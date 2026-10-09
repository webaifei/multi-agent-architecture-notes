/**
 * agent-tool.mjs — Claude Code 的 `Agent` 工具：按声明装配一个**全新上下文**。
 *
 * 和第 1 章 Codex 的 `spawn_agent` 对照着看，差别集中在三处：
 *
 *   隔离
 *     Codex       `spawn_agent({ task })`            隔离程度是**参数**，可以选继承
 *     Claude Code `Agent({ prompt, subagent_type })` 隔离是**默认值**，孩子拿不到父级历史
 *
 *   取结果
 *     Codex       `wait_agent` 主动去**等**
 *     Claude Code 后台完成时，通知**自己送上门**（在之后的某一轮注入父级上下文）
 *
 *   能力
 *     Codex       沙箱在 OS 层，工具集全局一致
 *     Claude Code 定义里的 `tools` / `disallowedTools` 是**能力裁剪**：
 *                 工具从提示里消失，调用也会被拒绝（一个可见性）
 *
 * `Agent` 工具被调用时做五件事：
 *   ① 按 `subagent_type` 查角色（2.1 那个 Markdown 文件）
 *   ② 用定义正文当初的系统提示词
 *   ③ 拼环境块（cwd、平台、日期、git 状态、CLAUDE.md、同级 agent 名册）
 *   ④ **按定义裁剪工具集**，并在调用前后触发 PreToolUse / PostToolUse hook
 *   ⑤ 跑完，**只把最后一条消息**还给父 agent
 *
 * 对应真实系统（docs/sources/claude-code.md）：
 *   - 工具名 `Agent`（v2.1.63 起，旧名 `Task` 仍可作别名）；
 *   - 输入字段：description / prompt / subagent_type / model / run_in_background / name / isolation；
 *   - frontmatter `tools` / `disallowedTools` / `permissionMode`；
 *   - hooks：SubagentStart / SubagentStop（matcher 是 agent 类型）、
 *     子 agent 内部的 PreToolUse / PostToolUse（带 agent_id、agent_type）；
 *   - 插件来源的 subagent 不支持 hooks / mcpServers / permissionMode。
 */

import { combinePreToolUse } from './hooks.mjs'
import { runAgent } from './loop.mjs'
import * as trace from './trace.mjs'

/** 工具名。真实 Claude Code 在 tool_use 块里用它。 */
export const AGENT_TOOL_NAME = 'Agent'

/**
 * Claude Code 的工具名 → 本教学仓库实现的工具名。
 *
 * 真实系统里这张表对应的是内置工具集合（Read / Grep / Glob / Bash / Write / Edit / WebSearch / …）。
 * 映射存在本身就说明一件事：**白名单是「能力类别」，不是具体实现**。
 */
const CLAUDE_TO_LAB = {
  Read: ['read_file'],
  Grep: ['search'],
  Glob: ['search'],
  Bash: ['exec_command'],
  Write: ['apply_patch'],
  Edit: ['apply_patch'],
}

/**
 * 按定义裁剪工具集。
 *
 * 规则（对齐官方语义）：
 *   · `tools` 为空 → 继承全部工具；
 *   · `tools` 非空 → 只保留列出的能力；
 *   · `disallowedTools` → 再减掉列出的能力（优先级更高）。
 *
 * @param {object} definition
 * @param {object[]} labTools 全部可用工具
 * @param {Record<string, Function>} labImpls
 * @returns {{ tools: object[], impls: Record<string, Function>, names: string[], unknown: string[] }}
 */
export function selectChildTools(definition, labTools, labImpls) {
  const declared = definition.tools ?? []
  const denied = definition.disallowedTools ?? []
  const unknown = [...declared, ...denied].filter((name) => !(name in CLAUDE_TO_LAB))

  const allowNames = declared.length > 0 ? new Set(declared.flatMap((name) => CLAUDE_TO_LAB[name] ?? [])) : null
  const denyNames = new Set(denied.flatMap((name) => CLAUDE_TO_LAB[name] ?? []))

  const tools = labTools.filter((tool) => {
    if (denyNames.has(tool.name)) return false
    if (allowNames && !allowNames.has(tool.name)) return false
    return true
  })

  return {
    tools,
    impls: Object.fromEntries(tools.map((tool) => [tool.name, labImpls[tool.name]])),
    names: tools.map((tool) => tool.name),
    unknown,
  }
}

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
 * @param {(definition: object, prompt: string) => object} options.makeChildModel
 * @param {object[]} [options.labTools] 全部可用工具（会被按定义裁剪）
 * @param {Record<string, Function>} [options.labImpls]
 * @param {import('./hooks.mjs').HookBus} [options.hooks] hook 总线
 * @param {(context: object) => void} [options.onChildContext]
 * @param {number} [options.maxConcurrent] 后台并发上限（官方默认 20）
 * @param {number} [options.maxDepth] 深度上限（官方默认 3）
 * @param {number} [options.depth] 当前工具所在深度
 * @returns {{ tools: object[], impls: Record<string, Function>, drainNotifications: Function, background: Map }}
 */
export function createAgentTool({
  definitions,
  env,
  makeChildModel,
  labTools = [],
  labImpls = {},
  hooks,
  onChildContext,
  maxConcurrent = 20,
  maxDepth = 3,
  depth = 0,
}) {
  const byName = new Map(definitions.map((definition) => [definition.name, definition]))
  const names = definitions.map((definition) => definition.name)

  const background = new Map()
  const notifications = []
  let counter = 0

  const tools = [
    {
      name: AGENT_TOOL_NAME,
      description: [
        '启动一个子 agent 去做一件自包含的任务。',
        '子 agent 有独立的全新上下文和自己的工具集，看不到你之前的对话，只把最终结论返回给你。',
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

      // ② + ③ 装配一个全新的上下文。
      const system = `${definition.systemPrompt}\n\n${env}`

      // ④ 按定义裁剪工具集 —— 这是「能力」而不是「建议」。
      const selection = selectChildTools(definition, labTools, labImpls)
      const agentId = `agent-${++counter}`
      onChildContext?.({
        type: definition.name,
        agentId,
        description,
        system,
        prompt,
        declaredTools: definition.tools,
        effectiveTools: selection.names,
        unknownTools: selection.unknown,
        messageCount: 1,
      })

      const runOnce = async () => {
        await hooks?.emit('SubagentStart', {
          agentType: definition.name,
          agentId,
          description,
          tools: selection.names,
        })

        const outcome = await runAgent({
          model: makeChildModel(definition, prompt),
          system,
          userMessage: prompt,
          tools: selection.tools,
          impls: selection.impls,
          maxTurns: definition.maxTurns ?? 6,
          tracer: trace.scoped(`${definition.name} ${agentId}`),
          // PreToolUse 可以否决；PostToolUse 可以改写输出（脱敏）。
          toolHook: hooks
            ? async (payload) => {
                const results = await hooks.emit(payload.phase === 'pre' ? 'PreToolUse' : 'PostToolUse', {
                  agentType: definition.name,
                  agentId,
                  toolName: payload.name,
                  toolInput: payload.arguments,
                  toolOutput: payload.output,
                })
                if (payload.phase === 'pre') return combinePreToolUse(results)
                for (const result of results) {
                  if (result?.output !== undefined) return { output: result.output }
                }
                return {}
              }
            : undefined,
        })

        await hooks?.emit('SubagentStop', {
          agentType: definition.name,
          agentId,
          status: outcome.interrupted ? 'interrupted' : 'completed',
          result: outcome.text,
        })
        return outcome.text
      }

      // 定义里写了 background: true 就强制后台 —— 模型说了不算。
      const wantsBackground = run_in_background === true || definition.background === true
      if (!wantsBackground) return await runOnce()

      if (background.size >= maxConcurrent) {
        return `无法启动后台任务：并发上限是 ${maxConcurrent}，当前已有 ${background.size} 个在跑（SPAWN_LIMIT）`
      }

      const bgId = `bg-${counter}`
      const promise = runOnce()
        .then((text) => {
          notifications.push({
            role: 'user',
            content: `【后台通知】子 agent ${definition.name}（${bgId}，任务：${description}）已完成。结论：${text}`,
          })
        })
        .catch((error) => {
          notifications.push({ role: 'user', content: `【后台通知】子 agent ${definition.name}（${bgId}）失败：${error.message}` })
        })
        .finally(() => background.delete(bgId))

      background.set(bgId, promise)
      return `已后台启动 ${bgId}（${definition.name}）：${description}。结果会在之后的某一轮以通知形式送达，你可以继续做别的事。`
    },
  }

  /** 回合开始前被调用：把已完成的后台通知交给父级上下文。 */
  function drainNotifications() {
    return notifications.splice(0, notifications.length)
  }

  return { tools, impls, drainNotifications, background }
}
