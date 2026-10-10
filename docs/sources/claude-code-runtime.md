# Claude Code 运行时溯源档案

> 只写**实际拉取过**的证据；每条断言后跟 URL 或「包@版本 / 文件:行号」。文档没写、源码没给的一律进第 8 节，**不猜**。
> 核验 2026-10-10；版本 `@anthropic-ai/claude-code@2.1.296`、`@anthropic-ai/claude-agent-sdk@0.3.296`、Python `claude-agent-sdk@0.2.165`。
> 标记：**[文档]** 官方文档明文 · **[类型]** 已发布 `.d.ts` · **[源码]** Python SDK 实现 · **[元数据]** npm 包文件。

## 0. 先纠正三个关于「可观测性」的前提

**0.1 TypeScript SDK 的 GitHub 仓库里没有 SDK 源码。** `github.com/anthropics/claude-agent-sdk-typescript`（main tarball）
只有 `README.md`、`CLAUDE.md`、`CHANGELOG.md`、`LICENSE.md`、`.github/`、`scripts/`、
`examples/session-stores/{s3,redis,postgres}/`。**不存在 `src/`**，因此它无法「揭示 wire protocol」。
可读的 TS 协议面在 npm 包里：`@anthropic-ai/claude-agent-sdk@0.3.296` 的 `package/sdk.d.ts`
（10,044 行，纯类型声明，**未压缩，带完整 JSDoc**）——这是本档案最主要的一手来源。

**0.2 `@anthropic-ai/claude-code` 已经不是「打包压缩过的 JS」。** **[元数据]** `package.json` 有
`"bin": {"claude": "bin/claude.exe"}` 与 8 个平台可选依赖（`@anthropic-ai/claude-code-darwin-arm64` 等，版本同为 2.1.296）。
**[元数据]** `install.cjs` 首段注释：

> Detects the platform, finds the matching native binary from optionalDependencies, and copies it over the
> `bin/claude.exe` placeholder. After this runs, `claude` execs the native binary directly — **no Node.js process
> stays resident.**

CLI 现在是**编译后的原生二进制**；`bin/claude.exe` 在 Linux/macOS 上也只有 500 字节占位文本。
**「从 minified code 确认字符串」这条路已不存在**——字符串在二进制里，且不可作为行为证据。

**0.3 真正可读的三层**：`code.claude.com/docs/en/*.md`（行为承诺、配置、限额）＋ SDK 的 `.d.ts` 与 Python 实现
（帧格式、控制协议、CLI 参数）＋ npm 元数据。

## 1. Query 生命周期

**1.1 SDK 怎么起 CLI。** **[源码]** `claude-agent-sdk-python/src/claude_agent_sdk/_internal/transport/subprocess_cli.py:574`：

```python
cmd = [self._cli_path, "--output-format", "stream-json", "--verbose"]
```

同文件另加：`--input-format stream-json`（:793，流式输入＝持久会话）、`--append-system-prompt <s>`（:588）、
`--permission-mode <m>`（:637）、`--continue`（:640）、`--resume=<id>`（:649）、`--fork-session`（:704）、
`--resume-session-at=<uuid>`（:712）、`--resume-drops-turn=<uuid>`（:721）、`--settings <json>`（:660）。
:727 注释 `# No --agents CLI flag needed` —— SDK 走 `initialize` 控制请求传 agent 定义，而非 CLI 参数。

**1.2 CLI 往外流什么。** **[类型]** `sdk.d.ts:9642`：

```ts
declare type StdoutMessage = coreTypes.SDKMessage | coreTypes.SDKActiveGoalMessage
  | SDKControlResponse | SDKControlRequest | SDKControlCancelRequest | SDKKeepAliveMessage;
```

`stream-json` 模式下 **stdout 每行一个 JSON 对象**（`sdk.d.ts:9640`）；`SDKMessage` 是 43 个成员的联合（`sdk.d.ts:5383`）。
核心成员：`system/init`＝`SDKSystemMessage`（`sdk.d.ts:5973`，**每一轮开头都重发**）；`assistant`＝`SDKAssistantMessage`
（`sdk.d.ts:3630`）；`user`＝`SDKUserMessage`（`sdk.d.ts:6311`，回显用户消息或 tool_result）；
`stream_event`＝`SDKPartialAssistantMessage`（`sdk.d.ts:5537`，**仅 `--include-partial-messages` 时**）；
`result`＝`SDKResultMessage`（`sdk.d.ts:5789`，一轮结束）；`system/compact_boundary`＝`SDKCompactBoundaryMessage`
（`sdk.d.ts:3776`）；`system/status`（`compacting`/`requesting`）＝`SDKStatusMessage`（`sdk.d.ts:5956`）。
**`init` 的注释**（`sdk.d.ts:5971`）：

> Session metadata the CLI emits **at the start of each turn**, normally ahead of every other message of that turn:
> session_id, model, working directory, tools, MCP servers, slash commands, permission mode, and the capabilities
> list for feature detection.

其字段含 `claude_code_version`、`cwd`、`tools[]`、`mcp_servers[]`、`model`、`permissionMode`、`slash_commands[]`、
`agents[]`、`skills[]`、`plugins[]`、`output_style`、`apiKeySource`、`capabilities[]`、`uuid`、`session_id`
（`sdk.d.ts:5973-6055`）。`capabilities` 是**开放集合**，供特性探测而非比对版本号。

**1.3 控制协议：同一根流上的双向请求。** **[类型]** `sdk.d.ts:5029`：

```ts
export declare type SDKControlRequest = {
    type: 'control_request';
    request_id: string;          // 发送方自选，响应原样回带
    request: SDKControlRequestInner;
};
```

`SDKControlRequestInner` 有 40 种 subtype（`sdk.d.ts:5040`）：`initialize`、`interrupt`、`set_permission_mode`、
`set_model`、`can_use_tool`、`hook_callback`、`mcp_message`、`get_context_usage`、`get_session_cost`、`rewind_files`、
`stop_task`、`reload_plugins`、`reload_skills`、`update_settings`、`elicitation`、`request_user_dialog` 等。
响应两种（`sdk.d.ts:384`、`sdk.d.ts:408`）：`{subtype:'success', request_id, response?}` 与
`{subtype:'error', request_id, error}`。双方都可发起，也可用 `SDKControlCancelRequest`（`sdk.d.ts:3924`）
取消自己发出的在途请求。**[源码]** `initialize` 请求体（`query.py:340-356`）只带 `subtype:"initialize"` 加可选字段
`hooks`、`agents`、`excludeDynamicSections`、`systemPromptSnapshot`、`skills`、`forwardSubagentText`；
默认超时 60 秒（`query.py:168`）。**方向很重要**：`can_use_tool` 与 `hook_callback` 是 **CLI 发起、SDK 应答**的请求
（`query.py:577` 的 `_handle_control_request`）——权限提示与 hook 回调是反向 RPC。

**1.4 什么叫「一轮」（turn），`session_id` 怎么用。**

- **一轮 = 一次用户输入到一条 `result`。** `result.num_turns` 计的是这一轮内部的**模型往返次数**，不是轮数
  （`sdk.d.ts:5864`：「Distinct from num_turns, which counts model round-trips within one turn」）。
- `result_index` 是本次运行内 `result` 的**投递序号**（从 0）；序号有缺口说明有 result 丢失（同处注释）。
  `is_error` + `subtype` 区分成功/失败（`sdk.d.ts:5789`、`sdk.d.ts:5791`）。
- **`session_id` 几乎出现在每一条帧上**，含 `init` 与 `result`。[agent-sdk/sessions] 第 150 行：
  「Read it from the `session_id` field on the result message, which is present on **every result regardless of
  success or error**」；TS 里还能从 `init` 更早拿到。
- 流式输入下 `result` 的 `total_cost_usd` / `modelUsage` 是**累计值**，每轮带一次运行总量，不要跨 result 相加
  （`sdk.d.ts:5842`、`sdk.d.ts:5850`）。
- 几秒内连发的多条消息会**并成一轮**，该轮 `user_message_uuid` 是**最后一条**的 uuid（`sdk.d.ts:5556`、`sdk.d.ts:5767`）。
  [agent-sdk/streaming-vs-single-mode] 给出两种输入模式：流式输入是持久会话（可中断、可排队、可出权限请求），
  单消息输入是一次性调用加恢复能力。

## 2. 上下文组装

**2.1 系统提示的「层」与缓存边界。** 文档**没有**给出系统提示的分节清单（没有 "Identity / Doing tasks /
Tone and style / …" 这类官方列表）。能确认的只有**三层排序**与一个显式边界标记。**[文档]** [prompt-caching]
第 23-31 行的层表（请求顺序，最稳定在前）：

| 层 | 内容 | 何时变化 |
| - | - | - |
| System prompt | 核心指令、**工具定义** | 加载的工具定义集合变化时 |
| Project context | CLAUDE.md、auto memory、无路径限定 rules | 会话开始，或 `/clear`、`/compact` 后 |
| Conversation | 用户消息、模型回复、工具结果 | 每轮 |

改 Conversation 层不破坏前两层缓存；改 System prompt 层使其后全部失效——前缀精确匹配，无分段缓存。
**[类型]** SDK 侧 `systemPrompt` 选项（`sdk.d.ts:2321-2409`）：字符串 / 字符串数组 /
`{type:'preset',preset:'claude_code'}` / `preset+append`；`excludeDynamicSections:true` 剥掉
「working directory, auto-memory, git status」三类**逐用户动态段**，被剥内容**改以第一条 user 消息注入**；
`SYSTEM_PROMPT_DYNAMIC_BOUNDARY`（`sdk.d.ts:9744`，值 `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__`）作数组里的独立元素，
**标记前＝跨会话可缓存前缀，标记后＝会话私有后缀**；`snapshot`（默认 `true`）让系统提示**只在第一条请求渲染一次
并记入 transcript**，之后每条请求与 `resume`/`continue` 原样发送，晚到的不同 `append` 被忽略直到压缩或新会话。
注意 `excludeDynamicSections` 只点名三个动态段，**不是**完整分节清单。

**2.2 CLAUDE.md 从哪加载。** **[文档]** [memory] 第 55-64 行，由宽到窄：Managed policy（macOS
`/Library/Application Support/ClaudeCode/CLAUDE.md`；Linux `/etc/claude-code/CLAUDE.md`；Windows
`C:\Program Files\ClaudeCode\CLAUDE.md`）→ User `~/.claude/CLAUDE.md` → Project `./CLAUDE.md` 或
`./.claude/CLAUDE.md`（仓库可用 `AGENTS.md` 替代）→ Local `./CLAUDE.local.md`。关键规则（第 142-150 行）：
工作目录**及其所有上级目录**的 CLAUDE.md/CLAUDE.local.md 启动时加载；**全部拼接**而非覆盖，顺序为
「文件系统根 → 工作目录」，同目录内 `CLAUDE.local.md` 排在 `CLAUDE.md` 之后；工作目录**子目录**里的按需加载
（读写编辑该子目录文件时）；`@path` 导入随引用文件一起加载，代码块与行内代码里的 `@` 不解析；
块级 HTML 注释注入前剥离（代码块内的保留）；`--add-dir` 目录**默认不加载**其 CLAUDE.md。

**2.3 缓存。** **[文档]** [prompt-caching]：两个 TTL `5m`/`1h`，分桶配置——主会话 `promptCacheTtl` /
`CLAUDE_CODE_PROMPT_CACHE_TTL`，其余（子 agent、workflow、后台与辅助请求）`subagentPromptCacheTtl` /
`CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL`（第 277-284 行，均需 v2.1.242+）；优先级首位是
`FORCE_PROMPT_CACHING_5M=1`（第 286-289 行）。未设时的自动行为：限额内的 Claude 订阅用 `1h`，
API key / Bedrock / Vertex / Foundry 用 `5m`（`sdk.d.ts:9038`）。子 agent 可用 frontmatter
`experimental.cacheTtl`（[sub-agents] 字段表）。Claude Code **确实发送 `cache_control` 标记**；网关若以 400
拒绝带标记的请求，它把标记移到「最后一条对话消息」上并保持（第 57-60 行）。压缩的摘要请求复用同一 system
prompt、工具与历史，再加一条 summarization instruction 作为末尾 user 消息，故热缓存下 `/compact` 便宜很多（第 176 行）。

**2.4 压缩（compaction）。**

- **[文档]** 触发量是**窗口 token 数**，不是百分比：`autoCompactWindow`（100K–1M）。四个设置位：
  `/autocompact <tokens|auto>`、settings 的 `autoCompactWindow`、`--autocompact`、`CLAUDE_CODE_AUTO_COMPACT_WINDOW`
  （[model-config] 第 780-788 行）；`modelSettings.<model>.autoCompactWindow` 可按模型覆盖（`sdk.d.ts:9071`）。
- **[文档]** `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` 设「在窗口的百分之几触发」（1–100），**只能调低不能调高**
  （[env-vars] 第 202 行）——**默认百分比文档未给**。唯一默认数是「Sessions auto-compact at about **967K tokens**
  by default」，语境是 1M 窗口模型（[model-config] 第 774 行）。
- **[文档]** 保留规则表见 [context-window] 第 1592-1611 行：系统提示与 output style 保留；项目根 CLAUDE.md、
  auto memory、plan、路径规则、嵌套 CLAUDE.md 从磁盘重载；最近改动的**至多 5 个**文件被重读；已调用 skill
  正文重注入但**每个上限 5,000 token、合计 25,000 token**，超出从最旧开始丢。
- **[类型]** 流里的表达是 `SDKCompactBoundaryMessage`（`sdk.d.ts:3776`）：`compact_metadata.trigger:'manual'|'auto'`、
  `pre_tokens`、`post_tokens?`、`duration_ms?`，另加 `preserved_segment` / `preserved_messages` 两种**重链接信息**
  （压缩若保留部分消息段，恢复时把该段接回父链）。压缩前后另有 `system/status`：`status:'compacting'` +
  `compact_result:'success'|'failed'` + `compact_error?`（`sdk.d.ts:5954-5962`）。
- **[文档]** 手动入口 `/compact [instructions]`；`/autocompact` 管窗口（[commands] 第 59、73 行）。
  「先清旧工具输出、再摘要对话」；反复压缩失败（thrashing）几次后**停止并报错**而非死循环
  （[how-claude-code-works] 第 138-142 行）。

## 3. 子 agent

**3.1 工具名与输入。**

- **[文档]** `Agent`（旧名 `Task`）。[sub-agents] 第 492 行：「In version **2.1.63**, the Task tool was renamed to
  **Agent**. Existing `Task(...)` references in settings and agent definitions still work as aliases.」
  调用就是普通 `tool_use`，`name == "Agent"`（[agent-sdk/subagents] 第 302 行）。
- **[文档]** 文档**没有**给出 Agent 的完整参数 schema。确证的输入字段：`subagent_type`（省略时回退内置
  `general-purpose`；若内置被 `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1` 移除则报 `subagent_type is required`，
  [agent-sdk/subagents] 第 173 行）、`prompt`（唯一传参通道——同文档：「the only content you pass from parent to
  subagent is the Agent tool's prompt string」）、`run_in_background`（[sub-agents] 第 906 行）、`name`（带 `name`
  的调用在 agent teams 开启时改为起 teammate，[tools-reference] 第 21 行）、`isolation:"worktree"`（fork 可传，
  [sub-agents] 第 1208 行）。
- **[类型]** SDK 侧 `AgentDefinition`（`sdk.d.ts:38-110`）字段：`description`（必填）、`prompt`（必填）、`tools`、
  `disallowedTools`、`model`、`mcpServers`、`skills`、`initialPrompt`、`maxTurns`、`autoCompactWindow`、
  `background`、`omitClaudeMd`、`memory`、`effort`、`permissionMode`、`observer`、`observerMessage`、
  `criticalSystemReminder_EXPERIMENTAL`。
- **[文档]** 文件式定义＝Markdown + YAML frontmatter，正文即系统提示词；**只有 `name` 和 `description` 必填**；
  **不认识的字段被静默忽略、不报错**（[sub-agents] 第 300、303 行）。frontmatter 字段表在第 305-323 行，
  比 `AgentDefinition` 多 `name`、`hooks`、`isolation`、`color`、`experimental.cacheTtl`。
- **[文档]** 作用域：managed settings → `--agents` CLI JSON → 项目 `.claude/agents/` → 用户 `~/.claude/agents/` →
  插件（[sub-agents] 作用域表）。`--agents` 接受内联 JSON；非交互模式下也接受 JSON 文件路径，交互模式拒绝文件路径（第 224 行）。

**3.2 子 agent 看到什么。** **[文档]** [agent-sdk/subagents] 第 186-190 行的表：

| 子 agent **收到** | 子 agent **收不到** |
| - | - |
| 自己的系统提示（`AgentDefinition.prompt`）与 Agent 的 prompt 字符串 | 父级的对话历史或工具结果 |
| 项目 CLAUDE.md（经 `settingSources` 加载），除非设了 `omitClaudeMd` | 预加载 skill 正文，除非列在 `skills` 里 |
| 工具定义（继承父级，或 `tools` 给出的子集；后台运行再过滤） | 父级的系统提示 |

另：若子 agent 有 `SendMessage` 工具，第一轮自动附带**同会话其它具名 agent 的名册**；子 agent 继承主会话的
extended thinking 配置（第 178-183 行）；`omitClaudeMd` 保留 managed policy 文件。

**3.3 结果怎么回来。**

- **[文档]** 「intermediate tool calls and results **stay inside the subagent**; only its **final message** returns
  to the parent」（[agent-sdk/subagents] 第 26 行）。
- **[类型]** 该报告结构化出现在 `tool_use_result`（`sdk.d.ts:6311` 附近注释）：「For the Agent/Task tool the
  completed shape is the subagent's final report **without the model-directed agentId/usage trailer**, plus run totals」。
- **[文档]** v2.1.210 起最终消息先过**指令形态扫描**：仿冒 harness 控制标签（如 `<system-reminder>`）就地转义
  （开尖括号后插反斜杠）；提权限配置（`.claude/settings.json`、`bypassPermissions` 等）**原样保留**；行首 `Human:` /
  `Assistant:` 在冒号前插反斜杠。命中前两类额外加一行 `[harness: ...]` 标记。「it never removes or rewords the
  subagent's text」（[agent-sdk/subagents] 第 194 行后的 Note）。

**3.4 前台 / 后台。** **[文档]** [sub-agents] 第 900-928 行，**按顺序取第一个命中**：① in-process 团队 teammate
起的子 agent → 前台，且**拒绝**起 `background:true` 的 teammate 子 agent；② `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`
→ 一律前台；③ fork mode 开启（交互会话默认）→ 一律后台，Claude 无法要求前台；④ fork mode 关闭（`-p`、Agent SDK 默认）
→ 默认后台，需要结果时前台。后台子 agent 的**权限提示浮到主会话**（点名是哪个子 agent 在问；Esc 只拒这一次调用、
不终止该子 agent），其结果「reach Claude as a completion notification in a **later turn**」（第 922 行）；
后台子 agent 工具集比前台更小。

**3.5 深度与并发上限。** **[文档]** 两个环境变量，默认值明确：

| 维度 | 变量 | 默认 | 行为 |
| - | - | - | - |
| 深度 | `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` | `3`（主 agent 之下 3 层；`1` 表示子 agent 不能再派生） | 底层子 agent 无法再起，只能自己做 |
| 并发 | `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` | `20`（**统计每一个** Agent 工具起的子 agent） | 超限报 `Concurrent subagent limit reached`；**ultracode 会话豁免** |

出处：[sub-agents] 第 1028、1055 行；[agent-sdk/subagents] 第 624、625 行；并发限制需 v2.1.217+。
另有 workflow 独立上限 `CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS`（默认 16，范围 1–256，[workflows] 第 365 行），
workflow 起的子 agent **不受**会话并发上限约束（[workflows] 第 161 行）。

## 4. 权限

**4.1 `permissionMode` 取值。** **[类型]** `sdk.d.ts:2503`：

```ts
export declare type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto';
```

**[文档]** [agent-sdk/permissions] 第 131-138 行逐项：`default` 无模式级自动批准，需批准且未命中 allow 规则的调用
触发 `canUseTool`；`acceptEdits` 文件编辑与文件系统操作（`mkdir`、`rm`、`mv` 等）自动批准；`bypassPermissions`
跳过权限检查（**需 `allowDangerouslySkipPermissions`**），「任何模式都不自动批准的动作」除外；`plan` 只探索不编辑，
文件编辑永不自动批准、仍走 `canUseTool`；`dontAsk` 该提示的一律拒绝、**`canUseTool` 根本不被调用**；
`auto` 由模型分类器逐个审批/拒绝。**[文档]** 评估顺序六步：hooks → deny 规则 → ask 规则 → permission mode →
allow 规则 → `canUseTool`（第 54 行流程图 alt 文本）。子 agent 默认继承父会话模式，但**永不继承
`bypassPermissions`**（除非父会话本身是），`auto` 仅在 auto mode 对该子 agent 可用时才施加（第 141 行）。
frontmatter 另接受 `manual` 作 `default` 别名（[sub-agents] 字段表）。

**4.2 `canUseTool`。** **[类型]** `sdk.d.ts:217`：`(toolName, input, options) => Promise<PermissionResult | null>`。
`options` 含 `signal`、`suggestions`、`blockedPath`、`mcpServer{name,source}`、`decisionReason`、`title`、
`displayName`、`description`、`defaultToNo`、`suppressAlwaysAllowRule`、`toolUseID`、`agentID`、`requestId`、
`matchedAskRule`。**返回 `null` 是危险操作**——注释（`sdk.d.ts:210-216`）说只有消费者已**带外**发过
`control_response` 时才能返回 null；误返回 null 会导致不发响应、工具**永久挂起**：
「permission prompts have **no park deadline**」。

**4.3 拒绝怎么表示（三层，别混）。**

1. **SDK 回调返回**（**[类型]** `sdk.d.ts:2526`，**[源码]** `types.py:259-276`）：`{behavior:'allow', updatedInput?,
   updatedPermissions?}` 或 `{behavior:'deny', message: string, interrupt?: boolean}`。**[源码]** `query.py:611-641`
   转成 wire 上的 `{"behavior":"allow","updatedInput":...}` / `{"behavior":"deny","message":...,"interrupt":...}`。
2. **流里的帧** **[类型]** `SDKPermissionDeniedMessage`（`sdk.d.ts:5574`）：`system/permission_denied`，带
   `tool_name`、`tool_use_id`、`agent_id?`、`decision_reason_type?`。注释定性为「**Best-effort advisory** …
   `result.permission_denials` is the authoritative record」——帧可能丢，权威记录是 result 上的
   `permission_denials` 数组（`SDKPermissionDenial = {tool_name, tool_use_id, tool_input}`，`sdk.d.ts:5565`）。
   **PreToolUse hook 的拒绝、deny 规则覆盖 hook allow、路径作用域 deny 规则拒掉的文件工具调用都不在这个帧里。**
3. **Hook 的拒绝**：`PreToolUse` 返回 `permissionDecision:"deny"` + `permissionDecisionReason`（[hooks] 决策表）。

**4.4 `allowedTools` / `disallowedTools`。** **[文档]** [agent-sdk/permissions] 第 74-109 行：二者**不是**对称的
白名单/黑名单，而是往「allow 规则表」和「deny 规则表」加条目。`allowedTools=["Read","Grep"]` 之后**其它工具依然存在**，
只是需批准时落到 permission mode 与 `canUseTool`。**`allowedTools` 不能约束 `bypassPermissions`**——文档唯一的
Warning：未列出的工具没被任何 allow 命中，就落到 `bypassPermissions` 被批准；要真挡用 `disallowedTools`。
`disallowedTools=["Bash(rm *)"]` 只挡匹配命令，`Bash` 本身仍在；这类 deny 在**所有模式**生效，含 `bypassPermissions`。
收紧场景推荐 `allowedTools` + `permissionMode:"dontAsk"`。子 agent 侧优先级：`disallowedTools` > `tools`，
两边都列则移除，结果还要再受「子 agent 可用工具集」限制（[tools-reference] 第 107 行附近）。

## 5. 持久化

- **[文档]** 位置 `~/.claude/projects/<encoded-cwd>/*.jsonl`；设了 `CLAUDE_CONFIG_DIR` 则在其下 `projects/`。
  编码：把绝对工作目录里**每个非字母数字字符替换成 `-`**（`/Users/me/proj` → `-Users-me-proj`）；转换后超 200
  字符则截断并追加 hash。格式 **JSONL**。**官方没有发布行级 schema**——SDK 只提供 `listSessions()` /
  `getSessionMessages()` / `getSessionInfo()`（TS）与 `list_sessions()` / `get_session_messages()`（Python）
  （[agent-sdk/sessions] 第 272-274、410 行）。
- **[文档]** 子 agent transcript 单独存放：`~/.claude/projects/{project}/{sessionId}/subagents/agent-{agentId}.jsonl`。
  主会话压缩**不影响**子 agent transcript；同一 session 恢复后子 agent transcript 仍在（[sub-agents] 第 1127-1132 行）。
- **[文档]** `continue`/`resume`/`fork` 差别（[agent-sdk/sessions] 第 32-41 行）：continue 接最近一次；resume 指定 id
  续写；**fork 用原历史造一个全新会话，原会话不变**。fork 得到**自己的新 session id**，原 id 与历史不动（第 290 行）。
  限制：「Forking branches the conversation history, **not the filesystem**」（第 293 行）。
- **[类型]** SDK 选项：`continue`、`resume`、`sessionId`、`forkSession`、`resumeSessionAt`、`resumeDropsTurn`、
  `persistSession`、`sessionStore`（`sdk.d.ts:1526-2475` 的 Options 列表）；`--fork-session` /
  `--resume-session-at=` 由 Python transport 拼进命令行（`subprocess_cli.py:704`、`:712`）。
- **[文档]** 跨机恢复三条路：用 `sessionStore` 镜像；或搬 `*.jsonl` 到目标机 `~/.claude/projects/` 下再 resume；
  或干脆不依赖 resume（第 400-408 行）。不落盘：TS `persistSession:false`，Python `CLAUDE_CODE_SKIP_PROMPT_HISTORY`
  （第 30 行）。transcript 有保留期 `cleanupPeriodDays`，但 `~/.claude/projects/<project>/memory/` 下的记忆文件
  被排除在清理外（[memory] 第 542 行）。

## 6. Hooks

**6.1 事件全表与「能挡什么 / 能改什么」。** **[类型]** 完整列表是常量 `HOOK_EVENTS`（`sdk.d.ts:963`），与联合类型
`HookEvent`（`sdk.d.ts:982`）一致，共 **33 个**：

```
PreToolUse, PostToolUse, PostToolUseFailure, PostToolBatch, Notification,
UserPromptSubmit, UserPromptExpansion, SessionStart, SessionEnd, Stop, StopFailure,
SubagentStart, SubagentStop, PreCompact, PostCompact, PreModelSwitch, PostModelSwitch,
PermissionRequest, PermissionDenied, Setup, TeammateIdle, TaskCreated, TaskCompleted,
Elicitation, ElicitationResult, ConfigChange, WorktreeCreate, WorktreeRemove,
InstructionsLoaded, CwdChanged, FileChanged, DirectoryAdded, MessageDisplay
```

**[文档]** [hooks] 第 1099-1116 行决策控制总表：

| 事件 | 决策通道 | 关键字段 / 效果 |
| - | - | - |
| UserPromptSubmit, UserPromptExpansion, PostToolUse, PostToolUseFailure, PostToolBatch, Stop, SubagentStop, ConfigChange, PreCompact | 顶层 `decision` | `decision:"block"` + `reason`；Stop/SubagentStop 另接受 `hookSpecificOutput.additionalContext` 作非错误反馈 |
| TeammateIdle, TaskCompleted | 退出码或 `continue:false` | 退出码 2 阻止并以 stderr 反馈；`{"continue":false,"stopReason":…}` 直接停 teammate |
| TaskCreated | 退出码或顶层 `decision` | 退出码 2 或 `decision:"block"` 取消任务；**`continue:false` 被忽略** |
| PreToolUse | `hookSpecificOutput` | `permissionDecision`（**allow/deny/ask/defer**）+ `permissionDecisionReason` |
| PreModelSwitch | `hookSpecificOutput` 或顶层 `decision` | `permissionDecision`（allow/deny/ask）；`decision:"block"` 取消切换 |
| PermissionRequest | `hookSpecificOutput` | `decision.behavior`（allow/deny）；allow 时可带 `updatedInput` |
| PermissionDenied | `hookSpecificOutput` | `retry:true` 告诉模型可重试该次被拒调用 |
| WorktreeCreate | 返回路径 | command hook 用 stdout 打印路径；HTTP hook 用 `hookSpecificOutput.worktreePath` |
| WorktreeRemove | 退出码 | 任何非零退出码使删除失败（目录仍在）；**JSON 输出被丢弃** |
| Elicitation, ElicitationResult | `hookSpecificOutput` 或顶层 `decision` | `action`（accept/decline/cancel）、`content` |
| MessageDisplay | `hookSpecificOutput` | `displayContent` **只替换屏幕显示**；transcript 与模型看到的仍是原文 |
| SessionStart, SubagentStart, PostModelSwitch | 仅上下文 | `additionalContext`；SessionStart 另接受 `initialUserMessage`、`watchPaths`、`sessionTitle`、`reloadSkills`。**无阻断能力** |
| Setup, Notification, SessionEnd, PostCompact, InstructionsLoaded, StopFailure, CwdChanged, DirectoryAdded, FileChanged | 无 | 无决策控制，仅副作用 |

**能改写内容的事件只有四个**（[hooks] 第 1113-1118 行）：`PreToolUse` 的 `hookSpecificOutput.updatedInput`
**整体替换**工具入参（未改字段须一并带上；权限规则与 Bash 自动后台判定按**改写后**输入评估）；
`PermissionRequest` 的 `decision.updatedInput`（仅 `behavior:"allow"`）；`PostToolUse` 的 `updatedToolOutput`
替换工具结果（`updatedMCPToolOutput` 仅限 MCP 工具，已被前者取代）；`UserPromptSubmit` **不能替换提示词**，
只能并列注入 `additionalContext`。

**6.2 通用输出字段与退出码。** **[文档]** [hooks] 第 1005-1016 行：`continue`（false ＝ 立刻停下，优先级高于
一切事件级决策字段）、`stopReason`、`suppressOutput`（**接受但无效果**）、`systemMessage`、`terminalSequence`。
`additionalContext` / `systemMessage` / `initialUserMessage` 与裸 stdout **各限 10,000 字符**，超限则落盘为会话
目录文件、只把路径与至多 2,000 字符预览交给模型（第 993-999 行）。`additionalContext` 被包成 system reminder、
在 hook 触发点插入对话、不进聊天界面（第 1056 行），且**会写入 transcript**；`--continue`/`--resume` 时是**回放**
而非重跑（第 1088 行）。**退出码**（第 916 行）：除 0 和 2 以外的退出码对 command hook 计为失败——**即使它打印了
`{"permissionDecision":"allow"}` 这样的 JSON 也一样**；要返回 JSON 决策就必须 exit 0。

**6.3 SDK 侧 hook。** **[类型]** `Options.hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>`（`sdk.d.ts:1526+`）。
**[源码]** 接法（`query.py:317-338`）：SDK 不给 CLI 可执行命令，而是为每个 matcher 生成 `hookCallbackIds`，把
`{matcher, hookCallbackIds, timeout?}` 放进 `initialize` 的 `hooks` 字段；运行时 CLI 反向发 `hook_callback` 控制请求，
SDK 查表调用本地函数并回 `hookSpecificOutput`（`query.py:643-660`）。Python 的 `HookEvent` 只声明 **10 个**成员
（`types.py:284-295`），**少于 CLI 支持的 33 个**——Python SDK 暴露面落后于 TS 的实证。

## 7. 已验证 / 未验证 总表

**已确证（文档、类型、源码两方或三方一致）**：传输方式与 CLI 参数、帧类型清单、控制协议请求/响应/cancel 形态、
`init` 每轮重发、`session_id` 语义、turn 与 `num_turns` 的区别、权限模式六值、`canUseTool` 签名与 deny 形态、
hook 事件 33 项与逐事件决策能力、深度 3 / 并发 20、CLAUDE.md 加载顺序、缓存三层与 TTL 优先级、
`compact_boundary` 字段、transcript 路径与 JSONL 格式、fork 语义。

**文档未给、只能看到选项名或间接痕迹**：系统提示的**分节清单**；auto-compact 的**默认百分比**；
Agent 工具的**完整参数 schema**；`can_use_tool` 的内部 park deadline。

## 8. 明确**不公开**的部分（教学材料禁止把猜测写成实现）

1. **CLI 内部实现整体**。`claude` 是各平台原生二进制（见 0.2）。以下全部不可读：agent 主循环、工具的具体实现、
   压缩摘要的提示词与算法、token 计数方式、`auto` 模式分类器的提示词与阈值、会话文件的写入代码。
2. **系统提示的完整分节清单**。文档只点名三个「动态段」（working directory、auto-memory、git status）。
   任何「系统提示分为 N 节，依次是……」的说法都没有出处。
3. **auto-compact 的默认百分比**。只公开「窗口」量纲与 `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` 这个只能调低的开关；
   文档的 `967K` 只在 1M 窗口模型语境里出现，**不要当成通用默认值**。
4. **Agent 工具的完整输入 schema**。文档零散提到 `subagent_type`、`prompt`、`run_in_background`、`name`、
   `isolation`，没有权威字段表。`team_name`、`mode` 之类**在本次核验中找不到任何文档或类型证据**，应视为未验证。
5. **会话 JSONL 的行级 schema**。官方只承诺「路径 + `.jsonl`」，读取一律走 SDK 函数。
   不要用「从磁盘文件反推字段」当作规范。
6. **Anthropic API 请求体的精确形态**。能确证的是：Claude Code **会**发送 `cache_control` 标记、请求按三层排序、
   有 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 这个 SDK 侧边界标记。但**标记加在哪些 block 上、加几个、有无第四个断点**，公开材料未定义。
7. **限额的强制点位置**。深度 3 / 并发 20 是文档承诺的行为与可观测错误字符串；它们在二进制里何处检查、
   是否可绕过、内部计数是否原子，均不可知。
8. **子 agent 结果扫描的完整模式集**。文档只列三类模式（控制标签仿冒、权限配置提及、轮次标记），
   并说「those are the only modifications the scan makes」，但**没有发布匹配用的正则或词表**。
9. **`compact_boundary` 中 `preserved_segment` / `preserved_messages` 的生成规则**。类型注释只说明字段语义
   （供 loader 把保留段重新挂回 `anchor_uuid`）与「何时不设」，未说明「保留哪些消息」的选择算法。
10. **版本间的完整行为差异**。文档以「Before v2.1.x」零散标注过变更点，但没有可审计的完整 changelog 对应到二进制行为。

> 来源速查（均为本次实际拉取）。文档 `https://code.claude.com/docs/en/`：`sub-agents`、`agent-sdk/subagents`、
> `agent-sdk/sessions`、`agent-sdk/permissions`、`agent-sdk/streaming-vs-single-mode`、
> `agent-sdk/modifying-system-prompts`、`hooks`、`permissions`、`memory`、`settings`、`tools-reference`、
> `agent-teams`、`workflows`、`commands`、`context-window`、`prompt-caching`、`model-config`、`env-vars`、
> `how-claude-code-works`、`slash-commands`。代码：`@anthropic-ai/claude-agent-sdk@0.3.296` → `package/sdk.d.ts`；
> `@anthropic-ai/claude-code@2.1.296` → `package/{package.json,install.cjs}`；
> `github.com/anthropics/claude-agent-sdk-python` → `src/claude_agent_sdk/_internal/transport/subprocess_cli.py`、
> `_internal/query.py`、`types.py`、`_internal/message_parser.py`；
> `github.com/anthropics/claude-agent-sdk-typescript` → 无 `src/`（见 0.1）。
