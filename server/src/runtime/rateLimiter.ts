/**
 * 滑动窗口限流 —— 域无关
 *
 * 为生图加的：实测 `gemini-3.1-flash-image` 连发第 4 张就
 * `429 Resource has been exhausted`。限流放在我们这边，是为了让「配额用完」
 * 变成一个**可预期、可回退**的结果，而不是等上游甩 429 才手忙脚乱。
 *
 * ## 为什么注入时钟
 *
 * 这个模块唯一有意思的行为全在**边界**上：第 60.000 秒该不该放行、
 * 被拒时算出来的 `retryAfterSec` 对不对。不注入时钟就只能 `sleep(60000)` 去等，
 * 那样的测试既慢又不稳，实际上等于没有判据。
 * 和 `objectStore.ts` 把 `now` 注入进签名是同一个理由：**为了让判据做得成**。
 *
 * ## 为什么是「滑动窗口」而不是「固定窗口」
 *
 * 固定窗口（每分钟清零）在窗口交界处会放两倍的量：第 59 秒发 3 张、
 * 第 61 秒又发 3 张，上游看到的是 2 秒内 6 张 —— 正好是它要防的那件事。
 * 滑动窗口只保留「此刻往前 60 秒」内的记录，不存在交界。
 *
 * ## 为什么在内存里，不落库
 *
 * 限流的目的是「别把上游打爆」，不是记账。进程重启后放宽一分钟毫无害处，
 * 而落库要给每次生图加一次写 —— 拿持久化换一个没人需要的保证。
 *
 * ## 超限时**不消耗名额**（这条最容易写错）
 *
 * `tryAcquire` 只在放行时才记时间戳。反过来写（先记再判）会让被拒的调用
 * 也把窗口填满 —— agent 每被拒一次就把恢复时间往后推一次，
 * 表现是**限流一旦触发就永远不恢复**，而日志里看起来一切正常。
 */

/** 窗口长度。配置项名字叫 `rate_limit_per_min`，所以这里就是一分钟 */
const WINDOW_MS = 60_000

export interface RateLimitDecision {
  allowed: boolean
  /**
   * 放行后本窗口还剩几次。不限流时是 `Infinity`。
   * 被拒时是 0 —— 它和 `allowed` 冗余，但让工具的返回值能直接带上这个数给 agent 看
   */
  remaining: number
  /**
   * 被拒时：最早的那次调用滑出窗口还要几秒。**最小 1**，不返回 0 ——
   * 返回 0 等于告诉 agent「立刻重试」，而它一定会再被拒。
   * 放行时为 0。
   */
  retryAfterSec: number
}

export interface RateLimiter {
  /**
   * 试着占一个名额。
   *
   * `limitPerMin` 为 `null` / 非正数 = 不限流。非正数走「不限」而不是「全禁」，
   * 理由和 `budget.ts` 处理非法环境变量一致：入口处 zod 已经限了 `positive()`，
   * 能走到这里的非正数只可能是脏数据，而**因为一个脏数据把生图彻底关掉**
   * 比放开更糟 —— 真想关有 `asset_sources.generate_enabled` 那个开关。
   */
  tryAcquire: (key: string, limitPerMin: number | null) => RateLimitDecision
  /** 某个键当前窗口内已占用的名额数。诊断与判据用 */
  used: (key: string) => number
  /**
   * 把一个键按死 `seconds` 秒，不管窗口里还剩多少名额。
   *
   * **给「上游明说配额用完了」用的**（HTTP 429）。实测撞到过：库里配 3 次/分钟，
   * 而中转实际只放 2 次。没有这个方法的话，本地限流器仍以为还有余额，
   * 于是每一次调用都要真打一次上游、真拿一次 429 才知道不行 ——
   * **上游告诉了我们它的答案，我们却每次都要再问一遍。**
   *
   * 和 `tryAcquire` 的窗口是两套：窗口是「我们自己承诺的节奏」，
   * 这个是「对方已经拒绝了」。两者取更严的那个。
   */
  block: (key: string, seconds: number) => void
  /** 清空全部记录。测试与「改了配置想立刻生效」时用 */
  reset: () => void
}

export const createRateLimiter = (now: () => number = Date.now): RateLimiter => {
  // key → 窗口内的调用时刻（升序，因为每次都是 push 当前时间）
  const hits = new Map<string, number[]>()
  // key → 被上游按死到什么时刻。见 `block`
  const blockedUntil = new Map<string, number>()

  /**
   * 剪掉滑出窗口的记录，返回还在窗口内的那些。
   *
   * 判定写成 `t > cutoff` 而不是 `>=`：`cutoff = now - 60000`，
   * 也就是「整整 60 秒前的那一次」**算滑出去了**，第 60.000 秒可以再发。
   * 这条就是注入时钟要测的那个边界。
   *
   * 顺带把空数组从 Map 里删掉 —— 不删的话，key 是 `model:<id>` 这种有限集合
   * 时无所谓，但将来若按用户或按 prompt 分键，这就是一条内存泄漏。
   */
  const live = (key: string): number[] => {
    const cutoff = now() - WINDOW_MS
    const kept = (hits.get(key) ?? []).filter(t => t > cutoff)
    if (kept.length) hits.set(key, kept)
    else hits.delete(key)
    return kept
  }

  return {
    tryAcquire(key, limitPerMin) {
      // 上游的拒绝**盖过**本地配额，也盖过「不限流」——
      // 对方说不行的时候，我们配了多宽都没有意义
      const until = blockedUntil.get(key)
      if (until !== undefined) {
        if (now() < until) {
          return {
            allowed: false,
            remaining: 0,
            retryAfterSec: Math.max(1, Math.ceil((until - now()) / 1000)),
          }
        }
        blockedUntil.delete(key)
      }

      if (limitPerMin === null || limitPerMin <= 0) {
        return { allowed: true, remaining: Infinity, retryAfterSec: 0 }
      }

      const kept = live(key)
      if (kept.length >= limitPerMin) {
        // 最早那次滑出窗口时，就腾出一个位置
        const freeAt = kept[0] + WINDOW_MS
        return {
          allowed: false,
          remaining: 0,
          retryAfterSec: Math.max(1, Math.ceil((freeAt - now()) / 1000)),
        }
      }

      // **只有放行才记**，见文件头注释
      kept.push(now())
      hits.set(key, kept)
      return { allowed: true, remaining: limitPerMin - kept.length, retryAfterSec: 0 }
    },

    used: key => live(key).length,

    block(key, seconds) {
      // 取更晚的那个：连续两次 429 不该把封锁时间缩短
      const until = now() + seconds * 1000
      blockedUntil.set(key, Math.max(until, blockedUntil.get(key) ?? 0))
    },

    reset() {
      hits.clear()
      blockedUntil.clear()
    },
  }
}

/**
 * 进程级的共享实例。
 *
 * 限流要在**所有任务之间**共享才有意义 —— 三个用户各跑一个任务、
 * 每人一个限流器，上游照样一分钟收 9 张。键里带 modelConfigId，
 * 不同模型各自计数（文本模型和生图模型的配额不是一个量级）。
 */
export const imageRateLimiter = createRateLimiter()

/** 限流键。按模型分 —— `rate_limit_per_min` 就是配在 `model_configs` 上的 */
export const modelRateKey = (modelConfigId: number): string => `model:${modelConfigId}`
