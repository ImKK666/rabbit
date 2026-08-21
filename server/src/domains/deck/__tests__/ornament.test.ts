/**
 * 装饰层纯函数的判据 —— docs/14 的 O1，以及负空间 prompt 的形状
 *
 * **阈值是拿真样本标定的，不是拍的**（`samples/ornament/`，2026-08-21 实测）：
 *
 * | 样本 | 留空矩形内平均 alpha |
 * |---|---:|
 * | 目标形态 `form-target.png` | **0 / 0** |
 * | thin-line 版 `chroma-green.png` | 0.6 / 0 |
 * | 把矩形挪到装饰上（负对照） | **76.1** |
 * | 棋盘格 `alpha-hard.png` | 255 |
 *
 * 阈值 12 落在 0.6 与 76.1 之间，两边各差一到两个数量级。
 */

import { describe, it, expect } from 'vitest'
import type { Slide, PPTElement } from '@/types/slides'
import { chromaKey } from '@server/runtime/chromaKey'
import {
  occupiedRectsOf, buildOrnamentPrompt, lintOrnament, describeOrnamentIssues,
  keyColorName, MAX_MEAN_ALPHA_IN_RECT, type OccupiedRect,
} from '../ornament'
import { VIEWPORT_WIDTH, VIEWPORT_HEIGHT } from '../kernel'

const el = (type: string, over: Record<string, unknown> = {}): PPTElement => ({
  id: `el_${type}`, type, left: 0, top: 0, width: 100, height: 50, rotate: 0,
  ...(type === 'text' ? { content: '<p>x</p>', defaultFontName: 'a', defaultColor: '#000' } : {}),
  ...(type === 'image' ? { src: 'x', fixedRatio: true } : {}),
  ...(type === 'shape' ? { viewBox: [200, 200], path: 'M0', fill: '#000' } : {}),
  ...over,
} as unknown as PPTElement)

const slide = (elements: PPTElement[]): Slide =>
  ({ id: 's1', type: 'content', elements } as Slide)

/** 造一张抠好的层：整张透明，只在指定矩形里填不透明 */
const keyedWithInk = (w: number, h: number, ink: OccupiedRect | null) => {
  const rgba = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inside = ink
        && x >= ink.x * w && x < (ink.x + ink.w) * w
        && y >= ink.y * h && y < (ink.y + ink.h) * h
      const o = (y * w + x) * 4
      // 绿底 → 抠掉；藏青 → 留下
      const c = inside ? [31, 58, 95] : [0, 255, 0]
      rgba[o] = c[0]; rgba[o + 1] = c[1]; rgba[o + 2] = c[2]; rgba[o + 3] = 255
    }
  }
  return chromaKey(rgba, w, h)
}

describe('occupiedRectsOf · 只收 text 和 image', () => {
  it('形状 / 线条 / 图表不算占用 —— 装饰压在它们上面正是框架层要的效果', () => {
    const s = slide([
      el('text'), el('image'), el('shape'),
      el('line', { start: [0, 0], end: [1, 1] }),
      el('chart', { chartType: 'bar', data: {} }),
    ])
    const rects = occupiedRectsOf(s)
    expect(rects).toHaveLength(2)
    expect(rects.map(r => r.kind).sort()).toEqual(['image', 'text'])
  })

  it('坐标归一化到 0~1', () => {
    const s = slide([el('text', {
      left: VIEWPORT_WIDTH / 4, top: VIEWPORT_HEIGHT / 2,
      width: VIEWPORT_WIDTH / 2, height: VIEWPORT_HEIGHT / 4,
    })])
    expect(occupiedRectsOf(s)[0]).toMatchObject({ x: 0.25, y: 0.5, w: 0.5, h: 0.25 })
  })

  it('一页上什么都没有时返回空 —— 不能崩', () => {
    expect(occupiedRectsOf(slide([]))).toEqual([])
  })
})

describe('buildOrnamentPrompt · 构图决策留在代码里', () => {
  const rects: OccupiedRect[] = [{ kind: 'text', x: 0.08, y: 0.12, w: 0.62, h: 0.18 }]
  const colors = ['#1F3A5F', '#2F6FEB', '#E8A33D']

  it('把占用矩形写成百分比，模型只填剩下的', () => {
    const p = buildOrnamentPrompt({ rects, colors })
    expect(p).toContain('x 8%, y 12%, w 62%, h 18%')
    expect(p).toContain('COMPLETELY EMPTY')
  })

  it('锚点色由代码注入 —— 跨页一致性不靠模型记忆', () => {
    const p = buildOrnamentPrompt({ rects, colors })
    for (const c of colors) expect(p).toContain(c)
  })

  it('实心度和覆盖密度是两个**正交**的约束', () => {
    const p = buildOrnamentPrompt({ rects, colors })
    // 上一版把两者混在一句里，结果要到实心的同时覆盖率飙到 33%
    expect(p).toContain('(A) STROKE QUALITY')
    expect(p).toContain('(B) COVERAGE')
    expect(p).toContain('AT MOST 12%')
  })

  it('键色可换 —— 撞色时不至于把装饰一起抠掉', () => {
    const p = buildOrnamentPrompt({ rects, colors, keyHex: '#FF00FF' })
    expect(p).toContain('#FF00FF')
    expect(p).not.toContain('#00FF00')
  })

  /**
   * **这条钉的是一次真实回归**（端到端实测，2026-08-21）。
   *
   * 第一版为了支持任意键色，把措辞泛化成 `the exact color #00FF00`，
   * 把「pure green」这个词丢了。结果：带色名的 3 次全部照做（透明 92~95%），
   * 只给 hex 的 2 次全部翻车（一次 32.79% 不透明、一次 91.97%）。
   *
   * **模型对色名的遵守远强于对 hex 的遵守。** hex 要给（精确），
   * 名字也必须给 —— 它才是真正起作用的那个词。
   */
  it('键色必须同时给出**名字**，不能只给 hex —— 只给 hex 实测会让模型画满整页', () => {
    expect(buildOrnamentPrompt({ rects, colors })).toContain('pure green')
    expect(buildOrnamentPrompt({ rects, colors, keyHex: '#FF00FF' })).toContain('pure magenta')
    expect(keyColorName('#00ff00')).toBe('pure green')   // 大小写不敏感
  })

  it('禁文字禁图标，否则装饰层会带出一堆假标题', () => {
    const p = buildOrnamentPrompt({ rects, colors })
    expect(p).toContain('No text, no letters, no numbers, no icons')
  })

  it('一个矩形都没有时也拼得出来', () => {
    expect(() => buildOrnamentPrompt({ rects: [], colors })).not.toThrow()
    expect(buildOrnamentPrompt({ rects: [], colors })).toContain('(none)')
  })
})

describe('O1 · 占用矩形内不许有墨', () => {
  const textRect: OccupiedRect = { kind: 'text', x: 0.1, y: 0.1, w: 0.4, h: 0.3 }

  it('装饰躲开了 → 不报', () => {
    // 墨全在右下角，和 textRect 不相交
    const keyed = keyedWithInk(100, 100, { kind: 'text', x: 0.7, y: 0.7, w: 0.25, h: 0.25 })
    expect(lintOrnament(keyed, [textRect])).toHaveLength(0)
  })

  it('装饰盖进来了 → 报，且给得出平均浓度', () => {
    const keyed = keyedWithInk(100, 100, textRect)
    const issues = lintOrnament(keyed, [textRect])
    expect(issues).toHaveLength(1)
    expect(issues[0].kind).toBe('text')
    expect(issues[0].meanAlpha).toBeGreaterThan(MAX_MEAN_ALPHA_IN_RECT)
  })

  it('细描边压边界不算 —— 那是想要的效果', () => {
    // 只在矩形最上面一行画墨：1/30 的面积，均值远低于阈值
    const keyed = keyedWithInk(100, 100, { kind: 'text', x: 0.1, y: 0.1, w: 0.4, h: 0.01 })
    const issues = lintOrnament(keyed, [textRect])
    expect(issues).toHaveLength(0)
  })

  it('图片区和文字区都判，但报告里分得开', () => {
    const imgRect: OccupiedRect = { kind: 'image', x: 0.1, y: 0.1, w: 0.4, h: 0.3 }
    const keyed = keyedWithInk(100, 100, imgRect)
    const issues = lintOrnament(keyed, [imgRect])
    expect(issues[0].kind).toBe('image')
    expect(describeOrnamentIssues(issues)).toContain('图片区')
  })

  it('压得最狠的排前面', () => {
    const a: OccupiedRect = { kind: 'text', x: 0.0, y: 0.0, w: 0.5, h: 0.5 }
    const b: OccupiedRect = { kind: 'text', x: 0.5, y: 0.5, w: 0.5, h: 0.5 }
    // 墨完全盖住 b，只盖住 a 的一角
    const keyed = keyedWithInk(100, 100, { kind: 'text', x: 0.45, y: 0.45, w: 0.55, h: 0.55 })
    const issues = lintOrnament(keyed, [a, b])
    expect(issues.length).toBeGreaterThanOrEqual(1)
    expect(issues[0].rect).toMatchObject({ x: 0.5, y: 0.5 })
  })

  it('矩形落在画布外时跳过，不崩也不误报', () => {
    const keyed = keyedWithInk(50, 50, null)
    expect(lintOrnament(keyed, [{ kind: 'text', x: 1.5, y: 1.5, w: 0.2, h: 0.2 }])).toHaveLength(0)
  })

  it('全干净时的那句话不含告警口吻', () => {
    expect(describeOrnamentIssues([])).toContain('没有压到')
  })
})
