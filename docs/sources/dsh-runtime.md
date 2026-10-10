# DSH 运行时的真实流程

来源：本仓库源码（`packages/`），行号对应当前 master。每条结论都带锚点，没读过的代码不写。

## 一、谁在跑：驱动器

`packages/core/agent-loop/src/agent.ts:98`

```ts
export class ReactLoopAgent implements Agent {
```

它实现 `Agent` 接口，由 `AgentLoop`（`index.ts:330`，`extends Service implements AgentFactory`）创建或恢复。

创建和恢复是两个不同的入口，互斥：

- `sessionId` —— 首次使用则创建，重新挂载则恢复
- `resumeSessionId` —— 加载一个已持久化的会话

校验在 `index.ts:314-319`，两者同时给会直接报错。

## 二、三个循环

### 最外层：`kick()`

`agent.ts:252`

```ts
private async kick(): Promise<void> {
  try {
    while (await this.turn()) {}
  } catch (_error) {
    // Reported failures and cancellation are contained at the driver boundary.
  } finally {
    if (this.phase.kind === 'running') { ... }
  }
}
```

`turn()` 返回 `true` = 队列里还有活，再来一个 turn。

配套的是 `wakeDriver()`（`agent.ts:214`）和 `whenIdle()`（`agent.ts:237`）：没有活的时候驱动器是 idle 的，被唤醒才跑。不是常驻轮询。

### 中间层：`turn()`

`agent.ts:296`

1. `this.session.append('turn/start', { turn })`
2. 内层 `while (true)` 转 step：
   - `preStep(target, { turn, step })`
   - `session.append('step/start', { turn, step })`
   - `this.step(decision)`
   - `session.append('step/end', { turn, step })`
   - `target = 'next-step'`（`agent.ts:364`）
3. `session.append('turn/end', { reason })`

退出条件是 `turnEnds && this.inbox.nextStep.length === 0`，也就是「这一轮跑完了，而且 `next-step` 队列也空了」。

### 内层：`step()`

`agent.ts:398`

1. `prepareRequest(turn, step, signal)` —— 定模型路由
2. `systemPrompt.project(...)`，把要提交的系统消息 `session.append('system/message', ...)`
3. 第一圈才 `session.append('user/message', message, { surfaceOp: 'append' })`
4. `buildRequest(...)`
5. `this.loopCtx.llm.stream(request)`，然后 `for await (const chunk of stream) live.push(chunk)`
6. `session.append('assistant/message', ...)`
7. 取工具调用：

```ts
const toolCalls = message.content.filter(block => block.type === 'tool-call')
if (toolCalls.length === 0) return { kind: 'completed' }
```

8. 有工具调用就执行：

```ts
const { concluded } = await executeToolCalls(
  this.loopCtx, turn, step, toolCalls, signal,
  context => this.inbox.splice('next-step', this.inbox.nextStep.length, 0, [context]),
)
return concluded ? { kind: 'completed' } : null
```

返回 `null` 表示「还没完，回到 turn 的内层循环再来一个 step」。

## 三、`preStep`：模型看到什么，在这里决定

`agent.ts:267`

```ts
const claimed = this.inbox.claim(target, position.turn)
const assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal))
const sections = renderContextSections(assembly)
const context = this.runtimeContext.project(joinContextSections(sections), sections)
const decision = await this.dispatch.waterfall(
  'agent/pre-step', { messages: claimed, ...position, signal },
  () => Promise.resolve({ kind: 'enter', messages: context === undefined ? claimed : [...claimed, context] }),
)
```

四步，顺序不能换：取队列 → 组装系统提示词 → 投影运行时上下文 → 过 `agent/pre-step` waterfall。

waterfall 的默认实现是 `kind: 'enter'`；监听器可以改成 `kind: 'reject'`，这一轮就不发请求了。

## 四、inbox：两个队列

`packages/core/agent-loop/src/inbox.ts:21`

```ts
export const inboxProjectionSchema = z.object({
  'next-turn': z.array(z.custom<UserMessage>()).readonly(),
  'next-step': z.array(z.custom<UserMessage>()).readonly(),
}).readonly()
```

- `next-turn`：等到下一个 turn 才处理，用来排队新输入
- `next-step`：当前 step 结束后立刻插入，用来插话和回填工具上下文

状态不是存在内存变量里，而是从 `agent/inbox/spliced` 事件折叠出来的（`apply(state, event)`）。也就是说**排队中的输入也进日志**，进程重启后队列还在。

`claim(target, turn)` 取走消息；第一个 step 用 `next-turn`，之后 `target` 切成 `next-step`。

工具那条回填走的是同一个队列：

`agent.ts:536`
```ts
context => this.inbox.splice('next-step', this.inbox.nextStep.length, 0, [context]),
```

`acceptContext` 的类型是 `(context: UserMessage) => void`，由 `executeToolCalls` 传入（`tool-calls.ts:66`）。工具执行过程中产生的上下文消息，和用户插话走同一条路。

## 五、工具执行

`packages/core/agent-loop/src/tool-calls.ts:60`

```ts
export async function executeToolCalls(
  ctx: Context, turn: number, step: number,
  toolCalls: ToolCallBlock[], signal: AbortSignal,
  acceptContext: (context: UserMessage) => void,
): Promise<{ concluded: boolean }>
```

分组规则在 `tool-calls.ts:84`：

```ts
const mode = ctx.tools.executionMode(first.exec).kind
const group = mode === 'parallel' ? planned.slice(next) : [first]
```

`'parallel'` 才整组并发，否则一次一个。并发上限是配置项 `maxParallelToolCalls`（默认 10）。

失败恢复：`ToolCallRecovery`（`tool-calls.ts`）订阅 `session/event`，把已经产生的工具结果记下来。step 抛错时在 `agent.ts:344-355` 把待补的 `tool/result` 补录进 session，补录也失败则抛 `AggregateError`。

## 六、会话：日志是唯一的真相

`session.append(type, payload, intent)` 每个动作都调一次，出现在：

| 事件 | 位置 |
|---|---|
| `turn/start` | agent.ts:305 |
| `step/start` | agent.ts:329 |
| `system/message` | agent.ts:417 |
| `user/message` | agent.ts:421 |
| `assistant/message` | agent.ts:451 / 522 |
| `tool/result` | tool-calls.ts / agent.ts:345 |
| `step/end` | agent.ts:356 |
| `turn/end` | agent.ts:385 |
| `agent/inbox/spliced` | inbox.ts |
| `subagent/start` / `subagent/end` | docs/subsystems/subagent.md |

持久化由 `packages/session/session-persistence-jsonl` 承担（`storage.ts:187` 的 `append`）。事件带 `surfaceOp`，用来区分「进模型历史」和「只记录」。

## 七、上下文与压缩是两块独立的东西

- `systemPrompt.assemble(...)` —— 组装系统提示词
- `runtimeContext.project(...)` —— 运行时上下文快照，是一条可以被**替换**的 surface message（`runtime-context.ts` 里有 `isReplacementSurfaceEvent`）

压缩不在 agent-loop 里，是独立的包族：

```
packages/compaction/compaction            压缩引擎与触发契约
packages/compaction/compaction-basic      后端，用 ctx.tokenMeter 判压力
packages/compaction/compaction-tool-result-pruner
packages/compaction/compaction-image-offload
packages/compaction/command-compact       手动 /compact
```

## 八、子 agent

服务在 `packages/subagent/subagent/src/index.ts`：

- `registerProvider(provider)`（:510）—— 注册是能撤销的副作用，重名报 `DUPLICATE_PROVIDER`
- `start(name, request)`（:557）—— 先 `assertCapabilities`，再 `snapshotSubagentDescriptor`，最后才 `provider.start`
- `assertCapabilities`（:642）—— 表驱动，判据是 `!== undefined`

provider 侧契约在 `types.ts:130`（`SubagentCapabilities`）和 `:344`（`SubagentProvider`）。

模型面向的工具：

- `packages/subagent/tool-subagent` —— 一个 provider 一个 `toolName`
- `packages/subagent/tool-subagent-control` —— `send_message`（:29）、`interrupt_agent`（:75）、`list_agents`（list-agents.ts:87）

## 九、和 Codex 对得上的地方

| 环节 | DSH | Codex |
|---|---|---|
| 最外层循环 | `kick(): while (await this.turn()) {}` | `RegularTask::run` 的 `loop { run_turn(..) }` |
| 退出条件 | `inbox.hasPending` | `input_queue.has_pending_input(&active_turn)` |
| 队列 | `inbox`：`next-turn` / `next-step` | `input_queue`：pending input + mailbox |
| 中途插话 | `inbox.claim('next-step')` | `get_pending_input` + `PersistContext::SteeredUserInput` |
| 一个回合 | `turn()` | `run_turn()` |
| 回合内的轮 | `step()` | 采样循环 |
| 模型流 | `llm.stream(request)` | `client.stream(...)` |
| 工具 | `executeToolCalls` | `ToolCallRuntime` |
| 落盘 | `session.append(...)` 每步一次 | `run_hooks_and_record_inputs` + rollout |

形状一致，但两边是独立演化的，细节差别很大（Codex 有 TaskKind 分层、MCP 按输入拉起、采样前压缩写死在 turn 开头）。

## 未核实

- `session.append` 的完整签名与 `surfaceOp` 全部取值，未逐字段核对 `packages/session/session`。
- 压缩触发的具体阈值由配置与 `tokenMeter` 共同决定，未核对默认值。
- 工具注册表的 `restrict()` 作用域语义，只看了 `packages/core/tools/src/index.ts` 的片段。
