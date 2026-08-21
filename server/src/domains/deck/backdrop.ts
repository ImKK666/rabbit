/**
 * 生成版面底图（backdrop）—— 纯函数那一半
 *
 * 和装饰层（`ornament.ts`）是**两件不同的事**：
 *
 * | | 装饰层 ornament | 底图 backdrop |
 * |---|---|---|
 * | 位置 | 压在内容**之上** | 垫在内容**之下** |
 * | 覆盖 | 稀疏（约 5%） | 铺满整页 |
 * | 透明 | 要，所以要抠图 | **不要**，不透明 |
 * | 落点 | 一个图片元素 | `slide.background`（原生支持 `type:'image'`） |
 * | 主要风险 | 压住文字 | 文字在它上面读不出来 |
 * | 存储 | 无损 PNG 207 KB | **JPEG 110 KB**（不透明能压） |
 *
 * 所以负空间的说法要**反过来**：不是「这里不许画」，
 * 而是「这几块要**安静**（近似均匀的浅色），好让文字压上去还读得出来」。
 *
 * ## 一条从实测来的硬规矩：绝不把数字写进提示词
 *
 * 第一版把留白区写成 `x 8%, y 12%, w 62%, h 18%`。
 * 版面画得很好 —— 网格底纹、带阴影的白卡片、右侧几何色块，全对。
 * **但模型把那串坐标当成要画的内容，原样写在了页面右边**，
 * 尽管提示词里明写着 `ABSOLUTELY NO text, letters, numbers`。
 *
 * 加更强的禁令是治标。**根因是给了它数字，那就别给。**
 * 所以坐标一律经 `describeRegion` 翻成方位短语（"the upper-left area…"），
 * 提示词里从头到尾不出现一个百分号。
 *
 * 这和 Gorden 的做法是一致的：他们的框架图提示词是固定模板，
 * **只允许替换背景色值**，不带任何坐标 —— 现在知道为什么了。
 */

import type { Slide } from '@/types/slides'
import { occupiedRectsOf, type OccupiedRect } from './ornament'

/** 把归一化矩形翻成方位短语。**输出里绝不能出现数字**，理由见文件头注释 */
export const describeRegion = ({ x, y, w, h }: OccupiedRect): string => {
  const cx = x + w / 2
  const cy = y + h / 2
  const col = cx < 0.36 ? 'left' : cx < 0.64 ? 'centre' : 'right'
  const row = cy < 0.36 ? 'upper' : cy < 0.64 ? 'middle' : 'lower'

  const width = w > 0.7 ? 'nearly the full width'
    : w > 0.45 ? 'a wide span'
      : w > 0.25 ? 'a medium span'
        : 'a narrow column'
  const height = h > 0.5 ? 'tall'
    : h > 0.25 ? 'medium-height'
      : 'a shallow band'

  return `the ${row}-${col} area — ${width}, ${height}`
}

export interface BackdropPromptInput {
  /** 要留安静的区域（文字和图片所在处） */
  rects: OccupiedRect[]
  /** 从 theme 来的锚点色。第一个当页面底色 */
  colors: string[]
}

/**
 * 拼出这一页的底图提示词。
 *
 * 措辞是实测收敛的（2026-08-21）：文字区亮度跨度 **0.048 / 0.128**，
 * 而非文字区 **0.814** —— 分离度 6~17 倍，`lintBackdropCalm` 的阈值就落在中间。
 */
export const buildBackdropPrompt = ({ rects, colors }: BackdropPromptInput): string => {
  const [base, ...accents] = colors
  const zones = rects.length
    ? rects.map(r => `  - ${describeRegion(r)}`).join('\n')
    : '  - the left half of the page'

  // NO TEXT 放在**最前面**。放末尾时模型已经把画面想完了，再禁就晚了
  return `Design the BACKGROUND ARTWORK for a 16:9 presentation slide.

FIRST AND MOST IMPORTANT: this image must contain NO text of any kind —
no letters, no words, no numbers, no digits, no percent signs, no labels,
no captions, no icons, no logos, no page numbers, no watermarks.
It is pure abstract background artwork. Text will be added later by other means.

This artwork sits UNDERNEATH the content, so it must never compete with it.

Base colour: ${base ?? '#F7F5F0'}. Accents (use only these and tints of them): ${accents.join(', ') || 'a single muted navy'}.

WHAT TO DRAW — give the page real structure and depth:
  - soft panel or card shapes with gentle shadows, marking out the regions of the layout
  - one broad colour-block zone or diagonal band anchoring one side of the page
  - a very light texture or fine grid across the whole canvas
  - a few thin accent rules and corner marks
  - a subtle gradient so the page has depth rather than flat fill

CALM ZONES — content will sit on top of these areas, so inside them the artwork must be
QUIET: a near-uniform light tone, no busy texture, no strong edges, no dark shapes,
no high-contrast patterns. A plain soft panel is exactly right.
${zones}
Each calm zone must be covered ENTIRELY and EDGE TO EDGE by its quiet tone, extending a
little beyond the area on every side. A panel that covers only part of the zone is wrong —
the leftover strip would fall on the darker artwork and text there would be unreadable.
Put all the visual interest OUTSIDE those areas — the opposite side, the bottom band, the corners.

Style: flat vector / editorial print design. Not photographic. Not 3D.
Remember: absolutely no text, letters or numbers anywhere in the image.`
}

// ---------------------------------------------------------------------------
// 判据 · 文字区必须「安静」
// ---------------------------------------------------------------------------

/**
 * 文字区内亮度 p5~p95 的跨度上限。
 *
 * **跨度大 = 区内一块亮一块暗 = 不管文字设成什么颜色都会有一部分读不出来。**
 * 这一条是**渲染之前**就能判的，比 `renderContrast.ts` 那条（渲染后实测）便宜得多；
 * 两者是两层：这里挡掉「这张底图根本不能用」，那里兜住「具体某块字压坏了」。
 *
 * 0.30 是拿实测标定的：文字区 0.048 / 0.128，非文字区 0.814。
 */
export const MAX_LUMINANCE_SPREAD = 0.30

export interface CalmIssue {
  kind: 'text' | 'image'
  rect: OccupiedRect
  /** 区内亮度的 p5~p95 跨度 */
  spread: number
  p5: number
  p95: number
}

/** WCAG 相对亮度。和 `design.ts` 的 `luminance` 同一个公式，输入是 0~255 分量 */
const lumOf = (r: number, g: number, b: number) => {
  const f = (v: number) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

/** 一个区域里最多采这么多点。1376×768 的整页全采是白烧 */
const SAMPLE_STRIDE_TARGET = 4096

/**
 * 这张底图的文字区够不够安静。
 *
 * 纯 `Uint8Array` 统计，不起浏览器、不调模型。
 */
export const lintBackdropCalm = (
  rgba: Uint8Array,
  width: number,
  height: number,
  rects: OccupiedRect[],
  maxSpread: number = MAX_LUMINANCE_SPREAD,
): CalmIssue[] => {
  const issues: CalmIssue[] = []

  for (const rect of rects) {
    const x0 = Math.max(0, Math.round(rect.x * width))
    const y0 = Math.max(0, Math.round(rect.y * height))
    const x1 = Math.min(width, Math.round((rect.x + rect.w) * width))
    const y1 = Math.min(height, Math.round((rect.y + rect.h) * height))
    if (x1 <= x0 || y1 <= y0) continue

    const area = (x1 - x0) * (y1 - y0)
    const step = Math.max(1, Math.round(Math.sqrt(area / SAMPLE_STRIDE_TARGET)))
    const ls: number[] = []
    for (let y = y0; y < y1; y += step) {
      for (let x = x0; x < x1; x += step) {
        const o = (y * width + x) * 4
        ls.push(lumOf(rgba[o], rgba[o + 1], rgba[o + 2]))
      }
    }
    if (ls.length < 16) continue

    ls.sort((a, b) => a - b)
    const at = (q: number) => ls[Math.min(ls.length - 1, Math.max(0, Math.round(q * (ls.length - 1))))]
    const p5 = at(0.05), p95 = at(0.95)
    const spread = p95 - p5
    if (spread > maxSpread) {
      issues.push({
        kind: rect.kind, rect,
        spread: Math.round(spread * 1000) / 1000,
        p5: Math.round(p5 * 1000) / 1000,
        p95: Math.round(p95 * 1000) / 1000,
      })
    }
  }

  issues.sort((a, b) => b.spread - a.spread)
  return issues
}

export const describeCalmIssues = (issues: CalmIssue[]): string => {
  if (issues.length === 0) return '底图的内容区都是安静的，文字压上去读得出来。'
  return [
    `底图有 ${issues.length} 块内容区太花（亮度跨度上限 ${MAX_LUMINANCE_SPREAD}）：`,
    ...issues.map(i =>
      `- ${i.kind === 'text' ? '文字区' : '图片区'} ${describeRegion(i.rect)}`
      + `：亮度 ${i.p5}~${i.p95}，跨度 ${i.spread}`),
    '这张底图不能用 —— 区内一块亮一块暗，文字设成什么颜色都会有一部分看不见。',
  ].join('\n')
}

/** 从一页 slide 直接算出它的安静区要求。就是 ornament 那套占用矩形 */
export const calmZonesOf = (slide: Slide): OccupiedRect[] => occupiedRectsOf(slide)
