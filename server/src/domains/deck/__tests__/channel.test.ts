/**
 * 下行通道的判据 —— 本轮两条验收标准就在这里
 *
 * > ① 取消之后，除 `agent.deck` 外 `agent.*` 计数为 0
 * > ② 任务结束时库里的 slidesJson 与最后一条 `agent.deck` **逐字节相等**
 *
 * `cancellation.ts` / `commit.ts` 各自的判据验的是零件；这一组验的是
 * **它们被接对了没有**。零件对 ≠ 装配对 —— 这个仓库在这上面栽过
 * （R-36：45 个 cssClass 静态核过「都有定义」，但没有一个被看过）。
 */

import { describe, it, expect } from 'vitest'
import type { ServerMessage } from '@server/ws/handler'
import type { SlideTheme } from '@/types/slides'
import { createDeckChannel } from '../channel'
import type { DeckState } from '../tools'

const THEME = {} as SlideTheme

const stateAt = (n: number): DeckState => ({
  slides: Array.from({ length: n }, (_, i) => ({ id: `s${i + 1}`, elements: [] })),
  theme: THEME,
  version: n,
})

const setup = () => {
  const controller = new AbortController()
  const delivered: ServerMessage[] = []
  let stored: string | null = null

  const channel = createDeckChannel({
    signal: controller.signal,
    deliver: msg => {
      delivered.push(msg)
    },
    persist: (next) => {
      stored = JSON.stringify(next.slides)
    },
  })

  const lastDeck = () =>
    [...delivered].reverse().find(m => m.type === 'agent.deck') as
      Extract<ServerMessage, { type: 'agent.deck' }> | undefined

  return {
    controller,
    channel,
    delivered,
    stored: () => stored,
    lastDeck,
    /** 判据 ②：库里 == 最后一条推出去的 */
    inSync: () => stored === (lastDeck()?.slidesJson ?? null),
    /** 判据 ①：取消之后到达前端的非 deck 事件 */
    narrationAfter: (mark: number) =>
      delivered.slice(mark).filter(m => m.type !== 'agent.deck'),
  }
}

/** 一轮典型的 agent 活动：说一句、调个工具、改一次 deck */
const oneRound = async (h: ReturnType<typeof setup>, n: number) => {
  h.channel.emit({ type: 'agent.text', role: 'generator', content: `第 ${n} 页` })
  h.channel.emit({ type: 'agent.tool', tool: 'addSlide', args: {} })
  await h.channel.commit(stateAt(n))
}

describe('判据 ①：取消之后 agent.* 只剩 agent.deck', () => {
  it('取消后继续跑的两轮，一条叙事都没有到达前端', async () => {
    const h = setup()
    await oneRound(h, 1)
    await oneRound(h, 2)

    const mark = h.delivered.length
    h.controller.abort() // ← 用户点了取消

    // agent 并不会立刻停 —— 工具函数不看 signal，当前这步会跑完
    await oneRound(h, 3)
    await oneRound(h, 4)
    h.channel.emit({ type: 'agent.status', status: 'error', message: '任务已取消' })
    h.channel.emit({ type: 'agent.reasoning', role: 'generator', delta: '还在想' })

    expect(h.narrationAfter(mark)).toEqual([])

    // 而 deck 照常送达，共 2 条（第 3、4 轮各一次提交）
    const decksAfter = h.delivered.slice(mark).filter(m => m.type === 'agent.deck')
    expect(decksAfter).toHaveLength(2)
  })

  it('取消前的叙事一条不少', async () => {
    const h = setup()
    await oneRound(h, 1)
    const before = h.delivered.filter(m => m.type !== 'agent.deck')
    expect(before).toHaveLength(2) // text + tool

    h.controller.abort()
    await oneRound(h, 2)
    expect(h.delivered.filter(m => m.type !== 'agent.deck')).toHaveLength(2) // 没再多
  })

  it('回收计数对得上', async () => {
    const h = setup()
    await oneRound(h, 1)
    h.controller.abort()
    await oneRound(h, 2)
    await oneRound(h, 3)

    // 取消后两轮各有 text + tool 被回收
    expect(h.channel.stats().reclaimed).toBe(4)
    expect(h.channel.stats().committed).toBe(3)
  })
})

describe('判据 ②：库里 == 最后一条 agent.deck，逐字节', () => {
  it('正常跑完时成立', async () => {
    const h = setup()
    for (let n = 1; n <= 5; n++) await oneRound(h, n)
    await h.channel.drain()

    expect(h.inSync()).toBe(true)
    expect(h.lastDeck()!.slidesJson).toBe(JSON.stringify(stateAt(5).slides))
    expect(h.lastDeck()!.version).toBe(5)
  })

  it('**取消之后仍然成立** —— 这正是 agent.deck 不可回收的理由', async () => {
    const h = setup()
    for (let n = 1; n <= 3; n++) await oneRound(h, n)
    h.controller.abort()
    // abort 之后当前步的 mutation 还会落库；deck 事件一起放行，两边才不会错开
    await oneRound(h, 4)
    await h.channel.drain()

    expect(h.inSync()).toBe(true)
    expect(h.stored()).toBe(JSON.stringify(stateAt(4).slides))
  })

  it('每一步之后都成立，不是只有收尾时', async () => {
    const h = setup()
    for (let n = 1; n <= 6; n++) {
      await oneRound(h, n)
      expect(h.inSync()).toBe(true)
    }
  })

  it('负对照：agent.deck 若也被回收，取消后立刻不一致', () => {
    // 把策略换成「全部可回收」，其余接线不变 —— 这是选 (a)/(c) 方案时的形状
    const controller = new AbortController()
    const delivered: ServerMessage[] = []
    let stored: string | null = null

    const gateAllReclaimable = (msg: ServerMessage) => {
      if (controller.signal.aborted) return
      delivered.push(msg)
    }
    const commit = (next: DeckState) => {
      stored = JSON.stringify(next.slides)
      gateAllReclaimable({
        type: 'agent.deck', slidesJson: JSON.stringify(next.slides), version: next.version,
      })
    }

    commit(stateAt(1))
    controller.abort()
    commit(stateAt(2)) // 落库了，但事件被丢掉

    const lastDeck = [...delivered].reverse()
      .find(m => m.type === 'agent.deck') as Extract<ServerMessage, { type: 'agent.deck' }>
    expect(stored).toBe(JSON.stringify(stateAt(2).slides))
    expect(lastDeck.slidesJson).toBe(JSON.stringify(stateAt(1).slides))
    expect(stored).not.toBe(lastDeck.slidesJson) // ← 画布比库少一步
  })
})

describe('接线本身', () => {
  it('commit 推出的 agent.deck 也走闸门，不是绕过去直接投递', async () => {
    // 看着多余（策略表里它永远放行），但绕过去会留一条暗路：
    // 哪天 events.ts 改主意，改一处不够。
    //
    // **必须用 commit 而不是 emit 来验**：第一版这里写的是 emit，
    // 而 emit 无论如何都走闸门 —— 于是把 publish 改成绕过闸门，判据照样全绿。
    // 挂负对照才发现它测的根本不是 publish 那条路
    const h = setup()
    await h.channel.commit(stateAt(1))

    expect(h.delivered).toHaveLength(1) // 事件到了前端
    expect(h.channel.stats().delivered).toBe(1) // 且是**经闸门**到的
  })

  it('drain 之后库里就是最终态', async () => {
    const h = setup()
    void h.channel.commit(stateAt(1))
    void h.channel.commit(stateAt(2))
    await h.channel.drain()
    expect(h.stored()).toBe(JSON.stringify(stateAt(2).slides))
    expect(h.inSync()).toBe(true)
  })

  it('推送的 version 跟着状态走', async () => {
    const h = setup()
    await h.channel.commit(stateAt(3))
    expect(h.lastDeck()!.version).toBe(3)
  })
})
