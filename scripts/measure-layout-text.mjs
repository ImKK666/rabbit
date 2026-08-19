/**
 * 量「估出来的文本高度」和「真正渲染出来的高度」差多少（开发工具，不参与打包）
 *
 *   npx vite --port 5199                     # 另开一条命令
 *   node scripts/measure-layout-text.mjs
 *
 * ## 为什么需要它
 *
 * `design.ts` 的 `estimateTextHeight` 是**估**的：按 CJK 全宽算字数、除以框宽得行数。
 * 版式引擎拿这个估值往下累加 `y`，决定下一个元素放哪。估小了，下一个元素就压上来。
 *
 * 而这件事**现有的检查一条都看不见**：
 *   - `Builder.text()` 会把框高夹进画布（`Math.min(box.height, …)`），
 *     所以 `lintSlide` 的「超出画布」永远不会响 —— 框永远在画布内
 *   - 重叠检查比的是**声明的框**，而溢出发生在框**外面**（PPTist 不裁剪文本）
 *
 * 于是 66 张样张跑下来 **0 告警**，其中好几张我肉眼就能看到文字压在一起。
 * 这正是 R-39 那句话的复现：**没被写成判据的东西，从来就没立起来过。**
 *
 * 判据在这里能立起来，是因为换了个量法：不问「框在哪」，问**「字画到哪了」**。
 * 和 R-36 用逐帧采样代替肉眼、R-41 用联系表代替读 path 是同一件事。
 *
 * ## 量的是什么
 *
 * 每个文本元素两个数：
 *   declared  元素声明的 height（版式引擎算出来的那个）
 *   actual    `.text` 节点的 offsetHeight（浏览器真正排完的高度，逻辑像素）
 *
 * `offsetHeight` 不受祖先的 CSS transform 影响，所以缩略图缩放不用换算。
 */

/* eslint-env node */
/* eslint-disable no-console -- 命令行工具，输出就是它的产物 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFile, mkdir } from 'node:fs/promises'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const argv = process.argv.slice(2)
const argOf = (n, d) => {
  const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1] 
}

const port = argOf('--port', '5199')
/** 超过这个像素数才算「真的溢出」—— 1~2px 是行高取整的正常抖动 */
const TOLERANCE = Number(argOf('--tolerance', '4'))

let chromium
try {
  ({ chromium } = await import('playwright-core')) 
}
catch {
  console.error('需要 playwright-core：npm i --no-save playwright-core'); process.exit(1) 
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1180, height: 1200 } })
await page.goto(`http://127.0.0.1:${port}/layout-sheet.html`, { waitUntil: 'networkidle', timeout: 60000 })
await page.evaluate(() => window.__sheetReady())

const rows = await page.evaluate(() => {
  const out = []
  for (const fig of document.querySelectorAll('figure.cell')) {
    const label = fig.querySelector('figcaption b')?.textContent ?? '?'
    // 版式名在这一行的表头里
    const pattern = fig.closest('section.row')?.querySelector('h2 .pat')?.textContent ?? '?'

    for (const el of fig.querySelectorAll('.base-element-text')) {
      const declared = parseFloat(el.style.height)
      const inner = el.querySelector('.text')
      if (!inner) continue
      const actual = inner.offsetHeight
      const text = (inner.textContent || '').replace(/\s+/g, ' ').trim()
      out.push({ pattern, variant: label, declared, actual, text: text.slice(0, 30) })
    }
  }
  return out
})

await browser.close()

const over = rows
  .filter(r => r.actual - r.declared > TOLERANCE)
  .sort((a, b) => (b.actual - b.declared) - (a.actual - a.declared))

const pad = (s, n) => {
  const w = [...String(s)].reduce((a, ch) => a + (/[⺀-￯]/.test(ch) ? 2 : 1), 0)
  return String(s) + ' '.repeat(Math.max(0, n - w))
}

console.log(`\n量了 ${rows.length} 个文本元素，${over.length} 个渲染高度超过声明高度（容差 ${TOLERANCE}px）\n`)
console.log(`${pad('版式', 14)}${pad('变体', 16)}${pad('声明', 7)}${pad('实际', 7)}${pad('溢出', 7)}内容`)
console.log('─'.repeat(96))
for (const r of over) {
  console.log(
    pad(r.pattern, 14) + pad(r.variant, 16) + pad(r.declared.toFixed(0), 7)
    + pad(String(r.actual), 7) + pad(`+${(r.actual - r.declared).toFixed(0)}`, 7) + r.text,
  )
}

// 按版式/变体汇总，好知道该先修哪一个
const byCell = new Map()
for (const r of over) {
  const k = `${r.pattern}/${r.variant}`
  byCell.set(k, (byCell.get(k) ?? 0) + 1)
}
console.log(`\n受影响的样张：${byCell.size} 张`)
for (const [k, n] of [...byCell].sort((a, b) => b[1] - a[1])) console.log(`  ${pad(k, 34)}${n} 处`)

await mkdir(path.join(ROOT, 'samples'), { recursive: true })
await writeFile(path.join(ROOT, 'samples/layout-text-overflow.json'), JSON.stringify({ tolerance: TOLERANCE, total: rows.length, over }, null, 2))
console.log('\n→ samples/layout-text-overflow.json')

process.exit(over.length ? 1 : 0)
