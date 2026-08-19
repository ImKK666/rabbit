/**
 * 状态提交的判据
 *
 * 守的不变量只有一条，但它是这一轮的全部意义：
 * **任何时刻，持久层里的状态 == 最后一条推给前端的状态。**
 *
 * 「写库」和「推画布」以前是两件独立的事，中途失败就会错开（画布有、库里没有，
 * 刷新即丢）。这里验的是它们现在合成了一次操作，且在
 * 失败、并发、中途 kill 三种情况下都不会错开。
 *
 * 三组负对照都挂在「拆开的旧实现」上，确认判据真的分得出两版。
 */

import { describe, it, expect, vi } from 'vitest'
import { createCommitter } from '../commit'

/** 手动控制何时 resolve 的 promise —— 用它排并发顺序，比 setTimeout 确定 */
const deferred = () => {
  let resolve!: () => void
  let reject!: (err: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res; reject = rej
  })
  return { promise, resolve, reject }
}

/** 一个假的持久层 + 假的前端，用来断言那条不变量 */
const setup = () => {
  const published: string[] = []
  const persisted: string[] = []
  let stored: string | null = null

  const committer = createCommitter<string>({
    persist: (state) => {
      persisted.push(state)
      stored = state
    },
    publish: (state) => {
      published.push(state)
    },
  })

  return {
    committer,
    published,
    persisted,
    /** 不变量：库里 == 最后一条推出去的 */
    consistent: () => stored === (published.at(-1) ?? null),
    stored: () => stored,
  }
}

describe('顺序是契约', () => {
  it('先落库，再推画布', async () => {
    const order: string[] = []
    const committer = createCommitter<string>({
      persist: () => {
        order.push('persist')
      },
      publish: () => {
        order.push('publish')
      },
    })

    await committer.commit('a')
    expect(order).toEqual(['persist', 'publish'])
  })

  it('写库失败 → 不推画布，两边仍然一致', async () => {
    const published: string[] = []
    const committer = createCommitter<string>({
      persist: () => {
        throw new Error('磁盘满了')
      },
      publish: (s) => {
        published.push(s)
      },
    })

    await expect(committer.commit('a')).rejects.toThrow('磁盘满了')
    // 关键：库没写成，画布也没动。反过来的顺序会留下「画布变了、库没变」
    expect(published).toEqual([])
  })

  it('写库失败要抛给调用方，不能吞', async () => {
    const committer = createCommitter<string>({
      persist: () => {
        throw new Error('写不进去')
      },
      publish: () => {},
    })

    // 吞掉的话，工具会回一句 { ok: true } 告诉 agent 改好了，
    // 它就不会重试 —— 这条修改从此谁也不知道丢了
    await expect(committer.commit('a')).rejects.toThrow('写不进去')
  })

  it('一次失败不会毒死整条链 —— 后续提交照常', async () => {
    const published: string[] = []
    let failNext = true
    const committer = createCommitter<string>({
      persist: () => {
        if (failNext) {
          failNext = false; throw new Error('瞬时故障')
        }
      },
      publish: (s) => {
        published.push(s)
      },
    })

    await expect(committer.commit('a')).rejects.toThrow('瞬时故障')
    await committer.commit('b')
    await committer.commit('c')

    expect(published).toEqual(['b', 'c'])
    expect(committer.committed()).toBe(2)
  })
})

describe('并发提交', () => {
  it('模型一步发多个工具调用时，落库顺序 = 调用顺序', async () => {
    const gates = { a: deferred(), b: deferred() }
    const persisted: string[] = []
    const published: string[] = []
    let stored = ''

    const committer = createCommitter<'a' | 'b'>({
      persist: async (s) => {
        await gates[s].promise
        persisted.push(s)
        stored = s
      },
      publish: (s) => {
        published.push(s)
      },
    })

    const p1 = committer.commit('a')
    const p2 = committer.commit('b')

    // 先放行 b。串行化生效的话，persist('b') 此刻**根本还没开始**，
    // 所以这一下什么都不会发生
    gates.b.resolve()
    await Promise.resolve()
    expect(persisted).toEqual([])

    gates.a.resolve()
    await Promise.all([p1, p2])

    expect(persisted).toEqual(['a', 'b'])
    expect(published).toEqual(['a', 'b'])
    expect(stored).toBe('b')
    expect(stored).toBe(published.at(-1))
  })

  it('负对照：不排队的实现会让库停在 a、画布停在 b', async () => {
    const gates = { a: deferred(), b: deferred() }
    const published: string[] = []
    let stored = ''

    // 拆开的旧形状：各推各的、各写各的，谁先写完谁说了算
    const naiveCommit = async (s: 'a' | 'b') => {
      published.push(s)
      await gates[s].promise
      stored = s
    }

    const p1 = naiveCommit('a')
    const p2 = naiveCommit('b')

    // b 的写入先完成，a 的后完成 —— 于是最终库里是 a，而画布上是 b
    gates.b.resolve()
    await p2
    gates.a.resolve()
    await p1

    expect(published.at(-1)).toBe('b')
    expect(stored).toBe('a')
    expect(stored).not.toBe(published.at(-1)) // ← 不变量被打破，这正是判据要抓的
  })
})

describe('中途 kill', () => {
  it('提交 N 次后停，库里恰好是第 N 次的状态', async () => {
    const ctx = setup()

    for (let i = 1; i <= 7; i++) await ctx.committer.commit(`v${i}`)

    // 「进程在这里被 kill」—— 此后不再有任何提交
    expect(ctx.stored()).toBe('v7')
    expect(ctx.published.at(-1)).toBe('v7')
    expect(ctx.consistent()).toBe(true)
    expect(ctx.committer.committed()).toBe(7)
  })

  it('每一步之后不变量都成立，不是只有最后一步', async () => {
    const ctx = setup()
    for (let i = 1; i <= 5; i++) {
      await ctx.committer.commit(`v${i}`)
      expect(ctx.consistent()).toBe(true)
    }
  })

  it('负对照：收尾才落库的旧实现，中途 kill 时库里是空的', () => {
    const published: string[] = []
    let stored: string | null = null

    // HEAD 的形状：每步推画布，saveDeckState 只在剧本最后调一次
    const oldStyleMutate = (s: string) => {
      published.push(s)
    }
    const oldStyleSaveAtEnd = (s: string) => {
      stored = s
    }

    for (let i = 1; i <= 7; i++) oldStyleMutate(`v${i}`)
    // 「进程在这里被 kill」—— oldStyleSaveAtEnd 从来没被调到
    expect(published.at(-1)).toBe('v7')
    expect(stored).toBeNull() // ← 画布上 7 步改动，库里什么都没有。刷新即丢
    void oldStyleSaveAtEnd
  })
})

describe('drain', () => {
  it('等到所有排队的提交都落地', async () => {
    const gate = deferred()
    const persisted: string[] = []
    const committer = createCommitter<string>({
      persist: async (s) => {
        await gate.promise; persisted.push(s)
      },
      publish: () => {},
    })

    void committer.commit('a')
    void committer.commit('b')
    expect(persisted).toEqual([])

    gate.resolve()
    await committer.drain()
    expect(persisted).toEqual(['a', 'b'])
  })

  it('即使有提交失败过也不 reject —— 收尾的职责只是「等干净」', async () => {
    const committer = createCommitter<string>({
      persist: () => {
        throw new Error('炸了')
      },
      publish: () => {},
    })

    void committer.commit('a').catch(() => {})
    await expect(committer.drain()).resolves.toBeUndefined()
  })

  it('没有任何提交时也能直接返回', async () => {
    const committer = createCommitter<string>({ persist: () => {}, publish: () => {} })
    await expect(committer.drain()).resolves.toBeUndefined()
  })
})

describe('计数', () => {
  it('只数成功的那些', async () => {
    let ok = false
    const committer = createCommitter<string>({
      persist: () => {
        if (!ok) throw new Error('x')
      },
      publish: () => {},
    })

    await committer.commit('a').catch(() => {})
    expect(committer.committed()).toBe(0)

    ok = true
    await committer.commit('b')
    expect(committer.committed()).toBe(1)
  })

  it('publish 抛错时不计成功', async () => {
    const committer = createCommitter<string>({
      persist: () => {},
      publish: () => {
        throw new Error('socket 断了')
      },
    })
    await expect(committer.commit('a')).rejects.toThrow('socket 断了')
    expect(committer.committed()).toBe(0)
  })
})

describe('persist 只收状态，不关心它是什么', () => {
  it('域无关：状态是什么类型由调用方定', async () => {
    const persist = vi.fn(async () => {})
    const committer = createCommitter<{ slides: number[], version: number }>({
      persist,
      publish: () => {},
    })
    await committer.commit({ slides: [1, 2], version: 3 })
    expect(persist).toHaveBeenCalledWith({ slides: [1, 2], version: 3 })
  })
})
