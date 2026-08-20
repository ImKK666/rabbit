/**
 * 排队输入的判据
 *
 * 对应 docs/13-queue-reflect-ingest.md §二 的 Q1~Q6。
 *
 * 这一组守的两件事，坏掉时都**不会有任何东西报错**：
 *   - 排队的输入被静默丢掉（用户发了一句话，它消失了）
 *   - 接力和上一轮的收尾写入抢跑（库与画布不一致，最难查的一类）
 *
 * 第二件在纯数据结构这一层测不到时机，只能测「取出来的顺序对不对」；
 * 时机由 `ActiveTaskRegistry` 配合的那一组（下面「接力时机」）和端到端判据守。
 */

import { describe, it, expect } from 'vitest'
import { InputQueue, DEFAULT_MAX_PER_KEY } from '../inputQueue'
import { ActiveTaskRegistry } from '../taskRegistry'

interface Msg { text: string, owner?: string }

describe('入队与出队', () => {
  it('空队列入队排在第 1 位', () => {
    const q = new InputQueue<Msg>()
    expect(q.enqueue('deck:1', { text: 'a' })).toEqual({ position: 1 })
    expect(q.size('deck:1')).toBe(1)
  })

  it('position 是排在第几位，1 表示下一个就是它', () => {
    const q = new InputQueue<Msg>()
    expect(q.enqueue('deck:1', { text: 'a' })?.position).toBe(1)
    expect(q.enqueue('deck:1', { text: 'b' })?.position).toBe(2)
    expect(q.enqueue('deck:1', { text: 'c' })?.position).toBe(3)
  })

  it('FIFO —— 先发的先跑', () => {
    const q = new InputQueue<Msg>()
    q.enqueue('deck:1', { text: 'a' })
    q.enqueue('deck:1', { text: 'b' })
    expect(q.take('deck:1')?.text).toBe('a')
    expect(q.take('deck:1')?.text).toBe('b')
    expect(q.take('deck:1')).toBeUndefined()
  })

  it('空队列取出返回 undefined，不抛错', () => {
    const q = new InputQueue<Msg>()
    expect(q.take('deck:404')).toBeUndefined()
  })
})

describe('Q6 · 队列满时明确拒绝，不静默丢', () => {
  it('超过上限返回 null', () => {
    const q = new InputQueue<Msg>(2)
    expect(q.enqueue('deck:1', { text: 'a' })).not.toBeNull()
    expect(q.enqueue('deck:1', { text: 'b' })).not.toBeNull()
    expect(q.enqueue('deck:1', { text: 'c' })).toBeNull()
  })

  it('被拒的那条**没有**进队列 —— 拒绝要是真的拒绝', () => {
    // 静默丢是这个仓库的典型失败模式：返回了 null 却仍然入了队，
    // 表现是「提示排队已满，过一会儿它又自己跑了」
    const q = new InputQueue<Msg>(1)
    q.enqueue('deck:1', { text: 'a' })
    q.enqueue('deck:1', { text: '被拒的' })
    expect(q.size('deck:1')).toBe(1)
    expect(q.take('deck:1')?.text).toBe('a')
    expect(q.take('deck:1')).toBeUndefined()
  })

  it('默认上限是 3', () => {
    const q = new InputQueue<Msg>()
    for (let i = 0; i < DEFAULT_MAX_PER_KEY; i++) {
      expect(q.enqueue('deck:1', { text: String(i) })).not.toBeNull()
    }
    expect(q.enqueue('deck:1', { text: 'over' })).toBeNull()
  })

  it('取走一条之后又能再排一条', () => {
    const q = new InputQueue<Msg>(1)
    q.enqueue('deck:1', { text: 'a' })
    expect(q.enqueue('deck:1', { text: 'b' })).toBeNull()
    q.take('deck:1')
    expect(q.enqueue('deck:1', { text: 'b' })).not.toBeNull()
  })
})

describe('按工作区隔离', () => {
  it('不同 deck 各排各的', () => {
    const q = new InputQueue<Msg>()
    q.enqueue('deck:1', { text: 'a' })
    q.enqueue('deck:2', { text: 'b' })
    expect(q.size('deck:1')).toBe(1)
    expect(q.size('deck:2')).toBe(1)
    expect(q.take('deck:1')?.text).toBe('a')
    expect(q.size('deck:2')).toBe(1)
  })

  it('一个 deck 排满不影响另一个', () => {
    const q = new InputQueue<Msg>(1)
    q.enqueue('deck:1', { text: 'a' })
    expect(q.enqueue('deck:1', { text: 'b' })).toBeNull()
    expect(q.enqueue('deck:2', { text: 'c' })).not.toBeNull()
  })

  it('空掉的队列从表里删掉 —— 不然 keys() 会越攒越多', () => {
    const q = new InputQueue<Msg>()
    q.enqueue('deck:1', { text: 'a' })
    q.take('deck:1')
    expect(q.keys()).toEqual([])
    expect(q.total()).toBe(0)
  })
})

describe('Q4 · 取消 = 全停，且被丢掉的项要还给调用方', () => {
  it('clear 清空该工作区', () => {
    const q = new InputQueue<Msg>()
    q.enqueue('deck:1', { text: 'a' })
    q.enqueue('deck:1', { text: 'b' })
    expect(q.clear('deck:1')).toHaveLength(2)
    expect(q.size('deck:1')).toBe(0)
  })

  it('clear 返回被丢掉的全部项 —— 静默丢掉用户的话是不可接受的', () => {
    // 返回它们，调用方才有机会说一声「另有 N 条排队输入已丢弃」
    const q = new InputQueue<Msg>()
    q.enqueue('deck:1', { text: 'a' })
    q.enqueue('deck:1', { text: 'b' })
    expect(q.clear('deck:1').map(m => m.text)).toEqual(['a', 'b'])
  })

  it('clear 不碰别的工作区', () => {
    const q = new InputQueue<Msg>()
    q.enqueue('deck:1', { text: 'a' })
    q.enqueue('deck:2', { text: 'b' })
    q.clear('deck:1')
    expect(q.size('deck:2')).toBe(1)
  })

  it('clear 一个空队列返回空数组，不抛错', () => {
    expect(new InputQueue<Msg>().clear('deck:404')).toEqual([])
  })
})

describe('Q5 · 断线清理：只丢自己那些，别人的不动', () => {
  it('按谓词丢，返回被丢掉的', () => {
    const q = new InputQueue<Msg>()
    q.enqueue('deck:1', { text: 'a', owner: 'ws1' })
    q.enqueue('deck:1', { text: 'b', owner: 'ws2' })
    q.enqueue('deck:2', { text: 'c', owner: 'ws1' })

    const dropped = q.dropWhere(m => m.owner === 'ws1')
    expect(dropped.map(m => m.text)).toEqual(['a', 'c'])
  })

  it('别的连接的排队项一条都不动', () => {
    const q = new InputQueue<Msg>()
    q.enqueue('deck:1', { text: 'a', owner: 'ws1' })
    q.enqueue('deck:1', { text: 'b', owner: 'ws2' })
    q.dropWhere(m => m.owner === 'ws1')
    expect(q.size('deck:1')).toBe(1)
    expect(q.take('deck:1')?.text).toBe('b')
  })

  it('丢完之后仍然保持 FIFO —— 中间挖走一条不能打乱剩下的顺序', () => {
    const q = new InputQueue<Msg>(5)
    q.enqueue('deck:1', { text: 'a', owner: 'ws1' })
    q.enqueue('deck:1', { text: 'b', owner: 'ws2' })
    q.enqueue('deck:1', { text: 'c', owner: 'ws1' })
    q.enqueue('deck:1', { text: 'd', owner: 'ws2' })
    q.dropWhere(m => m.owner === 'ws1')
    expect([q.take('deck:1')?.text, q.take('deck:1')?.text]).toEqual(['b', 'd'])
  })

  it('整队被丢空时该键从表里删掉', () => {
    const q = new InputQueue<Msg>()
    q.enqueue('deck:1', { text: 'a', owner: 'ws1' })
    q.dropWhere(m => m.owner === 'ws1')
    expect(q.keys()).toEqual([])
  })

  it('谓词也拿得到键 —— 断线时可能要按域判断', () => {
    const q = new InputQueue<Msg>()
    q.enqueue('deck:1', { text: 'a' })
    q.enqueue('research:1', { text: 'b' })
    const dropped = q.dropWhere((_, key) => key.startsWith('deck:'))
    expect(dropped.map(m => m.text)).toEqual(['a'])
    expect(q.size('research:1')).toBe(1)
  })
})

/**
 * Q1 / Q3 · 接力时机
 *
 * 队列本身管不住时机，但「队列 + 注册表」这两个零件**装在一起**之后
 * 的行为是可以测的。11 号文档那条教训在这里同样适用：
 * **零件对 ≠ 装配对** —— `cancellation.ts` 和 `commit.ts` 各自全绿，
 * 接错线时两边的判据一条都不响。
 */
describe('Q1/Q3 · 队列与注册表装在一起', () => {
  /** 模拟 orchestrator 的接力：release 之后才取下一条 */
  const relayAfterRelease = (reg: ActiveTaskRegistry, q: InputQueue<Msg>, key: string) => {
    const lease = reg.acquire(key)
    if (!lease) return null
    // …任务跑完…
    reg.release(lease)
    if (reg.isBusy(key)) return null
    return q.take(key) ?? null
  }

  it('busy 时入队，第一轮释放后取得到第二条', () => {
    const reg = new ActiveTaskRegistry()
    const q = new InputQueue<Msg>()

    const lease = reg.acquire('deck:1')!
    expect(reg.acquire('deck:1')).toBeNull() // 第二句被挡
    q.enqueue('deck:1', { text: '第二句' })

    reg.release(lease)
    expect(q.take('deck:1')?.text).toBe('第二句')
  })

  it('接力时同一工作区不会有两个任务同时持坑', () => {
    const reg = new ActiveTaskRegistry()
    const q = new InputQueue<Msg>()
    q.enqueue('deck:1', { text: '排着的' })

    const next = relayAfterRelease(reg, q, 'deck:1')
    expect(next?.text).toBe('排着的')
    // 上一轮已经释放，新一轮还没占 —— 此刻是空闲的，不是双占
    expect(reg.isBusy('deck:1')).toBe(false)
  })

  it('**负对照**：release 之前就取，会取到一条本该等着的输入', () => {
    // 这就是「接力提前」的形状：坑位还占着（收尾写入还在跑），
    // 队列却已经把下一条交出去了 —— 端到端表现是库与画布不一致
    const reg = new ActiveTaskRegistry()
    const q = new InputQueue<Msg>()
    const lease = reg.acquire('deck:1')!
    q.enqueue('deck:1', { text: '排着的' })

    const tooEarly = q.take('deck:1')
    expect(tooEarly?.text).toBe('排着的')
    expect(reg.isBusy('deck:1')).toBe(true) // ← 还占着坑就把下一条放出去了
    reg.release(lease)
  })

  it('别人抢先占坑时不取队首 —— 那一条留给它收尾时再叫', () => {
    const reg = new ActiveTaskRegistry()
    const q = new InputQueue<Msg>()
    q.enqueue('deck:1', { text: '排着的' })

    reg.acquire('deck:1') // 一条全新的用户消息抢先占了坑
    const next = reg.isBusy('deck:1') ? null : q.take('deck:1')
    expect(next).toBeNull()
    expect(q.size('deck:1')).toBe(1) // 还在队里，没漏掉
  })
})
