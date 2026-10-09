/**
 * subagent-tools.mjs — 把注册表包装成模型能调用的工具。
 *
 * 工具名直接照抄 Codex 的 V2 命名（见 docs/sources/codex.md）：
 *
 *   spawn_agent   造一个子 agent（立刻返回 id，不等它跑完）
 *   wait_agent    等它到终态，拿回最后一条消息
 *   list_agents   列出所有 agent 的状态
 *
 * 1.6 会补上另外三个：send_message、followup_task、interrupt_agent。
 *
 * 一个细节值得注意：**工具是绑定身份的**。
 * `createSubagentTools({ callerId, callerDepth })` 让每个 agent 拿到的工具
 * 都知道「我是谁、我在第几层」。这样 spawn 时才能正确地记父节点、算深度，
 * 也才能在上限处 fail loud。
 * 真实系统里这叫「每个子 agent 有自己的一份工具注册表」。
 */

import { AgentError, formatHandle } from './subagent.mjs'

/**
 * 为一个 agent 造一套协作工具。
 *
 * @param {object} options
 * @param {import('./subagent.mjs').AgentRegistry} options.registry
 * @param {string} [options.callerId] 调用者 id（主 agent 是 'root'）
 * @param {number} [options.callerDepth] 调用者所在深度
 * @returns {{ tools: object[], impls: Record<string, Function> }}
 */
export function createSubagentTools({ registry, callerId = 'root', callerDepth = 0 }) {
  const tools = [
    {
      name: 'spawn_agent',
      description:
        '创建一个子 agent 去处理一件自包含的任务。立刻返回它的 id，不会等它跑完；用 wait_agent 取结果。子 agent 有自己的上下文，看不到你之前的对话。',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: '交给子 agent 的任务描述，要自包含' },
          name: { type: 'string', description: '可选的角色名，比如 explorer / verifier' },
        },
        required: ['task'],
      },
    },
    {
      name: 'wait_agent',
      description: '等某个子 agent 到终态，返回它的状态和最后一条回答。',
      parameters: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'spawn_agent 返回的 id' },
        },
        required: ['agent_id'],
      },
    },
    {
      name: 'list_agents',
      description: '列出所有子 agent 的 id、昵称和当前状态。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  ]

  const impls = {
    /** 造一个子 agent。超限时报错文本回给模型，而不是抛异常。 */
    async spawn_agent({ task, name }) {
      if (typeof task !== 'string' || !task.trim()) return '工具调用失败：task 必须是非空字符串'
      try {
        const handle = await registry.spawn({ task, label: name, parentId: callerId, depth: callerDepth + 1 })
        // 返回 JSON，模型读起来比一行自然语言更稳。
        return JSON.stringify({ agent_id: handle.id, nickname: handle.nickname, status: handle.status })
      } catch (error) {
        if (error instanceof AgentError) return `无法创建子 agent：${error.message}（${error.code}）`
        throw error
      }
    },

    /** 等一个子 agent。 */
    async wait_agent({ agent_id }) {
      try {
        const handle = await registry.wait(agent_id)
        return formatHandle(handle)
      } catch (error) {
        if (error instanceof AgentError) return `无法等待：${error.message}（${error.code}）`
        throw error
      }
    },

    /** 列出所有 agent。 */
    list_agents() {
      const all = registry.list()
      if (all.length === 0) return '(当前没有子 agent)'
      return all.map((handle) => `${handle.id}  ${handle.nickname}  ${handle.status}  ${handle.label}`).join('\n')
    },
  }

  return { tools, impls }
}
