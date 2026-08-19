/**
 * 版式样张联系表（开发工具，不参与打包）
 *
 *   npx vite                                     # 起 dev server
 *   open http://127.0.0.1:5173/layout-sheet.html
 *   node scripts/shoot-layout-sheet.mjs          # 截成 PNG
 *
 * ## 为什么要它
 *
 * 「好不好看」没有机器判据。`lintDeckDesign` 能判对比度、越界、重叠、相邻页雷同，
 * 但判不了「这页排得整齐却没有设计感」—— 那正是这一轮要解决的问题。
 *
 * 仓库里已经吃过两次同样的亏，两次的解法都是**换一个看它的方式**：
 *   R-36  「45 个动画对不对」—— 肉眼看不出补间和阶梯的区别 → 无头浏览器逐帧采样
 *   R-41  「51 个图标叫什么」—— 光看 path 没法命名 → 生成联系表截图逐个看
 * 这个文件是第三次：**把 10 个版式 × 7 种内容变体一次性摆出来看**。
 *
 * ## 和真实渲染路径的关系
 *
 * - 版面：直接调 `buildLayout`，就是 `applyLayout` 工具调的那个函数
 * - 渲染：用 `ThumbnailSlide`（`src/views/components/`），编辑器左侧缩略图同一个组件，
 *   它内部 dispatch 到真实的 BaseTextElement / BaseShapeElement / BaseImageElement
 * - 配色：`buildPalette`，agent 拿 `getDesignTokens` 拿到的同一套
 * - 图片：真实 COS 上的照片，经 `resolveAssetUrl` 解析 `asset://`
 *
 * **这里没有任何一行是「怎么排」或「怎么画」的第二实现**，它只负责把产物摆出来。
 * 唯一属于工具自己的是排版（网格）和标注。
 *
 * ## 刻意不做动画
 *
 * 出场顺序有 `npm run layout-order` 管，那是另一个问题。这里只看**终态版面**，
 * 混在一起会让「这页丑」和「这页出场顺序不对」两类问题分不开。
 */

import { createApp, defineComponent, h, ref, computed } from 'vue'
import { createPinia } from 'pinia'

import 'animate.css'
import '@/assets/styles/animation-extra.scss'
import '@/assets/styles/asset-skeleton.scss'
import '@/assets/styles/prosemirror.scss'
import '@/assets/styles/global.scss'
import '@/assets/styles/font.scss'

import { setAssetBaseUrl } from '@/utils/assetUrl'
import ThumbnailSlide from '@/views/components/ThumbnailSlide/index.vue'
import type { Slide } from '@/types/slides'

import {
  LAYOUT_PATTERNS, LAYOUT_META, buildLayout, type LayoutPattern,
} from '../server/src/domains/deck/layouts'
import { buildPalette } from '../server/src/domains/deck/design'
import { variantsFor, type Variant } from './layout-fixtures'

/**
 * 图直接指到 COS 公有读的根。
 *
 * 正式路径是前端启动时问后端 `GET /api/assets/base-url`（R-47），
 * 这里写死是**故意的** —— 这个工具不该为了看一眼版面就要求先起后端 + 登录。
 * 代价是换桶之后要改这一行，用 `?base=` 覆盖即可。
 */
const DEFAULT_BASE = 'https://rabbit-1307074209.cos.ap-guangzhou.myqcloud.com/rabbit'
const params = new URLSearchParams(location.search)
setAssetBaseUrl(params.get('base') || DEFAULT_BASE)

/** 一格的宽度。默认 480 —— 一屏两列，既看得出细节又能整体比较 */
const CELL = Number(params.get('size') || 480)

interface Cell {
  pattern: LayoutPattern
  variant: Variant
  slide: Slide
  /** 越界 / 空元素这类硬问题在联系表上直接标出来，省得看图时以为是自己眼花 */
  overflow: number
}

const build = (pattern: LayoutPattern, variant: Variant): Cell => {
  const palette = buildPalette(variant.theme)
  // animate:false —— 只看终态版面，出场顺序归 npm run layout-order 管
  const r = buildLayout(pattern, variant.content, palette, `sheet_${pattern}_${variant.key}`, { animate: false })

  const overflow = r.elements.filter(el => {
    const w = 'width' in el ? el.width : 0
    const h = 'height' in el ? el.height : 0
    return el.left < -1 || el.top < -1 || el.left + w > 1001 || el.top + h > 563.5
  }).length

  return {
    pattern,
    variant,
    slide: { id: `${pattern}_${variant.key}`, elements: r.elements, background: r.background, animations: [] },
    overflow,
  }
}

const only = params.get('only')?.split(',').filter(Boolean) as LayoutPattern[] | undefined
const patterns = only?.length ? only : [...LAYOUT_PATTERNS]

const Sheet = defineComponent({
  setup() {
    const variantFilter = ref(params.get('variant') || '')

    const rows = computed(() => patterns.map(pattern => ({
      pattern,
      meta: LAYOUT_META[pattern],
      cells: variantsFor(pattern, LAYOUT_META[pattern].image, LAYOUT_META[pattern].itemImage)
        .filter(v => !variantFilter.value || v.key === variantFilter.value)
        .map(v => build(pattern, v)),
    })))

    return () => h('div', { class: 'sheet' }, [
      h('header', { class: 'sheet-head' }, [
        h('h1', 'Rabbit · 版式样张联系表'),
        h('p', [
          `${patterns.length} 个版式 · ${rows.value.reduce((n, r) => n + r.cells.length, 0)} 张样张 · `,
          '终态版面（不含动画）· 图片是 COS 上的真实照片',
        ]),
      ]),
      ...rows.value.map(row => h('section', { class: 'row' }, [
        h('h2', [
          h('span', { class: 'pat' }, row.pattern),
          h('span', { class: 'nm' }, row.meta.name),
          h('span', { class: 'img' }, row.meta.image ? `图位：${row.meta.image}` : '不吃图'),
        ]),
        h('div', { class: 'grid' }, row.cells.map(cell => h('figure', { class: 'cell' }, [
          h(ThumbnailSlide, { slide: cell.slide, size: CELL }),
          h('figcaption', [
            h('b', cell.variant.label),
            h('span', { class: 'watch' }, cell.variant.watch),
            cell.overflow
              ? h('span', { class: 'bad' }, `⚠ ${cell.overflow} 个元素越界`)
              : null,
          ]),
        ]))),
      ])),
    ])
  },
})

const app = createApp(Sheet)
app.use(createPinia())
app.mount('#app')

// 无头截图要等图片真的解码完 —— networkidle 只保证请求结束，不保证画上了
Object.assign(window, {
  __sheetReady: async () => {
    const imgs = Array.from(document.images)
    await Promise.all(
      imgs.map(img => img.complete
        ? Promise.resolve()
        : new Promise(res => {
          img.onload = img.onerror = res 
        })),
    )
    await document.fonts.ready
    return {
      cells: document.querySelectorAll('.cell').length,
      images: imgs.length,
      // 图挂了必须显式报出来：一张 404 的图在联系表上是**一块白**，
      // 而白块看起来完全像「这个版式就是这么设计的」
      broken: imgs.filter(i => !i.naturalWidth).map(i => i.src),
    }
  },
})
