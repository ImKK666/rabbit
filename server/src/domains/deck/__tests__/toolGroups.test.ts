/**
 * deck 域工具配额的判据
 *
 * A3 把「角色 → 工具子集」从 `roles.ts` 里的一个 switch 改成了数据。
 * **这是一次纯搬家，配额一个字都不该变** —— 所以这里把拆层前的配额硬编码成期望，
 * 而不是从 `DECK_ROLE_TOOL_GROUPS` 反推。
 *
 * 从数据反推期望的测试是不设防的：改了数据，期望跟着改，测试照样绿。
 * 这一组的价值全在「期望是独立写下来的」。
 */

import { describe, it, expect } from 'vitest'
import { findUngroupedTools } from '@server/runtime/toolRegistry'
import { createAgentTools, type DeckState } from '../tools'
import { getToolSubset } from '../roles'
import { DECK_TOOL_GROUPS, DECK_ROLE_TOOL_GROUPS } from '../toolGroups'

const makeTools = () => {
  let state: DeckState = { slides: [], theme: undefined as never, version: 0 }
  const set = (next: DeckState) => {
    state = next
  }
  return createAgentTools({ get: () => state, set })
}

/** 拆层前 `createAgentTools` 返回的 23 个键，独立抄录一份 */
const ALL_TOOL_NAMES = [
  'getDeck', 'getSlide', 'findElements', 'lintDeck', 'getDesignTokens',
  'updateElement', 'addElement', 'deleteElement',
  'addSlide', 'updateSlide', 'deleteSlide',
  'setTheme', 'setSlideBackground',
  'setAnimationPreset', 'addAnimation', 'removeAnimation', 'setSlideTransition',
  'applyLayout', 'addShape', 'addChart', 'addTable', 'addLine', 'arrangeElements',
].sort()

/** 拆层前 planner / reviewer 那个 switch 分支里硬列的 5 个 */
const READONLY_TOOL_NAMES = [
  'getDeck', 'getSlide', 'findElements', 'getDesignTokens', 'lintDeck',
].sort()

describe('工具总集', () => {
  it('仍然是 23 个，且键名与拆层前一致', () => {
    // 这条同时是上面两份硬编码清单的锚：工具增删时这里先红，
    // 提醒去更新清单，而不是让清单悄悄和现实脱节
    expect(Object.keys(makeTools()).sort()).toEqual(ALL_TOOL_NAMES)
    expect(ALL_TOOL_NAMES).toHaveLength(23)
  })
})

describe('角色配额与拆层前等价', () => {
  const tools = makeTools()

  it('planner 只拿 5 个只读工具', () => {
    expect(Object.keys(getToolSubset('planner', tools)).sort()).toEqual(READONLY_TOOL_NAMES)
  })

  it('reviewer 只拿 5 个只读工具', () => {
    expect(Object.keys(getToolSubset('reviewer', tools)).sort()).toEqual(READONLY_TOOL_NAMES)
  })

  it('generator 拿全部 23 个', () => {
    expect(Object.keys(getToolSubset('generator', tools)).sort()).toEqual(ALL_TOOL_NAMES)
  })

  it('editor 拿全部 23 个', () => {
    expect(Object.keys(getToolSubset('editor', tools)).sort()).toEqual(ALL_TOOL_NAMES)
  })

  it('挑出来的是同一个工具对象，不是拷贝', () => {
    // 装配只做引用挑选。如果哪天变成结构化克隆，
    // tool() 闭包捕获的 accessor 会静默失效 —— 那是查起来很痛的一类 bug
    expect(getToolSubset('planner', tools).getDeck).toBe(tools.getDeck)
  })
})

describe('分组完整性', () => {
  it('每个工具都至少属于一个组 —— 没有够不着的工具', () => {
    // 加了第 24 个工具却忘了归组时，它会编译过、测试过、
    // 然后永远不出现在任何 agent 手里，且没有任何东西报错
    expect(findUngroupedTools(makeTools(), DECK_TOOL_GROUPS)).toEqual([])
  })

  it('所有组的并集恰好是工具全集 —— 组里没有已不存在的工具名', () => {
    const union = new Set(Object.values(DECK_TOOL_GROUPS).flat())
    expect([...union].sort()).toEqual(ALL_TOOL_NAMES)
  })

  it('read 组就是那 5 个只读工具', () => {
    expect([...DECK_TOOL_GROUPS.read].sort()).toEqual(READONLY_TOOL_NAMES)
  })

  it('每个角色引用的组名都真实存在', () => {
    const known = new Set(Object.keys(DECK_TOOL_GROUPS))
    for (const [role, groups] of Object.entries(DECK_ROLE_TOOL_GROUPS)) {
      for (const g of groups) expect(known, `${role} 引用了未知组 ${g}`).toContain(g)
    }
  })

  it('四个角色都有配额 —— 新增角色不许漏配', () => {
    // Record<AgentRole, …> 在编译期已经保证了，这条防的是
    // 有人为了绕过编译错误写成 Partial 或加 index signature
    expect(Object.keys(DECK_ROLE_TOOL_GROUPS).sort())
      .toEqual(['editor', 'generator', 'planner', 'reviewer'])
  })
})
