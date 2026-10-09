/**
 * loop.mjs — agent 主循环。从 1.2 起成为三章共用的公共设施。
 *
 * 循环的形状从第 1.1 节起就没变过：
 *
 *   问模型 → 要工具就执行 → 结果写回 messages → 再问 → 直到模型不要工具
 *
 * 1.3 给它加了两样**扩展点**，注意加的姿势：
 *
 *   · `onEvent` —— 循环把「发生了什么」广播出去，谁关心谁订阅。
 *     1.3 用它写会话日志，2.x/3.x 会用它做子 agent 事件与前端渲染。
 *   · `history` —— 让循环从一份已有的 messages 开始，而不是从零开始。
 *     resume（恢复中断的会话）就靠它。
 *
 * **循环本身不知道日志的存在**。这是刻意的：真实系统里持久化、遥测、UI 都是插件，
 * 改它们不该去动 agent loop。DeepSeek Harness 把这条写成硬规矩——
 * 「新增行为走扩展点；改 agent-loop 必须同步更新架构文档」。
 */

import * as trace from './trace.mjs'

/**
 * 跑完一个 agent 的一次任务。
 *
 * @param {object} options
 * @param {{ complete: Function, name: string }} options.model 模型适配器
 * @param {string} options.system 系统提示词
 * @param {string} [options.userMessage] 用户交代的任务（用 history 续跑时可省略）
 * @param {Array<object>} [options.history] 起始上下文；给了就用它，不再拼 userMessage
 * @param {Array<object>} [options.tools] 给模型看的工具清单（JSON Schema）
 * @param {Record<string, Function>} [options.impls] 工具名 → 真实实现
 * @param {number} [options.maxTurns] 轮数上限，兜底防死循环
 * @param {(event: object) => void | Promise<void>} [options.onEvent] 事件订阅钩子
 * @returns {Promise<{ text: string, turns: number, messages: object[] }>}
 */
export async function runAgent({
  model,
  system,
  userMessage,
  history,
  tools = [],
  impls = {},
  maxTurns = 8,
  onEvent,
}) {
  const emit = onEvent ?? (() => {})

  /** 上下文：模型唯一能看到的记忆。它既可以是新起的，也可以是从日志重放出来的。 */
  const messages = history ? [...history] : [{ role: 'user', content: userMessage }]

  for (let turnNo = 1; turnNo <= maxTurns; turnNo += 1) {
    trace.turn(turnNo)
    await emit({ type: 'turn/start', turn: turnNo })

    // ① 问模型：现在干什么？
    const reply = await model.complete({ system, messages, tools })
    trace.assistant(reply.text)

    // ② 模型不要工具 → 它认为任务结束了
    if (reply.toolCalls.length === 0) {
      messages.push({ role: 'assistant', content: reply.text })
      await emit({ type: 'assistant/message', text: reply.text, toolCalls: [] })
      await emit({ type: 'run/end', text: reply.text, turns: turnNo })
      return { text: reply.text, turns: turnNo, messages }
    }

    // ③ 模型要工具 → 把「申请」写进上下文（线上协议要求 assistant 消息带 tool_calls）
    messages.push(assistantWireMessage(reply))
    await emit({ type: 'assistant/message', text: reply.text, toolCalls: reply.toolCalls })

    // ④ 执行工具、回填结果，进入下一轮
    for (const call of reply.toolCalls) {
      trace.toolCall(call.name, call.arguments)
      const impl = impls[call.name]
      // 模型可能编造不存在的工具名：这是要回给模型的「结果」，不是异常。
      const output = impl ? await impl(call.arguments) : `错误：不存在名为 ${call.name} 的工具`
      trace.toolResult(output)
      messages.push({ role: 'tool', tool_call_id: call.id, content: String(output) })
      await emit({ type: 'tool/result', id: call.id, name: call.name, output: String(output) })
    }
  }

  const stopped = `达到最大轮次上限（${maxTurns}），强制停止`
  await emit({ type: 'run/end', text: stopped, turns: maxTurns })
  return { text: stopped, turns: maxTurns, messages }
}

/** 把内部的 ModelReply 转成线上协议要求的 assistant 消息。 */
export function assistantWireMessage(reply) {
  return {
    role: 'assistant',
    content: reply.text || null,
    tool_calls: reply.toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    })),
  }
}
