/**
 * 动画实验台生成器（开发工具，不参与打包）
 *
 *   npm run lab      → samples/animation-lab.html（自包含，双击即可打开）
 *
 * ## 为什么要它
 *
 * R-25 把词表从 25 扩到 45，新增的一大半是 `<p:animEffect filter>` 那批
 * 几何 / 分块效果，网页侧只能用 clip-path + mask 拼近似。这类 CSS 的失败方式
 * 很安静 —— @property 没注册就直接跳变、mask 写错就永久隐形、clip-path 起止
 * 点数不一致就变硬切换，**看起来都像「没写错」**，只有真在浏览器里跑一遍才知道。
 *
 * 起整个编辑器去验太重（要前后端 + 登录 + 建元素 + 逐个点面板），
 * 而且把「CSS 本身的问题」和「播放逻辑的问题」混在一起。这个页面只装两样东西：
 * animate.css 和 animation-extra.scss，45 个类逐个套在色块上，一屏看完。
 *
 * ## 和真实播放路径的关系
 *
 * **共用词表**：effect → cssClass 走的是 `getAnimationCssClass`，和
 * views/Screen/hooks/useExecPlay.ts 同一个函数，这里不另抄一份清单。
 *
 * **复刻播放机制**：设 `--animate-duration` → 加 `animate__xxx` +
 * `animate__animated` → animationend 后对非退场类移除类名，与 useExecPlay 一致。
 * 所以「入场播完元素还在不在」「退场播完消没消失」这两件事这里就能看出来。
 *
 * 不共用的是元素本身 —— 这里是纯色块，真实路径是文本 / 形状 / 图表。
 * 所以它能证明「这个 CSS 类会不会动、动得对不对」，不能证明「套在富文本上不塌」。
 *
 * ## 自动化钩子
 *
 * 页面在 window.__lab 上挂了一组方法（arm / seek / snapshot / …），
 * 给无头浏览器逐帧采样用 —— 人眼看不出「补间」和「30 步阶梯」的区别，
 * 但采样能。用法见 scripts/measure-animation-lab.mjs。
 */

/* eslint-disable no-console -- 命令行生成器，输出就是它的产物 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as sass from 'sass'
import {
  ANIMATION_DEFS,
  ANIMATION_CLASS_PREFIX,
  getAnimationCssClass,
  ENTER_ANIMATIONS,
  ATTENTION_ANIMATIONS,
  EXIT_ANIMATIONS,
} from '../src/configs/animation'
import type { AnimationEffect, AnimationType } from '../src/types/slides'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const OUT_FILE = path.join(ROOT, 'samples/animation-lab.html')

/** 面板的分组结构就是这张表 —— 实验台照着排，才能顺带看出分组有没有被撑坏 */
const GROUPED: { type: AnimationType, label: string, groups: typeof ENTER_ANIMATIONS }[] = [
  { type: 'in', label: '入场', groups: ENTER_ANIMATIONS },
  { type: 'attention', label: '强调', groups: ATTENTION_ANIMATIONS },
  { type: 'out', label: '退场', groups: EXIT_ANIMATIONS },
]

interface LabEntry {
  value: AnimationEffect
  name: string
  type: AnimationType
  group: string
  cssClass: string
  cssExact: boolean
}

const collectEntries = (): LabEntry[] => {
  const entries: LabEntry[] = []
  for (const { type, groups } of GROUPED) {
    for (const g of groups) {
      for (const child of g.children) {
        const def = ANIMATION_DEFS[child.value]
        entries.push({
          value: def.value,
          name: def.name,
          type,
          group: g.name,
          cssClass: getAnimationCssClass(def.value),
          cssExact: def.cssExact,
        })
      }
    }
  }
  return entries
}

/**
 * animate.css 从 node_modules 读原文，animation-extra.scss 现编译。
 * vite 会给每个 scss 注入 variable / mixin，这里照做 —— 少注入一次就可能
 * 编译报错，多注入一次只是多几条没人用的规则。
 */
const buildCss = async (): Promise<string> => {
  const animateCss = await readFile(
    path.join(ROOT, 'node_modules/animate.css/animate.css'),
    'utf-8',
  )

  const extraPath = path.join(ROOT, 'src/assets/styles/animation-extra.scss')
  const extraSrc = await readFile(extraPath, 'utf-8')
  const compiled = sass.compileString(
    `@import '${path.join(ROOT, 'src/assets/styles/variable.scss')}';\n` +
    `@import '${path.join(ROOT, 'src/assets/styles/mixin.scss')}';\n` +
    extraSrc,
    { loadPaths: [path.dirname(extraPath), path.join(ROOT, 'src/assets/styles')] },
  )

  return `/* ---- animate.css ---- */\n${animateCss}\n/* ---- animation-extra.scss ---- */\n${compiled.css}`
}

const PAGE_CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
  margin: 0;
  font: 13px/1.5 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
  background: #f5f6f8;
  color: #222;
}
header {
  position: sticky; top: 0; z-index: 10;
  display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
  padding: 12px 20px;
  background: #fff;
  border-bottom: 1px solid #e3e5e9;
}
header h1 { font-size: 15px; margin: 0 12px 0 0; }
header label { display: flex; align-items: center; gap: 6px; }
header .hint { color: #888; margin-left: auto; }
button {
  font: inherit; padding: 4px 12px; border-radius: 4px;
  border: 1px solid #c8ccd4; background: #fff; cursor: pointer;
}
button:hover { border-color: #4f7df3; color: #4f7df3; }

section { padding: 8px 20px 24px; }
section > h2 {
  font-size: 14px; margin: 20px 0 4px;
  padding-left: 8px; border-left: 4px solid #aaa;
}
section > h2 .count { color: #999; font-weight: normal; }
.group { margin: 14px 0 4px; color: #666; font-size: 12px; }
.grid { display: flex; flex-wrap: wrap; gap: 12px; }

.card {
  width: 188px; background: #fff; border: 1px solid #e3e5e9;
  border-radius: 6px; overflow: hidden; cursor: pointer;
}
.card.bad { border-color: #d86344; box-shadow: 0 0 0 1px #d8634455; }
.stage {
  position: relative; height: 150px; overflow: hidden;
  background:
    repeating-conic-gradient(#eef0f3 0 25%, #fff 0 50%) 0 0 / 20px 20px;
  display: flex; align-items: center; justify-content: center;
}
.swatch {
  width: 96px; height: 96px; border-radius: 4px;
  background: linear-gradient(135deg, #4f7df3, #7b5cf0);
  color: #fff; font-size: 12px; font-weight: 600;
  display: flex; align-items: center; justify-content: center;
}
.meta { padding: 6px 8px; border-top: 1px solid #eef0f3; }
.meta .name { font-weight: 600; }
.meta .value { color: #888; font-size: 11px; font-family: ui-monospace, Menlo, monospace; }
.meta .flags { margin-top: 3px; display: flex; gap: 6px; font-size: 10px; }
.flag { padding: 1px 5px; border-radius: 3px; background: #eef0f3; color: #667; }
.flag.approx { background: #fdf0e5; color: #a2621c; }
.flag.exact { background: #e9f5ee; color: #2b7a4b; }

/* 测量模式：白底 + 一块「有方向感」的色块，让无头浏览器能把状态压成两个标量。
   彩色渐变和文字会污染像素统计，人眼看着好看，脚本看着全是噪声。

   两处刻意的设计：
   ① 舞台放大到 384×384（正常模式只有 188×150）。fadeInLeft / slideInUp 这类
      位移 100% 自身尺寸，舞台不够大就会被裁掉，「从左边进来」和「凭空出现」
      在像素上分不开。
   ② 色块用 135° 对角双色而不是纯黑。纯正方形旋转时面积和重心都不变 ——
      陀螺旋转会被测成「什么都没发生」。对角双色一转就露馅。 */
body.measure { background: #fff; }
body.measure header, body.measure .meta, body.measure .group, body.measure h2 { display: none; }
body.measure .card { width: 384px; border: none; border-radius: 0; background: #fff; }
body.measure .stage { width: 384px; height: 384px; background: #fff; }
body.measure .swatch {
  width: 120px; height: 120px; border-radius: 0; color: transparent;
  background: linear-gradient(135deg, #000 0 50%, #999 50% 100%);
}
`

const buildHtml = (css: string, entries: LabEntry[]): string => {
  const sections = GROUPED.map(({ type, label, groups }) => {
    const total = groups.reduce((n, g) => n + g.children.length, 0)
    const body = groups.map(g => {
      const cards = g.children.map(child => {
        const e = entries.find(x => x.value === child.value)!
        return `        <div class="card" data-effect="${e.value}" data-type="${e.type}" data-css="${e.cssClass}">
          <div class="stage"><div class="swatch">${e.name}</div></div>
          <div class="meta">
            <div class="name">${e.name}</div>
            <div class="value">${e.value}</div>
            <div class="flags">
              <span class="flag">${e.cssClass}</span>
              <span class="flag ${e.cssExact ? 'exact' : 'approx'}">${e.cssExact ? 'cssExact' : '近似'}</span>
            </div>
          </div>
        </div>`
      }).join('\n')
      return `      <div class="group">${g.name}（${g.children.length}）</div>\n      <div class="grid">\n${cards}\n      </div>`
    }).join('\n')

    return `    <section data-type="${type}">
      <h2>${label} <span class="count">${total}</span></h2>
${body}
    </section>`
  }).join('\n')

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>动画实验台 · ${entries.length} 个效果</title>
<style>
${css}
${PAGE_CSS}
</style>
</head>
<body>
<header>
  <h1>动画实验台 · ${entries.length} 个效果</h1>
  <label>时长 <input id="dur" type="number" value="1000" step="100" min="100" max="5000" style="width:70px"> ms</label>
  <label><input id="loop" type="checkbox" checked> 循环</label>
  <button id="replay">全部重播</button>
  <span class="hint">点单个卡片可单独重播 · 加 ?measure=1 进测量模式</span>
</header>
${sections}
<script>
(function () {
  var PREFIX = ${JSON.stringify(ANIMATION_CLASS_PREFIX)};
  var ENTRIES = ${JSON.stringify(entries)};
  var byValue = {};
  ENTRIES.forEach(function (e) { byValue[e.value] = e; });

  var cards = Array.prototype.slice.call(document.querySelectorAll('.card'));
  var swatchOf = {};
  cards.forEach(function (c) { swatchOf[c.dataset.effect] = c.querySelector('.swatch'); });

  var durInput = document.getElementById('dur');
  var loopInput = document.getElementById('loop');
  var timers = [];

  /**
   * 复刻 views/Screen/hooks/useExecPlay.ts 的施加与清理：
   * 先清掉所有 PREFIX 开头的类，再设 --animate-duration，再加类；
   * animationend 后**只对非退场类**移除 —— 退场要保留终态才能看出「消失了」。
   */
  function clear(el) {
    el.style.removeProperty('--animate-duration');
    Array.prototype.slice.call(el.classList).forEach(function (c) {
      if (c.indexOf(PREFIX) !== -1) el.classList.remove(c, PREFIX + 'animated');
    });
  }

  /**
   * withCleanup=false 是给采样用的。
   * seek 到 currentTime === duration 时 Chromium 会照常派发 animationend，
   * 清理逻辑一跑，末帧量到的就是「类名已移除」的样子而不是 100% 关键帧 ——
   * 恰好会把「动画结束时元素还是被裁着的」这种 bug 抹平。
   */
  function play(value, duration, withCleanup) {
    var e = byValue[value];
    var el = swatchOf[value];
    if (!e || !el) return null;
    clear(el);
    // 强制回流，否则同一帧内「移除再添加」浏览器会认为类名没变，动画不重启
    void el.offsetWidth;
    el.style.setProperty('--animate-duration', duration + 'ms');
    el.classList.add(e.cssClass, PREFIX + 'animated');
    if (withCleanup !== false) {
      el.addEventListener('animationend', function () {
        if (e.type !== 'out') clear(el);
      }, { once: true });
    }
    return el;
  }

  function playAll() {
    timers.forEach(clearTimeout);
    timers = [];
    var duration = Number(durInput.value) || 1000;
    ENTRIES.forEach(function (e) { play(e.value, duration); });
    if (loopInput.checked) {
      timers.push(setTimeout(playAll, duration + 700));
    }
  }

  document.getElementById('replay').addEventListener('click', playAll);
  loopInput.addEventListener('change', function () { if (loopInput.checked) playAll(); });
  cards.forEach(function (c) {
    c.addEventListener('click', function () {
      play(c.dataset.effect, Number(durInput.value) || 1000);
    });
  });

  // ---------------------------------------------------------------------
  // 自动化钩子
  // ---------------------------------------------------------------------
  window.__lab = {
    entries: ENTRIES,

    /**
     * 施加类名并把动画停在 t=0，**不挂 animationend 清理**（见 play 的注释）。
     * 返回拿到的 Animation 条数 —— 0 就是这个类根本不会动
     */
    arm: function (value, duration) {
      var el = play(value, duration, false);
      if (!el) return 0;
      var anims = el.getAnimations();
      anims.forEach(function (a) { a.pause(); a.currentTime = 0; });
      return anims.length;
    },

    /** 把动画seek到进度 f（0~1），并等一帧让样式落地 */
    seek: function (value, f, duration) {
      var el = swatchOf[value];
      if (!el) return false;
      el.getAnimations().forEach(function (a) { a.currentTime = f * duration; });
      return true;
    },

    /**
     * 走**真实播放路径**（挂清理监听）到结束：验「入场播完类名被摘掉、元素回到常态」
     * 和「退场播完保留终态、元素不见了」这两件 useExecPlay 负责的事。
     *
     * 必须返回 Promise —— animationend 是异步派发的，同步读 styleOf 拿到的
     * 还是 fill-mode 保持的 100% 关键帧，清理逻辑跑没跑根本看不出来。
     */
    finish: function (value, duration) {
      var el = play(value, duration, true);
      if (!el) return Promise.resolve(false);
      return new Promise(function (resolve) {
        el.addEventListener('animationend', function () {
          // 让 play() 里那条 once 清理监听先跑完，再读样式
          setTimeout(function () { resolve(true); }, 0);
        }, { once: true });
        el.getAnimations().forEach(function (a) { a.currentTime = duration; a.finish(); });
      });
    },

    /** 当前计算样式的关键字段，给「播完有没有回到原状」这类断言用 */
    styleOf: function (value) {
      var el = swatchOf[value];
      if (!el) return null;
      var s = getComputedStyle(el);
      return {
        transform: s.transform,
        opacity: s.opacity,
        clipPath: s.clipPath,
        maskImage: s.maskImage || s.webkitMaskImage,
        classes: el.className,
      };
    },

    clearAll: function () {
      Object.keys(swatchOf).forEach(function (k) { clear(swatchOf[k]); });
    },

    stopLoop: function () { timers.forEach(clearTimeout); timers = []; loopInput.checked = false; },
  };

  if (new URLSearchParams(location.search).get('measure') === '1') {
    document.body.classList.add('measure');
    loopInput.checked = false;
  }
  else playAll();
})();
</script>
</body>
</html>
`
}

const main = async () => {
  const css = await buildCss()
  const entries = collectEntries()

  if (entries.length !== Object.keys(ANIMATION_DEFS).length) {
    throw new Error(
      `分组里只出现了 ${entries.length} 个效果，词表有 ${Object.keys(ANIMATION_DEFS).length} 个 —— ` +
      'ENTER/ATTENTION/EXIT_ANIMATIONS 漏了某一项，面板里也会看不见它',
    )
  }

  await mkdir(path.dirname(OUT_FILE), { recursive: true })
  await writeFile(OUT_FILE, buildHtml(css, entries), 'utf-8')

  console.log(`✓ ${path.relative(ROOT, OUT_FILE)}（${entries.length} 个效果）`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
