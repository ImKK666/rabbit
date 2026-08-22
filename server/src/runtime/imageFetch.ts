/**
 * R-68 · 把用户上传的图取回内存，交给模型
 *
 * ## 为什么不能给模型一个 URL
 *
 * AI SDK 的 image part 两种都收：URL 或字节。给 URL 省事，但那等于
 * **要求 provider 自己去下载那个地址** —— 中转站往往取不到。
 * 实测第一版就栽在这里，报的是：
 *
 *   Unable to download content from the provided URL before the timeout.
 *
 * 而画布上那张图好好的，控制台干干净净，看不出问题出在哪一端。
 * 内联字节把这件事变成我们自己的责任：我们的服务器能取到，就一定送得到模型。
 *
 * 代价是请求体变大（一张图几百 KB 的 base64）。可接受 ——
 * 视觉复核（`reflectTool.ts`）走 data URL，本质上也是内联，一直是这么用的。
 *
 * ## 为什么单独一个文件
 *
 * `turnMemory.ts` 是同步纯函数，而取图是异步 IO。把 fetch 塞进去会让它
 * 再也不能在 vitest 里裸跑，而"能裸跑"是它全部判据的前提。
 * 所以字节在这里预取好，那边只做同步查表。
 */

import type { LoadedImage } from './turnMemory'

/** 一次取图的超时。取不到就少一张图，不该把整轮任务拖死 */
const FETCH_TIMEOUT_MS = 15_000

/**
 * 单张图的上限。**超了就丢掉，而不是截断** ——
 * 半张图的字节送给模型只会得到一个更难查的错误。
 *
 * 上传端点已经压到长边 1568（`routes/assets.ts`），正常不会到这个量级；
 * 这里挡的是历史里那些更早传进来的、或将来改了压缩策略之后的。
 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024

export interface FetchImagesResult {
  /** `asset://<hash>` → 字节。取不到的**不在表里**，调用方据此跳过 */
  images: Map<string, LoadedImage>
  /** 没取到的引用与原因，供日志 */
  failures: { src: string, reason: string }[]
}

/**
 * 批量取回图片字节。
 *
 * `Promise.all` 但每个任务自己吞异常 —— 它只用来等齐，不用来传播失败。
 * 一张图取不到就少一张，绝不能让整轮对话失败。
 */
export const fetchImages = async (
  refs: string[],
  resolveUrl: (src: string) => string,
): Promise<FetchImagesResult> => {
  const images = new Map<string, LoadedImage>()
  const failures: { src: string, reason: string }[] = []

  await Promise.all([...new Set(refs)].map(async src => {
    const url = resolveUrl(src)
    if (!url) {
      failures.push({ src, reason: '引用解析不出地址' })
      return
    }

    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      const bytes = new Uint8Array(await res.arrayBuffer())
      if (!bytes.length) throw new Error('取到 0 字节')
      if (bytes.byteLength > MAX_IMAGE_BYTES) {
        throw new Error(`超过 ${MAX_IMAGE_BYTES / 1024 / 1024}MB 上限`)
      }

      // Content-Type 是桶上传时写进去的，可信；缺了就交给 SDK 自己嗅
      const mimeType = res.headers.get('content-type') || undefined
      images.set(src, { bytes, mimeType })
    }
    catch (err) {
      failures.push({ src, reason: err instanceof Error ? err.message : String(err) })
    }
  }))

  return { images, failures }
}

/** 从库里的一批 blocksJson 里挑出所有 `asset://` 图片引用 */
export const collectImageRefs = (blocksJsonList: (string | null | undefined)[]): string[] => {
  const refs: string[] = []

  for (const json of blocksJsonList) {
    if (!json) continue
    try {
      const blocks = JSON.parse(json)
      if (!Array.isArray(blocks)) continue
      for (const b of blocks) {
        if (b?.type === 'image' && typeof b.src === 'string') refs.push(b.src)
      }
    }
    catch {
      // 脏数据在 turnMemory 那边也会被跳过，这里静默忽略即可
    }
  }

  return refs
}
