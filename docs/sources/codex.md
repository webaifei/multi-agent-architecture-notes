# 资料来源 · Codex

本页只放**能核对的事实**，每条都带出处。章节讲解里出现的每个机制，都应该能在下面找到对应条目。

置信度标记：**[源码]** = 本机一手源码，**[官方]** = 官方文档/仓库，**[待核]** = 尚未验证，不在正文里当结论用。

## 一级来源

| 来源 | 是什么 |
| --- | --- |
| `packages/subagent/subagent-codex/src/wire.ts` | DeepSeek Harness 里的 **Codex app-server 0.153.4 协议适配器**。这是「把真实 Codex 当子 agent 驱动」的完整实现 |
| `packages/subagent/subagent-codex/src/run.ts` | 子进程生命周期 + `permissionMode` → `thread/start` 字段映射 |
| `packages/subagent/subagent-codex/README.md` | 配置项、权限模式表、已知限制 |
| `docs/subsystems/subagent.md` | Harness 的委托能力接缝契约（第 3 章的主角） |

> 为什么先读这里：DeepSeek Harness 已经把 Codex 的协议摸了一遍，而且是被测试覆盖的产品代码。
> 读它比自己猜 codex-rs 的内部结构快得多，而且是可验证的。

## 已核实事实

### 1. Codex 是可被外部驱动的「进程 + 协议」

- **[源码]** 启动方式固定为 `codex app-server --stdio`（`run.ts` 里是 `[process.execPath, CODEX_PACKAGE_BIN, 'app-server', '--stdio']`），走 **JSON-RPC 行协议**。
- **[源码]** 握手顺序：客户端发 `initialize` 请求 → 收到响应 → 发 `initialized` **通知**（notification，不等响应）。然后才能开 thread。
- **[源码]** 一次委派 = 一个 **ephemeral thread** + 一个 turn；协议版本对齐 `0.153.4`。

**教学含义**：Codex 的「agent 边界」是**进程边界**。子 agent 不是同进程里的一个对象，而是一个独立进程 + 一份协商好的协议。这解释了它为什么沙箱/审批最扎实，也解释了它跨进程通信的天花板。

### 2. 审批与沙箱是「两个正交旋钮」

**[源码]** `run.ts` 里的三档 `permissionMode`，直接映射成 `thread/start` 参数：

| permissionMode | thread/start 字段 | 含义 |
| --- | --- | --- |
| `never`（默认） | `approvalPolicy: 'never'` | 从不问人；失败就作为结果回给模型 |
| `approve-for-me` | `approvalPolicy: 'on-request'` + `approvalsReviewer: 'auto_review'` + `sandbox: 'workspace-write'` | 权限请求交给模型自动评审，**不需要人类** |
| `dangerously-bypass-approvals-and-sandbox` | `approvalPolicy: 'never'` + `sandbox: 'danger-full-access'` | 既不管审批也不管沙箱，必须显式选择 |

**教学含义**：这里有两个独立维度——**要不要问**（approval）和**允许碰什么**（sandbox）。
第 1.4 节就按这个二分法实现，而不是自己拍脑袋发明一套。

### 3. 事件流里有三种重要 item

**[源码]** 协议侧观察到的 item 类型至少包括：

- `commandExecution` —— 执行命令，状态可能是 `declined`（被拒绝）；
- `fileChange` —— 改文件，状态也可能是 `declined`；
- `agentMessage` —— 模型说话，带 `phase` 字段：`final_answer` / `commentary` / `null`。

**[源码]** 取最终答案的逻辑很讲究：优先取 `final_answer`；只有**没有** phase 的（`null`）才当后备答案；
`commentary`（过程性发言）**不算**结果。所以一个 turn 的「产出」是被协议显式标注的，不是靠猜。

**[源码]** 无人值守审批：遇到审批请求时，看 `availableDecisions`，有 `cancel` 选 `cancel`，否则 `decline`；
两个都没有就**报错**而不是默认放行（fail loud）。

**教学含义**：第 1.3 节的会话日志、第 1.5 节的「只回传最终答案」，都是围绕 `phase` 这个设计展开的。

### 4. 子 agent 的输入输出被刻意收窄

**[源码]** README：一次委派执行「一个自包含的文本任务」，**只返回最终答案**，或者一个安全的失败诊断。
没有中途追问、没有增量回传。想换一种行为，就换一个 provider（Harness 有 Claude Code、ACP、DSH SDK 等并列实现）。

**教学含义**：这是「一次性返回值」通信模式的教科书案例（见 `docs/00-concepts.md` 第三节）。

## 待核实（下一轮补齐）

- [ ] codex-rs 内部 agent loop 的模块划分（core/src 下的会话、turn、item 表示）；
- [ ] 会话落盘路径与 rollout JSONL 的确切格式；
- [ ] `exec` / `apply_patch` 工具在协议层的确切名字与参数；
- [ ] 云端并行任务与本地 CLI 多 agent 的边界。
