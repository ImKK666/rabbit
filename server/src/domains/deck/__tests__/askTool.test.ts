/**
 * 确认闸门（R-61）的判据
 *
 * 判「问答闭环 / 超时 / 取消作废」三条。等待与超时本身在
 * `runtime/pendingRequests.test.ts` 里验，这里验的是接线的行为：
 * 提问确实发出去、答案确实回到工具、失败路径不抛异常。
 */

import { describe, it, expect } from 'vitest'
import { createAskTool, settleUserAnswer } from '../askTool'
import type { ServerMessage } from '@server/ws/handler'

const context = () => {
  const emitted: ServerMessage[] = []
  const controller = new AbortController()
  return {
    emitted,
    signal: controller.signal,
    ctx: { emit: (m: ServerMessage) => emitted.push(m), signal: controller.signal },
    controller,
  }
}

const tick = () => new Promise(r => setTimeout(r, 15))

describe('askTool · 确认闸门（R-61）', () => {
  it('settleUserAnswer 对不认识的 requestId 返回 false —— 迟到/伪造/重复一律丢', () => {
    expect(settleUserAnswer('req_nope', true)).toBe(false)
  })

  it('问答闭环：提问发出去、答案回到工具、等待表清空', async () => {
    const { emitted, ctx } = context()
    const { askUser } = createAskTool(ctx, { timeoutMs: 5000 })

    const run = (askUser.execute as (a: { question: string }) => Promise<string>)({ question: '数据报告还是故事叙事？' })
    await tick()
    const ask = emitted.find(m => m.type === 'agent.ask')
    expect(ask).toBeTruthy()
    if (!ask || ask.type !== 'agent.ask') return
    expect(ask.question).toContain('数据报告')

    expect(settleUserAnswer(ask.requestId, true)).toBe(true)
    const out = JSON.parse(await run)
    expect(out.ok).toBe(true)
    expect(out.answer).toBe(true)

    // 同一个 id 再交一次（重复点击）不再被接受
    expect(settleUserAnswer(ask.requestId, false)).toBe(false)
  })

  it('超时回「没回答」，不抛异常，agent 按自己的判断继续', async () => {
    const { ctx } = context()
    const { askUser } = createAskTool(ctx, { timeoutMs: 30 })
    const out = JSON.parse(await (askUser.execute as (a: { question: string }) => Promise<string>)({ question: 'x' }))
    expect(out.ok).toBe(false)
    expect(out.reason).toContain('超时')
    expect(out.hint).toContain('自己的判断')
  })

  it('任务取消时作废在等的提问，不等超时', async () => {
    const { ctx, controller } = context()
    const { askUser } = createAskTool(ctx, { timeoutMs: 5000 })
    const run = (askUser.execute as (a: { question: string }) => Promise<string>)({ question: 'x' })
    await tick()
    controller.abort()
    const out = JSON.parse(await run)
    expect(out.ok).toBe(false)
    expect(out.reason).toContain('取消')
  })
})
