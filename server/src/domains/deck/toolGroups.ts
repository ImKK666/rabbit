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
// 同上，必须 `import type`：`reflectTool.ts` 经 `runtime/llm.ts` 拉 `bun:sqlite`
import type { ReflectTools } from './reflectTool'
// 同上，必须 `import type`：`ornamentTool.ts` 经 `runtime/assetConfig.ts` 拉 `bun:sqlite`
import type { OrnamentTools } from './ornamentTool'

/** deck 域现在能提供的全部工具。装配时由 `pipeline.ts` 把三组合到一起 */
export type DeckTools = AgentTools & AssetTools & ReflectTools & OrnamentTools

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

  /**
   * 渲染后反思（R-52）。
   *
   * 单独一组而不是并进 `read`：它和别的只读工具**代价完全不是一个量级** ——
   * 一次调用要让前端全量渲染一遍（最长等 20 秒），配了视觉模型时还要
   * 再叫几次模型。哪天需要「便宜的只读 agent」时，这一组要能单独摘掉。
   */
  render: ['reflectRender'],

  /**
   * 生成装饰层（docs/14）。
   *
   * **和 `asset` 分开，虽然两者都要生图模型。** 理由是它们可以各自关掉：
   * 配图是内容能力（没图这份稿子就是纯文字），装饰是质感增强（没它稿子照样成立）。
   * 并成一组的话，「只想要配图不想要装饰」就没法表达 ——
   * 而这正是每页多花 15 秒之后第一个会提的要求。
   */
  ornament: ['addOrnament', 'generateBackdrop'],
} as const satisfies ToolGroupMap<DeckTools>

export type DeckToolGroup = keyof typeof DECK_TOOL_GROUPS

/** 全部能力。单独抽出来是为了下面那张表和判据都指向同一份组名 */
const ALL_DECK_GROUPS = [
  'read', 'slide', 'element', 'layout', 'theme', 'animation', 'asset', 'render', 'ornament',
] as const satisfies readonly DeckToolGroup[]

/**
 * agent → 工具组。
 *
 * **R-51 之前这里有四行**：planner / reviewer 只拿那 5 个只读工具，
 * generator / editor 拿全集。合并成一个 agent 之后只剩一行，
 * 配额**与原来的 generator 逐键相等** —— 判据 7 在 `toolGroups.test.ts` 里
 * 把那 25 个键独立抄了一份当期望，不从这张表反推。
 *
 * 只读那一档没了，因为「只判断不动手」的角色没了。
 * 这一层本身保留：它表达的是「谁有资格用什么」，
 * 而第二个域接进来时马上要用到这个表达力（见 `toolRegistry.ts` 头注释）。
 */
export const DECK_ROLE_TOOL_GROUPS: Record<AgentRole, readonly DeckToolGroup[]> = {
  deck: ALL_DECK_GROUPS,

  /**
   * 视觉复核**一个工具都不给**，这是刻意的。
   *
   * 它做的事是「看一张渲染出来的截图，说出哪里不对」——一次性的、只出文字的判断。
   * 给它工具就等于放它进来改 deck，而那时就有两个写者了
   * （B 期「单一权威写者」防的正是这件事）。改由 deck agent 拿着它的意见去改，
   * 谁负责动手这件事仍然只有一个答案。
   */
  reflect: [],
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
  { assets, ornament = assets }: { assets: boolean, ornament?: boolean },
): readonly DeckToolGroup[] => {
  const groups = DECK_ROLE_TOOL_GROUPS[role]
  return groups.filter(g =>
    (g !== 'asset' || assets)
    // 装饰层也要生图，所以 `assets` 关着时它一定不可用；
    // 但反过来不成立 —— 开着生图而单独关掉装饰是合法配置，默认跟随 `assets`
    && (g !== 'ornament' || (assets && ornament)),
  )
}
