/**
 * 搜图请求缓存 —— 24 小时，图库的硬性要求
 *
 * Pixabay 文档原文：「requests must be cached for 24 hours … do not send lots of
 * automated queries」。`imageSearch.ts` 头注释把它列为三条合规要求之一，
 * 第十七轮记的是「搜索请求本身还没有缓存，接工具时要补」——这里就是补。
 *
 * ## 为什么只有纯函数，读写留给调用方
 *
 * 缓存要落库（进程重启后仍然算数，否则重启一次就等于没缓存过），
 * 而 `db/index.ts` 拉的是 `bun:sqlite`，**vitest 里 import 不进来**。
 * 写在这里等于没有判据 —— 和 `events.ts` / `channel.ts` 被拆出来是同一个原因。
 *
 * 所以这个文件只装两件**会写错**的事：键怎么算、什么时候算过期。
 * 真正的 SELECT / INSERT 在 `domains/deck/assetTools.ts` 里，它本来就碰库。
 *
 * ## 缓存「候选列表」而不是「原始响应体」
 *
 * 合规要求的字面意思是缓存 request。我们缓存的是解析后的 `ImageCandidate[]`，
 * 两者对图库而言**完全等价** —— 命中缓存时我们一个字节都不会发给对方，
 * 而这正是那条要求想达到的效果。存解析后的形状省地方，也省掉「缓存里躺着
 * 一份四家格式各异的原始 JSON」这种将来必然咬人的东西。
 *
 * ## 失败不进缓存
 *
 * 只缓存成功的响应。把一次网络抖动缓存 24 小时，等于**一次超时让搜图瘫一天** ——
 * 而搜图恰恰是生图被限流时的那条退路（见 rateLimiter.ts），它不能这么脆。
 *
 * **空结果算成功，要缓存**：「这个词确实搜不到图」是一个有效答案，
 * 不缓存的话每次都要再问一遍图库，正是那条要求要防的事。
 */

import crypto from 'node:crypto'
import type { AssetSearchProvider } from '@server/db/schema'
import type { ImageCandidate } from './imageSearch'

/** 24 小时。图库文档写死的数字，不做成配置 —— 它不是我们能商量的 */
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000

export interface SearchCacheKeyInput {
  provider: AssetSearchProvider
  query: string
  lang: string
  limit: number
}

/**
 * 归一化查询词。
 *
 * 大小写、首尾空格、词间多余空白都不该产生两条缓存 ——
 * 它们发给图库的是同一个请求，缓存却当成两次，等于漏掉一半的命中。
 *
 * `toLowerCase` 对中文是空操作，无害；`\s+` 折叠对中日韩同样安全
 * （那些语言词间本来就没有空格，折叠不到东西）。
 */
export const normalizeQuery = (query: string): string =>
  query.trim().replace(/\s+/g, ' ').toLowerCase()

/**
 * 缓存键。
 *
 * 四个维度都进键，因为它们**各自都会改变发给图库的那个请求**：
 * 换图库、换词、换语言、换条数，拿到的结果都不一样。
 * 少一个维度的表现是「缓存串台」——搜 3 张的结果被当成搜 12 张的答案返回。
 *
 * 拼接用 `JSON.stringify` 而不是模板字符串，是为了**分隔无歧义**：
 * 查询词里本来就可能有空格，用空格当分隔符，理论上能让不同的四元组撞成同一个键。
 * 数组序列化把边界写进了字面量里，撞不了。
 *
 * （第一版用模板字符串，而落到磁盘上的分隔符是三个**不可见的 NUL 字节** ——
 * 功能上碰巧比空格更安全，但源码里藏控制字符是另一回事：看不见、grep 不到、
 * 有的工具会把整个文件当二进制。是负对照那条「模式没匹配上」的告警把它翻出来的。）
 */
export const searchCacheKey = ({ provider, query, lang, limit }: SearchCacheKeyInput): string =>
  crypto.createHash('sha256')
    .update(JSON.stringify([provider, normalizeQuery(query), lang, limit]))
    .digest('hex')

/**
 * 这条缓存还新鲜吗。
 *
 * `age < TTL` 用严格小于：整整 24 小时那一刻算过期。图库要求的是「缓存 24 小时」，
 * 边界上宁可多发一次请求，也不要多用一秒。
 *
 * **时钟回拨（age 为负）也算新鲜**：那说明这条是「未来写的」，
 * 只可能来自机器校时，把它判成过期只会平白多打一次图库。
 */
export const isFresh = (fetchedAtMs: number, nowMs: number): boolean =>
  nowMs - fetchedAtMs < CACHE_TTL_MS

export interface CachedSearch {
  candidates: ImageCandidate[]
  fetchedAtMs: number
}

/**
 * 缓存条目 → 可用的候选列表；过期或空则返回 null（调用方据此决定要不要真的去搜）。
 *
 * 单独一个函数而不是让调用方写 `if (row && isFresh(...))`：
 * 这样「过期判定」只有一处，而且它测得到。
 */
export const readCache = (
  entry: CachedSearch | null | undefined,
  nowMs: number,
): ImageCandidate[] | null => {
  if (!entry) return null
  return isFresh(entry.fetchedAtMs, nowMs) ? entry.candidates : null
}
