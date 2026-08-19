/**
 * 版式体检台（开发工具，不参与打包）
 *
 *   npx vite-node scripts/audit-layouts.ts
 *   npx vite-node scripts/audit-layouts.ts -- --json
 *
 * ## 和联系表的分工
 *
 * `layout-sheet.ts` 回答「好不好看」—— 只能靠人看。
 * 这个文件回答**能机器判的那一半**，因为「看着还行」和「没有告警」是两回事：
 * 一页可以既通过全部 lint 又难看得要命（留白空洞、右侧死区），
 * 也可以看着挺好而文字实际压在一起（缩略图上 15px 的重叠看不出来）。
 *
 * 判据全部来自生产代码 `lintSlide` / `lintDeckDesign`，这里不写第二套规则。
 * 工具自己加的只有两条**量化指标**（不是判据，是给人看的数字）：
 *   - 内容占比：所有元素的并集面积 ÷ 安全区面积。太低 = 版面空
 *   - 底部空档：最下方元素的底边到安全区底边还剩多少
 *
 * ## 为什么要 DENSE 那一档
 *
 * 「applyLayout 的产物必须零告警」是仓库的硬契约，但它一直只在**理想内容**
 * 上验过 —— 短标题、三条要点、每条一句话。真实 agent 写出来的文案长得多。
 * 这个文件把 `layout-fixtures.ts` 的四档内容全部过一遍。
 */

/* eslint-disable no-console -- 命令行工具，输出就是它的产物 */
import type { Slide } from '../src/types/slides'
import {
  LAYOUT_PATTERNS, LAYOUT_META, buildLayout, type LayoutPattern,
} from '../server/src/domains/deck/layouts'
import { buildPalette, SAFE } from '../server/src/domains/deck/design'
import { lintSlide, lintDeckDesign } from '../server/src/domains/deck/kernel'
import { variantsFor, type Variant } from './layout-fixtures'

const box = (el: Slide['elements'][number]) => ({
  left: el.left,
  top: el.top,
  width: 'width' in el ? el.width : 0,
  height: 'height' in el ? el.height : 0,
})

/**
 * 元素并集面积 ÷ 安全区面积。
 *
 * 用**栅格采样**而不是矩形求并 —— 后者要处理任意重叠的容斥，代码长得多，
 *而这只是个给人看的指标，2px 精度完全够。
 */
const coverage = (slide: Slide): number => {
  const STEP = 4
  let hit = 0, total = 0
  for (let y = SAFE.top; y < SAFE.bottom; y += STEP) {
    for (let x = SAFE.left; x < SAFE.right; x += STEP) {
      total++
      for (const el of slide.elements) {
        const b = box(el)
        // 满屏背景图 / 遮罩不算「内容」—— 算了的话每张 backdrop 都是 100%
        if (b.width >= 990 && b.height >= 550) continue
        if (x >= b.left && x <= b.left + b.width && y >= b.top && y <= b.top + b.height) {
          hit++; break 
        }
      }
    }
  }
  return total ? hit / total : 0
}

/**
 * 上下留白的**不对称度**：`|上边距 - 下边距|`。
 *
 * 一开始量的是「底部空档」（最下方元素到安全区底边），但那个指标在这一轮
 * 自己失效了 —— 版面改成垂直居中之后，底部空档大是**对的**，因为顶部空档一样大。
 * 拿它当判据会把「排好了」判成「没排完」。
 *
 * 真正要抓的是**「内容整个掉在顶上、下面空一大片」**，那表现为两边差得很远。
 * 光学底重让下边比上边多 8px，所以理想值是 8 左右而不是 0。
 *
 * 这条记在这里当个记号：**判据也会过期**。改了实现却不回头看判据还量不量得对，
 * 就会拿着一把量错东西的尺子继续调。
 */
const verticalBalance = (slide: Slide): number => {
  let lowest = SAFE.top
  let highest = SAFE.bottom
  for (const el of slide.elements) {
    const b = box(el)
    if (b.width >= 990 && b.height >= 550) continue
    lowest = Math.max(lowest, b.top + b.height)
    highest = Math.min(highest, b.top)
  }
  const top = highest - SAFE.top
  const bottom = SAFE.bottom - lowest
  return Math.round(Math.abs(top - bottom))
}

interface Row {
  pattern: LayoutPattern
  variant: string
  elements: number
  issues: { level: string, message: string }[]
  coverage: number
  balance: number
}

const audit = (pattern: LayoutPattern, v: Variant): Row => {
  const palette = buildPalette(v.theme)
  const r = buildLayout(pattern, v.content, palette, `audit_${pattern}_${v.key}`)
  const slide: Slide = {
    id: `${pattern}_${v.key}`,
    elements: r.elements,
    animations: r.animations,
    background: r.background,
    type: r.slideType,
  }

  // 单页设计检查要放进一个 deck 才跑得起来，套一层单页 deck
  const issues = [...lintSlide(slide), ...lintDeckDesign([slide])]
    .map(i => ({ level: i.level, message: i.message }))

  return {
    pattern,
    variant: v.key,
    elements: r.elements.length,
    issues,
    coverage: coverage(slide),
    balance: verticalBalance(slide),
  }
}

const rows: Row[] = []
for (const pattern of LAYOUT_PATTERNS) {
  for (const v of variantsFor(pattern, LAYOUT_META[pattern].image, LAYOUT_META[pattern].itemImage)) rows.push(audit(pattern, v))
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(rows, null, 2))
}
else {
  const pad = (s: string, n: number) => {
    const w = [...s].reduce((a, ch) => a + (/[⺀-￯]/.test(ch) ? 2 : 1), 0)
    return s + ' '.repeat(Math.max(0, n - w))
  }

  console.log(`\n${pad('版式', 15)}${pad('变体', 14)}${pad('元素', 6)}${pad('内容占比', 10)}${pad('上下失衡', 10)}告警`)
  console.log('─'.repeat(92))
  for (const r of rows) {
    const errs = r.issues.filter(i => i.level === 'error').length
    const warns = r.issues.filter(i => i.level === 'warning').length
    const tag = errs ? `${errs} error ${warns} warn` : warns ? `${warns} warn` : '—'
    console.log(
      pad(r.pattern, 15) + pad(r.variant, 14) + pad(String(r.elements), 6)
      + pad(`${(r.coverage * 100).toFixed(0)}%`, 10)
      + pad(`${r.balance}`, 10) + tag,
    )
  }

  console.log(`\n${'═'.repeat(92)}\n告警明细\n${'═'.repeat(92)}`)
  let n = 0
  for (const r of rows) {
    for (const i of r.issues) {
      n++
      console.log(`  ${pad(`${r.pattern}/${r.variant}`, 26)}[${i.level}] ${i.message}`)
    }
  }
  if (!n) console.log('  ✓ 全部 0 告警')

  const empty = rows.filter(r => r.coverage < 0.35)
  console.log(`\n内容占比 < 35% 的样张（版面空洞）：${empty.length} / ${rows.length}`)
  for (const r of empty) console.log(`  ${pad(`${r.pattern}/${r.variant}`, 26)}${(r.coverage * 100).toFixed(0)}%`)

  // 理想是 8（光学底重），放宽到 60 —— 再大就是「内容掉在一头」了
  const lopsided = rows.filter(r => r.balance > 60)
  console.log(`\n上下留白失衡 > 60px 的样张（内容掉在一头）：${lopsided.length} / ${rows.length}`)
  for (const r of lopsided) console.log(`  ${pad(`${r.pattern}/${r.variant}`, 26)}${r.balance}px`)

  console.log(`\n合计 ${n} 条告警，涉及 ${rows.filter(r => r.issues.length).length} / ${rows.length} 张样张\n`)
}
