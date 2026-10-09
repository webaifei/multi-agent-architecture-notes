/**
 * 第 1 章 · Step 1.1 —— 最小 agent loop
 *
 * 目标：先把「一个 agent」写出来。多 agent 的最小组成单位，就是它。
 *
 * 一个 agent 只有四样东西：
 *
 *   循环(loop)  +  上下文(messages)  +  工具(tools)  +  策略(policy)
 *
 *   循环：不停地问模型「下一步干什么」，直到模型不再要工具。
 *   上下文：模型每次只能看到 messages 数组，写进去什么它就知道什么。
 *   工具：模型自己不能干活，它只能「填写参数、申请调用」，由我们的代码执行。
 *   策略：什么时候允许调用、最多几轮、超时怎么办。
 *
 * 这四样里，多 agent 系统唯一增加的是「循环的嵌套方式」：
 * 让某个工具调用不再返回数据，而是**返回另一个 agent 的结果**。
 * 所以先把这个最小的循环跑通、跑懂，后面全靠它。
 *
 * 对应真实系统：
 *   - Codex CLI（codex-rs）的 core 循环：提交 turn → 模型输出 item → 执行工具 → 回填 → 继续；
 *   - Claude Code 的主循环：assistant 消息 + tool_use / tool_result 交替；
 *   - DeepSeek Harness 的 agent-loop 包，也是这个循环，只是加了并发、中断、恢复。
 *
 * 运行：node chapter1-codex/step1-agent-loop.mjs
 * 真实模型：node chapter1-codex/step1-agent-loop.mjs --real   （需 DEEPSEEK_API_KEY）
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pickModel } from '../lib/model.mjs'
import * as trace from '../lib/trace.mjs'

const run = promisify(execFile)

// ─────────────────────────────────────────────────────────────
// 1. 策略（policy）：这一节能写死的部分，真实系统里都是可配置的
// ─────────────────────────────────────────────────────────────

const MAX_TURNS = 8 // 最多循环几轮，防止模型陷入死循环烧钱
const SYSTEM_PROMPT = [
  '你是一个能在工作目录里执行命令的编码 agent。',
  '需要环境信息时调用 exec_command；拿到结果后判断任务是否完成。',
  '任务完成后用中文给出一句话结论，不要再调用工具。',
].join('\n')

// ─────────────────────────────────────────────────────────────
// 2. 工具（tools）：给模型的「菜单」，以及菜单背后的真实实现
// ─────────────────────────────────────────────────────────────

const tools = [
  {
    name: 'exec_command',
    description: '在工作目录执行一条 shell 命令，返回标准输出与标准错误。',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: '要执行的 shell 命令' } },
      required: ['command'],
    },
  },
]

/**
 * 工具的真实实现。
 * 真实 Codex 在这里做三件事：沙箱隔离、审批判断、输出截断。
 * 这一节先只做一条「最小安全线」——白名单，真正的沙箱留到 1.4。
 */
async function execCommand({ command }) {
  if (typeof command !== 'string' || !command.trim()) {
    return '错误：command 必须是非空字符串'
  }
  if (!/^(echo|printf|pwd|ls|node -e)\b/.test(command.trim())) {
    // 教学环境只放行无害命令。真实系统不靠白名单，靠 OS 级沙箱：
    //   - Codex: macOS seatbelt / Linux landlock + seccomp
    //   - DeepSeek Harness: 进程级沙箱策略（read-only / workspace-write / danger-full-access）
    return `已拒绝：教学白名单只允许 echo / printf / pwd / ls / node -e，收到的是「${command}」`
  }

  try {
    const { stdout, stderr } = await run('/bin/sh', ['-c', command], {
      cwd: process.cwd(),
      timeout: 10_000, // 真实系统给工具设超时，并把超时当成一次可重试的失败
      maxBuffer: 1024 * 1024,
    })
    return (stdout + stderr).trim() || '(命令成功，无输出)'
  } catch (error) {
    // 工具失败不是程序崩溃：把错误当结果回传给模型，让它自己决定下一步。
    return `命令执行失败：${error.message}`
  }
}

/** 工具名 → 实现。加新工具时只改这张表。 */
const toolImpls = { exec_command: execCommand }

// ─────────────────────────────────────────────────────────────
// 3. 主循环（loop）
// ─────────────────────────────────────────────────────────────

/**
 * 跑完一个 agent 的一次任务。
 *
 * @param {object} options
 * @param {{ complete: Function, name: string }} options.model 模型适配器
 * @param {string} options.userMessage 用户交代的任务
 * @returns {Promise<{ text: string, turns: number }>}
 */
async function runAgent({ model, userMessage }) {
  /** 上下文：模型唯一能看到的记忆。它的增长方式决定了成本与能力上限。 */
  const messages = [{ role: 'user', content: userMessage }]

  for (let turnNo = 1; turnNo <= MAX_TURNS; turnNo += 1) {
    trace.turn(turnNo)

    // ① 问模型：现在干什么？
    const reply = await model.complete({ system: SYSTEM_PROMPT, messages, tools })
    trace.assistant(reply.text)

    // ② 模型不要工具 → 它认为任务结束了，循环终止
    if (reply.toolCalls.length === 0) {
      return { text: reply.text, turns: turnNo }
    }

    // ③ 模型要工具 → 先把它的「申请」写进上下文（真实 API 要求 assistant 消息带上 tool_calls）
    messages.push(assistantWireMessage(reply))

    // ④ 执行工具，把每个结果也写回上下文，然后进入下一轮
    for (const call of reply.toolCalls) {
      trace.toolCall(call.name, call.arguments)
      const impl = toolImpls[call.name]
      // 模型可能编造不存在的工具名：这也是要回给模型的「结果」，不是异常。
      const output = impl ? await impl(call.arguments) : `错误：不存在名为 ${call.name} 的工具`
      trace.toolResult(output)
      messages.push({ role: 'tool', tool_call_id: call.id, content: String(output) })
    }
  }

  return { text: `达到最大轮次上限（${MAX_TURNS}），强制停止`, turns: MAX_TURNS }
}

/** 把内部的 ModelReply 转成线上协议要求的 assistant 消息。 */
function assistantWireMessage(reply) {
  return {
    role: 'assistant',
    content: reply.text || null,
    tool_calls: reply.toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    })),
  }
}

// ─────────────────────────────────────────────────────────────
// 4. 跑起来
// ─────────────────────────────────────────────────────────────

// Mock 脚本 = 「模型会怎么回答」的固定剧本。
// 脚本驱动的好处：输出确定、可断言、能离线跑；真实模型只需要把这份剧本换成一次网络请求。
const mockScript = [
  {
    text: '',
    toolCalls: [
      { id: 'call_1', name: 'exec_command', arguments: { command: 'echo "hello from the shell tool"' } },
    ],
  },
  {
    text: '',
    toolCalls: [{ id: 'call_2', name: 'exec_command', arguments: { command: 'node -e "console.log(1 + 1)"' } }],
  },
  {
    text: '我刚执行了两条命令：第一条打印了问候语，第二条算出 1 + 1 = 2。任务完成。',
    toolCalls: [],
  },
]

const model = pickModel(mockScript)

trace.banner('第 1 章 · Step 1.1  最小 agent loop', `模型 = ${model.name}`)
const userMessage = '帮我确认一下 shell 工具能用，再算一下 1+1。'
trace.note(`用户：${userMessage}`)

const outcome = await runAgent({ model, userMessage })

trace.result(outcome.text)
trace.note(`共 ${outcome.turns} 轮循环`)

console.log(`
${'─'.repeat(66)}
这一节记住三件事：

  1. agent 不是「模型」，是「围着模型转的循环」。
     模型只负责决定下一步；执行、校验、记上下文，都是循环的活。

  2. 上下文就是 messages 数组，它是唯一真相。
     模型看不到没写进去的东西 —— 这条规则后面会决定子 agent 的「隔离」能力。

  3. 工具调用是「数据」，不是「控制流」。
     模型说要调用工具，我们可以执行、可以拒绝、可以超时、也可以……换成另一个 agent。
     ← 下一节 1.2 加固工具层之后，1.5 就靠这句话实现多 agent。

动手练习：
  · 把 mockScript 第 3 条删掉，看它撞到 MAX_TURNS 会发生什么。
  · 把第 1 条命令改成 'rm -rf /'，观察白名单拒绝后模型怎么应对。
  · 加一个 read_file 工具：实现、注册进 toolImpls、再写一条 mock 调用它。
${'─'.repeat(66)}
`)
