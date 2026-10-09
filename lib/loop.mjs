/**
 * loop.mjs — 从 1.2 起，agent 主循环搬进公共库。
 *
 * 第 1.1 节把循环写在 step1 文件里，是为了让你一次读完；
 * 但从这一节开始，三章都要用同一个循环，所以把它抽出来。
 *
 * 循环的形状没变，一个字都没变：
 *
 *   问模型 → 要工具就执行 → 结果写回 messages → 再问 → 直到模型不要工具
 *
 * 真实系统里这个循环也是长期稳定的核心，外围机制（沙箱、审批、日志、子 agent）
 * 都是挂在它周围的插件，而不是去改循环本身。
 * DeepSeek Harness 甚至把这条写成了硬规矩：「新增行为走扩展点，改 agent-loop 要同步改架构文档」。
 */

import * as trace from './trace.mjs'

/**
 * 跑完一个 agent 的一次任务。
 *
 * @param {object} options
 * @param {{ complete: Function, name: string }} options.model 模型适配器
 * @param {string} options.system 系统提示词
 * @param {string} options.userMessage 用户交代的任务
 * @param {Array<object>} options.tools 给模型看的工具清单（JSON Schema）
 * @param {Record<string, Function>} options.impls 工具名 → 真实实现
 * @param {number} [options.maxTurns] 轮数上限，兜底防死循环
 * @returns {Promise<{ text: string, turns: number, messages: object[] }>}
 */
export async function runAgent({ model, system, userMessage, tools = [], impls = {}, maxTurns = 8 }) {
  /** 上下文：模型唯一能看到的记忆。 */
  const messages = [{ role: 'user', content: userMessage }]

  for (let turnNo = 1; turnNo <= maxTurns; turnNo += 1) {
    trace.turn(turnNo)

    // ① 问模型：现在干什么？
    const reply = await model.complete({ system, messages, tools })
    trace.assistant(reply.text)

    // ② 模型不要工具 → 它认为任务结束了
    if (reply.toolCalls.length === 0) {
      messages.push({ role: 'assistant', content: reply.text })
      return { text: reply.text, turns: turnNo, messages }
    }

    // ③ 模型要工具 → 把「申请」写进上下文（线上协议要求 assistant 消息带 tool_calls）
    messages.push(assistantWireMessage(reply))

    // ④ 执行工具、回填结果，进入下一轮
    for (const call of reply.toolCalls) {
      trace.toolCall(call.name, call.arguments)
      const impl = impls[call.name]
      // 模型可能编造不存在的工具名：这是要回给模型的「结果」，不是异常。
      const output = impl ? await impl(call.arguments) : `错误：不存在名为 ${call.name} 的工具`
      trace.toolResult(output)
      messages.push({ role: 'tool', tool_call_id: call.id, content: String(output) })
    }
  }

  return { text: `达到最大轮次上限（${maxTurns}），强制停止`, turns: maxTurns, messages }
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
