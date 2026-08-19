import { describe, it, expect } from 'vitest'
import { createRateLimiter, modelRateKey } from '../rateLimiter'

/**
 * 时钟注入的全部意义就在这个文件里：下面一半的断言是**边界**，
 * 不注入时钟就只能 `sleep(60000)` 去等，那样的测试既慢又不稳，等于没有判据。
 */
const at = (start = 0) => {
  let t = start
  return {
    now: () => t,
    set: (v: number) => {
      t = v
    },
    advance: (ms: number) => {
      t += ms
    },
  }
}

const KEY = 'model:18'

describe('rateLimiter · 不限流的档位', () => {
  it('limitPerMin 为 null 时永远放行，且 remaining 是 Infinity', () => {
    const clock = at()
    const rl = createRateLimiter(clock.now)
    for (let i = 0; i < 50; i++) {
      expect(rl.tryAcquire(KEY, null).allowed).toBe(true)
    }
    expect(rl.tryAcquire(KEY, null).remaining).toBe(Infinity)
  })

  it('不限流时不记账 —— used 保持 0，不会白占内存', () => {
    const rl = createRateLimiter(at().now)
    rl.tryAcquire(KEY, null)
    rl.tryAcquire(KEY, null)
    expect(rl.used(KEY)).toBe(0)
  })

  it('脏数据（0 / 负数）当「不限」而不是「全禁」', () => {
    // 入口 zod 限了 positive()，能走到这里的非正数只可能是脏数据。
    // 因为一个脏数据把生图彻底关掉，比放开更糟 —— 真想关有 generate_enabled
    const rl = createRateLimiter(at().now)
    expect(rl.tryAcquire(KEY, 0).allowed).toBe(true)
    expect(rl.tryAcquire(KEY, -5).allowed).toBe(true)
  })
})

describe('rateLimiter · 配额与拒绝', () => {
  it('放行到上限，之后被拒', () => {
    const rl = createRateLimiter(at().now)
    expect(rl.tryAcquire(KEY, 3).allowed).toBe(true)
    expect(rl.tryAcquire(KEY, 3).allowed).toBe(true)
    expect(rl.tryAcquire(KEY, 3).allowed).toBe(true)
    expect(rl.tryAcquire(KEY, 3).allowed).toBe(false)
  })

  it('remaining 逐次递减，拒绝时为 0', () => {
    const rl = createRateLimiter(at().now)
    expect(rl.tryAcquire(KEY, 3).remaining).toBe(2)
    expect(rl.tryAcquire(KEY, 3).remaining).toBe(1)
    expect(rl.tryAcquire(KEY, 3).remaining).toBe(0)
    expect(rl.tryAcquire(KEY, 3).remaining).toBe(0)
  })

  it('放行时 retryAfterSec 为 0', () => {
    const rl = createRateLimiter(at().now)
    expect(rl.tryAcquire(KEY, 3).retryAfterSec).toBe(0)
  })

  it('不同 key 各算各的 —— 生图被限流不能连坐搜图', () => {
    const rl = createRateLimiter(at().now)
    rl.tryAcquire(modelRateKey(18), 1)
    expect(rl.tryAcquire(modelRateKey(18), 1).allowed).toBe(false)
    expect(rl.tryAcquire(modelRateKey(25), 1).allowed).toBe(true)
  })
})

describe('rateLimiter · 超限不消耗名额', () => {
  /**
   * 这一组是整个文件里最要紧的。反过来写（先记时间戳再判断）也能通过
   * 上面所有断言，但会让**被拒的调用也把窗口填满** ——
   * agent 每被拒一次就把恢复时间往后推一次，表现是「限流一触发就永不恢复」，
   * 而日志里一切正常。
   */
  it('被拒 N 次之后，窗口滑出即恢复（拒绝没有被记账）', () => {
    const clock = at()
    const rl = createRateLimiter(clock.now)

    expect(rl.tryAcquire(KEY, 1).allowed).toBe(true) // t=0 占掉唯一的名额

    clock.set(1000)
    for (let i = 0; i < 5; i++) expect(rl.tryAcquire(KEY, 1).allowed).toBe(false)

    // t=0 那次在 t=60000 滑出。若刚才 5 次拒绝被记了账，
    // 此刻窗口里还留着 t=1000 的记录，这里就会是 false
    clock.set(60_000)
    expect(rl.tryAcquire(KEY, 1).allowed).toBe(true)
  })

  it('被拒不改变 used', () => {
    const clock = at()
    const rl = createRateLimiter(clock.now)
    rl.tryAcquire(KEY, 1)
    clock.set(1000)
    rl.tryAcquire(KEY, 1)
    rl.tryAcquire(KEY, 1)
    expect(rl.used(KEY)).toBe(1)
  })
})

describe('rateLimiter · 窗口边界', () => {
  it('第 59.999 秒仍被拒，第 60.000 秒放行', () => {
    const clock = at()
    const rl = createRateLimiter(clock.now)
    rl.tryAcquire(KEY, 1)

    clock.set(59_999)
    expect(rl.tryAcquire(KEY, 1).allowed).toBe(false)

    clock.set(60_000)
    expect(rl.tryAcquire(KEY, 1).allowed).toBe(true)
  })

  it('滑动而非固定窗口 —— 交界处不会放两倍的量', () => {
    // 固定窗口（每分钟清零）在这里会放行：第 59 秒 3 次、第 61 秒又 3 次。
    // 滑动窗口只看「此刻往前 60 秒」，所以第 61 秒时前 3 次还在窗口里
    const clock = at()
    const rl = createRateLimiter(clock.now)

    clock.set(59_000)
    for (let i = 0; i < 3; i++) expect(rl.tryAcquire(KEY, 3).allowed).toBe(true)

    clock.set(61_000)
    expect(rl.tryAcquire(KEY, 3).allowed).toBe(false)
  })

  it('used 随时间自然衰减', () => {
    const clock = at()
    const rl = createRateLimiter(clock.now)
    rl.tryAcquire(KEY, 5)
    clock.set(30_000)
    rl.tryAcquire(KEY, 5)
    expect(rl.used(KEY)).toBe(2)

    clock.set(60_001) // 第一次滑出，第二次还在
    expect(rl.used(KEY)).toBe(1)
  })
})

describe('rateLimiter · retryAfterSec', () => {
  /** 期望值独立算一遍：最早那次 + 60s - 此刻，向上取整。不从实现反推 */
  it('等于「最早一次滑出窗口还要几秒」', () => {
    const clock = at()
    const rl = createRateLimiter(clock.now)
    rl.tryAcquire(KEY, 1) // t=0

    clock.set(1000)
    expect(rl.tryAcquire(KEY, 1).retryAfterSec).toBe(59) // (60000-1000)/1000 = 59

    clock.set(30_500)
    expect(rl.tryAcquire(KEY, 1).retryAfterSec).toBe(30) // 29.5 → 向上取整 30
  })

  it('最小是 1，不返回 0 —— 返回 0 等于叫 agent 立刻重试，而它一定再被拒', () => {
    const clock = at()
    const rl = createRateLimiter(clock.now)
    rl.tryAcquire(KEY, 1)
    clock.set(59_999)
    expect(rl.tryAcquire(KEY, 1).retryAfterSec).toBe(1)
  })

  it('看的是最早那次，不是最近那次', () => {
    const clock = at()
    const rl = createRateLimiter(clock.now)
    rl.tryAcquire(KEY, 2) // t=0
    clock.set(10_000)
    rl.tryAcquire(KEY, 2) // t=10000

    clock.set(20_000)
    // 腾位置的是 t=0 那次（60000 - 20000 = 40s），不是 t=10000 那次（50s）
    expect(rl.tryAcquire(KEY, 2).retryAfterSec).toBe(40)
  })
})

describe('rateLimiter · block（上游明说配额用完了）', () => {
  /**
   * 实测撞到过：库里配 3 次/分钟，而中转实际只放 2 次，第 3 次直接 429。
   * 没有 block 的话本地限流器仍以为还有余额 ——
   * **上游给了答案，我们却每次都要再打一次才知道不行。**
   */
  it('按死之后，窗口里还有余额也照样拒绝', () => {
    const clock = at()
    const rl = createRateLimiter(clock.now)
    expect(rl.tryAcquire(KEY, 10).allowed).toBe(true) // 余额充足

    rl.block(KEY, 60)
    expect(rl.tryAcquire(KEY, 10).allowed).toBe(false)
  })

  it('连「不限流」也盖得住 —— 对方说不行时我们配多宽都没意义', () => {
    const rl = createRateLimiter(at().now)
    rl.block(KEY, 60)
    expect(rl.tryAcquire(KEY, null).allowed).toBe(false)
  })

  it('到点自动解除', () => {
    const clock = at()
    const rl = createRateLimiter(clock.now)
    rl.block(KEY, 60)

    clock.set(59_999)
    expect(rl.tryAcquire(KEY, 10).allowed).toBe(false)

    clock.set(60_000)
    expect(rl.tryAcquire(KEY, 10).allowed).toBe(true)
  })

  it('retryAfterSec 报的是「还要等多久解封」', () => {
    const clock = at()
    const rl = createRateLimiter(clock.now)
    rl.block(KEY, 60)

    clock.set(20_000)
    expect(rl.tryAcquire(KEY, 10).retryAfterSec).toBe(40)
  })

  it('连续两次 429 不会把封锁时间缩短', () => {
    const clock = at()
    const rl = createRateLimiter(clock.now)
    rl.block(KEY, 120)

    clock.set(10_000)
    rl.block(KEY, 5) // 更短的一次，不该覆盖掉更晚的解封时刻

    clock.set(20_000)
    expect(rl.tryAcquire(KEY, 10).allowed).toBe(false)
    expect(rl.tryAcquire(KEY, 10).retryAfterSec).toBe(100) // 120000 - 20000
  })

  it('只按死指定的键 —— 生图被上游拒了不该连坐别的模型', () => {
    const rl = createRateLimiter(at().now)
    rl.block(modelRateKey(18), 60)
    expect(rl.tryAcquire(modelRateKey(18), 10).allowed).toBe(false)
    expect(rl.tryAcquire(modelRateKey(19), 10).allowed).toBe(true)
  })

  it('被按死期间不消耗名额 —— 解封后配额是满的', () => {
    const clock = at()
    const rl = createRateLimiter(clock.now)
    rl.block(KEY, 60)
    for (let i = 0; i < 5; i++) rl.tryAcquire(KEY, 2)

    clock.set(60_000)
    expect(rl.tryAcquire(KEY, 2).allowed).toBe(true)
    expect(rl.tryAcquire(KEY, 2).allowed).toBe(true)
  })

  it('reset 一并清掉封锁', () => {
    const rl = createRateLimiter(at().now)
    rl.block(KEY, 60)
    rl.reset()
    expect(rl.tryAcquire(KEY, 1).allowed).toBe(true)
  })
})

describe('rateLimiter · 健壮性', () => {
  it('reset 清空全部记录', () => {
    const rl = createRateLimiter(at().now)
    rl.tryAcquire(KEY, 1)
    expect(rl.tryAcquire(KEY, 1).allowed).toBe(false)
    rl.reset()
    expect(rl.tryAcquire(KEY, 1).allowed).toBe(true)
  })

  it('时钟回拨不会崩，也不会错放', () => {
    // NTP 校时、容器迁移都可能让 Date.now() 往回跳。
    // 回拨只会让窗口显得更长（记录更晚滑出），偏保守，不会放行超额请求
    const clock = at(100_000)
    const rl = createRateLimiter(clock.now)
    rl.tryAcquire(KEY, 1)

    clock.set(50_000)
    expect(() => rl.tryAcquire(KEY, 1)).not.toThrow()
    expect(rl.tryAcquire(KEY, 1).allowed).toBe(false)
  })

  it('key 用完即从表里删掉，不留空数组', () => {
    const clock = at()
    const rl = createRateLimiter(clock.now)
    rl.tryAcquire(KEY, 1)
    clock.set(60_001)
    expect(rl.used(KEY)).toBe(0)
    // used() 自身会做剪枝，这里再取一次确认它是稳定的（不是「第一次调用才对」）
    expect(rl.used(KEY)).toBe(0)
  })

  it('modelRateKey 按模型分键', () => {
    expect(modelRateKey(18)).toBe('model:18')
    expect(modelRateKey(18)).not.toBe(modelRateKey(19))
  })
})
