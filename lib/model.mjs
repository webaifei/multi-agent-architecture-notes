/**
 * model.mjs — 模型适配层。
 *
 * 多 agent 系统里，模型只是一个「输入 messages + 工具清单，输出文本或工具调用」的函数。
 * 把它抽象成 ModelClient，好处是：
 *   1. 教学时可以用确定性 Mock，输出永远一样，方便对照；
 *   2. 换成真实模型时，agent loop 一行都不用改。
 *
 * 这个接口和 OpenAI / DeepSeek 兼容的 function calling 协议一致：
 *
 *   complete({ system, messages, tools }) ->
 *     { text: string, toolCalls: [{ id, name, arguments }] }
 *
 * 注意 arguments 的形态差异（真实 API 里是一个 JSON **字符串**，由适配层解析成对象）：
 * 这是新手最容易踩的坑，适配层替你挡住。
 */

/** @typedef {{ id: string, name: string, arguments: Record<string, unknown> }} ToolCall */
/** @typedef {{ text: string, toolCalls: ToolCall[] }} ModelReply */

const DEFAULTS = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
}

/**
 * 确定性 Mock 模型：按脚本依次返回。
 *
 * 脚本每一项要么是一条 ModelReply，要么是一个 `(request) => ModelReply` 函数
 * （函数形式可以读取真实请求，用来做「根据上下文分支」的 mock）。
 *
 * @param {Array<ModelReply | ((request: object) => ModelReply)>} script
 */
export function createMockModel(script) {
  const queue = [...script]
  let used = 0

  return {
    name: 'mock',
    /** @param {{ system?: string, messages: object[], tools: object[] }} request */
    async complete(request) {
      const next = queue.shift()
      used += 1
      if (!next) {
        return { text: `[mock] 脚本已用完（第 ${used} 次调用）`, toolCalls: [] }
      }
      const reply = typeof next === 'function' ? next(request) : next
      return { text: reply.text ?? '', toolCalls: reply.toolCalls ?? [] }
    },
  }
}

/**
 * 真实模型：DeepSeek（OpenAI 兼容的 chat/completions + function calling）。
 *
 * @param {{ model?: string, apiKey?: string, baseUrl?: string }} [options]
 */
export function createDeepSeekModel(options = {}) {
  const apiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY
  if (!apiKey) {
    throw new Error('真实模型模式需要 DEEPSEEK_API_KEY，或改用默认的 Mock 模型')
  }
  const baseUrl = (options.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? DEFAULTS.baseUrl).replace(/\/+$/, '')
  const model = options.model ?? DEFAULTS.model

  return {
    name: `deepseek:${model}`,
    /** @param {{ system?: string, messages: object[], tools: object[] }} request */
    async complete({ system, messages, tools }) {
      const body = {
        model,
        messages: system ? [{ role: 'system', content: system }, ...messages] : messages,
        ...(tools?.length ? { tools: tools.map(toWireTool) } : {}),
      }

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      })

      if (!response.ok) {
        const detail = await response.text()
        throw new Error(`模型请求失败 ${response.status}: ${detail.slice(0, 500)}`)
      }

      const payload = await response.json()
      const message = payload.choices?.[0]?.message ?? {}
      return {
        text: message.content ?? '',
        // 真实 API 给的是 JSON 字符串，这里解析回对象，让 loop 只面对一种形态。
        toolCalls: (message.tool_calls ?? []).map((call) => ({
          id: call.id,
          name: call.function?.name ?? '',
          arguments: safeParse(call.function?.arguments),
        })),
      }
    },
  }
}

/**
 * 按命令行参数选择模型：默认 Mock，加 `--real`（或 LAB_MODEL=real）用真实模型。
 *
 * @param {Array<ModelReply | ((request: object) => ModelReply)>} mockScript
 */
export function pickModel(mockScript) {
  const wantsReal = process.argv.includes('--real') || process.env.LAB_MODEL === 'real'
  return wantsReal ? createDeepSeekModel() : createMockModel(mockScript)
}

/** 把本仓库内部的工具描述转成线上协议格式。 */
function toWireTool(tool) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }
}

/** 解析工具参数；模型偶尔会给出空字符串或非法 JSON。 */
function safeParse(raw) {
  if (typeof raw !== 'string') return raw ?? {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}
