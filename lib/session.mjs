/**
 * session.mjs — 会话日志（rollout JSONL）：**日志才是真相，内存只是它的投影**。
 *
 * 这一条是 1.3 的全部内容，也是最容易被低估的设计。
 *
 * 新手写法：把 messages 数组揣在内存里，需要恢复就「想办法存一下」。
 * 真实系统写法：**每一条模型可见的信息都必须先落盘**，内存里的 messages 只是
 * 「把日志从头重放一遍」得到的投影。
 *
 * 为什么反过来更对：
 *   1. 崩溃恢复不用特殊代码 —— 重放日志就是了；
 *   2. 可回放、可审计、可导出 —— 出了问题能拿到完整现场；
 *   3. 前后端一致 —— UI 渲染的也是同一串事件，不会「界面和模型看到的不一样」；
 *   4. 持久化格式变成**显式契约**，改它就要考虑兼容（Harness 为此专门有格式版本与迁移规则）。
 *
 * 对应真实系统：
 *   - Codex：`~/.codex/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDThh-mm-ss-<thread-id>.jsonl`，
 *     追加写、可选 zstd 压缩，另有 `archived_sessions` 与 `session_index.jsonl`；
 *   - DeepSeek Harness：硬规矩「**模型可见 ⟺ 已落盘**」，新的事件类型必须进 SessionEventMap，
 *     且默认「读时必需」——不认识这个事件的旧版本会拒绝加载，而不是悄悄忽略。
 *
 * 日志格式（每行一个 JSON 对象）：
 *   { seq, ts, type, ... }
 *   type: session/meta | turn/start | assistant/message | tool/result | run/end | user/message
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import path from 'node:path'

/**
 * 一个追加写的会话日志文件。
 *
 * 每次 `append` 立刻落盘 **并返回它写出的那一行** ——
 * 「返回写出的内容」是有意的：调用方看到的事件和磁盘上的字节是同一份，不会漂移。
 */
export class SessionLog {
  /** @param {string} file 日志文件绝对路径 */
  constructor(file) {
    this.file = file
    /** 单调递增序号；真实系统用它做因果顺序与断点续传。 */
    this.seq = 0
  }

  /**
   * 新建一个会话日志，并写下第一行 `session/meta`。
   *
   * @param {object} options
   * @param {string} options.dir 日志目录
   * @param {string} options.system 系统提示词（重放时要用）
   * @param {string} options.userMessage 首条用户消息
   * @param {string} [options.cwd] 工作目录
   * @param {string} [options.model] 模型名
   * @returns {Promise<SessionLog>}
   */
  static async create({ dir, system, userMessage, cwd, model }) {
    await mkdir(dir, { recursive: true })
    const sessionId = randomBytes(4).toString('hex')
    const file = path.join(dir, `rollout-${utcStamp()}-${sessionId}.jsonl`)
    const log = new SessionLog(file)
    await log.append({
      type: 'session/meta',
      sessionId,
      createdAt: new Date().toISOString(),
      system,
      userMessage,
      cwd,
      model,
    })
    return log
  }

  /**
   * 追加一条事件，返回实际写入的那一行文本。
   *
   * @param {object} event 事件内容（type 必填）
   * @returns {Promise<string>}
   */
  async append(event) {
    this.seq += 1
    const line = JSON.stringify({ seq: this.seq, ts: new Date().toISOString(), ...event })
    await appendFile(this.file, `${line}\n`, 'utf8')
    return line
  }

  /**
   * 读取一个日志文件的全部事件。
   *
   * @param {string} file
   * @returns {Promise<object[]>}
   */
  static async read(file) {
    const text = await readFile(file, 'utf8')
    return text
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line))
  }
}

/**
 * 把事件流重放成模型需要的上下文。
 *
 * 这是「日志是真相」的兑现处：**不依赖任何内存状态**，只靠日志就能重建 messages。
 * 注意哪些事件参与了重建、哪些不参与：
 *   - 参与：session/meta、user/message、assistant/message、tool/result
 *   - 不参与：turn/start、run/end（它们是过程与元数据，不是模型可见内容）
 * 这条界线就是真实系统里「模型可见 ⟺ 已落盘」的精确含义。
 *
 * @param {object[]} events
 * @returns {{ system: string, messages: object[], meta: object | undefined }}
 */
export function replay(events) {
  const messages = []
  let system = ''
  let meta

  for (const event of events) {
    switch (event.type) {
      case 'session/meta':
        meta = event
        system = event.system ?? ''
        messages.push({ role: 'user', content: event.userMessage })
        break
      case 'user/message':
        messages.push({ role: 'user', content: event.content })
        break
      case 'assistant/message':
        messages.push(event.toolCalls?.length ? assistantWire(event) : { role: 'assistant', content: event.text })
        break
      case 'tool/result':
        messages.push({ role: 'tool', tool_call_id: event.id, content: String(event.output) })
        break
      default:
        // turn/start、run/end 等：过程事件，不进入模型上下文。
        break
    }
  }

  return { system, messages, meta }
}

/**
 * 从磁盘恢复一个会话：读日志 → 重放成上下文。
 *
 * @param {string} file 日志文件路径
 * @returns {Promise<{ file: string, events: object[], system: string, messages: object[], meta: object | undefined }>}
 */
export async function loadSession(file) {
  const events = await SessionLog.read(file)
  const { system, messages, meta } = replay(events)
  return { file, events, system, messages, meta }
}

/** 把日志里的事件还原成线上协议的 assistant 消息（与 loop.mjs 的写法保持一致）。 */
function assistantWire(event) {
  return {
    role: 'assistant',
    content: event.text || null,
    tool_calls: event.toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    })),
  }
}

/** 生成 Codex 风格的时间戳：2026-10-09T06-25-19。 */
function utcStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
  ].join('-') + `T${pad(date.getUTCHours())}-${pad(date.getUTCMinutes())}-${pad(date.getUTCSeconds())}`
}
