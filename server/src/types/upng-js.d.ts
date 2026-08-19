/**
 * `upng-js` 不带类型声明（`jpeg-js` 自带 `index.d.ts`，它没有）。
 *
 * 只声明我们真正用到的那三个函数，不求覆盖整个库 ——
 * 声明得越全，越容易写出一份**和实际行为对不上**的假类型，
 * 而那比没有类型更危险：编译过了，运行时才发现字段名是错的。
 *
 * （`encode` 只有测试在用：单测要现造 PNG 素材。）
 */
declare module 'upng-js' {
  interface UpngImage {
    width: number
    height: number
    depth: number
    /** PNG 色彩类型：0 灰度 · 2 RGB · 3 索引 · 4 灰度+A · 6 RGBA */
    ctype: number
    frames: unknown[]
    tabs: Record<string, unknown>
    data: Uint8Array
  }

  /** 解码。返回的 `data` 是原始色彩类型，要 RGBA 得再过一次 `toRGBA8` */
  export function decode(buffer: ArrayBuffer): UpngImage

  /** 展开成 RGBA8。返回逐帧的 ArrayBuffer（静态图取 `[0]`） */
  export function toRGBA8(img: UpngImage): ArrayBuffer[]

  /**
   * 编码。`ps=0` 为无损；帧数据是 RGBA8。只有单测在用。
   *
   * `forbidPlte` 必须传 true 才能拿到 ctype=2/6 的图 —— 默认它会对颜色少的图
   * 选调色板（ctype=3），而**本库自己解不回来**（见 imageCodec.ts 的说明）。
   */
  export function encode(
    imgs: ArrayBuffer[], width: number, height: number, ps: number,
    dels?: number[], forbidPlte?: boolean,
  ): ArrayBuffer

  const UPNG: {
    decode: typeof decode
    toRGBA8: typeof toRGBA8
    encode: typeof encode
  }
  export default UPNG
}
