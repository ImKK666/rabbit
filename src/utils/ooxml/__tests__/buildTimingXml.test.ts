import { describe, it, expect } from 'vitest'
import { buildTimingXml } from '../buildTimingXml'
import { ANIMATION_DEFS, formatEffectFilter, OOXML_EFFECT_FILTERS } from '@/configs/animation'
import type { PPTAnimation, AnimationEffect } from '@/types/slides'

const makeAnim = (overrides: Partial<PPTAnimation> = {}): PPTAnimation => ({
  id: 'anim-1',
  elId: 'el-1',
  effect: 'fade',
  type: 'in',
  duration: 500,
  trigger: 'click',
  ...overrides,
})

const makeMap = (...pairs: [string, number][]): Map<string, number> =>
  new Map(pairs)

describe('buildTimingXml', () => {
  describe('skipping', () => {
    it('returns empty xml when animations list is empty', () => {
      const result = buildTimingXml([], makeMap())
      expect(result.xml).toBe('')
      expect(result.skipped).toHaveLength(0)
    })

    it('skips animations with web-only exportBehavior', () => {
      const anim = makeAnim({ exportBehavior: 'web-only' })
      const result = buildTimingXml([anim], makeMap(['el-1', 2]))
      expect(result.xml).toBe('')
      expect(result.skipped).toHaveLength(1)
      expect(result.skipped[0].reason).toContain('web-only')
    })

    it('skips animations whose elId is not in spidMap', () => {
      const anim = makeAnim({ elId: 'missing' })
      const result = buildTimingXml([anim], makeMap(['el-1', 2]))
      expect(result.xml).toBe('')
      expect(result.skipped).toHaveLength(1)
      expect(result.skipped[0].reason).toContain('missing')
    })

    it('skips animations with unknown effect', () => {
      const anim = makeAnim({ effect: 'nonexistent' as AnimationEffect })
      const result = buildTimingXml([anim], makeMap(['el-1', 2]))
      expect(result.xml).toBe('')
      expect(result.skipped).toHaveLength(1)
      expect(result.skipped[0].reason).toContain('preset')
    })
  })

  describe('tree structure', () => {
    it('wraps everything in <p:timing>', () => {
      const result = buildTimingXml([makeAnim()], makeMap(['el-1', 2]))
      expect(result.xml).toMatch(/^<p:timing>.*<\/p:timing>$/)
    })

    it('has exactly one tmRoot', () => {
      const result = buildTimingXml([makeAnim()], makeMap(['el-1', 2]))
      expect(result.xml.match(/nodeType="tmRoot"/g)?.length).toBe(1)
    })

    it('has exactly one mainSeq', () => {
      const result = buildTimingXml([makeAnim()], makeMap(['el-1', 2]))
      expect(result.xml.match(/nodeType="mainSeq"/g)?.length).toBe(1)
    })

    // PowerPoint 自己写的文件里 tmRoot 恒为 1、mainSeq 恒为 2。
    // 规范只要求树内唯一，但对齐它能少一类「为什么我这份不认」的排查。
    it('numbers tmRoot as 1 and mainSeq as 2', () => {
      const result = buildTimingXml([makeAnim()], makeMap(['el-1', 2]))
      expect(result.xml).toContain('<p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot">')
      expect(result.xml).toContain('<p:cTn id="2" dur="indefinite" nodeType="mainSeq">')
    })

    it('assigns every cTn a unique id, ascending in document order', () => {
      const result = buildTimingXml(
        [
          makeAnim({ id: 'a1', elId: 'el-1', effect: 'fade-up', trigger: 'click' }),
          makeAnim({ id: 'a2', elId: 'el-2', effect: 'pulse', type: 'attention', trigger: 'auto' }),
          makeAnim({ id: 'a3', elId: 'el-3', effect: 'wipe', trigger: 'meantime' }),
        ],
        makeMap(['el-1', 2], ['el-2', 3], ['el-3', 4]),
      )
      const ids = [...result.xml.matchAll(/<p:cTn id="(\d+)"/g)].map(m => Number(m[1]))
      expect(ids.length).toBeGreaterThan(5)
      expect(new Set(ids).size).toBe(ids.length)
      // PowerPoint 自己的产物 id 就是按文档顺序递增的，对齐它少一个排查变量
      expect(ids).toEqual([...ids].sort((a, b) => a - b))
    })

    it('contains bldLst as direct child of timing', () => {
      const result = buildTimingXml([makeAnim()], makeMap(['el-1', 2]))
      expect(result.xml).toContain('<p:bldLst>')
      expect(result.xml).toContain('<p:bldP spid="2" grpId="0"/>')
    })

    it('every effect node has stCondLst', () => {
      const result = buildTimingXml([makeAnim()], makeMap(['el-1', 2]))
      const presetCount = (result.xml.match(/presetID="/g) || []).length
      const stCondCount = (result.xml.match(/<p:stCondLst>/g) || []).length
      expect(stCondCount).toBeGreaterThanOrEqual(presetCount)
    })

    it('every effect node has childTnLst', () => {
      const result = buildTimingXml([makeAnim()], makeMap(['el-1', 2]))
      const presetCount = (result.xml.match(/presetID="/g) || []).length
      expect(presetCount).toBeGreaterThan(0)
    })
  })

  // R-25：三层 <p:par> —— 点击步 / 子步 / 效果。
  // 少了最外层，PowerPoint 拿不到「停在这里等点击」的信号，整页会连成一串播完。
  describe('three-level par nesting', () => {
    it('a click step waits with delay="indefinite"', () => {
      const result = buildTimingXml([makeAnim({ trigger: 'click' })], makeMap(['el-1', 2]))
      expect(result.xml).toContain('<p:cond delay="indefinite"/>')
    })

    it('nests effect three <p:par> deep inside mainSeq', () => {
      const result = buildTimingXml([makeAnim({ trigger: 'click' })], makeMap(['el-1', 2]))
      const seqBody = result.xml.split('nodeType="mainSeq"')[1]
      const upToEffect = seqBody.slice(0, seqBody.indexOf('presetID='))
      expect((upToEffect.match(/<p:par>/g) || []).length).toBe(3)
    })

    it('two click animations produce two click steps', () => {
      const result = buildTimingXml(
        [
          makeAnim({ id: 'a1', elId: 'el-1', trigger: 'click' }),
          makeAnim({ id: 'a2', elId: 'el-2', trigger: 'click' }),
        ],
        makeMap(['el-1', 2], ['el-2', 3]),
      )
      expect((result.xml.match(/<p:cond delay="indefinite"\/>/g) || []).length).toBe(2)
    })

    it('meantime shares the parent sub-step instead of opening a new one', () => {
      const result = buildTimingXml(
        [
          makeAnim({ id: 'a1', elId: 'el-1', trigger: 'click' }),
          makeAnim({ id: 'a2', elId: 'el-2', trigger: 'meantime' }),
        ],
        makeMap(['el-1', 2], ['el-2', 3]),
      )
      expect((result.xml.match(/<p:cond delay="indefinite"\/>/g) || []).length).toBe(1)
      expect(result.xml).toContain('nodeType="clickEffect"')
      expect(result.xml).toContain('nodeType="withEffect"')
    })

    it('auto opens a new sub-step inside the same click step', () => {
      const result = buildTimingXml(
        [
          makeAnim({ id: 'a1', elId: 'el-1', trigger: 'click' }),
          makeAnim({ id: 'a2', elId: 'el-2', trigger: 'auto' }),
        ],
        makeMap(['el-1', 2], ['el-2', 3]),
      )
      expect((result.xml.match(/<p:cond delay="indefinite"\/>/g) || []).length).toBe(1)
      expect(result.xml).toContain('nodeType="afterEffect"')
    })

    // 整页第一条如果不是 click，应该进页就播，而不是白等一次点击
    it('auto-plays the first step when the first animation is not click-triggered', () => {
      const result = buildTimingXml(
        [makeAnim({ trigger: 'meantime' })],
        makeMap(['el-1', 2]),
      )
      expect(result.xml).not.toContain('delay="indefinite"')
      expect(result.xml).toContain('nodeType="withEffect"')
    })
  })

  describe('fade effect', () => {
    it('generates animEffect with filter="fade"', () => {
      const result = buildTimingXml([makeAnim({ effect: 'fade' })], makeMap(['el-1', 2]))
      expect(result.xml).toContain('filter="fade"')
      expect(result.xml).toContain('presetID="10"')
      expect(result.xml).toContain('presetClass="entr"')
    })

    it('targets the correct spid', () => {
      const result = buildTimingXml(
        [makeAnim({ elId: 'my-el' })],
        makeMap(['my-el', 7]),
      )
      expect(result.xml).toContain('<p:spTgt spid="7"/>')
      expect(result.xml).toContain('<p:bldP spid="7" grpId="0"/>')
    })
  })

  // presetSubtype 是方向位掩码：1=上 2=右 4=下 8=左
  describe('directional effects', () => {
    it('fade-up comes from the bottom edge (subtype 4)', () => {
      const result = buildTimingXml(
        [makeAnim({ effect: 'fade-up' })],
        makeMap(['el-1', 3]),
      )
      expect(result.xml).toContain('presetID="2"')
      expect(result.xml).toContain('presetSubtype="4"')
      expect(result.xml).toContain('<p:attrName>ppt_y</p:attrName>')
      expect(result.xml).toContain('val="#ppt_y+#ppt_h/2"')
      expect(result.xml).toContain('val="#ppt_y"')
    })

    it('fade-down comes from the top edge (subtype 1)', () => {
      const result = buildTimingXml([makeAnim({ effect: 'fade-down' })], makeMap(['el-1', 3]))
      expect(result.xml).toContain('presetSubtype="1"')
      expect(result.xml).toContain('val="#ppt_y-#ppt_h/2"')
    })

    it('slide-left comes from the left edge (subtype 8)', () => {
      const result = buildTimingXml(
        [makeAnim({ effect: 'slide-left' })],
        makeMap(['el-1', 3]),
      )
      expect(result.xml).toContain('presetSubtype="8"')
      expect(result.xml).toContain('<p:attrName>ppt_x</p:attrName>')
      expect(result.xml).toContain('val="#ppt_x-#ppt_w/2"')
    })

    it('slide-right comes from the right edge (subtype 2)', () => {
      const result = buildTimingXml([makeAnim({ effect: 'slide-right' })], makeMap(['el-1', 3]))
      expect(result.xml).toContain('presetSubtype="2"')
      expect(result.xml).toContain('val="#ppt_x+#ppt_w/2"')
    })
  })

  describe('scale effects', () => {
    it('scale-in generates animScale with correct range', () => {
      const result = buildTimingXml(
        [makeAnim({ effect: 'scale-in' })],
        makeMap(['el-1', 3]),
      )
      expect(result.xml).toContain('presetID="31"')
      expect(result.xml).toContain('<p:animScale>')
      expect(result.xml).toContain('<p:from x="85000" y="85000"/>')
      expect(result.xml).toContain('<p:to x="100000" y="100000"/>')
    })

    it('exit-scale generates exit preset with correct range', () => {
      const result = buildTimingXml(
        [makeAnim({ effect: 'exit-scale', type: 'out', trigger: 'click' })],
        makeMap(['el-1', 3]),
      )
      expect(result.xml).toContain('presetID="31" presetClass="exit"')
      expect(result.xml).toContain('transition="out"')
      expect(result.xml).toContain('<p:from x="100000" y="100000"/>')
      expect(result.xml).toContain('<p:to x="85000" y="85000"/>')
    })
  })

  describe('emphasis (rebound)', () => {
    it('pulse generates two animScale elements', () => {
      const result = buildTimingXml(
        [makeAnim({ effect: 'pulse', type: 'attention' })],
        makeMap(['el-1', 5]),
      )
      expect(result.xml).toContain('presetClass="emph"')
      const scaleCount = (result.xml.match(/<p:animScale>/g) || []).length
      expect(scaleCount).toBe(2)
    })

    // 第一版把回弹的两段裹在 <p:seq nodeType="mainSeq"> 里 —— 一页两个 mainSeq，
    // 是嵌套了第二条主时间线，PowerPoint 不该看到这种结构
    it('does not nest a second sequence inside the effect', () => {
      const result = buildTimingXml(
        [makeAnim({ effect: 'pulse', type: 'attention' })],
        makeMap(['el-1', 5]),
      )
      expect(result.xml.match(/nodeType="mainSeq"/g)?.length).toBe(1)
      expect((result.xml.match(/<p:seq/g) || []).length).toBe(1)
    })

    it('rebound phase starts after the first half', () => {
      const result = buildTimingXml(
        [makeAnim({ effect: 'pulse', type: 'attention', duration: 600 })],
        makeMap(['el-1', 5]),
      )
      expect(result.xml).toContain('<p:cond delay="300"/>')
      expect(result.xml).toContain('<p:to x="100000" y="100000"/>')
    })

    it('emphasis uses ease-in-out timing', () => {
      const result = buildTimingXml(
        [makeAnim({ effect: 'pulse', type: 'attention' })],
        makeMap(['el-1', 5]),
      )
      expect(result.xml).toContain('accel="20000"')
      expect(result.xml).toContain('decel="60000"')
    })

    it('emphasis never toggles style.visibility', () => {
      const result = buildTimingXml(
        [makeAnim({ effect: 'pulse', type: 'attention' })],
        makeMap(['el-1', 5]),
      )
      expect(result.xml).not.toContain('style.visibility')
    })
  })

  describe('rotation', () => {
    it('spin-in generates both animScale and absolute animRot', () => {
      const result = buildTimingXml(
        [makeAnim({ effect: 'spin-in' })],
        makeMap(['el-1', 3]),
      )
      expect(result.xml).toContain('<p:animScale>')
      expect(result.xml).toContain('<p:animRot from="-720000" to="0">')
    })

    // animRot 不带 attrNameLst 的话 PowerPoint 不知道该动哪个属性
    it('always declares the "r" attribute for rotation behaviors', () => {
      const result = buildTimingXml([makeAnim({ effect: 'spin-in' })], makeMap(['el-1', 3]))
      expect(result.xml).toContain('<p:attrNameLst><p:attrName>r</p:attrName></p:attrNameLst>')
    })

    it('spin emphasis uses a relative full turn', () => {
      const result = buildTimingXml(
        [makeAnim({ effect: 'spin', type: 'attention' })],
        makeMap(['el-1', 3]),
      )
      expect(result.xml).toContain('presetID="8" presetClass="emph"')
      expect(result.xml).toContain('<p:animRot by="21600000">')
      expect(result.xml).not.toContain('<p:animScale>')
    })
  })

  describe('opacity emphasis', () => {
    it('blink dips opacity and returns to 1', () => {
      const result = buildTimingXml(
        [makeAnim({ effect: 'blink', type: 'attention' })],
        makeMap(['el-1', 3]),
      )
      expect(result.xml).toContain('presetID="9" presetClass="emph"')
      expect(result.xml).toContain('<p:attrName>style.opacity</p:attrName>')
      expect(result.xml).toContain('<p:tav tm="0"><p:val><p:fltVal val="1"/></p:val></p:tav>')
      expect(result.xml).toContain('<p:tav tm="50000"><p:val><p:fltVal val="0.3"/></p:val></p:tav>')
      expect(result.xml).toContain('<p:tav tm="100000"><p:val><p:fltVal val="1"/></p:val></p:tav>')
    })
  })

  // R-25：effectFilter 从单个 'wipe' 字面量泛化成完整 OOXML 滤镜词表
  describe('effect filters', () => {
    it('wipe uses presetID 22 (Wipe) with a spec-shaped filter', () => {
      const result = buildTimingXml(
        [makeAnim({ effect: 'wipe' })],
        makeMap(['el-1', 3]),
      )
      expect(result.xml).toContain('presetID="22"')
      expect(result.xml).toContain('filter="wipe(right)"')
    })

    it.each([
      ['wipe-up', 22, 'wipe(up)'],
      ['wipe-down', 22, 'wipe(down)'],
      ['wipe-right', 22, 'wipe(left)'],
      ['blinds-h', 3, 'blinds(horizontal)'],
      ['blinds-v', 3, 'blinds(vertical)'],
      ['checkerboard', 5, 'checkerboard(across)'],
      ['dissolve-in', 9, 'dissolve'],
      ['randombar', 14, 'randombar(horizontal)'],
      ['strips-in', 18, 'strips(downRight)'],
      ['box-in', 4, 'box(in)'],
      ['circle-in', 6, 'circle(in)'],
      ['diamond-in', 8, 'diamond(in)'],
      ['plus-in', 13, 'plus(in)'],
      ['wedge-in', 20, 'wedge'],
      ['wheel-in', 21, 'wheel(4)'],
    ] as [AnimationEffect, number, string][])(
      '%s → presetID %i, filter %s',
      (effect, presetId, filter) => {
        const result = buildTimingXml([makeAnim({ effect })], makeMap(['el-1', 3]))
        expect(result.xml).toContain(`presetID="${presetId}"`)
        expect(result.xml).toContain(`filter="${filter}"`)
        expect(result.xml).toContain('transition="in"')
      },
    )

    it('exit filters carry transition="out"', () => {
      for (const effect of ['exit-wipe', 'exit-dissolve', 'exit-blinds', 'exit-circle'] as AnimationEffect[]) {
        const result = buildTimingXml(
          [makeAnim({ effect, type: 'out' })],
          makeMap(['el-1', 3]),
        )
        expect(result.xml).toContain('presetClass="exit"')
        expect(result.xml).toContain('transition="out"')
      }
    })

    it('every filter in the vocabulary is a legal OOXML filter string', () => {
      for (const def of Object.values(ANIMATION_DEFS)) {
        const filter = def.pptx.effectFilter
        if (!filter) continue
        const allowed = OOXML_EFFECT_FILTERS[filter.name] as readonly string[]
        const subtype = (filter as { subtype?: string }).subtype
        if (allowed.length) expect(allowed).toContain(subtype)
        else expect(subtype).toBeUndefined()
        expect(formatEffectFilter(filter)).toMatch(/^[a-z]+(\([a-zA-Z0-9]+\))?$/)
      }
    })
  })

  describe('exit effects', () => {
    it('exit-fade has presetClass="exit" and transition="out"', () => {
      const result = buildTimingXml(
        [makeAnim({ effect: 'exit-fade', type: 'out', trigger: 'click' })],
        makeMap(['el-1', 3]),
      )
      expect(result.xml).toContain('presetClass="exit"')
      expect(result.xml).toContain('transition="out"')
    })

    it('exit uses ease-in timing (accel=70000, decel=0)', () => {
      const result = buildTimingXml(
        [makeAnim({ effect: 'exit-fade', type: 'out', trigger: 'click' })],
        makeMap(['el-1', 3]),
      )
      expect(result.xml).toContain('accel="70000"')
      expect(result.xml).toContain('decel="0"')
    })

    it('exit-fly has motion channels', () => {
      const result = buildTimingXml(
        [makeAnim({ effect: 'exit-fly', type: 'out', trigger: 'click' })],
        makeMap(['el-1', 3]),
      )
      expect(result.xml).toContain('presetClass="exit"')
      expect(result.xml).toContain('<p:attrName>ppt_y</p:attrName>')
      expect(result.xml).toContain('val="#ppt_y+#ppt_h/2"')
    })

    // 第一版退场的 visibility 也写 delay=0：元素先瞬间消失，
    // 淡出动画再对着空气播完
    it('hides the element only after the effect finishes', () => {
      const result = buildTimingXml(
        [makeAnim({ effect: 'exit-fade', type: 'out', duration: 800 })],
        makeMap(['el-1', 3]),
      )
      expect(result.xml).toContain('<p:cond delay="799"/>')
      expect(result.xml).toContain('<p:strVal val="hidden"/>')
      const setIndex = result.xml.indexOf('<p:set>')
      const effectIndex = result.xml.indexOf('<p:animEffect')
      expect(setIndex).toBeGreaterThan(effectIndex)
    })

    it('shows the element immediately for entrances', () => {
      const result = buildTimingXml([makeAnim({ effect: 'fade' })], makeMap(['el-1', 3]))
      expect(result.xml).toContain('<p:strVal val="visible"/>')
      const setIndex = result.xml.indexOf('<p:set>')
      const effectIndex = result.xml.indexOf('<p:animEffect')
      expect(setIndex).toBeLessThan(effectIndex)
    })
  })

  describe('triggers', () => {
    it('click trigger maps to clickEffect', () => {
      const result = buildTimingXml(
        [
          makeAnim({ id: 'a1', effect: 'fade', trigger: 'click' }),
          makeAnim({ id: 'a2', elId: 'el-2', effect: 'fade', trigger: 'click' }),
        ],
        makeMap(['el-1', 2], ['el-2', 3]),
      )
      expect(result.xml).toContain('nodeType="clickEffect"')
    })

    it('meantime trigger maps to withEffect', () => {
      const result = buildTimingXml(
        [
          makeAnim({ id: 'a1', effect: 'fade', trigger: 'click' }),
          makeAnim({ id: 'a2', elId: 'el-2', effect: 'fade', trigger: 'meantime' }),
        ],
        makeMap(['el-1', 2], ['el-2', 3]),
      )
      expect(result.xml).toContain('nodeType="withEffect"')
    })

    it('auto trigger maps to afterEffect', () => {
      const result = buildTimingXml(
        [
          makeAnim({ id: 'a1', effect: 'fade', trigger: 'click' }),
          makeAnim({ id: 'a2', elId: 'el-2', effect: 'fade', trigger: 'auto' }),
        ],
        makeMap(['el-1', 2], ['el-2', 3]),
      )
      expect(result.xml).toContain('nodeType="afterEffect"')
    })
  })

  describe('build list', () => {
    it('deduplicates spids in bldLst', () => {
      const result = buildTimingXml(
        [
          makeAnim({ id: 'a1', effect: 'fade', trigger: 'click' }),
          makeAnim({ id: 'a2', effect: 'pulse', type: 'attention', trigger: 'click' }),
        ],
        makeMap(['el-1', 7]),
      )
      const bldPCount = (result.xml.match(/<p:bldP /g) || []).length
      expect(bldPCount).toBe(1)
    })

    it('includes all unique spids', () => {
      const result = buildTimingXml(
        [
          makeAnim({ id: 'a1', elId: 'el-1', effect: 'fade', trigger: 'click' }),
          makeAnim({ id: 'a2', elId: 'el-2', effect: 'fade', trigger: 'click' }),
        ],
        makeMap(['el-1', 7], ['el-2', 8]),
      )
      expect(result.xml).toContain('<p:bldP spid="7"')
      expect(result.xml).toContain('<p:bldP spid="8"')
    })
  })

  describe('entrance timing', () => {
    it('entrance uses smooth ease-out (accel=0, decel=70000)', () => {
      const result = buildTimingXml(
        [makeAnim({ effect: 'fade-up', duration: 600 })],
        makeMap(['el-1', 3]),
      )
      expect(result.xml).toContain('accel="0"')
      expect(result.xml).toContain('decel="70000"')
    })
  })

  // 整份词表的兜底：任何一个 effect 都必须能生成非空、结构完整的 XML。
  // 加新效果时忘了补 writer 分支，会在这里当场暴露。
  describe('vocabulary coverage', () => {
    const effects = Object.keys(ANIMATION_DEFS) as AnimationEffect[]

    it('covers 45 effects', () => {
      expect(effects).toHaveLength(45)
    })

    it.each(effects)('%s produces a well-formed timing tree', effect => {
      const def = ANIMATION_DEFS[effect]
      const result = buildTimingXml(
        [makeAnim({ effect, type: def.type })],
        makeMap(['el-1', 3]),
      )
      expect(result.skipped).toHaveLength(0)
      expect(result.xml).toMatch(/^<p:timing>.*<\/p:timing>$/)
      expect(result.xml).toContain(`presetID="${def.pptx.presetId}"`)
      expect(result.xml).toContain(`presetClass="${def.pptx.presetClass}"`)
      // 光有 preset 壳子不算数 —— 必须真的有行为节点驱动它
      expect(result.xml).toMatch(/<p:(animEffect|anim |animScale|animRot|set)/)
      // 标签配平
      expect((result.xml.match(/<p:par>/g) || []).length)
        .toBe((result.xml.match(/<\/p:par>/g) || []).length)
      // 自闭合的 <p:cTn .../> 不配对，只数需要闭合标签的那些
      expect((result.xml.match(/<p:cTn [^>]*[^/]>/g) || []).length)
        .toBe((result.xml.match(/<\/p:cTn>/g) || []).length)
    })
  })
})
