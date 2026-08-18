import { describe, it, expect } from 'vitest'
import { buildTransitionXml, isTransitionExactOnExport } from '../buildTransitionXml'
import { SLIDE_ANIMATIONS } from '@/configs/animation'
import type { TurningMode } from '@/types/slides'

describe('buildTransitionXml', () => {
  describe('opting out', () => {
    // 网页播放器把「没设过」当 slideY，但那是播放器的默认值不是用户的意图。
    // 导入的 pptx 再导出时平白多出一堆推移动画，是实打实的失真。
    it('emits nothing when turningMode is unset', () => {
      expect(buildTransitionXml(undefined).xml).toBe('')
    })

    it('emits nothing for "no"', () => {
      expect(buildTransitionXml('no').xml).toBe('')
    })

    it('emits nothing for an unknown mode instead of guessing', () => {
      expect(buildTransitionXml('morph-3d-cube').xml).toBe('')
    })
  })

  describe('mapping', () => {
    it.each([
      ['fade', '<p:fade/>'],
      ['random', '<p:random/>'],
      ['slideX', '<p:push dir="l"/>'],
      ['slideY', '<p:push dir="u"/>'],
      ['slideX3D', '<p:push dir="l"/>'],
      ['slideY3D', '<p:push dir="u"/>'],
      ['rotate', '<p:newsflash/>'],
      ['scaleY', '<p:split orient="horz" dir="out"/>'],
      ['scaleX', '<p:split orient="vert" dir="out"/>'],
      ['scale', '<p:zoom dir="in"/>'],
      ['scaleReverse', '<p:zoom dir="out"/>'],
    ] as [TurningMode, string][])('%s → %s', (mode, element) => {
      expect(buildTransitionXml(mode).xml).toBe(`<p:transition spd="med">${element}</p:transition>`)
    })

    it('honours the speed argument', () => {
      expect(buildTransitionXml('fade', 'fast').xml).toContain('spd="fast"')
      expect(buildTransitionXml('fade', 'slow').xml).toContain('spd="slow"')
    })
  })

  describe('degradation', () => {
    it('reports 3D pushes as degraded', () => {
      expect(buildTransitionXml('slideX3D').degraded).toContain('3D')
      expect(buildTransitionXml('slideY3D').degraded).toContain('3D')
      expect(isTransitionExactOnExport('slideX3D')).toBe(false)
    })

    it('reports rotate as degraded', () => {
      expect(buildTransitionXml('rotate').degraded).toBeTruthy()
      expect(isTransitionExactOnExport('rotate')).toBe(false)
    })

    it('leaves faithful mappings unflagged', () => {
      for (const mode of ['fade', 'slideX', 'slideY', 'scale', 'scaleReverse', 'scaleX', 'scaleY'] as TurningMode[]) {
        expect(buildTransitionXml(mode).degraded).toBeUndefined()
        expect(isTransitionExactOnExport(mode)).toBe(true)
      }
    })

    it('treats "no" and unset as exact (nothing to lose)', () => {
      expect(isTransitionExactOnExport('no')).toBe(true)
      expect(isTransitionExactOnExport(undefined)).toBe(true)
    })
  })

  // 词表漂移防线：SLIDE_ANIMATIONS 加了新转场却忘了补映射，会在这里当场暴露
  describe('vocabulary coverage', () => {
    it('maps every turningMode in SLIDE_ANIMATIONS', () => {
      for (const { value } of SLIDE_ANIMATIONS) {
        if (value === 'no') continue
        const { xml } = buildTransitionXml(value)
        expect(xml, `turningMode "${value}" 没有 OOXML 映射`).not.toBe('')
        expect(xml).toMatch(/^<p:transition spd="(slow|med|fast)"><p:[a-zA-Z]+( [a-z]+="[a-z]+")*\/><\/p:transition>$/)
      }
    })

    // p14/p15 扩展在非 PowerPoint 的阅读器里直接不播，只用基础 schema
    it('never emits an mc:AlternateContent or p14 extension', () => {
      for (const { value } of SLIDE_ANIMATIONS) {
        const { xml } = buildTransitionXml(value)
        expect(xml).not.toContain('mc:')
        expect(xml).not.toContain('p14:')
        expect(xml).not.toContain('p15:')
      }
    })
  })
})
