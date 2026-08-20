/**
 * 逐字体量字宽表（开发工具，不参与打包）—— 驱动这一半
 *
 *   npm i --no-save playwright-core   # 一次性，刻意不进 devDependencies
 *   npx vite --port 5199              # 另开一条命令起 dev server
 *   node scripts/measure-char-width.mjs
 *
 * 浏览器那一半在 `scripts/char-width-probe.ts`，量法的说明也在那儿。
 * 这里只做三件事：**自证量法、查偷偷 fallback、输出能直接贴进代码的表**。
 *
 * 用 127.0.0.1 不用 localhost：这台机器的 no_proxy 把 localhost 拼错了，
 * `http://localhost` 会走 HTTP_PROXY 回 502（沿用 render-probe.mjs 的说明）。
 */

/* eslint-env node */
/* eslint-disable no-console -- 命令行工具，输出就是它的产物 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFile, mkdir } from 'node:fs/promises'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const argv = process.argv.slice(2)
const argOf = (n, d) => {
  const i = argv.indexOf(n)
  return i === -1 ? d : argv[i + 1]
}
const port = argOf('--port', '5199')

/**
 * `design.ts` 头注释里那张**实测**表（不是 CHAR_WIDTH 本身 ——
 * CHAR_WIDTH 是在实测值上又留了余量的）。
 *
 * 这是量法自证的靶子：我的量法如果和当初一致，量 `__fallback__` 就该落在这些数附近。
 *
 * **`lower` 的靶子是 0.471 而不是 CHAR_WIDTH 里的 0.56。**
 * 第一版我设成 0.56，理由是注释里写着真实词 `Webhook` 每字符 0.575。
 * 但 `Webhook` 的 W 是**大写** —— 那 0.575 是「混合大小写词」的口径，
 * 而 `charWidth()` 是逐字符分类的（`ch >= 'a' && ch <= 'z'` → `lower`）。
 * 也就是说 **CHAR_WIDTH.lower = 0.56 是在纯小写实测 0.471 上主动加的 19% 余量**，
 * 方向是安全的（估宽 → 多算行 → 框留高 → 不压字）。靶子该对着实测值。
 */
const FALLBACK_EXPECTED = {
  cjk: { value: 1.000, tol: 0.02, note: '汉字，em 方块' },
  cjkPunct: { value: 0.778, tol: 0.06, note: '全角标点' },
  upper: { value: 0.630, tol: 0.06, note: '大写' },
  digit: { value: 0.577, tol: 0.05, note: '数字' },
  lower: { value: 0.471, tol: 0.05, note: '小写（纯 a~z，CHAR_WIDTH 的 0.56 是加了余量的）' },
  asciiPunct: { value: 0.299, tol: 0.08, note: 'ASCII 标点' },
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
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
page.on('pageerror', e => console.error('[页面异常]', e.message))

const url = `http://127.0.0.1:${port}/char-width-probe.html`
try {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 })
}
catch {
  console.error(`打不开 ${url} —— dev server 起了吗？  npx vite --port ${port}`)
  await browser.close()
  process.exit(1)
}

const tables = await page
  .waitForFunction(() => window.__charWidth, null, { timeout: 120000 })
  .then(h => h.jsonValue())
await browser.close()

const pad = (s, n) => {
  const w = [...String(s)].reduce((a, ch) => a + (/[⺀-￯]/.test(ch) ? 2 : 1), 0)
  return String(s) + ' '.repeat(Math.max(0, n - w))
}

const CLASSES = ['cjk', 'cjkPunct', 'upper', 'digit', 'lower', 'asciiPunct', 'space']

// ── 门 ①：量法自证 ───────────────────────────────────────────────
const fallback = tables.find(t => t.font === '__fallback__')
if (!fallback) {
  console.error('没量到 __fallback__，量法自证做不了')
  process.exit(1)
}

console.log('\n量法自证 · __fallback__（$textElementFont 系统栈）')
console.log('─'.repeat(74))
console.log(`${pad('分量', 12)}${pad('这次量到', 11)}${pad('design.ts 实测', 16)}${pad('差', 9)}判定`)
let selfCheckFailed = 0
for (const [cls, exp] of Object.entries(FALLBACK_EXPECTED)) {
  const got = fallback.widths[cls]
  const diff = got - exp.value
  const ok = Math.abs(diff) <= exp.tol
  if (!ok) selfCheckFailed++
  console.log(
    pad(cls, 12) + pad(got.toFixed(3), 11) + pad(exp.value.toFixed(3), 16)
    + pad((diff >= 0 ? '+' : '') + diff.toFixed(3), 9)
    + (ok ? '✅' : `❌ 超出容差 ${exp.tol}`) + `  ${exp.note}`,
  )
}

// ── 门 ②：有没有偷偷 fallback ────────────────────────────────────
const real = tables.filter(t => t.font !== '__fallback__')
const notLoaded = real.filter(t => !t.loaded)
const byProbe = new Map()
for (const t of tables) {
  const k = t.probeWidth.toFixed(2)
  byProbe.set(k, [...(byProbe.get(k) ?? []), t.font])
}
const collisions = [...byProbe.values()].filter(v => v.length > 1)

console.log('\n字体加载 · 有没有偷偷用 fallback')
console.log('─'.repeat(74))
console.log(`${pad('字体', 20)}${pad('加载', 7)}${pad('探针宽(px)', 13)}${pad('数字极差', 11)}判定`)
for (const t of real) {
  const dup = collisions.find(c => c.includes(t.font))
  console.log(
    pad(t.font, 20) + pad(t.loaded ? '✓' : '✗', 7)
    + pad(t.probeWidth.toFixed(1), 13)
    + pad(t.digitSpread < 0.001 ? '等宽' : t.digitSpread.toFixed(3), 11)
    + (!t.loaded ? '❌ 没加载成' : dup ? `❌ 探针宽和 ${dup.filter(f => f !== t.font).join('/')} 撞了` : '✅'),
  )
}

// ── 全表 ─────────────────────────────────────────────────────────
console.log('\n全表（单位 em）')
console.log('─'.repeat(74))
console.log(pad('字体', 20) + CLASSES.map(c => pad(c, 11)).join(''))
for (const t of tables) {
  console.log(pad(t.font, 20) + CLASSES.map(c => pad(t.widths[c].toFixed(3), 11)).join(''))
}

// ── 观测：孤儿标点被错分成 asciiPunct 的代价 ─────────────────────
//
// “”‘’—…· 的码位不在 CJK_PUNCT_RANGE（U+3000-303F, U+FF00-FFEF）里，
// charWidth() 把它们判成 asciiPunct。中文文稿里这几个到处都是。
console.log('\n观测 · 孤儿标点（“”‘’—…·）被按 asciiPunct 估的代价')
console.log('─'.repeat(74))
console.log(`${pad('字体', 20)}${pad('实际宽', 11)}${pad('按哪个估', 11)}${pad('每个少算', 11)}倍数`)
for (const t of tables) {
  const actual = t.orphanPunct
  const assumed = t.widths.asciiPunct
  console.log(
    pad(t.font, 20) + pad(actual.toFixed(3), 11) + pad(assumed.toFixed(3), 11)
    + pad((actual - assumed).toFixed(3), 11) + `${(actual / assumed).toFixed(2)}×`,
  )
}

// ── 输出能贴进 design.ts 的源码 ──────────────────────────────────
const src = real.map((t) => {
  const body = CLASSES.map(c => `    ${c}: ${t.widths[c].toFixed(3)},`).join('\n')
  return `  ${t.font}: {\n${body}\n  },`
}).join('\n')
const code = `// 由 npm run char-width 量出，勿手改。量法见 scripts/char-width-probe.ts\nconst CHAR_WIDTH_BY_FONT = {\n${src}\n} as const\n`

await mkdir(path.join(ROOT, 'samples'), { recursive: true })
await writeFile(path.join(ROOT, 'samples/char-width.json'), JSON.stringify(tables, null, 2))
await writeFile(path.join(ROOT, 'samples/char-width.ts.txt'), code)
console.log('\n→ samples/char-width.json')
console.log('→ samples/char-width.ts.txt（可直接贴进 design.ts）')

const bad = selfCheckFailed + notLoaded.length + collisions.length
console.log(
  `\n${bad === 0
    ? '✅ 量法自证通过，8 个字体各不相同且都真的加载了'
    : `❌ ${selfCheckFailed} 个分量对不上实测表 · ${notLoaded.length} 个字体没加载成 · ${collisions.length} 组探针宽撞车`}`,
)
process.exit(bad === 0 ? 0 : 1)
