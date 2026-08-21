/**
 * 渲染后对比度的判据
 *
 * 对应 docs/14-ornament-layer.md 的 O6。
 *
 * **这一组的负对照是现成的，而且是实测来的。**
 * `docs/04-changes.md` R-50「三件只有看截图才发现的事」第 3 件记着：
 * R-48 判过「半透明色块叠在照片上像块污渍」，但只修了 `title-split` ——
 * `stat` 的光晕、`end` 的装饰环、`title-center` 的斜块、`title-split` 的
 * 强调色分界线**漏了整整一轮**。同一段的第 2 件更直接：
 * 「『关键指标』那行黄字压在照片上几乎看不见，**而所有断言都是绿的**」。
 *
 * 所以每一条「量了之后能看见」的断言，都配一条
 * 「同一份数据 `scrimFor` 推算看不见」的断言。
 * **只测新做法看得见，证明不了它比原来强。**
 */

import { describe, it, expect } from 'vitest'
import type { Slide, PPTElement } from '@/types/slides'
import { scrimFor, contrastRatio, CONTRAST_AA, type Palette } from '../design'
import {
  reflectOnContrast,
  describeContrast,
  worstBackdrop,
  MIN_SAMPLED_PIXELS,
  type ContrastSample,
} from '../renderContrast'

const palette = (over: Partial<Palette> = {}): Palette => ({
  background: '#101418',
  surface: '#1a2027',
  primary: '#2f6feb',
  accent: '#e8a33d',
  text: '#ffffff',
  textMuted: '#c3ccd6',
  onPrimary: '#ffffff',
  border: '#2c3742',
  ...over,
} as Palette)

const text = (over: Record<string, unknown> = {}): PPTElement => ({
  id: 'el_t1',
  type: 'text',
  left: 100, top: 100, width: 400, height: 80, rotate: 0,
  content: '<p><span style="font-size:36px">关键指标</span></p>',
  defaultFontName: 'Microsoft YaHei',
  defaultColor: '#ffffff',
  textType: 'title',
  ...over,
} as PPTElement)

const slide = (over: Partial<Slide> = {}): Slide => ({
  id: 'slide_1',
  type: 'content',
  elements: [text()],
  ...over,
} as Slide)

const sample = (over: Partial<ContrastSample> = {}): ContrastSample => ({
  slideId: 'slide_1',
  elementId: 'el_t1',
  textColor: '#ffffff',
  backdrop: ['#101418', '#101418'],
  sampled: 4000,
  ...over,
})

// ---------------------------------------------------------------------------

describe('O6 · 装饰盖在文字上：推算看不见，实测看得见', () => {
  /**
   * 这条就是 R-48 那个 bug 的复现脚本。
   *
   * 场景：深色主题白字 + 一张**暗**照片。`scrimFor` 按图片亮度算，
   * 会得出「这图本来就暗，薄薄压一层就够」——**而且它是对的**，
   * 只看背景图的话确实够。
   *
   * 但版式在遮罩**之上**画了一枚强调色装饰环，正好落在这行字底下。
   * `scrimFor` 对此一无所知。
   */
  it('推算达标 / 实测不达标 —— 两个断言必须同时成立', () => {
    const p = palette()
    const spec = scrimFor(p, { luminance: [0.02, 0.10] }, { direction: 'none' })

    // ① 原来的做法：按图片亮度推算，白字压在遮罩后的暗背景上 —— 达标
    const predicted = contrastRatio(p.text, spec.effectiveBg)
    expect(predicted).toBeGreaterThanOrEqual(CONTRAST_AA)

    // ② 新做法：实测文字底下是那枚强调色装饰环 —— 不达标
    const r = reflectOnContrast([slide()], [sample({ backdrop: ['#e8a33d', '#e8a33d'] })])
    expect(r.issues).toHaveLength(1)
    expect(r.issues[0].ratio).toBeLessThan(CONTRAST_AA)
    expect(r.issues[0]).toMatchObject({ slideIndex: 1, elementId: 'el_t1', worstBg: '#e8a33d' })
  })

  it('背景真的干净时不误报', () => {
    const r = reflectOnContrast([slide()], [sample()])
    expect(r.issues).toHaveLength(0)
    expect(r.measured).toBe(1)
  })
})

describe('O6 · 「最坏那一头」和 scrimFor 用同一条判据', () => {
  /**
   * 取 {p5, p95} 里**离文字亮度更近**的那个，不是一律取亮的。
   * `scrimFor` 的注释 ② 记着：写那条测试时作者一开始断言反了。
   * 这里把两处钉在一起，防的是它们各自漂开。
   */
  it('白字：危险的是亮的那头', () => {
    expect(worstBackdrop('#ffffff', ['#000000', '#dddddd'])).toBe('#dddddd')
  })

  it('黑字：危险的是暗的那头', () => {
    expect(worstBackdrop('#111111', ['#333333', '#ffffff'])).toBe('#333333')
  })

  it('和 scrimFor 的选法一致 —— 换成「一律取亮的」这条必红', () => {
    // 深色主题白字：scrimFor 盯的是 p95（亮部）
    const dark = worstBackdrop('#ffffff', ['#050505', '#f0f0f0'])
    // 浅色主题黑字：scrimFor 盯的是 p5（暗部）。若实现写成「一律取亮的」，下面这条会得到 #f0f0f0
    const light = worstBackdrop('#111111', ['#050505', '#f0f0f0'])
    expect(dark).toBe('#f0f0f0')
    expect(light).toBe('#050505')
    expect(dark).not.toBe(light)
  })
})

describe('O6 · 采样不足时说「没判」，不给一个像结论的数', () => {
  it(`采样 < ${MIN_SAMPLED_PIXELS} → 计入 skipped，不进 issues`, () => {
    const r = reflectOnContrast([slide()], [
      sample({ backdrop: ['#e8a33d', '#e8a33d'], sampled: MIN_SAMPLED_PIXELS - 1 }),
    ])
    expect(r.issues).toHaveLength(0)
    expect(r.skipped).toBe(1)
    expect(r.measured).toBe(0)
  })

  it(`采样刚好 ${MIN_SAMPLED_PIXELS} → 判`, () => {
    const r = reflectOnContrast([slide()], [
      sample({ backdrop: ['#e8a33d', '#e8a33d'], sampled: MIN_SAMPLED_PIXELS }),
    ])
    expect(r.issues).toHaveLength(1)
    expect(r.measured).toBe(1)
  })

  it('没量到的页原样跳过，不拿推算值冒充', () => {
    const r = reflectOnContrast([slide({ id: 'other' })], [sample()])
    expect(r.measured).toBe(0)
    expect(r.skipped).toBe(0)
    expect(r.issues).toHaveLength(0)
  })
})

describe('O6 · 只判文本元素', () => {
  it('图片元素带了采样也不判 —— 对比度只对文字有意义', () => {
    const img = { id: 'el_img', type: 'image', left: 0, top: 0, width: 100, height: 100, rotate: 0, src: 'x', fixedRatio: true } as unknown as PPTElement
    const r = reflectOnContrast(
      [slide({ elements: [img] })],
      [sample({ elementId: 'el_img', backdrop: ['#e8a33d', '#e8a33d'] })],
    )
    expect(r.measured).toBe(0)
    expect(r.issues).toHaveLength(0)
  })
})

describe('O6 · 最糟的排前面', () => {
  it('按 ratio 升序 —— agent 步数有限，先修最读不出来的', () => {
    const s = slide({ elements: [text({ id: 'a' }), text({ id: 'b' })] })
    const r = reflectOnContrast([s], [
      // #888888 上的白字比 #e8a33d 上的白字略好一点
      sample({ elementId: 'a', backdrop: ['#888888', '#888888'] }),
      sample({ elementId: 'b', backdrop: ['#ffffff', '#ffffff'] }),
    ])
    expect(r.issues).toHaveLength(2)
    expect(r.issues[0].elementId).toBe('b')
    expect(r.issues[0].ratio).toBeLessThan(r.issues[1].ratio)
  })
})

describe('O6 · 给 agent 的改法不能是「改成黑白」', () => {
  it('三种病灶都点到，且明说不要洗掉配色', () => {
    const r = reflectOnContrast([slide()], [sample({ backdrop: ['#e8a33d', '#e8a33d'] })])
    const msg = describeContrast(r)
    expect(msg).toContain('盖在文字上面')
    expect(msg).toContain('full-figure')
    expect(msg).toContain('不要把整份稿子的文字改成黑白')
    // 页码和内容要认得出是哪一块
    expect(msg).toContain('第 1 页')
    expect(msg).toContain('关键指标')
  })

  it('全达标时说得干脆，不留「可能有问题」的尾巴', () => {
    const msg = describeContrast(reflectOnContrast([slide()], [sample()]))
    expect(msg).toContain('对比度全部达标')
    expect(msg).not.toContain('读不出来')
  })

  it('一条都没量到时明说，而不是报「全部达标」', () => {
    const msg = describeContrast(reflectOnContrast([slide({ id: 'other' })], [sample()]))
    expect(msg).toContain('没有量到')
    expect(msg).not.toContain('全部达标')
  })

  it('跳过的条数要说出来 —— 悄悄少判几块会被当成判过了', () => {
    const r = reflectOnContrast([slide()], [sample({ sampled: 2 })])
    expect(describeContrast(r)).toContain('没判')
  })
})
