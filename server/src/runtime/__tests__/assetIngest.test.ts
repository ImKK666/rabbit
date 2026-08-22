import { describe, it, expect } from 'vitest'
import UPNG from 'upng-js'
import { storeImageBytes } from '../assetIngest'
import type { ObjectStore, PutResult } from '../objectStore'

/**
 * 造 PNG。**`forbidPlte` 必须传**，理由和 `imageCodec.test.ts` 里那份一样：
 * 不传的话 upng-js 会对颜色少的图选调色板编码（ctype=3），而它自己解不回来，
 * `decodeImage` 也明确不收那一档。
 */
const toPng = (rgba: Uint8Array, w: number, h: number): Uint8Array =>
  new Uint8Array(UPNG.encode(
    [rgba.buffer.slice(rgba.byteOffset, rgba.byteOffset + rgba.byteLength) as ArrayBuffer],
    w, h, 0, undefined, true,
  ))

/** 不透明的渐变 PNG。不透明才会走 JPEG 分支 */
const solidPng = (w: number, h: number): Uint8Array => {
  const rgba = new Uint8Array(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = (i * 7) % 256
    rgba[i * 4 + 1] = (i * 13) % 256
    rgba[i * 4 + 2] = (i * 29) % 256
    rgba[i * 4 + 3] = 255
  }
  return toPng(rgba, w, h)
}

/** 半透明 PNG —— `compressImage` 会保留 PNG，不转 JPEG */
const transparentPng = (w: number, h: number): Uint8Array => {
  const rgba = new Uint8Array(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = (i * 7) % 256
    rgba[i * 4 + 1] = (i * 13) % 256
    rgba[i * 4 + 2] = (i * 29) % 256
    rgba[i * 4 + 3] = 128
  }
  return toPng(rgba, w, h)
}

interface Recorded {
  bytes: Uint8Array
  ext: string
  contentType: string
}

const fakeStore = (prefix = 'rabbit/') => {
  const calls: Recorded[] = []
  const store: ObjectStore = {
    put(bytes, ext, contentType): Promise<PutResult> {
      calls.push({ bytes, ext, contentType })
      const key = `${prefix}${'a'.repeat(64)}`
      return Promise.resolve({ key, url: `https://bucket.example.com/${key}`, existed: false, bytes: bytes.byteLength })
    },
    head: () => Promise.resolve(200),
    remove: () => Promise.resolve(204),
    urlFor: (key: string) => `https://bucket.example.com/${key}`,
  }
  return { store, calls }
}

describe('storeImageBytes', () => {
  // key 必须正好是 `{prefix}{hash}` —— 多一个 `.jpg` 就和 asset://<hash> 对不上，
  // 而症状只是「图取不到」，不会有任何报错
  it('ext 传空串，key 不带扩展名', async () => {
    const { store, calls } = fakeStore()
    await storeImageBytes(solidPng(8, 8), 1568, store)
    expect(calls).toHaveLength(1)
    expect(calls[0].ext).toBe('')
  })

  it('hash 取 key 的最后一段', async () => {
    const { store } = fakeStore('rabbit/')
    const out = await storeImageBytes(solidPng(8, 8), 1568, store)
    expect(out.hash).toBe('a'.repeat(64))
    expect(out.storageKey).toBe(`rabbit/${'a'.repeat(64)}`)
  })

  it('前缀为空时 hash 仍然取得对', async () => {
    const { store } = fakeStore('')
    const out = await storeImageBytes(solidPng(8, 8), 1568, store)
    expect(out.hash).toBe('a'.repeat(64))
  })

  it('超过长边上限的图会被缩小', async () => {
    const { store } = fakeStore()
    const out = await storeImageBytes(solidPng(100, 50), 20, store)
    expect(out.width).toBe(20)
    expect(out.height).toBe(10)
  })

  it('没超上限的图保持原尺寸', async () => {
    const { store } = fakeStore()
    const out = await storeImageBytes(solidPng(16, 8), 1568, store)
    expect(out.width).toBe(16)
    expect(out.height).toBe(8)
  })

  // 透明图转 JPEG 会变黑，所以 compressImage 保留 PNG —— contentType 必须跟着走，
  // 否则桶里那个对象的 Content-Type 是错的，而浏览器认的正是那个头
  it('透明图保留 PNG，contentType 一致传给 store', async () => {
    const { store, calls } = fakeStore()
    const out = await storeImageBytes(transparentPng(8, 8), 1568, store)
    expect(calls[0].contentType).toBe('image/png')
    expect(out.compressReason).toBe('kept-transparent')
  })

  it('返回亮度区间供版式算遮罩浓度', async () => {
    const { store } = fakeStore()
    const out = await storeImageBytes(solidPng(8, 8), 1568, store)
    expect(out.luminance).toHaveLength(2)
    expect(out.luminance[0]).toBeLessThanOrEqual(out.luminance[1])
  })

  it('认不出格式时抛，由调用方决定怎么说', async () => {
    const { store } = fakeStore()
    await expect(storeImageBytes(new Uint8Array([1, 2, 3, 4]), 1568, store)).rejects.toThrow()
  })
})
