/**
 * policy.mjs — 审批策略（approval policy）与沙箱模式（sandbox mode）。
 *
 * 这是 Codex 设计里最值得抄的一点：**它们是两个正交的旋钮，不是一个开关**。
 *
 *   沙箱模式：允许碰什么       read-only | workspace-write | danger-full-access
 *   审批策略：越界了怎么办     never | on-request | on-failure
 *
 * 两两组合出六种行为，覆盖从「只读助手」到「无人值守全权代理」的全部场景。
 * Codex 的真实取值见 docs/sources/codex.md；本文件里 `never` 的默认值也照抄了它。
 *
 * ⚠️ 必须说清楚的一件事：
 * 下面这套检查是**应用层策略**（policy），**不是安全边界**（sandbox）。
 * 它只能约束「我们自己代码里经过检查的那些路径」。一旦把字符串交给 shell，
 * 字符串检查就失效了 —— 这一点在 step4 的第三个场景里会当场演示。
 * 真实系统靠 OS 级强制：macOS Seatbelt、Linux Landlock + seccomp、容器、虚拟机。
 *
 * 「策略层」和「执行隔离层」分开，也是 DeepSeek Harness 的做法：
 * 沙箱是独立的进程约束包，策略是配置，两者互不越权。
 */

/** 允许的沙箱模式。 */
export const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access']

/** 允许的审批策略。 */
export const APPROVAL_POLICIES = ['never', 'on-request', 'on-failure']

/** 只读安全的命令（第一个词）。 */
const READ_ONLY_COMMANDS = new Set(['cat', 'ls', 'pwd', 'head', 'tail', 'wc', 'echo', 'printf', 'grep', 'find'])

/** 会改动文件系统的命令（第一个词）。 */
const WRITE_COMMANDS = new Set(['touch', 'mkdir', 'cp', 'mv', 'rm', 'node'])

/**
 * 造一个策略对象。工具的每一次有副作用的动作都要先过它。
 *
 * @param {object} options
 * @param {'read-only'|'workspace-write'|'danger-full-access'} [options.sandbox]
 * @param {'never'|'on-request'|'on-failure'} [options.approval]
 * @param {string} options.workspace 工作目录（workspace-write 的边界）
 * @param {(request: object) => Promise<boolean> | boolean} [options.approver] 审批人
 * @returns {object} 策略对象
 */
export function createPolicy({ sandbox = 'workspace-write', approval = 'never', workspace, approver } = {}) {
  if (!SANDBOX_MODES.includes(sandbox)) throw new Error(`未知的沙箱模式：${sandbox}`)
  if (!APPROVAL_POLICIES.includes(approval)) throw new Error(`未知的审批策略：${approval}`)
  if (!workspace) throw new Error('createPolicy 需要 workspace')

  return {
    sandbox,
    approval,
    workspace,

    /** 一行描述，便于打印和排错。 */
    describe() {
      return `sandbox=${sandbox}  approval=${approval}`
    },

    /**
     * 检查一次写入是否被沙箱允许。
     *
     * @param {string} absolutePath 目标文件的绝对路径
     * @returns {null | { reason: string }} 允许返回 null，否则返回拒绝原因
     */
    guardWrite(absolutePath) {
      if (sandbox === 'danger-full-access') return null
      if (sandbox === 'read-only') {
        return { reason: '沙箱是 read-only，不允许写任何文件' }
      }
      const inside = absolutePath === workspace || absolutePath.startsWith(workspace + '/')
      if (!inside) return { reason: `目标越出工作区（workspace-write 只允许写 ${workspace} 内）` }
      return null
    },

    /**
     * 检查一条命令是否被沙箱允许。
     *
     * 这里按 `&&`、`||`、`;`、`|` 切成多段，每段只看**第一个词**。
     * 只看第一个词是刻意的 —— 它看起来像检查，实际挡不住任何东西（见 step4 场景 C）。
     *
     * @param {string} command
     * @returns {null | { reason: string }}
     */
    guardCommand(command) {
      if (sandbox === 'danger-full-access') return null

      const allowed = sandbox === 'read-only' ? READ_ONLY_COMMANDS : new Set([...READ_ONLY_COMMANDS, ...WRITE_COMMANDS])
      const segments = String(command)
        .split(/&&|\|\||;|\|/)
        .map((segment) => segment.trim())
        .filter(Boolean)

      for (const segment of segments) {
        const head = segment.split(/\s+/)[0]
        if (!allowed.has(head)) {
          return { reason: `${sandbox} 模式不允许执行「${head}」开头的命令` }
        }
      }
      return null
    },

    /**
     * 请求人工/自动审批。策略是 `never` 时不会走到这里。
     *
     * @param {{ kind: 'write'|'command', detail: string, reason: string }} request
     * @returns {Promise<boolean>}
     */
    async requestApproval(request) {
      if (typeof approver !== 'function') return false
      return Boolean(await approver({ ...request, sandbox, approval }))
    },
  }
}

/**
 * 沙箱拒绝了之后怎么办 —— 审批策略的全部内容就这一个函数。
 *
 * 三种策略的语义（照 Codex 的真实定义）：
 *   never       直接拒绝，不问，把原因作为结果回给模型
 *   on-request  在**执行之前**请求批准；批准则以提升后的权限执行
 *   on-failure  **先执行**，只有当沙箱把它挡下来之后，才拿着失败证据去请求批准
 *
 * 本教学实现里 on-request 与 on-failure 都会问审批人，区别只在请求里带不带
 * 「刚从沙箱失败回来」的证据 —— 因为我们的检查发生在执行前，没有「先试一次」
 * 这一步。真实 Codex 有这个区别。
 *
 * @param {object} policy
 * @param {{ kind: 'write'|'command', detail: string, reason: string }} request
 * @returns {Promise<{ allowed: boolean, how: string }>}
 */
export async function escalate(policy, request) {
  if (policy.approval === 'never') {
    return { allowed: false, how: 'approval=never，不会询问' }
  }
  const granted = await policy.requestApproval(request)
  if (granted) return { allowed: true, how: `approval=${policy.approval}，已批准` }
  return { allowed: false, how: `approval=${policy.approval}，被否决` }
}
