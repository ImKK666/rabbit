/**
 * 崩溃捕获的判据
 *
 * 这一组防的是**错误处理路径自己再出错** —— 那会把原始错误彻底盖掉，
 * 结果比没有捕获还糟：白屏依旧，而且现在还多了一条误导的错误。
 */

import { describe, it, expect, vi } from 'vitest'
import {
  formatCrash, pushCrash, readCrashLog, writeCrashLog, clearCrashLog, showCrashBanner,
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


/**
 * 假 document —— **不装 jsdom**，照 `useStickToBottom.test.ts` 那条既有规矩。
 * 横幅只用到 createElement / append / style / textContent 这几样，假一份就够。
 */
const fakeDoc = () => {
  const mk = (tag: string) => {
    const el = {
      tag,
      style: { cssText: '' },
      textContent: '',
      children: [] as unknown[],
      onclick: null as unknown,
      append(...cs: unknown[]) { el.children.push(...cs) },
      appendChild(c: unknown) { el.children.push(c); return c },
      remove() {},
      select() {},
      /** 只支持按 tag 名找，够用 */
      querySelectorAll(sel: string) {
        const out: unknown[] = []
        const walk = (n: { tag?: string, children?: unknown[] }) => {
          if (n.tag === sel) out.push(n)
          for (const c of n.children ?? []) walk(c as never)
        }
        for (const c of el.children) walk(c as never)
        return out
      },
    }
    return el
  }
  const body = mk('body')
  return {
    createElement: mk,
    body,
    execCommand: () => true,
  } as unknown as Document & { body: ReturnType<typeof mk> }
}

/** 把一棵假树上的文字拼起来 —— 假元素没有真正的 textContent 继承 */
const textOf = (n: { textContent?: string, children?: unknown[] }): string =>
  (n.textContent ?? '') + (n.children ?? []).map(c => textOf(c as never)).join(' ')

describe('崩溃横幅 · 它自己不能成为第二个故障点', () => {
  /**
   * 横幅存在的理由：**「打开控制台」不是所有人都做得到。**
   * Safari 的开发者菜单默认是关的，要先进设置勾「显示网页开发者功能」——
   * 一个排查步骤如果要求用户先改浏览器设置，现实里它就是不会被执行的。
   */
  it('没有记录时什么都不挂', () => {
    const doc = fakeDoc()
    expect(showCrashBanner([], doc)).toBeNull()
    expect(doc.body.children).toHaveLength(0)
  })

  /**
   * **断言用的字符串必须不可能和界面文案撞车。**
   *
   * 第一版拿「根因 / 余波1」当消息内容，而横幅自己的标题里就写着
   * 「下面是第一条 —— 它才是根因」—— 于是 `toContain('根因')`
   * 匹配的是**界面文案**而不是数据，把 `records[0]` 改成 `records.at(-1)`
   * 测试照样绿。负对照当场抓住。
   */
  it('有记录时挂上，且显示的是**第一条**', () => {
    const doc = fakeDoc()
    const bar = showCrashBanner(
      [rec('ZZ_FIRST_ONLY'), rec('ZZ_SECOND'), rec('ZZ_THIRD')], doc)
    expect(bar).not.toBeNull()
    const t = textOf(bar as never)
    expect(t).toContain('ZZ_FIRST_ONLY')
    expect(t).toContain('3 条')
    // 只显示第一条 —— 连环崩溃里后面全是余波
    expect(t).not.toContain('ZZ_SECOND')
    expect(t).not.toContain('ZZ_THIRD')
    expect(doc.body.children).toHaveLength(1)
  })

  it('两个按钮都在', () => {
    const doc = fakeDoc()
    const bar = showCrashBanner([rec('x')], doc)!
    const labels = (bar.querySelectorAll('button') as unknown as { textContent: string }[])
      .map(b => b.textContent)
    expect(labels).toEqual(['复制全部', '清除'])
  })

  /** 记录里带 undefined 字段、奇怪内容，拼字符串时不能炸 */
  it('字段缺一半也不抛', () => {
    const doc = fakeDoc()
    const partial = { at: '', source: 'window', message: 'only message' } as CrashRecord
    expect(() => showCrashBanner([partial], doc)).not.toThrow()
  })

  it('传进来一个坏 document 也只是返回 null，不往外抛', () => {
    const broken = { createElement: () => { throw new Error('nope') } } as unknown as Document
    expect(() => showCrashBanner([rec('x')], broken)).not.toThrow()
    expect(showCrashBanner([rec('x')], broken)).toBeNull()
  })
})
