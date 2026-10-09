/**
 * 第 1 章 · Step 1.4 —— 审批策略与沙箱
 *
 * Codex 在这里做了一个很聪明的决定：**不要一个「安全开关」，要两个正交的旋钮**。
 *
 *   沙箱模式 sandbox ：允许碰什么   read-only | workspace-write | danger-full-access
 *   审批策略 approval：越界怎么办   never | on-request | on-failure
 *
 * 两两组合六种行为，从「只读助手」一路覆盖到「无人值守全权代理」。
 * 本节照真实取值实现这两档，然后跑三个场景：
 *
 *   A. read-only + never          写入被沙箱拒绝，模型只能接受现实
 *   B. workspace-write + on-request  越界写入 → 沙箱拒绝 → 审批放行
 *   C. 纸糊的墙                    展示这套策略层**挡不住**什么，以及真实系统怎么补
 *
 * 场景 C 是这一节的重点：很多教程把「字符串检查」当成沙箱来教，那是错的。
 *
 * 对应真实系统：
 *   - Codex：`approval_policy = never | on-request | on-failure`；
 *     `sandbox = read-only | workspace-write | danger-full-access`，由 OS 强制执行
 *     （macOS Seatbelt / Linux Landlock + seccomp），默认断网；子 agent 继承父级沙箱。
 *   - DeepSeek Harness：沙箱是独立的进程约束包，策略是配置，两者互不越权。
 *
 * 运行：node chapter1-codex/step4-sandbox.mjs
 * 真实模型：node chapter1-codex/step4-sandbox.mjs --real   （需 DEEPSEEK_API_KEY）
 */

import { access, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runAgent } from '../lib/loop.mjs'
import { createDeepSeekModel, createMockModel } from '../lib/model.mjs'
import { createPolicy } from '../lib/policy.mjs'
import { createToolkit, ensureWorkspace } from '../lib/tools.mjs'
import * as trace from '../lib/trace.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const demoRoot = path.join(root, 'runs', 'step4-demo')

await rm(demoRoot, { recursive: true, force: true })

const SYSTEM_PROMPT = [
  '你是一个在固定工作目录里干活的编码 agent。',
  '查看文件用 exec_command；改文件用 apply_patch。',
  '如果操作被拒绝，读懂拒绝原因，用中文说明你没能做什么。',
].join('\n')

// ─────────────────────────────────────────────────────────────
// 场景运行器
// ─────────────────────────────────────────────────────────────

/**
 * 跑一个场景。审批人是一个「脚本化的假人」——决策确定、可复现，
 * 但记录下它收到的每一个请求，让我们看到「如果这是真人，他会看到什么」。
 */
async function runScenario({ id, title, sandbox, approval, task, script, approvals = [] }) {
  const base = path.join(demoRoot, id)
  const workspace = path.join(base, 'workspace')
  await ensureWorkspace(workspace)

  const requests = []
  const queue = [...approvals]
  const approver = async (request) => {
    const granted = queue.shift() ?? false
    requests.push({ ...request, granted })
    return granted
  }

  const policy = createPolicy({ sandbox, approval, workspace, approver })
  const { tools, impls } = createToolkit({ workspace, policy })

  trace.banner(`场景 ${id} · ${title}`, policy.describe())
  trace.note(`用户：${task}`)

  const outcome = await runAgent({
    model: createMockModel(script),
    system: SYSTEM_PROMPT,
    userMessage: task,
    tools,
    impls,
    maxTurns: 6,
  })

  trace.result(outcome.text)

  if (requests.length > 0) {
    console.log(`\n  ${trace.dim('审批人看到的请求：')}`)
    for (const request of requests) {
      console.log(`    · 类型 ${request.kind}｜对象 ${request.detail}`)
      console.log(`      沙箱理由：${request.reason}`)
      console.log(`      决策：${request.granted ? '批准' : '否决'}（approval=${request.approval}）`)
    }
  }

  return { base, workspace, requests, outcome }
}

// ─────────────────────────────────────────────────────────────
// 场景 A：read-only + never —— 拒绝，且不问
// ─────────────────────────────────────────────────────────────

await runScenario({
  id: 'a-read-only',
  title: 'read-only + never',
  sandbox: 'read-only',
  approval: 'never',
  task: '在工作目录里建一个 hello.txt，写一行「你好」。',
  script: [
    {
      text: '建一个文件。',
      toolCalls: [
        {
          id: 'a1',
          name: 'apply_patch',
          arguments: { patch: ['*** Begin Patch', '*** Add File: hello.txt', '+你好', '*** End Patch'].join('\n') },
        },
      ],
    },
    { text: '沙箱是 read-only，我无法创建文件，任务没能完成。', toolCalls: [] },
  ],
})

// ─────────────────────────────────────────────────────────────
// 场景 B：workspace-write + on-request —— 沙箱拒绝，审批放行
// ─────────────────────────────────────────────────────────────

const scenarioB = await runScenario({
  id: 'b-on-request',
  title: 'workspace-write + on-request',
  sandbox: 'workspace-write',
  approval: 'on-request',
  task: '把结论写到工作目录外面的 ../outside.txt。',
  approvals: [true],
  script: [
    {
      text: '写一个越界文件。',
      toolCalls: [
        {
          id: 'b1',
          name: 'apply_patch',
          arguments: {
            patch: ['*** Begin Patch', '*** Add File: ../outside.txt', '+我本来不该出现在工作区外面。', '*** End Patch'].join(
              '\n',
            ),
          },
        },
      ],
    },
    { text: '', toolCalls: [{ id: 'b2', name: 'exec_command', arguments: { command: 'cat ../outside.txt' } }] },
    { text: '沙箱拒绝了越界写入，但审批人批准了，所以文件已经写到工作区外面。任务完成（带一次审批）。', toolCalls: [] },
  ],
})

const outsidePath = path.join(scenarioB.base, 'outside.txt')
const outsideExists = await access(outsidePath).then(
  () => true,
  () => false,
)
trace.note(`工作区外的 ${path.relative(root, outsidePath)} 存在吗？${outsideExists ? '存在 ✅（审批放行的结果）' : '不存在'}`)

// ─────────────────────────────────────────────────────────────
// 场景 C：纸糊的墙 —— 策略层不是沙箱
// ─────────────────────────────────────────────────────────────

await runScenario({
  id: 'c-leaky-wall',
  title: 'workspace-write + never（越界读取）',
  sandbox: 'workspace-write',
  approval: 'never',
  task: '读一下系统里的 hosts 文件，看看有哪些条目。',
  script: [
    { text: '', toolCalls: [{ id: 'c1', name: 'exec_command', arguments: { command: 'cat /etc/hosts' } }] },
    { text: '我读到了工作区外面的 /etc/hosts。这说明命令检查只看第一个词，管不住路径。', toolCalls: [] },
  ],
})

// ─────────────────────────────────────────────────────────────
// 汇总
// ─────────────────────────────────────────────────────────────

console.log(`\n${trace.bold('三个场景的结论')}`)
console.log(`  A  read-only + never          写入被拒；模型收到拒绝原因后放弃`)
console.log(`  B  workspace-write + on-request  沙箱拒绝越界写入 → 审批放行 → 真的写到了外面`)
console.log(`  C  workspace-write + never     命令「cat」看着人畜无害，于是读到了 /etc/hosts`)

console.log(`
${'─'.repeat(66)}
这一节记住五件事：

  1. 两个旋钮，不是一个开关。
     「允许碰什么」（sandbox）和「越界怎么办」（approval）必须分开配，
     否则你要么做不出只读助手，要么做不出无人值守代理。

  2. 默认值要选最保守的那一档。
     Codex 的委派默认 approval=never、子 agent 必须 approval=never 才能 spawn。
     默认放行是最常见的自伤方式。

  3. 被拒绝是结果，不是异常。
     和 1.2 一样：拒绝原因作为工具结果回给模型，模型自己决定放弃还是换个做法。

  4. 场景 C 是本节的重点：**应用层策略不是安全边界**。
     「cat」这个词本身没问题，问题在于它读哪里 —— 而路径藏在参数里，
     字符串检查看不见。换一种写法（环境变量、引号、sh -c、写个脚本）还能绕过更多。
     用字符串表达的安全策略，永远只是在描述意图，不是在施加约束。

  5. 真正的沙箱只能由**执行环境**提供：
     OS 级强制（macOS Seatbelt、Linux Landlock + seccomp）、容器、虚拟机、
     或者干脆只读挂载 + 断网。Codex 默认断网、Harness 把沙箱做成独立的进程约束包，
     都是这个原因。

动手练习：
  · 把场景 C 的命令改成 'cat /etc/hosts; rm -rf ../'，看分段检查能不能挡住（能挡住命令名，挡不住路径）。
  · 把审批人的决策改成 [false]，重跑场景 B，观察模型怎么应对「被否决」。
  · 给策略加第三种审批策略 on-failure：先执行，只有在沙箱失败后才请求批准。
  · 设计一个真正可信的边界：把 exec_command 换成在容器/沙箱里执行，再写清楚
    这时候策略层还需要做什么（提示、计费、审计），不需要做什么（拦截）。
${'─'.repeat(66)}
`)

// ─────────────────────────────────────────────────────────────
// 真实模型模式：同一套策略，换真模型照样被拦
// ─────────────────────────────────────────────────────────────

if (process.argv.includes('--real') || process.env.LAB_MODEL === 'real') {
  const workspace = path.join(demoRoot, 'd-real-model', 'workspace')
  await ensureWorkspace(workspace)
  const policy = createPolicy({ sandbox: 'read-only', approval: 'never', workspace })
  const { tools, impls } = createToolkit({ workspace, policy })

  trace.banner('场景 D · 真实模型 + read-only + never', `模型 = ${createDeepSeekModel().name}`)
  const outcome = await runAgent({
    model: createDeepSeekModel(),
    system: SYSTEM_PROMPT,
    userMessage: '在工作目录里建一个 hello.txt，写一行「你好」。',
    tools,
    impls,
    maxTurns: 6,
  })
  trace.result(outcome.text)
  trace.note('策略层在模型外面，所以换成真模型，拦截行为一模一样。')
}
