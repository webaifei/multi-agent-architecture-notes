/**
 * 第 1 章 · Step 1.6 —— 并行、邮箱与中断（第 1 章收尾）
 *
 * 1.5 造出了子 agent，但只用了「派一个、等一个」。这一节把 Codex 的另一半动词补齐，
 * 顺便回答多 agent 最实际的两个问题：**怎么同时干几件事**、**怎么中途改主意/叫停**。
 *
 * 三个演示：
 *
 *   ① 并行 fan-out：一次派三个，一起等 —— 墙钟时间接近「最慢的那个」，不是三者之和
 *   ② 邮箱 steering：send_message 只排队（QueueOnly），不打断正在跑的回合；
 *      followup_task 才是「明确触发一个新回合」——这两个的区别是 Codex 的关键设计
 *   ③ 中断：interrupt_agent 只发信号、立刻返回；取消是**协作式**的，
 *      在回合边界生效，不会硬杀正在执行的东西
 *
 * 对应真实系统（docs/sources/codex.md）：
 *   - V2 工具族：spawn_agent / send_message / followup_task / wait_agent /
 *     interrupt_agent / list_agents
 *   - `send_message` 投递模式是 `MessageDeliveryMode::QueueOnly`
 *   - 状态取值：PendingInit | Running | Completed | Errored | Interrupted | Shutdown | NotFound
 *
 * 运行：node chapter1-codex/step6-parallel-mailbox.mjs
 */

import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runAgent } from '../lib/loop.mjs'
import { createMockModel } from '../lib/model.mjs'
import { createPolicy } from '../lib/policy.mjs'
import { AgentRegistry } from '../lib/subagent.mjs'
import { createSubagentTools } from '../lib/subagent-tools.mjs'
import { createToolkit, ensureWorkspace } from '../lib/tools.mjs'
import * as trace from '../lib/trace.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const demoRoot = path.join(root, 'runs', 'step6-demo')
const workspace = path.join(demoRoot, 'workspace')
const sessionsDir = path.join(demoRoot, 'sessions')

await rm(demoRoot, { recursive: true, force: true })
await ensureWorkspace(workspace)
await writeFile(
  path.join(workspace, 'notes.md'),
  ['# 多 agent 笔记', '- 拓扑：谁创建谁', '- 隔离：能看见什么', '- 收敛：谁决定结束', ''].join('\n'),
  'utf8',
)

const base = createToolkit({ workspace, policy: createPolicy({ sandbox: 'workspace-write', approval: 'never', workspace }) })
const CHILD_SYSTEM = '你是一个子 agent，只负责一件自包含的小任务，拿到足够信息就给出简短结论。'
const PARENT_SYSTEM = '你是一个统筹 agent。派活给子 agent，回收它们的结论，然后汇总给用户。'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ─────────────────────────────────────────────────────────────
// 演示 ① 并行 fan-out
// ─────────────────────────────────────────────────────────────

const roles = [
  { label: 'reader', ms: 60, conclusion: 'notes.md 一共 4 行，前三行是三条要点。' },
  { label: 'lister', ms: 60, conclusion: '工作目录里只有 notes.md 一个文件。' },
  { label: 'counter', ms: 60, conclusion: 'notes.md 里有 3 条列表项。' },
]

/** 每个角色一个模型：先查一下，再给结论；故意慢一点，好看出并行与串行的差别。 */
function roleModel({ label, ms, conclusion }) {
  return {
    name: `role:${label}`,
    async complete({ messages }) {
      await sleep(ms)
      const looked = messages.some((message) => message.role === 'tool')
      if (!looked) {
        return { text: `我是 ${label}，先查一下。`, toolCalls: [{ id: `${label}-1`, name: 'exec_command', arguments: { command: 'ls' } }] }
      }
      return { text: conclusion, toolCalls: [] }
    },
  }
}

const registry1 = new AgentRegistry({
  workspace,
  sessionsDir,
  system: CHILD_SYSTEM,
  maxThreads: 3,
  maxDepth: 1,
  makeRun: (handle) => {
    const role = roles.find((item) => item.label === handle.label) ?? roles[0]
    const nested = createSubagentTools({ registry: registry1, callerId: handle.id, callerDepth: handle.depth })
    return { model: roleModel(role), tools: [...base.tools, ...nested.tools], impls: { ...base.impls, ...nested.impls } }
  },
})

const sub1 = createSubagentTools({ registry: registry1, callerId: 'root', callerDepth: 0 })

const fanOutScript = [
  ...roles.map((role, index) => ({
    text: `派第 ${index + 1} 个 agent：${role.label}。`,
    toolCalls: [
      {
        id: `f${index + 1}`,
        name: 'spawn_agent',
        arguments: { task: `以 ${role.label} 的身份查看工作目录，给出一句结论。`, name: role.label },
      },
    ],
  })),
  ...roles.map((_, index) => ({
    text: `等第 ${index + 1} 个。`,
    toolCalls: [{ id: `w${index + 1}`, name: 'wait_agent', arguments: { agent_id: `agent-${index + 1}` } }],
  })),
  (request) => {
    const results = request.messages
      .filter((message) => message.role === 'tool')
      .map((message) => String(message.content))
    const conclusions = roles
      .map((role, index) => {
        const hit = results.find((text) => text.includes(`agent: agent-${index + 1}`))
        return `· ${role.label}：${extractAnswer(hit ?? '')}`
      })
      .join('\n')
    return { text: `三个子 agent 的结论：\n${conclusions}`, toolCalls: [] }
  },
]

trace.banner('演示 ① 并行 fan-out', '一次派三个，再一起等')
const startedAt = Date.now()
const fanOut = await runAgent({
  model: createMockModel(fanOutScript),
  system: PARENT_SYSTEM,
  userMessage: '同时确认一下 notes.md 的行数、目录里的文件数、以及列表项数量。',
  tools: [...base.tools, ...sub1.tools],
  impls: { ...base.impls, ...sub1.impls },
  maxTurns: 12,
})
const wallClock = Date.now() - startedAt
trace.result(fanOut.text)

const spans = registry1.list().map((handle) => new Date(handle.finishedAt) - new Date(handle.startedAt))
console.log(`\n${trace.bold('并行 vs 串行')}`)
for (const handle of registry1.list()) {
  console.log(`  ${handle.id}  ${handle.label.padEnd(8)} 耗时 ${new Date(handle.finishedAt) - new Date(handle.startedAt)}ms`)
}
console.log(`  三个子 agent 各自耗时之和 = ${spans.reduce((a, b) => a + b, 0)}ms`)
console.log(`  实际墙钟时间（父 agent 全程） = ${wallClock}ms`)
trace.note('并行不是免费的：墙钟时间由最慢的那个决定，而且它们会同时抢工具、抢沙箱、抢模型配额。')

// ─────────────────────────────────────────────────────────────
// 演示 ② 邮箱 steering 与 followup_task
// ─────────────────────────────────────────────────────────────

const registry2 = new AgentRegistry({
  workspace,
  sessionsDir,
  system: CHILD_SYSTEM,
  maxThreads: 2,
  maxDepth: 1,
  idPrefix: 'mail',
  makeRun(handle) {
    return {
      model: {
        name: 'analyst-mock',
        async complete({ messages }) {
          await sleep(25)
          const toolResults = messages.filter((message) => message.role === 'tool').length
          const userTurns = messages.filter((message) => message.role === 'user').length
          if (toolResults === 0) {
            // 注意：这里**先不取邮箱**。回合还没结束，插话应当留到下一次模型调用。
            return { text: '先数一下行数。', toolCalls: [{ id: `${handle.id}-1`, name: 'exec_command', arguments: { command: 'wc -l notes.md' } }] }
          }
          const inbox = registry2.drainMailbox(handle.id)
          if (inbox.length > 0) return { text: `收到新指示「${inbox.join('；')}」—— notes.md 共 4 行。`, toolCalls: [] }
          if (userTurns >= 2) return { text: '复核过了，notes.md 仍然是 4 行。', toolCalls: [] }
          return { text: 'notes.md 共 4 行，内容是三条多 agent 要点。', toolCalls: [] }
        },
      },
      tools: base.tools,
      impls: base.impls,
    }
  },
})

const sub2 = createSubagentTools({ registry: registry2, callerId: 'root', callerDepth: 0 })

const mailboxScript = [
  {
    text: '派一个分析者，它有点慢。',
    toolCalls: [{ id: 'm1', name: 'spawn_agent', arguments: { task: '统计 notes.md 有多少行，并说明内容。', name: 'analyst' } }],
  },
  {
    text: '趁它还在跑，插一句话。',
    toolCalls: [
      { id: 'm2', name: 'send_message', arguments: { agent_id: 'mail-1', message: '只汇报行数就行，不要描述内容。' } },
    ],
  },
  { text: '等它把这一轮做完。', toolCalls: [{ id: 'm3', name: 'wait_agent', arguments: { agent_id: 'mail-1' } }] },
  {
    text: '再让它追加一个新回合做复核。',
    toolCalls: [{ id: 'm4', name: 'followup_task', arguments: { agent_id: 'mail-1', task: '再复核一次行数。' } }],
  },
  { text: '等复核结果。', toolCalls: [{ id: 'm5', name: 'wait_agent', arguments: { agent_id: 'mail-1' } }] },
  (request) => {
    const results = request.messages.filter((message) => message.role === 'tool').map((message) => String(message.content))
    const waits = results.filter((text) => text.startsWith('status:'))
    return {
      text: [
        '同一个子 agent 的两段输出：',
        `· 第一回合（被插话影响）：${extractAnswer(waits[0] ?? '')}`,
        `· 第二回合（followup）：${extractAnswer(waits[1] ?? '')}`,
      ].join('\n'),
      toolCalls: [],
    }
  },
]

trace.banner('演示 ② 邮箱 steering 与 followup_task', 'send_message 只排队；followup_task 才触发新回合')
const mailboxRun = await runAgent({
  model: createMockModel(mailboxScript),
  system: PARENT_SYSTEM,
  userMessage: '看看笔记多少行，尽量简短。',
  tools: [...base.tools, ...sub2.tools],
  impls: { ...base.impls, ...sub2.impls },
  maxTurns: 10,
})
trace.result(mailboxRun.text)

const mailHandle = registry2.get('mail-1')
console.log(`\n${trace.bold('邮箱语义')}`)
trace.note('send_message 的投递模式是 queue-only：不打断正在进行的回合，只在对方下一次模型调用前送达。')
trace.note('followup_task 会真的启动一个新回合，并且复用同一个会话日志文件。')
trace.note(`mail-1 的日志：${path.relative(root, mailHandle.logFile)}（两个回合写在同一个文件里）`)

// ─────────────────────────────────────────────────────────────
// 演示 ③ 中断
// ─────────────────────────────────────────────────────────────

const registry3 = new AgentRegistry({
  workspace,
  sessionsDir,
  system: CHILD_SYSTEM,
  maxThreads: 2,
  maxDepth: 1,
  idPrefix: 'sleepy',
  makeRun(handle) {
    return {
      model: {
        name: 'sleeper-mock',
        async complete({ messages }) {
          const used = messages.some((message) => message.role === 'tool')
          if (!used) {
            return { text: '我要一直等一个信号。', toolCalls: [{ id: 's1', name: 'wait_for_signal', arguments: {} }] }
          }
          return { text: '（不该走到这里）', toolCalls: [] }
        },
      },
      tools: [],
      impls: {
        // 这个工具会一直挂着，直到收到中断信号才返回 —— 用来把「协作式取消」演清楚。
        wait_for_signal: () =>
          new Promise((resolve) => {
            const signal = registry3.get(handle.id).controller.signal
            if (signal.aborted) return resolve('早已收到停止信号')
            signal.addEventListener('abort', () => resolve('收到停止信号，停止等待'), { once: true })
          }),
      },
    }
  },
})

const sub3 = createSubagentTools({ registry: registry3, callerId: 'root', callerDepth: 0 })

const pauseTool = {
  name: 'pause',
  description: '暂停若干毫秒（教学用工具，用来制造时间窗口）。',
  parameters: { type: 'object', properties: { ms: { type: 'number' } }, required: ['ms'] },
}

const interruptScript = [
  {
    text: '派一个会一直等的 agent。',
    toolCalls: [{ id: 'i1', name: 'spawn_agent', arguments: { task: '一直等到有人叫你停。', name: 'sleeper' } }],
  },
  { text: '给它一点时间真的挂起来。', toolCalls: [{ id: 'i2', name: 'pause', arguments: { ms: 60 } }] },
  { text: '叫停。', toolCalls: [{ id: 'i3', name: 'interrupt_agent', arguments: { agent_id: 'sleepy-1' } }] },
  { text: '等它真正停下。', toolCalls: [{ id: 'i4', name: 'wait_agent', arguments: { agent_id: 'sleepy-1' } }] },
  {
    text: '中断后的状态确认完毕，任务结束。',
    toolCalls: [],
  },
]

trace.banner('演示 ③ 中断', 'interrupt_agent 只发信号，立刻返回；取消在回合边界生效')

const interruptRun = await runAgent({
  model: createMockModel(interruptScript),
  system: PARENT_SYSTEM,
  userMessage: '派一个 agent，然后叫停它。',
  tools: [...base.tools, ...sub3.tools, pauseTool],
  impls: {
    ...base.impls,
    ...sub3.impls,
    pause: async ({ ms }) => {
      await sleep(Math.min(Number(ms) || 0, 2000))
      return `已等待 ${ms}ms`
    },
  },
  maxTurns: 10,
})

trace.result(interruptRun.text)
trace.note(`sleepy-1 的最终状态：${registry3.get('sleepy-1').status}`)

// ─────────────────────────────────────────────────────────────
// 第 1 章总结：四格表
// ─────────────────────────────────────────────────────────────

console.log(`
${'─'.repeat(66)}
第 1 章 · Codex 式的四个答案

  拓扑  主管-工人。主 agent 用 spawn_agent 造子 agent，用 wait_agent 收结果。
        子 agent 也可以再派（受深度上限约束），所以拓扑其实是「有上限的树」。
  隔离  逐次可选。本教学实现用「全新上下文」；真实 Codex 还有 Inherit / Forked /
        WarmFork / FullHistory 几档，可以按需复制父级历史。
  通信  三通道并存：
          · 一次性返回值（wait_agent 拿最后一条消息）
          · 邮箱（send_message，QueueOnly，不打断）
          · 新回合（followup_task，复用同一份会话与日志）
  收敛  主管聚合 + 预算兜底。真实系统还有并发上限、深度上限、审批前置条件三道闸。

  一句话记住第 1 章：**多 agent 不是新架构，是工具调用的一种新返回值。**

这一节记住四件事：

  1. 并行是「先都派出去，再一起等」，不是「派一个等一个」。
     墙钟时间由最慢的成员决定；代价是同时抢工具、抢配额、抢沙箱。

  2. send_message 与 followup_task 是两个不同的东西。
     前者只排队（QueueOnly），不打断，也不负责唤醒；
     后者明确触发一个新回合。混用会让时序变得不可预测。

  3. 取消是协作式的，只在回合边界生效。
     interrupt_agent 立刻返回，但对方要跑到下一个检查点才会停 ——
     所以「叫停」之后必须 wait_agent，不能假设它已经停了。

  4. 身份、日志、状态三样必须一路带着走。
     三个演示里你能分清每条日志是谁打的，靠的就是 id + 昵称 + 前缀。

动手练习：
  · 把 maxThreads 改成 2，重跑演示 ①，观察第三个 spawn 被拒后父 agent 的应对。
  · 把演示 ② 的 send_message 换成 followup_task，观察它会因为「对方还在跑」被拒绝。
  · 给中断加一个「部分结果保留」：被中断时把 already-collected 的结论也带回去。
  · 用 session.mjs 的 replay 读 mail-1 的日志，确认两个回合确实在同一个文件里。
${'─'.repeat(66)}
`)

/** 从 formatHandle 的输出里抠出「最后的回答」正文。 */
function extractAnswer(formatted) {
  const marker = '最后的回答：'
  const at = formatted.indexOf(marker)
  if (at === -1) return '(未取到结论)'
  return formatted.slice(at + marker.length).trim().replace(/\s+/g, ' ')
}
