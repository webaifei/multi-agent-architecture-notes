/**
 * 第 2 章 · Step 2.4 —— 工具白名单与 hooks：把规则变成代码
 *
 * 前面三节解决的是「怎么派活、怎么收结果」。这一节解决「**怎么不让它闯祸**」。
 *
 * Claude Code 给了两层，而且两层是不同性质的：
 *
 *   ① 工具白名单（`tools` / `disallowedTools`）
 *      这是**能力裁剪**：不在名单里的工具，从子 agent 的提示里直接消失，
 *      调用也会被拒绝（一个可见性）。它不是建议，是权限。
 *
 *   ② hooks（`SubagentStart` / `SubagentStop` / `PreToolUse` / `PostToolUse`）
 *      这是**外部可编程的拦截点**。规则不属于 agent，属于运行它的组织：
 *      审计、阻断、脱敏、计费。写进提示词只能靠模型自觉；写成 hook 才是代码强制。
 *
 * 本节三个演示：
 *   A. explorer 声明了 `tools: Read, Grep, Glob` —— 它拿不到 Bash，调用会失败
 *   B. general-purpose 没声明 tools（继承全部）—— 但它写文件会被 hook 拦下
 *   C. read_file 的输出经过 PostToolUse 脱敏，密钥变成 ***
 *
 * 对应真实系统（docs/sources/claude-code.md）：
 *   - frontmatter：`tools` / `disallowedTools` / `permissionMode` / `hooks`；
 *   - hook 事件：SubagentStart / SubagentStop（matcher = agent 类型）、
 *     子 agent 内的 PreToolUse / PostToolUse（带 agent_id、agent_type）；
 *   - 插件来源的 subagent **不支持** hooks / mcpServers / permissionMode。
 *
 * 运行：node chapter2-claude-code/step4-tools-and-hooks.mjs
 */

import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverAgents } from '../lib/agent-defs.mjs'
import { buildChildEnvironment, createAgentTool, selectChildTools } from '../lib/agent-tool.mjs'
import { HookBus } from '../lib/hooks.mjs'
import { runAgent } from '../lib/loop.mjs'
import { createMockModel } from '../lib/model.mjs'
import { createPolicy } from '../lib/policy.mjs'
import { createToolkit, ensureWorkspace } from '../lib/tools.mjs'
import * as trace from '../lib/trace.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const demoRoot = path.join(root, 'runs', 'step10-demo')
const projectDir = path.join(demoRoot, 'project')
const agentSourceDir = path.join(here, 'agents')

await rm(demoRoot, { recursive: true, force: true })

const write = async (file, content) => {
  await ensureWorkspace(path.dirname(file))
  await writeFile(file, content, 'utf8')
}

await write(path.join(projectDir, 'notes.md'), ['# 多 agent 笔记', '- 拓扑：谁创建谁', '- 隔离：能看见什么', ''].join('\n'))
await write(path.join(projectDir, 'secrets.md'), ['# 内部配置', 'API_KEY=SECRET-12345', 'ENDPOINT=internal.example.com', ''].join('\n'))
const claudeMd = ['# 项目约定', '- 所有文档用中文；', '- 不要输出任何凭据。'].join('\n')
await write(path.join(projectDir, 'CLAUDE.md'), claudeMd)

for (const name of ['explorer', 'verifier', 'scanner', 'general-purpose']) {
  await write(path.join(projectDir, '.claude', 'agents', `${name}.md`), await readFile(path.join(agentSourceDir, `${name}.md`), 'utf8'))
}

const { agents } = await discoverAgents({ cwd: projectDir, stopAt: demoRoot })
const env = buildChildEnvironment({
  cwd: path.relative(root, projectDir),
  claudeMd,
  agentNames: agents.map((agent) => agent.name),
})

const base = createToolkit({ workspace: projectDir, policy: createPolicy({ workspace: projectDir }) })

// ─────────────────────────────────────────────────────────────
// hook 总线：四条规则，全部是「组织的规则」，不是 agent 的提示词
// ─────────────────────────────────────────────────────────────

const hooks = new HookBus()
const startedAt = new Map()

// 审计：谁在什么时候被创建了，拿到了哪些工具
hooks.on(
  'SubagentStart',
  ({ agentType, agentId, tools }) => {
    startedAt.set(agentId, Date.now())
    trace.note(`[hook SubagentStart] ${agentType} ${agentId}｜工具=${tools.join(', ') || '(继承全部)'}`)
  },
  { name: 'audit-start' },
)

// 审计：跑完记账
hooks.on(
  'SubagentStop',
  ({ agentType, agentId, status }) => {
    const ms = Date.now() - (startedAt.get(agentId) ?? Date.now())
    trace.note(`[hook SubagentStop]  ${agentType} ${agentId}｜${status}｜${ms}ms`)
  },
  { name: 'audit-stop' },
)

// 审计：每一次工具调用
hooks.on('PreToolUse', ({ agentType, toolName }) => trace.note(`[hook PreToolUse]  ${agentType} → ${toolName}`), {
  name: 'audit-tools',
})

// 阻断：子 agent 一律不许写文件。这条规则和 agent 角色无关，是组织策略。
hooks.on(
  'PreToolUse',
  ({ agentType }) => ({ decision: 'deny', reason: `组织策略：${agentType} 不允许写文件` }),
  { matcher: 'apply_patch', name: 'deny-writes' },
)

// 脱敏：任何读到的东西都要过一遍，密钥不能进模型上下文
hooks.on(
  'PostToolUse',
  ({ toolOutput }) => ({ output: String(toolOutput).replace(/SECRET-\d+/g, '***') }),
  { matcher: 'read_file', name: 'redact-secrets' },
)

console.log(`\n${trace.bold('已注册的 hook')}`)
for (const row of hooks.list()) {
  console.log(`  ${row.event.padEnd(14)} matcher=${row.matcher.padEnd(12)} ${row.name}`)
}

// ─────────────────────────────────────────────────────────────
// 子 agent 剧本
// ─────────────────────────────────────────────────────────────

const childContexts = []
const agentTool = createAgentTool({
  definitions: agents,
  env,
  labTools: base.tools,
  labImpls: base.impls,
  hooks,
  onChildContext: (context) => childContexts.push(context),
  makeChildModel: (definition, prompt) => {
    if (definition.name === 'explorer' && prompt.includes('secrets')) {
      return createMockModel([
        { text: '', toolCalls: [{ id: 'r1', name: 'read_file', arguments: { filePath: 'secrets.md' } }] },
        { text: 'secrets.md 第一行是 API_KEY=***，第二行是内部域名。', toolCalls: [] },
      ])
    }
    if (definition.name === 'explorer') {
      return createMockModel([
        { text: '', toolCalls: [{ id: 'e1', name: 'read_file', arguments: { filePath: 'notes.md' } }] },
        { text: '再试试用命令看一眼目录。', toolCalls: [{ id: 'e2', name: 'exec_command', arguments: { command: 'ls' } }] },
        { text: 'notes.md 是两条多 agent 要点。我尝试执行命令，但我没有这个工具。', toolCalls: [] },
      ])
    }
    return createMockModel([
      {
        text: '',
        toolCalls: [
          {
            id: 'w1',
            name: 'apply_patch',
            arguments: { patch: ['*** Begin Patch', '*** Add File: out.md', '+写点什么', '*** End Patch'].join('\n') },
          },
        ],
      },
      { text: '我想把结论写进 out.md，但被拒绝了，所以没有创建文件。', toolCalls: [] },
    ])
  },
})

// ─────────────────────────────────────────────────────────────
// 主 agent
// ─────────────────────────────────────────────────────────────

const parentScript = [
  {
    text: '先让 explorer 读笔记。',
    toolCalls: [
      { id: 'p1', name: 'Agent', arguments: { description: '读笔记', prompt: '读 notes.md 并总结。', subagent_type: 'explorer' } },
    ],
  },
  {
    text: '再让它读内部配置（输出会经过脱敏）。',
    toolCalls: [
      {
        id: 'p2',
        name: 'Agent',
        arguments: { description: '读配置', prompt: '读 secrets.md 并告诉我第一行是什么。', subagent_type: 'explorer' },
      },
    ],
  },
  {
    text: '再派一个没有工具限制的通用 agent 去写文件。',
    toolCalls: [
      {
        id: 'p3',
        name: 'Agent',
        arguments: { description: '写结论', prompt: '把结论写进 out.md。', subagent_type: 'general-purpose' },
      },
    ],
  },
  (request) => {
    const results = request.messages.filter((message) => message.role === 'tool').map((message) => String(message.content))
    return { text: ['三轮委派的结果：', ...results.map((text, index) => `${index + 1}. ${text}`)].join('\n'), toolCalls: [] }
  },
]

trace.banner('第 2 章 · Step 2.4  工具白名单与 hooks', '白名单裁剪能力；hook 让外部能阻断与脱敏')

const outcome = await runAgent({
  model: createMockModel(parentScript),
  system: '你是一个统筹 agent。把任务派给子 agent，自己不要读文件。',
  userMessage: '确认笔记内容，读一下内部配置，并把结论写进 out.md。',
  tools: [...base.tools, ...agentTool.tools],
  impls: { ...base.impls, ...agentTool.impls },
  maxTurns: 10,
})

trace.result(outcome.text)

// ─────────────────────────────────────────────────────────────
// 账本：每个孩子实际拿到了什么工具
// ─────────────────────────────────────────────────────────────

console.log(`\n${trace.bold('能力裁剪的结果')}`)
for (const context of childContexts) {
  console.log(`  ${context.agentId}  ${context.type}`)
  console.log(`      声明 tools   ：${(context.declaredTools ?? []).join(', ') || '(未声明 → 继承全部)'}`)
  console.log(`      实际可用工具 ：${context.effectiveTools.join(', ')}`)
}

console.log(`\n${trace.bold('hook 触发统计')}`)
const counts = new Map()
for (const entry of hooks.log) counts.set(entry.event, (counts.get(entry.event) ?? 0) + 1)
for (const [event, count] of counts) console.log(`  ${String(count).padStart(3)} × ${event}`)

const outExists = await readFile(path.join(projectDir, 'out.md'), 'utf8').then(
  () => true,
  () => false,
)
trace.note(`out.md 存在吗？${outExists ? '存在（hook 没拦住，出问题了）' : '不存在 ✅（hook 拦住了写入）'}`)

// 直接展示一次裁剪计算，方便对照
const explorerDef = agents.find((agent) => agent.name === 'explorer')
const selection = selectChildTools(explorerDef, base.tools, base.impls)
console.log(`\n${trace.bold('裁剪计算（explorer）')}`)
console.log(`  全部工具：${base.tools.map((tool) => tool.name).join(', ')}`)
console.log(`  声明能力：${explorerDef.tools.join(', ')} → 映射为 ${selection.names.join(', ')}`)

console.log(`
${'─'.repeat(66)}
这一节记住四件事：

  1. 白名单是**能力**，不是建议。
     被裁掉的工具不是「提示模型别用」，而是从它的工具清单里消失、调用也直接失败。
     这叫「一个可见性」——模型看到的和它实际能做的，必须是同一套。

  2. hook 的位置决定了它能做什么。
     PreToolUse 能**否决**（阻断、审批）；
     PostToolUse 能**改写**（脱敏、截断、记账）；
     SubagentStart/Stop 做生命周期记账。
     想「拦住」就必须在 Pre；想「处理结果」就必须在 Post。

  3. 规则的归属很重要。
     「不许写文件」是组织策略，不该写进 explorer 的提示词里让模型自觉。
     放进 hook，它就和模型无关了 —— 换模型、换提示词、换角色，规则都在。

  4. hook 也要守「模型可见 ⟺ 已落盘」。
     我们的注入、拒绝、脱敏结果都会进 messages，也就都会进日志。
     否则事后审计时，你看到的和模型当时看到的不是同一份东西。

动手练习：
  · 把 deny-writes 的 matcher 改成 '*'，重跑，看 explorer 的 read_file 会不会也被拦。
  · 给 PostToolUse 加一个「输出超过 200 字符就截断」，体会「脱敏」和「截断」是同一类操作。
  · 把脱敏 hook 的返回值从 { output } 改成 undefined，确认密钥会原样进入模型上下文。
  · 把 explorer 的 tools 改成 Read, Bash，看它能做的事多了什么。

Claude Code 还剩最后一步（2.5 三种编排模式），之后就进第 3 章 DeepSeek Harness。
${'─'.repeat(66)}
`)
