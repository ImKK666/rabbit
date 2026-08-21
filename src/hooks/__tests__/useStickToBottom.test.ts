import { describe, it, expect } from 'vitest'
import { effectScope, nextTick, ref, type Ref } from 'vue'
import { useStickToBottom } from '../useStickToBottom'

/**
 * 用假元素测，不装 jsdom。
 *
 * 这个 composable 只碰四样东西：`scrollTop` / `scrollHeight` / `clientHeight`
 * 和一对 add/removeEventListener。真实 DOM 对判据没有额外贡献 ——
 * 要判的是**「什么时候该滚、什么时候不该」**，那是纯逻辑。
 *
 * 滚动条在浏览器里长什么样是另一回事，那一半只能眼看（见 docs/04）。
 */
const fakeEl = ({ scrollHeight = 1000, clientHeight = 200 } = {}) => {
  const listeners: Record<string, (() => void) | undefined> = {}
  return {
    scrollTop: 0,
    scrollHeight,
    clientHeight,
    addEventListener(type: string, fn: () => void) {
      listeners[type] = fn
    },
    removeEventListener(type: string) {
      delete listeners[type]
    },
    /** 模拟用户滚动：先改 scrollTop 再派发事件，和浏览器顺序一致 */
    scrollTo(top: number) {
      this.scrollTop = top
      listeners.scroll?.()
    },
    hasListener: () => !!listeners.scroll,
  }
}

type FakeEl = ReturnType<typeof fakeEl>

/** 装一次 composable，返回控制句柄。`flush` 要两拍：watch 一拍、内部 nextTick 一拍 */
const mount = (el: FakeEl | undefined, opts: { deep?: boolean } = {}) => {
  const elRef = ref(el) as unknown as Ref<HTMLElement | undefined>
  const source = ref(0)
  const scope = effectScope()
  let api!: ReturnType<typeof useStickToBottom>
  scope.run(() => {
    api = useStickToBottom(elRef, source, opts)
  })
  return {
    elRef: elRef as unknown as Ref<FakeEl | undefined>,
    grow: () => {
      source.value++
    },
    flush: async () => {
      await nextTick()
      await nextTick()
    },
    stop: () => scope.stop(),
    ...api,
  }
}

/** 底部位置 = scrollHeight - clientHeight（浏览器能滚到的最大 scrollTop） */
const BOTTOM = 1000 - 200

describe('useStickToBottom · 默认贴底跟随', () => {
  it('内容变化时滚到底', async () => {
    const el = fakeEl()
    const h = mount(el)
    await h.flush()

    el.scrollTop = 0 // 假装被别的东西挪走了，但没派发 scroll，所以 pinned 不变
    h.grow()
    await h.flush()
    expect(el.scrollTop).toBe(el.scrollHeight)
  })

  it('元素一挂上就装了 scroll 监听', async () => {
    const el = fakeEl()
    mount(el)
    await nextTick()
    expect(el.hasListener()).toBe(true)
  })
})

describe('useStickToBottom · 用户滚上去之后别再拽他', () => {
  /**
   * 这一组就是「一滚就回弹」那个 bug 的复现脚本。
   * 原来那行无条件的 `scrollTop = scrollHeight` 在这里必然红。
   */
  it('用户滚到顶部后，内容再变也不滚', async () => {
    const el = fakeEl()
    const h = mount(el)
    await h.flush()

    el.scrollTo(0) // 用户滚到最上面
    h.grow()
    await h.flush()
    expect(el.scrollTop).toBe(0)
  })

  it('连着来十次内容变化也一直不动', async () => {
    const el = fakeEl()
    const h = mount(el)
    await h.flush()
    el.scrollTo(120)

    for (let i = 0; i < 10; i++) {
      h.grow()
      await h.flush()
    }
    expect(el.scrollTop).toBe(120)
  })

  it('滚回底部就恢复跟随', async () => {
    const el = fakeEl()
    const h = mount(el)
    await h.flush()

    el.scrollTo(0)
    h.grow()
    await h.flush()
    expect(el.scrollTop).toBe(0)

    el.scrollTo(BOTTOM) // 用户自己滚回底部
    h.grow()
    await h.flush()
    expect(el.scrollTop).toBe(el.scrollHeight)
  })
})

describe('useStickToBottom · 贴底阈值', () => {
  /**
   * 阈值不能是 0：行高凑整、亚像素、滚动条零头都会留下一两个像素，
   * 判严了的表现是**跟随只生效一次然后再也不动**。
   */
  it('距底 32px 仍算贴着底', async () => {
    const el = fakeEl()
    const h = mount(el)
    await h.flush()

    el.scrollTo(BOTTOM - 32)
    h.grow()
    await h.flush()
    expect(el.scrollTop).toBe(el.scrollHeight)
  })

  it('距底 33px 就算用户滚开了', async () => {
    const el = fakeEl()
    const h = mount(el)
    await h.flush()

    el.scrollTo(BOTTOM - 33)
    h.grow()
    await h.flush()
    expect(el.scrollTop).toBe(BOTTOM - 33)
  })
})

describe('useStickToBottom · 元素会反复挂载卸载（思考块收起再展开）', () => {
  it('元素还不存在时不炸', async () => {
    const h = mount(undefined)
    h.grow()
    await expect(h.flush()).resolves.toBeUndefined()
  })

  it('元素后来才出现 → 立刻贴底', async () => {
    const h = mount(undefined)
    const el = fakeEl()
    h.elRef.value = el
    await h.flush()
    expect(el.scrollTop).toBe(el.scrollHeight)
  })

  it('重新展开时重新贴底 —— 哪怕上次是滚上去了收起来的', async () => {
    // 展开一个正在流的思考块，想看的是最新那几行，不是它十分钟前的开头
    const first = fakeEl()
    const h = mount(first)
    await h.flush()
    first.scrollTo(0) // 用户滚上去看
    h.elRef.value = undefined // 收起
    await h.flush()

    const second = fakeEl()
    h.elRef.value = second // 再展开（v-if 会造一个新元素）
    await h.flush()
    expect(second.scrollTop).toBe(second.scrollHeight)
  })

  it('元素换掉时，旧元素上的监听要摘干净', async () => {
    const first = fakeEl()
    const h = mount(first)
    await h.flush()
    expect(first.hasListener()).toBe(true)

    const second = fakeEl()
    h.elRef.value = second
    await h.flush()
    expect(first.hasListener()).toBe(false)
    expect(second.hasListener()).toBe(true)
  })

  it('scope 结束时摘掉监听 —— 面板关掉不留悬空引用', async () => {
    const el = fakeEl()
    const h = mount(el)
    await h.flush()
    h.stop()
    expect(el.hasListener()).toBe(false)
  })
})

describe('useStickToBottom · stickNow', () => {
  it('强制贴回底部，且此后恢复跟随', async () => {
    const el = fakeEl()
    const h = mount(el)
    await h.flush()
    el.scrollTo(0)

    h.stickNow()
    await h.flush()
    expect(el.scrollTop).toBe(el.scrollHeight)

    el.scrollTop = 0 // 不派发 scroll，pinned 应该还是 true
    h.grow()
    await h.flush()
    expect(el.scrollTop).toBe(el.scrollHeight)
  })
})

describe('useStickToBottom · deep 源', () => {
  it('深层变化也能触发跟随 —— reasoning 是往已有条目里追加正文', async () => {
    // 不开 deep 的话日志数组长度没变，watch 不会触发，
    // 表现就是「思考流一直在长，面板却不动」
    const el = fakeEl()
    const elRef = ref(el) as unknown as Ref<HTMLElement | undefined>
    const log = ref([{ content: 'a' }])
    const scope = effectScope()
    scope.run(() => useStickToBottom(elRef, log, { deep: true }))
    await nextTick()
    await nextTick()

    el.scrollTop = 0
    log.value[0].content += 'bcd'
    await nextTick()
    await nextTick()
    expect(el.scrollTop).toBe(el.scrollHeight)
    scope.stop()
  })
})
