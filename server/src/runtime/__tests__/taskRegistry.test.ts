/**
 * 活动任务注册表的判据
 *
 * 重点是那条 ABA 竞态 —— 它是拆层前就存在的真 bug，
 * 只在「用户取消后马上重发」时出现，靠手测几乎撞不到。
 * 这一组就是它的复现脚本。
 */

import { describe, it, expect } from 'vitest'
import { ActiveTaskRegistry, workspaceKey } from '../taskRegistry'

describe('workspaceKey', () => {
  it('按 <域>:<id> 构造', () => {
    expect(workspaceKey('deck', 42)).toBe('deck:42')
    expect(workspaceKey('research', 'abc')).toBe('research:abc')
  })

  it('不同域的同一个 id 不撞键', () => {
    expect(workspaceKey('deck', 1)).not.toBe(workspaceKey('research', 1))
  })
})

describe('占用与释放', () => {
  it('空闲工作区可以占用', () => {
    const reg = new ActiveTaskRegistry()
    expect(reg.acquire('deck:1')).not.toBeNull()
    expect(reg.isBusy('deck:1')).toBe(true)
  })

  it('已占用时返回 null，不抛错', () => {
    // 「已有任务在跑」是正常的用户操作结果（手快点了两次），不是异常
    const reg = new ActiveTaskRegistry()
    reg.acquire('deck:1')
    expect(reg.acquire('deck:1')).toBeNull()
  })

  it('释放后可以再次占用', () => {
    const reg = new ActiveTaskRegistry()
    const lease = reg.acquire('deck:1')!
    expect(reg.release(lease)).toBe(true)
    expect(reg.isBusy('deck:1')).toBe(false)
    expect(reg.acquire('deck:1')).not.toBeNull()
  })

  it('lease 带着可用的 AbortSignal', () => {
    const reg = new ActiveTaskRegistry()
    const lease = reg.acquire('deck:1')!
    expect(lease.signal.aborted).toBe(false)
    reg.cancel('deck:1')
    expect(lease.signal.aborted).toBe(true)
  })
})

describe('按工作区键隔离 —— 修的是「按 userId 键」那个限制', () => {
  it('不同 deck 的任务可以同时跑', () => {
    // 拆层前按 userId 键，一个用户打开两份演示文稿也只能跑一个
    const reg = new ActiveTaskRegistry()
    expect(reg.acquire('deck:1')).not.toBeNull()
    expect(reg.acquire('deck:2')).not.toBeNull()
    expect(reg.activeKeys()).toEqual(['deck:1', 'deck:2'])
  })

  it('同一个 deck 仍然串行 —— 画布是单一权威，并行就是改动丢失', () => {
    const reg = new ActiveTaskRegistry()
    reg.acquire('deck:1')
    expect(reg.acquire('deck:1')).toBeNull()
  })

  it('取消只影响被点名的工作区', () => {
    const reg = new ActiveTaskRegistry()
    const a = reg.acquire('deck:1')!
    const b = reg.acquire('deck:2')!
    reg.cancel('deck:1')
    expect(a.signal.aborted).toBe(true)
    expect(b.signal.aborted).toBe(false)
  })
})

describe('ABA 竞态 —— 拆层前的真 bug，这组是它的复现脚本', () => {
  it('迟到的 release 删不掉后来者的注册', () => {
    const reg = new ActiveTaskRegistry()

    // 任务 A 开跑
    const leaseA = reg.acquire('deck:1')!

    // 用户取消 A。注意：cancel 只 abort，不注销
    expect(reg.cancel('deck:1')).toBe(true)
    expect(leaseA.signal.aborted).toBe(true)

    // A 收尾，凭自己的收据注销
    expect(reg.release(leaseA)).toBe(true)

    // 用户重发，任务 B 占上
    const leaseB = reg.acquire('deck:1')!
    expect(reg.isBusy('deck:1')).toBe(true)

    // A 的 finally 迟到了，又拿旧收据注销一次 —— 必须无效
    expect(reg.release(leaseA)).toBe(false)
    expect(reg.isBusy('deck:1')).toBe(true)

    // B 的注册完好：还是占用中，且取消打得中 B
    expect(reg.acquire('deck:1')).toBeNull()
    reg.cancel('deck:1')
    expect(leaseB.signal.aborted).toBe(true)
  })

  it('负对照：如果注销不校验收据，B 的注册就会被删掉', () => {
    // 这条不是测产品代码，是把 bug 本身钉下来 ——
    // 模拟「按键删除、不看收据」的旧实现，确认它确实会漏
    const naive = new Map<string, string>()
    naive.set('deck:1', 'A')
    naive.delete('deck:1') // 取消时删
    naive.set('deck:1', 'B') // 新任务占上
    naive.delete('deck:1') // A 的 finally 迟到，按键删 → 删掉了 B

    expect(naive.has('deck:1')).toBe(false) // ← 旧实现在这里漏了
    // 对照：新实现在同一序列下 B 的注册仍在（见上一条）
  })

  it('取消后、收尾前，该键仍然占用', () => {
    // 这一条是**刻意的行为**，不是遗漏：
    // 上一轮的收尾写入还没跑完，此刻放新任务进来就是
    // BitFun 状态机 FINISHING 要防的「排队输入和收尾写入抢跑」
    const reg = new ActiveTaskRegistry()
    const lease = reg.acquire('deck:1')!
    reg.cancel('deck:1')
    expect(reg.isBusy('deck:1')).toBe(true)
    expect(reg.acquire('deck:1')).toBeNull()

    reg.release(lease)
    expect(reg.acquire('deck:1')).not.toBeNull()
  })
})

describe('边界情况', () => {
  it('取消不存在的工作区返回 false', () => {
    expect(new ActiveTaskRegistry().cancel('deck:404')).toBe(false)
  })

  it('释放已释放的 lease 返回 false，不抛错', () => {
    const reg = new ActiveTaskRegistry()
    const lease = reg.acquire('deck:1')!
    expect(reg.release(lease)).toBe(true)
    expect(reg.release(lease)).toBe(false)
  })

  it('两个注册表互不影响 —— 没有隐藏的模块级单例', () => {
    const a = new ActiveTaskRegistry()
    const b = new ActiveTaskRegistry()
    a.acquire('deck:1')
    expect(b.isBusy('deck:1')).toBe(false)
  })
})

describe('cancelAllMatching', () => {
  it('按前缀批量取消并注销', () => {
    const reg = new ActiveTaskRegistry()
    const d1 = reg.acquire('deck:1')!
    const d2 = reg.acquire('deck:2')!
    const r1 = reg.acquire('research:9')!

    expect(reg.cancelAllMatching(k => k.startsWith('deck:'))).toBe(2)
    expect(d1.signal.aborted).toBe(true)
    expect(d2.signal.aborted).toBe(true)
    expect(r1.signal.aborted).toBe(false)
    expect(reg.activeKeys()).toEqual(['research:9'])
  })

  it('批量取消会注销 —— 宿主没了就不该留占用', () => {
    // 用于登出 / 连接断开：那时没有收据可用，
    // 留着注册会让这个键永远占用
    const reg = new ActiveTaskRegistry()
    reg.acquire('deck:1')
    reg.cancelAllMatching(() => true)
    expect(reg.isBusy('deck:1')).toBe(false)
    expect(reg.acquire('deck:1')).not.toBeNull()
  })

  it('没有命中时返回 0', () => {
    const reg = new ActiveTaskRegistry()
    reg.acquire('deck:1')
    expect(reg.cancelAllMatching(k => k.startsWith('research:'))).toBe(0)
  })
})
