/**
 * 图片工具的返回形状 —— 这一轮全部的**策略决定**都在这个文件里
 *
 * 单独拆出来的理由和 `events.ts` 一模一样：`assetTools.ts` 要碰库
 * （票据表、搜图缓存），而库经 `db/index.ts` 拉 `bun:sqlite`，
 * **vitest 里 import 不进来**。策略写在那边等于没有判据。
 *
 * 这里装的是三件「写错了不会有任何东西报错」的事：
 *
 * ## ① 限流被拒时返回什么，才能让 agent 自己改用搜图
 *
 * **返回，不抛。** 抛出去的话 SDK 把它变成一次工具错误，模型的默认反应是
 * 「再试一次」——而它一定会再被拒，白烧两步预算。这条和 `searchImages`
 * 「不抛异常，返回 ok:false」、`budget.ts`「非法环境变量退回默认不报错」是同一个判断：
 * **失败了也要能继续往下走。**
 *
 * 光返回 `ok:false` 还不够，三样缺一不可 ——
 *   - `reason` 是**稳定的机器码**（不是中文句子），单测能钉住它
 *   - `retryAfterSec` 让模型知道要等多久，也让我们能独立算一遍验证
 *   - `hint` 里**点名替代工具**。不点名时模型的默认反应是重试同一个工具；
 *     点了名它才知道有第二条路。第十七轮定的「搜图和生图分成两个工具」
 *     就是为了这一刻 —— 分开了但不告诉模型，等于没分
 *
 * ## ② 合规：图库 URL 一个字节都不许进 deck
 *
 * Pixabay 文档明写不许长期热链，而且 `webformatURL` 只有 24 小时有效期。
 * 我们的架构是下载后传自己的 COS，本来就合规 —— 但**「本来就合规」不是判据**。
 * 判据是 `toolAsset()` 产出的 `src` 必须匹配 `asset://<64 位 hex>`，
 * 任何别的形状都是 bug。这条有单测钉着。
 *
 * ## ③ 合规：署名必须真的被带出去
 *
 * 「`attribution` 字段留了不等于兑现了」是第十七轮写进 `imageSearch.ts` 的原话。
 * 权威副本落在 `assets` 表（按 hash 可反查，不依赖模型），
 * 工具返回值里也带一份，让 agent 能把它写进元素。
 */

/**
 * 图片工具的名字。
 *
 * 放在这个（不碰库的）文件里，是为了让 `toolGroups.test.ts` import 得到 ——
 * `assetTools.ts` 经 `db/index.ts` 拉 `bun:sqlite`，vitest 里加载不了。
 * 没有这份清单，「加了工具忘了归组」这条判据就够不着图片工具。
 */
export const ASSET_TOOL_NAMES = ['searchImage', 'generateImage'] as const
export type AssetToolName = typeof ASSET_TOOL_NAMES[number]

/** 稳定的机器码。**改这里等于改协议** —— 单测按它断言，不按提示语断言 */
export type AssetFailureReason =
  /** 本地限流拦下（还没打上游） */
  | 'rate_limited'
  /** 管理员没开这个开关 */
  | 'disabled'
  /** 开关开了但配置不全（没配对象存储 / 没填 key / 没选模型） */
  | 'not_configured'
  /** 上游正常返回，但一张图都没有 */
  | 'no_results'
  /** 上游报错 / 超时 */
  | 'provider_error'
  /** 拿到字节了，但解不开（格式不支持、字节损坏） */
  | 'decode_failed'
  /** 传对象存储失败 */
  | 'upload_failed'

export interface Attribution {
  author: string
  source: string
  url: string
}

/** 工具交给 agent 的一张图 */
export interface ToolAsset {
  /**
   * **一定是 `asset://<sha256>`。** 见文件头 ②。
   * 前端 `utils/assetUrl.ts` 独家解释这个文法，deck 与存储位置就此解耦。
   */
  src: string
  /** 压缩/缩放**之后**的真实像素。版式拿它算 cover / contain */
  width: number
  height: number
  /**
   * 图片亮度，`[p5, p95]`，0~1。
   *
   * 版式拿它算**背景图遮罩该多浓**（`domains/deck/design.ts` 的 `scrimFor`）。
   * 给区间而不是单个均值：照片不均匀，一行字压在最亮/最暗的那一小块上就看不见了，
   * 而均值对此一无所知。哪一头是最坏取决于文字颜色，交给 `scrimFor` 挑。
   *
   * 少了它遮罩会退回一个中位数常量 —— 能用，但深色照片会被压得过狠、
   * 浅色照片压不住。改之前整整两轮就是那个样子（0.82 的常量，实测把照片压没了）。
   */
  luminance?: [number, number]
  /** 图库来源时必有。生图没有来源可署 */
  attribution?: Attribution
  /** 票据 id，和 `agent.asset.*` 两条消息对得上 */
  ticket: string
}

export type AssetToolResult =
  | { ok: true, images: ToolAsset[], note?: string }
  | { ok: false, reason: AssetFailureReason, hint: string, retryAfterSec?: number }

/** `asset://` + 64 位十六进制。判据用，也给 assetTools 自检用 */
export const ASSET_SRC_PATTERN = /^asset:\/\/[0-9a-f]{64}$/

/**
 * 造一条交给 agent 的图片记录。
 *
 * `hash` 必须是内容寻址算出来的 sha256 —— 传别的进来会当场抛，
 * 而不是产出一个「看着像 asset:// 的坏值」。合规①是硬要求，
 * 硬要求就该在**产生的那一刻**验，不是等 lint 事后发现。
 */
export const toolAsset = (
  { hash, width, height, ticket, attribution, luminance }: {
    hash: string
    width: number
    height: number
    ticket: string
    attribution?: Attribution
    luminance?: [number, number]
  },
): ToolAsset => {
  const src = `asset://${hash}`
  if (!ASSET_SRC_PATTERN.test(src)) {
    throw new Error(`资产 src 不合法："${src}" —— 必须是 asset:// 加 64 位十六进制 sha256`)
  }
  return {
    src,
    width,
    height,
    ticket,
    ...(luminance ? { luminance } : {}),
    ...(attribution ? { attribution } : {}),
  }
}

/**
 * 生图被本地限流拦下。
 *
 * 提示语里点名 `searchImage` 是这条的**全部意义**，见文件头 ①。
 */
export const rateLimitedResult = (
  { retryAfterSec, limitPerMin }: { retryAfterSec: number, limitPerMin: number },
): AssetToolResult => ({
  ok: false,
  reason: 'rate_limited',
  retryAfterSec,
  hint: `生图配额已用完（每分钟 ${limitPerMin} 张），约 ${retryAfterSec} 秒后恢复。`
    + '现在请改用 searchImage 搜一张现成的图片，**不要重试 generateImage** —— 重试只会再被拒绝。'
    + '搜图快得多（约 1 秒）而且没有这个配额限制。',
})

/** 开关没开。提示语要说清「去哪儿开」，否则用户只看到一句「不可用」 */
export const disabledResult = (kind: 'search' | 'generate'): AssetToolResult => ({
  ok: false,
  reason: 'disabled',
  hint: kind === 'search'
    ? '搜图未启用。管理员可在「设置 → 素材来源」里打开它。'
      + '如果生图是开着的，可以改用 generateImage。'
    : '生图未启用。管理员可在「设置 → 素材来源」里打开它。'
      + '如果搜图是开着的，可以改用 searchImage。',
})

/** 配置不全。`what` 要具体到「缺哪一样」—— 一句「配置错误」等于没说 */
export const notConfiguredResult = (what: string): AssetToolResult => ({
  ok: false,
  reason: 'not_configured',
  hint: `${what}。这一项要管理员在设置里配好，agent 无法自行解决 ——`
    + '请不要重试这个工具，改用另一种取图方式，或者先不放图把版面做完。',
})

/** 上游正常但没搜到。这条要引导模型**换词**，而不是换工具 */
export const noResultsResult = (query: string): AssetToolResult => ({
  ok: false,
  reason: 'no_results',
  hint: `「${query}」没有搜到图片。换一个更具体、更常见的英文关键词再试一次`
    + '（图库对抽象概念的覆盖普遍很差，具象名词效果好得多）；'
    + '连试两次都没有就改用 generateImage。',
})

export const providerErrorResult = (message: string): AssetToolResult => ({
  ok: false,
  reason: 'provider_error',
  hint: `图片服务出错：${message}。可以再试一次；连续失败就先不放图，把版面其余部分做完。`,
})

export const decodeFailedResult = (message: string): AssetToolResult => ({
  ok: false,
  reason: 'decode_failed',
  hint: `拿到的图片解不开：${message}。换一个关键词或换一种取图方式。`,
})

export const uploadFailedResult = (message: string): AssetToolResult => ({
  ok: false,
  reason: 'upload_failed',
  hint: `图片存储失败：${message}。这通常是对象存储配置的问题，重试大概率还是失败 ——`
    + '请先不放图，把版面其余部分做完，并在最终回复里说明图片没能存下来。',
})

/**
 * 工具的返回值统一序列化成字符串。
 *
 * 和 `tools.ts` 里 `applyMutation` 的 `JSON.stringify` 保持一致 ——
 * 同一个 agent 在同一轮里看到两种返回风格，只会让它更难判断「这次到底成没成」。
 */
export const serializeAssetResult = (result: AssetToolResult): string => JSON.stringify(result)
