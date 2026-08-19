/**
 * 工具组装配的判据（域无关）
 *
 * 这里只测纯函数本身，不碰 deck。deck 域的配额是否等价于拆层前，
 * 由 `server/src/domains/deck/__tests__/toolGroups.test.ts` 守。
 */

import { describe, it, expect } from 'vitest'
import { selectToolGroups, findUngroupedTools, type ToolGroupMap } from '../toolRegistry'

/** 拿字符串当工具，测的是键的挑选逻辑，和工具本身长什么样无关 */
const TOOLS = {
  read1: 'r1', read2: 'r2',
  write1: 'w1', write2: 'w2',
  rare: 'x',
} as const

const GROUPS = {
  read: ['read1', 'read2'],
  write: ['write1', 'write2'],
  everything: ['read1', 'read2', 'write1', 'write2', 'rare'],
} as const satisfies ToolGroupMap<typeof TOOLS>

describe('selectToolGroups', () => {
  it('按组名挑出工具', () => {
    expect(selectToolGroups(TOOLS, GROUPS, ['read'])).toEqual({ read1: 'r1', read2: 'r2' })
  })

  it('多个组合并', () => {
    expect(selectToolGroups(TOOLS, GROUPS, ['read', 'write'])).toEqual({
      read1: 'r1', read2: 'r2', write1: 'w1', write2: 'w2',
    })
  })

  it('组重叠时不重复也不出错 —— 两个组共享同一个工具是正常的', () => {
    expect(selectToolGroups(TOOLS, GROUPS, ['read', 'everything'])).toEqual(TOOLS)
  })

  it('空配额得到空工具集，不抛错', () => {
    // 「这个 agent 一个工具都不给」是合法配置（纯对话角色），不是错误
    expect(selectToolGroups(TOOLS, GROUPS, [])).toEqual({})
  })

  it('不改动传入的 all —— 装配是纯函数', () => {
    const before = { ...TOOLS }
    selectToolGroups(TOOLS, GROUPS, ['everything'])
    expect(TOOLS).toEqual(before)
  })

  describe('负对照：未知组名必须抛错，不能静默跳过', () => {
    // 静默跳过的表现是「agent 突然什么都不会做了」，
    // 比启动时抛一条明确的错难查一个数量级。
    // 与 budget.ts 对非法环境变量「忽略退回默认」的处置故意相反，
    // 理由见 toolRegistry.ts 头注释：那边的输入是用户打的字，这边是代码里的常量。
    it('抛错', () => {
      expect(() => selectToolGroups(TOOLS, GROUPS, ['reed'])).toThrow(/未知的工具组 "reed"/)
    })

    it('错误消息里列出可用组名 —— 打错字时要能直接看出正确拼法', () => {
      expect(() => selectToolGroups(TOOLS, GROUPS, ['reed']))
        .toThrow(/everything, read, write/)
    })

    it('混在合法组名中间的错别字一样抓得到', () => {
      expect(() => selectToolGroups(TOOLS, GROUPS, ['read', 'rite', 'write'])).toThrow(/"rite"/)
    })
  })
})

describe('findUngroupedTools', () => {
  it('全部归了组时返回空', () => {
    expect(findUngroupedTools(TOOLS, GROUPS)).toEqual([])
  })

  describe('负对照：漏网的工具真的抓得到', () => {
    // 守的是一个会静默发生的退化：加了新工具、忘了归组 ——
    // 编译过、测试过、agent 永远拿不到它。
    // 和第七轮动画「死词表是 0 个」是同一类判据。
    it('抓得到一个没进任何组的工具', () => {
      const incomplete = {
        read: ['read1', 'read2'],
        write: ['write1', 'write2'],
      } as const satisfies ToolGroupMap<typeof TOOLS>
      expect(findUngroupedTools(TOOLS, incomplete)).toEqual(['rare'])
    })

    it('一个组都没有时全部工具都算漏网', () => {
      expect(findUngroupedTools(TOOLS, {}).sort()).toEqual(
        ['rare', 'read1', 'read2', 'write1', 'write2'],
      )
    })
  })
})
