/**
 * R-67 · 导出前的图片预取
 *
 * ## 为什么不能把 URL 直接交给 pptxgenjs
 *
 * pptxgenjs 判断图片类型时**只切 path 字符串，从不看 `Content-Type` 响应头**。
 * 而 `asset://<sha256>` 解析出来的地址按决策 E 是**没有扩展名**的
 * （`runtime/assetConfig.ts` 的对象 key 只有 hash，MIME 由 HTTP 头给）。
 * 两者一撞，出两种不同的坏：
 *
 *   - `addImage({ path })` 取末段 `.` 后缀（pptxgen.es.js:2021）。末段是无点的
 *     sha256，`split('.').pop()` 原样返回整串 —— 于是产物里出现
 *     `<Default Extension="<64位hash>" ContentType="image/<64位hash>"/>`。
 *     包still合法，只是那张图打不开：**画布上好好的，导出后没了**。
 *
 *   - `slide.background = { path }` 更糟：它对**整个 URL** `split('.').pop()`
 *     （pptxgen.es.js:2728），被域名里的点切中，扩展名变成 `com/rabbit/<hash>`；
 *     而背景图的 rel.type 恰好等于 `'image'`，被写 [Content_Types].xml 的那个
 *     `rel.type !== 'image'` 判断（pptxgen.es.js:6315）整个跳过 ——
 *     这些 part 于是**一条内容类型声明都没有**，直接违反 OPC「每个 part 必须有
 *     内容类型」的强制约束。PowerPoint 对此不是丢图，是判**整个文件损坏**。
 *
 * 后一种是 R-57 底图上线后才踩到的：在那之前 deck 里没有背景图，
 * 只有零星几个图元，所以事故形态一直是「悄悄少一张图」，没人往包结构上想。
 *
 * ## 解法
 *
 * 导出前把字节自己取回来转成 `data:image/jpeg;base64,…`。pptxgenjs 对 data URL
 * 是**读 MIME 的**（`/image\/(\w+);/`，pptxgen.es.js:2028），类型就对了。
 * 代价是导出前多一轮网络往返 —— 但这轮往返本来也躲不掉，pptxgenjs 自己
 * 也要 XHR 取一遍，只是取完仍然按路径瞎猜类型。
 *
 * ## 顺带修掉的第二个坑
 *
 * pptxgenjs 内部用 `Promise.all` 取图（pptxgen.es.js:6844），**任何一张取不回来
 * 都会让整份导出连锁失败**。这里改成各自兜住异常，单张失败只记账、不牵连其余，
 * 调用方拿 `failures` 汇总告诉用户哪几张丢了。
 *
 * ## 纪律
 *
 * 解析结果只在这一次导出里用，**绝不写回 deck**（见 `assetUrl.ts` 的用法纪律）。
 */

import type { Slide } from '@/types/slides'
import { resolveAssetUrl, isPendingAsset } from './assetUrl'

/** 取不回来的一张图。`src` 是 deck 里的原串，便于对照排查 */
export interface FailedImage {
  src: string
  reason: string
}

/** 一次导出的图片账本：拿到的 + 没拿到的 */
export interface ImageBundle {
  /** deck 原串 → data URL */
  dataUrls: Map<string, string>
  failures: FailedImage[]
}

/**
 * 收集 deck 里所有需要预取的图片引用（去重）。
 *
 * 两类不收：
 *   - `data:` 开头的，本来就是 data URL，pptxgenjs 直接能读 MIME；
 *   - `.svg` 结尾的，路径自带扩展名，不受本文件描述的 bug 影响，
 *     而且 pptxgenjs 对 SVG 另有一条 svg→png 预览分支，别去动它。
 *
 * 内容寻址让去重是白送的：同一张图在多页复用时 `asset://` 原串完全相同。
 */
export const collectImageRefs = (slides: Slide[]): string[] => {
  const refs = new Set<string>()

  const take = (src: string | undefined) => {
    if (!src) return
    if (src.startsWith('data:')) return
    if (/\.svg$/i.test(src)) return
    refs.add(src)
  }

  for (const slide of slides) {
    if (slide.background?.type === 'image') take(slide.background.image?.src)

    for (const el of slide.elements || []) {
      if (el.type === 'image') take(el.src)
      else if (el.type === 'shape' && el.pattern) take(el.pattern)
    }
  }

  return [...refs]
}

/**
 * 单张图：地址 → data URL。
 *
 * 缝在这里而不是在 `fetch` 上，是因为「取字节」和「转 data URL」对调用方是
 * 同一件事，拆开只会逼单测去伪造 Blob / FileReader 这些浏览器 API。
 */
export type ImageLoader = (url: string) => Promise<string>

const defaultLoader: ImageLoader = async (url: string) => {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const blob = await res.blob()

  // 用 FileReader 而不是自己 btoa：几 MB 的图走原生实现，
  // 手搓 base64 要先拼一个等长的二进制字符串，白白多一份内存
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('图片字节读取失败'))
    reader.readAsDataURL(blob)
  })
}

/**
 * 批量取回图片字节。
 *
 * 这里的 `Promise.all` 和上面批评的那个不是一回事：每个任务**自己吞掉异常**，
 * 所以这个 all 永远不会 reject —— 它只用来等齐，不用来传播失败。
 */
export const fetchImageBundle = async (
  refs: string[],
  load: ImageLoader = defaultLoader,
): Promise<ImageBundle> => {
  const dataUrls = new Map<string, string>()
  const failures: FailedImage[] = []

  await Promise.all(refs.map(async src => {
    const url = resolveAssetUrl(src)
    if (!url) {
      // pending 和坏引用要分开说 —— 前者是「等一会儿再导」，后者是「这张没了」
      failures.push({ src, reason: isPendingAsset(src) ? '图片还在生成中' : '图片引用无效' })
      return
    }

    try {
      dataUrls.set(src, await load(url))
    }
    catch (err) {
      failures.push({ src, reason: err instanceof Error ? err.message : String(err) })
    }
  }))

  return { dataUrls, failures }
}

/**
 * data URL → pptxgenjs 认的扩展名。
 *
 * **背景图必须显式带上。** `addBackgroundDefinition` 只从 path 推扩展名，
 * 不看 data 的 MIME（只有普通图元走的 `addImageDefinition` 才看）。
 * 不给的话它默认 `preencoded.png`，一张 JPEG 会被声明成 image/png ——
 * 文件能开，但 PowerPoint 启动时报一条内容警告。
 *
 * `jpg` 归一到 `jpeg`：pptxgenjs 自己也这么做（pptxgen.es.js:2729），
 * 理由是 base64 的 JPEG 头本来就是 `image/jpeg`。
 */
export const dataUrlExtension = (dataUrl: string): string => {
  const mime = /^data:image\/([\w.+-]+)\s*[;,]/.exec(dataUrl)?.[1]?.toLowerCase()
  if (!mime) return 'png'
  if (mime === 'jpg') return 'jpeg'
  if (mime === 'svg+xml') return 'svg'
  return mime
}
