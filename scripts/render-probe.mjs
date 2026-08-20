/**
 * 无头跑一遍离屏测量探针（开发工具，不参与打包）
 *
 *   npm i --no-save playwright-core   # 一次性，刻意不进 devDependencies
 *   npx vite --port 5199              # 另开一条命令起 dev server
 *   node scripts/render-probe.mjs
 *
 * 判据 R3（docs/13 §三）：离屏渲染量出来的高度，必须和正常渲染逐个元素一致。
 * 不一致就说明 `src/utils/renderMeasure.ts` 量的不是用户看到的那份东西 ——
 * 而它坏掉时**不会报错**，只会安静地报告「一切正常」。
 *
 * 用 127.0.0.1 不用 localhost：这台机器的 no_proxy 把 localhost 拼错了，
 * `http://localhost` 会走 HTTP_PROXY 回 502（R-48 判断错过 ④）。
 */

/* eslint-env node */
/* eslint-disable no-console -- 命令行工具，输出就是它的产物 */

const argv = process.argv.slice(2)
const argOf = (n, d) => {
  const i = argv.indexOf(n)
  return i === -1 ? d : argv[i + 1]
}

const port = argOf('--port', '5199')
const variant = argOf('--variant', 'dense')
const bad = argv.includes('--bad') ? '&bad=1' : ''
const url = `http://127.0.0.1:${port}/render-probe.html?variant=${variant}${bad}`

let chromium
try {
  ({ chromium } = await import('playwright-core'))
}
catch {
  console.error('需要 playwright-core：npm i --no-save playwright-core')
  process.exit(1)
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })

page.on('console', (m) => {
  if (m.type() === 'error') console.error('[页面 console.error]', m.text())
})
page.on('pageerror', e => console.error('[页面异常]', e.message))

await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 })

const result = await page.waitForFunction(
  () => window.__probeResult,
  null,
  { timeout: 60000 },
).then(h => h.jsonValue())

await browser.close()

const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length))

console.log(`\n离屏测量探针 · variant=${variant}\n${'─'.repeat(60)}`)
console.log(`${pad('页数', 22)}${result.slides}`)
console.log(`${pad('正常渲染量到', 20)}${result.onscreenCount} 个文本元素`)
console.log(`${pad('离屏渲染量到', 20)}${result.offscreenCount} 个`)
console.log(`${pad('对不上的', 22)}${result.mismatched} 个`)
console.log(`${pad('离屏没量到的', 20)}${result.missing} 个`)
console.log(`${pad('离屏全是 0', 21)}${result.allZero ? '是 ← 离屏那条路坏了' : '否'}`)
console.log(`${pad('截图（视觉复核的输入）', 14)}${result.shotOk ? `✅ ${(result.shotBytes / 1024).toFixed(0)} KB` : '❌ 截不出来'}`)

// --shot-out <path>：把第一页的截图存下来，给视觉复核的端到端实测当输入
const shotOut = argOf('--shot-out', '')
if (shotOut && result.shotDataUrl) {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(shotOut, result.shotDataUrl, 'utf8')
  console.log(`\n截图已存到 ${shotOut}`)
}

// --slide-out <path>：把被截那一页的 slide JSON 也存下来。
// 和截图成对出去，端到端实测里「库里那页」和「模型看到的图」就不可能对不上
const slideOut = argOf('--slide-out', '')
if (slideOut && result.shotSlideJson) {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(slideOut, result.shotSlideJson, 'utf8')
  console.log(`slide JSON 已存到 ${slideOut}`)
}
console.log(`\n顺带：版式引擎估小的（溢出 >4px）${result.overflowing} 处`)

if (result.mismatchSamples?.length) {
  console.log('\n对不上的样本：')
  for (const s of result.mismatchSamples) {
    console.log(`  ${s.slideId} ${s.elementId}  onscreen=${s.actualHeight} offscreen=${s.offscreen}`)
  }
}

console.log(`\n${result.ok ? '✅ R3 通过：离屏渲染与正常渲染逐个元素一致' : '❌ R3 不通过'}`)
process.exit(result.ok ? 0 : 1)
