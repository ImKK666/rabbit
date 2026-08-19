/**
 * 「贴底跟随」—— 内容增长时自动滚到底，**但用户滚上去之后就别再拽他**
 *
 * ## 为什么要有这个
 *
 * AgentPanel 原来只有一行：
 *
 * ```js
 * watch(log, () => { nextTick(() => { body.scrollTop = body.scrollHeight }) }, { deep: true })
 * ```
 *
 * **无条件**，每次日志变化都执行。而 `agent.reasoning` 的增量是几个字符一条、
 * 每秒几十条 —— 用户往上滚，滚轮确实生效了（内容动了一下），
 * 然后 `nextTick` 里那行把它按回去。看到的就是「一滚就回弹」。
 *
 * 而思考块自己（`.reasoning-body`，有 `max-height` + `overflow-y: auto`）
 * **从来没人碰过它的 scrollTop**，所以流式输出跑到可视区外面也不会跟。
 * 两个毛病是同一个根因的两半：**整个面板没有「用户现在在不在底部」这个概念。**
 *
 * ## 契约
 *
 * `pinned` **只在容器自己的 `scroll` 事件里更新**，内容变化时只读不写。
 *
 * 这个顺序不能反。要是在内容变化时重新测量，那么「内容变长了、用户没动」
 * 会被算成「用户滚开了」（因为距底距离确实变大了），于是跟随会在第一次
 * 增长后就永久失效 —— 而且失效得悄无声息。
 *
 * ## 每个容器一份，互不干扰
 *
 * `scroll` 事件**不冒泡**，所以外层面板和每个思考块各调一次、各自持有
 * 自己的 `pinned`，天然就是「小块是小块、外面是外面」，不需要额外协调。
 */

import { nextTick, onScopeDispose, watch, type Ref, type WatchSource } from 'vue'

/**
 * 距底多少像素之内仍算「贴着底」。
 *
 * 不能用 0：行高凑整、亚像素、滚动条本身都会留下一两个像素的零头，
 * 判严了的表现是**跟随只生效一次然后再也不动**，而那比不跟随更难查。
 */
const NEAR_BOTTOM_PX = 32

export interface StickToBottomOptions {
  /** 源是深层可变对象（如整个日志数组）时要开 */
  deep?: boolean
}

export const useStickToBottom = (
  elRef: Ref<HTMLElement | undefined | null>,
  source: WatchSource,
  { deep = false }: StickToBottomOptions = {},
) => {
  // 初始就当贴底：面板刚打开时本来就在底部
  let pinned = true

  const measure = () => {
    const el = elRef.value
    if (!el) return
    pinned = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX
  }

  const toBottom = () => {
    const el = elRef.value
    if (el) el.scrollTop = el.scrollHeight
  }

  /**
   * 容器会被 `v-if` 反复挂载 / 卸载（思考块收起再展开），
   * 所以监听器要跟着元素走，不能在 onMounted 里挂一次了事。
   */
  watch(elRef, (el, prev) => {
    prev?.removeEventListener('scroll', measure)
    if (!el) return
    el.addEventListener('scroll', measure, { passive: true })
    // 重新出现时先贴底 —— 展开一个正在流的思考块，想看的是最新那几行，
    // 而不是它十分钟前的开头
    pinned = true
    nextTick(toBottom)
  }, { immediate: true })

  watch(source, () => {
    if (!pinned) return
    nextTick(toBottom)
  }, { deep })

  // 用 `onScopeDispose` 而不是 `onBeforeUnmount`：组件的 setup 本来就是一个
  // effect scope，两者在组件里等价 —— 但前者在**任何** scope 里都成立，
  // 于是这个 composable 脱离组件也能用、也能测（项目里没装 @vue/test-utils）
  onScopeDispose(() => {
    elRef.value?.removeEventListener('scroll', measure)
  })

  /** 强制贴回底部（发消息之后这类「我明确要看最新的」场景） */
  const stickNow = () => {
    pinned = true
    nextTick(toBottom)
  }

  return { stickNow }
}
