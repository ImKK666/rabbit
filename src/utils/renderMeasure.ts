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

/**
 * 一块文字**实际**是什么颜色、它底下**实际**是什么颜色。
 *
 * 判定逻辑在服务端 `domains/deck/renderContrast.ts`（那儿有判据），
 * 这里只负责采集 —— 而这三个数**只有浏览器知道**。
 */
export interface ContrastSample {
  slideId: string
  elementId: string
  /** `getComputedStyle().color` 换算成 hex。不解析 HTML，见服务端那边的说明 */
  textColor: string
  /** 文字矩形下方（**不含文字层**）合成后的第 5 / 95 百分位颜色 */
  backdrop: [string, string]
  /** 采到了几个像素。0 表示这条不可信（画布被跨域图污染 / 矩形在画布外） */
  sampled: number
}

export interface MeasureOutcome {
  measurements: TextMeasurement[]
  shots?: SlideShot[]
  contrast?: ContrastSample[]
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

const clamp255 = (v: number) => Math.max(0, Math.min(255, Math.round(v)))
const toHex = (r: number, g: number, b: number) =>
  `#${[r, g, b].map(v => clamp255(v).toString(16).padStart(2, '0')).join('')}`

/** WCAG 相对亮度。和服务端 `design.ts` 的 `luminance` 逐字相同的公式 */
const lumOf = (r: number, g: number, b: number) => {
  const f = (v: number) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

/** 一个矩形里最多采这么多点。400×80 的框有 32000 像素，全采是白烧 */
const MAX_SAMPLES_PER_RECT = 4096

/**
 * 把 `rgb(r, g, b)` / `rgba(...)` 换成 hex。
 *
 * `getComputedStyle().color` 在所有浏览器里都是这个形状 ——
 * 拿不准的情况返回 null，让调用方把这条标成不可信，
 * **而不是猜一个颜色**（猜错会变成一条看起来很正经的假告警）。
 */
const cssColorToHex = (css: string): string | null => {
  const m = css.match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/)
  return m ? toHex(+m[1], +m[2], +m[3]) : null
}

/**
 * 在一张已经画好的画布上，取 `rect` 区域的第 5 / 95 百分位颜色。
 *
 * **按亮度排序取百分位，返回那两个位置上的真实颜色** —— 不是平均色。
 * 平均色会把「一半纯白一半纯黑」算成灰，而那正是最危险的一种背景：
 * 白字在它的白半边上完全消失，平均值却显示对比度很好。
 */
const percentileColors = (
  ctx: CanvasRenderingContext2D,
  rect: { x: number, y: number, w: number, h: number },
): { backdrop: [string, string], sampled: number } | null => {
  const x = Math.max(0, Math.floor(rect.x))
  const y = Math.max(0, Math.floor(rect.y))
  const w = Math.min(ctx.canvas.width - x, Math.ceil(rect.w))
  const h = Math.min(ctx.canvas.height - y, Math.ceil(rect.h))
  if (w <= 0 || h <= 0) return null

  let data: Uint8ClampedArray
  try {
    // 跨域图片（COS 上的配图）会污染画布，这里直接抛 SecurityError。
    // 抛了就返回 null → 这条标成 sampled:0 → 服务端报「没判」。
    // **绝不能吞掉当成「背景是白的」** —— 那会把所有深色主题误判成低对比度
    data = ctx.getImageData(x, y, w, h).data
  }
  catch {
    return null
  }

  const total = w * h
  const stride = Math.max(1, Math.floor(total / MAX_SAMPLES_PER_RECT))
  const px: { l: number, r: number, g: number, b: number }[] = []
  for (let i = 0; i < total; i += stride) {
    const o = i * 4
    // 全透明的像素不算 —— 它代表这块画布上什么都没画，不是「黑色背景」
    if (data[o + 3] < 8) continue
    px.push({ l: lumOf(data[o], data[o + 1], data[o + 2]), r: data[o], g: data[o + 1], b: data[o + 2] })
  }
  if (px.length === 0) return null

  px.sort((a, b) => a.l - b.l)
  const at = (q: number) => px[Math.min(px.length - 1, Math.max(0, Math.round(q * (px.length - 1))))]
  const lo = at(0.05), hi = at(0.95)
  return { backdrop: [toHex(lo.r, lo.g, lo.b), toHex(hi.r, hi.g, hi.b)], sampled: px.length }
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
  wantBackdrop = false,
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

    /**
     * 「不含文字层」的同一页 —— 要量的是**文字底下是什么**，所以得把文字层拿掉再渲一份。
     * 位置全是绝对定位，拿掉文字不影响其余元素的几何，两份渲染在坐标上逐像素对齐。
     *
     * ## 必须在 `render()` **外面**算好，这一条是踩出来的
     *
     * 第一版把 `bare(slide)` 写在 `render()` 里，结果是**白屏**：
     *
     * 1. 每次重渲染都产生一个**全新对象**，Vue 看到 `slide` prop 变了就重渲整棵子树
     * 2. 而 `bare()` 读的 `slide.elements` 是 pinia 的响应式代理 ——
     *    这一读就把它注册成了这个渲染副作用的依赖
     * 3. 于是「渲染 → 造新对象 → 依赖变化 → 再渲染」自激，主线程卡死
     *
     * **而这种卡死外层的 try/catch 抓不到** —— 它不抛异常，是根本不返回。
     * 所以这个文件头注释里「永不抛异常」那道防线，在这条路上是失效的：
     * 唯一的防法是不制造这个循环。
     *
     * `structuredClone` 之类的深拷贝也不行，一样是新身份。要的就是**算一次、存下来**。
     */
    const bareSlides: Slide[] = wantBackdrop
      ? targets.map(s => ({ ...s, elements: s.elements.filter(el => el.type !== 'text') }))
      : []

    app = createApp({
      render: () => targets.flatMap((slide, i) => [
        h('div', { 'data-slide-id': slide.id, 'style': 'position:relative' },
          [h(ThumbnailSlide, { slide, size, visible: true })]),
        ...(wantBackdrop
          ? [h('div', { 'data-bare-id': slide.id, 'style': 'position:relative' },
            [h(ThumbnailSlide, { slide: bareSlides[i], size, visible: true })])]
          : []),
      ]),
    })
    app.use(pinia)
    app.mount(host)

    await settle()

    const measurements: TextMeasurement[] = []
    const shots: SlideShot[] = []
    const contrast: ContrastSample[] = []

    for (const wrap of Array.from(host.querySelectorAll('[data-slide-id]'))) {
      const slideId = wrap.getAttribute('data-slide-id')
      if (!slideId) continue

      const slideNode = wrap.querySelector('.thumbnail-slide') as HTMLElement | null

      /**
       * 这一页「不含文字层」的画布。**一页只画一次**，所有文字块共用 ——
       * `toCanvas` 是这条路上最贵的一步（几百毫秒一张），
       * 每块文字各画一次的话，一页十块字就是十倍开销。
       */
      let bareCtx: CanvasRenderingContext2D | null = null
      let bareScale = 1
      if (wantBackdrop && slideNode) {
        const bareWrap = host.querySelector(`[data-bare-id="${CSS.escape(slideId)}"]`)
        const bareNode = bareWrap?.querySelector('.thumbnail-slide') as HTMLElement | null
        if (bareNode) {
          try {
            const { toCanvas } = await import('html-to-image')
            const canvas = await toCanvas(bareNode, { pixelRatio: 1, cacheBust: false })
            bareCtx = canvas.getContext('2d')
            // 画布像素 ÷ CSS 像素。ThumbnailSlide 内部有 transform: scale，
            // 而 getBoundingClientRect 给的是**变换后**的尺寸 —— 两边都按同一个基准换算
            bareScale = canvas.width / (bareNode.getBoundingClientRect().width || 1)
          }
          catch (err) {
            console.warn('[reflect] 背景采样画布生成失败，这一页只给几何数据:', err)
          }
        }
      }
      const slideRect = slideNode?.getBoundingClientRect()

      for (const box of Array.from(wrap.querySelectorAll('.base-element-text'))) {
        // 元素 id 在**外层**那个 `.base-element base-element-<id>` 上
        const holder = box.closest('.base-element')
        const elementId = holder ? elementIdOf(holder) : null
        const inner = box.querySelector('.text') as HTMLElement | null
        if (!elementId || !inner) continue
        // 和 scripts/measure-layout-text.mjs 逐字相同的量法
        measurements.push({ slideId, elementId, actualHeight: inner.offsetHeight })

        if (!bareCtx || !slideRect) continue
        const textColor = cssColorToHex(getComputedStyle(inner).color)
        const r = inner.getBoundingClientRect()
        // 拿不到颜色时**不猜** —— 标成 sampled:0，服务端会说「这条没判」
        if (!textColor) {
          contrast.push({ slideId, elementId, textColor: '#000000', backdrop: ['#000000', '#000000'], sampled: 0 })
          continue
        }
        const picked = percentileColors(bareCtx, {
          x: (r.left - slideRect.left) * bareScale,
          y: (r.top - slideRect.top) * bareScale,
          w: r.width * bareScale,
          h: r.height * bareScale,
        })
        contrast.push(picked
          ? { slideId, elementId, textColor, ...picked }
          : { slideId, elementId, textColor, backdrop: ['#000000', '#000000'], sampled: 0 })
      }

      if (wantShots && slideNode) {
        const dataUrl = await shoot(slideNode)
        if (dataUrl) shots.push({ slideId, dataUrl })
      }
    }

    return {
      measurements,
      ...(wantShots ? { shots } : {}),
      ...(wantBackdrop ? { contrast } : {}),
    }
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
