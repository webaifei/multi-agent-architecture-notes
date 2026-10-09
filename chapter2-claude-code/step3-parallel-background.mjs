/**
 * 第 2 章 · Step 2.3 —— 并行与后台任务：晚到的结果怎么交回来
 *
 * 2.2 解决了「孩子看不到父亲」。这一节解决一个更麻烦的问题：
 *
 *   **一次派 5 个，有的马上要、有的不急 —— 结果怎么收？**
 *
 * 两种设计，两种代价：
 *
 *   Codex         `spawn_agent` + `wait_agent`：父 agent **主动去等**某个 id。
 *                 好处：完全可控，想等谁等谁。代价：父 agent 得记得谁是谁。
 *
 *   Claude Code   `run_in_background: true`：立刻返回，**结果自己送上门**——
 *                 在之后的某一轮，以一条「完成通知」的形式注入父级上下文。
 *                 好处：父 agent 不用记 id、继续干活就行。代价：你无法确定它什么时候到。
 *
 * 本节实现第二种。为了实现它，循环第一次开了「回合边界注入」这个扩展点：
 *
 *   真实系统的对应物：
 *     - Claude Code  Agent 的 `run_in_background`；定义里的 `background: true` 会**强制**后台；
 *       并发默认 20，嵌套深度默认 3；后台结果在之后的某一轮以通知形式到达。
 *     - Codex        邮箱的 `QueueOnly` 投递（`deliver_mailbox_communication_to_current_turn`）——
 *       也是「在回合边界把消息交给模型」，不打断正在进行的回合。
 *
 * 运行：node chapter2-claude-code/step3-parallel-background.mjs
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
const demoRoot = path.join(root, 'runs', 'step9-demo')
const projectDir = path.join(demoRoot, 'project')
const agentSourceDir = path.join(here, 'agents')

await rm(demoRoot, { recursive: true, force: true })

// ─────────────────────────────────────────────────────────────
// 项目脚手架（同 2.2）
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

for (const name of ['explorer', 'verifier', 'scanner', 'general-purpose']) {
  const source = await readFile(path.join(agentSourceDir, `${name}.md`), 'utf8')
  await write(path.join(projectDir, '.claude', 'agents', `${name}.md`), source)
}

const { agents } = await discoverAgents({ cwd: projectDir, stopAt: demoRoot })
const env = buildChildEnvironment({
  cwd: path.relative(root, projectDir),
  claudeMd,
  agentNames: agents.map((agent) => agent.name),
  gitStatus: '(clean)',
})

const base = createToolkit({ workspace: projectDir, policy: createPolicy({ workspace: projectDir }) })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const withDelay = (model, ms) => ({
  name: model.name,
  async complete(request) {
    await sleep(ms)
    return model.complete(request)
  },
})

const childScripts = {
  explorer: [
    { text: '', toolCalls: [{ id: 'e1', name: 'exec_command', arguments: { command: 'cat notes.md' } }] },
    { text: 'notes.md 是三条多 agent 要点：拓扑、隔离、收敛。', toolCalls: [] },
  ],
  scanner: [
    { text: '', toolCalls: [{ id: 's1', name: 'exec_command', arguments: { command: 'cat notes.md' } }] },
    { text: '扫描完成：文件 4 行，3 条列表项，无异常。', toolCalls: [] },
  ],
  verifier: [
    { text: '', toolCalls: [{ id: 'v1', name: 'exec_command', arguments: { command: 'ls' } }] },
    { text: '一致。目录里只有 notes.md 与 CLAUDE.md。', toolCalls: [] },
  ],
}

/** 后台角色慢一点，这样「通知晚到」才看得出来。 */
const delays = { explorer: 0, scanner: 30, verifier: 30 }

const childContexts = []
const agentTool = createAgentTool({
  definitions: agents,
  env,
  childTools: base.tools,
  childImpls: base.impls,
  maxConcurrent: 2,
  onChildContext: (context) => childContexts.push(context),
  makeChildModel: (definition) =>
    withDelay(createMockModel(childScripts[definition.name] ?? [{ text: `（${definition.name} 无剧本）`, toolCalls: [] }]), delays[definition.name] ?? 0),
})

// ─────────────────────────────────────────────────────────────
// 主 agent：一个前台 + 两个后台，中间还干了点别的
// ─────────────────────────────────────────────────────────────

const pauseTool = {
  name: 'pause',
  description: '暂停若干毫秒（教学用工具，用来制造时间窗口）。',
  parameters: { type: 'object', properties: { ms: { type: 'number' } }, required: ['ms'] },
}

const parentScript = [
  {
    text: '先派一个前台的探索者，这个结论我马上要用。',
    toolCalls: [
      {
        id: 'a1',
        name: 'Agent',
        arguments: { description: '读笔记', prompt: '读 notes.md，用两句话总结。', subagent_type: 'explorer' },
      },
    ],
  },
  {
    text: '再派一个后台扫描者 —— 注意我**没有**传 run_in_background，是它的定义里写了 background: true。',
    toolCalls: [
      {
        id: 'a2',
        name: 'Agent',
        arguments: { description: '扫描一致性', prompt: '安静地检查 notes.md 有没有异常。', subagent_type: 'scanner' },
      },
    ],
  },
  {
    text: '再显式起一个后台验证者。',
    toolCalls: [
      {
        id: 'a3',
        name: 'Agent',
        arguments: {
          description: '后台复核',
          prompt: '后台复核 notes.md 的列表项数量。',
          subagent_type: 'verifier',
          run_in_background: true,
        },
      },
    ],
  },
  {
    text: '后台还在跑，我先干点别的。',
    toolCalls: [{ id: 'a4', name: 'pause', arguments: { ms: 90 } }],
  },
  (request) => {
    const notices = request.messages
      .filter((message) => message.role === 'user' && String(message.content).includes('【后台通知】'))
      .map((message) => String(message.content))
    return {
      text: notices.length > 0 ? `后台任务回报了：\n${notices.map((text) => `· ${text}`).join('\n')}` : '后台任务还没回来。',
      toolCalls: [],
    }
  },
]

trace.banner('第 2 章 · Step 2.3  并行与后台任务', '前台阻塞等结果；后台自己把通知送上门')

const outcome = await runAgent({
  model: createMockModel(parentScript),
  system: '你是一个统筹 agent。把检查类任务派给子 agent，自己不要读文件。',
  userMessage: '确认 notes.md 的内容，并做一轮一致性检查。',
  tools: [...base.tools, ...agentTool.tools, pauseTool],
  impls: {
    ...base.impls,
    ...agentTool.impls,
    pause: async ({ ms }) => {
      await sleep(Math.min(Number(ms) || 0, 2000))
      return `已等待 ${ms}ms`
    },
  },
  maxTurns: 10,
  // 唯一的新接线：回合边界把已完成的后台通知交给父级上下文。
  injectMessages: () => agentTool.drainNotifications(),
})

trace.result(outcome.text)

console.log(`\n${trace.bold('父 agent 最终的 messages')}`)
outcome.messages.forEach((message, index) => {
  const label = `${index}`.padStart(2, ' ')
  if (message.role === 'tool') {
    console.log(`  ${label} tool      ${oneLine(message.content, 62)}`)
  } else if (message.role === 'assistant' && message.tool_calls) {
    console.log(`  ${label} assistant → 调用 ${message.tool_calls.map((call) => call.function.name).join(', ')}`)
  } else {
    console.log(`  ${label} ${message.role.padEnd(9)} ${oneLine(message.content, 62)}`)
  }
})
trace.note('注意最后那两条 role=user 的消息：它们不是用户说的，是后台任务的完成通知被**注入**进来的。')
trace.note('它们同样被写进了会话日志 —— 模型可见的东西必须可回放。')

// ─────────────────────────────────────────────────────────────
// 并发闸门：超了直接拒绝，不排队
// ─────────────────────────────────────────────────────────────

trace.banner('并发闸门', 'maxConcurrent = 1 时，第二个后台任务会被直接拒绝')

const smallTool = createAgentTool({
  definitions: agents,
  env,
  childTools: base.tools,
  childImpls: base.impls,
  maxConcurrent: 1,
  makeChildModel: (definition) =>
    withDelay(createMockModel(childScripts[definition.name] ?? [{ text: '（无剧本）', toolCalls: [] }]), 60),
})

trace.note(`第一次：${await smallTool.impls.Agent({ description: '第一个', prompt: '扫描一下', subagent_type: 'scanner' })}`)
trace.note(`第二次：${await smallTool.impls.Agent({ description: '第二个', prompt: '再扫描一下', subagent_type: 'scanner' })}`)
await Promise.all([...smallTool.background.values()])
trace.note('第一个跑完后，通知才进入队列。')

console.log(`
${'─'.repeat(66)}
这一节记住四件事：

  1. 「并行」和「收结果」是两个问题，别混为一谈。
     Claude Code 用 run_in_background 解决前者，用「通知注入」解决后者；
     Codex 用 spawn/wait 分离解决后者。两条路都行，但代价不同。

  2. 后台任务的本质是**延迟未知**。
     父 agent 无法知道通知什么时候到，所以它必须能在「信息不全」的情况下继续工作。
     这也是为什么定义里的 background: true 能**强制**后台 —— 有些任务天生就是「不急」。

  3. 注入必须发生在回合边界。
     不能在模型调用中途塞消息（会破坏协议），也不能在工具执行中途塞（会打断副作用）。
     真实系统同理：Codex 的邮箱是 QueueOnly，Harness 的 steer 也是排队投递。

  4. 注入的消息也是「模型可见」，所以也必须落盘。
     我们把每一条注入事件都写进 JSONL（type: user/message, source: background）。
     漏了这一步，重放出来的上下文就和当时不一样了 —— 1.3 那个断言会当场抓住你。

动手练习：
  · 把 pause 的 90ms 改成 10ms，看父 agent 最后一轮还能不能收到通知（感受「延迟未知」）。
  · 把 scanner 定义里的 background: true 删掉，再跑一次，看它变成前台阻塞。
  · 把 maxConcurrent 改成 1，重跑主流程，观察第三个 Agent 调用被拒后的连锁反应。
  · 给注入的通知加上 agent id，然后写个断言：注入的消息必须能在日志里重放出来。

Claude Code 这一章还剩两步（2.4 权限白名单与 hooks、2.5 三种编排模式），
之后就是第 3 章 DeepSeek Harness —— 那里会把三家合体：能力接缝 + 共享任务板 + 持久团队。
${'─'.repeat(66)}
`)

/** 压成一行并截断。 */
function oneLine(text, max) {
  const flat = String(text ?? '').replace(/\n/g, ' ⏎ ')
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}
