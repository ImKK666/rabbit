/**
 * 生图 —— 域无关：给 prompt，返回一段图片字节
 *
 * 和 `imageSearch.ts` 对称：不知道 deck、不知道版式，**不抛异常**，
 * 失败返回 `ok: false` 带原因。理由同那边 —— 这是给 agent 工具用的入口，
 * 一次网络抖动不该变成一个把整轮任务打断的异常。
 *
 * ## R-62：两种请求形状（flavor）
 *
 * 第十七轮接入的是 **Gemini wire 形状**（`generateContent`，经中转）；
 * R-62 接入 **OpenAI Images 形状**（`/v1/images/generations`，gpt-image-2 系）。
 * 两条路共用这一个入口，按 `flavor` 分发：
 *
 * | | gemini | openai |
 * |---|---|---|
 * | 端点 | `{base}/v1beta/models/{m}:generateContent?key=…` | `{base}/v1/images/generations` + Bearer |
 * | 比例 | `imageConfig.aspectRatio`（生效但不精确，实测 1376/768） | `aspect_ratio`（16:9 直出） |
 * | 透明 | ❌ 无原生 alpha（装饰层走绿幕抠图） | ✅ `background: transparent` + `output_format: png` |
 * | 风格锁定 | ❌ | ✅ `seed`（同一份 deck 各页同 seed，跨页风格一致） |
 *
 * `auto` 按模型名猜：含 `gpt-image` → openai，否则 gemini —— 存量配置零迁移。
 *
 * ## 请求形状是实测出来的，不是照文档抄的（gemini 一侧）
 *
 * 第十七轮探路时用户给的 Python 片段跑不通：`:predict` 在这个中转上
 * 三个模型名全 404。真正能用的形状是（2026-08-19 实测，本轮再次验过）：
 *
 * ```
 * POST {origin}/v1beta/models/{model}:generateContent?key=…
 * { "contents": [{ "role": "user", "parts": [{ "text": … }] }],
 *   "generationConfig": { "responseModalities": ["IMAGE"] } }
 * → candidates[0].content.parts[].inlineData.data   (base64)
 * ```
 *
 * `role: "user"` **不能省**，少了直接 400。
 *
 * openai 一侧的参数表以官方 Images API 为准（2026-08 决策者提供的
 * gpt-image-2 接口总结）：generations 支持 `model/prompt/aspect_ratio/
 * quality/size/background/output_format/n/seed/moderation`。
 * 这里只发我们用得到的：aspect_ratio（16:9 直出，下游仍按解码后的
 * 真实像素用，见下）、background/output_format（透明通道）、seed（风格锁定）。
 *
 * ## 实测数字（gemini 一侧，本轮）
 *
 * | 请求 | 耗时 | 产物 |
 * |---|---|---|
 * | 不带 aspectRatio | 14.0 / 14.9 s | PNG 1408×768，**1.5~2.0 MB** |
 * | `aspectRatio: '16:9'` | 14.0 s | PNG 1376×768，922 KB |
 * | `aspectRatio: '1:1'` | 13.8 s | PNG 1024×1024，370 KB |
 *
 * 两件事值得记：
 *
 * **① 比例参数是生效的，但给的不一定精确。** 所以下游一律用**解码出来的
 * 真实像素**，不用请求时的比例去推 —— 第十七轮 Pixabay 那个「报原图尺寸、
 * 给缩略图」的真 bug 就是这么来的，满屏背景直接糊掉且不报错。
 *
 * **② 产物是 PNG，1~2 MB。** 所以 `imageCodec.ts` 的重编码不是可选项。
 *
 * ## 超时定 120 秒
 *
 * 实测 14~15 秒，文档记过 15~50 秒。120 秒给足余量，同时**必须小于**
 * `Bun.serve` 的 `idleTimeout`（已显式设成 255，见 `src/index.ts`）——
 * 让我们自己的超时先响，才能给出一句说得清的错误；
 * 被服务器掐掉的表现是一个没有响应体的失败，日志里只有一句 timed out。
 */

/** 单次生图的硬超时 */
const GENERATE_TIMEOUT_MS = 120_000

/**
 * 幻灯片是 16:9，所以这几个比例是按「放在一页里怎么用」选的：
 * 16:9 满屏背景 / 宽幅横幅 · 4:3 与 1:1 图文并排的插图 · 3:4 与 9:16 竖栏。
 */
export const IMAGE_ASPECT_RATIOS = ['1:1', '3:4', '4:3', '9:16', '16:9'] as const
export type ImageAspectRatio = typeof IMAGE_ASPECT_RATIOS[number]

/** R-62：生图接口形状。`auto` 按模型名猜 */
export type ImageApiFlavor = 'auto' | 'gemini' | 'openai'

/**
 * 把配置里的 flavor 落成确定的请求形状。
 *
 * `auto` 的判据是模型名含不含 `gpt-image` —— 官方模型线
 * （gpt-image-2 / gpt-image-1.5 / gpt-image-1 / gpt-image-1-mini）
 * 全在 OpenAI Images 形状上，Gemini 那套（gemini-2.x-flash 等）在 generateContent 上。
 * 中转站的自定义别名不可枚举，所以显式配置仍是兜底。
 */
export const resolveImageApiFlavor = (
  flavor: ImageApiFlavor,
  modelName: string,
): 'gemini' | 'openai' => {
  if (flavor === 'gemini' || flavor === 'openai') return flavor
  return /gpt-image/i.test(modelName) ? 'openai' : 'gemini'
}

/**
 * 拼出 `:generateContent` 的地址。
 *
 * **不硬编码 `/v/v1beta`。** 那个前缀是当前这个中转特有的
 * （库里配的 baseUrl 是 `https://g.92.run/v`），照抄会让换成官方端点
 * `https://generativelanguage.googleapis.com` 时拼出一个 404。
 *
 * 规则只有一条：**baseUrl 里已经有 `v1beta` 就不再加**。
 * 和 `baseUrl.ts` 那条「路径已有内容的一律不动」是同一个判断 ——
 * 宁可不修，也不能把本来能用的配置改坏。
 *
 *   https://g.92.run/v                      → https://g.92.run/v/v1beta/models/…
 *   https://g.92.run/v/v1beta               → 原样
 *   https://generativelanguage.googleapis.com → …/v1beta/models/…
 */
export const googleImageEndpoint = (baseUrl: string, model: string): string => {
  const base = baseUrl.trim().replace(/\/+$/, '')
  const withVersion = /\/v1beta$/.test(base) ? base : `${base}/v1beta`
  return `${withVersion}/models/${model}:generateContent`
}

/**
 * 拼出 `/images/generations` 的地址。
 *
 * 与 `googleImageEndpoint` 同一条规则：baseUrl 已以 `/v1` 结尾就不再加。
 * 官方是 `https://api.openai.com/v1`，中转站按文档替换域名、路径保持 `/v1`。
 */
export const openAiImagesEndpoint = (baseUrl: string): string => {
  const base = baseUrl.trim().replace(/\/+$/, '')
  const withVersion = /\/v1$/.test(base) ? base : `${base}/v1`
  return `${withVersion}/images/generations`
}

/**
 * R-62 补充：本地限流器该用的有效限额。
 *
 * **OpenAI 接口（image2）没有每分钟限流** —— 决策者实测确认。
 * gemini 形状保留库里配的限额（那个中转实测 2~3 次/分钟就 429，
 * 库里建议填 3）。限流器对 `null` 本来就「一律放行」（见 `rateLimiter.ts`），
 * 所以这里只做「按形状落成 null 还是配置值」这一件事。
 */
export const effectiveImageRateLimit = (
  flavor: 'gemini' | 'openai',
  configured: number | null,
): number | null => (flavor === 'openai' ? null : configured)

/**
 * 从一组字符串推一个稳定的正整数 seed。
 *
 * R-62 用途：装饰层/底图按「主题锚点色 + 艺术方向 + 层种」算 seed ——
 * 同一份稿子所有页同 seed，生图风格跨页一致（配合 artDirection 的
 * 风格词，这是「seed 锁风格」的确定性一侧）。djb2 就够：要的是稳定不是密码学。
 */
export const hashSeed = (parts: string[]): number => {
  let h = 5381
  for (const s of parts) {
    for (const ch of s) h = ((h << 5) + h + ch.charCodeAt(0)) | 0
  }
  return Math.abs(h) % 0x7fffffff
}

export interface GenerateOutcome {
  ok: boolean
  bytes?: Uint8Array
  /** 上游报的 MIME。**仅供参考** —— 下游一律按字节头判格式 */
  mimeType?: string
  elapsedMs: number
  error?: string
  /**
   * 上游明说配额用完了（429）。
   *
   * **必须是一个独立的布尔，不能让调用方去 regex 错误信息** ——
   * 它决定的是给 agent 的两种完全相反的建议：普通错误是「可以再试一次」，
   * 配额用完是「别试了，改用搜图」。把这个判断寄托在字符串匹配上，
   * 只要有人改一下措辞就会静默退化成前者。
   */
  rateLimited?: boolean
}

export interface GenerateInput {
  baseUrl: string
  apiKey: string
  model: string
  prompt: string
  aspectRatio?: ImageAspectRatio
  /** R-62：请求形状。缺省按 gemini（存量行为），调用方应传 resolve 后的值 */
  flavor?: 'gemini' | 'openai'
  /** R-62：要透明通道（openai 形状下 = background:transparent + png） */
  alpha?: boolean
  /** R-62：风格锁定种子。openai 形状才发 */
  seed?: number
}

/** gemini 形状：解析 `candidates[0].content.parts[].inlineData` */
const parseGeminiBytes = async (res: Response): Promise<{ bytes: Uint8Array, mimeType?: string }> => {
  const body = await res.json() as {
    candidates?: { content?: { parts?: { inlineData?: { data?: string, mimeType?: string } }[] } }[]
  }
  const inline = (body.candidates?.[0]?.content?.parts ?? []).find(p => p.inlineData)?.inlineData
  if (!inline?.data) {
    // 模型有可能只回了一段文字（比如判定 prompt 违反安全策略）。
    // 把响应片段带出来，否则排查的人只看到「没有图」
    throw new Error(`响应里没有图片数据：${JSON.stringify(body).slice(0, 200)}`)
  }
  return { bytes: new Uint8Array(Buffer.from(inline.data, 'base64')), mimeType: inline.mimeType }
}

/**
 * openai 形状：解析 `data[0]`。
 *
 * 中转站可能回 `b64_json`，也可能只给 `url`（决策者给的总结里两者都出现过）。
 * 给 url 时再拉一次 —— 用同一个超时，失败报得出来。
 */
const parseOpenAiBytes = async (res: Response, signal: AbortSignal): Promise<{ bytes: Uint8Array, mimeType?: string }> => {
  const body = await res.json() as {
    data?: { b64_json?: string | null, url?: string | null }[]
  }
  const item = body.data?.[0]
  if (item?.b64_json) {
    return { bytes: new Uint8Array(Buffer.from(item.b64_json, 'base64')) }
  }
  if (item?.url) {
    const dl = await fetch(item.url, { signal })
    if (!dl.ok) throw new Error(`下载生成图失败 HTTP ${dl.status}`)
    return { bytes: new Uint8Array(await dl.arrayBuffer()) }
  }
  throw new Error(`响应里没有图片数据：${JSON.stringify(body).slice(0, 200)}`)
}

const callGemini = async (
  input: GenerateInput, started: number,
): Promise<GenerateOutcome> => {
  const { baseUrl, apiKey, model, prompt, aspectRatio } = input
  const url = `${googleImageEndpoint(baseUrl, model)}?key=${encodeURIComponent(apiKey)}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      // role 不能省，少了 400
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ['IMAGE'],
        ...(aspectRatio ? { imageConfig: { aspectRatio } } : {}),
      },
    }),
    signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
  })

  if (res.status === 429) {
    return {
      ok: false, rateLimited: true, elapsedMs: Date.now() - started,
      error: '上游返回 429（配额耗尽）—— 本地的「每分钟上限」配得比上游实际额度宽，请调小',
    }
  }
  if (!res.ok) {
    throw new Error(`生图接口 HTTP ${res.status}：${(await res.text()).slice(0, 200)}`)
  }
  const { bytes, mimeType } = await parseGeminiBytes(res)
  return { ok: true, bytes, mimeType, elapsedMs: Date.now() - started }
}

const callOpenAi = async (
  input: GenerateInput, started: number,
): Promise<GenerateOutcome> => {
  const { baseUrl, apiKey, model, prompt, aspectRatio, alpha, seed } = input
  const res = await fetch(openAiImagesEndpoint(baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      prompt,
      n: 1,
      // 比例直出（gpt-image-2 官方参数）。下游仍按解码后的真实像素用
      ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
      // 透明通道：官方是 background=transparent + png/webp 才真正带 alpha
      ...(alpha ? { background: 'transparent', output_format: 'png' } : {}),
      ...(seed !== undefined ? { seed } : {}),
    }),
    signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
  })

  if (res.status === 429) {
    return {
      ok: false, rateLimited: true, elapsedMs: Date.now() - started,
      error: '上游返回 429（配额耗尽）—— 本地的「每分钟上限」配得比上游实际额度宽，请调小',
    }
  }
  if (!res.ok) {
    throw new Error(`生图接口 HTTP ${res.status}：${(await res.text()).slice(0, 200)}`)
  }
  const { bytes } = await parseOpenAiBytes(res, AbortSignal.timeout(GENERATE_TIMEOUT_MS))
  return { ok: true, bytes, elapsedMs: Date.now() - started }
}

export const generateImage = async (input: GenerateInput): Promise<GenerateOutcome> => {
  const started = Date.now()
  try {
    return (input.flavor ?? 'gemini') === 'openai'
      ? await callOpenAi(input, started)
      : await callGemini(input, started)
  }
  catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    const msg = /timed out|timeout|aborted/i.test(raw)
      ? `生图超时（${GENERATE_TIMEOUT_MS / 1000}s）`
      : raw
    return { ok: false, elapsedMs: Date.now() - started, error: msg }
  }
}
