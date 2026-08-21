/**
 * 离屏测量探针（开发工具，不参与打包）
 *
 *   npx vite --port 5199                 # 另开一条命令
 *   node scripts/render-probe.mjs        # 无头跑一遍，把结论打到终端
 *   # 或者直接开 http://127.0.0.1:5199/render-probe.html 用眼睛看
 *
 * ## 它验的是什么
 *
 * `src/utils/renderMeasure.ts` 把 slide **离屏**挂起来量真实文本高度，
 * 结果通过 WebSocket 交给后端的 `reflectRender` 工具（docs/13 §三）。
 *
 * 这里面有一个不验就不知道的假设：**离屏那份渲染和用户真正看到的那份一样吗。**
 * 离屏容器是 `position:fixed; left:-2000px; opacity:0`，
 * 万一哪天有人改成 `display:none`，`offsetHeight` 会**全部变成 0** ——
 * 而 0 意味着「每块文字都画得下」，报告一片祥和，
 * **没有任何东西会报错**。这正是 09 号风险表那类「绿着的假判据」。
 *
 * 所以这个探针把同一批页量两遍：
 *   A 组 正常挂在文档流里渲染（就是编辑器缩略图那条路）
 *   B 组 走 `measureRenderedSlides`（离屏）
 * 逐个元素比对，对不上就红。
 *
 * ## 和 measure-layout-text.mjs 的关系
 *
 * 那个脚本量的是**版式引擎估得准不准**（declared vs actual），
 * 这个探针量的是**离屏这条路可不可信**（onscreen vs offscreen）。
 * 两者用的是逐字相同的公式：`declared = style.height`、`actual = .text 的 offsetHeight`。
 */

import { createApp, defineComponent, h, ref, onMounted } from 'vue'
import { createPinia } from 'pinia'

import 'animate.css'
import '@/assets/styles/animation-extra.scss'
import '@/assets/styles/asset-skeleton.scss'
import '@/assets/styles/prosemirror.scss'
import '@/assets/styles/global.scss'
import '@/assets/styles/font.scss'

import ThumbnailSlide from '@/views/components/ThumbnailSlide/index.vue'
import { useSlidesStore } from '@/store'
import { measureRenderedSlides } from '@/utils/renderMeasure'
import type { Slide } from '@/types/slides'

import { LAYOUT_PATTERNS, buildLayout, type LayoutPattern } from '../server/src/domains/deck/layouts'
import { buildPalette } from '../server/src/domains/deck/design'
import { variantsFor } from './layout-fixtures'

const params = new URLSearchParams(location.search)

/**
 * 每个版式取一个变体就够。
 *
 * 默认取 `dense`（内容顶满）—— 那是最容易溢出的一档，
 * 也就是这套机制最该量准的地方。
 */
const VARIANT = params.get('variant') || 'dense'

/**
 * 一页**故意写坏的**稿子，给视觉复核当正对照用（`?bad=1`）。
 *
 * 两条毛病是刻意挑的，正好对应 12 号文档 §六② 砍掉 Reviewer 时
 * 明确「先丢掉」的那两条 —— 它们是几何检查永远查不出来的：
 *   1. 满篇套话（「全面赋能业务增长」「打造业务闭环」）
 *   2. 一串百分比被排成了文字，而不是 chart
 *
 * **这一页和它的截图会被一起吐出去**（`--shot-out` / `--slide-out`），
 * 让端到端实测里「库里那页」和「模型看到的那张图」不可能对不上 ——
 * 上一版就是对不上：图是 title-center、库里是 bullets，
 * 模型说「没问题」而我差点当成通过了。**那是一条假绿。**
 */
const badSlide = (): Slide => {
  const variant = variantsFor('bullets', null)[0]
  const palette = buildPalette(variant.theme)
  const r = buildLayout('bullets', {
    title: '全面赋能业务增长',
    items: [
      { title: '提升效率', desc: '通过流程优化实现降本增效，打造业务闭环' },
      { title: '数据驱动', desc: '第一季度 32%，第二季度 45%，第三季度 61%，第四季度 78%' },
      { title: '生态协同', desc: '深度整合上下游资源，构建全链路解决方案' },
    ],
  } as never, palette, 'probe_bad', { animate: false })
  return { id: 'probe_bad', elements: r.elements, background: r.background, animations: [] } as Slide
}

const buildSlides = (): Slide[] => {
  if (params.get('bad')) return [badSlide()]
  const only = params.get('only')?.split(',').filter(Boolean) as LayoutPattern[] | undefined
  const patterns = only?.length ? only : [...LAYOUT_PATTERNS]
  const out: Slide[] = []

  for (const pattern of patterns) {
    const variant = variantsFor(pattern, null).find(v => v.key === VARIANT)
      ?? variantsFor(pattern, null)[0]
    const palette = buildPalette(variant.theme)
    const r = buildLayout(pattern, variant.content, palette, `probe_${pattern}`, { animate: false })
    out.push({
      id: `probe_${pattern}`,
      elements: r.elements,
      background: r.background,
      animations: [],
    } as Slide)
  }
  return out
}

/** 量一份**已经在文档流里**的渲染。公式和 measure-layout-text.mjs 逐字相同 */
const measureOnscreen = (root: HTMLElement) => {
  const out: { slideId: string, elementId: string, declared: number, actualHeight: number }[] = []
  for (const wrap of Array.from(root.querySelectorAll('[data-slide-id]'))) {
    const slideId = wrap.getAttribute('data-slide-id')!
    for (const box of Array.from(wrap.querySelectorAll('.base-element-text'))) {
      const holder = box.closest('.base-element')
      const cls = holder
        ? Array.from(holder.classList).find(c => c.startsWith('base-element-') && c !== 'base-element-text')
        : undefined
      const inner = box.querySelector('.text') as HTMLElement | null
      if (!cls || !inner) continue
      out.push({
        slideId,
        elementId: cls.slice('base-element-'.length),
        declared: parseFloat((box as HTMLElement).style.height),
        actualHeight: inner.offsetHeight,
      })
    }
  }
  return out
}

const Probe = defineComponent({
  setup() {
    const slides = buildSlides()
    const onscreenRef = ref<HTMLElement | null>(null)

    onMounted(async () => {
      const store = useSlidesStore()
      store.setSlides(slides)

      // 等字体 —— 和 renderMeasure 里同一道等待，不然 A 组会用后备字体排版
      if (document.fonts?.ready) await document.fonts.ready
      await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())))

      const onscreen = measureOnscreen(onscreenRef.value!)
      const offscreen = (await measureRenderedSlides([], false)).measurements

      // 截图那条路单独走一次，只取第一页 —— 它是视觉复核的输入，
      // 而 html-to-image 遇到跨域图片会污染画布，这条不真跑一次就不知道行不行
      const shotRun = await measureRenderedSlides([slides[0].id], true)
      const firstShot = shotRun.shots?.[0]?.dataUrl ?? null

      /**
       * 背景采样那条路（R-57）。上面那两次调用的 `wantBackdrop` 都是默认的 false，
       * 所以这条路在这个探针里原本**一行都没被覆盖过**。
       */
      /**
       * **测量进行中改写 store** —— 探针原来覆盖不到的那个差异。
       *
       * 真实环境里 agent 一直在跑，`agent.deck` 不断推过来、
       * `slidesStore.setSlides()` 不断替换 slides。而离屏那份渲染是挂在同一个
       * pinia 上的，store 一换它就要重渲 —— 此时若正在 `toCanvas`，
       * 操作的就是一棵正在被拆掉的树。
       *
       * 这里在测量启动后立刻连推三次，模拟那个时序。
       */
      const churn = (async () => {
        for (let i = 0; i < 3; i++) {
          await new Promise<void>(r => setTimeout(r, 60))
          store.setSlides(JSON.parse(JSON.stringify(slides)) as Slide[])
        }
      })()

      const backdropStart = performance.now()
      const backdropRun = await measureRenderedSlides([], false, true)
      await churn
      const backdropMs = Math.round(performance.now() - backdropStart)
      const contrast = backdropRun.contrast ?? []
      const sampledOk = contrast.filter(c => c.sampled >= 64).length

      const key = (m: { slideId: string, elementId: string }) => `${m.slideId}|${m.elementId}`
      const byKey = new Map(offscreen.map(m => [key(m), m.actualHeight]))

      const rows = onscreen.map(a => ({
        ...a,
        offscreen: byKey.get(key(a)),
      }))
      const missing = rows.filter(r => r.offscreen === undefined)
      const mismatched = rows.filter(r => r.offscreen !== undefined && r.offscreen !== r.actualHeight)
      const allZero = offscreen.length > 0 && offscreen.every(m => m.actualHeight === 0)

      const result = {
        slides: slides.length,
        onscreenCount: onscreen.length,
        offscreenCount: offscreen.length,
        missing: missing.length,
        mismatched: mismatched.length,
        allZero,
        /** 顺带把「版式引擎估得准不准」也报一下，和 measure-layout-text.mjs 同一个口径 */
        overflowing: rows.filter(r => r.actualHeight - r.declared > 4).length,
        samples: rows.slice(0, 5),
        mismatchSamples: mismatched.slice(0, 5),
        /** 截图这条路通不通。视觉复核的输入全靠它 */
        shotOk: !!firstShot,
        /** 背景采样这条路：跑完了没有（白屏那次是根本跑不完）、采到几块、耗时 */
        backdropCount: contrast.length,
        backdropSampled: sampledOk,
        backdropMs,
        shotBytes: firstShot ? firstShot.length : 0,
        shotDataUrl: firstShot,
        /** 被截那一页的 slide JSON。和截图一起吐出去，两边就不可能对不上 */
        shotSlideJson: JSON.stringify(slides[0]),
        ok: onscreen.length > 0
          && offscreen.length === onscreen.length
          && missing.length === 0
          && mismatched.length === 0
          && !allZero
          // 背景采样这条路必须跑得完、且真采到东西。
          // 白屏那次它根本走不到这里，但万一以后是「跑完了却全是 0」，这条能抓住
          && sampledOk > 0,
      };

      (window as unknown as { __probeResult: unknown }).__probeResult = result

      const out = document.getElementById('out')!
      out.textContent = [
        `页数            ${result.slides}`,
        `正常渲染量到    ${result.onscreenCount} 个文本元素`,
        `离屏渲染量到    ${result.offscreenCount} 个`,
        `对不上的        ${result.mismatched} 个`,
        `离屏没量到的    ${result.missing} 个`,
        `离屏全是 0      ${result.allZero ? '是 ← 离屏那条路坏了' : '否'}`,
        `截图（视觉复核的输入）  ${result.shotOk ? `✅ ${(result.shotBytes / 1024).toFixed(0)} KB` : '❌ 截不出来'}`,
        `背景采样（R-57）        ${result.backdropCount > 0
          ? `✅ 跑完了，采到 ${result.backdropSampled}/${result.backdropCount} 块，${result.backdropMs}ms`
          : '❌ 一块都没采到'}`,
        '',
        `顺带：版式引擎估小的（溢出 >4px） ${result.overflowing} 处`,
        '',
        result.ok ? '✅ R3 通过：离屏渲染与正常渲染逐个元素一致' : '❌ R3 不通过',
        '',
        '前 5 个元素（declared / onscreen / offscreen）：',
        ...result.samples.map(s =>
          `  ${s.slideId} ${s.elementId}  ${s.declared.toFixed(0)} / ${s.actualHeight} / ${s.offscreen}`),
        ...(mismatched.length
          ? ['', '对不上的：', ...result.mismatchSamples.map(s =>
            `  ${s.slideId} ${s.elementId}  onscreen=${s.actualHeight} offscreen=${s.offscreen}`)]
          : []),
      ].join('\n')
      out.className = result.ok ? 'ok' : 'bad'
    })

    return () => h('div', { ref: onscreenRef, id: 'onscreen-host' }, slides.map(slide => h(
      'div',
      { 'data-slide-id': slide.id },
      [h(ThumbnailSlide, { slide, size: 1000, visible: true })],
    )))
  },
})

const app = createApp(Probe)
app.use(createPinia())
app.mount('#onscreen')
