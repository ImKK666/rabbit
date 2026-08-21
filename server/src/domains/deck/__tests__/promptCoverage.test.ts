/**
 * 工具在提示词里够不够得着 —— R-56 那次调研的机器可判版
 *
 * R-56 的做法是**手工**把 26 个工具名逐个在 prompt 里数一遍，
 * 查出 8 个 0 次出现。那次的结论值得原样记住：
 *
 * > 光数「提示词提没提」是没有意义的，工具的 zod 描述是随请求发给模型的。
 * > 真正会出事的是三种：提示词**反着教**、**工作流里没有它的位置**、
 * > 以及提示词把模型指向了另一条走不通的路。
 *
 * 所以这一组判的不是「提到了没有」，而是**「工作顺序里有没有它的位置」** ——
 * 那才是模型真正据以决定「这一步该干什么」的东西。
 *
 * R-58 加两个生成图层工具时**又踩了一次**：工具装好了、链路通了、
 * 端到端跑过了，而 prompt 里 0 次出现、工作顺序里没有位置 ——
 * 于是模型永远不会想起来调它，**且没有任何东西会报错**。
 */

import { describe, it, expect } from 'vitest'
import { getSystemPrompt } from '../roles'
import { DECK_TOOL_GROUPS } from '../toolGroups'

const prompt = getSystemPrompt('deck')

/**
 * 这些工具**必须在工作顺序里有位置**。
 *
 * 不是全部工具都要 —— `getSlide` / `findElements` 这类自述清楚的读操作，
 * 模型看 zod 描述就会用。要求进工作顺序的是**「不主动说它就不会被想起来」**的那些：
 * 慢、贵、有先后依赖、或者不做也能交差的。
 */
const MUST_BE_IN_WORKFLOW = [
  'setTheme',          // 必须在建页之前，晚了前面的元素就是旧色
  'applyLayout',       // 主力
  'lintDeck',          // 不主动跑就不会跑
  'reflectRender',     // 慢，且只有它看得见渲染后的问题
  'generateBackdrop',  // 慢、贵，且有严格的先后位置
]

describe('工具在提示词里够得着', () => {
  it.each(MUST_BE_IN_WORKFLOW)('%s 出现在提示词里', (name) => {
    expect(prompt).toContain(name)
  })

  /**
   * **这条比「提到了没有」强一档。**
   * 工作顺序是编号列表，模型据它决定「下一步干什么」。
   * 只在某个角落被提一句、而工作顺序里没有位置的工具，实际上等于不存在。
   */
  it('工作顺序那一节里点了名', () => {
    const start = prompt.indexOf('## 工作顺序')
    expect(start).toBeGreaterThan(-1)
    const end = prompt.indexOf('\n## ', start + 1)
    const flow = prompt.slice(start, end === -1 ? undefined : end)
    for (const name of MUST_BE_IN_WORKFLOW) {
      expect(flow, `${name} 不在工作顺序里`).toContain(name)
    }
  })

  /**
   * 生成图层必须排在 reflectRender **之前**。
   *
   * 底图会改变文字背后的颜色，而 reflectRender 那条对比度检查量的是
   * **实际渲染出来的背景**。顺序反了的话，量的是没有底图的版本 —— 白量。
   */
  it('生成图层排在 reflectRender 之前 —— 顺序反了对比度就白量了', () => {
    expect(prompt.indexOf('generateBackdrop')).toBeLessThan(prompt.lastIndexOf('reflectRender'))
    const flow = prompt.slice(prompt.indexOf('## 工作顺序'))
    expect(flow.indexOf('generateBackdrop')).toBeLessThan(flow.indexOf('reflectRender'))
  })

  /**
   * 提示词**没有把模型指向走不通的路** —— R-56 抓到的第三种失败。
   * 那次是「教模型每页传 paletteOverride」，而下游全读 theme。
   */
  it('不教模型用 addElement 去设背景 —— 背景要走 setSlideBackground', () => {
    const start = prompt.indexOf('## 生成图层')
    expect(start).toBeGreaterThan(-1)
    const end = prompt.indexOf('\n## ', start + 1)
    const section = prompt.slice(start, end === -1 ? undefined : end)
    expect(section).toContain('setSlideBackground')
  })
})

describe('反着教的检查', () => {
  /**
   * R-55 踩过：prompt 里写着「这里不给模型调色盘」，而 applyLayout
   * 一直收 primaryColor / accentColor —— **能力存在但没有任何路径够得着，等于不存在**。
   */
  it('没有一个工具组的工具在提示词里被明令禁止使用', () => {
    const banned = /不要(用|使用|调用)\s*(\w+)/g
    const hits: string[] = []
    const all = new Set(Object.values(DECK_TOOL_GROUPS).flat() as string[])
    for (const m of prompt.matchAll(banned)) {
      if (all.has(m[2])) hits.push(m[2])
    }
    expect(hits, `这些工具被提示词明令禁用：${hits.join(', ')}`).toEqual([])
  })
})
