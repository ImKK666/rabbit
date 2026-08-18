/**
 * R-36 · 动画三方一致性的静态闸门
 *
 * 「45 个效果播成什么样」最终只能在浏览器里看（见 scripts/measure-animation-lab.mjs），
 * 但**三条会静默失效的连接**可以在这里钉死，省得下次加效果时又靠人肉核对：
 *
 *   ① 词表 → CSS      cssClass 写错一个字母，网页侧回退到 fadeIn，没有任何报错
 *   ② 词表 → 面板     漏进 ENTER/ATTENTION/EXIT_ANIMATIONS 的效果，UI 里根本选不到
 *   ③ 翻页词表 → CSS  turningMode 没有对应的 .turning-mode-* 规则，翻页直接没动画
 *
 * 三条都是「文件 A 改了、文件 B 没跟上」，类型系统管不着 —— 只能读文件对。
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ANIMATION_DEFS,
  ANIMATION_CLASS_PREFIX,
  getAnimationCssClass,
  isAnimationEffect,
  formatEffectFilter,
  ENTER_ANIMATIONS,
  ATTENTION_ANIMATIONS,
  EXIT_ANIMATIONS,
  SLIDE_ANIMATIONS,
  TURNING_MODES,
  OOXML_EFFECT_FILTERS,
} from '../animation'
import type { AnimationEffect } from '@/types/slides'

const ROOT = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf-8')

const ALL = Object.values(ANIMATION_DEFS)

describe('词表本体', () => {
  it('45 个效果，value 与 key 一致', () => {
    expect(ALL).toHaveLength(45)
    for (const [key, def] of Object.entries(ANIMATION_DEFS)) expect(def.value).toBe(key)
  })

  it('type 与 effect 命名自洽：exit-* 是 out，其余不是', () => {
    for (const def of ALL) {
      if (def.value.startsWith('exit-')) expect(def.type, def.value).toBe('out')
      else expect(def.type, def.value).not.toBe('out')
    }
  })

  it('presetClass 与 type 对得上', () => {
    const expected = { in: 'entr', out: 'exit', attention: 'emph' } as const
    for (const def of ALL) expect(def.pptx.presetClass, def.value).toBe(expected[def.type])
  })

  it('effectFilter 的子类型都在 OOXML 词表里（编译期已挡，这里防有人加 as any）', () => {
    for (const def of ALL) {
      const f = def.pptx.effectFilter
      if (!f) continue
      const subtypes = OOXML_EFFECT_FILTERS[f.name] as readonly string[]
      expect(subtypes, def.value).toBeDefined()
      if (subtypes.length) expect(subtypes, def.value).toContain((f as { subtype: string }).subtype)
      else expect(f, def.value).not.toHaveProperty('subtype')
    }
  })

  it('未知 effect 回退到淡入，而不是拼出一个不存在的类名', () => {
    expect(getAnimationCssClass('bounceInDown')).toBe(`${ANIMATION_CLASS_PREFIX}fadeIn`)
    expect(isAnimationEffect('bounceInDown')).toBe(false)
    expect(isAnimationEffect('fade-up')).toBe(true)
  })

  it('formatEffectFilter 按有无子类型拼串', () => {
    expect(formatEffectFilter({ name: 'wipe', subtype: 'up' })).toBe('wipe(up)')
    expect(formatEffectFilter({ name: 'dissolve' })).toBe('dissolve')
  })
})

// ---------------------------------------------------------------------------
// ① 词表 → CSS
// ---------------------------------------------------------------------------

describe('每个 cssClass 都真的有规则', () => {
  // animate.css 提供 12 个，剩下 33 个在 animation-extra.scss 自定义
  const animateCss = read('node_modules/animate.css/animate.css')
  const extraScss = read('src/assets/styles/animation-extra.scss')

  it.each(ALL.map(d => [d.value, d.cssClass] as const))(
    '%s → .%s',
    (value, cssClass) => {
      const selector = `.${ANIMATION_CLASS_PREFIX}${cssClass}`
      const hit = animateCss.includes(`${selector} `) || animateCss.includes(`${selector},`)
        || animateCss.includes(`${selector}{`) || animateCss.includes(`${selector}\n`)
        || extraScss.includes(`${selector} `) || extraScss.includes(`${selector},`)
        || extraScss.includes(`${selector}{`) || extraScss.includes(`${selector}\n`)
      expect(hit, `${value} 的 ${selector} 在 animate.css 和 animation-extra.scss 里都找不到`).toBe(true)
    },
  )

  it('自定义类都声明了 animation-name —— 没有 animation-name 就不会触发 animationend，放映会卡死', () => {
    // useExecPlay 靠 animationend 推进 inAnimation 标志位；一个不会动的类
    // 不只是「看着没动画」，而是整页放映停在那里再也点不动
    const custom = ALL.filter(d => extraScss.includes(`.${ANIMATION_CLASS_PREFIX}${d.cssClass}`))
    expect(custom.length).toBeGreaterThan(20)
    for (const def of custom) {
      const selector = `.${ANIMATION_CLASS_PREFIX}${def.cssClass}`
      const block = extraScss.slice(extraScss.indexOf(selector))
      expect(block.slice(0, block.indexOf('}')), def.value).toContain('animation-name')
    }
  })

  it('cssClass 没有重名（重名意味着两个效果在网页上长得一模一样）', () => {
    const byClass = new Map<string, string[]>()
    for (const def of ALL) {
      byClass.set(def.cssClass, [...(byClass.get(def.cssClass) ?? []), def.value])
    }
    expect([...byClass.entries()].filter(([, v]) => v.length > 1)).toEqual([])
  })
})

describe('cssExact 标注', () => {
  // 显式列出「网页只是近似」的那些。改这张表是一个需要解释的动作，
  // 不该是某次顺手改 CSS 时悄悄发生的副作用
  const APPROXIMATE: AnimationEffect[] = [
    // 逐块揭示的滤镜：CSS 只能用 mask 拼形似的，分块数和节奏对不上
    'blinds-h', 'blinds-v', 'checkerboard', 'randombar', 'strips-in', 'dissolve-in',
    'exit-dissolve', 'exit-blinds',
    // animate.css 的 back* 多带一路缩放，PPTX 侧只有位移 + 淡入
    'fly-in', 'exit-fly',
  ]

  it('近似清单与词表一致', () => {
    const flagged = ALL.filter(d => !d.cssExact).map(d => d.value).sort()
    expect(flagged).toEqual([...APPROXIMATE].sort())
  })

  it('带 filter 的几何效果里，clip-path 能精确表达的那批标的是 exact', () => {
    // 盒状 / 圆形 / 菱形 / 十字 / 楔入 / 轮辐 / 擦除：CSS 有对应的原生几何，
    // 不是拿 mask 硬凑的，所以是 exact
    for (const v of ['box-in', 'circle-in', 'diamond-in', 'plus-in', 'wedge-in', 'wheel-in',
      'wipe', 'wipe-up', 'wipe-down', 'wipe-right', 'exit-wipe', 'exit-circle'] as AnimationEffect[]) {
      expect(ANIMATION_DEFS[v].cssExact, v).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// ② 词表 → 面板
// ---------------------------------------------------------------------------

describe('面板分组', () => {
  const groups = [...ENTER_ANIMATIONS, ...ATTENTION_ANIMATIONS, ...EXIT_ANIMATIONS]
  const listed = groups.flatMap(g => g.children.map(c => c.value))

  it('45 个效果每个恰好出现一次 —— 漏一个就是 UI 里选不到', () => {
    expect([...listed].sort()).toEqual(Object.keys(ANIMATION_DEFS).sort())
  })

  it('分组的 type 与效果的 type 一致', () => {
    const check = (gs: typeof ENTER_ANIMATIONS, type: string) => {
      for (const g of gs) {
        for (const c of g.children) expect(ANIMATION_DEFS[c.value].type, c.value).toBe(type)
      }
    }
    check(ENTER_ANIMATIONS, 'in')
    check(ATTENTION_ANIMATIONS, 'attention')
    check(EXIT_ANIMATIONS, 'out')
  })

  it('分组内的展示名取自词表，没有第二份手抄的名字', () => {
    for (const g of groups) {
      for (const c of g.children) expect(c.name, c.value).toBe(ANIMATION_DEFS[c.value].name)
    }
  })
})

// ---------------------------------------------------------------------------
// ③ 翻页词表 → CSS
// ---------------------------------------------------------------------------

describe('翻页转场', () => {
  const screenList = read('src/views/Screen/ScreenSlideList.vue')

  it.each(TURNING_MODES.filter(m => m !== 'random'))(
    'turning-mode-%s 在 ScreenSlideList 里有规则',
    (mode) => {
      expect(screenList).toContain(`&.turning-mode-${mode} {`)
    },
  )

  it('random 不需要规则 —— 渲染前已被 useSlidesWithTurningMode 换成具体值', () => {
    const hook = read('src/views/Screen/hooks/useSlidesWithTurningMode.ts')
    expect(hook).toContain(`turningMode === 'random'`)
    expect(screenList).not.toContain('turning-mode-random {')
  })

  it('SLIDE_ANIMATIONS 与 TURNING_MODES 同源，没有第二份清单', () => {
    expect(TURNING_MODES).toEqual(SLIDE_ANIMATIONS.map(s => s.value))
    expect(new Set(TURNING_MODES).size).toBe(TURNING_MODES.length)
  })
})
