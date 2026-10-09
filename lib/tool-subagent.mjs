/**
 * tool-subagent.mjs — Consumer：把接缝上的一个 provider 暴露成**一个静态工具**。
 *
 * 这里有个刻意的设计，和「暴露一个 provider 选择器」正好相反：
 *
 *   ❌ 一个工具 `subagent(provider: "spawn" | "codex", prompt)`  ← 模型自己选 transport
 *   ✅ 每个 provider 一个工具 `subagent_spawn(prompt)` / `subagent_codex(prompt)`
 *
 * 为什么真实 DSH 选后者？看它 README 的原话：
 *   "Each delegation tool row names one provider and needs its own `toolName`,
 *    so the model sees static tools rather than a dynamic provider selector."
 *
 * 理由是**模型可见性**：
 *   · 工具描述可以针对这个 backend 写准（哪些能力支持、会不会继承上下文）；
 *   · 请求参数的能力检查可以在**参数层面**就摆清楚，而不是运行时才发现不支持；
 *   · 模型不需要知道「provider」这个抽象概念。
 *
 * 还有一条生命周期规矩：
 *   "The tool exists exactly while its provider does."
 *   工具跟着 provider 上线/下线 —— 这正是我们让 `registerProvider` 返回 disposer 的原因。
 */

import { missingCapabilities, supportsContinuable } from './seam.mjs'

/**
 * 造一个「对接某个 provider」的委派工具。
 *
 * @param {object} options
 * @param {object} options.registry createProviderRegistry() 的返回值
 * @param {string} options.providerName 绑定哪个 provider
 * @param {string} options.toolName 模型看到的工具名（每个实例必须不同）
 * @param {(provider: object, request: object) => Promise<object>} options.run 真正执行一次委派
 * @returns {{ tool: object, impl: Function }}
 */
export function createDelegationTool({ registry, providerName, toolName, run }) {
  const provider = () => registry.getProvider(providerName)

  // 措辞要跟 backend 的真实语义对上，别让模型以为孩子记得上下文。
  // 真实 DSH 就是靠 provider 的 inheritsParentContext 生成这段措辞的，
  // 而不是靠「fork 这个名字听起来像继承」。
  const inherits = registry.getProvider(providerName)?.inheritsParentContext === true

  const tool = {
    name: toolName,
    description: [
      `把一件自包含的任务委派给「${providerName}」这个 backend。`,
      inherits
        ? '这个 backend 的子 agent 会接着你之前的对话往下做。'
        : '这个 backend 的子 agent 看不到你之前的对话，背景必须写进 prompt。',
      '你只会拿到它的最后一条消息，中间过程不会回流。',
      '参数里没写的能力，说明这个 backend 不支持，调用时会直接拒绝。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '交给子 agent 的任务，要自包含' },
        mode: {
          type: 'string',
          enum: ['one-shot', 'continuable'],
          description: 'one-shot 等它跑完；continuable 起一个可续子 agent（需要 backend 支持）',
        },
        persona: { type: 'string', description: '给这个子 agent 的人设（需要 backend 支持 persona）' },
        tool_filter: { type: 'array', items: { type: 'string' }, description: '限定子 agent 能用的工具（需要 backend 支持）' },
        max_depth: { type: 'number', description: '深层委派上限（需要 backend 支持 depthLimit）' },
        output_schema: { type: 'object', description: '要求结构化输出（需要 backend 支持 outputSchema）' },
      },
      required: ['prompt'],
    },
  }

  const impl = async (args = {}) => {
    const target = provider()
    if (!target) {
      // 工具本该随 provider 一起消失；走到这里说明调用方拿着一个过期的工具。
      return `无法委派：backend「${providerName}」已经不在注册表里（NOT_FOUND）`
    }

    // 把模型参数翻译成 start 请求：**只带真正给了的字段**，
    // 因为「带了某个字段」就是「要求某个能力」。
    const request = { prompt: args.prompt }
    if (args.persona !== undefined) request.persona = args.persona
    if (args.tool_filter !== undefined) request.toolFilter = args.tool_filter
    if (args.max_depth !== undefined) request.maxDepth = args.max_depth
    if (args.output_schema !== undefined) request.outputSchema = args.output_schema

    // ① 能力检查发生在 start 之前 —— 缺什么就说什么，不静默降级。
    const missing = missingCapabilities(target, request)
    if (missing.length > 0) {
      const detail = [...new Set(missing.map((item) => item.capability))].join('、')
      return `无法委派：backend「${providerName}」缺少能力 ${detail}（UNSUPPORTED_CAPABILITY）`
    }

    // ② 可续模式：能力的发现方式是「方法在不在」。
    if (args.mode === 'continuable' && !supportsContinuable(target)) {
      return `无法委派：backend「${providerName}」不支持可续子 agent（没有 prepareContinuable；UNSUPPORTED_CAPABILITY）`
    }

    try {
      const runResult = await run(target, { ...request, mode: args.mode ?? 'one-shot' })
      return runResult.output
    } catch (error) {
      return `委派失败：${error.message}`
    }
  }

  return { tool, impl }
}
