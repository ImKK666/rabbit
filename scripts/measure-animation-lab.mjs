/**
 * 动画实验台的无头采样器（开发工具，不参与打包、不是 npm 依赖）
 *
 *   一次性准备：
 *     npm i --no-save playwright-core && npx playwright-core install chromium
 *   跑：
 *     npm run lab && node scripts/measure-animation-lab.mjs
 *
 * ## 它回答的问题
 *
 * 「45 个类都有定义」是静态就能查的，`npm run lab` 生成的页面也只能回答
 * 「肉眼看着像不像」。真正难判的是这三条，都得逐帧采样才知道：
 *
 *   1. **到底动没动** —— @property 没注册 / mask 写错时，元素会安静地
 *      停在起点或终点，看起来就像「动画很快」
 *   2. **是补间还是硬切** —— clip-path 起止点数不一致会退化成离散切换，
 *      单看首尾帧完全正常
 *   3. **方向对不对** —— 「自左淡入」到底是从左边进来还是往左边出去，
 *      靠可见像素的重心位移能测出来，靠读 keyframes 容易读反
 *
 * 做法：把每个效果 seek 到 0 / 25% / 50% / 75% / 100%，整页各截一张图，
 * 按卡片位置裁出色块区域，算两个标量 ——
 *   coverage 可见黑色占比（0=不可见，1=铺满），能同时反映 mask / clip-path / opacity / 缩放
 *   centroid  可见像素重心（归一化到 -1~1），反映位移方向
 *
 * PNG 解码是手写的（约 60 行，只支持 Chromium 截图那一种：8bit / 非隔行），
 * 为的是除 playwright-core 外不引第三方依赖 —— 这脚本是排查用的，
 * 不该为它给整个项目加一条 devDependency。
 */

/* eslint-env node */
/* eslint-disable no-console -- 命令行报告工具，输出就是它的产物 */
import { inflateSync } from 'node:zlib'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const LAB = path.join(ROOT, 'samples/animation-lab.html')
const DUR = 1000
/** 11 个采样点。5 个不够：backInUp 有 80% 的行程发生在前半段，粗采样会把它读成「硬切换」 */
const FRACTIONS = Array.from({ length: 11 }, (_, i) => i / 10)

// ---------------------------------------------------------------------------
// 最小 PNG 解码：签名 → 逐 chunk → IDAT 拼接 inflate → 逐行反滤波
// ---------------------------------------------------------------------------

const paeth = (a, b, c) => {
  const p = a + b - c
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

const decodePng = (buf) => {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG')

  let pos = 8
  let width = 0, height = 0, channels = 0
  const idat = []

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)

    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      const bitDepth = data[8]
      const colorType = data[9]
      if (bitDepth !== 8) throw new Error(`只支持 8bit，拿到 ${bitDepth}`)
      if (data[12] !== 0) throw new Error('不支持隔行 PNG')
      channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType]
      if (!channels) throw new Error(`不支持的 colorType ${colorType}`)
    }
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break

    pos += 12 + len
  }

  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(height * stride)

  // a=左邻 b=上邻 c=左上邻，PNG 五种滤波器都是拿这三个做预测再补差值
  const unfilter = (filter, x, a, b, c) => {
    switch (filter) {
      case 0: return x
      case 1: return x + a
      case 2: return x + b
      case 3: return x + ((a + b) >> 1)
      case 4: return x + paeth(a, b, c)
      default: throw new Error(`未知滤波器 ${filter}`)
    }
  }

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const cur = out.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null

    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0
      const b = prev ? prev[i] : 0
      const c = prev && i >= channels ? prev[i - channels] : 0
      cur[i] = unfilter(filter, src[i], a, b, c) & 0xff
    }
  }

  return { width, height, channels, data: out }
}

/**
 * 在一张整页截图里裁出某个矩形，算可见黑色占比和重心。
 * 色块是纯黑、底是纯白（测量模式），所以「暗度」= 该像素被覆盖的程度，
 * 半透明、被 mask 挖掉、被 clip-path 裁掉，在这个标量上是同一件事 —— 正好。
 */
const analyze = (png, box) => {
  const x0 = Math.max(0, Math.round(box.x))
  const y0 = Math.max(0, Math.round(box.y))
  const x1 = Math.min(png.width, Math.round(box.x + box.width))
  const y1 = Math.min(png.height, Math.round(box.y + box.height))

  let sum = 0, sx = 0, sy = 0, n = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * png.width + x) * png.channels
      const lum = 0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2]
      const dark = (255 - lum) / 255
      sum += dark
      sx += dark * (x - x0)
      sy += dark * (y - y0)
      n++
    }
  }

  const w = x1 - x0, h = y1 - y0
  return {
    coverage: n ? sum / n : 0,
    // 归一化到 -1~1：0 是正中，负数偏左/偏上
    cx: sum > 1e-6 ? ((sx / sum) / w) * 2 - 1 : 0,
    cy: sum > 1e-6 ? ((sy / sum) / h) * 2 - 1 : 0,
  }
}

// ---------------------------------------------------------------------------
// 判读
// ---------------------------------------------------------------------------

const r2 = (v) => Math.round(v * 100) / 100

/**
 * 「离静止态有多远」——把一帧压成一个标量。
 *
 * 不能只看 coverage：slideInLeft 是纯位移，全程完全不透明，coverage 几乎不变，
 * 只有重心在动。也不能只看重心：fadeIn 原地淡入，重心纹丝不动。
 * 两个加起来才盖得住 45 个效果的全部机制（遮罩 / 裁剪 / 透明度 / 位移 / 缩放 / 旋转）。
 *
 * 静止态 = 不施加任何动画类时的样子，逐卡片实测，不写死。
 */
const distanceFrom = (rest, s) =>
  Math.abs(s.coverage - rest.coverage) / Math.max(rest.coverage, 0.01)
  + Math.abs(s.cx - rest.cx)
  + Math.abs(s.cy - rest.cy)

/** 静止态的判定阈值。抗锯齿噪声实测在 0.005 以下，留一个数量级余量 */
const AT_REST = 0.05
const MOVED = 0.02

/**
 * 三类效果各有各的「正常」：
 *   入场  起点必须离静止态足够远（不管靠透明度还是靠位移），终点必须回到静止态
 *   退场  起点在静止态，终点必须真的看不见了
 *   强调  首尾都必须在静止态（不能停在放大 / 半透明 / 转了一半），中途要有变化
 */
const verdict = (entry, rest, samples) => {
  const dist = samples.map(s => distanceFrom(rest, s))
  const first = dist[0], last = dist[dist.length - 1]
  const problems = []

  if (entry.anims === 0) problems.push('没有任何 CSS 动画在跑（类名没匹配到 keyframes）')

  if (entry.type === 'in') {
    if (first < 0.2) problems.push(`起点几乎就是终态（偏离 ${r2(first)}），入场等于没播`)
    if (last > AT_REST) problems.push(`终点偏离静止态 ${r2(last)}，播完元素没有回到正常样子`)
  }
  else if (entry.type === 'out') {
    if (first > AT_REST) problems.push(`起点就偏离静止态 ${r2(first)}，退场起手元素已经不对了`)
    const vis = samples[samples.length - 1].coverage / Math.max(rest.coverage, 0.01)
    if (vis > 0.06) problems.push(`终点还剩 ${r2(vis)} 可见，退场播完元素没有消失`)
  }
  else {
    if (first > AT_REST) problems.push(`起点偏离静止态 ${r2(first)}，强调不该改变初始样子`)
    if (last > AT_REST) problems.push(`终点偏离静止态 ${r2(last)}，强调没有回到原状`)
    if (Math.max(...dist.slice(1, -1)) < MOVED) problems.push('中途没有任何可见变化')
  }

  // 补间检测：clip-path 起止点数不一致会退化成离散切换，首尾帧看着完全正常，
  // 只有中间帧能揭穿 —— 全都贴在两端就是硬切
  const span = Math.max(first, last)
  if (span > 0.2) {
    const between = dist.slice(1, -1).filter(d => d > span * 0.15 && d < span * 0.85)
    if (!between.length) problems.push('所有中间帧都贴着两端 —— 是硬切换，不是补间')
  }

  return problems
}

// ---------------------------------------------------------------------------

const main = async () => {
  if (!existsSync(LAB)) throw new Error(`找不到 ${LAB}，先跑 npm run lab`)

  let chromium
  try {
    ({ chromium } = await import('playwright-core'))
  }
  catch {
    console.error('需要 playwright-core：npm i --no-save playwright-core && npx playwright-core install chromium')
    process.exit(1)
  }

  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 })
  await page.goto(`${pathToFileURL(LAB).href}?measure=1`)
  await page.waitForFunction('!!window.__lab')

  const entries = await page.evaluate(() => window.__lab.entries)

  const boxes = await page.evaluate(() => {
    window.__lab.stopLoop()
    window.__lab.clearAll()
    const out = {}
    document.querySelectorAll('.card').forEach(card => {
      const r = card.querySelector('.stage').getBoundingClientRect()
      out[card.dataset.effect] = { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height }
    })
    return out
  })

  // 静止态基准：不加任何动画类时每个卡片长什么样。所有判读都相对它，
  // 这样舞台尺寸、色块比例、抗锯齿怎么变都不影响结论
  const restPng = decodePng(await page.screenshot({ fullPage: true }))
  const rest = Object.fromEntries(entries.map(e => [e.value, analyze(restPng, boxes[e.value])]))

  // 全部 arm 住（暂停在 t=0），之后统一 seek，一个进度点只截一张整页图
  const armed = await page.evaluate((dur) => {
    return window.__lab.entries.map(e => ({ value: e.value, anims: window.__lab.arm(e.value, dur) }))
  }, DUR)
  const animCount = Object.fromEntries(armed.map(a => [a.value, a.anims]))

  const samples = {}
  for (const e of entries) samples[e.value] = []

  for (const f of FRACTIONS) {
    await page.evaluate(({ f, dur }) => {
      window.__lab.entries.forEach(e => window.__lab.seek(e.value, f, dur))
    }, { f, dur: DUR })
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))

    const png = decodePng(await page.screenshot({ fullPage: true }))
    for (const e of entries) samples[e.value].push(analyze(png, boxes[e.value]))
  }

  // 走真实播放路径播完（含 animationend 清理），看最终停在什么状态：
  // 入场应当类名尽去、回到裸样式；退场应当保留终态、元素不可见
  const after = await page.evaluate(async (dur) => {
    const out = {}
    for (const e of window.__lab.entries) {
      await window.__lab.finish(e.value, dur)
      out[e.value] = window.__lab.styleOf(e.value)
    }
    return out
  }, DUR)

  await browser.close()

  const rows = entries.map(e => {
    const s = samples[e.value]
    const entry = { ...e, anims: animCount[e.value] }
    return {
      value: e.value,
      name: e.name,
      type: e.type,
      cssExact: e.cssExact,
      anims: animCount[e.value],
      rest: { coverage: r2(rest[e.value].coverage), cx: r2(rest[e.value].cx), cy: r2(rest[e.value].cy) },
      /** 相对静止态的可见比例：1 = 和不加动画时一样，0 = 完全看不见 */
      visible: s.map(x => r2(x.coverage / Math.max(rest[e.value].coverage, 0.01))),
      centroid: s.map(x => [r2(x.cx), r2(x.cy)]),
      dist: s.map(x => r2(distanceFrom(rest[e.value], x))),
      afterEnd: after[e.value],
      problems: verdict(entry, rest[e.value], s),
    }
  })

  console.log(JSON.stringify({ duration: DUR, fractions: FRACTIONS, rows }, null, 1))

  const bad = rows.filter(r => r.problems.length)
  console.error(`\n${rows.length} 个效果，${bad.length} 个有问题`)
  for (const r of bad) console.error(`  ✗ ${r.value.padEnd(20)} ${r.problems.join(' / ')}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
