/**
 * 离屏渲染 + 量真实文本高度
 *
 * 后端问、这里答。协议见 `services/websocket.ts` 的 `agent.render.request`。
 *
 * ## 为什么这件事必须在浏览器里做
 *
 * 服务端的 `estimateTextHeight` 是**估**的：按 CJK 全宽算字数、除以框宽得行数。
 * 版式引擎拿这个估值往下累加 `y`，估小了下一个元素就压上来。
 * 而服务端现有的几何检查一条都看不见这件事：
 *   - 「超出画布」永不响 —— `Builder.text()` 把框高夹进了画布
 *   - 「文本重叠」比的是**声明的框**，而溢出发生在框外面（PPTist 不裁剪文本）
 *
 * 实测 66 张样张 `lintDeck` **0 告警**，其中好几张肉眼能看到压字
 *（`scripts/measure-layout-text.mjs` 头注释）。
 *
 * **能量的只有浏览器。** 服务端要么装 chromium（一大笔部署面），
 * 要么自己写一个字体排版引擎（等于再造一个浏览器）。
 * 而这台浏览器本来就在 —— 用户就是在这儿看这份稿子的。
 *
 * ## 量法必须和那个脚本一模一样
 *
 * `declared = 元素的 style.height`，`actual = .text 节点的 offsetHeight`，容差 4px。
 * 两处不一致的话会出现「工具说没事、脚本说有事」，而那时没人知道该信哪个 ——
 * docs/13 的判据 R3 就是拿这两条路对一次。
 *
 * `offsetHeight` **不受祖先 CSS transform 影响**，所以缩放不用换算。
 *
 * ## 为什么离屏而不是量画布上现成的那些
 *
 * 编辑器只渲染当前那一页，缩略图列表还有懒加载（`index < slidesLoadLimit`）。
 * 要量的是**整份稿子**，只能自己渲一遍。用的是 `ThumbnailSlide` ——
 * 编辑器左侧缩略图同一个组件，它内部 dispatch 到真实的 BaseTextElement，
 * **这里没有任何一行是「怎么排」或「怎么画」的第二实现**。
 */

import { createApp, h, nextTick, type App } from 'vue'
import { getActivePinia } from 'pinia'
import ThumbnailSlide from '@/views/components/ThumbnailSlide/index.vue'
import { useSlidesStore } from '@/store'
import type { Slide } from '@/types/slides'

export interface TextMeasurement {
  slideId: string
  elementId: string
  actualHeight: number
}

export interface SlideShot {
  slideId: string
  /** `data:image/png;base64,...` */
  dataUrl: string
}

export interface MeasureOutcome {
  measurements: TextMeasurement[]
  shots?: SlideShot[]
  error?: string
}

/**
 * 等字体和布局稳下来。
 *
 * `document.fonts.ready` 是关键那一步：字体没加载完时浏览器按后备字体排版，
 * 量出来的高度和用户最终看到的**不是一回事** —— 而且它每次都不一样，
 * 取决于网络。少了这一句，这个工具会时准时不准，比不准更难查。
 */
const settle = async () => {
  await nextTick()
  if (document.fonts?.ready) await document.fonts.ready
  // 两帧：一帧让样式生效，一帧让布局落定
  await new Promise<void>(res => requestAnimationFrame(() => requestAnimationFrame(() => res())))
}

/** 从 `base-element-<id>` 这个 class 里把元素 id 抠出来 */
const elementIdOf = (node: Element): string | null => {
  for (const cls of Array.from(node.classList)) {
    if (cls.startsWith('base-element-') && cls !== 'base-element-text') {
      return cls.slice('base-element-'.length)
    }
  }
  return null
}

/**
 * 截一张图给视觉复核看。**失败就跳过这一页，不让整次测量失败** ——
 * 几何数据已经量到了，为了一张截图把它一起丢掉是不划算的。
 *
 * 最可能的失败原因是跨域图片污染画布（COS 上的配图）。
 */
const shoot = async (node: HTMLElement): Promise<string | null> => {
  try {
    const { toPng } = await import('html-to-image')
    return await toPng(node, {
      pixelRatio: 1,
      // 跳过我们自己插进去的定位样式，别让它进截图
      skipFonts: false,
      cacheBust: false,
    })
  }
  catch (err) {
    console.warn('[reflect] 截图失败，这一页只给几何数据:', err)
    return null
  }
}

/**
 * 渲染指定的几页，量出每块文字实际画到哪儿。
 *
 * `slideIds` 为空表示全部。**永不抛异常** —— 出错时返回 `error`，
 * 让后端回一句「没量到」而不是干等到超时。
 */
export const measureRenderedSlides = async (
  slideIds: string[],
  wantShots: boolean,
): Promise<MeasureOutcome> => {
  const slidesStore = useSlidesStore()
  const all = slidesStore.slides as Slide[]
  const targets = slideIds.length ? all.filter(s => slideIds.includes(s.id)) : all

  if (targets.length === 0) return { measurements: [], error: '没有可测量的页' }

  const pinia = getActivePinia()
  if (!pinia) return { measurements: [], error: 'pinia 未初始化' }

  const host = document.createElement('div')
  // **离屏靠位移，不靠 display:none / visibility** ——
  // display:none 的节点根本不参与布局，offsetHeight 一律是 0；
  // 而我们要的正是布局的结果
  host.style.cssText = [
    'position:fixed', 'top:0', `left:-${slidesStore.viewportSize * 2}px`,
    'z-index:-1', 'pointer-events:none', 'opacity:0',
  ].join(';')
  document.body.appendChild(host)

  let app: App | null = null
  try {
    // size 取 viewportSize → scale 为 1，截图是原始尺寸。
    // 量高度其实不需要 scale 为 1（offsetHeight 不受 transform 影响），
    // 但截图需要
    const size = slidesStore.viewportSize
    app = createApp({
      render: () => targets.map(slide => h(
        'div',
        { 'data-slide-id': slide.id, 'style': 'position:relative' },
        [h(ThumbnailSlide, { slide, size, visible: true })],
      )),
    })
    app.use(pinia)
    app.mount(host)

    await settle()

    const measurements: TextMeasurement[] = []
    const shots: SlideShot[] = []

    for (const wrap of Array.from(host.querySelectorAll('[data-slide-id]'))) {
      const slideId = wrap.getAttribute('data-slide-id')
      if (!slideId) continue

      for (const box of Array.from(wrap.querySelectorAll('.base-element-text'))) {
        // 元素 id 在**外层**那个 `.base-element base-element-<id>` 上
        const holder = box.closest('.base-element')
        const elementId = holder ? elementIdOf(holder) : null
        const inner = box.querySelector('.text') as HTMLElement | null
        if (!elementId || !inner) continue
        // 和 scripts/measure-layout-text.mjs 逐字相同的量法
        measurements.push({ slideId, elementId, actualHeight: inner.offsetHeight })
      }

      if (wantShots) {
        const node = wrap.querySelector('.thumbnail-slide') as HTMLElement | null
        const dataUrl = node ? await shoot(node) : null
        if (dataUrl) shots.push({ slideId, dataUrl })
      }
    }

    return wantShots ? { measurements, shots } : { measurements }
  }
  catch (err) {
    return { measurements: [], error: err instanceof Error ? err.message : String(err) }
  }
  finally {
    // 卸载和摘节点都不能漏 —— 漏一次就在 body 上永久留一份离屏的 deck，
    // 它还在响应 store 的变化
    app?.unmount()
    host.remove()
  }
}
