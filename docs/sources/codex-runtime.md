# Codex CLI 运行时调用链：源码锚定追踪

对象：`openai/codex` 分支 `main`，抓取时间 2026-10-10。
锚点写法 `仓库相对路径:行号`；引文为逐字摘录（≤20 词）。未能确认的内容见第 8 节「未核实」。

---

## 1. 入口：一次用户提交如何到达会话

### 1.1 提交对象与通道

- 提交在 core 内部表示为 `Submission`，带 `id`、`op`、`parent_turn_id`、`root_turn_id` 与 residency guard。
  - `codex-rs/core/src/session/submission.rs:9` `pub(crate) struct Submission {`（字段 `:10-19`）
- `SessionIo` 持有 `tx_sub: Sender<Submission>`；通道容量 512。
  - `codex-rs/core/src/session/mod.rs:416` `pub(crate) tx_sub: Sender<Submission>,`
  - `codex-rs/core/src/session/mod.rs:516` `pub(crate) const SUBMISSION_CHANNEL_CAPACITY: usize = 512;`

### 1.2 会话启动与提交循环

- `Session::spawn` → `spawn_internal` 建立通道并拉起 `submission_loop`。
  - `codex-rs/core/src/session/mod.rs:524` `pub(crate) fn spawn(`
  - `codex-rs/core/src/session/mod.rs:557` `async fn spawn_internal(args: SessionSpawnArgs) -> CodexResult<(Arc<Self>, SessionIo)> {`
  - `codex-rs/core/src/session/mod.rs:606` `let (tx_sub, rx_sub) = async_channel::bounded(SUBMISSION_CHANNEL_CAPACITY);`
  - `codex-rs/core/src/session/mod.rs:987` `submission_loop(session_for_loop, configured_config, rx_sub)`
- `submission_loop` 用 `tokio::select!` 同时等待提交、shutdown token 与 mailbox 变更，然后按 `sub.op` 分派。
  - `codex-rs/core/src/session/handlers.rs:439` `pub(super) async fn submission_loop(`
  - `codex-rs/core/src/session/handlers.rs:449` `let sub = tokio::select! {`

### 1.3 Op::TurnInput 的走向

- 用户输入走 `Op::TurnInput`，转交 `turn_input::handle`。
  - `codex-rs/core/src/session/handlers.rs:560` `Op::TurnInput {`
  - `codex-rs/core/src/session/handlers.rs:569` `let result = turn_input::handle(&sess, request, mode, sub.id.clone()).await;`
  - `codex-rs/core/src/session/turn_input.rs:230` `pub(super) async fn handle(`
- `handle` 按 `TurnInputMode` 分派：启动或转向 / 仅在空闲时启动 / 显式转向。
  - `codex-rs/core/src/session/turn_input.rs:238` `TurnInputMode::StartOrSteer => start_or_steer(session, request, submission_id).await,`
  - `codex-rs/core/src/session/turn_input.rs:278` `TurnInputMode::Steer { expected_turn_id } =>`
- 该模块只做「决定」而不等待采样。
  - `codex-rs/core/src/session/turn_input.rs:3-4` `This is the one place Core decides whether submitted input starts a turn, steers an active turn, or is rejected.`

### 1.4 启动新回合

- 无活动回合时 `start_or_steer` 生成设置与 `TurnContext`，再调 `Session::spawn_task`。
  - `codex-rs/core/src/session/turn_input.rs:328` `async fn start_or_steer(`
  - `codex-rs/core/src/session/turn_input.rs:446` `.spawn_task(Arc::clone(&turn_context), task_input, RegularTask::new())`
- 自动/恢复路径用 `start_task`。
  - `codex-rs/core/src/session/turn_input.rs:626` `.start_task(Arc::clone(&turn_context), task_input, RegularTask::new())`
- `spawn_task` 先中止当前任务再转 `start_task`。
  - `codex-rs/core/src/tasks/mod.rs:272` `pub async fn spawn_task<T: SessionTask>(`
  - `codex-rs/core/src/tasks/mod.rs:276` `self.abort_all_tasks(TurnAbortReason::Replaced).await;`
- `start_task` 登记活动回合、建取消令牌、最后 `tokio::spawn`。
  - `codex-rs/core/src/tasks/mod.rs:282` `pub(crate) async fn start_task<T: SessionTask>(`
  - `codex-rs/core/src/tasks/mod.rs:312` `let cancellation_token = CancellationToken::new();`
  - `codex-rs/core/src/tasks/mod.rs:408` `let handle = tokio::spawn(storage_originator.scope(task_future));`
  - 任务 future 结束前统一 `flush_rollout` 与 `on_task_finished`（`:377-401`）。

### 1.5 SessionTask trait 契约

- 声明在 `tasks/mod.rs:180`，三个必需方法加一个可选清理方法。
  - `codex-rs/core/src/tasks/mod.rs:180` `pub(crate) trait SessionTask: Send + Sync + 'static {`
  - `codex-rs/core/src/tasks/mod.rs:183` `fn kind(&self) -> TaskKind;`
  - `codex-rs/core/src/tasks/mod.rs:186` `fn span_name(&self) -> &'static str;`
  - `codex-rs/core/src/tasks/mod.rs:198` `fn run(`
  - `codex-rs/core/src/tasks/mod.rs:211` `fn abort(`
- `run` 返回 `SessionTaskResult = CodexResult<Option<String>>`；`Some` 会被 `Session::on_task_finished` 发给客户端（`codex-rs/core/src/tasks/mod.rs:75`，契约说明 `:190-197`）。
- `AnySessionTask` 是对象安全版本（`codex-rs/core/src/tasks/mod.rs:222`）；实现者含 `RegularTask`（`:65`）与 `CompactTask`（`codex-rs/core/src/tasks/compact.rs:18`）。

---

## 2. 循环与退出条件

一次用户回合实际包含**四个**嵌套循环（其中三个是主循环，第四个是重试循环）。以下给出每一层的继续与退出条件。

### 2.1 第一层：`RegularTask::run` 的任务驱动循环

- 位置 `codex-rs/core/src/tasks/regular.rs:104-124`。
  - `codex-rs/core/src/tasks/regular.rs:104` `loop {`
  - `codex-rs/core/src/tasks/regular.rs:105` `let last_agent_message = run_turn(`
- **继续条件**：`run_turn` 正常返回、无 terminal error、输入队列仍有待处理输入；把 `next_input` 置空再跑一轮。
  - `codex-rs/core/src/tasks/regular.rs:120` `if !sess.input_queue.has_pending_input(&sess.active_turn).await {`
  - `codex-rs/core/src/tasks/regular.rs:123` `next_input = Vec::new();`
- **退出条件**：`run_turn` 返回 `Err` 经 `?` 冒泡（`:114`）；`ctx.terminal_error` 非空（`:117-119`）；队列无待处理输入（`:121`）。
- 含义：一个「任务」在语义上可包含多次 `run_turn`。

### 2.2 第二层：`run_turn` 的步进循环

- 函数 `codex-rs/core/src/session/turn.rs:164`；循环在 `:425`。
  - `codex-rs/core/src/session/turn.rs:425` `loop {`
- 每轮：取待处理输入（`:429-434`）→ 记录输入（`:436-448`）→ 可选压缩与上下文捕获 → 发一次采样请求（`:532`，`run_sampling_request`）。
- 采样后判定：`codex-rs/core/src/session/turn.rs:574` `let needs_follow_up = model_needs_follow_up || has_pending_input;` 与 `:609` `let should_roll_over = needs_follow_up`。
- **继续条件（`continue`）**：
  1. `should_roll_over`：先 `run_auto_compact`（`CompactionPhase::MidTurn`，`:628`），再 `continue`（`:654`）。
  2. `needs_follow_up` 为真：`codex-rs/core/src/session/turn.rs:760` `continue;`
  3. Stop hook 阻塞并给出续跑提示：`codex-rs/core/src/session/turn.rs:693` `continue;`
  4. guardian 预算压缩后重试一次：`codex-rs/core/src/session/turn.rs:790` `continue;`
- **退出条件（`break` / `return`）**：
  1. hook 判定停止：`codex-rs/core/src/session/turn.rs:447` `break;`
  2. Stop hook 明确停止：`codex-rs/core/src/session/turn.rs:705` `break;`
  3. `!needs_follow_up`：跑 post-turn 压缩（`CompactionPhase::PostTurn`，`:736`）后 `codex-rs/core/src/session/turn.rs:758` `break;`
  4. 图片请求非法：`codex-rs/core/src/session/turn.rs:816` `break;`
  5. 其它错误：`codex-rs/core/src/session/turn.rs:833` `break;`
- 循环后返回 `Ok(last_agent_message)`，`codex-rs/core/src/session/turn.rs:838`。

### 2.3 第三层：`try_run_sampling_request` 的流事件循环

- 包装函数 `run_sampling_request`（`codex-rs/core/src/session/turn.rs:1604`）建 `ToolCallRuntime`（`:1614`）并进入重试循环。
- `client.stream(...)` 在 `codex-rs/core/src/session/turn.rs:2565-2566`（`let mut stream = client_session` / `.stream(`）。
- 流事件循环在 `codex-rs/core/src/session/turn.rs:2611` `let outcome: CodexResult<SamplingRequestResult> = loop {`。
- **退出条件**：
  1. 取消：`codex-rs/core/src/session/turn.rs:2634` `break Err(CodexErr::TurnAborted);`
  2. 流被中断但可继续：重置 preempt 后 `codex-rs/core/src/session/turn.rs:2646` `continue;`
  3. 中断且无法继续：`codex-rs/core/src/session/turn.rs:2650` 返回 `needs_follow_up: true`。
  4. 流被丢弃：`codex-rs/core/src/session/turn.rs:2662` `break Err(CodexErr::Stream(`
  5. mailbox 抢占：`codex-rs/core/src/session/turn.rs:2808` 返回 `needs_follow_up: true`。
  6. `ResponseEvent::Completed`：`codex-rs/core/src/session/turn.rs:2949`，据 `end_turn` 定 `needs_follow_up`，最终 `codex-rs/core/src/session/turn.rs:2994` `break Ok(SamplingRequestResult {`。
- 工具 future 先入队、流结束后才排空：`codex-rs/core/src/session/turn.rs:2582` `let mut in_flight: FuturesOrdered<InFlightFuture<'static>> = FuturesOrdered::new();`、`:2785` `in_flight.push_back(tool_future);`、`:3159` `if !in_flight.is_empty() {`、排空实现 `:2462`（`drain_in_flight`）。

### 2.4 第四层：`run_sampling_request` 自身的重试循环

- `codex-rs/core/src/session/turn.rs:1640` `loop {`；它包住 `try_run_sampling_request`（`:1673`）。
- **退出条件**：
  1. 采样成功：`codex-rs/core/src/session/turn.rs:1686-1687` `Ok(output) => {` / `return Ok((output, original_input.unwrap_or(prompt.input)));`
  2. 取消：`codex-rs/core/src/session/turn.rs:1720-1721` `return Err(CodexErr::TurnAborted);`
  3. preempt：`codex-rs/core/src/session/turn.rs:1722-1727` 返回 `needs_follow_up: true`。
  4. 否则调用 `handle_response_stream_error` 重试（`:1707`）。
- **继续条件**：`retry??` 成功后 `codex-rs/core/src/session/turn.rs:1732` `turn_context.turn_timing_state.record_sampling_retry();`，回到循环顶部。

### 2.5 循环间关系与常见数错点

- 四层共享同一个 `CancellationToken`：第 1 层由 `start_task` 创建（`codex-rs/core/src/tasks/mod.rs:312`），随后逐层 `child_token()`：`codex-rs/core/src/tasks/regular.rs:111` → `codex-rs/core/src/session/turn.rs:539` → `:1682` → `:2746`。
- 「`client.stream` 在 425 附近」与源码不符：425 是 `run_turn` 的步进循环，`client.stream` 在 2565，流循环在 2611。

---

## 3. 输入队列

### 3.1 结构

- `InputQueue` 是会话级（`codex-rs/core/src/session/input_queue.rs:95`），`TurnInputQueue` 是回合级容器（`:90`），后者只持有 `:91` `items: Vec<TurnInput>,`。
- `InputQueue` 另有 mailbox 队列与活动通知通道（字段 `:96-99`）；活动类型只有 `Mailbox` 与 `Steer`（`:83`）。

### 3.2 `get_pending_input`

- 声明 `codex-rs/core/src/session/input_queue.rs:400`，返回 `(Vec<TurnInput>, TurnStartOptions)`。
- 流程：锁 active turn → 若当前回合接受 mailbox 投递则整段 `split_off(0)`（`:411-415`）→ 再 drain mailbox 并拼接（`:424-431`）。
- 不接受 mailbox 时直接返回空 `TurnStartOptions`（`:421-423`）。

### 3.3 `has_pending_input`

- 声明 `codex-rs/core/src/session/input_queue.rs:438`；判据是 `:445` `!turn_state.pending_input.is_empty(),`。
- 不接受 mailbox 投递则返回 `false`，否则回落到 `has_pending_mailbox_items()`（`:452-457`）。这是第 1 层循环唯一的继续判据。

### 3.4 `accept_mailbox_delivery_for_current_turn`

- 声明 `codex-rs/core/src/session/input_queue.rs:345`；先把回合状态置回 `CurrentTurn`（取 `turn_state_for_sub_id` 于 `:346-352`，转调于 `:353-359`）。
- 状态机在 `TurnState`：默认 `CurrentTurn`，发出可见最终答案后切 `NextTurn`。
  - `codex-rs/core/src/state/turn.rs:47` `pub(crate) enum MailboxDeliveryPhase {`；转移注释 `:37-45`；接受函数 `:208`。
- 采样返回「需要续跑」时会主动接受 mailbox 投递（`codex-rs/core/src/session/turn.rs:551-557`）；显式推迟到下一回合见 `codex-rs/core/src/session/input_queue.rs:322`。

### 3.5 steering 与普通回合输入的区别

- steering 走 `Session::steer_input`（`codex-rs/core/src/session/turn_input.rs:803`），前提是存在 `active_turn.task`（`:814`）。
- steering 只接受 `UserInput`（`codex-rs/core/src/session/turn_input.rs:655` `"only user input can steer a turn".to_string(),`）。
- 非 `Regular` 任务不可 steering：`Review`（`:836`）与 `Compact`（`:841`）都返回 `ActiveTurnNotSteerable`。
- steering 把输入追加到当前回合 pending 队列并重新接受 mailbox 投递（`:888`；`codex-rs/core/src/session/input_queue.rs:368-379` 扩展 items → 接受投递 → 发送 `InputQueueActivity::Steer`）。
- 普通回合输入则新建 `TurnContext` 并启动新任务（`codex-rs/core/src/session/turn_input.rs:446`）。
- 结论：steering **不新建回合**，只向已有回合追加；这些输入要等下一轮 `get_pending_input` 才被取走并送进模型。
- 正在进行的采样可被用户输入抢占：`watch_user_input` 订阅活动并在出现用户输入时 cancel 抢占令牌。
  - `codex-rs/core/src/session/input_queue.rs:293` `pub(crate) async fn watch_user_input(`
  - `has_user_input` 只认 `TurnInput::UserInput`，`codex-rs/core/src/session/input_queue.rs:463`
- mailbox 与 steering 的分野：mailbox 只影响子代理消息的投递时机（`has_pending_mailbox_items`，`codex-rs/core/src/session/input_queue.rs:221`），steering 是用户输入直接进入当前回合。

---

## 4. 工具执行、审批与沙箱

### 4.1 ToolCallRuntime 与并行分组

- `ToolCallRuntime` 持有 session、step_context、diff tracker 与一把并行闸门锁（`codex-rs/core/src/tools/parallel.rs:46`；锁字段 `:51`）。
- 每个调用先问路由器是否支持并行（`codex-rs/core/src/tools/parallel.rs:141` → `codex-rs/core/src/tools/router.rs:246`）。
- 分组规则：支持并行取**读锁**（可并发），否则取**写锁**（串行独占）——`codex-rs/core/src/tools/parallel.rs:213` `if supports_parallel {`、`:216` `Either::Right(lock.write().await)`。
- 每次派发是独立 `tokio::spawn`（`codex-rs/core/src/tools/parallel.rs:202`）；采样循环只在流结束后按序收集结果（`:240` `The sampling loop collects results in order only after its stream ends.`）。

### 4.2 审批请求位置

- 命令审批 `codex-rs/core/src/session/mod.rs:2881`：注册 oneshot（`:2903-2909`）→ 发 `EventMsg::ExecApprovalRequest`（`:2948`）→ 等待，断线按 `ReviewDecision::Abort`（`:2969`）。
- 补丁审批 `codex-rs/core/src/session/mod.rs:2976`：发 `EventMsg::ApplyPatchApprovalRequest`（`:3002`）→ 等待 oneshot（`:3011`）。
- 实际调用点在 `codex-rs/core/src/tools/approvals.rs` 的 `request_user_approval`：命令 `:671`、`write_stdin` `:701`、补丁 `:738`/`:752`、网络访问 `:779`。

### 4.3 审批、沙箱与重试的编排

- `ToolOrchestrator` 模块注释直接写明顺序：approval → select sandbox → attempt → retry。
  - `codex-rs/core/src/tools/orchestrator.rs:1-6`（含 `approval → select sandbox → attempt → retry`）
- `run` 固定步骤：`codex-rs/core/src/tools/orchestrator.rs:127` `pub async fn run<Rq, Out, T>(`、`:137` `let approval_policy = tool_ctx.step_context.settings.approval_policy();`、`:166` `let requirement = tool.exec_approval_requirement(req).unwrap_or_else(|| {`。
- 第一次尝试用 `initial_attempt`（`:364`）；沙箱拒绝后构造升级的 `retry_attempt` 再试（`:539`）；单次执行在 `run_attempt`（`:56`）。

### 4.4 沙箱模式在哪里被应用

- `SandboxAttempt` 承载一次尝试的沙箱类型、权限、cwd、workspace roots 与 sandbox 可执行文件（`codex-rs/core/src/tools/sandboxing.rs:401`，字段 `:402-419`）。
- 真正应用在 `SandboxAttempt::env_for`（`:490`）：`:500` `.transform(SandboxTransformRequest {`，随后 `:519` `crate::sandboxing::ExecRequest::from_sandbox_exec_request(request, options, workspace_roots)`。
- 远程 exec-server 路径 `env_for_exec_server`（`:524`）强制本金沙箱为 `SandboxType::None`（`:539`），改由 exec-server 施加。
- 首次尝试前确认原生沙箱可用（`:234` `pub(crate) fn ensure_native_sandbox(`）；至少一个工具显式构造编排器（`codex-rs/core/src/tools/handlers/apply_patch.rs:555`）。

---

## 5. 持久化与 rollout

### 5.1 `rollout.rs` 只是再导出

- 该文件不含实现，只 `pub use codex_rollout::...` 并实现 `RolloutConfigView`。
  - `codex-rs/core/src/rollout.rs:5` `pub use codex_rollout::RolloutRecorder;`
  - `codex-rs/core/src/rollout.rs:26` `impl codex_rollout::RolloutConfigView for Config {`

### 5.2 事件与对话项如何进入 rollout

- 对话项：`record_conversation_items`（`codex-rs/core/src/session/mod.rs:3573`）做准备后写历史与持久化（`:3701`，`RolloutItem::ResponseItem`）。
- 协议事件：`send_event_raw_with_persistence`（`:2611`）在 `persist` 为真时写 `RolloutItem::EventMsg`（`:2643`）。
- 统一写入口 `persist_rollout_items`（`:4596`），实际追加交给 `LiveThread`（`:4598` → `codex-rs/thread-store/src/live_thread.rs:220`）。
- 每次任务结束前有统一落盘屏障 `flush_rollout`（`:1477`），任务侧调用 `codex-rs/core/src/tasks/mod.rs:387`。
- 另一条写入路径是 `RolloutRecorder`：`codex-rs/rollout/src/recorder.rs:1048` `pub async fn record_canonical_items(&self, items: &[RolloutItem]) -> std::io::Result<()> {`。

### 5.3 rollout 预算

- `RolloutBudget` 按 token 记账并产生提醒。
  - `codex-rs/core/src/rollout_budget.rs:48` `pub(crate) fn record_usage(&self, usage: &TokenUsage) -> CodexResult<bool> {`
  - `codex-rs/core/src/rollout_budget.rs:69` `pub(crate) fn pending_reminder(`
  - `codex-rs/core/src/rollout_budget.rs:95` `pub(crate) fn mark_reminder_delivered(`
  - 提醒只在历史插入后才标记已投递（`:101`）。
- 回合侧封装 `codex-rs/core/src/session/rollout_budget.rs:7` `pub(super) async fn maybe_record_reminder(`，调用点 `codex-rs/core/src/session/turn.rs:453`。

### 5.4 resume 如何重建历史

- `spawn_internal` 按 `InitialHistory` 分支；`Resumed` 分支取出历史。
  - `codex-rs/core/src/session/mod.rs:1634` `InitialHistory::Resumed(resumed_history) => {`
  - `codex-rs/core/src/session/mod.rs:1636` `let rollout_items = resumed_history.history;`
  - 先据 rollout 末尾事件推断 agent 状态（`:1637-1645`）。
- 重建入口：
  - `codex-rs/core/src/session/mod.rs:1646` `let previous_turn_settings = self`
  - `codex-rs/core/src/session/mod.rs:1773` `async fn apply_rollout_reconstruction(`
  - `codex-rs/core/src/session/mod.rs:1792` `.reconstruct_history_from_rollout(turn_context, rollout_items)`
- 真正的重放算法是 `ContextManager::reconstruct_rollout`。
  - `codex-rs/core/src/session/rollout_reconstruction.rs:189` `pub(super) async fn reconstruct_history_from_rollout(`
  - `codex-rs/core/src/session/rollout_reconstruction.rs:208` `pub(crate) fn reconstruct_rollout(`
- 重放会选择最新仍然有效的压缩检查点，并从其 `replacement_history` 起算。
  - `codex-rs/core/src/session/rollout_reconstruction.rs:231` `let input_checkpoint = select_input_compaction(rollout_items, history_mode);`
  - `codex-rs/core/src/session/rollout_reconstruction.rs:497` `history.replace_annotated(items.clone());`
- resume 还会读 `resume_metadata`（多代理版本、最后回合 id、上一回合设置）。
  - `codex-rs/core/src/session/rollout_reconstruction.rs:233` `let resume_metadata =`
  - `codex-rs/core/src/session/rollout_reconstruction.rs:481` `resume_metadata.and_then(|metadata| metadata.previous_turn_settings.clone());`
- resume 完成后立刻写一条 `ThreadSettingsApplied`，即使没有后续回合。
  - `codex-rs/core/src/session/mod.rs:1680-1683`

---

## 6. 压缩

### 6.1 何时触发

- 入口一：每回合采样前的 `run_pre_sampling_compact`。
  - `codex-rs/core/src/session/turn.rs:1304` `async fn run_pre_sampling_compact(`
  - 触发条件 `codex-rs/core/src/session/turn.rs:1316` `if token_status.token_limit_reached {`
  - 走 `CompactionReason::ContextLimit` + `CompactionPhase::PreTurn`（`:1327`）。
- 入口二：模型切换相关压缩 `codex-rs/core/src/session/turn.rs:1346`。
  - 条件为压缩兼容 hash 改变或降级到更小窗口；reason 为 `CompHashChanged`（`:1377`）或 `ModelDownshift`（`:1406`）。
- 入口三：回合中 rollover，`codex-rs/core/src/session/turn.rs:609-651`（`CompactionPhase::MidTurn`，`:628`）。
- 入口四：回合结束后压缩，条件是配置阈值命中且无待处理输入（`:727-757`，`CompactionPhase::PostTurn`，`:736`）。
- 手动压缩是独立任务：
  - `codex-rs/core/src/session/handlers.rs:254` `sess.spawn_task(turn_context, Vec::new(), CompactTask).await;`
  - `codex-rs/core/src/tasks/compact.rs:18` `pub(crate) struct CompactTask;`

### 6.2 压缩替换了什么

- `run_auto_compact` 是自动压缩统一入口；先建 world state，再按 provider 能力选实现。
  - `codex-rs/core/src/session/turn.rs:1435` `async fn run_auto_compact(`（TokenBudget 走单独实现，`:1462`）
- 自动压缩入口 `run_inline_auto_compact_task` 使用 `CompactionTrigger::Auto`。
  - `codex-rs/core/src/compact.rs:113` `pub(crate) async fn run_inline_auto_compact_task(`
  - `codex-rs/core/src/compact.rs:140` `CompactionTrigger::Auto,`
- 手动压缩入口 `run_compact_task` 使用 `Manual` + `UserRequested`。
  - `codex-rs/core/src/compact.rs:150` `pub(crate) async fn run_compact_task(`
  - `codex-rs/core/src/compact.rs:163` `CompactionTrigger::Manual,`
- 替换历史 = 摘要 + 「窗口前缀 + 普通上下文」。
  - `codex-rs/core/src/compact.rs:673` `pub(crate) fn build_compacted_history(`
  - `codex-rs/core/src/compact.rs:80` `pub(crate) async fn build_compaction_replacement_history(`
- `replace_compacted_history` 替换内存历史并构造待持久化的 `CompactedItem`。
  - `codex-rs/core/src/session/mod.rs:4125` `pub(crate) async fn replace_compacted_history(`
  - `codex-rs/core/src/session/mod.rs:4181` `let replacement_history = items.clone();`
  - `codex-rs/core/src/session/mod.rs:4182` `state.replace_annotated_history(`
- 压缩推进自动压缩窗口号并重算 token 用量。
  - `codex-rs/core/src/compact.rs:392` `let (window_number, window_ids) = sess.advance_auto_compact_window().await;`
  - `codex-rs/core/src/compact.rs:416` `sess.recompute_token_usage(&replacement_step_context.turn)`
- 持久化批次按固定顺序写出 `Compacted`、`WorldState`、`TurnContext`、`EventMsg`。
  - `codex-rs/core/src/session/mod.rs:4216` `RolloutItem::Compacted(compacted_item),`
  - `codex-rs/core/src/session/mod.rs:4218` `RolloutItem::TurnContext(reference_context_item),`

---

## 7. 子代理

### 7.1 `spawn_agent` 如何创建子会话

- 处理函数 `handle_spawn_agent`（`codex-rs/core/src/tools/handlers/multi_agents/spawn.rs:53`）先发 `CollabAgentToolCall`（InProgress）。
- 深度检查：`:75` `let max_depth = turn.config.agent_max_depth;`，超限文案 `:78` `"Agent depth limit reached. Solve the task yourself."`。
- 子代理配置由 `prepare_agent_spawn_config` 依父 turn 推导（`:98`）。
- 创建动作交给 `AgentControl::spawn`：`codex-rs/core/src/tools/handlers/multi_agents/spawn.rs:116` `.spawn(SpawnRequest {`、`:119` `input: AgentInput::UserInput(input_items),` → `codex-rs/core/src/agent/control/spawn.rs:278` `pub(crate) async fn spawn_agent(` → `:676` `pub(super) async fn spawn_agent_internal(`。
- 结果取出新线程 id 与状态用于完成事件（`.../spawn.rs:153`）。

### 7.2 `SessionSource::SubAgent` 携带什么

- `SessionSource` 带 `SubAgent(SubAgentSource)` 变体。
  - `codex-rs/protocol/src/protocol.rs:2948` `pub enum SessionSource {`
  - `codex-rs/protocol/src/protocol.rs:2956` `SubAgent(SubAgentSource),`
- `SubAgentSource::ThreadSpawn` 携带父线程 id、深度、agent path、昵称、角色。
  - `codex-rs/protocol/src/protocol.rs:3030` `pub enum SubAgentSource {`
  - `codex-rs/protocol/src/protocol.rs:3033` `ThreadSpawn {`（字段 `:3034-3042`）
- 构造点 `thread_spawn_source`：昵称置空，角色由参数写入。
  - `codex-rs/core/src/tools/handlers/multi_agents_common.rs:141` `pub(crate) fn thread_spawn_source(`
  - `codex-rs/core/src/tools/handlers/multi_agents_common.rs:158` `Ok(SessionSource::SubAgent(SubAgentSource::ThreadSpawn {`
- 其它变体：`Review`、`Compact`、`MemoryConsolidation`、`Other(String)`（`codex-rs/protocol/src/protocol.rs:3031-3044`）。

### 7.3 `wait_agent` 如何拿到结果

- `handle_call` 先取 `local_agent_runtime.control(...)`。
  - `codex-rs/core/src/tools/handlers/multi_agents/wait.rs:56` `async fn handle_call(`
  - `codex-rs/core/src/tools/handlers/multi_agents/wait.rs:72` `.local_agent_runtime`
- 超时默认 `DEFAULT_WAIT_TIMEOUT_MS`，夹在 MIN/MAX 之间；非正数报错（`:95-105`）。
- 每个目标先订阅状态：初始快照已是终态则立即返回。
  - `codex-rs/core/src/tools/handlers/multi_agents/wait.rs:127` `let mut updates = local_agent_control.subscribe_status(*id).await?;`
- 未终结的目标进 `FuturesUnordered`，用 `timeout_at(deadline, ...)` 等第一个终态。
  - `codex-rs/core/src/tools/handlers/multi_agents/wait.rs:178` `futures.push(wait_for_final_status(session, id, rx));`
  - `codex-rs/core/src/tools/handlers/multi_agents/wait.rs:183` `match timeout_at(deadline, futures.next()).await {`
- `wait_for_final_status` 逐条读快照，命中 `is_final` 返回。
  - `codex-rs/core/src/tools/handlers/multi_agents/wait.rs:322` `async fn wait_for_final_status(`（`:329-332`）
- 「终态」= 非 `PendingInit` / `Running` / `Interrupted`。
  - `codex-rs/core/src/agent/status.rs:26` `pub(crate) fn is_final(status: &AgentStatus) -> bool {`
- 状态由事件推导：`TurnStarted→Running`、`TurnComplete→Completed/Errored`、`TurnAborted→Interrupted/Errored`、`ShutdownComplete→Shutdown`、`Error→Errored`。
  - `codex-rs/core/src/agent/status.rs:6` `pub(crate) fn agent_status_from_event(msg: &EventMsg) -> Option<AgentStatus> {`（分支 `:8-22`）
- 发布点：`Session::deliver_event_raw` 对每个事件更新 `agent_status` watch 通道。
  - `codex-rs/core/src/session/mod.rs:2662` `async fn deliver_event_raw(&self, event: Event) {`
  - `codex-rs/core/src/session/mod.rs:2664-2666`

### 7.4 `codex_delegate.rs` 的实际用途（重要修正）

- 它提供 `run_codex_thread_interactive` 与 `run_codex_thread_one_shot`。
  - `codex-rs/core/src/codex_delegate.rs:53` `pub(crate) async fn run_codex_thread_interactive(`
  - `codex-rs/core/src/codex_delegate.rs:230` `pub(crate) async fn run_codex_thread_one_shot(`
- 它确实用 `SessionSource::SubAgent` 并通过 `Session::spawn` 建子会话。
  - `codex-rs/core/src/codex_delegate.rs:96` `let session_source = SessionSource::SubAgent(subagent_source.clone());`
  - `codex-rs/core/src/codex_delegate.rs:105` `let spawn_result = Session::spawn(SessionSpawnArgs {`
- 但它要求审批策略必须是 `never`。
  - `codex-rs/core/src/codex_delegate.rs:69` `"Codex delegates require approval policy \`never\`".to_string(),`
- `run_codex_thread_one_shot` 唯一调用方是 review 任务，传入 `SubAgentSource::Review`。
  - `codex-rs/core/src/tasks/review.rs:23` `use crate::codex_delegate::run_codex_thread_one_shot;`
  - `codex-rs/core/src/tasks/review.rs:128` `(run_codex_thread_one_shot(`
  - `codex-rs/core/src/tasks/review.rs:136` `SubAgentSource::Review,`
- 结论：`spawn_agent` 工具**不走** `codex_delegate.rs`，而走 `AgentControl::spawn` → `spawn_agent_internal`（`codex-rs/core/src/agent/control/spawn.rs:676`）。

---

## 8. 未核实

1. **`spawn_agent_internal` 之后的子会话启动细节。** 只确认它位于 `codex-rs/core/src/agent/control/spawn.rs:676`，并处理 `SessionSource::SubAgent(SubAgentSource::ThreadSpawn { .. })`（`:761`）。未逐行确认它是直接调用 `Session::spawn` 还是经 ThreadManager 的 `start_thread`。
2. **子代理首条输入如何变成 `Op::TurnInput`。** `SpawnRequest` 带 `input: AgentInput::UserInput(input_items)`（`.../multi_agents/spawn.rs:119`），但未追踪该输入在子会话侧的投递函数与行号。
3. **V2 多代理路径。** `tools/handlers/multi_agents_v2/` 下的 `spawn.rs`、`wait.rs` 未逐行阅读；第 7 节结论仅覆盖 V1 处理器。
4. **`RolloutRecorder` 与 `LiveThread` 两条写入路径的分工。** 未确认 `RolloutRecorder` 在何种场景被直接使用。
5. **rollout 预算提醒的落点。** 只确认 `maybe_record_reminder`（`codex-rs/core/src/session/rollout_budget.rs:7`）与调用点（`codex-rs/core/src/session/turn.rs:453`）；未确认提醒文本写进哪一条 rollout item。
6. **`ensure_native_sandbox` 的失败语义。** 只读到签名 `codex-rs/core/src/tools/sandboxing.rs:234`，未读完整实现判断它是返回错误还是降级。
7. **行号时效性。** 所有行号基于 2026-10-10 抓取的 `main`；上游改动会导致偏移。
