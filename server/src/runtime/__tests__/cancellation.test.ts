/**
 * 取消回收的判据
 *
 * 守的是一件事：**abort 之后，可回收的事件不再投递，不可回收的照常送达。**
 *
 * 每一组都配了负对照 —— 把闸门换成「直接投递」的旧实现（那正是 HEAD 的行为），
 * 确认同一条序列下它真的会漏。全绿的检查器和没有检查器是一回事。
 */

import { describe, it, expect } from 'vitest'
import { createEventGate } from '../cancellation'

interface Msg { type: string }

/** 只有 `state` 类型在取消后仍必须送达，模拟 deck 域「只有 agent.deck 放行」 */
const survivesCancel = (msg: Msg) => msg.type === 'state'

const setup = () => {
  const controller = new AbortController()
  const delivered: Msg[] = []
  const gate = createEventGate<Msg>({
    signal: controller.signal,
    survivesCancel,
    deliver: msg => {
      delivered.push(msg)
    },
  })
  return { controller, delivered, gate }
}

/** 一条典型的在途序列：叙事夹着一次状态推送 */
const IN_FLIGHT: Msg[] = [
  { type: 'text' },
  { type: 'tool' },
  { type: 'state' },
  { type: 'reasoning' },
  { type: 'status' },
]

describe('取消之前', () => {
  it('全部照常投递', () => {
    const { delivered, gate } = setup()
    for (const msg of IN_FLIGHT) expect(gate.send(msg)).toBe(true)
    expect(delivered).toEqual(IN_FLIGHT)
    expect(gate.stats()).toEqual({ delivered: 5, reclaimed: 0 })
  })

  it('signal 是发送时读的，不是构造时快照的', () => {
    const { controller, delivered, gate } = setup()
    gate.send({ type: 'text' })
    controller.abort()
    gate.send({ type: 'text' })
    // 构造时未取消，但第二条仍要被拦下 —— 闸门若在构造时把 aborted 存成常量就会漏
    expect(delivered).toHaveLength(1)
  })
})

describe('取消之后', () => {
  it('叙事类事件一条都不投递，权威状态照常送达', () => {
    const { controller, delivered, gate } = setup()
    controller.abort()

    for (const msg of IN_FLIGHT) gate.send(msg)

    expect(delivered).toEqual([{ type: 'state' }])
    expect(gate.stats()).toEqual({ delivered: 1, reclaimed: 4 })
  })

  it('send 对被回收的事件返回 false', () => {
    const { controller, gate } = setup()
    controller.abort()
    expect(gate.send({ type: 'text' })).toBe(false)
    expect(gate.send({ type: 'state' })).toBe(true)
  })

  it('闸门不是一次性的 —— 后续每一条都继续拦', () => {
    const { controller, delivered, gate } = setup()
    controller.abort()
    for (let i = 0; i < 50; i++) gate.send({ type: 'text' })
    expect(delivered).toHaveLength(0)
    expect(gate.stats().reclaimed).toBe(50)
  })

  it('取消发生在序列中途时，之前的留下、之后的丢掉', () => {
    const { controller, delivered, gate } = setup()
    gate.send({ type: 'text' })
    gate.send({ type: 'tool' })
    controller.abort()
    gate.send({ type: 'text' })
    gate.send({ type: 'tool' })

    expect(delivered).toEqual([{ type: 'text' }, { type: 'tool' }])
    expect(gate.stats()).toEqual({ delivered: 2, reclaimed: 2 })
  })
})

describe('计数', () => {
  it('数得出「什么都没发生」—— 被丢掉的事件在别处完全不可见', () => {
    const { controller, gate } = setup()
    gate.send({ type: 'text' })
    controller.abort()
    gate.send({ type: 'text' })
    gate.send({ type: 'text' })
    gate.send({ type: 'state' })

    // 抄 BitFun 视口登记处那条：「一个『拒绝』的写者也要说出来」。
    // 闸门坏掉的两种表现（该丢的没丢 / 不该丢的丢了）都只有计数看得见
    expect(gate.stats()).toEqual({ delivered: 2, reclaimed: 2 })
  })
})

describe('负对照：没有闸门的旧实现', () => {
  /** HEAD 的行为 —— cancelAgentTask 只 abort()，send 照发 */
  const oldStyleSend = (delivered: Msg[], _signal: AbortSignal, msg: Msg) => {
    delivered.push(msg)
  }

  it('同一条序列下，旧实现在取消后仍然把叙事事件全发出去了', () => {
    const controller = new AbortController()
    const delivered: Msg[] = []
    controller.abort()
    for (const msg of IN_FLIGHT) oldStyleSend(delivered, controller.signal, msg)

    // 这就是要修的行为：取消之后 5 条一条不少
    expect(delivered).toEqual(IN_FLIGHT)

    // 而新实现在同样的输入下只放行 1 条 —— 判据确实分得开这两版
    const { controller: c2, delivered: d2, gate } = setup()
    c2.abort()
    for (const msg of IN_FLIGHT) gate.send(msg)
    expect(d2).toHaveLength(1)
    expect(d2).not.toEqual(delivered)
  })
})
