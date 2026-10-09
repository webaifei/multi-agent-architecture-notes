/**
 * tools.mjs — 工具层：`exec_command`、`apply_patch`、以及输出截断。
 *
 * 一个工具在实现上有三部分，缺一不可：
 *
 *   ① schema —— 给模型看的说明书（名字、用途、参数 JSON Schema）
 *   ② 实现   —— 真正产生副作用的那段代码
 *   ③ 结果规范化 —— 把「成功/失败/被拒/超时/输出太大」都变成一段**能喂回模型的文本**
 *
 * 第 ③ 点最容易被忽略：新手常把工具写成「出错就 throw」。但在 agent 里，
 * 工具失败是**正常输入**——模型需要看到错误才能自己纠正。所以这里所有工具都不抛异常，
 * 而是返回一段描述性文本。
 *
 * 对应真实系统：
 *   - Codex：`exec_command`、`write_stdin`（持久 shell）、`apply_patch`（FREEFORM 工具，
 *     有自己的 Lark 文法，官方明确说「不要用 JSON 包起来」）、`request_permissions`、`view_image`；
 *     见 codex-rs/core/src/tools/handlers/*。
 *   - 输出截断：所有真实系统都做，因为一次 `cat` 大文件就能把上下文冲爆。
 */

import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { createPolicy, escalate } from './policy.mjs'

const run = promisify(execFile)

/** 单个工具结果回填给模型的上限（字符）。 */
export const MAX_TOOL_OUTPUT = 4000

/** 命令执行超时（毫秒）。真实系统会把超时也当成一次可重试的失败。 */
const COMMAND_TIMEOUT_MS = 10_000

// ─────────────────────────────────────────────────────────────
// 输出截断
// ─────────────────────────────────────────────────────────────

/**
 * 头尾保留式截断。
 *
 * 为什么不是「只留前 N 个字符」？因为工具输出里最有价值的是**开头**（命令回显、错误头）
 * 和**结尾**（最终结果、退出状态），中间过程通常可以丢。
 *
 * @param {string} text 原始输出
 * @param {number} [maxChars] 保留的最大字符数
 * @returns {string} 截断后的文本，带省略标记
 */
export function truncate(text, maxChars = MAX_TOOL_OUTPUT) {
  const value = String(text)
  if (value.length <= maxChars) return value

  const headSize = Math.floor(maxChars * 0.7)
  const tailSize = maxChars - headSize
  const omitted = value.length - headSize - tailSize
  return `${value.slice(0, headSize)}\n\n... [已截断 ${omitted} 个字符] ...\n\n${value.slice(-tailSize)}`
}

// ─────────────────────────────────────────────────────────────
// apply_patch：解析与执行
// ─────────────────────────────────────────────────────────────

/** 补丁格式错误（可被模型修正，所以不抛出到循环外）。 */
class PatchError extends Error {}

/**
 * 解析教学子集的补丁格式。真实 Codex 用的是同一套 `*** Begin Patch` 文法。
 *
 * 支持：
 *   *** Add File: <path>        后面每行以 `+` 开头
 *   *** Update File: <path>     `@@` 分段，hunk 内 ` `=上下文 `-`=删除 `+`=新增
 *   *** Delete File: <path>
 *
 * @param {string} text 补丁原文
 * @returns {Array<object>} 操作列表
 */
export function parsePatch(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n')
  if (lines[0]?.trim() !== '*** Begin Patch') {
    throw new PatchError('补丁必须以 `*** Begin Patch` 开头')
  }
  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === '*** End Patch')
  if (endIndex === -1) throw new PatchError('补丁缺少 `*** End Patch`')

  const ops = []
  let cursor = 1

  while (cursor < endIndex) {
    const header = lines[cursor].trim()
    if (header === '') {
      cursor += 1
      continue
    }

    const add = /^\*\*\* Add File: (.+)$/.exec(header)
    const update = /^\*\*\* Update File: (.+)$/.exec(header)
    const del = /^\*\*\* Delete File: (.+)$/.exec(header)
    const op = add ? 'add' : update ? 'update' : del ? 'delete' : null
    if (!op) throw new PatchError(`无法识别的段落标题：${header}`)

    cursor += 1
    const body = []
    while (cursor < endIndex && !lines[cursor].trim().startsWith('*** ')) {
      body.push(lines[cursor])
      cursor += 1
    }
    const target = (add ?? update ?? del)[1].trim()

    if (op === 'add') {
      const bad = body.find((line) => line !== '' && !line.startsWith('+'))
      if (bad !== undefined) throw new PatchError(`Add File 的每行都要以 + 开头，遇到：${bad}`)
      ops.push({ type: 'add', path: target, lines: body.filter((l) => l.startsWith('+')).map((l) => l.slice(1)) })
    } else if (op === 'delete') {
      ops.push({ type: 'delete', path: target })
    } else {
      ops.push({ type: 'update', path: target, hunks: parseHunks(body) })
    }
  }

  if (ops.length === 0) throw new PatchError('补丁里没有任何文件操作')
  return ops
}

/** 把 Update File 的正文切成若干 hunk。 */
function parseHunks(body) {
  const trimmed = [...body]
  while (trimmed.length > 0 && trimmed[trimmed.length - 1].trim() === '') trimmed.pop()

  const hunks = []
  let current = null
  for (const line of trimmed) {
    if (line.startsWith('@@')) {
      current = []
      hunks.push(current)
      continue
    }
    if (current === null) {
      if (line.trim() === '') continue
      throw new PatchError('Update File 的内容必须放在 @@ 分段里')
    }
    if (line === '') current.push({ type: 'context', text: '' })
    else if (line.startsWith('+')) current.push({ type: 'add', text: line.slice(1) })
    else if (line.startsWith('-')) current.push({ type: 'remove', text: line.slice(1) })
    else if (line.startsWith(' ')) current.push({ type: 'context', text: line.slice(1) })
    else throw new PatchError(`补丁行必须以 空格/+/- 开头，遇到：${line}`)
  }
  if (hunks.length === 0) throw new PatchError('Update File 里没有任何 @@ 分段')
  return hunks
}

/**
 * 执行补丁。任何可预期的失败都返回文本，交给模型自己修。
 *
 * 1.4 起每个文件操作都要先过策略：沙箱挡下来之后，由审批策略决定是直接拒绝
 * 还是去问审批人。被拒绝是**结果**，不是异常。
 *
 * @param {{ workspace: string, patch: string, policy: object }} input
 * @returns {Promise<string>} 给模型看的结果
 */
export async function applyPatch({ workspace, patch, policy }) {
  let ops
  try {
    ops = parsePatch(patch)
  } catch (error) {
    if (error instanceof PatchError) return `补丁解析失败：${error.message}`
    throw error
  }

  const done = []
  const refused = []
  try {
    for (const op of ops) {
      const target = resolvePath(workspace, op.path)

      // ① 沙箱先表态：允许 / 拒绝 + 原因
      const guard = policy.guardWrite(target)
      let note = ''
      if (guard) {
        // ② 沙箱拒绝后，审批策略决定下一步
        const decision = await escalate(policy, { kind: 'write', detail: op.path, reason: guard.reason })
        if (!decision.allowed) {
          refused.push(`${op.path}（${guard.reason}；${decision.how}）`)
          continue
        }
        note = `（沙箱拒绝，但审批放行：${decision.how}）`
      }

      if (op.type === 'add') {
        await writeFile(target, `${op.lines.join('\n')}\n`, 'utf8')
        done.push(`新增 ${op.path}${note}`)
        continue
      }

      if (op.type === 'delete') {
        await rm(target, { force: true })
        done.push(`删除 ${op.path}${note}`)
        continue
      }

      const raw = await readFile(target, 'utf8')
      const hadTrailingNewline = raw.endsWith('\n')
      const fileLines = raw.split('\n')
      if (hadTrailingNewline) fileLines.pop()

      const next = applyHunks(fileLines, op.hunks, op.path)
      await writeFile(target, next.join('\n') + (hadTrailingNewline ? '\n' : ''), 'utf8')
      done.push(`修改 ${op.path}${note}`)
    }
  } catch (error) {
    if (error instanceof PatchError) return `补丁应用失败（已应用的部分保留）：${error.message}`
    if (error.code === 'ENOENT') return `补丁应用失败：文件不存在 —— ${error.path}`
    throw error
  }

  const parts = []
  if (done.length > 0) parts.push(`补丁应用成功：${done.join('，')}`)
  if (refused.length > 0) parts.push(`被拒绝的操作：${refused.join('，')}`)
  return parts.length > 0 ? parts.join('\n') : '补丁里没有任何操作'
}

/** 按 hunk 逐个改文件：每一段的「上下文 + 删除行」必须在文件里精确匹配到。 */
function applyHunks(fileLines, hunks, filePath) {
  let lines = [...fileLines]
  let searchFrom = 0

  for (const hunk of hunks) {
    const oldSequence = hunk.filter((l) => l.type !== 'add').map((l) => l.text)
    const newSequence = hunk.filter((l) => l.type !== 'remove').map((l) => l.text)

    const at = indexOfSequence(lines, oldSequence, searchFrom)
    if (at === -1) {
      const preview = oldSequence.slice(0, 3).join(' / ') || '(空上下文)'
      throw new PatchError(`在 ${filePath} 里找不到匹配的上下文：${preview}`)
    }
    lines = [...lines.slice(0, at), ...newSequence, ...lines.slice(at + oldSequence.length)]
    searchFrom = at + newSequence.length
  }
  return lines
}

/** 在 lines 中从 from 开始找 needle 的精确位置；needle 为空时返回 from。 */
function indexOfSequence(lines, needle, from) {
  if (needle.length === 0) return Math.min(from, lines.length)
  for (let i = from; i <= lines.length - needle.length; i += 1) {
    let matched = true
    for (let j = 0; j < needle.length; j += 1) {
      if (lines[i + j] !== needle[j]) {
        matched = false
        break
      }
    }
    if (matched) return i
  }
  return -1
}

/**
 * 把相对路径解析成绝对路径。
 *
 * 注意：这里**不做**越界拦截 —— 「能不能写」是策略（policy）的判断，
 * 不是路径工具的职责。分开之后，审批放行时才能合法地写到工作区外面。
 *
 * @param {string} workspace
 * @param {string} relativePath
 * @returns {string}
 */
function resolvePath(workspace, relativePath) {
  return path.resolve(workspace, relativePath)
}

// ─────────────────────────────────────────────────────────────
// exec_command
// ─────────────────────────────────────────────────────────────

/**
 * 执行一条 shell 命令，返回规范化文本。
 *
 * 命令先过策略：沙箱拒绝后由审批策略决定是直接拒绝还是问审批人。
 *
 * ⚠️ 这里的检查只看命令的**第一个词**，挡不住路径越界 —— 见 policy.mjs 的警告。
 *
 * @param {{ workspace: string, command: string, policy: object }} input
 * @returns {Promise<string>}
 */
export async function execCommand({ workspace, command, policy }) {
  if (typeof command !== 'string' || !command.trim()) {
    return '工具调用失败：command 必须是非空字符串'
  }

  const guard = policy.guardCommand(command)
  if (guard) {
    const decision = await escalate(policy, { kind: 'command', detail: command, reason: guard.reason })
    if (!decision.allowed) {
      return `命令被拒绝：${guard.reason}（${decision.how}）`
    }
  }

  try {
    const { stdout, stderr } = await run('/bin/sh', ['-c', command], {
      cwd: workspace,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    })
    return formatCommandResult({ exitCode: 0, stdout, stderr })
  } catch (error) {
    if (error.killed && error.signal) {
      return `命令超时（超过 ${COMMAND_TIMEOUT_MS}ms 被终止）：${command}`
    }
    // 非零退出码不是异常，是结果。模型需要看到 stderr 才能纠正。
    if (typeof error.code === 'number' || typeof error.code === 'string') {
      return formatCommandResult({ exitCode: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' })
    }
    return `命令执行失败：${error.message}`
  }
}

/** 把命令结果拼成统一文本，方便模型阅读，也方便我们截断。 */
function formatCommandResult({ exitCode, stdout, stderr }) {
  const parts = [`[exit ${exitCode}]`]
  if (stdout.trim()) parts.push(stdout.trim())
  if (stderr.trim()) parts.push(`[stderr]\n${stderr.trim()}`)
  if (parts.length === 1) parts.push('(无输出)')
  return truncate(parts.join('\n'))
}

// ─────────────────────────────────────────────────────────────
// read_file / search：两个**只读**工具
// ─────────────────────────────────────────────────────────────

/**
 * 读取工作区内的一个文本文件。
 *
 * 这是「只读工具」的样板：没有副作用，不需要审批，但输出照样要截断。
 * 对应 Claude Code 的 `Read`。
 *
 * @param {{ workspace: string, filePath: string }} input
 * @returns {Promise<string>}
 */
export async function readFileTool({ workspace, filePath }) {
  if (typeof filePath !== 'string' || !filePath.trim()) return '工具调用失败：filePath 必须是非空字符串'
  try {
    const content = await readFile(resolvePath(workspace, filePath), 'utf8')
    return truncate(content) || '(文件为空)'
  } catch (error) {
    if (error.code === 'ENOENT') return `读取失败：文件不存在 —— ${filePath}`
    if (error.code === 'EISDIR') return `读取失败：${filePath} 是目录，请用 search`
    throw error
  }
}

/**
 * 在工作区内按正则搜索文件内容。
 *
 * 对应 Claude Code 的 `Grep` / `Glob`：**只能看，不能改**。
 *
 * @param {{ workspace: string, pattern: string, maxResults?: number }} input
 * @returns {Promise<string>}
 */
export async function searchTool({ workspace, pattern, maxResults = 40 }) {
  if (typeof pattern !== 'string' || !pattern.trim()) return '工具调用失败：pattern 必须是非空字符串'
  let regex
  try {
    regex = new RegExp(pattern, 'i')
  } catch (error) {
    return `正则表达式无效：${error.message}`
  }

  const hits = []
  const skip = new Set(['node_modules', '.git', 'runs', 'sessions'])
  const walk = async (dir) => {
    if (hits.length >= maxResults) return
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (hits.length >= maxResults) return
      if (skip.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (!/\.(md|txt|json|mjs|js|ts)$/.test(entry.name)) continue
      const lines = (await readFile(full, 'utf8')).split('\n')
      for (const [index, line] of lines.entries()) {
        if (regex.test(line)) {
          hits.push(`${path.relative(workspace, full)}:${index + 1}: ${line.trim().slice(0, 100)}`)
          if (hits.length >= maxResults) return
        }
      }
    }
  }

  await walk(workspace)
  if (hits.length === 0) return `没有匹配「${pattern}」的内容`
  return truncate(hits.join('\n'))
}

// ─────────────────────────────────────────────────────────────
// 组装
// ─────────────────────────────────────────────────────────────

/**
 * 为一个 workspace 造出一套工具：schema + 实现。
 *
 * 不传 policy 时用默认策略（`workspace-write` + `never`），这样 1.2 / 1.3 的代码不用改。
 *
 * @param {{ workspace: string, policy?: object }} options
 * @returns {{ tools: object[], impls: Record<string, Function>, policy: object }}
 */
export function createToolkit({ workspace, policy = createPolicy({ workspace }) }) {
  const tools = [
    {
      name: 'read_file',
      description: '读取工作区内的一个文本文件。只读，不会修改任何东西。',
      parameters: {
        type: 'object',
        properties: { filePath: { type: 'string', description: '相对工作区的文件路径' } },
        required: ['filePath'],
      },
    },
    {
      name: 'search',
      description: '在工作区内按正则表达式搜索文件内容，返回「文件:行号: 内容」。只读。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '正则表达式' },
          maxResults: { type: 'number', description: '最多返回多少条，默认 40' },
        },
        required: ['pattern'],
      },
    },
    {
      name: 'exec_command',
      description:
        '在工作目录执行一条 shell 命令，返回退出码、标准输出与标准错误。用于查看文件、运行脚本、获取环境信息。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的 shell 命令' },
        },
        required: ['command'],
      },
    },
    {
      name: 'apply_patch',
      description: [
        '用补丁文本修改工作目录里的文件。格式：',
        '*** Begin Patch',
        '*** Add File: 路径   （后续每行以 + 开头）',
        '*** Update File: 路径 （用 @@ 分段，hunk 内：空格=上下文，-=删除，+=新增）',
        '*** Delete File: 路径',
        '*** End Patch',
        '真实 Codex 里这个工具是 FREEFORM 文本参数，不是 JSON。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          patch: { type: 'string', description: '完整的补丁文本' },
        },
        required: ['patch'],
      },
    },
  ]

  const impls = {
    read_file: (args) => readFileTool({ workspace, filePath: args.filePath }),
    search: (args) => searchTool({ workspace, pattern: args.pattern, maxResults: args.maxResults }),
    exec_command: (args) => execCommand({ workspace, command: args.command, policy }),
    apply_patch: (args) => applyPatch({ workspace, patch: args.patch ?? '', policy }),
  }

  return { tools, impls, policy }
}

/** 确保工作目录存在（每个 step 用独立的 runs/ 子目录，互不干扰）。 */
export async function ensureWorkspace(workspace) {
  await mkdir(workspace, { recursive: true })
  return workspace
}
