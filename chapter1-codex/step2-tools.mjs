/**
 * 第 1 章 · Step 1.2 —— 工具层加固
 *
 * 1.1 里那个 exec_command 是个玩具。这一节把它做成 Codex 那个样子：
 *
 *   ① 统一的工具形态：schema（给模型看）+ 实现（真干活）+ 结果规范化（喂回模型）
 *   ② 两个真正的工具：`exec_command` 和 `apply_patch`
 *   ③ 输出截断：一次 `cat` 大文件就能冲爆上下文，必须头尾保留式截断
 *   ④ 最重要的一条：**工具失败是正常输入，不是异常**
 *
 * 关于 ④，这一节的 mock 剧本里故意安排了一次「补丁写错 → 模型自己改对」，
 * 你会看到 agent 不靠异常处理也能自愈。
 *
 * 对应真实系统：
 *   - Codex 的工具清单：`exec_command`、`write_stdin`（持久 shell 会话）、
 *     `apply_patch`（**FREEFORM** 工具，有独立 Lark 文法，官方明确说不要用 JSON 包）、
 *     `request_permissions`、`view_image`
 *     —— 见 `codex-rs/core/src/tools/handlers/`；
 *   - 补丁文法：`*** Begin Patch` / `*** Add File:` / `*** Update File:` / `@@` / `+` / `-` / `*** End Patch`；
 *   - 会话落盘（rollout JSONL）留到 1.3，审批与沙箱留到 1.4。
 *
 * 运行：node chapter1-codex/step2-tools.mjs
 * 真实模型：node chapter1-codex/step2-tools.mjs --real   （需 DEEPSEEK_API_KEY）
 */

import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runAgent } from '../lib/loop.mjs'
import { pickModel } from '../lib/model.mjs'
import { createToolkit, ensureWorkspace, truncate } from '../lib/tools.mjs'
import * as trace from '../lib/trace.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const workspace = path.join(here, '..', 'runs', 'step2-demo')

// ─────────────────────────────────────────────────────────────
// 工作区：每次运行都清空重来，保证 Mock 剧本与结果一一对应
// ─────────────────────────────────────────────────────────────

await rm(workspace, { recursive: true, force: true })
await ensureWorkspace(workspace)

const SYSTEM_PROMPT = [
  '你是一个在固定工作目录里干活的编码 agent。',
  '查看文件用 exec_command；改文件一律用 apply_patch，不要用重定向或 echo 覆盖。',
  '工具返回错误时，读懂错误信息再修正你的下一次调用。',
  '任务完成后用中文给出一句话结论，不要再调用工具。',
].join('\n')

const { tools, impls } = createToolkit({ workspace })

// ─────────────────────────────────────────────────────────────
// Mock 剧本：模型会怎么回答
// ─────────────────────────────────────────────────────────────

const addFilePatch = [
  '*** Begin Patch',
  '*** Add File: hello.txt',
  '+第一行：你好，多 agent。',
  '+第二行：这一行待会儿会被改掉。',
  '*** End Patch',
].join('\n')

// 注意：这一条**故意写错**（上下文对不上），用来演示工具失败如何被模型消化。
const wrongUpdatePatch = [
  '*** Begin Patch',
  '*** Update File: hello.txt',
  '@@',
  ' 这一行在文件里根本不存在',
  '-第二行：这一行待会儿会被改掉。',
  '+第二行：改好了。',
  '*** End Patch',
].join('\n')

const correctUpdatePatch = [
  '*** Begin Patch',
  '*** Update File: hello.txt',
  '@@',
  ' 第一行：你好，多 agent。',
  '-第二行：这一行待会儿会被改掉。',
  '+第二行：已被 apply_patch 改写。',
  '+第三行：这是新加的一行。',
  '*** End Patch',
].join('\n')

const mockScript = [
  {
    text: '先建一个文件。',
    toolCalls: [{ id: 'call_1', name: 'apply_patch', arguments: { patch: addFilePatch } }],
  },
  {
    text: '看看现在的内容。',
    toolCalls: [{ id: 'call_2', name: 'exec_command', arguments: { command: 'cat hello.txt' } }],
  },
  {
    text: '改掉第二行。',
    toolCalls: [{ id: 'call_3', name: 'apply_patch', arguments: { patch: wrongUpdatePatch } }],
  },
  {
    // 模型看到「找不到匹配的上下文」后，重新写了一份正确的补丁。
    text: '上下文写错了，我按文件真实内容再改一次。',
    toolCalls: [{ id: 'call_4', name: 'apply_patch', arguments: { patch: correctUpdatePatch } }],
  },
  {
    text: '',
    toolCalls: [{ id: 'call_5', name: 'exec_command', arguments: { command: 'cat hello.txt && wc -l hello.txt' } }],
  },
  {
    text: '已创建工作区的 hello.txt 并把第二行改写、新增了第三行，共 3 行。任务完成。',
    toolCalls: [],
  },
]

// ─────────────────────────────────────────────────────────────
// 跑起来
// ─────────────────────────────────────────────────────────────

const model = pickModel(mockScript)

trace.banner('第 1 章 · Step 1.2  工具层加固', `模型 = ${model.name}`)
trace.note(`工作目录：${path.relative(path.join(here, '..'), workspace)}`)
trace.note('用户：帮我建个 hello.txt，先写两行，再把第二行改掉并加一行。')

const outcome = await runAgent({
  model,
  system: SYSTEM_PROMPT,
  userMessage: '帮我建个 hello.txt，先写两行，再把第二行改掉并加一行。',
  tools,
  impls,
  maxTurns: 8,
})

trace.result(outcome.text)

// Node 侧直接读文件，证明补丁真的落盘了 —— 不要只信模型的自我报告。
const finalContent = await readFile(path.join(workspace, 'hello.txt'), 'utf8')
console.log(`\n${trace.bold('磁盘上的真实内容')}`)
console.log(finalContent.replace(/^/gm, '  │ '))

// ─────────────────────────────────────────────────────────────
// 小实验：输出截断
// ─────────────────────────────────────────────────────────────

const noisy = Array.from({ length: 200 }, (_, i) => `line ${i + 1}: ${'x'.repeat(30)}`).join('\n')
console.log(`\n${trace.bold('输出截断演示')}  原始 ${noisy.length} 字符 → 截断到 300 字符`)
console.log(truncate(noisy, 300))
console.log('')

console.log(`${'─'.repeat(66)}
这一节记住四件事：

  1. 工具 = 说明书(schema) + 实现 + 结果规范化。三样都要有。
     只写实现，模型不知道该调什么；只写 schema，没人干活。

  2. 工具失败要变成「文本」回给模型，不要 throw。
     剧本里第 3 步故意写错补丁，模型靠错误信息自己改对了 —— 这就是自愈。
     真实 Codex 把「被拒绝(declined)」「非零退出码」「超时」都归到这一类。

  3. apply_patch 用 FREEFORM 文本，不用 JSON。
     因为补丁本质是「带格式的文本」，塞进 JSON 字符串要转义一堆换行，
     模型写起来更容易错。真实 Codex 为它单独定义了 Lark 文法。

  4. 输出必须截断，而且头尾都要留。
     头是命令回显和错误头，尾是最终结果；中间的过程通常最不重要。

动手练习：
  · 把 truncate 的 0.7 改成 0.2，观察尾部保留更多时的效果。
  · 给 apply_patch 加一个「*** Move to:」支持（真实 Codex 有）。
  · 去掉 exec_command 的非零退出码分支，让 error 直接抛出，看循环会怎样崩。
  · 把 SAFE_COMMAND 换成「只允许在 workspace 内读文件」，体会白名单和沙箱的差别。
${'─'.repeat(66)}
`)
