/**
 * deck 域的工具分组与角色配额
 *
 * 拆层前这是 `roles.ts` 里一个 switch。改成数据的三个理由见
 * `server/src/runtime/toolRegistry.ts` 的头注释。
 *
 * 分组的粒度按「一次能力」切，不按「读/写」切 ——
 * 读写只有两档，表达不了「这个 agent 能改内容但不许动主题」这种配额，
 * 而那正是接入更多 agent 之后马上会需要的。
 */

import type { ToolGroupMap } from '@server/runtime/toolRegistry'
import type { AgentRole } from '@server/db/schema'
import type { AgentTools } from './tools'
// **必须是 `import type`。** `assetTools.ts` 经 `db/index.ts` 拉 `bun:sqlite`，
// 写成值导入会让这个文件（以及 import 它的每一个测试）在 vitest 里加载失败。
// 类型导入编译期就抹掉了，运行时不产生任何依赖
import type { AssetTools } from './assetTools'

/** deck 域现在能提供的全部工具。装配时由 `pipeline.ts` 把两组合到一起 */
export type DeckTools = AgentTools & AssetTools

/**
 * 25 个工具分成 7 组。
 *
 * `satisfies` 而不是类型标注：这样组里写错工具名是**编译错误**，
 * 同时 `DECK_TOOL_GROUPS` 的键仍是字面量联合，
 * 下面 `DeckToolGroup` 才能自动跟着长，不用手抄一份组名列表。
 */
export const DECK_TOOL_GROUPS = {
  /** 只读。任何角色都该有 —— 不让看就只能瞎猜 */
  read: ['getDeck', 'getSlide', 'findElements', 'lintDeck', 'getDesignTokens'],

  /** 页级增删改 */
  slide: ['addSlide', 'updateSlide', 'deleteSlide'],

  /** 元素级增删改 */
  element: ['addElement', 'updateElement', 'deleteElement'],

  /** 版面与图形。`applyLayout` 在这组里，它是整页替换语义，杠杆最大的一个 */
  layout: ['applyLayout', 'addShape', 'addChart', 'addTable', 'addLine', 'arrangeElements'],

  /** 主题与背景。改这个是整份 deck 级别的影响，所以单独一组 */
  theme: ['setTheme', 'setSlideBackground'],

  /** 动画与转场 */
  animation: ['setAnimationPreset', 'addAnimation', 'removeAnimation', 'setSlideTransition'],

  /**
   * 取图。单独一组是因为它**可以整组不给** ——
   * 没配对象存储 / 两个开关都关着时，这一组不进任何角色的工具表。
   *
   * 照 R-32 的教训：「一个永远返回『未接入』的工具只会白白消耗步数预算」。
   * 所以「有没有这个能力」由装配时决定（见 `deckRoleGroups`），
   * 而不是让工具自己在运行时回一句「未配置」。
   */
  asset: ['searchImage', 'generateImage'],
} as const satisfies ToolGroupMap<DeckTools>

export type DeckToolGroup = keyof typeof DECK_TOOL_GROUPS

/** 全部写能力 —— generator / editor 两个写角色共用，避免两处各抄一份组名 */
const ALL_DECK_GROUPS = [
  'read', 'slide', 'element', 'layout', 'theme', 'animation', 'asset',
] as const satisfies readonly DeckToolGroup[]

/**
 * 角色 → 工具组。
 *
 * 与拆层前的 `getToolSubset` switch **行为完全一致**：
 * planner / reviewer 拿那 5 个只读工具，generator / editor 拿全集。
 * A3 只把规则从控制流搬成数据，不改配额 —— 改配额是另一件事，要单独验。
 *
 * Planner 和 Reviewer 只给只读，是第六轮定下的：
 * 它们的职责是判断不是动手，给了写工具只会让它们绕过 Generator 自己改，
 * 而它们的 prompt 里没有任何设计规范。
 */
export const DECK_ROLE_TOOL_GROUPS: Record<AgentRole, readonly DeckToolGroup[]> = {
  planner: ['read'],
  reviewer: ['read'],
  generator: ALL_DECK_GROUPS,
  editor: ALL_DECK_GROUPS,
}

/**
 * 这次装配实际给某个角色哪些组。
 *
 * 图片能力关着时把 `asset` 整组摘掉，而不是留一个会回「未配置」的工具。
 * 差别是实打实的：留着的话模型每轮都会试着调它、拿到失败、再想别的办法，
 * **一次往返就没了** —— R-32 当初决定「没实现的工具不注册」正是这个理由。
 *
 * 写成函数而不是在 `DECK_ROLE_TOOL_GROUPS` 上做手脚：
 * 那张表是**静态配额**（谁有资格用什么），这里是**本次可用性**（这次装了什么），
 * 两件事混在一起会让「为什么 generator 没有 searchImage」变得无从查起。
 */
export const deckRoleGroups = (
  role: AgentRole,
  { assets }: { assets: boolean },
): readonly DeckToolGroup[] => {
  const groups = DECK_ROLE_TOOL_GROUPS[role]
  return assets ? groups : groups.filter(g => g !== 'asset')
}
