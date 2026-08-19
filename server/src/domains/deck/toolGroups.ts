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

/**
 * 23 个工具分成 6 组。
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
} as const satisfies ToolGroupMap<AgentTools>

export type DeckToolGroup = keyof typeof DECK_TOOL_GROUPS

/** 全部写能力 —— generator / editor 两个写角色共用，避免两处各抄一份组名 */
const ALL_DECK_GROUPS = [
  'read', 'slide', 'element', 'layout', 'theme', 'animation',
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
