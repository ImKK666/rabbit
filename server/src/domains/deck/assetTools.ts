/**
 * 图片工具 —— `searchImage` / `generateImage`
 *
 * D1 的工具层。配置层是第十七轮做的（两张表 + 两个设置页 + 限流字段），
 * 这一轮把它接成 agent 真的能调的两个工具。
 *
 * ## 为什么是同步等图，而不是异步票据
 *
 * `assets.ts` 当初设计的形状是「工具立刻返回 `asset://pending/<id>`，
 * 后台完成后改元素的 src」，协议里的 `agent.asset.pending` / `.ready`
 * 就是为那条路留的。**这一轮没有走那条路**，因为它和 B 期刚立的两条契约正面冲突：
 *
 * | 契约 | 冲突点 |
 * |---|---|
 * | R-44 中途落库 | 所有 deck 变更必须走 `channel.commit`（先落库再推画布、内部串行），而 channel 的生命周期**绑在任务上**（signal / drain / stats）。任务结束后没有 channel 可用 |
 * | R-45 单一权威写者 | 任务结束时前端把所有权还给 `user`、画布解锁。此后再推 `agent.deck` 会被对称守卫**丢弃且不报错** —— 图永远补不上 |
 *
 * `events.ts:54` 的注释其实已经预见到一半：「真接上之后 `asset.ready` 会改
 * 元素的 src —— 那时它就是权威状态了，**要连同一次 commit 一起走**」。
 *
 * 所以现在的形状是：
 *
 * ```
 * generateImage(prompt)
 *   ├ 建票据行（pending）
 *   ├ 发 agent.asset.pending        ← 纯叙事，填上那 14 秒的沉默
 *   ├ 生图 14~15 秒（agent 在这里等）
 *   ├ 压缩 → 传 COS → 票据置 ready
 *   ├ 发 agent.asset.ready          ← 纯叙事
 *   └ 返回 asset://<sha256>
 *
 * agent 拿到 hash 后**自己**调 addElement 写进 deck
 *   → 走 applyMutation → channel.commit ✅ 两条契约一个字都不用改
 * ```
 *
 * 于是 `agent.asset.*` 三条消息**不改 deck**，`events.ts` 里
 * 「叙事类可回收」的分类继续正确。
 *
 * **代价说清楚**：生图的 14~15 秒里 agent 是阻塞的，一份配 6 张图的 deck
 * 要多等 1.5 分钟。步数预算不受影响（一次调用一步，上限 512）。
 * 真要做成异步，得先解决「任务结束后谁是权威写者」——建议放到 C 期
 * 和 `FINISHING` 态一起做，那时才有一个状态能表达「任务还没真正结束」。
 *
 * ## 这个文件碰库，所以策略不写在这里
 *
 * 票据表和搜图缓存都要落库，而 `db/index.ts` 拉 `bun:sqlite`，
 * **vitest 里 import 不进来**。所以所有「写错了不会有东西报错」的判断
 * 都放在有判据的地方：
 *   - 返回形状与合规 → `assetResults.ts`
 *   - 缓存键与过期 → `runtime/searchCache.ts`
 *   - 限流窗口 → `runtime/rateLimiter.ts`
 *   - 压缩分支 → `runtime/imageCodec.ts`
 * 这里只剩搬运和接线。
 */

import crypto from 'node:crypto'
import { tool } from 'ai'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { db } from '@server/db'
import { assets, assetSearchCache, type AssetSearchProvider } from '@server/db/schema'
import type { ServerMessage } from '@server/ws/handler'
import { searchImages, detectLang, type ImageCandidate } from '@server/runtime/imageSearch'
import {
  generateImage as callGenerateImage, resolveImageApiFlavor, effectiveImageRateLimit,
  IMAGE_ASPECT_RATIOS,
} from '@server/runtime/imageGenerate'
import { storeImageBytes, type StoredImage } from '@server/runtime/assetIngest'
import { searchCacheKey, readCache } from '@server/runtime/searchCache'
import { imageRateLimiter, modelRateKey } from '@server/runtime/rateLimiter'
import {
  openAssetStorage, loadAssetSourceRow, loadImageModel, storageMissingFields, loadStorageRow,
} from '@server/runtime/assetConfig'
import {
  toolAsset, serializeAssetResult, rateLimitedResult, disabledResult, notConfiguredResult,
  noResultsResult, providerErrorResult, decodeFailedResult, uploadFailedResult,
  type AssetToolResult, type ToolAsset, type Attribution, type AssetToolName,
} from './assetResults'

export interface AssetToolContext {
  userId: number
  deckId: number
  /**
   * 发下行事件。生产环境是 `channel.emit`，所以取消之后这几条会被闸门回收 ——
   * 那正是我们要的：它们是叙事，不是权威状态。
   */
  emit: (msg: ServerMessage) => void
  /** 注入时钟，缓存过期判定用。不注入就没法测「24 小时那一刻」 */
  now?: () => number
}

/** 一次搜图向图库要几个候选。多要几个是为了某张下载失败时能接着试下一张 */
const SEARCH_CANDIDATE_POOL = 8

/** 一次调用最多交付几张图 */
const MAX_IMAGES_PER_CALL = 3

/** 下载一张图的硬超时。挂住比失败更糟，理由同 imageSearch.ts */
const DOWNLOAD_TIMEOUT_MS = 20_000

const newTicket = () => crypto.randomBytes(8).toString('hex')

// ---------------------------------------------------------------------------
// 票据
// ---------------------------------------------------------------------------

const openTicket = async (
  { ticket, kind, ctx, prompt, source }: {
    ticket: string
    kind: 'search' | 'generate'
    ctx: AssetToolContext
    prompt: string
    source: string
  },
) => {
  await db.insert(assets).values({
    ticket, kind, status: 'pending',
    userId: ctx.userId, deckId: ctx.deckId, prompt, source,
  })
  ctx.emit({ type: 'agent.asset.pending', ticket, kind, prompt })
}

const closeTicketReady = async (
  ticket: string,
  ctx: AssetToolContext,
  data: {
    hash: string, storageKey: string, width: number, height: number,
    bytes: number, originalBytes: number, compressReason: string,
    attribution?: Attribution,
  },
) => {
  await db.update(assets).set({
    status: 'ready',
    hash: data.hash,
    storageKey: data.storageKey,
    width: data.width,
    height: data.height,
    bytes: data.bytes,
    originalBytes: data.originalBytes,
    compressReason: data.compressReason,
    // 合规②：署名的**权威副本**在这里，不依赖模型记得把它抄进元素
    attributionAuthor: data.attribution?.author,
    attributionSource: data.attribution?.source,
    attributionUrl: data.attribution?.url,
    updatedAt: new Date(),
  }).where(eq(assets.ticket, ticket))

  ctx.emit({
    type: 'agent.asset.ready',
    ticket,
    src: `asset://${data.hash}`,
    width: data.width,
    height: data.height,
  })
}

const closeTicketFailed = async (ticket: string, ctx: AssetToolContext, error: string) => {
  await db.update(assets)
    .set({ status: 'failed', error: error.slice(0, 500), updatedAt: new Date() })
    .where(eq(assets.ticket, ticket))
  // 不发这条的话，面板上那个「生成中」会一直转下去 —— 用户看到的是「卡死了」
  ctx.emit({ type: 'agent.asset.failed', ticket, reason: error.slice(0, 200) })
}

/**
 * 进程启动时把上一次没跑完的 pending 票据扫成 failed。
 *
 * 同步等图的形状下，进程死掉时任务本身也死了，没有「在飞的图」需要恢复 ——
 * 但**留在库里的 pending 行会永远挂着**，让审计和将来的去重都读到一个假状态。
 */
export const sweepStalePendingAssets = async (): Promise<number> => {
  const stale = await db.update(assets)
    .set({ status: 'failed', error: '进程重启，任务未完成', updatedAt: new Date() })
    .where(eq(assets.status, 'pending'))
    .returning({ id: assets.id })
  return stale.length
}

// ---------------------------------------------------------------------------
// 落图：下载/生成 → 压缩 → 传对象存储
// ---------------------------------------------------------------------------

/**
 * `storeImageBytes` 的本地包装：把「对象存储没配好」翻译成一句人话。
 *
 * 共用实现刻意不认 `null` store —— 它不碰库也不认配置，
 * 而「没配好」是调用方的处境，措辞该由调用方决定。
 */
const storeBytes = async (
  raw: Uint8Array,
  maxEdgePx: number,
  store: Awaited<ReturnType<typeof openAssetStorage>>,
): Promise<StoredImage> => {
  if (!store) throw new Error('对象存储不可用')
  return storeImageBytes(raw, maxEdgePx, store.store)
}

const download = async (url: string): Promise<Uint8Array> => {
  const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`下载图片失败 HTTP ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

// ---------------------------------------------------------------------------
// 搜图缓存（合规③：24 小时）
// ---------------------------------------------------------------------------

const readSearchCache = async (key: string, nowMs: number): Promise<ImageCandidate[] | null> => {
  const row = await db.select().from(assetSearchCache).where(eq(assetSearchCache.key, key)).get()
  if (!row) return null
  return readCache(
    { candidates: JSON.parse(row.candidatesJson) as ImageCandidate[], fetchedAtMs: row.fetchedAt.getTime() },
    nowMs,
  )
}

const writeSearchCache = async (
  key: string, provider: AssetSearchProvider,
  query: string, candidates: ImageCandidate[], nowMs: number,
) => {
  const values = {
    key, provider, query,
    candidatesJson: JSON.stringify(candidates),
    fetchedAt: new Date(nowMs),
  }
  // upsert：同一个键过期后要覆盖，不是插一条新的
  await db.insert(assetSearchCache).values(values)
    .onConflictDoUpdate({ target: assetSearchCache.key, set: values })
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

export const createAssetTools = (ctx?: AssetToolContext) => ({
  searchImage: tool({
    description: [
      '从图库搜一张真实照片，下载后存进本项目的对象存储，返回可直接用作图片元素 src 的 asset:// 地址。',
      '快（约 1 秒），适合具象的事物：城市、办公场景、设备、自然风光。',
      '关键词用英文效果最好，越具体越好；抽象概念（如「创新」「协同」）搜不到好图，那种情况用 generateImage。',
      '返回的 attribution 是图片来源信息，图库要求署名 —— 请在页面上放一行小字注明作者与来源。',
    ].join(''),
    parameters: z.object({
      query: z.string().min(1).max(100).describe('搜索关键词，建议英文、具象名词'),
      count: z.number().int().min(1).max(MAX_IMAGES_PER_CALL).optional()
        .describe(`要几张不同的图，默认 1，最多 ${MAX_IMAGES_PER_CALL}`),
    }),
    execute: async ({ query, count }) => {
      if (!ctx) return serializeAssetResult(notConfiguredResult('图片能力未装配'))
      return serializeAssetResult(await runSearch(ctx, query, count ?? 1))
    },
  }),

  generateImage: tool({
    description: [
      '用 AI 生成一张图片，存进本项目的对象存储，返回可直接用作图片元素 src 的 asset:// 地址。',
      '慢（约 15 秒）且有每分钟配额，适合图库搜不到的东西：抽象概念、特定风格的插画、指定构图的背景。',
      'prompt 用英文描述画面内容与风格，不要在图里要求文字（模型写出来的字大多是错的）。',
      '被限流时会返回 reason="rate_limited"，那时请改用 searchImage，不要重试。',
    ].join(''),
    parameters: z.object({
      prompt: z.string().min(1).max(2000).describe('画面描述，建议英文，含主体、场景、风格、光线'),
      aspectRatio: z.enum(IMAGE_ASPECT_RATIOS).optional()
        .describe('画面比例。满屏背景/宽幅用 16:9，图文并排的插图用 4:3 或 1:1，竖栏用 3:4'),
    }),
    execute: async ({ prompt, aspectRatio }) => {
      if (!ctx) return serializeAssetResult(notConfiguredResult('图片能力未装配'))
      return serializeAssetResult(await runGenerate(ctx, prompt, aspectRatio))
    },
  }),
})

export type AssetTools = ReturnType<typeof createAssetTools>

/**
 * 三方对齐的编译期闸门：**字面量 ≡ `ASSET_TOOL_NAMES` ≡ `keyof AssetTools`**。
 *
 * 加了第三个工具时，三处任意一处漏改这一行都编译不过：
 * 少写字面量 → Record 缺键；少写清单 → 多余属性；少写工具 → Record 缺键。
 * 没有它，`toolGroups.test.ts` 那条「每个工具都归了组」对图片工具是**测不到**的
 * （那个文件 import 不进 assetTools），于是新工具会安静地永远不出现在 agent 手里。
 */
const _assetToolNamesMatch: Record<AssetToolName, true> & Record<keyof AssetTools, true> = {
  searchImage: true,
  generateImage: true,
}
void _assetToolNamesMatch

// ---------------------------------------------------------------------------
// 实现
// ---------------------------------------------------------------------------

const runSearch = async (
  ctx: AssetToolContext,
  query: string,
  count: number,
): Promise<AssetToolResult> => {
  const now = ctx.now ?? Date.now
  const source = await loadAssetSourceRow()
  if (!source?.searchEnabled) return disabledResult('search')

  const storage = await openAssetStorage()
  if (!storage) {
    const row = await loadStorageRow()
    const missing = storageMissingFields(row)
    return notConfiguredResult(
      row?.enabled === false
        ? '对象存储未启用，图片无处存放'
        : `对象存储配置不全：缺 ${missing.join(' / ')}`,
    )
  }

  const lang = detectLang(query)
  const key = searchCacheKey({ provider: source.searchProvider, query, lang, limit: SEARCH_CANDIDATE_POOL })

  // 合规③：图库要求请求缓存 24 小时。命中时一个字节都不发给对方
  let candidates = await readSearchCache(key, now())
  if (!candidates) {
    const outcome = await searchImages(source.searchProvider, query, {
      apiKey: source.searchApiKey, limit: SEARCH_CANDIDATE_POOL,
    })
    if (!outcome.ok) return providerErrorResult(outcome.error ?? '搜索失败')
    candidates = outcome.candidates
    // **只缓存成功的**。把一次网络抖动缓存 24 小时，等于一次超时让搜图瘫一天
    await writeSearchCache(key, source.searchProvider, query, candidates, now())
  }

  if (candidates.length === 0) return noResultsResult(query)

  const images: ToolAsset[] = []
  const failures: string[] = []

  // 按顺序试，够数就停 —— 只上传真正要交付的那几张，不为没人用的候选付存储费
  for (const candidate of candidates) {
    if (images.length >= count) break

    const ticket = newTicket()
    await openTicket({ ticket, kind: 'search', ctx, prompt: query, source: source.searchProvider })
    try {
      const stored = await storeBytes(await download(candidate.url), source.maxEdgePx, storage)
      await closeTicketReady(ticket, ctx, { ...stored, attribution: candidate.attribution })
      images.push(toolAsset({
        hash: stored.hash, width: stored.width, height: stored.height,
        ticket, attribution: candidate.attribution, luminance: stored.luminance,
      }))
    }
    catch (err) {
      const msg = err instanceof Error ? err.message : '未知错误'
      await closeTicketFailed(ticket, ctx, msg)
      failures.push(msg)
    }
  }

  if (images.length === 0) {
    // 全部候选都失败了。区分「解不开」和「传不上去」—— 两者的处置完全不同
    const joined = failures.join('；') || '未知原因'
    return /存储|上传|HTTP 4|HTTP 5/.test(joined)
      ? uploadFailedResult(joined)
      : decodeFailedResult(joined)
  }

  return {
    ok: true,
    images,
    note: failures.length
      ? `已交付 ${images.length} 张；另有 ${failures.length} 张候选失败并已跳过。`
      : undefined,
  }
}

const runGenerate = async (
  ctx: AssetToolContext,
  prompt: string,
  aspectRatio: typeof IMAGE_ASPECT_RATIOS[number] | undefined,
): Promise<AssetToolResult> => {
  const source = await loadAssetSourceRow()
  if (!source?.generateEnabled) return disabledResult('generate')

  const storage = await openAssetStorage()
  if (!storage) {
    const row = await loadStorageRow()
    return notConfiguredResult(
      row?.enabled === false
        ? '对象存储未启用，图片无处存放'
        : `对象存储配置不全：缺 ${storageMissingFields(row).join(' / ')}`,
    )
  }

  const resolved = await loadImageModel(source.imageModelConfigId)
  if (!resolved.ok) return notConfiguredResult(resolved.error)
  const { model } = resolved

  // 限流在**打上游之前**。超限不消耗名额，见 runtime/rateLimiter.ts
  // R-62 补充：openai 接口（image2）没有每分钟限流 → 限额落成 null（一律放行）
  const flavor = resolveImageApiFlavor(source.imageApi, model.modelName)
  const decision = imageRateLimiter.tryAcquire(
    modelRateKey(model.modelConfigId), effectiveImageRateLimit(flavor, model.rateLimitPerMin),
  )
  if (!decision.allowed) {
    return rateLimitedResult({
      retryAfterSec: decision.retryAfterSec,
      limitPerMin: model.rateLimitPerMin ?? 0,
    })
  }

  const ticket = newTicket()
  await openTicket({ ticket, kind: 'generate', ctx, prompt, source: model.displayName })

  const outcome = await callGenerateImage({
    baseUrl: model.baseUrl, apiKey: model.apiKey, model: model.modelName, prompt, aspectRatio,
    // R-62：内容配图也跟着配置走请求形状（openai 形状下 gpt-image-2 直连）
    flavor,
  })

  if (!outcome.ok || !outcome.bytes) {
    const msg = outcome.error ?? '生图失败'
    await closeTicketFailed(ticket, ctx, msg)

    // 上游明说配额用完了。**这里必须给和本地限流一样的建议** ——
    // 实测撞到过：库里配 3 次/分钟，中转实际只放 2 次，于是第 3 次拿到 429。
    // 当成普通 provider_error 的话，提示语是「可以再试一次」，
    // 而那正好是此刻最不该做的事，agent 会一路重试到步数耗尽。
    if (outcome.rateLimited) {
      // 顺手把这个键按死：对方已经给了答案，没必要每次都再问一遍。
      // 60 秒是按「每分钟配额」这个语义取的，和窗口长度一致
      imageRateLimiter.block(modelRateKey(model.modelConfigId), 60)
      const after = imageRateLimiter.tryAcquire(modelRateKey(model.modelConfigId), model.rateLimitPerMin)
      return rateLimitedResult({
        retryAfterSec: after.retryAfterSec || 60,
        limitPerMin: model.rateLimitPerMin ?? 0,
      })
    }

    return providerErrorResult(msg)
  }

  try {
    const stored = await storeBytes(outcome.bytes, source.maxEdgePx, storage)
    await closeTicketReady(ticket, ctx, stored)
    return {
      ok: true,
      images: [toolAsset({
        hash: stored.hash, width: stored.width, height: stored.height, ticket,
        luminance: stored.luminance,
      })],
      // 报的是**解码出来的真实像素**，不是请求时的比例 ——
      // 实测 aspectRatio:'16:9' 给的是 1376×768（1.792，不是 1.778）
      note: `生成耗时 ${(outcome.elapsedMs / 1000).toFixed(1)} 秒，实际尺寸 ${stored.width}×${stored.height}。`,
    }
  }
  catch (err) {
    const msg = err instanceof Error ? err.message : '未知错误'
    await closeTicketFailed(ticket, ctx, msg)
    return /存储|上传|HTTP/.test(msg) ? uploadFailedResult(msg) : decodeFailedResult(msg)
  }
}
