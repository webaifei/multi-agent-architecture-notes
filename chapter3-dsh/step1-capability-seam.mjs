/**
 * 第 3 章 · Step 3.1 —— 能力接缝：Service Definition / Provider / Consumer
 *
 * 前两章的「怎么跑一个子 agent」都是写死的：
 *   Codex        `Session::spawn`（进程内新会话）
 *   Claude Code  读 .md → 装配全新上下文
 *
 * DSH 把它抽成一条**接缝**，于是同一套接口下可以有多个实现并列：
 *
 *   ┌─────────── Service Definition ───────────┐
 *   │ ProviderRegistry + SubagentCapabilities  │   ← 只定义「怎么协商」
 *   └───────────────┬──────────────────────────┘
 *          ┌────────┼────────┬────────┬────────┐
 *        spawn    fork      acp     codex  claude-code   ← 六个 provider 按名字共存
 *          └────────┴────────┴────────┴────────┘
 *                   ▲
 *          ┌────────┴─────────┐
 *          │ Consumer: 工具层  │   ← 一个 provider 一个 toolName
 *          └──────────────────┘
 *
 * 本节用两个 provider 把这套结构跑起来：
 *   · `spawn`：进程内、全新上下文，能力齐全（可以带 persona / toolFilter / outputSchema）
 *   · `codex`：跨进程，几乎什么能力都不支持（对齐真实实现：ACP / Codex / Claude Code
 *     会在启动 transport 之前拒绝 agentOptions）
 *
 * 三条硬规矩（照真实源码实现）：
 *   A. provider 按名字共存，注册返回 disposer；
 *   B. 能力在 start **之前**检查，缺了就 `UNSUPPORTED_CAPABILITY`，不静默降级；
 *   C. 可选能力靠「方法存不存在」发现（`prepareContinuable`）。
 *
 * 运行：node chapter3-dsh/step1-capability-seam.mjs
 */

import { runAgent } from '../lib/loop.mjs'
import { createMockModel } from '../lib/model.mjs'
import {
  CapabilityError,
  createProviderRegistry,
  describeProvider,
  supportsContinuable,
} from '../lib/seam.mjs'
import { createDelegationTool } from '../lib/tool-subagent.mjs'
import * as trace from '../lib/trace.mjs'

/** 静默 tracer：provider 内部跑的子循环不需要往终端打字。 */
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

let runSeq = 0

// ─────────────────────────────────────────────────────────────
// 两个 provider
// ─────────────────────────────────────────────────────────────

/** 进程内、全新上下文、能力齐全。 */
const spawnProvider = {
  name: 'spawn',
  inheritsParentContext: false,
  capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true },

  /** 有这个方法 = 支持可续子 agent。真实 DSH 用方法存在性当能力标志。 */
  async prepareContinuable() {
    return { kind: 'continuable', provider: 'spawn' }
  },

  async start(request) {
    const system = [
      '你是一个子 agent。',
      request.persona ? `人设：${request.persona}` : null,
      request.toolFilter ? `可用工具：${request.toolFilter.join(', ')}` : '可用工具：全部',
      request.outputSchema ? '输出格式：被要求结构化' : null,
    ]
      .filter(Boolean)
      .join('\n')

    const outcome = await runAgent({
      model: createMockModel([{ text: `（spawn 子 agent）完成：${request.prompt}`, toolCalls: [] }]),
      system,
      userMessage: request.prompt,
      tools: [],
      impls: {},
      tracer: silent,
    })
    return { runId: `run-${++runSeq}`, output: outcome.text }
  },
}

/** 跨进程（真实实现走 app-server / Agent SDK），能力几乎为零。 */
const codexProvider = {
  name: 'codex',
  inheritsParentContext: false,
  // 对齐真实实现：ACP / Codex / Claude Code 会在启动 transport 之前拒绝 agentOptions，
  // 其余可选能力也不支持。一个都不声明。
  capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
  // 故意没有 prepareContinuable —— 「方法不存在」就是「不支持」。

  async start(request) {
    return { runId: `run-${++runSeq}`, output: `（codex 远端进程）已完成：${request.prompt}` }
  },
}

/** provider 的 start 执行函数（Consumer 通过它触发一次委派）。 */
async function runDelegation(provider, request) {
  return provider.start(request)
}

// ─────────────────────────────────────────────────────────────
// 组装：Definition → Providers → Consumer
// ─────────────────────────────────────────────────────────────

trace.banner('第 3 章 · Step 3.1  能力接缝', '服务定义 / 服务提供者 / 消费者，三角缺一不可')

const registry = createProviderRegistry({ kind: 'subagent' })

// Consumer 的工具跟着 provider 生命周期走：上线即挂载，下线即摘除。
/** @type {Map<string, { tool: object, impl: Function }>} */
const mounted = new Map()

registry.onProviderRegistered((provider) => {
  const toolName = `subagent_${provider.name}`
  const { tool, impl } = createDelegationTool({
    registry,
    providerName: provider.name,
    toolName,
    run: runDelegation,
  })
  mounted.set(provider.name, { tool, impl })
  trace.note(`[consumer] provider「${provider.name}」上线 → 挂载工具 ${toolName}`)
})

registry.onProviderUnregistered((provider) => {
  mounted.delete(provider.name)
  trace.note(`[consumer] provider「${provider.name}」下线 → 摘除工具 subagent_${provider.name}`)
})

const disposeSpawn = registry.registerProvider(spawnProvider)
const disposeCodex = registry.registerProvider(codexProvider)

/** 模型此刻能看到的工具清单（由挂载状态派生，不是写死的）。 */
const agentView = () => ({
  tools: [...mounted.values()].map((entry) => entry.tool),
  impls: Object.fromEntries([...mounted.values()].map((entry) => [entry.tool.name, entry.impl])),
})

// ─────────────────────────────────────────────────────────────
// 一、provider 清单
// ─────────────────────────────────────────────────────────────

console.log(`\n${trace.bold('注册表里有什么')}`)
console.log(`  ${'name'.padEnd(8)} ${'继承上下文'.padEnd(10)} ${'可续'.padEnd(5)} 支持的能力`)
for (const name of registry.providerNames()) {
  const row = describeProvider(registry.getProvider(name))
  console.log(`  ${row.name.padEnd(8)} ${String(row.inherits).padEnd(10)} ${String(row.continuable).padEnd(5)} ${row.capabilities}`)
}
trace.note('inheritsParentContext 只描述「对话是否被继承」，不暗示继承了工具或权限。')

console.log(`\n${trace.bold('模型能看到什么')}`)
for (const tool of agentView().tools) console.log(`  ${tool.name}`)
trace.note('一个 provider 一个静态工具，而不是一个「provider 动态选择器」。')

// ─────────────────────────────────────────────────────────────
// 二、能力检查：在 start 之前 fail loud
// ─────────────────────────────────────────────────────────────

async function call(toolName, args) {
  const impl = agentView().impls[toolName]
  if (!impl) return `（工具 ${toolName} 不存在）`
  trace.note(`调用 ${toolName}(${JSON.stringify(args)})`)
  const output = await impl(args)
  trace.result(output)
  return output
}

trace.banner('能力检查', '同一个请求，投给两个 provider，结果不同')

await call('subagent_spawn', { prompt: '统计 notes.md 行数', tool_filter: ['read_file'], persona: '你是精确的统计员' })
await call('subagent_codex', { prompt: '统计 notes.md 行数', tool_filter: ['read_file'] })

trace.note('关键：拒绝发生在 start **之前**，而且说清楚缺的是哪一项能力。')
trace.note('如果是「先接受、再静默忽略」，模型会以为自己拿到了受限的工具集，其实没有。')

// ─────────────────────────────────────────────────────────────
// 三、可选能力：方法的存在性就是能力标志
// ─────────────────────────────────────────────────────────────

trace.banner('可续子 agent', '能力靠「方法在不在」发现，不靠一个 boolean 自述')

trace.note(`spawn 支持可续吗？${supportsContinuable(registry.getProvider('spawn'))}`)
trace.note(`codex 支持可续吗？${supportsContinuable(registry.getProvider('codex'))}`)
await call('subagent_spawn', { prompt: '先看一下目录结构', mode: 'continuable' })
await call('subagent_codex', { prompt: '先看一下目录结构', mode: 'continuable' })

// ─────────────────────────────────────────────────────────────
// 四、生命周期：工具随 provider 上线/下线
// ─────────────────────────────────────────────────────────────

trace.banner('生命周期', '注销 provider，它的工具立刻消失')

disposeCodex()
console.log(`\n  现在模型能看到的工具：${agentView().tools.map((tool) => tool.name).join(', ') || '(无)'}`)
await call('subagent_codex', { prompt: '随便什么任务' })
trace.note('工具已经不存在了 —— 这就是「The tool exists exactly while its provider does」。')

// ─────────────────────────────────────────────────────────────
// 五、重名：直接失败，不允许悄悄覆盖
// ─────────────────────────────────────────────────────────────

trace.banner('重名', '注册同名 provider 会被拒绝')

try {
  registry.registerProvider({ name: 'spawn', capabilities: {} })
} catch (error) {
  if (error instanceof CapabilityError) trace.error(`${error.code} —— ${error.message}`)
}

disposeSpawn()
console.log(`\n  全部注销后，模型能看到的工具：${agentView().tools.map((tool) => tool.name).join(', ') || '(无)'}`)

console.log(`
${'─'.repeat(66)}
这一节记住四件事：

  1. 接缝是**三个角色**，不是一段接口代码。
     服务定义（怎么协商）、服务提供者（谁来干）、消费者（怎么给模型用）——
     少了任何一角都接不起来。只写一个 provider 叫「能跑」，不叫「有接缝」。

  2. 多 provider 并列，是这个接缝和别的能力最大的不同。
     bash 只能有一个 executor；子 agent 可以有六个 transport。
     所以注册表是「按名字的注册表」，不是「单例服务」。

  3. 能力要在**动手之前**谈拢，谈不拢就大声拒绝。
     SubagentCapabilities 的五个标志都是 start-time 的：
     agentOptions / outputSchema / depthLimit / toolFilter / persona。
     静默降级比直接报错危险得多 —— 调用方会以为自己拿到了没有的东西。

  4. 能用「方法存不存在」表达的能力，就别加一个 boolean。
     「prepareContinuable」这个方法在，就是支持；类型系统顺手把调用方收窄到强类型。
     多一个 boolean 就多一个说谎的机会。

动手练习：
  · 给 spawn 的 capabilities 把 toolFilter 改成 false，重跑，看拒绝信息变了没。
  · 自己加第三个 provider（比如 acp），只声明 outputSchema。
  · 把 Consumer 改成「一个工具 + provider 参数」，再回头看为什么真实 DSH 不这么做。
  · 让 registry 在 provider 下线时，把正在跑的 run 也取消掉（提示：需要 AbortSignal）。

下一节（3.2）会看三个真实 provider 的差别：
  spawn（全新）/ fork（继承历史）/ 跨进程（Codex、Claude Code、DSH SDK），
  以及「同一个接口下，隔离语义怎么变成 provider 自己的事」。
${'─'.repeat(66)}
`)
