/**
 * subagent.mjs — 子 agent 注册表：在同一个进程里新造一份 Session。
 *
 * 第 1.1 节说过：「工具调用是数据，不是控制流」。这个文件就是兑现：
 * 所谓「多 agent」，不过是让某个工具的实现**再起一个循环**，
 * 然后把它的最终回答当成工具结果还回去。
 *
 * 一个 agent 在实现层面只需要五样东西：
 *
 *   id + 昵称      身份，日志里靠它分辨「这条是谁说的」
 *   messages       自己的上下文（默认全新，与父级隔离）
 *   事件流          自己的会话日志文件（追加写，跨多次续跑复用同一个文件）
 *   邮箱           别人发来的消息（只排队，不打断）
 *   状态 + 取消信号  pending → running → completed | errored | interrupted
 *
 * 对应真实系统（见 docs/sources/codex.md）：
 *   - `Session::spawn(SessionSpawnArgs{…})` 在**进程内**返回新 `Session` 和它自己的 `SessionIo`；
 *     身份是 `SessionSource::SubAgent(ThreadSpawn{ parent_thread_id, depth, agent_path,
 *     agent_nickname, agent_role })`。
 *   - 工具动词：`spawn_agent` / `send_message` / `followup_task` / `wait_agent` /
 *     `interrupt_agent` / `list_agents`。
 *   - 三道闸：并发上限（`reserve_spawn_slot`）、深度上限、委派前必须 `approval_policy == Never`。
 *   - 邮箱语义：`send_message` 是 `MessageDeliveryMode::QueueOnly`（只排队），
 *     `followup_task` 才会触发一个新回合 —— 这个区分是本文件最重要的细节。
 */

import { runAgent } from './loop.mjs'
import { SessionLog } from './session.mjs'
import * as trace from './trace.mjs'

/** 子 agent 相关的、可预期的错误（超限、找不到、正忙）。 */
export class AgentError extends Error {
  /**
   * @param {'DEPTH_LIMIT'|'SPAWN_LIMIT'|'NOT_FOUND'|'BUSY'} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'AgentError'
    this.code = code
  }
}

/** agent 的生命周期状态（取值对齐 Codex 的 AgentStatus）。 */
export const AGENT_STATUS = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  ERRORED: 'errored',
  INTERRUPTED: 'interrupted',
})

/** 昵称表：真实 Codex 会给每个子 agent 发一个随机人类昵称，方便日志里指认。 */
const NICKNAMES = ['ada', 'bob', 'cora', 'dylan', 'eve', 'finn', 'gina', 'hope']

/**
 * 子 agent 注册表：谁被创建了、现在什么状态、结果是什么、邮箱里有什么。
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
   * @param {number} [options.maxThreads] 并发上限
   * @param {number} [options.maxDepth] 深度上限
   * @param {string} [options.idPrefix] id 前缀
   * @param {object} [options.tracer] 输出器
   */
  constructor({ workspace, sessionsDir, system, makeRun, maxThreads = 4, maxDepth = 1, idPrefix = 'agent', tracer = trace }) {
    this.workspace = workspace
    this.sessionsDir = sessionsDir
    this.system = system
    this.makeRun = makeRun
    this.maxThreads = maxThreads
    this.maxDepth = maxDepth
    this.idPrefix = idPrefix
    this.tracer = tracer
  }

  /** 当前在跑的 agent 数。 */
  get runningCount() {
    return this.#running
  }

  /**
   * 创建并启动一个子 agent，**不等待它跑完**。
   *
   * @param {object} options
   * @param {string} options.task 交给子 agent 的任务
   * @param {string} [options.label] 显示名
   * @param {string} [options.parentId] 父 agent id
   * @param {number} [options.depth] 深度（内部参数，模型看不到）
   * @returns {Promise<object>} 句柄
   */
  async spawn({ task, label, parentId = 'root', depth = 0 }) {
    // 闸门一：深度。必须在任何 await 之前判断，否则并发下会漏。
    if (depth > this.maxDepth) {
      throw new AgentError('DEPTH_LIMIT', `深度上限是 ${this.maxDepth}，不允许在第 ${depth} 层再创建子 agent`)
    }
    // 闸门二：并发。名额**同步**预留，避免两个 spawn 同时挤进来。
    this.#reserveSlot()

    const id = `${this.idPrefix}-${++this.#counter}`
    const handle = {
      id,
      nickname: NICKNAMES[(this.#counter - 1) % NICKNAMES.length],
      label: label ?? id,
      parentId,
      depth,
      task,
      status: AGENT_STATUS.PENDING,
      result: null,
      error: null,
      interrupted: false,
      mailbox: [],
      logFile: null,
      log: null,
      messages: [],
      spec: null,
      controller: null,
      startedAt: null,
      finishedAt: null,
      promise: null,
    }
    this.#handles.set(id, handle)

    try {
      // 一个子 agent 一个日志文件；后续 followup_task 复用同一个文件（真实系统里是同一个 thread）。
      handle.log = await SessionLog.create({
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
    handle.logFile = handle.log.file
    handle.tracer = this.tracer.scoped(`${id} ${handle.nickname}`)

    this.#startRun(handle)
    return handle
  }

  /**
   * 给一个 agent 发消息。**只排队，不打断当前回合** —— 对应 Codex 的 QueueOnly。
   *
   * @param {string} id
   * @param {string} text
   * @returns {object} 投递结果
   */
  sendMessage(id, text) {
    const handle = this.#require(id)
    const wasRunning = handle.status === AGENT_STATUS.RUNNING
    handle.mailbox.push({ text, at: new Date().toISOString() })
    return {
      delivery: 'queue-only',
      running: wasRunning,
      queueLength: handle.mailbox.length,
    }
  }

  /**
   * 取出并清空邮箱。子 agent 在自己的回合开始时调用它。
   *
   * @param {string} id
   * @returns {string[]}
   */
  drainMailbox(id) {
    const handle = this.#require(id)
    const messages = handle.mailbox.map((item) => item.text)
    handle.mailbox = []
    return messages
  }

  /**
   * 中断一个正在跑的 agent。**同步返回**：它只是发出信号，不等待对方收尾。
   *
   * @param {string} id
   * @returns {object} 句柄
   */
  interrupt(id) {
    const handle = this.#require(id)
    if (handle.status === AGENT_STATUS.PENDING || handle.status === AGENT_STATUS.RUNNING) {
      handle.interrupted = true
      handle.controller?.abort()
    }
    return handle
  }

  /**
   * 给一个空闲的 agent 追加一个新回合（上下文接着上一轮）。
   *
   * 这是和 `send_message` 的关键区别：`send_message` 只排队，
   * `followup_task` **明确触发一次新回合**。
   *
   * @param {string} id
   * @param {string} task
   * @returns {Promise<object>} 句柄
   */
  async followupTask(id, task) {
    const handle = this.#require(id)
    if (handle.status === AGENT_STATUS.PENDING || handle.status === AGENT_STATUS.RUNNING) {
      throw new AgentError('BUSY', `${id} 还在运行；想插话用 send_message（只排队），别用 followup_task`)
    }
    this.#reserveSlot()

    // 新回合的用户消息也要落盘，否则恢复出来的上下文会和原来不一样。
    await handle.log.append({ type: 'user/message', content: task })
    handle.history = [...handle.messages, { role: 'user', content: task }]
    handle.interrupted = false
    this.#startRun(handle, { history: handle.history })
    return handle
  }

  /**
   * 等一个 agent 到终态。
   *
   * @param {string} id
   * @returns {Promise<object>} 句柄（终态）
   */
  async wait(id) {
    const handle = this.#require(id)
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

  // ─────────────────────────── 内部 ───────────────────────────

  /** 预留一个并发名额，满则大声失败。 */
  #reserveSlot() {
    if (this.#running >= this.maxThreads) {
      throw new AgentError('SPAWN_LIMIT', `并发上限是 ${this.maxThreads}，当前已有 ${this.#running} 个在运行`)
    }
    this.#running += 1
  }

  /** 找不到就抛，别返回 undefined 让调用方猜。 */
  #require(id) {
    const handle = this.#handles.get(id)
    if (!handle) throw new AgentError('NOT_FOUND', `没有 id 为 ${id} 的 agent`)
    return handle
  }

  /**
   * 真正起一个循环。spawn 和 followupTask 共用。
   *
   * @param {object} handle
   * @param {{ history?: object[] }} [options]
   */
  #startRun(handle, options = {}) {
    handle.status = AGENT_STATUS.RUNNING
    handle.startedAt = new Date().toISOString()
    handle.controller = new AbortController()
    // 同一个 agent 的工具与模型只组装一次，续跑时继续用同一份。
    handle.spec ??= this.makeRun(handle)

    handle.promise = (async () => {
      try {
        const outcome = await runAgent({
          model: handle.spec.model,
          system: handle.spec.system ?? this.system,
          history: options.history,
          userMessage: options.history ? undefined : handle.task,
          tools: handle.spec.tools ?? [],
          impls: handle.spec.impls ?? {},
          maxTurns: handle.spec.maxTurns ?? 40,
          onEvent: (event) => handle.log.append(event),
          tracer: handle.tracer,
          signal: handle.controller.signal,
        })
        handle.messages = outcome.messages
        handle.result = outcome.text
        handle.status = outcome.interrupted ? AGENT_STATUS.INTERRUPTED : AGENT_STATUS.COMPLETED
      } catch (error) {
        handle.status = AGENT_STATUS.ERRORED
        handle.error = error.message
      } finally {
        this.#running -= 1
        handle.finishedAt = new Date().toISOString()
      }
      return handle
    })()
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
  if (handle.mailbox.length > 0) lines.push(`邮箱里还有 ${handle.mailbox.length} 条未读`)
  if (handle.status === AGENT_STATUS.COMPLETED || handle.status === AGENT_STATUS.INTERRUPTED) {
    lines.push('最后的回答：', handle.result ?? '(空)')
  } else if (handle.status === AGENT_STATUS.ERRORED) {
    lines.push(`错误：${handle.error}`)
  }
  return lines.join('\n')
}
