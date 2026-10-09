/**
 * 第 2 章 · Step 2.1 —— 声明式子 agent：一个 Markdown 文件就是一个角色
 *
 * Codex 加一个角色要写代码/TOML；Claude Code 只要往目录里丢一个 .md：
 *
 *   ---
 *   name: explorer            ← 必填
 *   description: 只读探索者。  ← 必填，主 agent 靠它判断「什么时候该叫我」
 *   tools: Read, Grep, Glob
 *   ---
 *   你是一个只读探索者……

 * frontmatter 是配置，正文是系统提示词。本节只做「发现与装配」，2.2 才让主 agent 真的调用它。
 *
 * 三个必须记住的点：
 *   ① 只有 name / description 必填；
 *   ② 未知字段被静默忽略 —— 拼错 tools 不报错，只是「写了没生效」（本节会把这个坑演示出来）；
 *   ③ 发现顺序有优先级，**最近的赢**：CLI 覆盖 > 项目（越靠近 cwd 越优先）> 用户目录。
 *
 * 对应真实系统（见 docs/sources/claude-code.md）：
 *   项目 `.claude/agents/`、用户 `~/.claude/agents/`、插件 `agents/`；
 *   项目级从 cwd 向上查找，最近的赢；目录递归扫描，子目录名成为命名空间前缀。
 *
 * 运行：node chapter2-claude-code/step1-agent-defs.mjs [--strict]
 */

import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverAgents, normalizeAgent, parseAgentMarkdown } from '../lib/agent-defs.mjs'
import { ensureWorkspace } from '../lib/tools.mjs'
import * as trace from '../lib/trace.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const demoRoot = path.join(root, 'runs', 'step7-demo')
const projectDir = path.join(demoRoot, 'project')

await rm(demoRoot, { recursive: true, force: true })

// ─────────────────────────────────────────────────────────────
// 造一棵带「优先级冲突」的项目树
// ─────────────────────────────────────────────────────────────

/** 离 cwd 更近的这一份应该赢。 */
const nearExplorer = `---
name: explorer
description: 只读探索者（项目内版本）。需要摸清代码结构、找文件、找符号时用它。
tools: Read, Grep, Glob
model: sonnet
---
你是一个只读探索者。只做两件事：定位文件、总结结构。

硬性约束：
- 不要修改任何文件；
- 不要执行会改变状态的命令；
- 结论要短，给出文件路径和一句话说明。
`

/** 上一层项目目录里的同名定义应该被覆盖。 */
const farExplorer = `---
name: explorer
description: 只读探索者（被覆盖的旧版本）。
tools: Read
---
旧版本的提示词。
`

/** 故意把 tools 拼成 tool —— 真实 Claude Code 会静默忽略，这就是最常见的坑。 */
const typoSummarizer = `---
name: summarizer
description: 把多个子 agent 的结论压缩成一段话。
tool: Read, Grep
maxTurns: 3
colour: blue
---
你负责汇总。把输入压成不超过三句话。
`

const reviewer = `---
name: reviewer
description: 代码审查者。对实现挑刺，优先指出失败路径。
tools: [Read, Grep]
model: opus
background: true
---
你是审查者。只关心：边界条件、失败路径、以及被忽略的错误。
不要提风格问题。
`

const verifier = `---
name: verifier
description: 独立验证者（用户级）。用不同的方法复核结论。
---
你是验证者。用与提问者不同的路径重新推导一遍，只回答「一致」或「不一致 + 原因」。
`

const write = async (file, content) => {
  await ensureWorkspace(path.dirname(file))
  await writeFile(file, content, 'utf8')
}

await write(path.join(projectDir, '.claude', 'agents', 'explorer.md'), nearExplorer)
await write(path.join(projectDir, '.claude', 'agents', 'summarizer.md'), typoSummarizer)
await write(path.join(projectDir, '.claude', 'agents', 'reviewer.md'), reviewer)
await write(path.join(demoRoot, '.claude', 'agents', 'explorer.md'), farExplorer)
await write(path.join(demoRoot, 'user-agents', 'verifier.md'), verifier)

// ─────────────────────────────────────────────────────────────
// 发现
// ─────────────────────────────────────────────────────────────

const strict = process.argv.includes('--strict')

trace.banner('第 2 章 · Step 2.1  声明式子 agent', `cwd = ${path.relative(root, projectDir)}`)

// `--agents` CLI 覆盖：优先级最高，用来临时改行为而不动文件。
const cliOverride = normalizeAgent({
  ...parseAgentMarkdown(
    ['---', 'name: reviewer', 'description: 审查者（CLI 临时覆盖版，优先于项目文件）。', 'tools: Read', '---', '这一版只读，不做任何写操作。'].join('\n'),
    '--agents',
  ),
  file: '--agents JSON',
  scope: 'cli',
})

const userDir = path.join(demoRoot, 'user-agents')
const { agents, shadowed, sources } = await discoverAgents({
  cwd: projectDir,
  userDir,
  stopAt: demoRoot, // 教学简化：真实 Claude Code 会一直找到文件系统根
  overrides: [cliOverride],
})

console.log(`${trace.bold('扫描到的位置')}`)
for (const source of sources) {
  console.log(`  [${source.scope.padEnd(7)}] ${path.relative(root, source.dir)}  (${source.count} 个)`)
}

console.log(`\n${trace.bold('最终生效的 agent')}`)
for (const agent of agents) {
  const tools = agent.tools.length > 0 ? agent.tools.join('/') : '(继承全部工具)'
  console.log(`  ${agent.name.padEnd(11)} ${String(agent.model ?? '-').padEnd(7)} tools=${tools.padEnd(18)} ${agent.description}`)
  console.log(`  ${' '.repeat(11)} 来源：${agent.scope} · ${path.relative(root, agent.file)}`)
}

console.log(`\n${trace.bold('被覆盖的定义')}`)
if (shadowed.length === 0) console.log('  （无）')
for (const item of shadowed) {
  console.log(`  ${item.name}：${path.relative(root, item.file)}（${item.scope}）被 ${path.relative(root, item.winner)}（${item.winnerScope}）覆盖`)
}
trace.note('规则：越靠近 cwd 的赢；CLI 覆盖压在所有文件之上。')

// ─────────────────────────────────────────────────────────────
// 那个坑：未知字段被静默忽略
// ─────────────────────────────────────────────────────────────

console.log(`\n${trace.bold('未知字段陷阱')}`)
const summarizer = agents.find((agent) => agent.name === 'summarizer')
for (const warning of summarizer.warnings) console.log(`  ⚠️  ${warning}`)
trace.note('真实 Claude Code 不会报这个错：它直接忽略不认识的字段，于是「写了没生效」。')
trace.note('本仓库额外把 warning 暴露出来；再往上加一层 --strict 可以直接失败：')
if (strict && summarizer.warnings.length > 0) {
  trace.error('--strict 模式：存在被忽略的字段，直接失败')
  process.exitCode = 1
} else {
  trace.note('（加 --strict 运行本文件，就能把 warning 变成硬失败）')
}

// ─────────────────────────────────────────────────────────────
// frontmatter 是配置，正文是系统提示词
// ─────────────────────────────────────────────────────────────

const winner = agents.find((agent) => agent.name === 'explorer')
const raw = await readFile(winner.file, 'utf8')

console.log(`\n${trace.bold('生效的 explorer 定义（原文）')}`)
console.log(raw.trimEnd().replace(/^/gm, '  │ '))

console.log(`\n${trace.bold('装配结果')}`)
console.log(`  systemPrompt 长度：${winner.systemPrompt.length} 字符`)
console.log(`  tools：${winner.tools.join(', ') || '(未声明 → 继承)'}`)
console.log(`  model：${winner.model ?? '(未声明 → 继承)'}`)
console.log(`  background：${winner.background}`)
trace.note('2.2 会把这段 systemPrompt 装进一个**全新的上下文窗口**，交给 Agent 工具创建的子 agent。')

console.log(`
${'─'.repeat(66)}
这一节记住四件事：

  1. 角色是数据，不是代码。
     加一个子 agent = 加一个 .md 文件，不需要重新编译、不需要改装配逻辑。

  2. description 是**路由**，不是说明文字。
     主 agent 完全靠它判断「这个任务该叫哪个 agent」。写得含糊，就不会被选中。

  3. 未知字段静默忽略 —— 这是「写了没生效」的头号原因。
     真实产品为了宽容而不报错；但你要知道自己在冒险。
     本仓库的做法：把 warning 暴露出来，并提供 --strict 让它变成硬失败。

  4. 同名定义按范围决定谁赢：CLI 覆盖 > 项目（越近越优先）> 用户。
     所以「我改了 .claude/agents/foo.md 怎么没生效」的答案通常是：
     还有一份离 cwd 更近的 foo.md 把它盖住了。

动手练习：
  · 删掉 project/.claude/agents/explorer.md，重跑，观察上一层的旧版本接管。
  · 给 verifier 加上 tools: Read, Bash，看它怎么出现在最终表里。
  · 把 summarizer 的 tool 改回 tools，确认 warning 消失。
  · 给 .claude/agents/ 建一个子目录 review/security.md，看它能不能被发现（真实系统会递归扫描）。
${'─'.repeat(66)}
`)
