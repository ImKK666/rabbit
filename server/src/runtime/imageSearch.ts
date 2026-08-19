/**
 * 图库检索 —— 四家的差异收敛成一个形状
 *
 * 域无关：给关键词，返回一组候选图。不知道 deck、不知道版式。
 *
 * ## wikimedia 这一档是兜底，而且是个**弱**兜底
 *
 * Pexels / Unsplash / Pixabay 都要注册拿 key，而注册会卡人（网络、手机号、审核）。
 * Wikimedia Commons **完全不需要 key**，所以留它当「什么都没配也能用」的那一档。
 *
 * 但它有两个实测出来的硬伤，别把它当首选：
 *
 * **① 相关性一般。** 它是百科档案库，不是为审美策展的图库。
 * 「business team meeting」搜出来的是拉斯维加斯赌场照片；
 * 具体物件（data center / solar panels）和中文查询倒是不错。
 *
 * **② 从某些网络出去是间歇性的。** 同一台机器上实测：
 * 先是 9.5 秒返回、再是 4.9 秒返回，十分钟后**完全连不上**
 * （curl -4 也是 30 秒超时）。不是慢，是时通时不通。
 * 所以搜图必须有硬超时（见 `SEARCH_TIMEOUT_MS`），**挂住比失败更糟**。
 *
 * ## 一个会咬人的环境问题
 *
 * `commons.wikimedia.org` 的 AAAA 记录在某些网络下连不通，而
 * **bun 的 fetch 不会自动回退 IPv4** —— 表现是整整 15 秒超时后失败。
 * 实测 `dns.setDefaultResultOrder('ipv4first')` 在 bun 里是**空操作**，
 * 只有环境变量有效：
 *
 * ```
 * BUN_CONFIG_DNS_RESULT_ORDER=ipv4first
 * ```
 *
 * 已经写进 `server/package.json` 的 dev / start 脚本里，不靠人记得。
 *
 * ## 图库的合规要求（Pixabay 文档明写的三条，实装工具时必须兑现）
 *
 * **① 不许长期热链。** 原文：「permanent hotlinking of images (using Pixabay URLs
 * in your app) is not allowed. If you intend to use the images, please download
 * them to your server first.」——**我们的架构本来就是下载后传自己的 COS**，
 * 所以合规。但反过来说：**绝不能把图库的 URL 直接写进 deck**，
 * 那既违规，`webformatURL` 还只有 24 小时有效期。
 *
 * **② 必须署名。** 原文：「show your users where the images and videos are from,
 * whenever search results are displayed」。`ImageCandidate.attribution` 就是为这个留的，
 * 工具落地时要把它带进 deck 并在界面上显示 —— **字段留了不等于兑现了**。
 *
 * **③ 请求要缓存 24 小时。** 原文：「requests must be cached for 24 hours…
 * do not send lots of automated queries」。图片本身靠内容寻址天然只存一份，
 * 但**搜索请求本身还没有缓存**，接工具时要补。
 */

import type { AssetSearchProvider } from '@server/db/schema'

export interface ImageCandidate {
  /** 原图地址 */
  url: string
  width: number
  height: number
  /** 合规需要：图库图片基本都要求署名 */
  attribution?: { author: string, source: string, url: string }
}

export interface SearchOutcome {
  ok: boolean
  provider: AssetSearchProvider
  count: number
  elapsedMs: number
  candidates: ImageCandidate[]
  error?: string
}

/** 哪些家需要 key —— 设置页据此决定要不要显示 key 输入框 */
export const NEEDS_API_KEY: Record<AssetSearchProvider, boolean> = {
  wikimedia: false,
  pexels: true,
  unsplash: true,
  pixabay: true,
}

const UA = 'rabbit/0.1 (https://github.com/ImKK666/rabbit)'

/**
 * 单次搜图的硬超时。
 *
 * **挂住比失败更糟**：实测 Wikimedia 从这条网络出去是间歇性的 ——
 * 前一分钟 4.9 秒返回，后一分钟直接连不上（curl -4 也是 30 秒超时）。
 * 没有这个超时，一次搜图会把请求拖到服务器的 idleTimeout（255 秒）才算完，
 * 而 agent 那边就是干等。
 *
 * 8 秒是按「正常情况 1~5 秒」定的：够慢网络返回，又不至于让 agent 傻等。
 */
const SEARCH_TIMEOUT_MS = 8000

/** 带超时的 fetch。超时抛出的错误信息要能一眼看出是超时，不是别的网络错 */
const fetchWithTimeout = async (url: string, init: RequestInit = {}) => {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) })
  }
  catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Error(`图库请求超时（${SEARCH_TIMEOUT_MS / 1000}s）`)
    }
    throw err
  }
}

/** 把 HTML 标签剥掉 —— Wikimedia 的 Artist 字段是一段 HTML */
const stripHtml = (s: string) => s.replace(/<[^>]+>/g, '').trim()

const searchWikimedia = async (query: string, limit: number): Promise<ImageCandidate[]> => {
  const p = new URLSearchParams({
    action: 'query', format: 'json', origin: '*',
    generator: 'search',
    gsrsearch: `filetype:bitmap ${query}`,
    gsrlimit: String(limit),
    gsrnamespace: '6', // 只搜 File: 命名空间
    prop: 'imageinfo',
    iiprop: 'url|size|extmetadata',
    iiurlwidth: '1600', // 要一个缩放版，原图动辄几十 MB
  })
  const res = await fetchWithTimeout(`https://commons.wikimedia.org/w/api.php?${p}`, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`Wikimedia HTTP ${res.status}`)
  const pages = Object.values((await res.json() as any).query?.pages ?? {}) as any[]
  return pages.flatMap((pg) => {
    const i = pg.imageinfo?.[0]
    if (!i) return []
    return [{
      url: i.thumburl ?? i.url,
      width: i.thumbwidth ?? i.width,
      height: i.thumbheight ?? i.height,
      attribution: {
        author: stripHtml(i.extmetadata?.Artist?.value ?? '') || '未署名',
        source: `Wikimedia Commons · ${stripHtml(i.extmetadata?.LicenseShortName?.value ?? '') || '见原页'}`,
        url: i.descriptionurl ?? i.url,
      },
    }]
  })
}

const searchPexels = async (query: string, limit: number, apiKey: string): Promise<ImageCandidate[]> => {
  const res = await fetchWithTimeout(`https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=${limit}`, {
    headers: { Authorization: apiKey, 'User-Agent': UA },
  })
  if (!res.ok) throw new Error(`Pexels HTTP ${res.status}`)
  return ((await res.json() as any).photos ?? []).map((p: any) => ({
    url: p.src?.large2x ?? p.src?.large ?? p.src?.original,
    width: p.width, height: p.height,
    attribution: { author: p.photographer, source: 'Pexels', url: p.url },
  }))
}

const searchUnsplash = async (query: string, limit: number, apiKey: string): Promise<ImageCandidate[]> => {
  const res = await fetchWithTimeout(`https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=${limit}`, {
    headers: { Authorization: `Client-ID ${apiKey}`, 'User-Agent': UA },
  })
  if (!res.ok) throw new Error(`Unsplash HTTP ${res.status}`)
  return ((await res.json() as any).results ?? []).map((p: any) => ({
    url: p.urls?.regular ?? p.urls?.full,
    width: p.width, height: p.height,
    attribution: { author: p.user?.name ?? '未署名', source: 'Unsplash', url: p.links?.html },
  }))
}

/**
 * Pixabay 的 `largeImageURL` 最长边被缩到 1280，而 `imageWidth/imageHeight`
 * 报的是**原图**尺寸 —— 两者能差 4 倍以上。
 *
 * 交出去的是 large 那个 URL，就必须报 large 的尺寸：
 * 版式要拿宽高算 cover / contain 裁剪，报成原图尺寸会让它以为拿到一张
 * 5760px 的图，实际只有 1280px，满屏背景就是糊的。
 *
 * 实测三组全中（原图 → large）：
 *   3354×2019 → 1280×771 · 5760×3840 → 1280×853 · 5868×4004 → 1280×873
 */
export const PIXABAY_LARGE_MAX_EDGE = 1280

export const scaleToMaxEdge = (w: number, h: number, maxEdge: number) => {
  const longest = Math.max(w, h)
  if (!longest || longest <= maxEdge) return { width: w, height: h }
  const scale = maxEdge / longest
  return { width: Math.round(w * scale), height: Math.round(h * scale) }
}

const searchPixabay = async (
  query: string, limit: number, apiKey: string, lang: string,
): Promise<ImageCandidate[]> => {
  const p = new URLSearchParams({
    key: apiKey,
    q: query.slice(0, 100), // 文档：q 不得超过 100 字符
    per_page: String(Math.max(3, Math.min(200, limit))), // 文档：3~200
    image_type: 'photo',
    safesearch: 'true', // 图要插进用户的文稿里，默认就该是安全的
    lang,
  })
  const res = await fetchWithTimeout(`https://pixabay.com/api/?${p}`, { headers: { 'User-Agent': UA } })
  // 文档：超限返回 429 "API rate limit exceeded"。默认 100 次 / 60 秒，**按 key 算不按 IP**
  if (res.status === 429) {
    throw new Error(`Pixabay 限流（100 次/60 秒），${res.headers.get('X-RateLimit-Reset') ?? '?'} 秒后恢复`)
  }
  if (!res.ok) throw new Error(`Pixabay HTTP ${res.status}`)

  return ((await res.json() as any).hits ?? []).map((p: any) => {
    // fullHDURL / imageURL 只有「完整 API 权限」的账号才有，实测本 key 没有 —— 别指望它们
    const url = p.largeImageURL ?? p.webformatURL
    const { width, height } = p.largeImageURL
      ? scaleToMaxEdge(p.imageWidth, p.imageHeight, PIXABAY_LARGE_MAX_EDGE)
      : { width: p.webformatWidth, height: p.webformatHeight }
    return {
      url, width, height,
      attribution: { author: p.user, source: 'Pixabay', url: p.pageURL },
    }
  })
}

/** 查询里有中日韩字符就切到中文检索 —— Pixabay 的 lang 支持 zh */
export const detectLang = (q: string) => (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(q) ? 'zh' : 'en')

/**
 * 搜一次图。**不抛异常** —— 返回 `ok: false` 带原因。
 *
 * 理由和 `budget.ts` 对非法环境变量的处置一致：这是给设置页的「测试」按钮
 * 和 agent 工具共用的入口，两边都要「失败了也能继续往下走」，
 * 而不是把一个网络抖动变成 500。
 */
export const searchImages = async (
  provider: AssetSearchProvider,
  query: string,
  { apiKey = '', limit = 6 }: { apiKey?: string, limit?: number } = {},
): Promise<SearchOutcome> => {
  const started = Date.now()
  const done = (candidates: ImageCandidate[]): SearchOutcome => ({
    ok: true, provider, count: candidates.length, candidates,
    elapsedMs: Date.now() - started,
  })

  try {
    if (NEEDS_API_KEY[provider] && !apiKey) {
      throw new Error(`${provider} 需要 API Key，请先在设置里填写`)
    }
    switch (provider) {
      case 'wikimedia': return done(await searchWikimedia(query, limit))
      case 'pexels': return done(await searchPexels(query, limit, apiKey))
      case 'unsplash': return done(await searchUnsplash(query, limit, apiKey))
      case 'pixabay': return done(await searchPixabay(query, limit, apiKey, detectLang(query)))
      default: throw new Error(`未知图库：${provider}`)
    }
  }
  catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    // bun 不回退 IPv4 时的表现就是一个干巴巴的超时，这里把线索补上，
    // 否则排查的人只会看到「timed out」然后去怀疑网络
    const hint = /timed out|timeout|fetch failed/i.test(raw)
      ? '（若为 Wikimedia：需给后端设 BUN_CONFIG_DNS_RESULT_ORDER=ipv4first，bun 不会自动回退 IPv4）'
      : ''
    return { ok: false, provider, count: 0, candidates: [], elapsedMs: Date.now() - started, error: raw + hint }
  }
}
