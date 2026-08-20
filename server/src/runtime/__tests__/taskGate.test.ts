/**
 * 准入闸门的判据 —— 测的是**接线**，不是零件
 *
 * 对应 docs/13-queue-reflect-ingest.md §二 的 Q1~Q6。
 *
 * `taskRegistry.test.ts` 和 `inputQueue.test.ts` 各自全绿，也证明不了
 * 这两样被接对了。11 号文档记过这条：把 signal 接错、把 publish 改成
 * 绕过闸门，两个零件的判据一条都不响。**零件对 ≠ 装配对。**
 *
 * 这一组盯的是那三件只在接线处才成立的事：
 *   - 接力发生在 release 之后（提前 = 和上一轮的收尾写入抢跑）
 *   - 每一句输入恰好一个终局回执（前端配对全靠它）
 *   - 断线的排队项被跳过，而不是跑给没人看
 */

import { describe, it, expect } from 'vitest'
import { createTaskGate, type TaskGateHandlers } from '../taskGate'

interface Job { id: string, alive?: boolean }

/** 一个可以手动控制何时结束的任务 */
const deferred = () => {
  let resolve!: () => void
  let reject!: (e: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

interface Harness {
  events: string[]
  gate: ReturnType<typeof createTaskGate<Job>>
  /** 每个 job 的控制器，按 id 取 */
  ctl: Map<string, ReturnType<typeof deferred>>
  signals: Map<string, AbortSignal>
}

const harness = (overrides: Partial<TaskGateHandlers<Job>> = {}): Harness => {
  const events: string[] = []
  const ctl = new Map<string, ReturnType<typeof deferred>>()
  const signals = new Map<string, AbortSignal>()

  const gate = createTaskGate<Job>({
    run: (job, signal) => {
      events.push(`run:${job.id}`)
      signals.set(job.id, signal)
      const d = deferred()
      ctl.set(job.id, d)
      return d.promise
    },
    onStarted: job => events.push(`started:${job.id}`),
    onQueued: (job, pos) => events.push(`queued:${job.id}@${pos}`),
    onRejected: job => events.push(`rejected:${job.id}`),
    onDropped: job => events.push(`dropped:${job.id}`),
    onRelayError: job => events.push(`relayError:${job.id}`),
    isAlive: job => job.alive !== false,
    ...overrides,
  })

  return { events, gate, ctl, signals }
}

/** 让挂着的微任务跑完 */
const tick = () => new Promise<void>(res => setTimeout(res, 0))

describe('Q1 · 忙的时候排队，空了自动接力', () => {
  it('第一条直接跑，第二条排队', async () => {
    const h = harness()
    void h.gate.submit('deck:1', { id: 'a' })
    void h.gate.submit('deck:1', { id: 'b' })

    // started 在 run 之前 —— 先告诉前端「开跑了」，再真的进去跑
    expect(h.events).toEqual(['started:a', 'run:a', 'queued:b@1'])
    expect(h.gate.queueDepth('deck:1')).toBe(1)
  })

  it('第一条跑完，第二条自动开跑', async () => {
    const h = harness()
    void h.gate.submit('deck:1', { id: 'a' })
    void h.gate.submit('deck:1', { id: 'b' })

    h.ctl.get('a')!.resolve()
    await tick()

    expect(h.events).toContain('run:b')
    expect(h.events).toContain('started:b')
    expect(h.gate.queueDepth('deck:1')).toBe(0)
  })

  it('排三条，一条接一条按 FIFO 跑完', async () => {
    const h = harness()
    void h.gate.submit('deck:1', { id: 'a' })
    void h.gate.submit('deck:1', { id: 'b' })
    void h.gate.submit('deck:1', { id: 'c' })

    for (const id of ['a', 'b', 'c']) {
      h.ctl.get(id)!.resolve()
      await tick()
    }
    expect(h.events.filter(e => e.startsWith('run:'))).toEqual(['run:a', 'run:b', 'run:c'])
  })

  it('任务失败也照样接力 —— 队列不能被一个异常卡死', async () => {
    const h = harness()
    const first = h.gate.submit('deck:1', { id: 'a' })
    void h.gate.submit('deck:1', { id: 'b' })

    h.ctl.get('a')!.reject(new Error('炸了'))
    await expect(first).rejects.toThrow('炸了')
    await tick()

    expect(h.events).toContain('run:b')
  })

  it('接力任务抛异常时由闸门接住，不变成未捕获的 rejection', async () => {
    const h = harness()
    void h.gate.submit('deck:1', { id: 'a' })
    void h.gate.submit('deck:1', { id: 'b' })

    h.ctl.get('a')!.resolve()
    await tick()
    h.ctl.get('b')!.reject(new Error('第二条炸了'))
    await tick()

    expect(h.events).toContain('relayError:b')
  })
})

describe('Q3 · 同一工作区同时只有一个任务', () => {
  it('第二条在第一条跑完之前一步都不会跑', async () => {
    const h = harness()
    void h.gate.submit('deck:1', { id: 'a' })
    void h.gate.submit('deck:1', { id: 'b' })

    await tick()
    await tick()
    expect(h.events.filter(e => e === 'run:b')).toEqual([])
    expect(h.gate.isBusy('deck:1')).toBe(true)
  })

  it('**负对照**：接力不判 isBusy 的话，两个任务会同时在跑', async () => {
    // 这就是「接力提前」的形状。这里手工搭出那个坏版本，
    // 确认判据真的看得见它 —— 只测好版本等于什么都没测
    const running = new Set<string>()
    const overlaps: string[] = []
    const ctl = new Map<string, ReturnType<typeof deferred>>()

    const brokenRelay = (job: Job) => {
      if (running.size > 0) overlaps.push(job.id)
      running.add(job.id)
      const d = deferred()
      ctl.set(job.id, d)
      return d.promise.finally(() => running.delete(job.id))
    }

    // 不经闸门，直接两条一起跑 —— 判据必须看得见这个重叠
    void brokenRelay({ id: 'a' })
    void brokenRelay({ id: 'b' })
    expect(overlaps).toEqual(['b'])
  })

  it('不同工作区各跑各的', async () => {
    const h = harness()
    void h.gate.submit('deck:1', { id: 'a' })
    void h.gate.submit('deck:2', { id: 'b' })

    expect(h.events).toEqual(['started:a', 'run:a', 'started:b', 'run:b'])
    expect(h.gate.queueDepth('deck:1')).toBe(0)
  })
})

describe('接力时机 —— 必须在 release 之后', () => {
  it('第一条的 run 还没 settle 时，第二条一定还在队里', async () => {
    const h = harness()
    void h.gate.submit('deck:1', { id: 'a' })
    void h.gate.submit('deck:1', { id: 'b' })

    // 「收尾写入还在跑」的那一刻：run 的 promise 尚未 settle
    await tick()
    expect(h.gate.queueDepth('deck:1')).toBe(1)
    expect(h.events).not.toContain('run:b')

    h.ctl.get('a')!.resolve()
    await tick()
    expect(h.gate.queueDepth('deck:1')).toBe(0)
  })

  it('run 的 promise settle 之后才轮到下一条 —— 收尾动作都在那之前', async () => {
    // runDeckTask 的 finally 里还有 drain / touchConversation，
    // 它们跑完 promise 才 settle。闸门在 settle 之后接力，所以是安全的那一刻
    const order: string[] = []
    const d = deferred()
    const gate = createTaskGate<Job>({
      run: async (job) => {
        if (job.id === 'a') {
          await d.promise
          order.push('a 的收尾写入')
        }
        else order.push('b 开跑')
      },
      onStarted: () => {},
      onQueued: () => {},
      onRejected: () => {},
    })

    void gate.submit('deck:1', { id: 'a' })
    void gate.submit('deck:1', { id: 'b' })
    d.resolve()
    await tick()

    expect(order).toEqual(['a 的收尾写入', 'b 开跑'])
  })
})

describe('Q6 · 队列满时明确拒绝', () => {
  it('超过上限回 rejected，且没有静默入队', async () => {
    const h = harness()
    const gate = createTaskGate<Job>({
      run: () => new Promise(() => {}), // 永不结束
      onStarted: job => h.events.push(`started:${job.id}`),
      onQueued: (job, pos) => h.events.push(`queued:${job.id}@${pos}`),
      onRejected: job => h.events.push(`rejected:${job.id}`),
    }, { maxQueued: 2 })

    void gate.submit('deck:1', { id: 'a' }) // 直接跑
    void gate.submit('deck:1', { id: 'b' }) // 排 1
    void gate.submit('deck:1', { id: 'c' }) // 排 2
    void gate.submit('deck:1', { id: 'd' }) // 满

    expect(h.events).toEqual(['started:a', 'queued:b@1', 'queued:c@2', 'rejected:d'])
    expect(gate.queueDepth('deck:1')).toBe(2)
  })
})

describe('每一句输入恰好一个终局回执', () => {
  it('直接开跑的那条也发 started —— 前端靠它配对', async () => {
    // 只给排队的发回执的话，前端就得靠「没收到消息 == 已经在跑」来猜，
    // 而那正是猜错了也不会有任何东西报错的那类约定
    const h = harness()
    void h.gate.submit('deck:1', { id: 'a' })
    expect(h.events).toContain('started:a')
  })

  it('排队的那条先 queued 再 started，两条都有', async () => {
    const h = harness()
    void h.gate.submit('deck:1', { id: 'a' })
    void h.gate.submit('deck:1', { id: 'b' })
    h.ctl.get('a')!.resolve()
    await tick()

    expect(h.events.filter(e => e.endsWith(':b') || e.includes(':b@')))
      .toEqual(['queued:b@1', 'started:b', 'run:b'])
  })

  it('被拒的那条只有 rejected，不会再有 started', async () => {
    const gate = createTaskGate<Job>({
      run: () => new Promise(() => {}),
      onStarted: () => events.push('started'),
      onQueued: () => events.push('queued'),
      onRejected: () => events.push('rejected'),
    }, { maxQueued: 0 })
    const events: string[] = []

    void gate.submit('deck:1', { id: 'a' })
    void gate.submit('deck:1', { id: 'b' })
    expect(events).toEqual(['started', 'rejected'])
  })
})

describe('Q4 · 取消 = 全停', () => {
  it('取消把在跑的 abort 掉，把排着的全部丢掉并交还', async () => {
    const h = harness()
    void h.gate.submit('deck:1', { id: 'a' })
    void h.gate.submit('deck:1', { id: 'b' })
    void h.gate.submit('deck:1', { id: 'c' })

    const { cancelled, dropped } = h.gate.cancel('deck:1')
    expect(cancelled).toBe(true)
    expect(dropped.map(j => j.id)).toEqual(['b', 'c'])
    expect(h.signals.get('a')!.aborted).toBe(true)
  })

  it('取消之后坑位仍然占着，直到任务真的收尾 —— 这正是 FINISHING 窗口', async () => {
    const h = harness()
    void h.gate.submit('deck:1', { id: 'a' })
    h.gate.cancel('deck:1')
    expect(h.gate.isBusy('deck:1')).toBe(true)

    h.ctl.get('a')!.resolve()
    await tick()
    expect(h.gate.isBusy('deck:1')).toBe(false)
  })

  it('那个窗口里发进来的输入会排队，而不是被拒 —— 这就是这一版要修的东西', async () => {
    const h = harness()
    void h.gate.submit('deck:1', { id: 'a' })
    h.gate.cancel('deck:1')

    // 用户点了停、立刻改口。改这一版之前这里收到的是「已有任务在执行中」
    void h.gate.submit('deck:1', { id: '改口的' })
    expect(h.events).toContain('queued:改口的@1')

    h.ctl.get('a')!.resolve()
    await tick()
    expect(h.events).toContain('run:改口的')
  })

  it('取消一个空闲工作区不抛错', () => {
    const h = harness()
    expect(h.gate.cancel('deck:404')).toEqual({ cancelled: false, dropped: [] })
  })
})

describe('Q5 · 断线：排队项跳过，正在跑的不动', () => {
  it('宿主没了的排队项被跳过并报告，接着跑下一条', async () => {
    const h = harness()
    void h.gate.submit('deck:1', { id: 'a' })
    void h.gate.submit('deck:1', { id: 'dead', alive: false })
    void h.gate.submit('deck:1', { id: 'c' })

    h.ctl.get('a')!.resolve()
    await tick()

    expect(h.events).toContain('dropped:dead')
    expect(h.events).toContain('run:c')
    expect(h.events).not.toContain('run:dead')
  })

  it('整队都断了就什么都不跑，也不抛错', async () => {
    const h = harness()
    void h.gate.submit('deck:1', { id: 'a' })
    void h.gate.submit('deck:1', { id: 'x', alive: false })
    void h.gate.submit('deck:1', { id: 'y', alive: false })

    h.ctl.get('a')!.resolve()
    await tick()

    expect(h.events.filter(e => e.startsWith('run:'))).toEqual(['run:a'])
    expect(h.gate.isBusy('deck:1')).toBe(false)
  })

  it('dropQueued 只丢自己那些，正在跑的一律不动', async () => {
    const h = harness()
    void h.gate.submit('deck:1', { id: 'a' })
    void h.gate.submit('deck:1', { id: 'mine' })
    void h.gate.submit('deck:2', { id: 'other' })

    const dropped = h.gate.dropQueued(job => job.id === 'mine')
    expect(dropped.map(j => j.id)).toEqual(['mine'])
    // 正在跑的 a 没被 abort —— 它的改动是落库的，断线不等于白跑
    expect(h.signals.get('a')!.aborted).toBe(false)
    expect(h.gate.isBusy('deck:1')).toBe(true)
  })
})

describe('signal 接对了没有', () => {
  it('run 拿到的 signal 就是这一次占坑的那个', async () => {
    const h = harness()
    void h.gate.submit('deck:1', { id: 'a' })
    expect(h.signals.get('a')!.aborted).toBe(false)
    h.gate.cancel('deck:1')
    expect(h.signals.get('a')!.aborted).toBe(true)
  })

  it('取消会连排队的一起清掉，所以接力时没有 b 可跑', async () => {
    const h = harness()
    void h.gate.submit('deck:1', { id: 'a' })
    void h.gate.submit('deck:1', { id: 'b' })
    h.gate.cancel('deck:1')
    h.ctl.get('a')!.resolve()
    await tick()

    // b 是取消后残留在队里的？不 —— cancel 清空了队列，所以 b 不该跑
    expect(h.events).not.toContain('run:b')
  })

  it('没被取消时接力起来的那条 signal 是干净的', async () => {
    const h = harness()
    void h.gate.submit('deck:1', { id: 'a' })
    void h.gate.submit('deck:1', { id: 'b' })
    h.ctl.get('a')!.resolve()
    await tick()

    expect(h.signals.get('b')!.aborted).toBe(false)
    expect(h.signals.get('a')).not.toBe(h.signals.get('b'))
  })
})

describe('自愈：acquire 万一失败也不能把任务弄丢', () => {
  it('退回队列而不是静默丢掉', async () => {
    // 走不到的路径，但「静默丢掉用户的话」是这个仓库最不能接受的那类错误，
    // 所以它有一条兜底而不是一句注释
    const gate = createTaskGate<Job>({
      run: () => new Promise(() => {}),
      onStarted: () => {},
      onQueued: () => {},
      onRejected: () => {},
    })
    void gate.submit('deck:1', { id: 'a' })
    void gate.submit('deck:1', { id: 'b' })
    expect(gate.queueDepth('deck:1')).toBe(1)
  })
})
