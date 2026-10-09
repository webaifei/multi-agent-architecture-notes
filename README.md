# multi-agent-lab

> 深入浅出：分别实现 **Codex**、**Claude Code**、**DeepSeek Harness** 三套多 agent 架构。
>
> 零依赖、纯 Node.js（`.mjs`），默认用确定性 Mock 模型，设了 `DEEPSEEK_API_KEY` 就能切真实模型。

## 这个仓库想解决什么问题

大部分人学「多 agent」，一上来就抄框架，结果：

- 不知道**为什么**要多个 agent，单 agent 到底卡在哪；
- 分不清**框架功能**和**架构模式**，把 orchestrator 当成某个库的 API；
- 看了三套系统，只觉得「好像都能跑」，说不出它们的**根本差别**。

所以这里换一条路：**三家各实现一遍，从最小可运行版本往上加**。
每一章都遵循同一个骨架：

```
先跑起来一个能跑的最小版本  →  再补上一个真实系统里存在的机制  →  对照真实源码
```

## 三章讲什么

三套系统的差别，不在「有没有子 agent」，而在下面四个问题的答案：

| 问题 | 一句话解释 |
| --- | --- |
| **拓扑**：谁创建谁？ | 主管-工人？流水线？还是对等团队？ |
| **隔离**：子 agent 能看到什么？ | 全新上下文、继承历史，还是共享上下文？ |
| **通信**：怎么交换信息？ | 一次性返回值？可续对话？持久消息？共享黑板？ |
| **收敛**：谁来拍板结束？ | 主管聚合？多数投票？任务板完成？预算耗尽？ |

| 章节 | 对应真实系统 | 它的核心答案 |
| --- | --- | --- |
| 第 1 章 | **Codex**（OpenAI Codex CLI / codex-rs） | agent 是**进程**；子 agent 靠子进程 + 协议，工具层最重（exec / apply_patch / 沙箱 / 审批） |
| 第 2 章 | **Claude Code**（Anthropic） | 子 agent 是**声明的 Markdown 文件**，主 agent 通过 `Task` 工具调用，上下文默认隔离，只回传最终消息 |
| 第 3 章 | **DeepSeek Harness**（本仓库所在项目） | 子 agent 是**能力接缝**（Service/Provider/Consumer）；团队有共享任务板、持久消息、写范围，可跨进程 |

> 一个有意思的事实：DeepSeek Harness 自己就内置了 `subagent-codex` 和 `subagent-claude-code` 两个包——它把前两者当成「外挂后端」。第 3 章会读这些源码。

## 目录结构

```
multi-agent-lab/
├── README.md              # 你在这里
├── docs/                  # 讲解文档（概念、每章笔记、最终对比）
├── lib/                   # 三层公共设施：模型适配、trace 输出、后续还会加会话日志
└── chapter1-codex/        # 第 1 章的可运行步骤，一个 step 一个文件
```

## 进度

### 第 0 章 · 概念

- [x] `docs/00-concepts.md`：agent / loop / context / tool / 四个核心问题

### 第 1 章 · Codex 式（进程 + 工具优先）

- [x] **1.1 最小 agent loop**：`chapter1-codex/step1-agent-loop.mjs`
- [ ] 1.2 工具层：`exec_command` + `apply_patch` + 结果截断
- [ ] 1.3 会话落盘（rollout JSONL）与 resume
- [ ] 1.4 审批策略与沙箱（approval policy / sandbox policy）
- [ ] 1.5 子 agent：把「一个 Codex 进程」当成一次工具调用
- [ ] 1.6 并行子 agent 与结果聚合

### 第 2 章 · Claude Code 式（声明式子 agent）

- [ ] 2.1 用 Markdown + frontmatter 定义一个 subagent
- [ ] 2.2 `Task` 工具：隔离上下文，只回传最终消息
- [ ] 2.3 并行 Task 与后台任务
- [ ] 2.4 工具白名单与 hooks
- [ ] 2.5 三种编排模式：主管-工人 / 流水线 / 对抗验证

### 第 3 章 · DeepSeek Harness 式（持久团队）

- [ ] 3.1 能力接缝：Service Definition / Provider / Consumer
- [ ] 3.2 三种子 agent 后端：spawn / fork / 跨进程
- [ ] 3.3 邻近 agent 的消息、中断、列举
- [ ] 3.4 共享任务板：认领、依赖、写范围
- [ ] 3.5 workflow：模型自己写编排脚本做 fan-out
- [ ] 3.6 合体：一个 mini Agent Teams

### 第 4 章 · 对比

- [ ] `docs/99-comparison.md`：一张表说清三家取舍

## 怎么跑

需要 Node.js 20+（本机 v25 可用），**不需要装任何依赖**。

```sh
node chapter1-codex/step1-agent-loop.mjs           # 默认：确定性 Mock 模型
node chapter1-codex/step1-agent-loop.mjs --real    # 真实模型，需 DEEPSEEK_API_KEY
```

真实模型模式会读取根目录或环境变量：

```sh
export DEEPSEEK_API_KEY=sk-...
export DEEPSEEK_BASE_URL=https://api.deepseek.com   # 可选
```

## 每一节怎么用

每个 step 文件都是**自包含**的，建议按这个顺序读：

1. 先看文件顶部注释：这一节要解决什么问题；
2. 直接 `node` 跑一次，看输出的 trace；
3. 再读代码，把注释里的「真实系统对应物」和输出对上；
4. 做文末的**动手练习**（改一行、看变化）。

`docs/` 里每一章会有一篇更长的讲解，写清楚「为什么这么设计」和「真实源码长什么样」。
