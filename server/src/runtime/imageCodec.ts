/**
 * 图片转码与压缩 —— 域无关
 *
 * 只知道「给我一段图片字节，我给你一段更小的图片字节」，不知道 deck、不知道 COS。
 *
 * ## 先量再定：真正的收益不在缩放，在重编码
 *
 * 动手前实测过（2026-08-19，真打生图 API + 真下 Pixabay 图）：
 *
 * | | 实测 | 对 `maxEdgePx=1600` |
 * |---|---|---|
 * | 生图 `gemini-3.1-flash-image` | **1408×768 PNG，1.5~2.0 MB**，14~15 秒 | 长边 1408 **不触发缩放** |
 * | 搜图 Pixabay `largeImageURL` | 1280 长边 JPEG，165~279 KB | 也不触发 |
 *
 * 也就是说，配置里那个 `max_edge_px` 在默认值下**一次都不会生效** ——
 * 省下来的字节全部来自 **PNG → JPEG 重编码**：2000 KB → 333 KB，**6 倍**。
 * 缩放仍然实现了（配置可以调到 1280 以下），但它不是主角，
 * 别把它当成「压缩做完了」的证据。
 *
 * ## 为什么是 JPEG，不是 WebP
 *
 * WebP 体积更好，但 **PPTX 对它支持很差** —— 一份导出到 PowerPoint 打不开图的
 * 演示文稿，比大几百 KB 糟糕得多。这个项目的产物终点是 PPTX，所以只出 JPEG / PNG。
 *
 * ## 为什么是纯 JS 编解码，不是 sharp / mozjpeg-wasm
 *
 * 三个候选都在 bun 里实测跑通过，数字：
 *
 * | | q=82 输出 | 编码耗时 |
 * |---|---|---|
 * | `upng-js` + `jpeg-js`（纯 JS，本文件选的） | 332.9 KB | 78 ms |
 * | `@jsquash`（mozjpeg wasm） | 254.5 KB | 366 ms |
 * | `sharp`（原生） | 未测 —— 要原生编译，跨平台部署代价明显 |
 *
 * mozjpeg 小 24%，但要引入一条 wasm 加载路径（打包器 / 部署环境各有各的脾气）。
 * **6 倍已经解决了问题**，再省 78 KB 不值得为它多一个会在别人机器上炸的环节。
 * 相对 14 秒的生图，78 ms 和 366 ms 都是噪声，所以速度不是选它的理由。
 *
 * ## 透明通道是个会咬人的坑
 *
 * **JPEG 没有 alpha。** 一张透明背景的 PNG 直接转 JPEG，透明区域会变成黑色 ——
 * 而且不报任何错，只是图变丑了。所以解码后要**逐像素查 alpha**，
 * 真有透明就保留 PNG 原样，宁可大也不能把图毁了。
 * 生图现在给的是不透明照片，但 agent 完全可能要一张「透明背景的图标」。
 */

import jpeg from 'jpeg-js'
import UPNG from 'upng-js'
// 复用而不是再抄一份：缩放公式抄两份就是 R-16 治过的「三处各抄一份」老毛病。
// 方向看着别扭（编解码依赖搜图），但那边只是个 5 行纯函数，没有环
import { scaleToMaxEdge } from './imageSearch'

/**
 * JPEG 质量。82 是实测选的：
 * q=70 → 246 KB（能看出压缩痕迹）· **q=82 → 333 KB** · q=90 → 463 KB。
 * 82 往上收益迅速变差（+8 质量点要多 39% 体积），往下开始伤画质。
 */
export const JPEG_QUALITY = 82

export type ImageFormat = 'png' | 'jpeg'

/**
 * 认字节头，不认扩展名也不认 Content-Type。
 *
 * 图库和生图 API 报的 MIME 都可能与实际字节不符（实测 Pixabay 的 `.jpg`
 * 链接确实是 JPEG，但这条不该靠对方守规矩），而**裁剪与转码用错解码器
 * 的表现是一段乱码或一次抛错**，都比在这里多读 8 个字节贵。
 */
export const sniffFormat = (bytes: Uint8Array): ImageFormat | null => {
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  return null
}

/** RGBA 里有没有真正的透明像素。全 255 的 RGBA 转 JPEG 是安全的 */
export const hasTransparency = (rgba: Uint8Array): boolean => {
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 255) return true
  }
  return false
}

/**
 * 面积平均缩小。
 *
 * **只缩不放**：目标比源大时原样返回。把图放大到填满版面是排版层的事
 * （CSS / PPTX 都会自己拉伸），在这里放大只是凭空造字节。
 *
 * 用面积平均而不是双线性：双线性只采 4 个邻居，缩小倍数一大就会漏采样，
 * 表现是锯齿和摩尔纹。面积平均把目标像素覆盖到的那一整块源像素取均值，
 * 缩多少倍都不会漏。代价是慢一点 —— 相对 14 秒的生图完全不值一提。
 */
export const resizeRgba = (
  src: Uint8Array, sw: number, sh: number, dw: number, dh: number,
): Uint8Array => {
  if (dw >= sw && dh >= sh) return src

  const out = new Uint8Array(dw * dh * 4)
  const xScale = sw / dw
  const yScale = sh / dh

  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * yScale)
    // 至少覆盖一行 —— 缩放比接近 1 时 floor 可能让上下界相等，那样就一个像素都不采
    const y1 = Math.max(y0 + 1, Math.min(sh, Math.ceil((y + 1) * yScale)))

    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * xScale)
      const x1 = Math.max(x0 + 1, Math.min(sw, Math.ceil((x + 1) * xScale)))

      let r = 0, g = 0, b = 0, a = 0, n = 0
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * sw + sx) * 4
          r += src[i]; g += src[i + 1]; b += src[i + 2]; a += src[i + 3]
          n++
        }
      }
      const o = (y * dw + x) * 4
      out[o] = Math.round(r / n)
      out[o + 1] = Math.round(g / n)
      out[o + 2] = Math.round(b / n)
      out[o + 3] = Math.round(a / n)
    }
  }
  return out
}

export interface DecodedImage {
  width: number
  height: number
  /** 逐像素 RGBA */
  rgba: Uint8Array
}

/** 解码成 RGBA。认不出格式或字节坏了都抛 —— 见 `compressImage` 的说明 */
export const decodeImage = (bytes: Uint8Array): DecodedImage => {
  const format = sniffFormat(bytes)
  if (!format) throw new Error('无法识别的图片格式（只支持 PNG / JPEG）')

  // 两个库都要 ArrayBuffer / Buffer，而 `bytes` 可能是某个更大 buffer 的视图
  // （`new Uint8Array(await res.arrayBuffer())` 不是，但下游谁都可能切片），
  // 所以按 byteOffset/byteLength 精确切出来，别直接用 `.buffer`
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer

  if (format === 'png') {
    const png = UPNG.decode(ab)

    // **upng-js 解不了调色板 PNG。** 实测：它自己 encode 出来的 ctype=3 图，
    // 再 decode → toRGBA8 就抛 `undefined is not an object (evaluating 'data[i]')`
    // —— PLTE 明明在 tabs 里，是 toRGBA8 那条分支本身坏的。
    //
    // 在这里先拦一道，是为了**换一条看得懂的错误信息**：上面那句原始报错
    // 会让排查的人以为是字节损坏或网络截断，而真正的原因是「这张图是索引色的」。
    //
    // 不自己补展开逻辑（给第三方库打补丁要长期维护），也不换库，因为两条主路径都不碰它：
    // 生图实测是 ctype=2（RGB），搜图 Pixabay 给的是 JPEG（走 jpeg-js）。
    // 代价只是偶尔跳过一张索引色的候选图 —— 工具会接着试下一张。
    if (png.ctype === 3) {
      throw new Error('暂不支持索引色（调色板）PNG —— upng-js 的 toRGBA8 在这条分支上是坏的')
    }

    return { width: png.width, height: png.height, rgba: new Uint8Array(UPNG.toRGBA8(png)[0]) }
  }

  const img = jpeg.decode(bytes, { useTArray: true })
  return { width: img.width, height: img.height, rgba: new Uint8Array(img.data) }
}

/** 为什么得到这个结果 —— 落进 assets 表和日志，排查「图怎么还是这么大」时用 */
export type CompressReason =
  /** 转成了 JPEG（主路径） */
  | 'recoded'
  /** 先缩后转 */
  | 'resized-and-recoded'
  /** 有透明像素，保留 PNG */
  | 'kept-transparent'
  /** 本来就是 JPEG 且不超尺寸，原样放过 —— 再编一次只会二次损失画质 */
  | 'kept-as-is'

export interface CompressResult {
  bytes: Uint8Array
  /** 传对象存储时用；也决定 `Content-Type` */
  ext: 'jpg' | 'png'
  contentType: string
  width: number
  height: number
  originalBytes: number
  reason: CompressReason
}

export interface CompressOptions {
  /** 长边上限。来自 `asset_sources.max_edge_px` */
  maxEdgePx: number
  quality?: number
}

/**
 * 压缩一张图。
 *
 * **认不出 / 解不开时抛异常**，不返回一个「降级成功」的结果。
 * 这和 `searchImages` 那条「不抛，返回 ok:false」故意相反 —— 两者的失败含义不同：
 * 搜图失败是「这次没搜到，换个词再来」，而一张解不开的图**连宽高都拿不到**，
 * 而宽高正是版式算 cover / contain 必需的。硬凑一个结果出去，
 * 换来的是版面按错误尺寸排完之后才发现图是坏的。
 * 调用方（工具层）catch 住换下一张候选即可。
 */
export const compressImage = (
  input: Uint8Array,
  { maxEdgePx, quality = JPEG_QUALITY }: CompressOptions,
): CompressResult => {
  const format = sniffFormat(input)
  const { width: sw, height: sh, rgba } = decodeImage(input)
  const target = scaleToMaxEdge(sw, sh, maxEdgePx)
  const needsResize = target.width !== sw || target.height !== sh

  // 透明图不能转 JPEG（透明会变黑）。缩放同样会走 JPEG 编码，所以一并放弃 ——
  // 保留原 PNG 比「小了但花了」强
  if (hasTransparency(rgba)) {
    return {
      bytes: input, ext: 'png', contentType: 'image/png',
      width: sw, height: sh, originalBytes: input.byteLength, reason: 'kept-transparent',
    }
  }

  if (format === 'jpeg' && !needsResize) {
    return {
      bytes: input, ext: 'jpg', contentType: 'image/jpeg',
      width: sw, height: sh, originalBytes: input.byteLength, reason: 'kept-as-is',
    }
  }

  const pixels = needsResize
    ? resizeRgba(rgba, sw, sh, target.width, target.height)
    : rgba

  const encoded = jpeg.encode({ data: pixels, width: target.width, height: target.height }, quality)

  return {
    bytes: new Uint8Array(encoded.data),
    ext: 'jpg',
    contentType: 'image/jpeg',
    width: target.width,
    height: target.height,
    originalBytes: input.byteLength,
    reason: needsResize ? 'resized-and-recoded' : 'recoded',
  }
}
