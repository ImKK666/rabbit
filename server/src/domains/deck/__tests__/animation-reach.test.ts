/**
 * R-36 · agent 到底会用到哪些动画
 *
 * 45 个效果有三条通往产物的路，粗细完全不同：
 *
 *   a) layouts.ts 的 10 个版式  写死在代码里，**每份 deck 必然跑到**
 *   b) applyAnimationPreset     默认 fade-up，title-then-content 另用 fade-down
 *   c) LLM 自选                 z.enum 覆盖全部 45 个，ANIMATION_GUIDE 按性格列给模型
 *
 * 这里钉死两件事：
 *   **没有死词表** —— 45 个都在 z.enum 里，也都在 prompt 里被点过名。
 *     少一个就等于「定义了但模型永远不知道它存在」
 *   **写死的那批全是合法值** —— 版式里的 effect 是字符串字面量，
 *     打错字 TypeScript 拦得住，但改名词表时漏改这里拦不住
 */

import { describe, it, expect } from 'vitest'
import type { AnimationEffect, SlideTheme } from '@/types/slides'
import { ANIMATION_DEFS } from '@/configs/animation'
import { ANIMATION_EFFECTS } from '../kernel'
import { getSystemPrompt } from '../roles'
import { LAYOUT_PATTERNS, buildLayout, type LayoutContent } from '../layouts'
import { buildPalette } from '../design'

const VOCAB = Object.keys(ANIMATION_DEFS) as AnimationEffect[]

const THEME: SlideTheme = {
  themeColors: ['#2f6feb', '#f2596b', '#a5a5a5', '#ffc000', '#4472c4', '#70ad47'],
  fontColor: '#1a1a1a',
  fontName: '',
  backgroundColor: '#ffffff',
  shadow: { h: 3, v: 3, blur: 2, color: '#808080' },
  outline: { width: 2, color: '#525252', style: 'solid' },
}

/** 把每个可选字段都填满，才能覆盖版式里 `if (c.eyebrow)` 这类分支挂的动画 */
const items = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ label: `L${i}`, title: `标题${i}`, body: `正文${i}` }))

const fullContent = (n: number): LayoutContent => ({
  eyebrow: '章节', title: '标题', subtitle: '副标题', items: items(n),
  stat: { value: '87%', label: '标签', note: '注释' }, quote: '引述', source: '出处',
})

const layoutEffects = (): Set<AnimationEffect> => {
  const palette = buildPalette(THEME)
  const found = new Set<AnimationEffect>()
  for (const pattern of LAYOUT_PATTERNS) {
    const n = pattern === 'compare' ? 2 : pattern === 'timeline' ? 3 : 4
    const { animations } = buildLayout(pattern, fullContent(n), palette, 'x')
    for (const a of animations) found.add(a.effect)
  }
  return found
}

describe('c) LLM 自选的范围', () => {
  it('z.enum 覆盖全部 45 个 —— 没有「定义了但工具参数里选不到」的', () => {
    expect([...ANIMATION_EFFECTS].sort()).toEqual([...VOCAB].sort())
  })

  it('ANIMATION_GUIDE 把 45 个全点了名 —— 没进 prompt 等于模型不知道它存在', () => {
    const prompt = getSystemPrompt('generator')
    const missing = VOCAB.filter(v => !prompt.includes(v))
    expect(missing).toEqual([])
  })

  it('ANIMATION_GUIDE 里没有词表外的名字（改名时最容易漏的地方）', () => {
    const prompt = getSystemPrompt('generator')
    const start = prompt.indexOf('效果按**性格**分')
    const end = prompt.indexOf('**整份文稿至少用到 3 种')
    expect(start, '性格清单的锚点变了，这条断言要跟着改').toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)

    const tokens = prompt.slice(start, end).match(/[a-z][a-z-]{2,}/g) ?? []
    const unknown = [...new Set(tokens)].filter(t => !VOCAB.includes(t as AnimationEffect))
    expect(unknown).toEqual([])
  })

  it('editor 角色也拿得到这份清单', () => {
    expect(getSystemPrompt('editor')).toContain('blinds-h')
  })
})

describe('a) 版式写死的编排', () => {
  const used = layoutEffects()

  it('版式用到的每个 effect 都在词表里', () => {
    for (const e of used) expect(VOCAB, e).toContain(e)
  })

  it('版式只用入场类 —— 出场编排里混进退场/强调会让元素直接消失', () => {
    for (const e of used) expect(ANIMATION_DEFS[e].type, e).toBe('in')
  })

  // 这不是「越多越好」，而是防退化：某次重构把版式动画全换成 fade-up 时要有人喊
  it('10 个版式合起来用到 12 种以上效果，且不全是 fade 系', () => {
    expect(used.size).toBeGreaterThanOrEqual(12)
    expect([...used].filter(e => !e.startsWith('fade')).length).toBeGreaterThanOrEqual(6)
  })

  it('写死的那批里包含几何/擦除类，不是清一色位移', () => {
    for (const e of ['wipe', 'circle-in', 'wedge-in', 'blinds-v'] as AnimationEffect[]) {
      expect(used, `${e} 曾经是某个版式的招牌动画，被换掉要有意识`).toContain(e)
    }
  })
})

describe('b) applyAnimationPreset 的默认值', () => {
  it('默认入场与标题效果都是合法词表项', () => {
    for (const e of ['fade-up', 'fade-down'] as AnimationEffect[]) {
      expect(VOCAB).toContain(e)
      expect(ANIMATION_DEFS[e].type).toBe('in')
    }
  })
})

describe('三条路合起来', () => {
  it('没有任何一个效果是三条路都够不着的', () => {
    // z.enum 覆盖全集，所以这条永远成立 —— 断言的是「z.enum 别哪天被收窄成子集」
    const reachable = new Set<string>([...ANIMATION_EFFECTS, ...layoutEffects()])
    expect(VOCAB.filter(v => !reachable.has(v))).toEqual([])
  })

  it('写死路径只覆盖一部分，其余靠模型选 —— 记录这个分工，变了要有人解释', () => {
    const hardcoded = layoutEffects()
    expect(hardcoded.size).toBeLessThan(VOCAB.length)
    expect(VOCAB.length - hardcoded.size).toBeGreaterThan(20)
  })
})
