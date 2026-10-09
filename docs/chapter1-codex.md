# 第 1 章 · Codex 式多 agent 架构

> 一句话：**多 agent 不是新架构，是工具调用的一种新返回值。**

Codex 的选择是「独立会话 + 工具优先」：一个 agent 就是一份 `Session` 加它自己的 IO 通道；
子 agent 由 `Session::spawn` 在进程内造出来，工具层（exec / patch / 沙箱 / 审批）扎得最深。

## 六步回顾

| 步骤 | 解决的问题 | 关键设计 | 代码 |
| --- | --- | --- | --- |
| 1.1 | 什么是一个 agent | 循环 + 上下文 + 工具 + 策略，四样缺一不可 | `step1-agent-loop.mjs` |
| 1.2 | 工具怎么才靠得住 | schema + 实现 + 结果规范化；失败是文本不是异常；输出头尾截断 | `step2-tools.mjs` |
| 1.3 | 崩溃了怎么恢复 | rollout JSONL：日志是真相，内存只是投影；重放断言 | `step3-session-log.mjs` |
| 1.4 | 怎么不闯祸 | sandbox × approval 两个正交旋钮；策略层不是安全边界 | `step4-sandbox.mjs` |
| 1.5 | 怎么派活 | `spawn_agent` / `wait_agent`，只回传最后一条消息，深度与并发两道闸 | `step5-subagent.mjs` |
| 1.6 | 怎么并行、怎么叫停 | 并行 fan-out、邮箱 QueueOnly、followup_task、协作式中断 | `step6-parallel-mailbox.mjs` |

## 四格表

**拓扑 —— 主管-工人（有上限的树）**

```
           主 agent
        ┌─────┼─────┐
     agent-1 agent-2 agent-3      ← 一次 spawn 三个，再一起 wait
        │
     （还能再往下，但被深度上限挡住）
```

- `spawn_agent` 造节点，`wait_agent` 收结果；
- 深度上限（`exceeds_thread_spawn_depth_limit`）挡住无限嵌套；
- 并发上限（`reserve_spawn_slot`）挡住指数级 fan-out。

**隔离 —— 逐次可选**

| 模式 | 含义 |
| --- | --- |
| 全新 | 本教学实现的默认；最省上下文 |
| `SessionIsolation::Inherit` | 子会话共享父级的扩展注册表 |
| `InitialHistory::Forked` + `ForkPersistence::Copied` | 历史**复制**一份给子 agent |
| `WarmFork` | 从父线程 fork |
| `SpawnAgentForkMode::FullHistory` | `fork_turns` 省略或 `"all"` 时连模型档位一起继承 |

教学实现选了最简单的一档；真实系统把它做成**逐次可选**，因为「要不要继承历史」是每次委派都要重新权衡的。

**通信 —— 三通道并存**

| 通道 | 语义 | 什么时候用 |
| --- | --- | --- |
| 一次性返回值 | `wait_agent` → `Completed(last_agent_message)` | 标准的主-从回收 |
| 邮箱 | `send_message` = `QueueOnly`，只排队、不打断 | 想给正在干活的 agent 补一句 |
| 新回合 | `followup_task`，复用同一份会话与日志 | 拿到结果后追问、复核 |

后两者必须分清楚：`send_message` 不负责唤醒，`followup_task` 才真的启动一次运行。

**收敛 —— 主管聚合 + 预算兜底**

- 主管把所有工人的结论汇总成一段话（1.6 演示 ①）；
- 预算兜底：`maxTurns`、并发上限、深度上限；
- 前置条件：委派要求 `approval_policy == Never`，否则 spawn 直接报错。

## 真实源码对照

| 我们写的 | Codex 里对应 |
| --- | --- |
| `AgentRegistry` | `codex-rs/core/src/agent/registry.rs` |
| `spawn` / `wait` / `interrupt` | `codex_delegate.rs`、`agent/control/spawn.rs`、`agent/status.rs` |
| `spawn_agent` / `send_message` / … | `tools/handlers/multi_agents_spec.rs`、`multi_agents_v2/` |
| `agent.mailbox` | `agent/control/mailbox.rs`（`InterAgentCommunication`、`core.mailbox.pending`） |
| 共享黑板（第 3 章会用） | `agent_message_board.rs` |
| `SessionLog` | `codex-rs/rollout/src/lib.rs` |
| `createToolkit` 的 `apply_patch` | `tools/handlers/apply_patch_spec.rs`（FREEFORM + Lark 文法） |
| `createPolicy` | `approval_policy` / `sandbox`，由 macOS Seatbelt / Linux Landlock 执行 |
| `trace.scoped` | 事件里的 `agent_path` / `agent_nickname` |

细节与出处见 [`../sources/codex.md`](../sources/codex.md)。

## 别搞混的三件事

1. **Codex CLI 自己的子 agent 是进程内的**（`Session::spawn`），不是子进程。
2. **app-server 协议**是「从外部驱动 Codex」的方式，DeepSeek Harness 用的就是它；
   两者都真实存在，但属于不同的层。
3. **「Codex Swarm」在任何一手来源里都不存在**，不要教，也不要学。

## 留个钩子

Codex 的一切都围绕「会话 + 工具」展开，代价是：**定义一个角色要改 Rust 代码或写 TOML**。
下一章 Claude Code 走的是另一条路——把角色做成**数据**（一个 Markdown 文件），
主 agent 用 `Agent` 工具按声明装配出一个全新的上下文窗口。
