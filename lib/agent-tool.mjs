/**
 * agent-tool.mjs — Claude Code 的 `Agent` 工具：按声明装配一个**全新上下文**。
 *
 * 和第 1 章 Codex 的 `spawn_agent` 对照着看，差别集中在两处：
 *
 *   隔离
 *     Codex       `spawn_agent({ task })`            隔离程度是**参数**，可以选继承
 *     Claude Code `Agent({ prompt, subagent_type })` 隔离是**默认值**，孩子拿不到父级历史
 *
 *   取结果
 *     Codex       `wait_agent` 主动去**等**（父 agent 决定什么时候等）
 *     Claude Code 后台任务完成时，通知**自己送上门**（在之后的某一轮注入父级上下文）
 *
 * 第二点是 2.3 的重点：并行不是问题，**怎么把晚到的结果交回来**才是问题。
 * Claude Code 的答案是「不交，等它自己变成一条通知」。
 *
 * `Agent` 工具被调用时做四件事：
 *   ① 按 `subagent_type` 查角色（2.1 那个 Markdown 文件）
 *   ② 用定义正文当初的系统提示词
 *   ③ 拼环境块（cwd、平台、日期、git 状态、CLAUDE.md、同级 agent 名册）
 *   ④ 跑完，**只把最后一条消息**还给父 agent
 *
 * 对应真实系统（docs/sources/claude-code.md）：
 *   - 工具名 `Agent`（v2.1.63 起，旧名 `Task` 仍可作别名）；
 *   - 输入字段：description / prompt / subagent_type / model / run_in_background / name / isolation；
 *   - agent 定义里的 `background: true` 会**强制**后台执行；
 *   - 嵌套深度默认 3（CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH）；
 *   - 并发默认 20（CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS）；
 *   - 后台执行的结果，会在**之后的某一轮**以完成通知的形式到达。
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
 * @param {object[]} [options.childTools] 子 agent 能用的工具
 * @param {Record<string, Function>} [options.childImpls]
 * @param {(context: object) => void} [options.onChildContext] 观察钩子：孩子装配完成时回调
 * @param {number} [options.maxConcurrent] 并发上限（官方默认 20）
 * @param {number} [options.maxDepth] 深度上限（官方默认 3）
 * @param {number} [options.depth] 当前工具所在的深度
 * @returns {{ tools: object[], impls: Record<string, Function>, drainNotifications: Function }}
 */
export function createAgentTool({
  definitions,
  env,
  makeChildModel,
  childTools = [],
  childImpls = {},
  onChildContext,
  maxConcurrent = 20,
  maxDepth = 3,
  depth = 0,
}) {
  const byName = new Map(definitions.map((definition) => [definition.name, definition]))
  const names = definitions.map((definition) => definition.name)

  /** 正在跑的后台任务。 */
  const background = new Map()
  /** 已完成、还没送进父级上下文的通知。 */
  const notifications = []
  let counter = 0

  const tools = [
    {
      name: AGENT_TOOL_NAME,
      description: [
        '启动一个子 agent 去做一件自包含的任务。',
        '子 agent 有独立的全新上下文，看不到你之前的对话，只把最终结论返回给你。',
        'run_in_background=true 时立刻返回，结果会在之后的某一轮以通知形式送达。',
        `可用的 subagent_type：${names.join(', ')}`,
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string', description: '三五个词的任务描述，给用户看' },
          prompt: { type: 'string', description: '交给子 agent 的任务，要自包含' },
          subagent_type: { type: 'string', description: `要用的角色名，可选：${names.join(', ')}` },
          run_in_background: { type: 'boolean', description: 'true 则不等待结果，稍后以通知形式送达' },
        },
        required: ['description', 'prompt'],
      },
    },
  ]

  const impls = {
    async [AGENT_TOOL_NAME]({ description, prompt, subagent_type, run_in_background }) {
      if (typeof prompt !== 'string' || !prompt.trim()) return '工具调用失败：prompt 必须是非空字符串'
      if (depth > maxDepth) {
        return `无法创建子 agent：深度上限是 ${maxDepth}，当前已在第 ${depth} 层（DEPTH_LIMIT）`
      }

      // ① 查角色。省略时回退到 general-purpose，否则报错（对齐官方行为）。
      const definition = subagent_type ? byName.get(subagent_type) : byName.get('general-purpose')
      if (!definition) {
        return `错误：没有名为「${subagent_type}」的 agent 定义。可用：${names.join(', ')}`
      }

      // ② + ③ 装配一个全新的上下文：定义正文 + 环境块。父级历史到此为止，不参与。
      const system = `${definition.systemPrompt}\n\n${env}`
      onChildContext?.({
        type: definition.name,
        description,
        system,
        prompt,
        declaredTools: definition.tools,
        messageCount: 1,
      })

      const runOnce = () =>
        runAgent({
          model: makeChildModel(definition, prompt),
          system,
          userMessage: prompt,
          tools: childTools,
          impls: childImpls,
          maxTurns: definition.maxTurns ?? 6,
          tracer: trace.scoped(definition.name),
        }).then((outcome) => outcome.text)

      // 定义里写了 background: true 就强制后台 —— 模型说了不算。
      const wantsBackground = run_in_background === true || definition.background === true

      if (!wantsBackground) {
        // 前台：阻塞到它跑完，只回传最终消息。
        return await runOnce()
      }

      // 并发闸门：超了就直接拒绝，不排队、不静默降级。
      if (background.size >= maxConcurrent) {
        return `无法启动后台任务：并发上限是 ${maxConcurrent}，当前已有 ${background.size} 个在跑（SPAWN_LIMIT）`
      }

      const id = `bg-${++counter}`
      const promise = runOnce()
        .then((text) => {
          // 关键：结果不还给调用方，而是变成一条**待注入的通知**。
          notifications.push({
            role: 'user',
            content: `【后台通知】子 agent ${definition.name}（${id}，任务：${description}）已完成。结论：${text}`,
          })
        })
        .catch((error) => {
          notifications.push({ role: 'user', content: `【后台通知】子 agent ${definition.name}（${id}）失败：${error.message}` })
        })
        .finally(() => background.delete(id))

      background.set(id, promise)
      return `已后台启动 ${id}（${definition.name}）：${description}。结果会在之后的某一轮以通知形式送达，你可以继续做别的事。`
    },
  }

  /**
   * 回合开始前被调用：把已经完成的后台通知交给父级上下文。
   *
   * 这一步和 `spawn` 是分开的 —— 所以「后台跑完了」和「父 agent 知道它跑完了」
   * 是两个不同时刻。这个延迟是后台任务的本性，不是 bug。
   *
   * @returns {object[]} 要注入的消息
   */
  function drainNotifications() {
    return notifications.splice(0, notifications.length)
  }

  return { tools, impls, drainNotifications, background }
}
