/**
 * 生图 —— 域无关：给 prompt，返回一段图片字节
 *
 * 和 `imageSearch.ts` 对称：不知道 deck、不知道版式，**不抛异常**，
 * 失败返回 `ok: false` 带原因。理由同那边 —— 这是给 agent 工具用的入口，
 * 一次网络抖动不该变成一个把整轮任务打断的异常。
 *
 * ## 请求形状是实测出来的，不是照文档抄的
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
 * ## 实测数字（本轮）
 *
 * | 请求 | 耗时 | 产物 |
 * |---|---|---|
 * | 不带 aspectRatio | 14.0 / 14.9 s | PNG 1408×768，**1.5~2.0 MB** |
 * | `aspectRatio: '16:9'` | 14.0 s | PNG 1376×768，922 KB |
 * | `aspectRatio: '1:1'` | 13.8 s | PNG 1024×1024，370 KB |
 *
 * 两件事值得记：
 *
 * **① `imageConfig.aspectRatio` 是**生效的**，但给的不是精确比例**
 * （16:9 要 1.778，实得 1376/768 = 1.792）。所以下游一律用**解码出来的真实像素**，
 * 不用请求时的比例去推 —— 第十七轮 Pixabay 那个「报原图尺寸、给缩略图」的
 * 真 bug 就是这么来的，满屏背景直接糊掉且不报错。
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
}

export const generateImage = async (
  { baseUrl, apiKey, model, prompt, aspectRatio }: GenerateInput,
): Promise<GenerateOutcome> => {
  const started = Date.now()
  const url = `${googleImageEndpoint(baseUrl, model)}?key=${encodeURIComponent(apiKey)}`

  try {
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
      // 本地限流应该在这之前就拦住了（见 rateLimiter.ts）。走到这里说明
      // 配的额度比上游实际的宽 —— 实测就撞到过：库里配 3/分钟，
      // 而这个中转实际只放 2 次，第 3 次直接 429。
      //
      // 不抛，而是带着 rateLimited 标记正常返回：调用方要据此给出
      // 「改用搜图」而不是「可以重试」，两者差一个字都会让 agent 白烧一轮
      return {
        ok: false,
        rateLimited: true,
        elapsedMs: Date.now() - started,
        error: '上游返回 429（配额耗尽）—— 本地的「每分钟上限」配得比上游实际额度宽，请调小',
      }
    }
    if (!res.ok) {
      throw new Error(`生图接口 HTTP ${res.status}：${(await res.text()).slice(0, 200)}`)
    }

    const body = await res.json() as {
      candidates?: { content?: { parts?: { inlineData?: { data?: string, mimeType?: string } }[] } }[]
    }
    const inline = (body.candidates?.[0]?.content?.parts ?? []).find(p => p.inlineData)?.inlineData

    if (!inline?.data) {
      // 模型有可能只回了一段文字（比如判定 prompt 违反安全策略）。
      // 把响应片段带出来，否则排查的人只看到「没有图」
      throw new Error(`响应里没有图片数据：${JSON.stringify(body).slice(0, 200)}`)
    }

    return {
      ok: true,
      bytes: new Uint8Array(Buffer.from(inline.data, 'base64')),
      mimeType: inline.mimeType,
      elapsedMs: Date.now() - started,
    }
  }
  catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    const msg = /timed out|timeout|aborted/i.test(raw)
      ? `生图超时（${GENERATE_TIMEOUT_MS / 1000}s）`
      : raw
    return { ok: false, elapsedMs: Date.now() - started, error: msg }
  }
}
