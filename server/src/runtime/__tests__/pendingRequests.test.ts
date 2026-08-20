/**
 * 「后端问、前端答」等待器的判据
 *
 * 对应 docs/13-queue-reflect-ingest.md §三 的 R2 / R5。
 *
 * 这一组守的是那条**唯一新增的系统性风险**：阻塞。
 * 11 号文档风险表预告过「阻塞式确认在 WebSocket 断线时会死锁」，
 * 而死锁的表现是**任务再无下文、没有任何报错** —— 全靠这里的超时兜住。
 */

import { describe, it, expect, vi } from 'vitest'
import { createPendingRequests } from '../pendingRequests'

/** 假时钟：定时器攒着，手动触发 */
const fakeTimers = () => {
  const timers = new Map<number, { fn: () => void, ms: number }>()
  let next = 1
  return {
    setTimer: (fn: () => void, ms: number) => {
      const h = next++
      timers.set(h, { fn, ms })
      return h
    },
    clearTimer: (h: unknown) => {
      timers.delete(h as number)
    },
    /** 把所有到期的都触发 */
    fire: () => {
      for (const [h, t] of [...timers.entries()]) {
        timers.delete(h)
        t.fn()
      }
    },
    pending: () => timers.size,
    delays: () => [...timers.values()].map(t => t.ms),
  }
}

const make = <T>(timeoutMs = 5000) => {
  const clock = fakeTimers()
  let n = 0
  const reqs = createPendingRequests<T>({
    timeoutMs,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    newId: () => `id${++n}`,
  })
  return { reqs, clock }
}

describe('正常路径', () => {
  it('open 给出 id 和一个等待句柄', () => {
    const { reqs } = make<string>()
    const { id, wait } = reqs.open()
    expect(id).toBe('id1')
    expect(wait).toBeInstanceOf(Promise)
    expect(reqs.size()).toBe(1)
  })

  it('settle 之后拿到答复', async () => {
    const { reqs } = make<{ n: number }>()
    const { id, wait } = reqs.open()
    expect(reqs.settle(id, { n: 42 })).toBe(true)
    await expect(wait).resolves.toEqual({ ok: true, value: { n: 42 } })
  })

  it('settle 之后登记清干净，定时器也停掉 —— 不然是泄漏', async () => {
    const { reqs, clock } = make<string>()
    const { id } = reqs.open()
    reqs.settle(id, 'ok')
    expect(reqs.size()).toBe(0)
    expect(clock.pending()).toBe(0)
  })

  it('多个请求各等各的，互不干扰', async () => {
    const { reqs } = make<string>()
    const a = reqs.open()
    const b = reqs.open()
    reqs.settle(b.id, 'B')
    reqs.settle(a.id, 'A')
    await expect(a.wait).resolves.toEqual({ ok: true, value: 'A' })
    await expect(b.wait).resolves.toEqual({ ok: true, value: 'B' })
  })
})

describe('R2 · 超时必须有，而且永不 reject', () => {
  it('超时后 resolve 成 timeout，**不是 reject**', async () => {
    // 抛异常会变成一次工具调用失败，而 agent 对失败的反应是重试 ——
    // 重试一个断线的前端只会把步数烧光
    const { reqs, clock } = make<string>()
    const { wait } = reqs.open()
    clock.fire()
    await expect(wait).resolves.toEqual({ ok: false, reason: 'timeout' })
  })

  it('超时用的就是传进来的那个毫秒数', () => {
    const { reqs, clock } = make<string>(1234)
    reqs.open()
    expect(clock.delays()).toEqual([1234])
  })

  it('超时之后登记清干净', async () => {
    const { reqs, clock } = make<string>()
    const { wait } = reqs.open()
    clock.fire()
    await wait
    expect(reqs.size()).toBe(0)
  })

  it('**负对照**：没有超时的话，等待句柄永远不会 settle', async () => {
    // 这就是死锁的形状。用一个永不触发的定时器手工搭出来，
    // 确认「永远等下去」这件事本身是看得见的
    const never = createPendingRequests<string>({
      timeoutMs: 5000,
      setTimer: () => 0, // ← 定时器根本不排
      clearTimer: () => {},
    })
    const { wait } = never.open()
    const raced = await Promise.race([
      wait,
      new Promise<'还在等'>(res => setTimeout(() => res('还在等'), 20)),
    ])
    expect(raced).toBe('还在等')
  })
})

describe('R5 · 对不上的 id 一律丢掉', () => {
  it('未知 id 的答复返回 false，什么都不做', () => {
    const { reqs } = make<string>()
    reqs.open()
    expect(reqs.settle('伪造的', 'x')).toBe(false)
    expect(reqs.size()).toBe(1)
  })

  it('超时之后迟到的答复不会被接受', async () => {
    // 接受它就意味着 agent 拿到一份属于**上一次测量**的数据，
    // 而那份数据看起来完全正常 —— 没有任何东西会报错
    const { reqs, clock } = make<string>()
    const { id, wait } = reqs.open()
    clock.fire()
    await wait
    expect(reqs.settle(id, '迟到的')).toBe(false)
  })

  it('同一个 id 答两次，第二次落空', async () => {
    const { reqs } = make<string>()
    const { id, wait } = reqs.open()
    expect(reqs.settle(id, '第一次')).toBe(true)
    expect(reqs.settle(id, '第二次')).toBe(false)
    await expect(wait).resolves.toEqual({ ok: true, value: '第一次' })
  })

  it('一次测量的答复不会落到另一次上', async () => {
    const { reqs } = make<string>()
    const a = reqs.open()
    const b = reqs.open()
    reqs.settle(a.id, 'A 的数据')
    await expect(a.wait).resolves.toEqual({ ok: true, value: 'A 的数据' })
    expect(reqs.size()).toBe(1) // b 还在等，没被顺手 settle 掉
  })
})

describe('外部作废', () => {
  it('cancelAll 让所有在等的 resolve 成 cancelled', async () => {
    const { reqs } = make<string>()
    const a = reqs.open()
    const b = reqs.open()
    expect(reqs.cancelAll()).toBe(2)
    await expect(a.wait).resolves.toEqual({ ok: false, reason: 'cancelled' })
    await expect(b.wait).resolves.toEqual({ ok: false, reason: 'cancelled' })
  })

  it('cancelAll 之后定时器都停了', () => {
    const { reqs, clock } = make<string>()
    reqs.open()
    reqs.open()
    reqs.cancelAll()
    expect(clock.pending()).toBe(0)
    expect(reqs.size()).toBe(0)
  })

  it('没有在等的时候 cancelAll 返回 0，不抛错', () => {
    const { reqs } = make<string>()
    expect(reqs.cancelAll()).toBe(0)
  })
})

describe('默认实现用的是真定时器', () => {
  it('不注入时钟也能跑，超时后 resolve', async () => {
    vi.useFakeTimers()
    try {
      const reqs = createPendingRequests<string>({ timeoutMs: 50 })
      const { wait } = reqs.open()
      vi.advanceTimersByTime(60)
      await expect(wait).resolves.toEqual({ ok: false, reason: 'timeout' })
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('默认 id 不重复', () => {
    const reqs = createPendingRequests<string>({ timeoutMs: 1000 })
    const ids = new Set(Array.from({ length: 200 }, () => reqs.open().id))
    expect(ids.size).toBe(200)
  })
})
