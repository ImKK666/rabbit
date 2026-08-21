/**
 * 崩溃捕获的判据
 *
 * 这一组防的是**错误处理路径自己再出错** —— 那会把原始错误彻底盖掉，
 * 结果比没有捕获还糟：白屏依旧，而且现在还多了一条误导的错误。
 */

import { describe, it, expect, vi } from 'vitest'
import {
  formatCrash, pushCrash, readCrashLog, writeCrashLog, clearCrashLog,
  CRASH_LOG_KEY, MAX_CRASHES, type CrashRecord,
} from '../crashLog'

const rec = (message: string): CrashRecord => ({ at: '2026-08-21T00:00:00Z', source: 'vue', message })

const fakeStorage = (initial: Record<string, string> = {}) => {
  const data = { ...initial }
  return {
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => { data[k] = v },
    removeItem: (k: string) => { delete data[k] },
    _data: data,
  }
}

describe('formatCrash · 什么都能整成一条记录', () => {
  it('Error 拿 message 和 stack', () => {
    const r = formatCrash(new Error('炸了'), 'vue', { component: 'Foo', hook: 'render' })
    expect(r).toMatchObject({ source: 'vue', message: '炸了', component: 'Foo', hook: 'render' })
    expect(r.stack).toBeTruthy()
  })

  it.each([
    ['字符串', 'plain string'],
    ['数字', 42],
    ['null', null],
    ['undefined', undefined],
    ['对象', { weird: true }],
  ])('%s 也不抛', (_label, thrown) => {
    expect(() => formatCrash(thrown, 'window')).not.toThrow()
    expect(formatCrash(thrown, 'window').message).toBeTruthy()
  })

  it('超长内容被截断 —— 一条 10MB 的 stack 会把 localStorage 撑爆', () => {
    const e = new Error('x'.repeat(5000))
    e.stack = 'y'.repeat(50000)
    const r = formatCrash(e, 'vue')
    expect(r.message.length).toBeLessThanOrEqual(501)
    expect(r.stack!.length).toBeLessThanOrEqual(2001)
  })
})

describe('pushCrash · 满了丢新的，不丢旧的', () => {
  /**
   * 和常见 ring buffer 反着来。一次崩溃常连环触发十几条，
   * **第一条才是根因**，后面全是余波 —— 丢旧留新等于把唯一有用的挤掉。
   */
  it('满了之后新的进不来，最早那条还在', () => {
    let list: CrashRecord[] = []
    for (let i = 0; i < MAX_CRASHES + 10; i++) list = pushCrash(list, rec(`e${i}`))
    expect(list).toHaveLength(MAX_CRASHES)
    expect(list[0].message).toBe('e0')
    expect(list.at(-1)!.message).toBe(`e${MAX_CRASHES - 1}`)
  })

  it('不修改入参', () => {
    const a = [rec('a')]
    const b = pushCrash(a, rec('b'))
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(2)
  })
})

describe('读写 · 存储坏了也不能抛', () => {
  it('存了能读回来', () => {
    const s = fakeStorage()
    writeCrashLog([rec('x')], s)
    expect(readCrashLog(s)).toEqual([rec('x')])
    expect(s._data[CRASH_LOG_KEY]).toBeTruthy()
  })

  it('没存过 → 空数组', () => {
    expect(readCrashLog(fakeStorage())).toEqual([])
  })

  it('存的是坏 JSON → 空数组，不抛', () => {
    const s = fakeStorage({ [CRASH_LOG_KEY]: '{不是 json' })
    expect(() => readCrashLog(s)).not.toThrow()
    expect(readCrashLog(s)).toEqual([])
  })

  it('存的不是数组 → 空数组', () => {
    expect(readCrashLog(fakeStorage({ [CRASH_LOG_KEY]: '{"a":1}' }))).toEqual([])
  })

  /**
   * 无痕模式下 `setItem` 抛 QuotaExceeded。
   * **在错误处理路径上再抛一次，会把原始错误彻底盖掉** —— 比没有捕获更糟。
   */
  it('setItem 抛异常时吞掉，不往外冒', () => {
    const s = { setItem: vi.fn(() => { throw new Error('QuotaExceededError') }) }
    expect(() => writeCrashLog([rec('x')], s)).not.toThrow()
    expect(s.setItem).toHaveBeenCalled()
  })

  it('getItem 抛异常时也不冒', () => {
    const s = { getItem: () => { throw new Error('SecurityError') } }
    expect(() => readCrashLog(s)).not.toThrow()
    expect(readCrashLog(s)).toEqual([])
  })

  it('removeItem 抛异常时也不冒', () => {
    const s = { removeItem: () => { throw new Error('nope') } }
    expect(() => clearCrashLog(s)).not.toThrow()
  })
})
