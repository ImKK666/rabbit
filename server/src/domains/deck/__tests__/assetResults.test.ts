import { describe, it, expect } from 'vitest'
import {
  ASSET_SRC_PATTERN, ASSET_TOOL_NAMES, toolAsset, rateLimitedResult, disabledResult,
  notConfiguredResult, noResultsResult, providerErrorResult, decodeFailedResult,
  uploadFailedResult, serializeAssetResult,
} from '../assetResults'

const HASH = 'a'.repeat(64)

describe('限流被拒时的返回 —— 这一条决定 agent 会不会自己改用搜图', () => {
  /**
   * 反面写法（抛异常）也能「正确地」表达失败，但模型的默认反应是重试同一个工具，
   * 而它一定会再被拒 —— 白烧两步预算。所以这一组断言的是**返回值的形状**，
   * 不是「有没有失败」。
   */
  const result = rateLimitedResult({ retryAfterSec: 37, limitPerMin: 3 })

  it('不抛异常', () => {
    expect(() => rateLimitedResult({ retryAfterSec: 1, limitPerMin: 1 })).not.toThrow()
  })

  it('reason 是稳定的机器码 rate_limited', () => {
    // 按机器码断言，不按提示语断言：提示语会被改，机器码是协议
    expect(result).toMatchObject({ ok: false, reason: 'rate_limited' })
  })

  it('带上 retryAfterSec，原样透传限流器给的数', () => {
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.retryAfterSec).toBe(37)
  })

  it('**提示语里点名 searchImage** —— 不点名等于没给退路', () => {
    if (result.ok) throw new Error('unreachable')
    expect(result.hint).toContain('searchImage')
  })

  it('提示语明确叫它不要重试 generateImage', () => {
    if (result.ok) throw new Error('unreachable')
    expect(result.hint).toContain('不要重试')
    expect(result.hint).toContain('generateImage')
  })

  it('提示语里有配额数和等待秒数，用户和模型都看得懂发生了什么', () => {
    if (result.ok) throw new Error('unreachable')
    expect(result.hint).toContain('3')
    expect(result.hint).toContain('37')
  })
})

describe('合规① · 图库 URL 一个字节都不许进 deck', () => {
  /**
   * Pixabay 文档明写不许长期热链，而 `webformatURL` 只有 24 小时有效期。
   * 我们下载后传自己的 COS，本来就合规 —— 但「本来就合规」不是判据。
   * 判据是：**工具交出去的 src 只可能是 `asset://<sha256>`**。
   */
  it('src 是 asset:// 加 64 位十六进制', () => {
    const asset = toolAsset({ hash: HASH, width: 1280, height: 853, ticket: 't1' })
    expect(asset.src).toBe(`asset://${HASH}`)
    expect(asset.src).toMatch(ASSET_SRC_PATTERN)
  })

  it('即使带着图库的 attribution URL，src 也绝不是那个 URL', () => {
    const asset = toolAsset({
      hash: HASH, width: 1280, height: 853, ticket: 't1',
      attribution: { author: 'Someone', source: 'Pixabay', url: 'https://pixabay.com/photos/x-123/' },
    })
    expect(asset.src).toMatch(ASSET_SRC_PATTERN)
    expect(asset.src).not.toContain('http')
    expect(asset.src).not.toContain('pixabay')
  })

  it.each([
    ['大写 hex', 'A'.repeat(64)],
    ['长度不对', 'a'.repeat(63)],
    ['带扩展名', `${'a'.repeat(64)}.jpg`],
    ['整个是 URL', 'https://pixabay.com/get/x.jpg'],
    ['空', ''],
  ])('hash 是「%s」时当场抛，不产出一个看着像 asset:// 的坏值', (_label, hash) => {
    expect(() => toolAsset({ hash, width: 1, height: 1, ticket: 't' })).toThrow(/不合法/)
  })

  it('ASSET_SRC_PATTERN 不接受 pending 形式 —— 这一轮没有异步票据', () => {
    expect(`asset://pending/t-1`).not.toMatch(ASSET_SRC_PATTERN)
  })
})

describe('合规② · 署名要真的被带出去', () => {
  const attribution = { author: 'RonaldCandonga', source: 'Pixabay', url: 'https://pixabay.com/photos/x/' }

  it('三个字段原样透传，一个都不丢', () => {
    const asset = toolAsset({ hash: HASH, width: 1280, height: 771, ticket: 't1', attribution })
    expect(asset.attribution).toEqual(attribution)
  })

  it('没有来源可署时不硬塞一个空对象', () => {
    // 生图没有作者可署。塞个空对象会让下游以为「有署名信息」然后渲染出一行空白
    const asset = toolAsset({ hash: HASH, width: 1024, height: 1024, ticket: 't2' })
    expect(asset).not.toHaveProperty('attribution')
  })
})

describe('尺寸原样透传 —— 报错了会让版式按错误尺寸排版', () => {
  it('width / height 就是传进来的那两个数', () => {
    // 第十七轮 Pixabay 那个真 bug：交 1280 的图、报 5760 的宽高，
    // 满屏背景直接糊掉且不报任何错。所以这两个数必须来自**实际产物**
    const asset = toolAsset({ hash: HASH, width: 1376, height: 768, ticket: 't1' })
    expect(asset.width).toBe(1376)
    expect(asset.height).toBe(768)
  })
})

describe('各类失败的机器码稳定', () => {
  it.each([
    ['disabled', disabledResult('search')],
    ['disabled', disabledResult('generate')],
    ['not_configured', notConfiguredResult('缺 SecretKey')],
    ['no_results', noResultsResult('协同增效')],
    ['provider_error', providerErrorResult('HTTP 500')],
    ['decode_failed', decodeFailedResult('无法识别的图片格式')],
    ['upload_failed', uploadFailedResult('对象存储上传失败 HTTP 403')],
  ])('%s', (reason, result) => {
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe(reason)
    expect(result.hint.length).toBeGreaterThan(0)
  })

  it('两个开关互为退路 —— 各自的提示语点名对方', () => {
    const search = disabledResult('search')
    const generate = disabledResult('generate')
    if (search.ok || generate.ok) throw new Error('unreachable')
    expect(search.hint).toContain('generateImage')
    expect(generate.hint).toContain('searchImage')
  })

  it('not_configured 明确叫它别重试 —— 配置问题重试一万次也是一样的结果', () => {
    const r = notConfiguredResult('对象存储未启用')
    if (r.ok) throw new Error('unreachable')
    expect(r.hint).toContain('不要重试')
    expect(r.hint).toContain('对象存储未启用')
  })

  it('no_results 引导换词，而不是换工具', () => {
    const r = noResultsResult('协同增效')
    if (r.ok) throw new Error('unreachable')
    expect(r.hint).toContain('协同增效')
    expect(r.hint).toContain('换一个')
  })
})

describe('serializeAssetResult', () => {
  it('产出可解析的 JSON，和 applyMutation 的返回风格一致', () => {
    const raw = serializeAssetResult({
      ok: true,
      images: [toolAsset({ hash: HASH, width: 100, height: 50, ticket: 't' })],
    })
    expect(JSON.parse(raw)).toEqual({
      ok: true,
      images: [{ src: `asset://${HASH}`, width: 100, height: 50, ticket: 't' }],
    })
  })

  it('失败结果序列化后仍带得走 reason 和 retryAfterSec', () => {
    const parsed = JSON.parse(serializeAssetResult(rateLimitedResult({ retryAfterSec: 12, limitPerMin: 3 })))
    expect(parsed.reason).toBe('rate_limited')
    expect(parsed.retryAfterSec).toBe(12)
  })
})

describe('工具名清单', () => {
  it('就是那两个，且被 assetTools.ts 的编译期断言钉着', () => {
    expect([...ASSET_TOOL_NAMES]).toEqual(['searchImage', 'generateImage'])
  })
})
