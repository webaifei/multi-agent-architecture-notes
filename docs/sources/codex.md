# 资料来源 · Codex

本页只放**能核对的事实**，每条都带出处。章节讲解里出现的每个机制，都应该能在下面找到对应条目。

置信度标记：**[源码]** = 已读一手源码，**[官方]** = 官方文档已核对，**[待核]** = 未验证，不在正文里当结论用。

> ⚠️ **重要更正**：本页第一版曾写「Codex 的 agent 边界是进程边界」。
> 更深入的核查表明：**Codex CLI 自己的子 agent 是进程内的独立 Session**（`Session::spawn`），不是子进程。
> 「进程 + 协议」是 **DeepSeek Harness 从外部驱动 Codex** 的方式（app-server），两件事必须分开讲。

## 一手来源

| 来源 | 是什么 |
| --- | --- |
| `openai/codex` → `codex-rs/core/src/agent/`（`control/`、`registry.rs`、`role.rs`、`status.rs`） | Codex 子 agent 的注册表、生命周期、状态 |
| `codex-rs/core/src/agent/control/spawn.rs` | `spawn_agent` 工具的真实入口：`AgentControl::spawn`（:278）→ `spawn_agent_internal`（:676） |
| `codex-rs/core/src/codex_delegate.rs` | ⚠️ **不是** `spawn_agent` 的路径。它只被 `tasks/review.rs:128` 以 `SubAgentSource::Review` 调用（见下方更正） |
| `codex-rs/core/src/tools/handlers/multi_agents_spec.rs`、`multi_agents_v2/` | 暴露给模型的协作工具 |
| `codex-rs/core/src/agent/control/mailbox.rs`、`agent_message_board.rs` | 邮箱与共享消息板 |
| `codex-rs/rollout/src/lib.rs` | 会话落盘（JSONL）格式与路径 |
| `codex-rs/core/src/tools/handlers/apply_patch_spec.rs` | `apply_patch` 的 FREEFORM 规范 |
| 官方文档 `learn.chatgpt.com/docs/agent-configuration/subagents` 等 | 配置键与用户可见行为 |
| 本仓 `packages/subagent/subagent-codex/src/wire.ts` | Harness **从外部**驱动 Codex 的 app-server 适配器 |

> 时效性：以上仓库观察取自 2026-10-09 的 `main`。这块变化很快，教学时应当**钉一个 commit**，否则半年后对不上。

## 一、Codex CLI 自己的多 agent（进程内）

### 1. 协作工具的真实名字

**[源码]** `multi_agents_spec.rs` 定义了两套命名空间：

| 版本 | 工具 |
| --- | --- |
| V1 命名空间 `multi_agent_v1` | `spawn_agent`、`send_input`、`resume_agent`、`wait_agent`、`close_agent` |
| V2（裸名字） | `spawn_agent`、`send_message`、`followup_task`、`wait_agent`、`interrupt_agent`、`list_agents` |

工具命名空间描述原文：`"Tools for spawning and managing sub-agents."`

**教学含义**：这六个动词基本就是「多 agent 生命周期」的标准动作集合：
**造 → 说 → 追问 → 等 → 打断 → 收尾**。第 1.5 / 1.6 节直接照这个动词表实现。

### 2. 子 agent 怎么被创建：进程内，不是子进程

> ⚠️ **2026-10-10 更正**：本页第一版把 `codex_delegate.rs` 写成了 `spawn_agent` 的入口，这是错的。
> `codex_delegate.rs` 只被 `tasks/review.rs:128` 以 `SubAgentSource::Review` 调用，而且要求
> approval policy 必须是 `never`（`codex_delegate.rs:69`）——它是**审查任务**的子 agent 路径。
> 多 agent 的 `spawn_agent` 工具走 `AgentControl::spawn`（`agent/control/spawn.rs:278`）
> → `spawn_agent_internal`（`:676`）。

**[源码]** 创建出来的子会话**在同一个进程里**，有它自己的 `SessionIo` 通道，
事件由 tokio 任务桥接转发（`forward_session_io` 一类的接线）。

**[源码]** 身份表示：`SessionSource::SubAgent(SubAgentSource::ThreadSpawn { parent_thread_id, depth, agent_path, agent_nickname, agent_role })`。

**教学含义**：一个「agent」在实现层面 = **一份独立的会话状态 + 一对 IO 通道**。
只要我们能造出第二份 `messages` 数组和第二条事件流，我们就在同一个进程里拥有了多 agent。
→ 这正是 1.5 节要写的东西，不需要真的 fork 进程。

### 3. 三道闸：深度、并发、审批前置条件

- **[源码]** 深度：`next_thread_spawn_depth` + `exceeds_thread_spawn_depth_limit` —— 超过深度上限就不许再 spawn；
- **[源码]** 并发：`AgentRegistry::reserve_spawn_slot(max_threads)` —— 预留名额，顺带保证 `AgentPath`/nickname 唯一；
- **[源码]** 委派前必须 `approval_policy == Never`，否则 **spawn 直接报错**（fail loud）。

**[官方]** 配置键：`[agents] enabled`、`max_concurrent_threads_per_session`、`default_subagent_model`、
`default_subagent_reasoning_effort`、`interrupt_message`；`agents.max_threads` 是遗留别名。
特性开关：`features.multi_agent`、`features.multi_agent_v2`。
自定义 agent 是 TOML 文件，放 `~/.codex/agents/` 或 `.codex/agents/`，必填 `name`、`description`、`developer_instructions`；内置 `default`、`worker`、`explorer`。

**教学含义**：**并发和深度必须有上限**。这不是保守，而是多 agent 系统翻车的头号原因（指数级 fan-out）。

### 4. 上下文隔离：三档，不是一个开关

**[源码]**

| 模式 | 含义 |
| --- | --- |
| `SessionIsolation::Isolated` | 子会话不共享父级的扩展注册表 |
| `SessionIsolation::Inherit` | 共享 |
| `InitialHistory::Forked` + `ForkPersistence::Copied` | 历史被**复制**一份给子 agent |
| `WarmFork` | 从父线程 fork |
| `SpawnAgentForkMode::FullHistory` | `fork_turns` 省略或 `"all"` 时，连模型/推理档位一起继承 |

**教学含义**：和 Claude Code 的「默认全新」不同，Codex 把「isolated / fork 历史」做成了**逐次可选的参数**。
这解释了后面第 3 章为什么要有 `spawn` 与 `fork` 两个并列 provider。

### 5. 通信：邮箱 + 共享消息板 + 状态轮询

- **[源码]** 每个 agent 有真实邮箱（`agent/control/mailbox.rs`，`InterAgentCommunication`，指标 `core.mailbox.pending`）；
  `InputQueue::deliver_mailbox_communication_to_current_turn` 把消息投递进当前回合。
- **[源码]** `send_message` 的投递模式是 `MessageDeliveryMode::QueueOnly`（只排队，不立刻打断）；
  `followup_task` 才会真的触发一个新 turn。
- **[源码]** `wait_agent` 订阅该 agent 的状态直到终态；结果通过 `AgentStatus::Completed(last_agent_message)` 带回来。
- **[源码]** 状态取值：`PendingInit | Running | Completed | Errored | Interrupted | Shutdown | NotFound`。
- **[源码]** 共享黑板：`agent_message_board.rs`，按会话树（`SessionId`）隔离，本地 SQLite 或远程 HTTP 实现。
- **[源码]** 命名：层级化的 `AgentPath`（根 → 任务名）+ 随机人类昵称；**没有「团队名」这个概念**。

**教学含义**：这是「**异步消息 + 状态轮询**」的完整形态，比一次性返回值强得多。
注意 `send_message`（只排队）和 `followup_task`（触发新回合）的区分——这是很细但很关键的设计。

## 二、一个 Codex 回合的生命周期

- **[源码]** 会话落盘：`~/.codex/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDThh-mm-ss-<thread-id>.jsonl`
  （另有 `.jsonl.zst` 压缩、`~/.codex/archived_sessions`、`session_index.jsonl`）；
  常量 `SESSIONS_SUBDIR="sessions"`、`ARCHIVED_SESSIONS_SUBDIR="archived_sessions"`。每条记录是可回放的会话事件。
- **[源码]** 工具：`exec_command`、`write_stdin`（持久 shell 会话）、`apply_patch`（**FREEFORM**，有 Lark 文法，
  「不要用 JSON 包起来」）、`request_permissions`、`view_image`。
- **[官方]** 审批：`approval_policy` = `never | on-request | on-failure | …`（`untrusted` 已退休）。
  沙箱：`read-only | workspace-write | danger-full-access`，由 OS 强制（macOS Seatbelt；Linux Landlock），**默认断网**。
  子 agent 继承父级沙箱；运行时用 `/permissions` 覆盖后会重新应用到子级。
- **[官方]** `codex resume` 重开最近的本仓库会话。

## 三、从外部驱动 Codex：app-server（DeepSeek Harness 的做法）

这一节才是「进程 + 协议」。

**[源码]** `packages/subagent/subagent-codex/src/wire.ts`：适配 Codex app-server **0.153.4** 的 JSON-RPC 行协议。

- 启动：`codex app-server --stdio`；
- 握手：`initialize` 请求 → `initialized` 通知 → `thread/start` → `turn/start`；
- 一次委派 = 一个 ephemeral thread + 一个 turn，只回传最终答案；
- `permissionMode` → `thread/start` 参数：

| permissionMode | thread/start 字段 |
| --- | --- |
| `never`（默认） | `approvalPolicy: 'never'` |
| `approve-for-me` | `approvalPolicy: 'on-request'` + `approvalsReviewer: 'auto_review'` + `sandbox: 'workspace-write'` |
| `dangerously-bypass-approvals-and-sandbox` | `approvalPolicy: 'never'` + `sandbox: 'danger-full-access'` |

- 事件：`turn/started`；item 类型 `commandExecution`、`fileChange`、`agentMessage`；
  `agentMessage.phase` = `final_answer` / `commentary` / `null`，**只有 `final_answer` 算结果**；
- 无人值守审批：从 `availableDecisions` 里选 `cancel`/`decline`，都没有就**报错**，不默认放行。

**教学含义**：同一个 Codex，可以**进程内**当子 agent 用（第一节），也可以**跨进程**被驱动（这一节）。
第 3 章会看到 Harness 正是选了后者，才能把 Codex 当成一个可插拔 provider。

## 四、其他产品，别混进来

- **[官方]** **Codex Cloud**：远程隔离工作区，一个任务一个 workspace —— 是另一个产品，不是子 agent。
- **[官方]** **Codex SDK / app server**：对本地 Codex *thread* 的编程控制（start/continue/resume），不是 agent 委派 API。
- **[官方]** **ChatGPT Work**：托管式子 agent 工作流（有 Ultra 主动委派档位）。
- **[官方]** **OpenAI Agents SDK**（不同产品）：handoff 是 `transfer_to_<agent>` 这类**转移控制权**的工具调用，
  不是并行 fork 会话。
- **「Codex Swarm」：任何一手来源里都没找到，不要教。**

## 待核实

- [ ] `spawn_agent_internal` 之后子会话启动的完整路径；子代理首条输入如何变成 `Op::TurnInput`；
- [ ] V2 多代理路径（`tools/handlers/multi_agents_v2/`）未逐行读，现有结论只覆盖 V1；
- [ ] `RolloutRecorder` 与 `LiveThread` 两条写入路径的分工；
- [ ] `agents.max_concurrent_threads_per_session` 的默认值（文档只说「Codex 自己决定」）；
- [ ] 未实际运行 CLI；「子 agent 在进程内」的判断来自 `agent/control/spawn.rs` 的源码阅读，未确认 `spawn_agent_internal` 之后是直接 `Session::spawn` 还是经 ThreadManager `start_thread`；
- [ ] 某个具体构建里远端 agent 后端是否启用（`AgentControlInit::Local` vs 外部注入）未完全追踪。
