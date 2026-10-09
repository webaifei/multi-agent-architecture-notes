/**
 * 第 3 章 · Step 3.2 —— 三个后端，同一个接口
 *
 * 上一节把接缝搭起来了，但两个 provider 其实没真干活。这一节让它们真跑起来，
 * 顺便看清一件事：**隔离语义不是接口的一部分，是每个 provider 自己的事**。
 *
 * 三个后端：
 *
 *   spawn     进程内，全新上下文
 *   fork      进程内，把父级已完成的历史给子 agent
 *   dsh-sdk   真·子进程（不是模拟），只有最终消息能跨回来
 *
 * 判别方法很简单。先让父 agent 说一句「端口定在 4317」，然后问三个后端同一个问题：
 * 「我们刚才定的端口是多少？」
 *
 * spawn 和 dsh-sdk 答不上来，fork 答得上来。这不是谁对谁错，
 * 是 provider 替调用方做的选择 —— 接口一个字都不用改。
 *
 * 真实系统里对应的东西：
 *   · dsh-subagent-spawn-in-process   全新进程内子 agent
 *   · dsh-subagent-fork-in-process    用父级已完成历史播种的子 agent
 *   · dsh-subagent-dsh-sdk / -codex / -claude-code   跨进程
 * docs/subsystems/subagent.md 里区分得很清楚：
 *   inheritsParentContext 只描述「对话是否被继承」（fork: true；spawn、acp: false）。
 *
 * 运行：node chapter3-dsh/step2-three-backends.mjs
 */

import { execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { runAgent } from '../lib/loop.mjs'
import { createProviderRegistry } from '../lib/seam.mjs'
import { createDelegationTool } from '../lib/tool-subagent.mjs'
import * as trace from '../lib/trace.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const workerPath = path.join(here, 'child-worker.mjs')
const execFileAsync = promisify(execFile)

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

/** 父 agent 已经聊过的那几轮。里面埋着答案。 */
const PARENT_HISTORY = [
  { role: 'user', content: '这次服务端口定 4317，不要用 8080。' },
  { role: 'assistant', content: '好，4317。' },
  { role: 'user', content: '文档统一用中文。' },
  { role: 'assistant', content: '明白。' },
]

const QUESTION = '我们刚才定的端口是多少？'

/** 每次 run 的实况，用来事后对账。 */
const runs = []
let runSeq = 0

// ─────────────────────────────────────────────────────────────
// 两个进程内后端
// ─────────────────────────────────────────────────────────────

/**
 * @param {{ name: string, inheritHistory: boolean }} options
 */
function inProcessProvider({ name, inheritHistory }) {
  return {
    name,
    inheritsParentContext: inheritHistory,
    // 进程内后端能力齐全；跨进程那边基本什么都没有。
    capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true },

    async start(request) {
      const history = inheritHistory ? [...PARENT_HISTORY, { role: 'user', content: request.prompt }] : undefined

      // 子 agent 的模型只看自己手上的 messages。它答不上来，是因为那条信息
      // 确实没进它的上下文，而不是我们写死了「假装不知道」。
      const model = {
        name: `${name}-child`,
        async complete({ messages }) {
          const knowsPort = messages.some((message) => String(message.content).includes('4317'))
          return {
            text: knowsPort ? '端口是 4317。' : '你没告诉过我端口是多少。',
            toolCalls: [],
          }
        },
      }

      const outcome = await runAgent({
        model,
        system: '你是子 agent。',
        history,
        userMessage: inheritHistory ? undefined : request.prompt,
        tools: [],
        impls: {},
        tracer: silent,
      })

      runs.push({ provider: name, initialMessages: inheritHistory ? PARENT_HISTORY.length + 1 : 1, output: outcome.text })
      return { runId: `run-${++runSeq}`, output: outcome.text }
    },
  }
}

const spawnProvider = inProcessProvider({ name: 'spawn', inheritHistory: false })
const forkProvider = inProcessProvider({ name: 'fork', inheritHistory: true })

// ─────────────────────────────────────────────────────────────
// 跨进程后端：真的起一个 node 子进程
// ─────────────────────────────────────────────────────────────

const dshSdkProvider = {
  name: 'dsh-sdk',
  inheritsParentContext: false,
  capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false },

  async start(request) {
    const { stdout } = await execFileAsync(process.execPath, [workerPath, request.prompt], {
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
    })
    const output = String(stdout).trim()
    runs.push({ provider: 'dsh-sdk', initialMessages: 1, output })
    return { runId: `run-${++runSeq}`, output }
  },
}

// ─────────────────────────────────────────────────────────────
// 组装：还是 3.1 那套，一个 provider 一个工具
// ─────────────────────────────────────────────────────────────

trace.banner('第 3 章 · Step 3.2  三个后端，同一个接口', '隔离语义由 provider 决定，接口不变')

const registry = createProviderRegistry()
const mounted = new Map()

registry.onProviderRegistered((provider) => {
  mounted.set(
    provider.name,
    createDelegationTool({
      registry,
      providerName: provider.name,
      toolName: `subagent_${provider.name}`,
      run: (target, request) => target.start(request),
    }),
  )
})
registry.onProviderUnregistered((provider) => mounted.delete(provider.name))

registry.registerProvider(spawnProvider)
registry.registerProvider(forkProvider)
registry.registerProvider(dshSdkProvider)

const tools = () => [...mounted.values()].map((entry) => entry.tool)
const impls = () => Object.fromEntries([...mounted.values()].map((entry) => [entry.tool.name, entry.impl]))

console.log(`\n${trace.bold('模型看到的三个工具，和它们各自的措辞')}`)
for (const tool of tools()) {
  const second = tool.description.split('\n')[1]
  console.log(`  ${tool.name.padEnd(18)} ${second}`)
}
trace.note('措辞是 Consumer 从 provider 的 inheritsParentContext 推出来的，不是 hand-written。')
trace.note('同一条接口，模型看到的话不一样 —— 这就是那个标志位存在的全部理由。')

// ─────────────────────────────────────────────────────────────
// 同一个问题，问三个后端
// ─────────────────────────────────────────────────────────────

trace.banner('同一个问题，问三个后端', QUESTION)

for (const name of ['subagent_spawn', 'subagent_fork', 'subagent_dsh-sdk']) {
  const impl = impls()[name]
  trace.note(`${name} →`)
  const output = await impl({ prompt: QUESTION })
  trace.result(output)
}

console.log(`\n${trace.bold('对账')}`)
console.log(`  ${'provider'.padEnd(10)} ${'子 agent 起始 messages'.padEnd(22)} 结论`)
for (const run of runs) {
  console.log(`  ${run.provider.padEnd(10)} ${String(run.initialMessages).padEnd(22)} ${run.output}`)
}

console.log(`
${'─'.repeat(66)}

三件事值得记一下。

第一，隔离不是接口能规定的东西。
ProviderRegistry 上没有「隔离程度」这个字段，SubagentCapabilities 里也没有。
因为隔离是 transport 自己的性质：能不能看见父级历史，取决于它从哪儿开始。
接口只管两件 —— 你先声明你能干什么，我按你说的来调。

第二，inheritsParentContext 这么个看起来可有可无的小标志，是有实际用途的。
Consumer 拿它生成工具描述，让模型知道该不该把背景写进 prompt。
否则模型只能靠「fork 这个词听起来像继承」去猜，猜错就是白跑一轮。

第三，跨进程那条路是真起进程的。
上面 dsh-sdk 的输出里带着 pid，跟父进程不是一个号。
真实 DSH 里 subagent-codex 是 codex app-server --stdio，
subagent-dsh-sdk 是另一份 Harness runtime，都是这个形态。
进程边界买到的是真隔离，代价是每次委派都要过一次协议，
也没法像 fork 那样「顺手把历史塞过去」。

自己动手可以试：
  · 给 fork 的 capabilities 里把 toolFilter 打开，再传一个 tool_filter 参数，
    看它到底是「真的裁剪了工具」还是「只是接受了参数」。多半是后者 ——
    能力标志只说明 provider 敢接，不说明它真做了。
  · 把 child-worker.mjs 的 system 换成父级的 system，观察结果变不变。
    不变的话，说明你改的是这个进程里的事，跟跨不跨进程没关系。
  · 给 dsh-sdk 加一个 inheritsParentContext: true 的版本（要真的把历史序列化过去），
    然后想清楚：它该不该这么声明。

下一步（3.3）换个方向，不讲「怎么起子 agent」，讲它们**跑起来之后怎么互相说话**：
邻近 agent 的消息投递、中断、以及列举。
${'─'.repeat(66)}
`)
