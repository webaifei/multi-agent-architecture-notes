/**
 * 第 1 章 · Step 1.5 —— 子 agent：在进程内新造一份 Session
 *
 * 第 1.1 节埋了一句话：「工具调用是数据，不是控制流 —— 那个工具实现
 * 可以换成另一个 agent」。这一节把它兑现。
 *
 * 多 agent 没有魔法，只有三个决定：
 *
 *   ① 工具实现从「干活」换成「再起一个循环」；
 *   ② 那个循环有自己的 messages（**上下文隔离**，省 token 也防跑偏）；
 *   ③ 它跑完后，只把**最后一条消息**还回来（中间过程留在它自己的日志里）。
 *
 * spawn 与 wait 是分开的两个动作，这一点很关键：
 * spawn 立刻返回 id（不等），wait 才去取结果 —— 只有这样才可能同时开好几个（1.6）。
 *
 * 对应真实系统：
 *   - Codex：`Session::spawn` 进程内返回新 `Session` + 自己的 IO 通道；
 *     工具是 `spawn_agent` / `wait_agent` / `list_agents`；
 *     完成态是 `AgentStatus::Completed(last_agent_message)`。
 *   - 三道闸：并发上限、深度上限、以及委派前必须 `approval_policy == Never`。
 *
 * 运行：node chapter1-codex/step5-subagent.mjs
 */

import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runAgent } from '../lib/loop.mjs'
import { createMockModel } from '../lib/model.mjs'
import { createPolicy } from '../lib/policy.mjs'
import { AgentError, AgentRegistry } from '../lib/subagent.mjs'
import { createSubagentTools } from '../lib/subagent-tools.mjs'
import { createToolkit, ensureWorkspace } from '../lib/tools.mjs'
import * as trace from '../lib/trace.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const demoRoot = path.join(root, 'runs', 'step5-demo')
const workspace = path.join(demoRoot, 'workspace')
const sessionsDir = path.join(demoRoot, 'sessions')

await rm(demoRoot, { recursive: true, force: true })
await ensureWorkspace(workspace)

// 子 agent 和父 agent 共用同一个工作目录（Codex 也是这样：继承父 Session 的 workspace）。
await writeFile(
  path.join(workspace, 'notes.md'),
  ['# 多 agent 笔记', '- 拓扑：谁创建谁', '- 隔离：能看见什么', '- 收敛：谁决定结束', ''].join('\n'),
  'utf8',
)

const base = createToolkit({ workspace, policy: createPolicy({ sandbox: 'workspace-write', approval: 'never', workspace }) })

const PARENT_SYSTEM = [
  '你是一个负责统筹的 agent。你自己不要读文件，',
  '把探索类任务派给子 agent，拿到结论后汇总给用户。',
].join('\n')

const CHILD_SYSTEM = [
  '你是一个子 agent，只负责一件自包含的小任务。',
  '拿到足够信息后立刻给出简短结论，不要做任务之外的事。',
].join('\n')

// ─────────────────────────────────────────────────────────────
// 子 agent 的剧本：每个角色一份
// ─────────────────────────────────────────────────────────────

const childScripts = {
  explorer: [
    { text: '', toolCalls: [{ id: 'e1', name: 'exec_command', arguments: { command: 'cat notes.md' } }] },
    { text: 'notes.md 里列了三条：拓扑（谁创建谁）、隔离（能看见什么）、收敛（谁决定结束）。', toolCalls: [] },
  ],
  verifier: [
    { text: '', toolCalls: [{ id: 'v1', name: 'exec_command', arguments: { command: 'ls' } }] },
    { text: '工作目录里只有一个 notes.md，没有其他文件。', toolCalls: [] },
  ],
}

/** 让子 agent 慢一点点，这样「spawn 之后父 agent 继续走」才看得出来。 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const withDelay = (model, ms) => ({
  name: model.name,
  async complete(request) {
    await sleep(ms)
    return model.complete(request)
  },
})

// ─────────────────────────────────────────────────────────────
// 注册表：每个子 agent 一台自己的「会话」
// ─────────────────────────────────────────────────────────────

/** @type {AgentRegistry} */
let registry
registry = new AgentRegistry({
  workspace,
  sessionsDir,
  system: CHILD_SYSTEM,
  maxThreads: 3,
  maxDepth: 1,
  makeRun(handle) {
    const script = childScripts[handle.label] ?? [{ text: `（角色 ${handle.label} 没有剧本）`, toolCalls: [] }]
    // 子 agent 也拿到协作工具 —— 所以理论上它能再派孙 agent，只是被深度上限挡住。
    const nested = createSubagentTools({ registry, callerId: handle.id, callerDepth: handle.depth })
    return {
      model: withDelay(createMockModel(script), 20),
      system: `${CHILD_SYSTEM}\n你的角色名是：${handle.label}`,
      tools: [...base.tools, ...nested.tools],
      impls: { ...base.impls, ...nested.impls },
    }
  },
})

// 主 agent 的协作工具绑定在 'root' 身份上，深度 0。
const rootSub = createSubagentTools({ registry, callerId: 'root', callerDepth: 0 })
const rootTools = [...base.tools, ...rootSub.tools]
const rootImpls = { ...base.impls, ...rootSub.impls }

// ─────────────────────────────────────────────────────────────
// 主 agent 的剧本
// ─────────────────────────────────────────────────────────────

const parentScript = [
  {
    text: '先派一个探索者去读笔记。',
    toolCalls: [
      {
        id: 'p1',
        name: 'spawn_agent',
        arguments: { task: '读一遍工作目录里的 notes.md，把三条要点告诉我。', name: 'explorer' },
      },
    ],
  },
  {
    text: '不等它，再派一个验证者确认目录内容。',
    toolCalls: [
      {
        id: 'p2',
        name: 'spawn_agent',
        arguments: { task: '确认工作目录里有哪些文件，不要读文件内容。', name: 'verifier' },
      },
    ],
  },
  { text: '现在去等探索者的结果。', toolCalls: [{ id: 'p3', name: 'wait_agent', arguments: { agent_id: 'agent-1' } }] },
  { text: '再等验证者。', toolCalls: [{ id: 'p4', name: 'wait_agent', arguments: { agent_id: 'agent-2' } }] },
  { text: '顺便列出所有 agent。', toolCalls: [{ id: 'p5', name: 'list_agents', arguments: {} }] },
  // 最后一条用函数式 mock：汇总内容真的来自工具结果，不是写死的。
  (request) => {
    const results = request.messages.filter((message) => message.role === 'tool').map((message) => String(message.content))
    // 注意别拿 spawn 的返回值来解析：那个 JSON 里也有 agent-1，但它没有结论。
    const explorer = results.find((text) => text.includes('agent: agent-1')) ?? ''
    const verifier = results.find((text) => text.includes('agent: agent-2')) ?? ''
    return {
      text: [
        '两个子 agent 都已完成：',
        `· 探索者（agent-1）：${extractAnswer(explorer)}`,
        `· 验证者（agent-2）：${extractAnswer(verifier)}`,
        '工作目录内容已经确认过了。',
      ].join('\n'),
      toolCalls: [],
    }
  },
]

trace.banner('第 1 章 · Step 1.5  子 agent（进程内新 Session）', '主 agent 自己不动手，只负责派活和汇总')
trace.note('用户：帮我确认一下工作目录里的笔记写了什么，别自己读，派个 agent 去。')

const outcome = await runAgent({
  model: createMockModel(parentScript),
  system: PARENT_SYSTEM,
  userMessage: '帮我确认一下工作目录里的笔记写了什么，别自己读，派个 agent 去。',
  tools: rootTools,
  impls: rootImpls,
  maxTurns: 8,
})

trace.result(outcome.text)

// ─────────────────────────────────────────────────────────────
// 事后账本：谁被创建了、状态如何、各自的日志在哪
// ─────────────────────────────────────────────────────────────

console.log(`\n${trace.bold('注册表（对应 Codex 的 AgentRegistry）')}`)
for (const handle of registry.list()) {
  const span = handle.finishedAt ? `${new Date(handle.finishedAt) - new Date(handle.startedAt)}ms` : '—'
  console.log(`  ${handle.id}  ${handle.nickname}  depth=${handle.depth}  ${handle.status}  ${span}  ${handle.label}`)
}

console.log(`\n${trace.bold('每个 agent 一个会话日志')}`)
for (const handle of registry.list()) {
  console.log(`  ${handle.id}  ${path.relative(root, handle.logFile)}`)
}

// ─────────────────────────────────────────────────────────────
// 三道闸里的两道：深度与并发
// ─────────────────────────────────────────────────────────────

trace.banner('三道闸', '深度上限与并发上限，都必须「大声失败」而不是悄悄排队')

try {
  await registry.spawn({ task: '这一层不该被创建', depth: 2 })
} catch (error) {
  if (error instanceof AgentError) trace.note(`深度上限拦住：${error.code} —— ${error.message}`)
}

const gate = deferred()
const slow = new AgentRegistry({
  workspace,
  sessionsDir,
  system: CHILD_SYSTEM,
  idPrefix: 'slow',
  maxThreads: 1,
  maxDepth: 1,
  makeRun: () => ({ model: { name: 'blocked', async complete() { await gate.promise; return { text: '（名额释放后才回答）', toolCalls: [] } } } }),
})

await slow.spawn({ task: '占住唯一的名额' })
try {
  await slow.spawn({ task: '第二个任务' })
} catch (error) {
  if (error instanceof AgentError) trace.note(`并发上限拦住：${error.code} —— ${error.message}`)
}
gate.resolve()
await slow.wait('slow-1')
trace.note('名额释放，slow-1 完成')

console.log(`
${'─'.repeat(66)}
这一节记住五件事：

  1. 多 agent 的全部实现，就是「工具实现里再起一个循环」。
     spawn_agent 是个普通工具；它的返回值是个 id，不是文件内容。
     没有新的架构组件，只有循环的嵌套。

  2. spawn 和 wait 必须分开。
     spawn 立刻返回，wait 才取结果 —— 这一刀切下去，并行才有可能（1.6）。
     真实 Codex 同样如此：spawn 返回 id + 昵称，结果靠 wait 取。

  3. 只回传最后一条消息，中间过程不进父上下文。
     这是上下文隔离的收益所在：子 agent 读 30 个文件，父 agent 只看到一句结论。
     要留证据？留在它自己的 JSONL 日志里 —— 日志是真相，父上下文只是摘要。

  4. 三道闸要 fail loud，不能静默排队或降级。
     深度、并发、以及「委派前审批策略必须是 never」。
     静默降级会让调用方以为自己拿到了子 agent，其实什么也没发生。

  5. 身份要一路带着走。
     工具绑定 callerId / callerDepth，日志带 agent 前缀（agent-1 ada）。
     多 agent 一旦超过两个，没有身份标注的日志就没法读了。

动手练习：
  · 把 maxThreads 改成 1，重跑主流程，观察第二个 spawn 被拒后父 agent 怎么应对。
  · 让 explorer 的剧本里再 spawn 一个孙 agent，验证深度上限确实拦得住。
  · 把 wait_agent 的 agent_id 改成 'agent-9'，看 NOT_FOUND 是怎么变成工具结果的。
  · 对比父 agent 的 messages 长度和 explorer 的日志行数，算一算省了多少上下文。
${'─'.repeat(66)}
`)

// ─────────────────────────────────────────────────────────────
// 小工具
// ─────────────────────────────────────────────────────────────

/** 从 formatHandle 的输出里抠出「最后的回答」正文。 */
function extractAnswer(formatted) {
  const marker = '最后的回答：'
  const at = formatted.indexOf(marker)
  if (at === -1) return '(未取到结论)'
  return formatted.slice(at + marker.length).trim().replace(/\s+/g, ' ')
}

/** 一个可以手动放行的 Promise，用来制造「名额被占住」的场景。 */
function deferred() {
  let resolve
  const promise = new Promise((r) => {
    resolve = r
  })
  return { promise, resolve }
}
