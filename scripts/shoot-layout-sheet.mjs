/**
 * 把版式样张联系表截成 PNG（开发工具，不参与打包）
 *
 *   npm i --no-save playwright-core   # 一次性，刻意不进 devDependencies
 *   npx vite --port 5199              # 另开一条命令起 dev server
 *   node scripts/shoot-layout-sheet.mjs
 *
 * 参数：
 *   --port 5199        dev server 端口
 *   --only bullets     只截某几个版式（逗号分隔）
 *   --variant image    只截某一种变体
 *   --size 480         单格宽度
 *   --out  <path>      输出路径（默认 samples/layout-sheet.png）
 *   --per-pattern      每个版式各存一张，而不是一整张长图
 *
 * ## 为什么用 127.0.0.1 而不是 localhost
 *
 * 这台机器的 `no_proxy` 把 localhost 拼成了 `locahost`，于是 `http://localhost`
 * 会走 HTTP_PROXY 回 502。curl 不受影响，所以这个坑只在脚本里露头（R-48 判断错过 ④）。
 */

/* eslint-env node */
/* eslint-disable no-console -- 命令行工具，输出就是它的产物 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir } from 'node:fs/promises'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = argv.indexOf(name)
  return i === -1 ? fallback : argv[i + 1]
}
const has = name => argv.includes(name)

const port = argOf('--port', '5199')
const only = argOf('--only', '')
const variant = argOf('--variant', '')
const size = argOf('--size', '480')
const perPattern = has('--per-pattern')

const query = new URLSearchParams()
if (only) query.set('only', only)
if (variant) query.set('variant', variant)
if (size) query.set('size', size)
const url = `http://127.0.0.1:${port}/layout-sheet.html${query.toString() ? `?${query}` : ''}`

let chromium
try {
  ({ chromium } = await import('playwright-core'))
}
catch {
  console.error('需要 playwright-core：npm i --no-save playwright-core')
  process.exit(1)
}

const browser = await chromium.launch()
// deviceScaleFactor 2：样张要看清 12px 的 caption 字号和 1px 描边，
// 1 倍图上这两样都糊成一团，看不出「层次拉开了没有」
const page = await browser.newPage({ viewport: { width: 1180, height: 1200 }, deviceScaleFactor: 2 })

const errors = []
page.on('console', m => {
  if (m.type() === 'error') errors.push(m.text()) 
})
page.on('pageerror', e => errors.push(String(e)))

await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 })

// networkidle 只保证请求结束，不保证图片解码完 —— 页面自己给了个 ready 钩子
const stat = await page.evaluate(() => window.__sheetReady())
console.log(`样张 ${stat.cells} 张 · 图片 ${stat.images} 张`)
if (stat.broken.length) {
  // 挂掉的图在联系表上是一块白，看起来完全像「这个版式本来就长这样」—— 必须显式报
  console.error(`✗ ${stat.broken.length} 张图没加载出来：`)
  for (const s of stat.broken) console.error(`    ${s}`)
}
if (errors.length) {
  console.error(`✗ ${errors.length} 条控制台错误：`)
  for (const e of errors.slice(0, 10)) console.error(`    ${e}`)
}

await mkdir(path.join(ROOT, 'samples'), { recursive: true })

if (perPattern) {
  const sections = await page.locator('section.row').all()
  for (const section of sections) {
    const name = await section.locator('h2 .pat').innerText()
    const out = path.join(ROOT, `samples/layout-${name}.png`)
    await section.screenshot({ path: out })
    console.log(`→ ${path.relative(ROOT, out)}`)
  }
}
else {
  const out = path.resolve(ROOT, argOf('--out', 'samples/layout-sheet.png'))
  await page.screenshot({ path: out, fullPage: true })
  console.log(`→ ${path.relative(ROOT, out)}`)
}

await browser.close()
process.exit(stat.broken.length || errors.length ? 1 : 0)
