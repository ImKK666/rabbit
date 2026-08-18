import { describe, it, expect } from 'vitest'
import {
  SHAPE_CATALOG,
  SHAPE_CATALOG_KEYS,
  buildShapeGeometry,
  describeShapeCatalog,
} from '../shapeCatalog'
import { SHAPE_LIST } from '../shapes'

/**
 * 目录按 (分类下标, 条目下标) 引用 SHAPE_LIST，是为了不复制 path。
 * 代价是上游一旦重排下标，会**静默**指到另一个形状上 —— 这一组测试就是那道警报。
 */
describe('shapeCatalog', () => {
  it('exposes 37 named shapes', () => {
    expect(SHAPE_CATALOG_KEYS).toHaveLength(37)
    expect(new Set(SHAPE_CATALOG_KEYS).size).toBe(37)
  })

  it('every key resolves to a real shape pool item', () => {
    for (const key of SHAPE_CATALOG_KEYS) {
      const shape = SHAPE_CATALOG[key]
      expect(shape, key).toBeDefined()
      expect(shape.item.path.length).toBeGreaterThan(4)
      expect(shape.item.viewBox).toHaveLength(2)
      expect(shape.usage.length).toBeGreaterThan(3)
    }
  })

  it('every referenced item is actually present in SHAPE_LIST', () => {
    const pool = new Set(SHAPE_LIST.flatMap(g => g.children))
    for (const key of SHAPE_CATALOG_KEYS) {
      expect(pool.has(SHAPE_CATALOG[key].item), key).toBe(true)
    }
  })

  // 逐条钉住身份特征：上游重排下标时会在这里报出到底是哪个键错位了
  it.each([
    ['rect', 'rect', undefined, 'M 0 0 L 200 0 L 200 200 L 0 200 Z'],
    ['roundRect', 'roundRect', 'roundRect', 'M 50 0 L 150 0 Q 200 0 200 50'],
    ['snipRect', 'snip1Rect', 'cutRectSingle', 'M 0 200 L 0 0 L 150 0 L 200 50'],
    ['ellipse', 'ellipse', undefined, 'M 100 0 A 50 50 0 1 1 100 200'],
    ['triangle', 'triangle', 'triangle', 'M 100 0 L 0 200 L 200 200'],
    ['trapezoid', 'trapezoid', 'trapezoid', 'M 50 0 L 150 0 L 200 200 L 0 200'],
    ['diamond', undefined, undefined, 'M 100 0 L 0 100 L 100 200 L 200 100 L 100 0 Z'],
    ['frame', 'frame', 'ringRect', 'M0 0 L200 0 L200 200 L0 200 L0 0 Z'],
    ['donut', 'donut', 'donut', 'M0 100 A100 100 0 1 1 0 101 Z'],
    ['cross', 'plus', 'plus', 'M 50 0 L 150 0 L 150 50 L 200 50'],
    ['corner', 'corner', 'L', 'M 0 0 L 0 200 L 200 200 L 200 140'],
    ['diagStripe', 'diagStripe', 'diagStripe', 'M 200 0 L 100 0 L 0 100 L 0 200 L 200 0 Z'],
    ['callout', undefined, 'message', 'M 0 0 L 200 0 L 200 160 L 100 160'],
    ['roundCallout', undefined, 'roundMessage', 'M 0 40 Q 0 0 40 0 L 160 0'],
    ['bar', undefined, undefined, 'M 0 70 L 200 70 L 200 130 L 0 130 Z'],
    ['pill', undefined, undefined, 'M 50 0 A 25 50 0 1 0 50 200'],
    ['chevron', undefined, undefined, 'M 0 0 L 120 0 L 200 100 L 120 200 L 0 200 L 80 100 L 0 0 Z'],
    ['chevronLeft', undefined, undefined, 'M 80 0 L 200 0 L 120 100 L 200 200 L 80 200 L 0 100 L 80 0 Z'],
    ['pentagonArrow', undefined, undefined, 'M 0 0 L 140 0 L 200 100 L 140 200 L 0 200 L 0 100 L 0 0 Z'],
    ['homePlate', undefined, undefined, 'M 60 0 L 200 0 L 200 100 L 200 200 L 60 200 L 0 100 L 60 0 Z'],
    ['arrowRight', undefined, undefined, 'M 0 100 L 100 0 L 100 50 L 200 50 L 200 150'],
    ['arrowLeft', undefined, undefined, 'M 200 100 L 100 0 L 100 50 L 0 50 L 0 150'],
    ['arrowUp', undefined, undefined, 'M 100 0 L 0 100 L 50 100 L 50 200'],
    ['arrowDown', undefined, undefined, 'M 100 200 L 200 100 L 150 100 L 150 0'],
    ['arrowLeftRight', undefined, undefined, 'M 0 100 L 60 0 L 60 60 L 140 60'],
    ['arrowUpDown', undefined, undefined, 'M 100 0 L 0 60 L 60 60 L 60 140'],
    ['indicator', undefined, 'indicator', 'M 200 100 L 150 0 L 0 0 L 50 100'],
    ['bullet', undefined, 'bullet', 'M 100 0 L 0 50 L 0 200 L 200 200 L 200 50 L 100 0 Z'],
  ] as [string, string | undefined, string | undefined, string][])(
    '%s points at the expected pool item',
    (key, pptxShapeType, pathFormula, pathPrefix) => {
      const { item } = SHAPE_CATALOG[key]
      expect(item.path.startsWith(pathPrefix), `${key}: path 是 "${item.path.slice(0, 60)}"`).toBe(true)
      expect(item.pptxShapeType).toBe(pptxShapeType)
      expect(item.pathFormula).toBe(pathFormula)
    },
  )

  describe('buildShapeGeometry', () => {
    it('returns null for an unknown key', () => {
      expect(buildShapeGeometry('nope', 100, 100)).toBeNull()
    })

    it('keeps the original viewBox for formula-less shapes', () => {
      const g = buildShapeGeometry('rect', 400, 120)!
      expect(g.viewBox).toEqual([200, 200])
      expect(g.path).toBe('M 0 0 L 200 0 L 200 200 L 0 200 Z')
    })

    // 不重算的话，宽卡片的圆角会被横向拉成椭圆角
    it('recomputes formula shapes against the real size', () => {
      const g = buildShapeGeometry('roundRect', 400, 120)!
      expect(g.viewBox).toEqual([400, 120])
      expect(g.pathFormula).toBe('roundRect')
      expect(g.keypoints).toEqual([0.125])
      // 半径按短边算 → 120 * 0.125 = 15，横竖两个方向都该是 15
      expect(g.path).toContain('M 15 0')
      expect(g.path).toContain('L 385 0')
      expect(g.path).not.toContain('NaN')
    })

    it('produces a path proportional to the requested size', () => {
      const small = buildShapeGeometry('roundRect', 100, 100)!
      const large = buildShapeGeometry('roundRect', 800, 800)!
      expect(small.path).not.toBe(large.path)
      expect(large.path).toContain('800')
    })

    it('marks fixedRatio shapes', () => {
      expect(buildShapeGeometry('ellipse', 100, 100)!.fixedRatio).toBe(true)
      expect(buildShapeGeometry('rect', 100, 100)!.fixedRatio).toBe(false)
    })

    it('never emits NaN for any catalog entry at any size', () => {
      for (const key of SHAPE_CATALOG_KEYS) {
        for (const [w, h] of [[10, 10], [400, 60], [60, 400], [1000, 562]]) {
          const g = buildShapeGeometry(key, w, h)!
          expect(g.path, `${key} @ ${w}x${h}`).not.toMatch(/NaN|Infinity|undefined/)
          expect(g.viewBox[0]).toBeGreaterThan(0)
          expect(g.viewBox[1]).toBeGreaterThan(0)
        }
      }
    })
  })

  it('describeShapeCatalog lists every key exactly once', () => {
    const text = describeShapeCatalog()
    for (const key of SHAPE_CATALOG_KEYS) {
      expect(text.split(`${key}(`).length - 1, key).toBe(1)
    }
  })
})
