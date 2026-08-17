import { describe, it, expect } from 'vitest'
import { buildTimingXml } from '../buildTimingXml'
import type { PPTAnimation } from '@/types/slides'

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
      const anim = makeAnim({ effect: 'nonexistent' as any })
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

  describe('directional effects', () => {
    it('fade-up has motion from bottom and presetSubtype', () => {
      const result = buildTimingXml(
        [makeAnim({ effect: 'fade-up' })],
        makeMap(['el-1', 3]),
      )
      expect(result.xml).toContain('presetID="2"')
      expect(result.xml).toContain('presetSubtype="8"')
      expect(result.xml).toContain('<p:attrName>ppt_y</p:attrName>')
      expect(result.xml).toContain('val="#ppt_y+#ppt_h/2"')
      expect(result.xml).toContain('val="#ppt_y"')
    })

    it('slide-left has motion from left', () => {
      const result = buildTimingXml(
        [makeAnim({ effect: 'slide-left' })],
        makeMap(['el-1', 3]),
      )
      expect(result.xml).toContain('presetSubtype="2"')
      expect(result.xml).toContain('<p:attrName>ppt_x</p:attrName>')
      expect(result.xml).toContain('val="#ppt_x-#ppt_w/2"')
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
    it('pulse generates two animScale elements inside a p:seq', () => {
      const result = buildTimingXml(
        [makeAnim({ effect: 'pulse', type: 'attention' })],
        makeMap(['el-1', 5]),
      )
      expect(result.xml).toContain('presetClass="emph"')
      const scaleCount = (result.xml.match(/<p:animScale>/g) || []).length
      expect(scaleCount).toBe(2)
    })

    it('second animScale returns to identity (100000)', () => {
      const result = buildTimingXml(
        [makeAnim({ effect: 'pulse', type: 'attention', duration: 600 })],
        makeMap(['el-1', 5]),
      )
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
  })

  describe('spin-in', () => {
    it('generates both animScale and animRot', () => {
      const result = buildTimingXml(
        [makeAnim({ effect: 'spin-in' })],
        makeMap(['el-1', 3]),
      )
      expect(result.xml).toContain('<p:animScale>')
      expect(result.xml).toContain('<p:animRot')
      expect(result.xml).toContain('from="-720000"')
      expect(result.xml).toContain('to="0"')
    })
  })

  describe('wipe', () => {
    it('generates animEffect with wipe filter', () => {
      const result = buildTimingXml(
        [makeAnim({ effect: 'wipe' })],
        makeMap(['el-1', 3]),
      )
      expect(result.xml).toContain('presetID="5"')
      expect(result.xml).toContain('filter="wipe(r)"')
    })

    it('exit-wipe has transition="out"', () => {
      const result = buildTimingXml(
        [makeAnim({ effect: 'exit-wipe', type: 'out', trigger: 'click' })],
        makeMap(['el-1', 3]),
      )
      expect(result.xml).toContain('presetClass="exit"')
      expect(result.xml).toContain('transition="out"')
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
})
