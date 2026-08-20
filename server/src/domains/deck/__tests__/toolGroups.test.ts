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
import { DECK_TOOL_GROUPS, DECK_ROLE_TOOL_GROUPS, deckRoleGroups } from '../toolGroups'
// 名字从不碰库的 assetResults 取 —— `assetTools.ts` 经 db 拉 `bun:sqlite`，值导入会加载失败。
// 类型可以照常 import：`import type` 编译期就抹掉了，运行时不产生依赖
import { ASSET_TOOL_NAMES } from '../assetResults'
import type { AssetTools } from '../assetTools'

const makeDeckTools = () => {
  let state: DeckState = { slides: [], theme: undefined as never, version: 0 }
  const set = (next: DeckState) => {
    state = next
  }
  return createAgentTools({ get: () => state, set })
}

/**
 * deck 工具 + 图片工具的完整键集合。
 *
 * 图片工具本体在 `assetTools.ts`（碰库，vitest 加载不了），这里用占位补齐两个键。
 * 这一组判据要验的是**「组名清单 == 工具键集合」**，占位对它完全够用；
 * 工具自身的行为由 `assetResults.test.ts`（返回形状 / 合规）
 * 和端到端实测（真搜真生成）各管一段。
 *
 * 键名不是硬编码的，来自 `ASSET_TOOL_NAMES` —— 而那份清单被 `assetTools.ts`
 * 里一行编译期断言钉死和真实工具键一致，所以占位不会和现实脱节。
 */
const makeTools = () => {
  const stub = Object.fromEntries(ASSET_TOOL_NAMES.map(n => [n, {}]))
  // 占位物在运行时不是真工具，但这一组只读 `Object.keys` 和对象同一性，够用
  return { ...makeDeckTools(), ...stub } as ReturnType<typeof makeDeckTools> & AssetTools
}

/**
 * 全部 25 个键，独立抄录一份。
 *
 * 前 23 个是拆层前 `createAgentTools` 的原样，**一个字都没改** ——
 * 判据 8「角色配额与拆层前逐键等价」靠的就是它没被动过。
 * 后 2 个是第十八轮 D1 工具层加的，单独列出来，这样「原有配额有没有被动过」
 * 仍然一眼看得出来。
 */
const DECK_TOOL_NAMES = [
  'getDeck', 'getSlide', 'findElements', 'lintDeck', 'getDesignTokens',
  'updateElement', 'addElement', 'deleteElement',
  'addSlide', 'updateSlide', 'deleteSlide',
  'setTheme', 'setSlideBackground',
  'setAnimationPreset', 'addAnimation', 'removeAnimation', 'setSlideTransition',
  'applyLayout', 'addShape', 'addChart', 'addTable', 'addLine', 'arrangeElements',
]

/** 第十八轮加的两个。独立抄，不从 ASSET_TOOL_NAMES 反推 */
const IMAGE_TOOL_NAMES = ['searchImage', 'generateImage']

const ALL_TOOL_NAMES = [...DECK_TOOL_NAMES, ...IMAGE_TOOL_NAMES].sort()

/** 拆层前 planner / reviewer 那个 switch 分支里硬列的 5 个 */
const READONLY_TOOL_NAMES = [
  'getDeck', 'getSlide', 'findElements', 'getDesignTokens', 'lintDeck',
].sort()

describe('工具总集', () => {
  it('是 25 个（23 个 deck + 2 个图片），键名与实现一致', () => {
    // 这条同时是上面几份硬编码清单的锚：工具增删时这里先红，
    // 提醒去更新清单，而不是让清单悄悄和现实脱节
    expect(Object.keys(makeTools()).sort()).toEqual(ALL_TOOL_NAMES)
    expect(ALL_TOOL_NAMES).toHaveLength(25)
  })

  it('原有 23 个 deck 工具一个没少、一个没改名', () => {
    // 判据 8 的实质：加图片工具**不许顺手动到原有配额**
    expect(Object.keys(makeDeckTools()).sort()).toEqual([...DECK_TOOL_NAMES].sort())
    expect(DECK_TOOL_NAMES).toHaveLength(23)
  })

  it('ASSET_TOOL_NAMES 与独立抄的那份一致', () => {
    expect([...ASSET_TOOL_NAMES].sort()).toEqual([...IMAGE_TOOL_NAMES].sort())
  })
})

describe('判据 7 · 单 agent 的配额与合并前的 generator 逐键相等', () => {
  const tools = makeTools()
  const withAssets = { assets: true }

  /**
   * R-51 把四个角色合成一个。**唯一要守住的是配额没变** ——
   * 合并前 generator 拿全部 25 个，合并后也必须是这 25 个，一个不多一个不少。
   *
   * `ALL_TOOL_NAMES` 是本文件顶上**独立抄的一份**，不从 `DECK_TOOL_GROUPS` 反推：
   * 从新数据反推的期望值，在数据本身写错时也会绿。
   */
  it('deck agent 拿全部 25 个', () => {
    expect(Object.keys(getToolSubset('deck', tools, withAssets)).sort()).toEqual(ALL_TOOL_NAMES)
  })

  /**
   * 只读那一档随 planner / reviewer 一起没了。这条留着是因为
   * `READONLY_TOOL_NAMES` 仍然是「read 组」的独立期望值 ——
   * 第二个域进来时大概率又要一个只读 agent，那时这份清单还在。
   */
  it('read 组仍然正好是那 5 个只读工具', () => {
    expect([...DECK_TOOL_GROUPS.read].sort()).toEqual(READONLY_TOOL_NAMES)
  })

  it('挑出来的是同一个工具对象，不是拷贝', () => {
    // 装配只做引用挑选。如果哪天变成结构化克隆，
    // tool() 闭包捕获的 accessor 会静默失效 —— 那是查起来很痛的一类 bug
    expect(getToolSubset('deck', tools, withAssets).getDeck).toBe(tools.getDeck)
  })
})

describe('图片能力关着时整组不注册', () => {
  /**
   * R-32 的教训：「一个永远返回『未接入』的工具只会白白消耗步数预算」。
   * 所以没配对象存储 / 两个取图开关都关着时，**这两个工具压根不进模型的工具表**，
   * 而不是留在表里回一句「未配置」。
   */
  const tools = makeTools()

  it('拿到的正好是原来那 23 个', () => {
    expect(Object.keys(getToolSubset('deck', tools, { assets: false })).sort())
      .toEqual([...DECK_TOOL_NAMES].sort())
  })

  it('默认（不传 assets）就是不给 —— 忘了传不会把图片工具漏出去', () => {
    const names = Object.keys(getToolSubset('deck', tools))
    for (const n of IMAGE_TOOL_NAMES) expect(names).not.toContain(n)
  })

  it('deckRoleGroups 只摘掉 asset 一组，别的组一个不少', () => {
    expect(deckRoleGroups('deck', { assets: false }))
      .toEqual(DECK_ROLE_TOOL_GROUPS.deck.filter(g => g !== 'asset'))
    expect(deckRoleGroups('deck', { assets: true }))
      .toEqual(DECK_ROLE_TOOL_GROUPS.deck)
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

  it('asset 组就是那两个图片工具，且不含任何写 deck 的工具', () => {
    // 图片工具**不碰 deck**：它们只负责把图弄进对象存储、返回 asset:// 地址，
    // 写进 deck 是 agent 随后调 addElement 的事。混进来一个写工具，
    // 就等于开了第二条改 deck 的路，绕过 applyMutation → commit
    expect([...DECK_TOOL_GROUPS.asset].sort()).toEqual([...IMAGE_TOOL_NAMES].sort())
  })

  it('每个角色引用的组名都真实存在', () => {
    const known = new Set(Object.keys(DECK_TOOL_GROUPS))
    for (const [role, groups] of Object.entries(DECK_ROLE_TOOL_GROUPS)) {
      for (const g of groups) expect(known, `${role} 引用了未知组 ${g}`).toContain(g)
    }
  })

  it('每个 agent 都有配额 —— 新增 agent 不许漏配', () => {
    // Record<AgentRole, …> 在编译期已经保证了，这条防的是
    // 有人为了绕过编译错误写成 Partial 或加 index signature
    expect(Object.keys(DECK_ROLE_TOOL_GROUPS).sort()).toEqual(['deck'])
  })
})
