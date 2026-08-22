/**
 * R-68 · 取图给模型
 *
 * 守两件事：**一张图取不到不能拖垮整轮对话**，以及
 * **取不到的必须不在表里**（在表里但字节是空的，等于把坏数据送给模型）。
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchImages, collectImageRefs } from '../imageFetch'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const BASE = 'https://bucket.example.com/rabbit'

const resolveUrl = (src: string) =>
  src.startsWith('asset://') ? `${BASE}/${src.slice(8)}` : ''

const okResponse = (bytes: Uint8Array, contentType = 'image/jpeg') => ({
  ok: true,
  status: 200,
  headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? contentType : null) },
  arrayBuffer: () => Promise.resolve(bytes.buffer),
})

afterEach(() => vi.unstubAllGlobals())

describe('fetchImages', () => {
  it('取回字节与 Content-Type', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(okResponse(new Uint8Array([1, 2, 3])))))

    const { images, failures } = await fetchImages([`asset://${HASH_A}`], resolveUrl)

    expect(failures).toEqual([])
    expect(images.get(`asset://${HASH_A}`)).toEqual({
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: 'image/jpeg',
    })
  })

  // 这条是核心：provider 那边一张图的失败绝不能变成整轮对话的失败
  it('一张失败不影响另一张', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) =>
      url.includes(HASH_A)
        ? Promise.reject(new Error('connect ETIMEDOUT'))
        : Promise.resolve(okResponse(new Uint8Array([9])))))

    const { images, failures } = await fetchImages(
      [`asset://${HASH_A}`, `asset://${HASH_B}`], resolveUrl)

    expect(images.has(`asset://${HASH_B}`)).toBe(true)
    expect(images.has(`asset://${HASH_A}`)).toBe(false)
    expect(failures).toEqual([{ src: `asset://${HASH_A}`, reason: 'connect ETIMEDOUT' }])
  })

  it('HTTP 错误码算失败，且带上状态码', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ...okResponse(new Uint8Array()), ok: false, status: 404 })))

    const { images, failures } = await fetchImages([`asset://${HASH_A}`], resolveUrl)

    expect(images.size).toBe(0)
    expect(failures[0].reason).toBe('HTTP 404')
  })

  // 空字节进了表就等于把坏数据送给模型 —— 必须算失败
  it('0 字节算失败，不进表', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(okResponse(new Uint8Array(0)))))

    const { images, failures } = await fetchImages([`asset://${HASH_A}`], resolveUrl)

    expect(images.size).toBe(0)
    expect(failures[0].reason).toBe('取到 0 字节')
  })

  it('解析不出地址的引用不发请求', async () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)

    const { failures } = await fetchImages(['asset://pending/t1'], () => '')

    expect(spy).not.toHaveBeenCalled()
    expect(failures[0].reason).toBe('引用解析不出地址')
  })

  // 内容寻址下同一张图跨轮复用是常态，重复下载是白花的钱和时间
  it('同一引用只取一次', async () => {
    const spy = vi.fn(() => Promise.resolve(okResponse(new Uint8Array([1]))))
    vi.stubGlobal('fetch', spy)

    await fetchImages([`asset://${HASH_A}`, `asset://${HASH_A}`, `asset://${HASH_A}`], resolveUrl)

    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('没有 Content-Type 时 mimeType 留空，交给 SDK 自己嗅', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(okResponse(new Uint8Array([1]), ''))))

    const { images } = await fetchImages([`asset://${HASH_A}`], resolveUrl)

    expect(images.get(`asset://${HASH_A}`)?.mimeType).toBeUndefined()
  })
})

describe('collectImageRefs', () => {
  const blocks = (...items: unknown[]) => JSON.stringify(items)

  it('从 blocksJson 里挑出图片引用', () => {
    const refs = collectImageRefs([
      blocks({ type: 'text', text: '看这个' }, { type: 'image', src: `asset://${HASH_A}` }),
    ])
    expect(refs).toEqual([`asset://${HASH_A}`])
  })

  it('跳过 null / 空 / 脏数据，不抛', () => {
    expect(() => collectImageRefs([null, undefined, '', '{不是 JSON', '"不是数组"'])).not.toThrow()
    expect(collectImageRefs([null, '{坏']).length).toBe(0)
  })

  it('assistant / tool 的 blocks 里没有图，不会误收', () => {
    const refs = collectImageRefs([
      blocks({ type: 'tool-call', toolCallId: 'c1', toolName: 'applyLayout', args: {} }),
      blocks({ type: 'reasoning', text: '想一下' }),
    ])
    expect(refs).toEqual([])
  })

  it('src 不是字符串的图片块被跳过', () => {
    const refs = collectImageRefs([blocks({ type: 'image', src: 123 })])
    expect(refs).toEqual([])
  })
})
