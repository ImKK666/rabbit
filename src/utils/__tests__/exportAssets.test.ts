import { describe, it, expect, beforeEach } from 'vitest'
import type { Slide } from '@/types/slides'
import { collectImageRefs, fetchImageBundle, dataUrlExtension } from '../exportAssets'
import { setAssetBaseUrl } from '../assetUrl'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

beforeEach(() => {
  setAssetBaseUrl('https://bucket.example.com/rabbit')
})

/** 只填测试要用到的字段 —— PPTElement 的完整形状与本文件无关 */
const slide = (partial: Partial<Slide>): Slide => ({
  id: 's1',
  elements: [],
  ...partial,
} as Slide)

describe('collectImageRefs', () => {
  it('收集背景图与图片元素', () => {
    const refs = collectImageRefs([
      slide({
        background: { type: 'image', image: { src: `asset://${HASH_A}`, size: 'cover' } },
        elements: [{ type: 'image', src: `asset://${HASH_B}` }],
      } as Partial<Slide>),
    ])
    expect(refs).toEqual([`asset://${HASH_A}`, `asset://${HASH_B}`])
  })

  it('同一张图跨页复用只收一次', () => {
    const bg = { type: 'image', image: { src: `asset://${HASH_A}`, size: 'cover' } }
    const refs = collectImageRefs([
      slide({ background: bg } as Partial<Slide>),
      slide({ background: bg } as Partial<Slide>),
    ])
    expect(refs).toHaveLength(1)
  })

  it('跳过 data URL 与 svg —— 前者已是 data URL，后者路径自带扩展名', () => {
    const refs = collectImageRefs([
      slide({
        elements: [
          { type: 'image', src: 'data:image/png;base64,AAAA' },
          { type: 'image', src: 'https://example.com/icon.svg' },
          { type: 'image', src: 'https://example.com/photo' },
        ],
      } as Partial<Slide>),
    ])
    expect(refs).toEqual(['https://example.com/photo'])
  })

  it('收集形状的图案填充', () => {
    const refs = collectImageRefs([
      slide({ elements: [{ type: 'shape', pattern: `asset://${HASH_A}` }] } as Partial<Slide>),
    ])
    expect(refs).toEqual([`asset://${HASH_A}`])
  })

  it('背景不是图片时不收', () => {
    const refs = collectImageRefs([
      slide({ background: { type: 'solid', color: '#fff' } } as Partial<Slide>),
    ])
    expect(refs).toEqual([])
  })
})

describe('fetchImageBundle', () => {
  const JPEG_DATA_URL = 'data:image/jpeg;base64,/9j/4AAQ'

  it('把 asset:// 解析成真实地址后取回，产出 data URL', async () => {
    const seen: string[] = []
    const bundle = await fetchImageBundle([`asset://${HASH_A}`], url => {
      seen.push(url)
      return Promise.resolve(JPEG_DATA_URL)
    })

    expect(seen).toEqual([`https://bucket.example.com/rabbit/${HASH_A}`])
    expect(bundle.dataUrls.get(`asset://${HASH_A}`)).toBe(JPEG_DATA_URL)
    expect(bundle.failures).toEqual([])
  })

  // 这是修复的核心：pptxgenjs 内部的 Promise.all 会让一张图的失败
  // 拖垮整份导出，我们必须做到「坏一张只少一张」
  it('单张失败不牵连其余', async () => {
    const bundle = await fetchImageBundle(
      [`asset://${HASH_A}`, `asset://${HASH_B}`],
      url => {
        if (url.includes(HASH_A)) return Promise.reject(new Error('HTTP 403'))
        return Promise.resolve(JPEG_DATA_URL)
      },
    )

    expect(bundle.dataUrls.has(`asset://${HASH_B}`)).toBe(true)
    expect(bundle.failures).toEqual([{ src: `asset://${HASH_A}`, reason: 'HTTP 403' }])
  })

  it('pending 与坏引用不发请求，且原因分得开', async () => {
    let calls = 0
    const bundle = await fetchImageBundle(
      ['asset://pending/task1', 'asset://not-a-hash'],
      () => {
        calls++
        return Promise.resolve(JPEG_DATA_URL)
      },
    )

    expect(calls).toBe(0)
    expect(bundle.failures).toEqual([
      { src: 'asset://pending/task1', reason: '图片还在生成中' },
      { src: 'asset://not-a-hash', reason: '图片引用无效' },
    ])
  })
})

describe('dataUrlExtension', () => {
  it('从 MIME 取扩展名', () => {
    expect(dataUrlExtension('data:image/png;base64,AAAA')).toBe('png')
    expect(dataUrlExtension('data:image/webp;base64,AAAA')).toBe('webp')
  })

  // pptxgenjs 自己也把 jpg 归一到 jpeg，否则 PowerPoint 启动时报内容警告
  it('jpg 归一到 jpeg', () => {
    expect(dataUrlExtension('data:image/jpg;base64,AAAA')).toBe('jpeg')
  })

  it('svg+xml 归一到 svg', () => {
    expect(dataUrlExtension('data:image/svg+xml;base64,AAAA')).toBe('svg')
  })

  it('认不出时退回 png', () => {
    expect(dataUrlExtension('data:application/octet-stream;base64,AAAA')).toBe('png')
  })
})
