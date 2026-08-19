/**
 * 形状拼版（开发工具，不参与打包）
 *
 *   npm run shapes            → samples/shape-sheet.html（自包含，双击即可看）
 *   node scripts/shoot-shape-sheet.mjs   → 顺带截成 PNG
 *
 * ## 为什么要它
 *
 * `configs/shapes.ts` 有 151 个形状，其中「其他形状」「线性」两类共 51 个是
 * **1024 viewBox 的图标字形**（云、锁、灯泡……）。R-27 给形状起语义名时把它们跳过了，
 * 理由写在 `shapeCatalog.ts` 的注释里：「光看 path 无法可靠命名，猜错名字比没有更糟」。
 *
 * 那句话是对的 —— 但结论下早了。看不出来是因为**没有把它们画出来看**。
 * 一个 500 字符的贝塞尔串人眼读不出是云还是锁，渲染成 64px 的图形就一目了然。
 *
 * 所以这个工具只做一件事：把每个形状按 `pick(分类下标, 条目下标)` 的坐标标好，
 * 铺成一张联系表。命名靠看图，不靠猜 path。
 *
 * ## 输出里有什么
 *
 * 每格 = 一个形状 + 它的 `pick()` 坐标 + viewBox + 是否已收进 shapeCatalog。
 * 已收录的会显示语义名，未收录的留空 —— 一眼就能看出还剩哪些没起名。
 */

/* eslint-disable no-console -- 命令行生成器，输出就是它的产物 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SHAPE_LIST, type ShapePoolItem } from '../src/configs/shapes'
import { SHAPE_CATALOG } from '../src/configs/shapeCatalog'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const OUT_FILE = path.join(ROOT, 'samples/shape-sheet.html')

/** 上游的分类没有可读名字（ShapeListItem.type 是 'shape'），按下标手工标注 */
const GROUP_LABELS = ['矩形', '常用形状', '箭头', '其他形状', '线性']

/** pick(g, c) → 已收录的语义名 */
const named = new Map<string, { key: string, name: string }>()
for (const s of Object.values(SHAPE_CATALOG)) {
  for (const [gi, group] of SHAPE_LIST.entries()) {
    const ci = group.children.indexOf(s.item)
    if (ci !== -1) named.set(`${gi},${ci}`, { key: s.key, name: s.name })
  }
}

const cell = (item: ShapePoolItem, gi: number, ci: number): string => {
  const hit = named.get(`${gi},${ci}`)
  const [vw, vh] = item.viewBox
  return `
    <figure class="cell${hit ? ' named' : ''}">
      <svg viewBox="0 0 ${vw} ${vh}" preserveAspectRatio="xMidYMid meet">
        <path d="${item.path}" />
      </svg>
      <figcaption>
        <b>${gi},${ci}</b>
        <span class="vb">${vw}</span>
        <em>${hit ? hit.key : ''}</em>
      </figcaption>
    </figure>`
}

const section = (gi: number): string => {
  const group = SHAPE_LIST[gi]
  const total = group.children.length
  const done = group.children.filter((_, ci) => named.has(`${gi},${ci}`)).length
  return `
  <section>
    <h2>[${gi}] ${GROUP_LABELS[gi] ?? '未知分类'}
      <small>${total} 个 · 已命名 ${done} · 待命名 ${total - done}</small>
    </h2>
    <div class="grid">${group.children.map((c, ci) => cell(c, gi, ci)).join('')}</div>
  </section>`
}

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>形状联系表 · Rabbit</title>
<style>
  :root { color-scheme: light; }
  body {
    margin: 0; padding: 24px 28px 60px;
    font: 13px/1.5 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
    background: #f6f7f9; color: #1a1a1a;
  }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .intro { color: #666; margin: 0 0 24px; }
  section { margin-bottom: 28px; }
  h2 {
    font-size: 15px; margin: 0 0 10px; padding-bottom: 6px;
    border-bottom: 2px solid #d14424;
  }
  h2 small { font-weight: 400; color: #888; margin-left: 10px; font-size: 12px; }
  .grid { display: grid; grid-template-columns: repeat(12, 1fr); gap: 8px; }
  .cell {
    margin: 0; background: #fff; border: 1px solid #e3e5e8; border-radius: 6px;
    padding: 8px 4px 4px; text-align: center;
  }
  /* 已收进 shapeCatalog 的压暗，让待命名的那些跳出来 */
  .cell.named { background: #eef0f2; opacity: .45; }
  .cell svg { width: 100%; height: 46px; display: block; }
  .cell svg path { fill: #2f3439; }
  figcaption { margin-top: 4px; font-size: 10px; line-height: 1.35; }
  figcaption b { color: #d14424; font-weight: 700; }
  figcaption .vb { color: #aaa; margin-left: 3px; }
  figcaption em { display: block; font-style: normal; color: #555; min-height: 12px; }
</style>
</head>
<body>
  <h1>形状联系表</h1>
  <p class="intro">
    每格标的是 <code>pick(分类下标, 条目下标)</code> —— 直接抄进 <code>shapeCatalog.ts</code>。
    压暗的是已经收录的，正常显示的是还没起名的。
  </p>
  ${SHAPE_LIST.map((_, gi) => section(gi)).join('')}
</body>
</html>`

await mkdir(path.dirname(OUT_FILE), { recursive: true })
await writeFile(OUT_FILE, html, 'utf8')

const total = SHAPE_LIST.reduce((n, g) => n + g.children.length, 0)
console.log(`形状 ${total} 个，已命名 ${named.size}，待命名 ${total - named.size}`)
console.log(`→ ${path.relative(ROOT, OUT_FILE)}`)
