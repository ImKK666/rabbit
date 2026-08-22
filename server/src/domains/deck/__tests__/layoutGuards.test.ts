/**
 * applyLayout 执行守卫的判据 —— 守卫① 防抖 + 守卫② 换色风暴（R-63）
 *
 * 两条守卫治的是日志里实测出来的两场风暴（会话 76）：
 *   - 同一批 36 页 8 分钟内被整体重排三轮，169 次 applyLayout
 *   - 换色的做法是逐页传覆盖色，而不是 setTheme
 *
 * 守卫状态**每轮一份**（`createAgentTools` 每轮重建），所以这里
 * 每次 `makeHarness()` 都是新的一轮 —— 「下一轮可以重排」正是设计意图。
 */

import { describe, it, expect } from 'vitest'
import type { SlideTheme } from '@/types/slides'
import { createAgentTools, type DeckState } from '../tools'

const THEME: SlideTheme = {
  themeColors: ['#5b9bd5', '#ed7d31', '#a5a5a5', '#ffc000', '#4472c4', '#70ad47'],
  fontColor: '#333',
  fontName: '',
  backgroundColor: '#fff',
  shadow: { h: 3, v: 3, blur: 2, color: '#808080' },
  outline: { width: 2, color: '#525252', style: 'solid' },
}

const makeHarness = () => {
  let state: DeckState = { slides: [], theme: THEME, version: 0 }
  const tools = createAgentTools({
    get: () => state,
    set: (next) => {
      state = next
    },
  })
  return { tools, state: () => state }
}

/** 工具的第二个参数是 SDK 的执行上下文，我们的工具一个都不用 */
const CTX = {} as never
const run = (fn: unknown, args: unknown) =>
  (fn as (a: unknown, c: never) => Promise<string>)(args, CTX)

const addSlide = async (h: ReturnType<typeof makeHarness>, id: string) => {
  await run(h.tools.addSlide.execute, { slide: { id, elements: [] } })
}

const CARD = (title: string) => ({
  title,
  items: [
    { title: '模块一', body: '要点' },
    { title: '模块二', body: '要点' },
    { title: '模块三', body: '要点' },
  ],
})

describe('守卫① · applyLayout 防抖', () => {
  it('同页同版式同内容本轮重排 —— 第二次直接拒，且不动状态', async () => {
    const h = makeHarness()
    await addSlide(h, 's1')

    const first = await run(h.tools.applyLayout.execute, { slideId: 's1', pattern: 'cards', content: CARD('卡片') })
    expect(JSON.parse(first).ok).toBe(true)
    const versionAfterFirst = h.state().version

    const second = await run(h.tools.applyLayout.execute, { slideId: 's1', pattern: 'cards', content: CARD('卡片') })
    const parsed = JSON.parse(second)
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toContain('无需重排')
    expect(h.state().version).toBe(versionAfterFirst)
  })

  it('内容真的变了 —— 放行（重排有正当理由）', async () => {
    const h = makeHarness()
    await addSlide(h, 's1')

    await run(h.tools.applyLayout.execute, { slideId: 's1', pattern: 'cards', content: CARD('卡片') })
    const second = await run(h.tools.applyLayout.execute, { slideId: 's1', pattern: 'cards', content: CARD('换过的标题') })
    expect(JSON.parse(second).ok).toBe(true)
  })

  it('换 variant 重排 —— 放行（B 变体是另一种结构）', async () => {
    const h = makeHarness()
    await addSlide(h, 's1')

    await run(h.tools.applyLayout.execute, { slideId: 's1', pattern: 'cards', content: CARD('卡片') })
    const second = await run(h.tools.applyLayout.execute, { slideId: 's1', pattern: 'cards', variant: 'B', content: CARD('卡片') })
    expect(JSON.parse(second).ok).toBe(true)
  })

  it('**负对照**：kernel 拒掉的排布不记指纹 —— 改了内容还能再排', async () => {
    const h = makeHarness()
    await addSlide(h, 's1')

    // title-center 要求 title，缺了会被 kernel 拒
    const rejected = await run(h.tools.applyLayout.execute, { slideId: 's1', pattern: 'title-center', content: {} })
    expect(JSON.parse(rejected).ok).toBe(false)

    const retry = await run(h.tools.applyLayout.execute, { slideId: 's1', pattern: 'title-center', content: { title: '补上标题' } })
    expect(JSON.parse(retry).ok).toBe(true)
  })

  it('新一轮（重建工具）重新排同一页 —— 放行（用户中间改过主意是合法的）', async () => {
    const h = makeHarness()
    await addSlide(h, 's1')
    await run(h.tools.applyLayout.execute, { slideId: 's1', pattern: 'cards', content: CARD('卡片') })

    const h2 = makeHarness()
    h2.state()
    await run(h2.tools.addSlide.execute, { slide: { id: 's1', elements: [] } })
    const again = await run(h2.tools.applyLayout.execute, { slideId: 's1', pattern: 'cards', content: CARD('卡片') })
    expect(JSON.parse(again).ok).toBe(true)
  })
})

describe('守卫② · 换色风暴', () => {
  const COLORS = { primaryColor: '#1d5c3f', accentColor: '#824010', backgroundColor: '#f5f3ec' }

  it('同一套覆盖色传到第 3 个页 —— 拒并指路 setTheme', async () => {
    const h = makeHarness()
    for (const id of ['s1', 's2']) {
      await addSlide(h, id)
      const out = await run(h.tools.applyLayout.execute, { slideId: id, pattern: 'cards', content: CARD(id), ...COLORS })
      expect(JSON.parse(out).ok, `第 ${id} 页应该放行`).toBe(true)
    }
    await addSlide(h, 's3')
    const third = await run(h.tools.applyLayout.execute, { slideId: 's3', pattern: 'cards', content: CARD('s3'), ...COLORS })
    const parsed = JSON.parse(third)
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toContain('setTheme')
  })

  it('**负对照**：两页同色 = 个别页破例，放行', async () => {
    const h = makeHarness()
    for (const id of ['s1', 's2']) {
      await addSlide(h, id)
      const out = await run(h.tools.applyLayout.execute, { slideId: id, pattern: 'cards', content: CARD(id), ...COLORS })
      expect(JSON.parse(out).ok).toBe(true)
    }
  })

  it('第三页换了别的颜色 —— 不算同一套，放行', async () => {
    const h = makeHarness()
    for (const id of ['s1', 's2']) {
      await addSlide(h, id)
      await run(h.tools.applyLayout.execute, { slideId: id, pattern: 'cards', content: CARD(id), ...COLORS })
    }
    await addSlide(h, 's3')
    const third = await run(h.tools.applyLayout.execute, {
      slideId: 's3', pattern: 'cards', content: CARD('s3'),
      primaryColor: '#0b4a8a', accentColor: '#c05621', backgroundColor: '#f5f3ec',
    })
    expect(JSON.parse(third).ok).toBe(true)
  })

  it('不传覆盖色的正常排版完全不受影响', async () => {
    const h = makeHarness()
    for (let i = 0; i < 4; i++) {
      const id = `s${i}`
      await addSlide(h, id)
      const out = await run(h.tools.applyLayout.execute, { slideId: id, pattern: 'cards', content: CARD(id) })
      expect(JSON.parse(out).ok).toBe(true)
    }
  })
})
