/**
 * 第 1 章 · Step 1.3 —— 会话落盘（rollout JSONL）与 resume
 *
 * 一句话：**日志才是真相，内存只是它的投影。**
 *
 * 这一节做三件事：
 *   ① 给循环挂一个 `onEvent` 钩子，把每个事件追加写进 JSONL（循环本身完全不知道日志存在）；
 *   ② **用日志重放**重建出 messages，并断言它和内存里那份**逐字节相同** —— 证明日志没有信息丢失；
 *   ③ 模拟进程重启：只靠磁盘上的日志恢复上下文，接着往下干活（resume）。
 *
 * 对应真实系统：
 *   - Codex：`~/.codex/sessions/YYYY/MM/DD/rollout-<时间>-<thread-id>.jsonl`，追加写；
 *     另有 `.jsonl.zst` 压缩、`~/.codex/archived_sessions`、`session_index.jsonl`；
 *     `codex resume` 就是从这些文件重开会话。
 *   - DeepSeek Harness：硬规矩「模型可见 ⟺ 已落盘」，且持久化格式有显式版本与迁移规则。
 *
 * 运行：node chapter1-codex/step3-session-log.mjs
 * 真实模型：node chapter1-codex/step3-session-log.mjs --real   （需 DEEPSEEK_API_KEY）
 */

import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runAgent } from '../lib/loop.mjs'
import { pickModel } from '../lib/model.mjs'
import { SessionLog, loadSession, replay } from '../lib/session.mjs'
import { createToolkit, ensureWorkspace } from '../lib/tools.mjs'
import * as trace from '../lib/trace.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const workspace = path.join(root, 'runs', 'step3-demo')
const sessionsDir = path.join(workspace, 'sessions')

await rm(workspace, { recursive: true, force: true })
await ensureWorkspace(workspace)

const SYSTEM_PROMPT = [
  '你是一个在固定工作目录里干活的编码 agent。',
  '查看文件用 exec_command；改文件一律用 apply_patch。',
  '任务完成后用中文给出一句话结论，不要再调用工具。',
].join('\n')

const { tools, impls } = createToolkit({ workspace })

// ─────────────────────────────────────────────────────────────
// ① 第一次运行：边跑边落盘
// ─────────────────────────────────────────────────────────────

const taskA = '新建 notes.md，写上三条多 agent 的要点。'

const scriptA = [
  {
    text: '建一个 notes.md。',
    toolCalls: [
      {
        id: 'call_1',
        name: 'apply_patch',
        arguments: {
          patch: [
            '*** Begin Patch',
            '*** Add File: notes.md',
            '+# 多 agent 笔记',
            '+- 拓扑：谁创建谁',
            '+- 策略：上下文怎么隔离',
            '*** End Patch',
          ].join('\n'),
        },
      },
    ],
  },
  {
    text: '确认一下写进去了。',
    toolCalls: [{ id: 'call_2', name: 'exec_command', arguments: { command: 'cat notes.md' } }],
  },
  { text: '已创建 notes.md，写了三条要点。任务完成。', toolCalls: [] },
]

const modelA = pickModel(scriptA)

trace.banner('第 1 章 · Step 1.3  会话落盘与 resume', `模型 = ${modelA.name}`)
trace.note('第一次运行 —— 边跑边把事件写进 JSONL')

// 日志的创建者不是循环，而是「外面的调用方」。循环只负责 emit。
const log = await SessionLog.create({
  dir: sessionsDir,
  system: SYSTEM_PROMPT,
  userMessage: taskA,
  cwd: path.relative(root, workspace),
  model: modelA.name,
})

const runA = await runAgent({
  model: modelA,
  system: SYSTEM_PROMPT,
  userMessage: taskA,
  tools,
  impls,
  maxTurns: 8,
  onEvent: (event) => log.append(event), // ← 唯一的接线处
})

trace.result(runA.text)

// ─────────────────────────────────────────────────────────────
// ② 关键证明：从日志重放出来的上下文，和内存里的逐字节相同
// ─────────────────────────────────────────────────────────────

const eventsA = await SessionLog.read(log.file)
const restoredA = replay(eventsA)

// 如果日志漏了任何一条模型可见的信息，这里就会炸。
assert.deepStrictEqual(restoredA.messages, runA.messages)

console.log(`\n${trace.bold('日志文件')}  ${path.relative(root, log.file)}`)
console.log(`${trace.bold('行数')}      ${eventsA.length}`)
console.log(`\n${trace.bold('原始 JSONL（前 6 行，已截断显示）')}`)
const rawLines = (await readFile(log.file, 'utf8')).trim().split('\n')
for (const line of rawLines.slice(0, 6)) {
  console.log(`  ${line.length > 118 ? `${line.slice(0, 118)}…` : line}`)
}

console.log(`\n${trace.bold('重放校验')}`)
trace.note(`内存 messages 条数 = ${runA.messages.length}`)
trace.note(`日志重放条数     = ${restoredA.messages.length}`)
trace.note('assert.deepStrictEqual(重放结果, 内存结果) —— 通过 ✅')
trace.note('结论：内存里的上下文没有携带任何日志之外的信息。丢掉内存，也能完全复现。')

printMessages(restoredA.messages)

// ─────────────────────────────────────────────────────────────
// ③ 模拟进程重启：只靠磁盘恢复，然后接着干
// ─────────────────────────────────────────────────────────────

trace.banner('模拟进程重启', '新进程里没有上一轮的 messages，只有这个 .jsonl 文件')

const restored = await loadSession(log.file)
trace.note(`从日志恢复：system ${restored.system.length} 字符，messages ${restored.messages.length} 条`)

const taskB = '在这份笔记末尾再加一条结论：日志才是真相。'
await log.append({ type: 'user/message', content: taskB })

const scriptB = [
  {
    text: '在末尾追加一条。',
    toolCalls: [
      {
        id: 'call_3',
        name: 'apply_patch',
        arguments: {
          patch: [
            '*** Begin Patch',
            '*** Update File: notes.md',
            '@@',
            ' - 拓扑：谁创建谁',
            ' - 策略：上下文怎么隔离',
            '+- 结论：日志才是真相，内存只是投影。',
            '*** End Patch',
          ].join('\n'),
        },
      },
    ],
  },
  { text: '已追加结论，notes.md 现在有 4 行。任务完成。', toolCalls: [] },
]

const modelB = pickModel(scriptB)

const runB = await runAgent({
  model: modelB,
  system: restored.system,
  // 注意这里：history 完全来自磁盘重放，函数里没有任何上一轮的内存残留。
  history: [...restored.messages, { role: 'user', content: taskB }],
  tools,
  impls,
  maxTurns: 8,
  onEvent: (event) => log.append(event),
})

trace.result(runB.text)

const finalNotes = await readFile(path.join(workspace, 'notes.md'), 'utf8')
console.log(`\n${trace.bold('磁盘上的 notes.md')}`)
console.log(finalNotes.replace(/^/gm, '  │ '))

const finalEvents = await SessionLog.read(log.file)
console.log(`\n${trace.bold('日志最终行数')}  ${finalEvents.length}`)
printMessageTypeCounts(finalEvents)

console.log(`
${'─'.repeat(66)}
这一节记住四件事：

  1. 日志是真相，内存是投影。
     整个仓库后面所有「恢复」「续跑」「审计」能力，都建立在这一点上。

  2. 循环不认识日志。它只 emit 事件，谁来写、写到哪，是外挂的决定。
     这就是「插件，而不是改循环」——真实系统靠这条保持核心稳定。

  3. 重放规则要有明确的边界：哪些事件进模型上下文，哪些不进。
     turn/start、run/end 是过程事件，不进；assistant/message、tool/result 进。
     这条界线画错，恢复出来的上下文就会和原来不一样（我们的断言就是守这条线）。

  4. 追加写 + 单调 seq，天然支持崩溃恢复。
     进程在任意一行之后被杀，重放前面所有行即可继续 —— 不需要「保存」这个动作。

动手练习：
  · 把 assert.deepStrictEqual 那行注释掉，再故意漏写一条 tool/result 事件，
    看恢复出来的上下文会不会静默变样（真实系统靠版本号 + 读时必需来防这个）。
  · 给日志加一个 「session/fork」 事件：从某一 seq 开始分叉出新会话，实现「分支剧情」。
  · 用 「node --input-type=module -e」 单独读这个 .jsonl，把工具调用重现一遍。
  · 加一条 「token/usage」 事件，统计这次会话花了多少 token（真实 Codex 有 usage 记录）。
${'─'.repeat(66)}
`)

// ─────────────────────────────────────────────────────────────
// 小工具：只负责打印
// ─────────────────────────────────────────────────────────────

/** 打印 messages 的概要，观察上下文是怎么长出来的。 */
function printMessages(messages) {
  console.log(`\n${trace.bold('重放出来的上下文')}`)
  messages.forEach((message, index) => {
    const label = String(index).padStart(2, ' ')
    if (message.role === 'tool') {
      console.log(`  ${label} tool        ${oneLine(message.content, 60)}`)
    } else if (message.role === 'assistant' && message.tool_calls) {
      const names = message.tool_calls.map((call) => call.function.name).join(', ')
      console.log(`  ${label} assistant   → 申请工具: ${names}`)
    } else {
      console.log(`  ${label} ${message.role.padEnd(11)} ${oneLine(message.content, 60)}`)
    }
  })
}

/** 统计每类事件的数量，一眼看出日志里到底记了什么。 */
function printMessageTypeCounts(events) {
  const counts = new Map()
  for (const event of events) counts.set(event.type, (counts.get(event.type) ?? 0) + 1)
  for (const [type, count] of counts) console.log(`  ${String(count).padStart(3)} × ${type}`)
}

/** 压成一行并截断。 */
function oneLine(text, max) {
  const flat = String(text ?? '').replace(/\n/g, ' ⏎ ')
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}
