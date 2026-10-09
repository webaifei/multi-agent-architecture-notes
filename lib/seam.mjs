/**
 * seam.mjs — 能力接缝（capability seam）：DSH 最核心的那一个设计决定。
 *
 * Codex 把「怎么跑一个子 agent」写死在 `Session::spawn` 里；
 * Claude Code 把它写死在「读 .md 然后装配」里；
 * DSH 把它抽成**一条接缝**，接缝上有三个角色，缺一不可：
 *
 *   ① Service Definition（服务定义）
 *      接口 + 词汇表。这里是 `ProviderRegistry` 和 `SubagentCapabilities`。
 *      它不说「谁来跑」，只说「跑一个子 agent 需要哪些能力、怎么协商」。
 *
 *   ② Service Provider（服务提供者）
 *      具体实现。同一套接口下**可以有多个**，按名字共存。
 *      真实 DSH 里有六个：spawn / fork / acp / codex / claude-code / dsh-sdk。
 *
 *   ③ Consumer（消费者）
 *      把能力暴露给模型。这里是 `tool-subagent` —— 一个工具实例对接一个 provider。
 *
 * 三条来自真实源码的硬规矩（见 packages/subagent/subagent/src/types.ts 与
 * docs/subsystems/subagent.md）：
 *
 *   A. **provider 按名字共存**，注册返回 disposer（注册即副作用）。
 *      `registerProvider(provider): () => void`
 *
 *   B. **能力在 start 之前检查**，缺了就报 `UNSUPPORTED_CAPABILITY`，
 *      绝不「先接受再静默忽略」。
 *      `SubagentCapabilities = { agentOptions, outputSchema, depthLimit, toolFilter, persona }`
 *
 *   C. **可选能力靠「方法存不存在」发现**，用 TS 收窄当发现机制。
 *      `prepareContinuable?(request)` —— 有它才支持可续子 agent。
 *      文档原话：continuable start on a provider without `prepareContinuable` 会被拒绝。
 *
 * 另外两个细节也照抄了真实实现：
 *   · `inheritsParentContext` 只描述「对话是否被继承」，**不暗示**继承工具或权限 ——
 *     好让 Consumer 能生成准确的模型可见措辞（fork: true；spawn/acp: false）。
 *   · Consumer 实例**一个 provider 一个 toolName**，所以模型看到的是**静态工具**，
 *     而不是一个「provider 动态选择器」。工具的生命周期跟着 provider 走。
 */

/** 接缝里的可预期错误。 */
export class CapabilityError extends Error {
  /**
   * @param {'INVALID_PROVIDER'|'DUPLICATE_PROVIDER'|'UNSUPPORTED_CAPABILITY'|'NOT_FOUND'} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'CapabilityError'
    this.code = code
  }
}

/**
 * 请求字段 → 能力标志 的对应表。
 * 一个请求带了某个字段，就要求 provider 声明对应能力为 true。
 */
export const REQUEST_CAPABILITY = Object.freeze({
  agentOptions: 'agentOptions',
  outputSchema: 'outputSchema',
  maxDepth: 'depthLimit',
  toolFilter: 'toolFilter',
  persona: 'persona',
})

/** 能力标志的完整清单（用于打印与校验）。 */
export const CAPABILITY_KEYS = Object.freeze([...new Set(Object.values(REQUEST_CAPABILITY))])

/**
 * 一个按名字共存的 provider 注册表 —— 也就是「服务定义」那一半。
 *
 * 注意它和 shell 那种单执行器服务的区别：**这里允许多个实现并列**。
 * bash 只能有一个 executor，子 agent 可以有六个 transport。
 *
 * @param {{ kind?: string }} [options]
 */
export function createProviderRegistry({ kind = 'subagent' } = {}) {
  /** @type {Map<string, object>} */
  const providers = new Map()
  const listeners = { registered: [], unregistered: [] }

  return {
    kind,

    /**
     * 注册一个 provider。**返回 disposer** —— 注册是一种副作用，要能撤销。
     * 名字必须唯一：重名直接失败，不允许悄悄覆盖。
     *
     * @param {object} provider
     * @returns {() => void} 注销函数
     */
    registerProvider(provider) {
      if (!provider || typeof provider.name !== 'string' || provider.name === '') {
        throw new CapabilityError('INVALID_PROVIDER', 'provider 必须有一个非空的 name')
      }
      if (providers.has(provider.name)) {
        throw new CapabilityError('DUPLICATE_PROVIDER', `已存在名为「${provider.name}」的 provider，注册被拒绝`)
      }
      providers.set(provider.name, provider)
      for (const listener of listeners.registered) listener(provider)

      return () => {
        if (!providers.has(provider.name)) return
        providers.delete(provider.name)
        for (const listener of listeners.unregistered) listener(provider)
      }
    },

    /**
     * 按名字取 provider。
     *
     * @param {string} name
     * @returns {object | undefined}
     */
    getProvider(name) {
      return providers.get(name)
    },

    /** 按插入顺序列出 provider 名字。 */
    providerNames() {
      return [...providers.keys()]
    },

    /** 订阅「provider 上线」。 */
    onProviderRegistered(listener) {
      listeners.registered.push(listener)
      return () => {
        listeners.registered = listeners.registered.filter((item) => item !== listener)
      }
    },

    /** 订阅「provider 下线」。 */
    onProviderUnregistered(listener) {
      listeners.unregistered.push(listener)
      return () => {
        listeners.unregistered = listeners.unregistered.filter((item) => item !== listener)
      }
    },
  }
}

/**
 * 检查一个请求需要的能力，provider 是否都声明了。
 *
 * 这是「fail loud」的落点：返回值是**缺失清单**，调用方必须在 start 之前处理它。
 *
 * @param {object} provider
 * @param {object} request
 * @returns {Array<{ field: string, capability: string }>}
 */
export function missingCapabilities(provider, request = {}) {
  const missing = []
  for (const [field, capability] of Object.entries(REQUEST_CAPABILITY)) {
    if (request[field] === undefined) continue
    if (provider.capabilities?.[capability] !== true) missing.push({ field, capability })
  }
  return missing
}

/**
 * 「可续子 agent」这个能力的发现方式：**看方法在不在**。
 *
 * 真实 DSH 就是这样做的 —— 一个可选方法的存在性**就是**能力标志，
 * 然后靠 TS 收窄让调用方拿到强类型。比额外维护一个 boolean 更难说谎：
 * 说自己支持却没有实现，类型就过不去。
 *
 * @param {object} provider
 * @returns {boolean}
 */
export function supportsContinuable(provider) {
  return typeof provider.prepareContinuable === 'function'
}

/** 把 provider 的能力压成一行，方便打印。 */
export function describeProvider(provider) {
  const supported = CAPABILITY_KEYS.filter((key) => provider.capabilities?.[key] === true)
  return {
    name: provider.name,
    inherits: provider.inheritsParentContext === true,
    continuable: supportsContinuable(provider),
    capabilities: supported.length > 0 ? supported.join(', ') : '(无)',
    unsupported: CAPABILITY_KEYS.filter((key) => !supported.includes(key)).join(', ') || '(无)',
  }
}
