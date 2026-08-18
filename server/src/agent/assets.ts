/**
 * R-32 · 图片 / 图标资产接口（**本轮只定义形状，不实现**）
 *
 * 08-expressiveness.md 诊断 ① 说得很清楚：零图片能力是「产出没新意」里最大的一条。
 * 但决策 P1 把它推到下一轮 —— 本轮只做形状 / 图标 / 图表。
 *
 * 这个文件存在的意义是**把接口定死**，让下一轮只需要填实现，不需要重新设计：
 *   - 前端的 `asset://` 解析器和 pending 骨架屏早就就绪（R-10 / R-11）
 *   - 后端的 kernel 校验、WebSocket 下发链路也都在
 *   - 缺的只有「谁去把 prompt 变成一张图」这一段
 *
 * ## 为什么不注册成 LLM 工具
 *
 * 一个永远返回「未接入」的工具只会白白消耗 agent 的步数预算：
 * 模型会试着调它、拿到失败、再想别的办法，一轮往返就没了。
 * Generator 现在 48 步，这种浪费是实打实的。
 *
 * 所以 `createAssetTools()` 存在但**不出现在 roles.ts 的工具子集里**。
 * 接上 provider 那天，把它并进 getToolSubset 即可，工具签名不用改。
 */

import type { PPTImageElement } from '@/types/slides'

// ---------------------------------------------------------------------------
// 协议
// ---------------------------------------------------------------------------

export type AssetKind = 'image' | 'icon'

/** 图片在版面里怎么摆 —— 决定裁剪策略 */
export type AssetFit = 'cover' | 'contain'

export interface AssetRequest {
  kind: AssetKind
  /** 自然语言描述。图库检索当关键词用，生图当 prompt 用 */
  prompt: string
  /** 目标框，用来定裁剪比例和生成尺寸 */
  targetBox: { width: number, height: number }
  fit: AssetFit
  /** 要把结果写回哪个元素的 src。空则由调用方决定 */
  elementId?: string
  /** 图标专用：线性 / 面性 / 双色 */
  style?: 'regular' | 'bold' | 'fill' | 'duotone'
  /** 主色，图标会按它着色 */
  color?: string
}

/**
 * 立即返回的占位结果。
 *
 * `asset://pending/<id>` 是前端约定的骨架屏地址（utils/assetUrl.ts 已实现），
 * 任务完成后再推一个 patch 把它换成 `asset://<sha256>`。
 * **同步等图会把 agent 卡在一个几十秒的工具调用上**，所以这里必须是异步的。
 */
export interface AssetTicket {
  id: string
  src: string
  status: 'pending'
}

export interface AssetResolved {
  id: string
  /** `asset://<sha256>` */
  src: string
  status: 'ready'
  width: number
  height: number
  /** 图库来源时的署名信息，合规需要 */
  attribution?: { author: string, source: string, url: string }
}

export interface AssetFailed {
  id: string
  status: 'failed'
  reason: string
}

export type AssetResult = AssetResolved | AssetFailed

/**
 * 资产 provider。
 *
 * 两条路子共用一个接口：
 *   图库检索  Unsplash / Pexels / 自建库 —— 快、免费、真实感强、但可控性差
 *   生图      GPT-image-1 / Gemini —— 慢、要钱、但能精确匹配版面需求
 *
 * 选哪条由实现方按 kind + prompt 决定，agent 不需要知道。
 */
export interface AssetProvider {
  readonly name: string
  readonly kinds: readonly AssetKind[]
  /** 入队，立刻返回票据 */
  enqueue(request: AssetRequest): Promise<AssetTicket>
  /** 查询结果；未完成时返回 null */
  poll(ticketId: string): Promise<AssetResult | null>
}

/** 把解析结果落到图片元素上 —— 实现之后 patch 走这里，保证字段一致 */
export const applyAssetToImageElement = (
  element: PPTImageElement,
  asset: AssetResolved,
  fit: AssetFit,
): PPTImageElement => {
  if (fit === 'contain' || !asset.width || !asset.height) {
    return { ...element, src: asset.src, fixedRatio: true }
  }

  // cover：按目标框比例居中裁剪
  const boxRatio = element.width / element.height
  const srcRatio = asset.width / asset.height
  const [x0, y0, x1, y1] = srcRatio > boxRatio
    ? [(1 - boxRatio / srcRatio) / 2, 0, 1 - (1 - boxRatio / srcRatio) / 2, 1]
    : [0, (1 - srcRatio / boxRatio) / 2, 1, 1 - (1 - srcRatio / boxRatio) / 2]

  return {
    ...element,
    src: asset.src,
    fixedRatio: false,
    clip: {
      shape: 'rect',
      range: [[x0 * 100, y0 * 100], [x1 * 100, y1 * 100]],
    },
  }
}

// ---------------------------------------------------------------------------
// 实现位
// ---------------------------------------------------------------------------

/**
 * TODO(R-32): 接入真实 provider。落地时需要：
 *   1. 对象存储（S3 / R2）—— 04-changes.md「待完成」里的「图片资产存储」
 *   2. 内容寻址：下载后算 sha256 当 key，同一张图不会存两份
 *   3. 一张任务表（assets）记 ticket → 状态 → src，进程重启不丢
 *   4. 完成后经 WebSocket 推 `agent.deck`，前端 pending 骨架屏自动换成图
 *   5. 把 searchImage / generateImage 并进 roles.ts 的 generator / editor 工具子集
 */
export const createAssetProvider = (): AssetProvider | null => null

export const ASSET_TODO = 'R-32: 图片 / 图标能力本轮未实现，接口已定义，见 server/src/agent/assets.ts'
