/**
 * hooks.mjs — 拦截点：让**外部**能干预 agent 的行为，而不用改 agent 的代码。
 *
 * 为什么需要它？因为有些规则不属于 agent，属于**运行它的组织**：
 *
 *   · 审计：记下每一次工具调用
 *   · 阻断：子 agent 一律不许写文件
 *   · 脱敏：输出里的密钥、内部域名要抹掉
 *   · 记账：哪个角色花了多少钱
 *
 * 如果把这些写进 agent 的提示词，等于把合规交给模型自觉。hook 把它变成**代码强制**。
 *
 * 对应真实系统（docs/sources/claude-code.md）：
 *   - `SubagentStart` / `SubagentStop`：matcher 是 agent 类型；
 *   - `PreToolUse` / `PostToolUse`：在子 agent 内部也会触发，且带上 `agent_id`、`agent_type`；
 *   - 子 agent frontmatter 里的 `Stop` hook 会被自动转成 `SubagentStop`；
 *   - 插件来源的 subagent **不支持** `hooks` / `mcpServers` / `permissionMode`（安全考虑）。
 *
 * 我们实现一个最小可用的总线：按事件名 + matcher 订阅，按注册顺序执行，
 * `PreToolUse` 的返回值可以**否决**调用或**改写**输出。
 */

/** 支持的事件名。 */
export const HOOK_EVENTS = ['SubagentStart', 'SubagentStop', 'PreToolUse', 'PostToolUse']

/**
 * 极简 hook 总线。
 *
 * 执行的语义很关键：**所有 handler 都会跑，谁也不能悄悄吞掉别人的结果**。
 * （对比 Cordis 的 waterfall：那里是显式 `next()`，第一个不调用 next 的会短路。
 *  这里为了教学简单，改成「全跑 + 取第一个否决」。）
 */
export class HookBus {
  #handlers = new Map()
  /** 所有触发过的记录，纯粹给你看。 */
  log = []

  /**
   * 注册一个 handler。
   *
   * @param {'SubagentStart'|'SubagentStop'|'PreToolUse'|'PostToolUse'} event
   * @param {(payload: object) => object | void | Promise<object | void>} handler
   * @param {{ matcher?: string, name?: string }} [options] matcher：工具名或 agent 类型，'*' 表示全部
   * @returns {() => void} 取消注册的函数（注册即副作用，返回 disposer —— 和真实系统一致）
   */
  on(event, handler, options = {}) {
    if (!HOOK_EVENTS.includes(event)) throw new Error(`未知的 hook 事件：${event}`)
    const entry = { matcher: options.matcher ?? '*', handler, name: options.name ?? handler.name ?? '(anonymous)' }
    const list = this.#handlers.get(event) ?? []
    list.push(entry)
    this.#handlers.set(event, list)
    return () => {
      const current = this.#handlers.get(event) ?? []
      this.#handlers.set(
        event,
        current.filter((item) => item !== entry),
      )
    }
  }

  /**
   * 触发一个事件。
   *
   * @param {string} event
   * @param {object} payload
   * @returns {Promise<object[]>} 每个命中的 handler 的返回值
   */
  async emit(event, payload) {
    const matched = (this.#handlers.get(event) ?? []).filter((entry) => matches(entry.matcher, payload))
    this.log.push({ event, matcherTarget: payload.toolName ?? payload.agentType ?? '-', handlers: matched.length })
    const results = []
    for (const entry of matched) {
      results.push((await entry.handler(payload)) ?? null)
    }
    return results
  }

  /** 列出已注册的 handler，便于打印。 */
  list() {
    const rows = []
    for (const [event, entries] of this.#handlers) {
      for (const entry of entries) rows.push({ event, matcher: entry.matcher, name: entry.name })
    }
    return rows
  }
}

/** matcher 命中判断：'*' 全中；否则比对工具名或 agent 类型。 */
function matches(matcher, payload) {
  if (matcher === '*') return true
  return matcher === payload.toolName || matcher === payload.agentType
}

/**
 * 把一条 PreToolUse 的结果集合归约成「放行 / 否决 / 改写」。
 *
 * @param {object[]} results
 * @returns {{ decision?: 'deny', reason?: string, output?: string }}
 */
export function combinePreToolUse(results) {
  for (const result of results) {
    if (result?.decision === 'deny') return { decision: 'deny', reason: result.reason ?? '(未说明原因)' }
  }
  return {}
}
