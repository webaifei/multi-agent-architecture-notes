/**
 * 第 2 章 · Step 2.2 —— `Agent` 工具：全新上下文，只回传最终消息
 *
 * 上一节我们把角色做成了数据（.md 文件）。这一节回答三家最本质的那个分歧：
 *
 *   **子 agent 该不该看到父级的对话历史？**
 *
 * 三种答案，三种哲学：
 *
 *   Claude Code   默认**全新**。孩子拿到：自己的系统提示词 + 环境块 + 任务提示词
 *                 + CLAUDE.md + git 状态 + 同级 agent 名册。
 *                 拿不到：父级对话历史、父级系统提示词、output style、auto-memory。
 *   Codex         **逐次可选**。Isolated / Inherit / Forked / WarmFork / FullHistory。
 *   DeepSeek Harness **可插拔**。spawn（全新）和 fork（继承）是两个并列 provider。
 *
 * 这一节的实测会给你两个数字：父级历史多大、孩子实际拿到多大。
 *
 * 对应真实系统（docs/sources/claude-code.md）：
 *   - 工具名 `Agent`（v2.1.63 起；旧名 `Task` 仍可作别名）；
 *   - 省略 `subagent_type` 回退到 `general-purpose`，否则报错；
 *   - 「中间的工具调用与结果留在子 agent 内部，只有最终消息回到父级」。
 *
 * 运行：node chapter2-claude-code/step2-agent-tool.mjs
 */

import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverAgents } from '../lib/agent-defs.mjs'
import { buildChildEnvironment, createAgentTool } from '../lib/agent-tool.mjs'
import { runAgent } from '../lib/loop.mjs'
import { createMockModel } from '../lib/model.mjs'
import { createPolicy } from '../lib/policy.mjs'
import { createToolkit, ensureWorkspace } from '../lib/tools.mjs'
import * as trace from '../lib/trace.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const demoRoot = path.join(root, 'runs', 'step8-demo')
const projectDir = path.join(demoRoot, 'project')
const agentSourceDir = path.join(here, 'agents')

await rm(demoRoot, { recursive: true, force: true })

// ─────────────────────────────────────────────────────────────
// 造一个像样的项目：笔记 + CLAUDE.md + .claude/agents/
// ─────────────────────────────────────────────────────────────

const write = async (file, content) => {
  await ensureWorkspace(path.dirname(file))
  await writeFile(file, content, 'utf8')
}

await write(
  path.join(projectDir, 'notes.md'),
  ['# 多 agent 笔记', '- 拓扑：谁创建谁', '- 隔离：能看见什么', '- 收敛：谁决定结束', ''].join('\n'),
)

const claudeMd = ['# 项目约定', '- 所有文档用中文；', '- 结论要短，不要复述原文。'].join('\n')
await write(path.join(projectDir, 'CLAUDE.md'), claudeMd)

// 把仓库里那份声明复制进项目，这样「发现」是真的在走文件系统。
for (const name of ['explorer', 'verifier', 'general-purpose']) {
  const source = await readFile(path.join(agentSourceDir, `${name}.md`), 'utf8')
  await write(path.join(projectDir, '.claude', 'agents', `${name}.md`), source)
}

// ─────────────────────────────────────────────────────────────
// 发现角色（复用 2.1 的能力）
// ─────────────────────────────────────────────────────────────

const { agents } = await discoverAgents({ cwd: projectDir, stopAt: demoRoot })

const env = buildChildEnvironment({
  cwd: path.relative(root, projectDir),
  claudeMd,
  agentNames: agents.map((agent) => agent.name),
  gitStatus: '(clean)',
})

const base = createToolkit({ workspace: projectDir, policy: createPolicy({ workspace: projectDir }) })

/** 每个角色的剧本。函数式 mock，这样汇总内容真的来自工具结果。 */
const childScripts = {
  explorer: [
    { text: '', toolCalls: [{ id: 'x1', name: 'exec_command', arguments: { command: 'cat notes.md' } }] },
    { text: 'notes.md 里是三条多 agent 要点：拓扑、隔离、收敛。', toolCalls: [] },
  ],
  verifier: [
    { text: '', toolCalls: [{ id: 'y1', name: 'exec_command', arguments: { command: 'cat notes.md' } }] },
    { text: '一致。我按行数复核：文件共 4 行，3 条列表项，与结论相符。', toolCalls: [] },
  ],
}

/** 记录每个孩子被装配出来的初始上下文，用来对比。 */
const childContexts = []
const agentTool = createAgentTool({
  definitions: agents,
  env,
  childTools: base.tools,
  childImpls: base.impls,
  onChildContext: (context) => childContexts.push(context),
  makeChildModel: (definition) =>
    createMockModel(childScripts[definition.name] ?? [{ text: `（${definition.name} 没有剧本）`, toolCalls: [] }]),
})

// ─────────────────────────────────────────────────────────────
// 主 agent：先聊了 10 轮无关的事，再派活
// ─────────────────────────────────────────────────────────────

const chatter = []
for (let i = 1; i <= 10; i += 1) {
  chatter.push({ role: 'user', content: `第 ${i} 轮背景交代：${'我们之前讨论过的约定与决策。'.repeat(8)}` })
  chatter.push({ role: 'assistant', content: `收到，第 ${i} 轮我记下了。${'细节记录。'.repeat(8)}` })
}
const task = '帮我确认 notes.md 里写了什么，并复核一遍。'
const parentHistory = [...chatter, { role: 'user', content: task }]

const parentScript = [
  {
    text: '派探索者去读。',
    toolCalls: [
      {
        id: 'g1',
        name: 'Agent',
        arguments: { description: '读笔记', prompt: '读 notes.md，用不超过两句话总结。', subagent_type: 'explorer' },
      },
    ],
  },
  {
    text: '再派验证者独立复核。',
    toolCalls: [
      {
        id: 'g2',
        name: 'Agent',
        arguments: {
          description: '独立复核',
          prompt: '用与探索者不同的方法，复核 notes.md 是否只有三条要点。',
          subagent_type: 'verifier',
        },
      },
    ],
  },
  (request) => {
    const results = request.messages.filter((message) => message.role === 'tool').map((message) => String(message.content))
    return { text: [`探索者：${results[0] ?? ''}`, `验证者：${results[1] ?? ''}`].join('\n'), toolCalls: [] }
  },
]

trace.banner('第 2 章 · Step 2.2  Agent 工具与上下文隔离', '子 agent 看不到父级历史，只回传最终消息')
trace.note(`父 agent 已经有 ${chatter.length} 条历史，现在派两个子 agent。`)

const outcome = await runAgent({
  model: createMockModel(parentScript),
  system: '你是一个统筹 agent。把探索类任务派给子 agent，自己不要读文件。',
  history: parentHistory,
  tools: [...base.tools, ...agentTool.tools],
  impls: { ...base.impls, ...agentTool.impls },
  maxTurns: 8,
})

trace.result(outcome.text)

// ─────────────────────────────────────────────────────────────
// 对照：孩子到底看到了什么
// ─────────────────────────────────────────────────────────────

const parentChars = JSON.stringify(parentHistory).length

console.log(`\n${trace.bold('孩子被装配出来的初始上下文（以 explorer 为例）')}`)
const explorerContext = childContexts.find((context) => context.type === 'explorer')
console.log('  ┌─ system（= 定义正文 + 环境块）')
for (const line of explorerContext.system.split('\n')) console.log(`  │ ${line}`)
console.log('  ├─ messages')
console.log(`  │ [0] user: ${explorerContext.prompt}`)
console.log('  └─ 一共 1 条 message')

console.log(`\n${trace.bold('成本对比')}`)
const childChars = childContexts.reduce(
  (sum, context) => sum + context.system.length + context.prompt.length,
  0,
)
console.log(`  父 agent 的起始上下文：${parentChars} 字符（${parentHistory.length} 条 message）`)
for (const context of childContexts) {
  console.log(`  子 agent ${context.type}：${context.system.length + context.prompt.length} 字符（1 条 message）`)
}
console.log(`  实际总输入：${parentChars + childChars} 字符`)
console.log(`  如果每个孩子都继承父级历史：${parentChars} × ${1 + childContexts.length} = ${parentChars * (1 + childContexts.length)} 字符`)
trace.note(`本节的隔离策略，为每个孩子省下约 ${parentChars} 字符的上下文。`)

console.log(`
${'─'.repeat(66)}
这一节记住四件事：

  1. 隔离不是「少发点东西」，是**结构上没有那条通道**。
     Agent 工具只接受 { description, prompt, subagent_type }，父级历史根本没有参数可传。
     想让孩子知道什么，只能写进 prompt —— 这强迫你把任务描述写成自包含的。

  2. 隔离省的是两样：钱，和「跑偏」。
     钱好理解：上面那两个数字。跑偏更隐蔽：父级里那些没验证过的假设、被否决的方案，
     一旦传染给孩子，它会一本正经地把错的接着往下做。

  3. 隔离的代价是：孩子不懂你的约定。
     所以才有 CLAUDE.md、git 状态、同级名册这些「补给」——
     它们不是历史，是**长期有效的背景**。这一手很关键：
     把「会过期的对话」和「长期有效的约定」分开，只把后者带给孩子。

  4. 三家在这里的差别，是默认值与可选性的差别。
     Claude Code 默认全新，Codex 逐次可选，Harness 直接做成两个可插拔的 provider。
     没有谁更对：默认全新适合并行与省钱，可继承适合多轮协作。

动手练习：
  · 把 explorer 的 prompt 改短（只留「读 notes.md 并总结」），看孩子还能不能完成任务 ——
    体会「自包含」这个要求有多硬。
  · 把 makeChildModel 换成读 explorer 的 system，把「不知道自己在哪个目录」暴露出来。
  · 在 env 里删掉 available agents 那一行，观察「同级名册」缺失会带来什么。
  · 把 chatter 加到 100 轮，重跑，看成本对比那个数字怎么变 —— 这就是隔离的收益曲线。

下一节（2.3）回答一个新问题：
  既然孩子看不到历史、还各自独立，那**同时开 5 个**会怎样？
  谁来决定「用哪几个」？答案在 Claude Code 的写法里是 —— 由模型自己决定。
${'─'.repeat(66)}
`)
