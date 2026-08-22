/**
 * R-68 · 图片字节 → 桶里的一个对象
 *
 * 从 `domains/deck/assetTools.ts` 提出来的，因为**第二个调用方出现了**：
 * 用户在对话框粘贴的图片也要走同一条路（`routes/assets.ts` 的上传端点）。
 *
 * 提取而不是复制，是因为这段代码里有两个「写错了不会报错」的约定：
 *   - `put()` 的 ext 传空串 —— key 必须正好是 `{prefix}{hash}`，多一个 `.jpg`
 *     就和 `asset://<hash>` 对不上（见 `assetConfig.ts` 头注释）
 *   - hash 取 key 的最后一段 —— 那一段才是写进 deck 的东西
 * 复制一份的话，哪天压缩策略或 key 文法改了，两边只会改一边，
 * 而症状是「图在画布上好好的，某条路径下就是取不到」。
 *
 * ## 这个文件刻意不碰库
 *
 * `assetTools.ts` 因为要写票据表而拉了 `db/index.ts`（`bun:sqlite`），
 * **vitest 里 import 不进来**。这里只做「字节 → 压缩 → 上传」，
 * store 由调用方传进来 —— 于是它有判据可写，而那正是本文件值得独立存在的理由。
 */

import { compressImage } from './imageCodec'
import type { ObjectStore } from './objectStore'

/** 落好的一张图。字段与 `assets` 表的列一一对应，方便调用方直接落库 */
export interface StoredImage {
  hash: string
  storageKey: string
  width: number
  height: number
  bytes: number
  originalBytes: number
  compressReason: string
  /** `[p5, p95]` 亮度，给背景遮罩算浓度 */
  luminance: [number, number]
}

/**
 * 把一段图片字节变成桶里的一个对象。
 *
 * key **不带扩展名**，这样 `asset://<hash>` 才解析得到它 ——
 * 理由见 `runtime/assetConfig.ts` 头注释。
 *
 * 认不出格式或字节坏了会抛（`compressImage` 的行为），调用方自己决定
 * 是回一句人话还是让它冒泡。
 */
export const storeImageBytes = async (
  raw: Uint8Array,
  maxEdgePx: number,
  store: ObjectStore,
): Promise<StoredImage> => {
  const out = compressImage(raw, { maxEdgePx })
  const put = await store.put(out.bytes, '', out.contentType)

  // key 形如 `rabbit/<sha256>`；hash 是最后一段，也是写进 deck 的那一段
  const hash = put.key.split('/').pop() ?? ''

  return {
    hash,
    storageKey: put.key,
    width: out.width,
    height: out.height,
    bytes: out.bytes.byteLength,
    originalBytes: out.originalBytes,
    compressReason: out.reason,
    // 解码时顺手量的亮度分布 —— 版式拿它算背景遮罩浓度
    luminance: [out.luminance.p5, out.luminance.p95] as [number, number],
  }
}
