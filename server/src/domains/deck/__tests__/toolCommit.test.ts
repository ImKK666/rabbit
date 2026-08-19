/**
 * 「工具改一次 → 库跟一次」的端到端判据
 *
 * 上面两个 runtime 判据分别验了闸门和提交器本身，这一组验的是**它们和真工具接在一起**
 * 之后那条不变量还成立：
 *
 * > 任何一次工具调用返回时，库里的状态 == 最后一条推给前端的状态。
 *
 * 这里用的是真的 `createAgentTools` 和真的 `createCommitter`，
 * 只把「库」和「前端」换成内存里的两个变量 ——
 * `pipeline.ts` 本身因为 `bun:sqlite` 在 vitest 里 import 不进来，
 * 但它在这条链路上只负责把两头接起来，接法就是下面 `makeHarness` 这几行。
 */

import { describe, it, expect } from 'vitest'
import type { SlideTheme } from '@/types/slides'
import { createCommitter } from '@server/runtime/commit'
import { createAgentTools, type DeckState } from '../tools'

const THEME: SlideTheme = {
  themeColors: ['#5b9bd5', '#ed7d31', '#a5a5a5', '#ffc000', '#4472c4', '#70ad47'],
  fontColor: '#333',
  fontName: '',
  backgroundColor: '#fff',
  shadow: { h: 3, v: 3, blur: 2, color: '#808080' },
  outline: { width: 2, color: '#525252', style: 'solid' },
}

/** 复刻 pipeline.ts 里 accessor + committer 的接法，库与前端换成内存变量 */
const makeHarness = () => {
  let state: DeckState = { slides: [], theme: THEME, version: 0 }
  const published: string[] = []
  let stored: string | null = null

  const committer = createCommitter<DeckState>({
    persist: (next) => {
      stored = JSON.stringify(next.slides)
    },
    publish: (next) => {
      published.push(JSON.stringify(next.slides))
    },
  })

  const tools = createAgentTools({
    get: () => state,
    set: (next) => {
      state = next
    },
    onChange: () => committer.commit(state),
  })

  return {
    tools,
    committer,
    published,
    stored: () => stored,
    state: () => state,
    /** 那条不变量 */
    consistent: () => stored === (published.at(-1) ?? null),
  }
}

/** 工具的第二个参数是 SDK 的执行上下文，我们的工具一个都不用 */
const CTX = {} as never
const run = (fn: unknown, args: unknown) =>
  (fn as (a: unknown, c: never) => Promise<string>)(args, CTX)

describe('每一次工具调用之后，库与画布都一致', () => {
  it('addSlide → applyLayout → updateElement 全程不变量成立', async () => {
    const h = makeHarness()

    await run(h.tools.addSlide.execute, { slide: { id: 's1', elements: [] } })
    expect(h.consistent()).toBe(true)
    expect(h.committer.committed()).toBe(1)

    await run(h.tools.applyLayout.execute, {
      slideId: 's1',
      pattern: 'title-center',
      content: { title: '季度回顾', subtitle: '2026 Q3' },
    })
    expect(h.consistent()).toBe(true)

    const el = h.state().slides[0].elements[0]
    await run(h.tools.updateElement.execute, { elementId: el.id, props: { width: 400 } })
    expect(h.consistent()).toBe(true)

    // 每一步都提交过，不是最后才写一次
    expect(h.committer.committed()).toBe(3)
    expect(h.published).toHaveLength(3)
  })

  it('中途「停电」：第 N 次调用之后库里就是第 N 次的状态', async () => {
    const h = makeHarness()

    await run(h.tools.addSlide.execute, { slide: { id: 's1', elements: [] } })
    await run(h.tools.applyLayout.execute, {
      slideId: 's1', pattern: 'bullets',
      content: { title: '三件事', items: [{ title: '一' }, { title: '二' }, { title: '三' }] },
    })
    await run(h.tools.addSlide.execute, { slide: { id: 's2', elements: [] } })

    // ——— 进程在这里被 kill ———
    const recovered = JSON.parse(h.stored()!)
    expect(recovered).toHaveLength(2)
    expect(recovered[0].elements.length).toBeGreaterThan(0) // 版式排的那页确实存下来了
    expect(h.stored()).toBe(h.published.at(-1))
  })

  it('setTheme 也走提交（它不经 applyMutation，是另一条路）', async () => {
    const h = makeHarness()
    await run(h.tools.addSlide.execute, { slide: { id: 's1', elements: [] } })
    const before = h.committer.committed()

    await run(h.tools.setTheme.execute, { props: { backgroundColor: '#101010' } })

    // setTheme 里的 onChange 是手写的第二处，漏加 await 时这条会红
    expect(h.committer.committed()).toBe(before + 1)
    expect(h.consistent()).toBe(true)
  })

  it('只读工具不提交', async () => {
    const h = makeHarness()
    await run(h.tools.addSlide.execute, { slide: { id: 's1', elements: [] } })
    const before = h.committer.committed()

    await run(h.tools.getDeck.execute, {})
    await run(h.tools.getSlide.execute, { slideId: 's1' })
    await run(h.tools.lintDeck.execute, {})

    expect(h.committer.committed()).toBe(before)
  })

  it('被 kernel 拒绝的修改不提交 —— 库里不留废状态', async () => {
    const h = makeHarness()
    await run(h.tools.addSlide.execute, { slide: { id: 's1', elements: [] } })
    const before = h.committer.committed()
    const snapshot = h.stored()

    const out = await run(h.tools.updateElement.execute, {
      elementId: '并不存在的元素', props: { width: 100 },
    })

    expect(JSON.parse(out).ok).toBe(false)
    expect(h.committer.committed()).toBe(before)
    expect(h.stored()).toBe(snapshot)
  })
})

describe('工具必须等写入落地才返回', () => {
  it('落库没完成之前，工具不会回 ok:true', async () => {
    let state: DeckState = { slides: [], theme: THEME, version: 0 }
    let resolvePersist!: () => void
    const persistGate = new Promise<void>((res) => {
      resolvePersist = res
    })
    let persisted = false

    const committer = createCommitter<DeckState>({
      persist: async () => {
        await persistGate; persisted = true
      },
      publish: () => {},
    })
    const tools = createAgentTools({
      get: () => state,
      set: (next) => {
        state = next
      },
      onChange: () => committer.commit(state),
    })

    let returned = false
    const call = run(tools.addSlide.execute, { slide: { id: 's1', elements: [] } })
      .then((out) => {
        returned = true; return out
      })

    // 写入还卡着，工具就不该已经返回 —— 否则 agent 拿到「改好了」时
    // 那次写入其实还在飞，失败了也没人知道。
    //
    // **必须排干微任务再断言**：第一版这里写的是 `await Promise.resolve()`，
    // 只推进一个 tick，于是「没 await onChange」的版本也来得及显示成「还没返回」——
    // 判据在两版上都是绿的。挂负对照才发现，用 setTimeout 落到宏任务才分得开
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(returned).toBe(false)
    expect(persisted).toBe(false)

    resolvePersist()
    const out = await call
    expect(returned).toBe(true)
    expect(persisted).toBe(true)
    expect(JSON.parse(out).ok).toBe(true)
  })

  it('负对照：onChange 不被 await 时，工具在写入落地前就返回了', async () => {
    let state: DeckState = { slides: [], theme: THEME, version: 0 }
    let resolvePersist!: () => void
    const persistGate = new Promise<void>((res) => {
      resolvePersist = res
    })
    let persisted = false

    const committer = createCommitter<DeckState>({
      persist: async () => {
        await persistGate; persisted = true
      },
      publish: () => {},
    })
    // 改动前的形状：onChange 是同步的 void，applyMutation 不等它
    const fireAndForget = () => {
      void committer.commit(state)
    }
    const tools = createAgentTools({
      get: () => state,
      set: (next) => {
        state = next
      },
      onChange: fireAndForget,
    })

    const out = JSON.parse(await run(tools.addSlide.execute, { slide: { id: 's1', elements: [] } }))

    // 工具已经告诉 agent「改好了」，而库里什么都还没有
    expect(out.ok).toBe(true)
    expect(persisted).toBe(false)

    resolvePersist()
    await committer.drain()
    expect(persisted).toBe(true)
  })
})
