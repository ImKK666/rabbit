/**
 * 把形状联系表截成 PNG（开发工具，不参与打包）
 *
 *   npm i --no-save playwright-core   # 一次性，刻意不进 devDependencies
 *   npm run shapes                    # 先生成 HTML
 *   node scripts/shoot-shape-sheet.mjs
 *
 * 为什么要 PNG 而不是直接开 HTML：命名这件事需要**把 51 个字形并排看**，
 * 而 PNG 可以贴进对话、可以存档、可以让模型自己读图。
 * 和 `measure-animation-lab.mjs` 一样，playwright-core 是按需装的，不进依赖表。
 *
 * 参数：
 *   --group 3      只截某一个分类（默认整页）
 *   --out  <path>  输出路径
 */

/* eslint-env node */
/* eslint-disable no-console -- 命令行工具，输出就是它的产物 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { access } from 'node:fs/promises'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const SHEET = path.join(ROOT, 'samples/shape-sheet.html')

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = argv.indexOf(name)
  return i === -1 ? fallback : argv[i + 1]
}

const group = argOf('--group', null)
const out = path.resolve(ROOT, argOf('--out', group === null
  ? 'samples/shape-sheet.png'
  : `samples/shape-sheet-g${group}.png`))

try {
  await access(SHEET)
}
catch {
  console.error('先跑 npm run shapes 生成 samples/shape-sheet.html')
  process.exit(1)
}

let chromium
try {
  ({ chromium } = await import('playwright-core'))
}
catch {
  console.error('需要 playwright-core：npm i --no-save playwright-core')
  process.exit(1)
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 2 })
await page.goto(pathToFileURL(SHEET).href)
await page.waitForLoadState('networkidle')

// 截图前把「已命名压暗」还原 —— 存档用的图要看得清全部
await page.addStyleTag({ content: '.cell.named { opacity: 1 !important; }' })

const target = group === null ? page : page.locator(`section:nth-of-type(${Number(group) + 1})`)
await target.screenshot({ path: out, ...(group === null ? { fullPage: true } : {}) })

await browser.close()
console.log(`→ ${path.relative(ROOT, out)}`)
