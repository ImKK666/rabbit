/**
 * 逐字体量字宽表（开发工具，不参与打包）—— 浏览器这一半
 *
 *   npx vite --port 5199
 *   node scripts/measure-char-width.mjs
 *
 * ## 为什么需要它
 *
 * `design.ts` 的 `CHAR_WIDTH` 是**一张常量表**，注释写着它是在
 * `variable.scss` 的 `$textElementFont` 栈下量出来的。那个栈是系统字体 fallback ——
 * Mac 上落到 PingFang SC、Windows 上落到 Microsoft YaHei，**两台机器的字宽本来就不一样**。
 *
 * 而 `layouts.ts` 写的 `defaultFontName: 'Microsoft YaHei'` 不在 `configs/font.ts`
 * 的白名单里，匹配不到任何 `@font-face`，于是也落进那个栈。
 *
 * 一旦版式引擎改用登记字体（思源黑体、得意黑…），字宽就变了，而
 * `estimateTextHeight` 仍按旧表估 —— 估小了下一个元素就压上来。
 * 所以「一个字体一张表」是换字族的前置条件，不是可选项。
 *
 * ## 量法
 *
 * 每一类字符给一个**频率加权的样本串**，量总宽再除以字符数，得到 em。
 *
 * 为什么要加权而不是取算术平均 —— `design.ts:466-473` 已经把坑写清楚了：
 *
 * > 平均值会骗人：a~z 平均 0.471，但那个平均被 i / l / j / t / f / r 这些
 * > 窄字母拉下去了，而真实单词里占多数的是 e / o / h / b / k / n / m。
 *
 * 所以 `lower` 的样本按英文字母自然频率重复，`upper` 按技术文稿里
 * 真实出现的缩写（API / SDK / P99 / SOC2 …）取字母。量出来的就是「真实文本的
 * 每字符宽」，而不是「字母表的平均宽」。
 *
 * ## 量法自证
 *
 * 驱动脚本会先量 `__fallback__`（就是 `$textElementFont` 那个栈），
 * 拿结果和 `design.ts` 现有的 `CHAR_WIDTH` 对一次。**对得上才说明量法和当初一致**，
 * 后面 8 张表才有意义。对不上就是量法漂了，这时候先修量法，不要改数。
 *
 * ## 唯一会「坏了但看起来是好的」的地方
 *
 * 字体没加载成时浏览器安静地用 fallback 排版，量出来是一张**看着完全正常**的表。
 * 三道防线：
 *   1. `document.fonts.load()` 显式加载，再 `document.fonts.check()` 确认
 *   2. 量一个探针串，和 fallback 的宽度比 —— 一样就是没换成
 *   3. 驱动脚本比对 8 张表两两之间，完全相同的两张必有一张是假的
 */

import '@/assets/styles/font.scss'

/** 量的字号。取大是为了让 getBoundingClientRect 的亚像素误差摊薄 */
const FONT_SIZE = 400

/**
 * 系统字体栈 —— 抄自 `variable.scss` 的 `$textElementFont`。
 *
 * **必须逐字一致**：它是量法自证的参照系，漂了就没法和 `design.ts` 的旧表对。
 */
export const FALLBACK_STACK
  = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, "PingFang SC", '
    + '"Hiragino Sans GB", "Microsoft YaHei", Arial, sans-serif'

/** 频率加权的样本串。每一类的构造理由见各自注释 */
export const SAMPLES = {
  /**
   * 汉字：现代汉语高频字。CJK 字体基本是 em 方块等宽设计，
   * 量出来应该贴近 1.0 —— 如果某个字体明显偏离，那是它自己的设计选择，得如实记下来
   */
  cjk: '的一是了我不人在他有这个上们来到时大地为子中你说生国年着就那和要她出也得里后自以会家可下而过天去能对小多然于心学么之都好看起发当没成只如事把还用第样道想作种开美总从无情己面最女但现前些所同日手又行意动方期它头经长儿回位分爱老因很给名法间斯知世什两次使身者被高已亲其进此话常与活正感',
  /**
   * 全角标点。**必须只放落在 `design.ts` 的 `CJK_PUNCT_RANGE`
   * （U+3000–U+303F, U+FF00–U+FFEF）里的字符** —— 量的必须和分的是同一批。
   *
   * 第一版把 `“” ‘’ — … ·` 也放进来了，量出 0.634 而实测表是 0.778。
   * 原因是那五个的码位（U+201C/D、U+2018/9、U+2014、U+2026、U+00B7）
   * **全都不在那个范围里**，`charWidth()` 会把它们判成 `asciiPunct`。
   * 混进来等于在量一个 `charWidth()` 永远不会用的口径。
   *
   * 那几个字符另有 `ORPHAN_PUNCT` 单独观测 —— 它们的错分是既有问题。
   */
  cjkPunct: '，。、；：？！（）《》【】〈〉「」『』〔〕％＆＋－＝＜＞',
  /**
   * 大写：技术文稿里的大写几乎全是缩写。这串是从真实缩写语料
   * （API SDK REST HTTP JSON SQL CDN CPU GPU TLS DNS URL UUID SaaS SOC ISO GDPR
   *  KPI ROI OKR MVP POC QPS P99 AWS GCP K8S CI CD ML AI LLM RAG）里抽出的字母，
   * 保留原始出现次数 —— 所以 S / A / P / C 这些高频字母权重天然更高
   */
  upper: 'APISDKRESTHTTPJSONSQLCDNCPUGPUTLSDNSURLUUIDSSSOCISOGDPRKPIROIOKRMVPPOCQPSPAWSGCPKSCICDMLAILLMRAG',
  /**
   * 数字。多数字体做等宽数字（tabular），但不是全部 ——
   * 探针会顺带报每个数字的宽度方差，方差大就说明这个字体是比例数字，要留更多余量
   */
  digit: '0123456789',
  /**
   * 小写：按英文字母自然频率重复（e 12.7% → 13 个，z 0.07% → 1 个）。
   * 这一串量出来的每字符宽，才是真实英文文本的每字符宽
   */
  lower: 'eeeeeeeeeeeeetttttttttaaaaaaaaooooooooiiiiiiinnnnnnnssssssshhhhhhrrrrrrddddllllccuummwwffggyyppbbvkjxqz',
  /** ASCII 标点：按技术文稿里的常见度取，句点逗号连字符斜杠百分号占多数 */
  asciiPunct: '..,,,--//%%()::;!?\'"',
} as const

export type CharClass = keyof typeof SAMPLES

/**
 * 「孤儿标点」—— 中文文稿里到处都是，但码位不在 `CJK_PUNCT_RANGE` 里，
 * 于是 `charWidth()` 把它们判成 `asciiPunct`（0.32）。
 *
 * 而在中文字体里它们多半是**全角**（1.0em 上下）。如果真是这样，
 * 每出现一个就低估 0.68em —— 一行 40 个字的正文里有三五个引号破折号，
 * 就是少算大半个字的宽度。**这个观测只报告，不进表**：改分类规则是
 * 另一件事，得单独立判据。
 */
const ORPHAN_PUNCT = '“”‘’—…·'

export interface FontTable {
  font: string
  loaded: boolean
  /** 七个分量，单位 em */
  widths: Record<CharClass | 'space', number>
  /** 每个数字各自的宽度（em）—— 用来判断是不是等宽数字 */
  digitSpread: number
  /** 孤儿标点的实际每字符宽（em）。和 asciiPunct 一比就知道错分的代价 */
  orphanPunct: number
  /** 探针串在这个字体下的宽度（px）。驱动脚本拿它查「有没有偷偷 fallback」 */
  probeWidth: number
}

/** 查 fallback 用的探针串：混合中英数，任何两个不同字体都不该量出一样的宽 */
const PROBE = '中文Webhook800msSOC2永'

const measurer = (() => {
  const el = document.createElement('span')
  el.style.cssText = [
    'position:absolute', 'left:-99999px', 'top:0',
    'white-space:pre', 'letter-spacing:0', 'word-spacing:0',
    `font-size:${FONT_SIZE}px`, 'line-height:1',
  ].join(';')
  document.body.appendChild(el)
  return el
})()

/** 一串文字在某字体下的宽度，单位 em（= px / 字号） */
const widthEm = (text: string, fontFamily: string): number => {
  measurer.style.fontFamily = fontFamily
  measurer.textContent = text
  return measurer.getBoundingClientRect().width / FONT_SIZE
}

/**
 * 空格宽度。**不能直接量一个空格** —— `white-space:pre` 下单独一个空格
 * 量得出来，但两侧没有字符时浏览器对它的处理和排在文本中间时不同。
 * 量「x x」减「xx」，差值才是文本流里一个空格真正占的宽。
 */
const spaceWidthEm = (fontFamily: string): number =>
  widthEm('x x', fontFamily) - widthEm('xx', fontFamily)

const measureFont = async (font: string, fontFamily: string): Promise<FontTable> => {
  let loaded = false
  if (font !== '__fallback__') {
    try {
      // 把要量的字都传进去 —— 子集字体只会加载用得到的那部分
      const all = Object.values(SAMPLES).join('') + PROBE + ORPHAN_PUNCT
      await document.fonts.load(`${FONT_SIZE}px "${font}"`, all)
      loaded = document.fonts.check(`${FONT_SIZE}px "${font}"`)
    }
    catch {
      loaded = false
    }
  }
  else loaded = true

  const widths = {} as Record<CharClass | 'space', number>
  for (const [cls, sample] of Object.entries(SAMPLES) as [CharClass, string][]) {
    widths[cls] = widthEm(sample, fontFamily) / Array.from(sample).length
  }
  widths.space = spaceWidthEm(fontFamily)

  // 每个数字单独量，取极差 —— 等宽数字的极差应该是 0
  const digitWidths = Array.from('0123456789').map(d => widthEm(d, fontFamily))
  const digitSpread = Math.max(...digitWidths) - Math.min(...digitWidths)

  const orphanPunct = widthEm(ORPHAN_PUNCT, fontFamily) / Array.from(ORPHAN_PUNCT).length

  return {
    font, loaded, widths, digitSpread, orphanPunct,
    probeWidth: widthEm(PROBE, fontFamily) * FONT_SIZE,
  }
}

/** 要量的字体。`__fallback__` 排第一，它是量法自证的参照 */
const TARGETS: { font: string, family: string }[] = [
  { font: '__fallback__', family: FALLBACK_STACK },
  ...[
    'SourceHanSans', 'SourceHanSerif', 'AlibabaPuHuiTi', 'MiSans',
    'DeYiHei', 'LXGWNeoZhiSong', 'LXGWWenKai', 'LXGWNeoXiHei',
  ].map(f => ({ font: f, family: `"${f}"` })),
]

const run = async () => {
  await document.fonts.ready
  const tables: FontTable[] = []
  for (const t of TARGETS) tables.push(await measureFont(t.font, t.family))

  const out = document.querySelector('#out')
  if (out) {
    out.textContent = tables
      .map(t => `${t.font.padEnd(18)}${t.loaded ? '✓' : '✗ 没加载成'}  `
        + (Object.entries(t.widths) as [string, number][])
          .map(([k, v]) => `${k}=${v.toFixed(3)}`).join('  '))
      .join('\n')
  }
  ;(window as unknown as { __charWidth: FontTable[] }).__charWidth = tables
}

run()
