import { describe, it, expect } from 'vitest'
import jpeg from 'jpeg-js'
import UPNG from 'upng-js'
import {
  sniffFormat, hasTransparency, alphaStats, resizeRgba, decodeImage, compressImage, JPEG_QUALITY,
} from '../imageCodec'

// ---------------------------------------------------------------------------
// 素材：现造，不放二进制 fixture
//
// 真实素材（2 MB 的生图 PNG）太大不适合进仓库，而且**判据不需要它** ——
// 这里测的是「格式判定 / 透明保护 / 缩放算术 / 分支选择」，
// 它们对一张 4×4 的图和对一张 1408×768 的图是同一套逻辑。
// 真图上的验证走端到端实测（见 docs/04 第十八轮），两者各管一段。
// ---------------------------------------------------------------------------

/** 造一块渐变 RGBA，alpha 全 255 */
const opaqueRgba = (w: number, h: number): Uint8Array => {
  const rgba = new Uint8Array(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = (i * 7) % 256
    rgba[i * 4 + 1] = (i * 13) % 256
    rgba[i * 4 + 2] = (i * 29) % 256
    rgba[i * 4 + 3] = 255
  }
  return rgba
}

/**
 * `forbidPlte = true` 不是可有可无的 —— 不传的话 upng-js 会对颜色少的图
 * 选调色板编码（ctype=3），而**它自己解不回来**。
 * 真生图实测是 ctype=2，所以这里也要造 ctype=2 的图才算测到真实形状。
 */
const toPng = (rgba: Uint8Array, w: number, h: number, palette = false): Uint8Array =>
  new Uint8Array(UPNG.encode(
    [rgba.buffer.slice(rgba.byteOffset, rgba.byteOffset + rgba.byteLength) as ArrayBuffer],
    w, h, 0, undefined, !palette,
  ))

const toJpeg = (rgba: Uint8Array, w: number, h: number, q = 90): Uint8Array =>
  new Uint8Array(jpeg.encode({ data: rgba, width: w, height: h }, q).data)

describe('sniffFormat · 认字节头不认扩展名', () => {
  it('认得 PNG 魔数', () => {
    expect(sniffFormat(toPng(opaqueRgba(2, 2), 2, 2))).toBe('png')
  })

  it('认得 JPEG 魔数', () => {
    expect(sniffFormat(toJpeg(opaqueRgba(8, 8), 8, 8))).toBe('jpeg')
  })

  it('认不出的返回 null，不猜', () => {
    expect(sniffFormat(new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toBeNull() // GIF
    expect(sniffFormat(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBeNull() // WebP
  })

  it('字节太短不越界读', () => {
    expect(sniffFormat(new Uint8Array([]))).toBeNull()
    expect(sniffFormat(new Uint8Array([0x89]))).toBeNull()
    expect(sniffFormat(new Uint8Array([0xff, 0xd8]))).toBeNull()
  })
})

describe('hasTransparency', () => {
  it('alpha 全 255 → false', () => {
    expect(hasTransparency(opaqueRgba(4, 4))).toBe(false)
  })

  it('只要有一个像素不是 255 → true', () => {
    const rgba = opaqueRgba(4, 4)
    rgba[4 * 4 * 4 - 1] = 254 // 最后一个像素的 alpha
    expect(hasTransparency(rgba)).toBe(true)
  })

  it('全透明 → true', () => {
    const rgba = opaqueRgba(2, 2)
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = 0
    expect(hasTransparency(rgba)).toBe(true)
  })
})

describe('alphaStats · 「生成一张」测透明通道的判据', () => {
  it('全实底：ratio 0、fullyOpaque —— 模型没回透明通道', () => {
    expect(alphaStats(opaqueRgba(4, 4))).toEqual({ transparentRatio: 0, fullyOpaque: true, empty: false })
  })

  it('一半透明（含半透明边缘）：ratio 0.5、不判实底', () => {
    const rgba = opaqueRgba(2, 2)
    for (let i = 3; i < rgba.length; i += 8) rgba[i] = 128
    const stats = alphaStats(rgba)
    expect(stats.transparentRatio).toBeCloseTo(0.5)
    expect(stats.fullyOpaque).toBe(false)
    expect(stats.empty).toBe(false)
  })

  it('全透明：ratio 1、empty —— 图上什么都没有', () => {
    const rgba = opaqueRgba(2, 2)
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = 0
    expect(alphaStats(rgba)).toEqual({ transparentRatio: 1, fullyOpaque: false, empty: true })
  })

  it('**负对照**：空数组按「空图」处理，不除零', () => {
    expect(alphaStats(new Uint8Array(0))).toEqual({ transparentRatio: 1, fullyOpaque: false, empty: true })
  })
})

describe('resizeRgba · 面积平均', () => {
  it('2×2 缩到 1×1 就是四个像素的精确均值', () => {
    // 期望值手算，不从实现反推：(0+100+200+255)/4 = 138.75 → 四舍五入 139
    const src = new Uint8Array([
      0, 0, 0, 255, 100, 100, 100, 255,
      200, 200, 200, 255, 255, 255, 255, 255,
    ])
    const out = resizeRgba(src, 2, 2, 1, 1)
    expect(out.length).toBe(4)
    expect(out[0]).toBe(139)
    expect(out[3]).toBe(255)
  })

  it('4×4 缩到 2×2：每个目标像素取对应 2×2 块的均值', () => {
    const src = new Uint8Array(4 * 4 * 4)
    // 左上 2×2 全 0，其余全 200
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        const v = (x < 2 && y < 2) ? 0 : 200
        const i = (y * 4 + x) * 4
        src[i] = src[i + 1] = src[i + 2] = v
        src[i + 3] = 255
      }
    }
    const out = resizeRgba(src, 4, 4, 2, 2)
    expect(out[0]).toBe(0) // 左上块
    expect(out[4]).toBe(200) // 右上块
    expect(out[8]).toBe(200) // 左下块
  })

  it('输出尺寸就是要求的尺寸', () => {
    const out = resizeRgba(opaqueRgba(100, 60), 100, 60, 50, 30)
    expect(out.length).toBe(50 * 30 * 4)
  })

  it('只缩不放 —— 目标不小于源时原样返回', () => {
    const src = opaqueRgba(4, 4)
    expect(resizeRgba(src, 4, 4, 8, 8)).toBe(src)
    expect(resizeRgba(src, 4, 4, 4, 4)).toBe(src)
  })

  it('缩放比接近 1 也不会有采样不到的目标像素', () => {
    // ceil/floor 撞到一起时若不兜底，会出现 n=0 → 除零 → NaN → 写进 Uint8Array 变 0
    const out = resizeRgba(opaqueRgba(101, 101), 101, 101, 100, 100)
    expect(out.length).toBe(100 * 100 * 4)
    expect([...out].every(v => Number.isFinite(v))).toBe(true)
    expect(out[3]).toBe(255) // alpha 没被算成 NaN→0
  })
})

describe('decodeImage', () => {
  it('PNG 往返：宽高与像素都对得上', () => {
    const rgba = opaqueRgba(8, 6)
    const got = decodeImage(toPng(rgba, 8, 6))
    expect(got.width).toBe(8)
    expect(got.height).toBe(6)
    expect(got.rgba.length).toBe(8 * 6 * 4)
    expect([...got.rgba]).toEqual([...rgba]) // PNG 无损，必须逐字节相等
  })

  it('JPEG 往返：宽高对得上（有损，像素不做逐一比对）', () => {
    const got = decodeImage(toJpeg(opaqueRgba(16, 8), 16, 8))
    expect(got.width).toBe(16)
    expect(got.height).toBe(8)
    expect(got.rgba.length).toBe(16 * 8 * 4)
  })

  it('认不出格式就抛，不返回一个空壳', () => {
    expect(() => decodeImage(new Uint8Array([1, 2, 3, 4]))).toThrow(/无法识别/)
  })
})

describe('compressImage · 分支选择', () => {
  const OPTS = { maxEdgePx: 1600 }

  it('不透明 PNG → 重编码成 JPEG', () => {
    const rgba = opaqueRgba(400, 300)
    const png = toPng(rgba, 400, 300)
    const out = compressImage(png, OPTS)

    expect(out.reason).toBe('recoded')
    expect(out.ext).toBe('jpg')
    expect(out.contentType).toBe('image/jpeg')
    expect(out.width).toBe(400)
    expect(out.height).toBe(300)
    expect(out.originalBytes).toBe(png.byteLength)
    expect(sniffFormat(out.bytes)).toBe('jpeg')
  })

  it('**这里刻意不断言「JPEG 比 PNG 小」** —— 那是内容属性，不是代码属性', () => {
    // 第一版真写了 `toBeLessThan(png.byteLength)`，跑出来红了：
    // 合成的渐变图 PNG 只有 1.3 KB（规律性太强，PNG 压得极好），JPEG 反而 158 KB。
    // 结论不是「压缩坏了」，是**这条断言测的根本不是它名字说的那件事** ——
    // 压缩比取决于图像内容，拿合成素材断言它只能得到一个随素材变的数字。
    //
    // 真实的压缩比在真图上量：实测生图 2000 KB PNG → 333 KB JPEG（6 倍），
    // 见 imageCodec.ts 头注释与 docs/04 第十八轮。这里只钉「分支选对了」。
    const gradient = toPng(opaqueRgba(200, 200), 200, 200)
    expect(compressImage(gradient, OPTS).reason).toBe('recoded')
  })

  it('索引色 PNG 抛的是一条说得清的错，不是 upng 那句天书', () => {
    // upng-js 原始报错是 `undefined is not an object (evaluating 'data[i]')`，
    // 会让排查的人以为字节坏了。这条测试同时钉住「这个缺口是已知的」——
    // 哪天换了库或补了实现，它会提醒有个决定要重新做
    const palettePng = toPng(opaqueRgba(8, 6), 8, 6, true)
    expect(() => compressImage(palettePng, OPTS)).toThrow(/索引色/)
  })

  it('透明 PNG → 原样保留，绝不转 JPEG', () => {
    // JPEG 没有 alpha，转过去透明区域会变黑，而且不报任何错
    const rgba = opaqueRgba(32, 32)
    rgba[3] = 0
    const png = toPng(rgba, 32, 32)
    const out = compressImage(png, OPTS)

    expect(out.reason).toBe('kept-transparent')
    expect(out.ext).toBe('png')
    expect(out.contentType).toBe('image/png')
    expect(out.bytes).toBe(png) // 原样，不是「又编码了一次的 PNG」
  })

  it('不超尺寸的 JPEG → 原样放过，不做二次有损编码', () => {
    const src = toJpeg(opaqueRgba(64, 48), 64, 48)
    const out = compressImage(src, OPTS)

    expect(out.reason).toBe('kept-as-is')
    expect(out.ext).toBe('jpg')
    expect(out.bytes).toBe(src)
    expect(out.width).toBe(64)
    expect(out.height).toBe(48)
  })

  it('超尺寸 → 先缩后转，长边正好等于上限且比例不变', () => {
    const png = toPng(opaqueRgba(400, 200), 400, 200)
    const out = compressImage(png, { maxEdgePx: 100 })

    expect(out.reason).toBe('resized-and-recoded')
    expect(out.width).toBe(100)
    expect(out.height).toBe(50) // 400:200 = 2:1 保持
    expect(out.ext).toBe('jpg')
    // 报的宽高必须是**真实**产物的宽高 —— 版式拿它算 cover/contain，
    // 报错了就会以为手里有张大图（第十七轮 Pixabay 那个真 bug 的同款形状）
    expect(decodeImage(out.bytes).width).toBe(100)
    expect(decodeImage(out.bytes).height).toBe(50)
  })

  it('超尺寸的 JPEG 也会被缩 —— kept-as-is 只对「不超尺寸」成立', () => {
    const src = toJpeg(opaqueRgba(400, 200), 400, 200)
    const out = compressImage(src, { maxEdgePx: 100 })
    expect(out.reason).toBe('resized-and-recoded')
    expect(out.width).toBe(100)
  })

  it('认不出的格式抛异常，不硬凑一个结果', () => {
    // 硬凑的代价是版面按错误尺寸排完之后才发现图是坏的
    expect(() => compressImage(new Uint8Array([0x47, 0x49, 0x46, 0x38]), OPTS)).toThrow()
  })

  it('quality 可覆盖，且更低的质量确实更小', () => {
    const png = toPng(opaqueRgba(200, 200), 200, 200)
    const lo = compressImage(png, { maxEdgePx: 1600, quality: 40 })
    const hi = compressImage(png, { maxEdgePx: 1600, quality: 95 })
    expect(lo.bytes.byteLength).toBeLessThan(hi.bytes.byteLength)
  })

  it('默认质量是 82', () => {
    expect(JPEG_QUALITY).toBe(82)
  })
})
