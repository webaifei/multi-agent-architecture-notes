/**
 * subagent-tools.mjs — 把注册表包装成模型能调用的工具。
 *
 * 工具名直接照抄 Codex 的 V2 命名（见 docs/sources/codex.md）：
 *
 *   spawn_agent      造一个子 agent（立刻返回 id，不等它跑完）
 *   send_message     给它发消息 —— **只排队，不打断**（QueueOnly）
 *   followup_task    给它追加一个新回合（上下文接着上一轮）
 *   wait_agent       等它到终态，拿回最后一条消息
 *   interrupt_agent  发出停止信号（同步返回，不等收尾）
 *   list_agents      列出所有 agent 的状态
 *
 * 一个细节值得注意：**工具是绑定身份的**。
 * `createSubagentTools({ callerId, callerDepth })` 让每个 agent 拿到的工具
 * 都知道「我是谁、我在第几层」。这样 spawn 时才能正确地记父节点、算深度，
 * 也才能在上限处 fail loud。
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
      name: 'send_message',
      description:
        '给一个正在运行或已完成的子 agent 发一条消息。只排队，不会打断它正在进行的回合；它会在这个回合结束后的下一次模型调用时看到。',
      parameters: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: '目标 agent id' },
          message: { type: 'string', description: '要发送的内容' },
        },
        required: ['agent_id', 'message'],
      },
    },
    {
      name: 'followup_task',
      description:
        '给一个**已空闲**的子 agent 追加一个新回合，它的上下文接着上一轮。它还在运行时会被拒绝，此时请改用 send_message。',
      parameters: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: '目标 agent id' },
          task: { type: 'string', description: '新的任务描述' },
        },
        required: ['agent_id', 'task'],
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
      name: 'interrupt_agent',
      description: '让某个子 agent 停下来。立刻返回，不等它收尾；用 wait_agent 可以等到它真正进入 interrupted 状态。',
      parameters: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: '目标 agent id' },
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

    /** 发消息：只排队，不打断。 */
    send_message({ agent_id, message }) {
      try {
        const result = registry.sendMessage(agent_id, message)
        return JSON.stringify({
          delivery: result.delivery,
          queue_length: result.queueLength,
          note: result.running ? '该 agent 正在运行，消息会在下一次模型调用前送达' : '该 agent 已空闲，消息会留在邮箱里，等下一次 followup_task 时读到',
        })
      } catch (error) {
        if (error instanceof AgentError) return `无法发送：${error.message}（${error.code}）`
        throw error
      }
    },

    /** 追加新回合：会真的触发一次运行。 */
    async followup_task({ agent_id, task }) {
      if (typeof task !== 'string' || !task.trim()) return '工具调用失败：task 必须是非空字符串'
      try {
        const handle = await registry.followupTask(agent_id, task)
        return JSON.stringify({ agent_id: handle.id, status: handle.status, note: '新回合已启动，用 wait_agent 取结果' })
      } catch (error) {
        if (error instanceof AgentError) return `无法追加回合：${error.message}（${error.code}）`
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

    /** 发出停止信号：同步返回，不等收尾。 */
    interrupt_agent({ agent_id }) {
      try {
        const handle = registry.interrupt(agent_id)
        return JSON.stringify({ agent_id: handle.id, status: handle.status, note: '已发出停止信号；用 wait_agent 等它真正停下' })
      } catch (error) {
        if (error instanceof AgentError) return `无法中断：${error.message}（${error.code}）`
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
