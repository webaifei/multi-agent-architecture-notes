/**
 * trace.mjs — 教学用终端输出。
 *
 * 为什么单独一个文件？因为「看得见」是多 agent 调试的全部。
 * 三套真实系统都花了大精力做这件事：
 *   - Codex CLI 把每个事件写进 rollout JSONL，再用 TUI 渲染；
 *   - Claude Code 有 --verbose 和 /agents 面板；
 *   - DeepSeek Harness 的原则是「模型可见的必须可回放」（model-visible ⟺ logged）。
 *
 * 所以从第 1 步开始，我们就用统一的 trace 词汇表：
 *   turn / assistant / tool_call / tool_result / result
 * 后面章节加子 agent 时，只多两个词：spawn / finish。
 */

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR

/** @param {number} code ANSI 颜色码 */
const paint = (code) => (text) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : String(text))

export const dim = paint(2)
export const bold = paint(1)
export const red = paint(31)
export const green = paint(32)
export const yellow = paint(33)
export const blue = paint(34)
export const magenta = paint(35)
export const cyan = paint(36)

/** 打印一节的大标题。 */
export function banner(title, subtitle) {
  console.log('')
  console.log(bold(cyan(`━━ ${title} `) + cyan('━'.repeat(Math.max(0, 58 - title.length)))))
  if (subtitle) console.log(dim(`   ${subtitle}`))
  console.log('')
}

/** 打印一次循环轮次的开头，对应真实系统里的 turn/start。 */
export function turn(n) {
  console.log(bold(`\n▸ turn ${n}`))
}

/** 打印模型的文本输出。 */
export function assistant(text) {
  if (!text) return
  console.log(`${magenta('assistant')} ${text}`)
}

/** 打印模型请求调用工具。参数太长时只显示开头，完整内容在 messages 里。 */
export function toolCall(name, args) {
  const raw = JSON.stringify(args)
  const shown = raw.length > 140 ? `${raw.slice(0, 140)}…` : raw
  console.log(`${yellow('tool_call')} ${bold(name)} ${dim(shown)}`)
}

/** 打印工具执行结果。 */
export function toolResult(text) {
  const oneLine = String(text).trim().replace(/\n/g, ' ⏎ ')
  console.log(`${green('tool_result')} ${oneLine}`)
}

/** 打印一条旁白（讲解用，不属于 agent 协议的一部分）。 */
export function note(text) {
  console.log(dim(`  · ${text}`))
}

/** 打印最终结果。 */
export function result(text) {
  console.log(`\n${bold(green('result'))} ${text}`)
}

/** 打印错误。 */
export function error(text) {
  console.log(`${bold(red('error'))} ${text}`)
}

/**
 * 造一个带前缀的 tracer，给子 agent 用。
 *
 * 多 agent 的第一大调试难题就是「这条日志是谁打的」。真实系统会给每条事件带上
 * agent id；我们这里用缩进 + 前缀，效果一样：父 agent 顶格，子 agent 缩进带名字。
 *
 * @param {string} prefix 例如 `agent-1 ada`
 * @returns {object} 与 trace 模块同名的输出函数
 */
export function scoped(prefix) {
  const tag = dim(`[${prefix}]`)
  const line = (text) => console.log(`  ${tag} ${text}`)
  return {
    banner(title, subtitle) {
      console.log('')
      console.log(line(bold(cyan(`━━ ${title}`))))
      if (subtitle) console.log(line(dim(subtitle)))
    },
    turn(n) {
      line(bold(`▸ turn ${n}`))
    },
    assistant(text) {
      if (text) line(`${magenta('assistant')} ${text}`)
    },
    toolCall(name, args) {
      const raw = JSON.stringify(args)
      line(`${yellow('tool_call')} ${bold(name)} ${dim(raw.length > 120 ? `${raw.slice(0, 120)}…` : raw)}`)
    },
    toolResult(text) {
      const oneLine = String(text).trim().replace(/\n/g, ' ⏎ ')
      line(`${green('tool_result')} ${oneLine.length > 120 ? `${oneLine.slice(0, 120)}…` : oneLine}`)
    },
    note(text) {
      line(dim(text))
    },
    result(text) {
      line(`${bold(green('result'))} ${text}`)
    },
    error(text) {
      line(`${bold(red('error'))} ${text}`)
    },
  }
}
