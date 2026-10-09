/**
 * agent-defs.mjs — 声明式子 agent：一个 Markdown 文件就是一个角色。
 *
 * 这是 Claude Code 和 Codex 最直观的分野。Codex 要加一个角色，得写 Rust 或 TOML；
 * Claude Code 只要往 `.claude/agents/` 里丢一个 `.md`：
 *
 *   ---
 *   name: explorer
 *   description: 只读探索者。需要摸清代码结构时用它。
 *   tools: Read, Grep, Glob
 *   model: sonnet
 *   ---
 *   你是一个只读探索者。不要修改任何文件……
 *
 *   ↓ frontmatter 是**配置**，正文是**系统提示词**
 *
 * 三条必须记住的规则（都来自官方文档，见 sources/claude-code.md）：
 *
 *   1. 只有 `name` 和 `description` 必填；
 *   2. **未知字段会被静默忽略** —— 拼错 `tools` 不会报错，只会「写了没生效」。
 *      本文件额外提供 `warnings` 把被忽略的字段报出来，真实产品不会。
 *   3. 发现范围有优先级，**最近的赢**：
 *      managed settings → `--agents` CLI JSON → 项目 `.claude/agents/` → 用户 `~/.claude/agents/` → 插件
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'

/** 定义文件相关错误（格式不对、缺必填字段）。 */
export class AgentDefError extends Error {
  constructor(message, file) {
    super(file ? `${path.basename(file)}: ${message}` : message)
    this.name = 'AgentDefError'
    this.file = file
  }
}

/**
 * 已知字段。**不在这个集合里的字段会被忽略**（对齐 Claude Code 的真实行为）。
 * 列表来自官方 sub-agents 文档。
 */
export const KNOWN_FIELDS = new Set([
  'name',
  'description',
  'tools',
  'disallowedTools',
  'model',
  'permissionMode',
  'maxTurns',
  'skills',
  'mcpServers',
  'hooks',
  'memory',
  'background',
  'omitClaudeMd',
  'effort',
  'isolation',
  'color',
  'initialPrompt',
])

/**
 * 解析一个 agent 定义文件：`---` 之间的 frontmatter + 其后的正文。
 *
 * 这里用最朴素的逐行解析，不引入 YAML 库 —— 教学仓库要保持零依赖，
 * 而 frontmatter 的形状本来就只有「key: value」和「key: [a, b]」两种。
 *
 * @param {string} text 文件全文
 * @param {string} [file] 文件名（用于报错）
 * @returns {{ fields: Record<string, unknown>, body: string }}
 */
export function parseAgentMarkdown(text, file) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!match) {
    throw new AgentDefError('缺少 frontmatter：文件必须以 --- 开头，并用 --- 结束', file)
  }
  const [, rawFrontmatter, body] = match

  const fields = {}
  for (const rawLine of rawFrontmatter.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const at = line.indexOf(':')
    if (at === -1) throw new AgentDefError(`frontmatter 无法解析的行：${line}`, file)
    fields[line.slice(0, at).trim()] = parseScalar(line.slice(at + 1).trim())
  }

  return { fields, body: body.trim() }
}

/**
 * 把解析出来的字段规范化成一个 agent 定义，并收集「被静默忽略」的字段。
 *
 * @param {object} options
 * @param {Record<string, unknown>} options.fields
 * @param {string} options.body 正文（即系统提示词）
 * @param {string} options.file 文件路径
 * @param {'cli'|'project'|'user'|'plugin'} options.scope 发现来源
 * @returns {{ name: string, description: string, tools: string[], disallowedTools: string[], model: string|null,
 *             permissionMode: string|null, maxTurns: number|null, background: boolean, omitClaudeMd: boolean,
 *             isolation: string|null, systemPrompt: string, file: string, scope: string, raw: Record<string, unknown>,
 *             warnings: string[] }}
 */
export function normalizeAgent({ fields, body, file, scope }) {
  const warnings = []

  const name = typeof fields.name === 'string' ? fields.name : ''
  const description = typeof fields.description === 'string' ? fields.description : ''
  if (!name) throw new AgentDefError('缺少必填字段 name', file)
  if (!description) throw new AgentDefError('缺少必填字段 description', file)

  // 未知字段：真实 Claude Code 静默忽略，我们记下来提醒你。
  for (const key of Object.keys(fields)) {
    if (!KNOWN_FIELDS.has(key)) warnings.push(`未知字段「${key}」被忽略（拼写错误？已知字段见 KNOWN_FIELDS）`)
  }

  if (!body) warnings.push('正文是空的：这个 agent 会拿不到任何系统提示词')

  return {
    name,
    description,
    tools: toList(fields.tools),
    disallowedTools: toList(fields.disallowedTools),
    model: toText(fields.model),
    permissionMode: toText(fields.permissionMode),
    maxTurns: toNumber(fields.maxTurns),
    background: fields.background === true,
    omitClaudeMd: fields.omitClaudeMd === true,
    isolation: toText(fields.isolation),
    systemPrompt: body,
    file,
    scope,
    raw: fields,
    warnings,
  }
}

/**
 * 从一个目录读入所有 agent 定义。
 *
 * @param {string} dir 例如 `<project>/.claude/agents`
 * @param {'cli'|'project'|'user'|'plugin'} scope
 * @returns {Promise<object[]>}
 */
export async function loadAgentDir(dir, scope) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }

  const agents = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      // 官方行为：目录会被递归扫描，子目录名成为命名空间前缀。
      agents.push(...(await loadAgentDir(full, scope)))
      continue
    }
    if (!entry.name.endsWith('.md')) continue
    const text = await readFile(full, 'utf8')
    agents.push(normalizeAgent({ ...parseAgentMarkdown(text, full), file: full, scope }))
  }
  return agents
}

/**
 * 按优先级发现 agent，**最近的赢**。
 *
 * 优先级（高 → 低）：
 *   1. `overrides`：对应 `--agents` CLI JSON
 *   2. 项目目录：从 cwd 往上走，**越靠近 cwd 的越优先**
 *   3. 用户目录：`~/.claude/agents`
 *
 * @param {object} options
 * @param {string} options.cwd 当前工作目录
 * @param {string} [options.userDir] 用户级目录
 * @param {string} [options.stopAt] 向上查找时停在这一层（含）
 * @param {object[]} [options.overrides] 最高优先级的定义（已 normalize）
 * @returns {Promise<{ agents: object[], shadowed: object[], sources: object[] }>}
 */
export async function discoverAgents({ cwd, userDir, stopAt, overrides = [] }) {
  const agents = []
  const shadowed = []
  const sources = []

  /** 先把定义放进结果；同名则记入 shadowed，不再覆盖。 */
  const accept = (agent) => {
    const existing = agents.find((item) => item.name === agent.name)
    if (existing) {
      shadowed.push({ name: agent.name, file: agent.file, scope: agent.scope, winner: existing.file, winnerScope: existing.scope })
      return
    }
    agents.push(agent)
  }

  if (overrides.length > 0) {
    sources.push({ scope: 'cli', dir: '--agents JSON', count: overrides.length })
  }
  for (const agent of overrides) {
    accept(agent)
  }

  for (const dir of ancestors(cwd, stopAt)) {
    const agentsDir = path.join(dir, '.claude', 'agents')
    const found = await loadAgentDir(agentsDir, 'project')
    if (found.length > 0) sources.push({ scope: 'project', dir: agentsDir, count: found.length })
    for (const agent of found) accept(agent)
  }

  if (userDir && (await exists(userDir))) {
    const found = await loadAgentDir(userDir, 'user')
    if (found.length > 0) sources.push({ scope: 'user', dir: userDir, count: found.length })
    for (const agent of found) accept(agent)
  }

  return { agents, shadowed, sources }
}

/** 从 start 往上列出祖先目录，直到 stopAt（含）或文件系统根。 */
function ancestors(start, stopAt) {
  const stop = stopAt ? path.resolve(stopAt) : null
  const out = []
  let current = path.resolve(start)
  while (true) {
    out.push(current)
    if (stop && current === stop) break
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return out
}

async function exists(target) {
  return stat(target).then(
    (info) => info.isDirectory(),
    () => false,
  )
}

/** `Read, Grep` 或 `[Read, Grep]` 都规范成数组。 */
function toList(value) {
  if (value === undefined || value === null || value === '') return []
  const raw = Array.isArray(value) ? value : String(value).replace(/^\[|\]$/g, '').split(',')
  return raw.map((item) => String(item).trim()).filter(Boolean)
}

function toText(value) {
  return typeof value === 'string' && value !== '' ? value : null
}

function toNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

/** 去掉包裹的引号；`[a, b]` 变成数组；true/false 变布尔；数字变数字。 */
function parseScalar(value) {
  if (value.startsWith('[') && value.endsWith(']')) {
    return value
      .slice(1, -1)
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  }
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  if (value === 'true') return true
  if (value === 'false') return false
  const number = Number(value)
  if (value !== '' && Number.isFinite(number)) return number
  return value
}
