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
  it('exposes 86 named shapes', () => {
    expect(SHAPE_CATALOG_KEYS).toHaveLength(86)
    expect(new Set(SHAPE_CATALOG_KEYS).size).toBe(86)
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


  // R-41 · 图标字形逐条钉住
  //
  // 图标的 path 是上千字符的贝塞尔串，肉眼比不出来 —— 上游一旦重排下标，
  // 「盾牌对勾」会静默变成「垃圾桶」，而 agent 会照样把它盖进用户的文稿里。
  //
  // 钉的是**长度 + 末 24 字符**，不是开头。第一版钉前 28 个字符，
  // 实测 checkCircle / minusCircle / closeCircle / plusCircle / playCircle / clock / ban
  // 七个的开头一模一样（都是同一个外圆），方形那五个也一样 ——
  // 那种钉法会在 ✓ 变成 ✗ 的时候一声不吭地通过。长度 + 尾巴对 86 个键全部可区分。
  it.each([
    ['arrowUndo', 139, '597.312-625.792-657.088z'],
    ['arrowRedo', 141, '597.312 625.792-657.088z'],
    ['heart', 1266, '96-24.5784-119.83439999z'],
    ['starRound', 873, '6667-32.256-43.36640001z'],
    ['cloud', 446, '9.07377778-219.93244445z'],
    ['bolt', 496, '-6.78091476-16.89064221z'],
    ['flame', 1677, '4.01955556-160.31288889z'],
    ['tshirt', 745, '56.06968888-56.06968888z'],
    ['folder', 429, '40.77795555-40.77795556z'],
    ['phone', 1219, '5.24719482-140.30329077z'],
    ['funnel', 581, '55.23363335-22.09345359z'],
    ['crown', 567, '3.36579793-269.52286815z'],
    ['thumbUp', 802, '8.30850884H643.02466884z'],
    ['user', 408, '9.72444445-291.27111111z'],
    ['bird', 786, '50.72971852-181.5589926z'],
    ['home', 643, '0.11182708-101.20351027z'],
    ['pin', 1096, '5.8722316 0-63.51539759z'],
    ['wrench', 693, '9.97328693-390.05465535z'],
    ['checkCircle', 675, ' 7.39555555 14.44977778z'],
    ['minusCircle', 510, ' 9.10222222v54.61333334z'],
    ['closeCircle', 994, '2-9.10222222 9.10222223z'],
    ['plusCircle', 822, ' 9.10222222v54.61333334z'],
    ['playCircle', 661, '11111-2.048 12.62933334z'],
    ['clock', 649, '33333 2.048 12.62933333z'],
    ['chat', 1792, '54.49955555 54.61333333z'],
    ['checkSquare', 785, '38 8.27023406 16.158765z'],
    ['minusSquare', 635, ' 10.17874962v61.0724977z'],
    ['closeSquare', 1076, '5.60763474 185.63494611z'],
    ['playSquare', 600, '6.6677025 0 22.39324918z'],
    ['plusSquare', 978, ' 10.17874962v61.0724977z'],
    ['shieldCheck', 1105, ' 7.15518603 14.09021248z'],
    ['trash', 773, '86.79248536v91.60874653z'],
    ['flag', 668, '40.71499846-40.71499846z'],
    ['hourglass', 968, '35.3773699-246.83467817z'],
    ['tag', 727, '76.45866665 76.45866667z'],
    ['percent', 1324, '4.23039603 104.23039603z'],
    ['lineArrowRight', 628, '9.1579333 0-66.83269582z'],
    ['lineArrowUp', 630, ' 8.41655359-18.51641789z'],
    ['lineArrowLeft', 628, '11.04672658-11.04672657z'],
    ['lineArrowDown', 638, '-8.41655359-18.51641789z'],
    ['swap', 891, '11.04672658-11.04672659z'],
    ['menuLines', 953, '10.17874961-10.17874959z'],
    ['closeLine', 769, '284176L591.98717801 512z'],
    ['userLine', 1809, '484444 512 540.03484444z'],
    ['mail', 849, '48.58311112 37.77422222z'],
    ['monitor', 707, '55.6088889v473.31555555z'],
    ['ban', 720, '5.00444444 267.15022222z'],
    ['document', 632, '667h245.76v562.06222223z'],
    ['funnelLine', 616, '0.70542222 574.95096888z'],
  ] as [string, number, string][])('%s 仍然指向命名时看到的那个字形', (key, len, tail) => {
    const { item } = SHAPE_CATALOG[key]
    // 对不上就是上游重排了：跑 `npm run shapes` 看联系表，按新下标改 pick()
    expect(item.path.length, `${key} 的 path 长度变了`).toBe(len)
    expect(item.path.endsWith(tail), `${key}: path 结尾是 "${item.path.slice(-30)}"`).toBe(true)
  })

  // 图标拉伸就不成样子 —— 云被压成 3:1 就不是云了
  it('every icon keeps its aspect ratio', () => {
    const icons = SHAPE_CATALOG_KEYS.filter(k => SHAPE_CATALOG[k].category === 'icon')
    expect(icons.length).toBe(47)
    for (const key of icons) {
      expect(SHAPE_CATALOG[key].fixedRatio, key).toBe(true)
      expect(SHAPE_CATALOG[key].item.viewBox, key).toEqual([1024, 1024])
    }
  })

  /**
   * 刻意没收进来的 4 个 —— 把这条决定钉住，免得哪天有人「顺手补全」又加回去。
   *
   * 三个第三方品牌标识：把别家商标交给一个会自动往用户文稿里盖图形的 agent，
   * 是给用户埋雷。它们在 UI 的形状面板里照常可选 —— 人自己挑是人自己的决定。
   * 一个孤零零的 ♂：集合里没有配套的 ♀，它最可能的用途恰恰是它一个人干不了的。
   */
  it.each([
    [3, 8, 'QQ 企鹅'],
    [3, 9, 'Twitter 小鸟'],
    [3, 14, 'GitLab 狐狸'],
    [4, 14, '男性符号 ♂'],
  ])('SHAPE_LIST[%i][%i]（%s）刻意不收进目录', (gi, ci) => {
    const item = SHAPE_LIST[gi].children[ci]
    const inCatalog = SHAPE_CATALOG_KEYS.some(k => SHAPE_CATALOG[k].item === item)
    expect(inCatalog).toBe(false)
  })

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
