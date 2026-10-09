/**
 * 跨进程 provider 那一头的「子 agent 进程」。
 *
 * 真实 DSH 里对应的东西是 subagent-dsh-sdk / subagent-codex / subagent-claude-code：
 * 起一个真实子进程，用协议把任务送进去、把最终消息取回来。
 *
 * 这里把协议缩到最小：argv 收任务，stdout 吐最终文本。
 * 进程边界本身是真的，所以它天然拿不到父级上下文，也没法继承工具。
 */

import { runAgent } from '../lib/loop.mjs'

const task = process.argv[2] ?? ''

const silent = {
  banner() {},
  turn() {},
  assistant() {},
  toolCall() {},
  toolResult() {},
  note() {},
  result() {},
  error() {},
}

// 这个模型只看自己收到的 messages。它答不上来，唯一的原因就是
// 那条信息从来没进过这个进程。
const model = {
  name: 'worker-mock',
  async complete({ messages }) {
    const sawPort = messages.some((message) => String(message.content).includes('4317'))
    return {
      text: sawPort
        ? '端口是 4317。'
        : `(pid ${process.pid}) 我不知道端口是多少 —— 这个进程里没有那段对话。`,
      toolCalls: [],
    }
  },
}

const outcome = await runAgent({
  model,
  system: '你是独立进程里的子 agent，看不到父级的任何上下文。',
  userMessage: task,
  tools: [],
  impls: {},
  tracer: silent,
})

process.stdout.write(outcome.text)
