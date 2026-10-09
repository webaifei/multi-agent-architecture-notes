/**
 * subagent.mjs — 子 agent 注册表：**在同一个进程里新造一份 Session**。
 *
 * 第 1.1 节说过一句话：「工具调用是数据，不是控制流」。
 * 这个文件就是那句话的兑现：所谓「多 agent」，不过是让某个工具的实现
 * **再起一个循环**，然后把它的最终回答当成工具结果还回去。
 *
 * 一个 agent 在实现层面只需要四样东西：
 *
 *   id + 昵称      身份，日志里靠它分辨「这条是谁说的」
 *   messages       自己的上下文（默认全新，与父级隔离）
 *   事件流          自己的会话日志文件
 *   状态            pending → running → completed | errored
 *
 * 对应真实系统：
 *   - Codex：`Session::spawn(SessionSpawnArgs{…})` 在**进程内**返回新的 `Session`
 *     和它自己的 `SessionIo`；身份是 `SessionSource::SubAgent(ThreadSpawn{ parent_thread_id,
 *     depth, agent_path, agent_nickname, agent_role })`。
 *   - 三道闸（本文件同样实现）：并发上限 `reserve_spawn_slot(max_threads)`、
 *     深度上限 `exceeds_thread_spawn_depth_limit`、以及完成态
 *     `AgentStatus::Completed(last_agent_message)` 只带回最后一条消息。
 *   - 状态取值照抄 Codex：pending / running / completed / errored（另有 interrupted 留给 1.6）。
 */

import { runAgent } from './loop.mjs'
import { SessionLog } from './session.mjs'
import * as trace from './trace.mjs'

/** 子 agent 相关的、可预期的错误（超限、找不到）。 */
export class AgentError extends Error {
  /**
   * @param {'DEPTH_LIMIT'|'SPAWN_LIMIT'|'NOT_FOUND'} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'AgentError'
    this.code = code
  }
}

/** agent 的生命周期状态。 */
export const AGENT_STATUS = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  ERRORED: 'errored',
})

/** 昵称表：真实 Codex 会给每个子 agent 发一个随机人类昵称，方便日志里指认。 */
const NICKNAMES = ['ada', 'bob', 'cora', 'dylan', 'eve', 'finn', 'gina', 'hope']

/**
 * 子 agent 注册表：谁被创建了、现在什么状态、结果是什么。
 *
 * 真实系统里这张表叫 `AgentRegistry`，挂在会话树上，还负责预留并发名额。
 */
export class AgentRegistry {
  /** @type {Map<string, object>} */
  #handles = new Map()
  #counter = 0
  #running = 0

  /**
   * @param {object} options
   * @param {string} options.workspace 子 agent 的工作目录（继承父级）
   * @param {string} options.sessionsDir 每个子 agent 一个日志文件的目录
   * @param {string} options.system 子 agent 的系统提示词
   * @param {(handle: object) => { model: object, system?: string, tools?: object[], impls?: object, maxTurns?: number }} options.makeRun
   *   给某个子 agent 组装运行参数（每个孩子可以有不同剧本/工具）
   * @param {number} [options.maxThreads] 并发上限
   * @param {number} [options.maxDepth] 深度上限：path 上再 spawn 的层级数
   * @param {string} [options.idPrefix] id 前缀，便于区分不同注册表
   */
  constructor({ workspace, sessionsDir, system, makeRun, maxThreads = 4, maxDepth = 1, idPrefix = 'agent', tracer = trace }) {
    this.workspace = workspace
    this.sessionsDir = sessionsDir
    this.system = system
    this.maxThreads = maxThreads
    this.maxDepth = maxDepth
    this.idPrefix = idPrefix
    this.makeRun = makeRun
    this.tracer = tracer
  }

  /** 当前在跑的 agent 数。 */
  get runningCount() {
    return this.#running
  }

  /**
   * 创建并启动一个子 agent，**不等待它跑完**。
   *
   * 这是和 1.1 的关键差别：`spawn` 立刻返回句柄，要用 `wait` 才拿结果。
   * 真实系统也是这样 —— 只有这样才可能同时开好几个（1.6 的内容）。
   *
   * @param {object} options
   * @param {string} options.task 交给子 agent 的任务
   * @param {string} [options.label] 显示名（模型给的 name，或角色名）
   * @param {string} [options.parentId] 父 agent id（'root' 表示主 agent）
   * @param {number} [options.depth] 深度（内部参数，模型看不到）
   * @returns {Promise<object>} 句柄
   */
  async spawn({ task, label, parentId = 'root', depth = 0 }) {
    // 闸门一：深度。必须在任何 await 之前判断，否则并发下会漏。
    if (depth > this.maxDepth) {
      throw new AgentError('DEPTH_LIMIT', `深度上限是 ${this.maxDepth}，不允许在第 ${depth} 层再创建子 agent`)
    }
    // 闸门二：并发。名额**同步**预留，避免两个 spawn 同时挤进来。
    if (this.#running >= this.maxThreads) {
      throw new AgentError('SPAWN_LIMIT', `并发上限是 ${this.maxThreads}，当前已有 ${this.#running} 个在运行`)
    }
    this.#running += 1

    const id = `${this.idPrefix}-${++this.#counter}`
    const handle = {
      id,
      nickname: NICKNAMES[(this.#counter - 1) % NICKNAMES.length],
      label: label ?? id,
      parentId,
      depth,
      status: AGENT_STATUS.PENDING,
      result: null,
      error: null,
      logFile: null,
      startedAt: null,
      finishedAt: null,
      promise: null,
    }
    this.#handles.set(id, handle)

    let log
    try {
      log = await SessionLog.create({
        dir: this.sessionsDir,
        system: this.system,
        userMessage: task,
        cwd: this.workspace,
        model: `subagent:${handle.label}`,
      })
    } catch (error) {
      this.#running -= 1
      this.#handles.delete(id)
      throw error
    }
    handle.logFile = log.file

    // 每个子 agent 有自己的 tracer：日志带前缀，出问题一眼看出是谁。
    const childTracer = this.tracer.scoped(`${id} ${handle.nickname}`)

    handle.promise = (async () => {
      handle.status = AGENT_STATUS.RUNNING
      handle.startedAt = new Date().toISOString()
      try {
        const spec = this.makeRun(handle)
        const outcome = await runAgent({
          model: spec.model,
          system: spec.system ?? this.system,
          userMessage: task,
          tools: spec.tools ?? [],
          impls: spec.impls ?? {},
          maxTurns: spec.maxTurns ?? 6,
          onEvent: (event) => log.append(event),
          tracer: childTracer,
        })
        // 只带回最后一条消息 —— 对应 Codex 的 Completed(last_agent_message)。
        handle.result = outcome.text
        handle.status = AGENT_STATUS.COMPLETED
      } catch (error) {
        handle.status = AGENT_STATUS.ERRORED
        handle.error = error.message
      } finally {
        this.#running -= 1
        handle.finishedAt = new Date().toISOString()
      }
      return handle
    })()

    return handle
  }

  /**
   * 等一个子 agent 到终态。
   *
   * @param {string} id
   * @returns {Promise<object>} 句柄（终态）
   */
  async wait(id) {
    const handle = this.#handles.get(id)
    if (!handle) throw new AgentError('NOT_FOUND', `没有 id 为 ${id} 的 agent`)
    if (handle.status === AGENT_STATUS.PENDING || handle.status === AGENT_STATUS.RUNNING) {
      await handle.promise
    }
    return handle
  }

  /**
   * 查一个 agent 的句柄。
   *
   * @param {string} id
   * @returns {object | undefined}
   */
  get(id) {
    return this.#handles.get(id)
  }

  /**
   * 列出当前注册表里的所有 agent（按创建顺序）。
   *
   * @returns {object[]}
   */
  list() {
    return [...this.#handles.values()]
  }
}

/**
 * 把句柄格式化成模型能读的一段文本。
 *
 * 真实 Codex 通过 `AgentStatus::Completed(last_agent_message)` 带回摘要，
 * 中间的工具调用**不会**回流到父 agent —— 这正是「上下文隔离」省 token 的地方。
 *
 * @param {object} handle
 * @returns {string}
 */
export function formatHandle(handle) {
  const lines = [`status: ${handle.status}`, `agent: ${handle.id} (${handle.nickname})`]
  if (handle.status === AGENT_STATUS.COMPLETED) {
    lines.push('最后的回答：', handle.result ?? '(空)')
  } else if (handle.status === AGENT_STATUS.ERRORED) {
    lines.push(`错误：${handle.error}`)
  }
  return lines.join('\n')
}
