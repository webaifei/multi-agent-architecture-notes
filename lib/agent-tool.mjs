/**
 * agent-tool.mjs — Claude Code 的 `Agent` 工具：按声明装配一个**全新上下文**。
 *
 * 和第 1 章 Codex 的 `spawn_agent` 对照着看，差别只有一处，但很致命：
 *
 *   Codex      `spawn_agent({ task })`            —— 隔离程度是**参数**，可以选继承
 *   Claude Code `Agent({ prompt, subagent_type })` —— 隔离是**默认值**，孩子拿不到父级历史
 *
 * `Agent` 工具被调用时，做四件事：
 *
 *   ① 按 `subagent_type` 去定义表里查角色（就是 2.1 那个 Markdown 文件）
 *   ② 用**定义正文**当初的系统提示词
 *   ③ 拼一个环境块（cwd、平台、日期、git 状态、项目说明 CLAUDE.md、同级 agent 名册）
 *   ④ 跑完，**只把最后一条消息**还给父 agent
 *
 * 孩子的初始上下文里，**一条父级消息都没有**。这不是靠自觉，是结构上就没有那条通道。
 *
 * 对应真实系统（见 docs/sources/claude-code.md）：
 *   - 工具名 v2.1.63 起是 `Agent`（旧名 `Task` 仍可作别名）；
 *     有趣的是 `tool_use` 块里叫 `Agent`，而 system:init 的工具清单里仍显示 `Task`。
 *   - 输入字段：description / prompt / subagent_type / model / run_in_background / name / isolation。
 *   - 省略 subagent_type 会回退到 general-purpose，否则报错。
 *   - 子 agent 拿到：自己的系统提示词 + 环境信息 + prompt + CLAUDE.md + git 状态 + 同级名册；
 *     拿不到：父级对话历史、父级系统提示词、output style、auto-memory。
 *   - 结果回流：中间的工具调用与结果留在子 agent 内部，只有最终消息回到父级。
 */

import { runAgent } from './loop.mjs'
import * as trace from './trace.mjs'

/** 工具名。真实 Claude Code 在 tool_use 块里用它。 */
export const AGENT_TOOL_NAME = 'Agent'

/**
 * 拼子 agent 的「环境块」。
 *
 * 注意这里出现的每一样东西，都是官方文档点名会给子 agent 的：
 * 自己的系统提示词（定义正文）、环境信息、CLAUDE.md、git 状态、**同级 agent 名册**。
 * 唯独没有父级对话历史。
 *
 * @param {object} options
 * @param {string} options.cwd
 * @param {string} [options.claudeMd] 项目说明（对应 CLAUDE.md）
 * @param {string[]} [options.agentNames] 同级 agent 名册
 * @param {string} [options.gitStatus]
 * @returns {string}
 */
export function buildChildEnvironment({ cwd, claudeMd, agentNames = [], gitStatus = '(clean)' }) {
  const lines = [
    '<env>',
    `cwd: ${cwd}`,
    `platform: ${process.platform}`,
    `date: ${new Date().toISOString().slice(0, 10)}`,
    `git status: ${gitStatus}`,
  ]
  if (claudeMd) lines.push(`<project-instructions>\n${claudeMd.trim()}\n</project-instructions>`)
  if (agentNames.length > 0) lines.push(`available agents: ${agentNames.join(', ')}`)
  lines.push('</env>')
  return lines.join('\n')
}

/**
 * 造一个 `Agent` 工具。
 *
 * @param {object} options
 * @param {object[]} options.definitions 2.1 发现出来的 agent 定义
 * @param {string} options.env 环境块文本
 * @param {(definition: object, prompt: string) => object} options.makeChildModel 给某个角色造模型
 * @param {object[]} [options.childTools] 子 agent 能用的工具（本节的演示工具）
 * @param {Record<string, Function>} [options.childImpls]
 * @param {(context: object) => void} [options.onChildContext] 观察钩子：孩子装配完成时回调
 * @returns {{ tools: object[], impls: Record<string, Function> }}
 */
export function createAgentTool({ definitions, env, makeChildModel, childTools = [], childImpls = {}, onChildContext }) {
  const byName = new Map(definitions.map((definition) => [definition.name, definition]))
  const names = definitions.map((definition) => definition.name)

  const tools = [
    {
      name: AGENT_TOOL_NAME,
      description: [
        '启动一个子 agent 去做一件自包含的任务。',
        '子 agent 有独立的全新上下文，看不到你之前的对话，只把最终结论返回给你。',
        '适合：需要大量探索但只需要结论的任务。',
        `可用的 subagent_type：${names.join(', ')}`,
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string', description: '三五个词的任务描述，给用户看' },
          prompt: { type: 'string', description: '交给子 agent 的任务，要自包含' },
          subagent_type: { type: 'string', description: `要用的角色名，可选：${names.join(', ')}` },
        },
        required: ['description', 'prompt'],
      },
    },
  ]

  const impls = {
    async [AGENT_TOOL_NAME]({ description, prompt, subagent_type }) {
      if (typeof prompt !== 'string' || !prompt.trim()) return '工具调用失败：prompt 必须是非空字符串'

      // ① 查角色。省略时回退到 general-purpose，否则报错（对齐官方行为）。
      const definition = subagent_type ? byName.get(subagent_type) : byName.get('general-purpose')
      if (!definition) {
        return `错误：没有名为「${subagent_type}」的 agent 定义。可用：${names.join(', ')}`
      }

      // ② + ③ 装配一个全新的上下文：定义正文 + 环境块。父级历史到此为止，不参与。
      const system = `${definition.systemPrompt}\n\n${env}`
      const context = {
        type: definition.name,
        description,
        system,
        prompt,
        declaredTools: definition.tools,
        messageCount: 1, // 只有这一条 user message，孩子的起点
      }
      onChildContext?.(context)

      // ④ 跑完，只回传最终消息。
      const outcome = await runAgent({
        model: makeChildModel(definition, prompt),
        system,
        userMessage: prompt,
        tools: childTools,
        impls: childImpls,
        maxTurns: definition.maxTurns ?? 6,
        tracer: trace.scoped(definition.name),
      })
      return outcome.text
    },
  }

  return { tools, impls }
}
