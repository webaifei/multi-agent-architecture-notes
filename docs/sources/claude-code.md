# 资料来源 · Claude Code

置信度标记：**[官方]** = 官方文档已核对，**[待核]** = 未验证。

> 官方文档主站已从 `docs.claude.com/en/docs/claude-code/` 迁到 **code.claude.com**；Agent SDK 文档在 `code.claude.com/docs/en/agent-sdk/`。下面链接均指向现址。

## 1. 子 agent 是「声明式文件」，不是代码

**[官方]** [sub-agents](https://code.claude.com/docs/en/sub-agents)

- 一个子 agent = 一个 **Markdown + YAML frontmatter** 文件，正文就是它的系统提示词；
- 只有 `name` 和 `description` 必填；其余字段包括 `tools`、`disallowedTools`、`model`、`permissionMode`、`maxTurns`、`skills`、`mcpServers`、`hooks`、`memory`、`background`、`omitClaudeMd`、`isolation`、`color`、`initialPrompt` 等；
- **未知字段被静默忽略**，不报错——这是新手最容易「写了没生效」的地方；
- 发现顺序（高 → 低）：managed settings → `--agents` CLI JSON → 项目 `.claude/agents/` → 用户 `~/.claude/agents/` → 插件 `agents/`；项目级从 cwd 向上找，**最近的赢**。

**教学含义**：Claude Code 把「角色」做成了**数据**。加一个 agent 不需要改一行代码，这是它和 Codex（进程/协议）最直观的分野。

## 2. 调用它的工具叫 `Agent`（旧名 `Task`）

**[官方]** [sub-agents](https://code.claude.com/docs/en/sub-agents) · [agent-sdk/subagents](https://code.claude.com/docs/en/agent-sdk/subagents) · [TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript)

- v2.1.63 起 `Task` 更名为 `Agent`，但 `Task(...)` 仍可作别名；
- 有个坑：**`tool_use` 块里叫 `Agent`，而 system:init 的工具清单里仍显示 `Task`**；
- 输入字段：`description`、`prompt`、`subagent_type`、`model`、`effort`、`run_in_background`、`name`、`isolation`；
- `team_name`、`mode` 已废弃并被忽略；
- **没有 `resume` 字段**。要接着说话，用 `SendMessage` 工具按 agent id/name 发消息；
- 省略 `subagent_type` 时回退到 `general-purpose`。

## 3. 上下文默认「全新」，只回传最终消息

**[官方]** [sub-agents](https://code.claude.com/docs/en/sub-agents)

- 子 agent 拿到的是**全新上下文窗口**：自己的系统提示词 + 环境信息、Task 的 prompt、CLAUDE.md 层级、git 状态快照、预加载的 skills、以及一份「同级 agent 名册」；
- **拿不到**：父级的对话历史、父级系统提示词、output style、auto-memory；
- 例外：`fork` 类与 Explore/Plan（跳过 CLAUDE.md 与 git 状态）；
- 结果回流：「中间的工具调用与结果留在子 agent 内部，**只有最终消息**回到父级」；
- 后台执行的结果，会在**之后的某一轮**以完成通知的形式到达。

**教学含义**：这就是「用上下文隔离换成本」的标准答案。第 2.2 节会实现同一件事：**父级只收到一个字符串**。

## 4. 并行与上限

**[官方]** [sub-agents](https://code.claude.com/docs/en/sub-agents) · [tools reference](https://code.claude.com/docs/en/tools-reference)

- 子 agent 可并发；`run_in_background` 是真实存在的入参，agent 定义里的 `background: true` 会强制它；
- 嵌套深度默认 **3**（`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`）；
- 并发默认 **20**（`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`）；
- `TaskCreate` / `TaskGet` / `TaskList` / `TaskUpdate` 是**任务清单**，不是创建 agent 的机制。

## 5. 编排模式与 hooks

**[官方]** [sub-agents](https://code.claude.com/docs/en/sub-agents) · [hooks](https://code.claude.com/docs/en/hooks)

- 官方明确点名三种模式：**主管-工人**（主 agent 委派后汇总）、**并行研究**（同时开多个子 agent）、**链式**（子 agent 顺序接力）；
- Plan mode 用的是内置的只读 `Plan` 子 agent；
- hooks：`SubagentStart` / `SubagentStop` 事件（matcher 是 agent 类型），以及子 agent 内部会触发的 `PreToolUse` / `PostToolUse`（带 `agent_id`、`agent_type`）。

## 6. 两个「进阶但真实存在」的机制

- **[官方]** **Agent teams**（[agent-teams](https://code.claude.com/docs/en/agent-teams)）：实验特性，默认关闭（`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`）。Lead + 独立 teammate 会话 + 共享任务清单 + 每个 agent 的 mailbox JSON（`~/.claude/teams/{team}/inboxes/{agent}.json`）+ `SendMessage`。限制：不能嵌套团队、只有 lead 能创建成员。
- **[官方]** **Workflow 工具**（[workflows](https://code.claude.com/docs/en/workflows)）：跑一段 JS 编排脚本，提供 `agent()` / `pipeline()` / `parallel()` / `phase()` / `log()`，单次上限 1000 个 agent、默认 16 并发。——这和 DeepSeek Harness 的 `workflow` 工具几乎是同一个设计。

## 待核实

- [ ] Explore 子 agent 的「200k 上下文」说法：**文档未提**，不要写进正文；
- [ ] `Agent` 工具上并不存在 `resume` 字段（以已发布的 `AgentInput` 为准）；
- [ ] 官方仓库里找不到公开的 `.claude/agents/` 示例目录（404）；可核对的示例在
      [claude-agent-sdk-python/examples](https://github.com/anthropics/claude-agent-sdk-python/tree/main/examples)。
