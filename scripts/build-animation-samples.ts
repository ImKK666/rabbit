/**
 * 动画最小样本生成器（开发工具，不参与打包）
 *
 *   npm run samples          → samples/animations/*.pptx
 *
 * ## 为什么要它
 *
 * 25 → 45 个效果是**一次性批量扩容**（决策 P2），风险是如果 `<p:timing>` 的
 * 基础结构有问题，错误会被放大数倍。在 PowerPoint 里打开一个 45 效果的大矩阵
 * 然后发现「全都不动」，没有任何定位价值。
 *
 * 所以每一类滤镜 / 每一类行为各出一份独立文件，一份文件里一页一个效果。
 * 哪份打不开、哪页不动，直接就把问题夹到了一个 filter 家族或一条行为分支上。
 *
 * ## 它和真实导出路径的关系
 *
 * **共用的是要害部分**：buildSpidMap / buildTimingXml / buildTransitionXml，
 * 以及「transition 在前 timing 在后」的注入顺序 —— 也就是 useExport.ts 里
 * 唯一属于我们自己的那段逻辑。
 *
 * 不共用的只有喂给 pptxgenjs 的方式（这里直接 addShape / addText，
 * 真实路径要处理 HTML 富文本、SVG path、裁剪等等）。所以样本能证明
 * 「动画树本身 PowerPoint 认」，不能证明「复杂元素的几何也对」。
 * 后者由真实导出验证，前者才是本轮要确认的未知数。
 */

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import JSZip from 'jszip'
import pptxgen from 'pptxgenjs'
import { buildSpidMap } from '../src/utils/ooxml/spidMap'
import { buildTimingXml } from '../src/utils/ooxml/buildTimingXml'
import { buildTransitionXml } from '../src/utils/ooxml/buildTransitionXml'
import { ANIMATION_DEFS, SLIDE_ANIMATIONS, type AnimationDef } from '../src/configs/animation'
import type { AnimationEffect, PPTAnimation, TurningMode } from '../src/types/slides'

const OUT_DIR = path.resolve(process.cwd(), 'samples/animations')

/** 画布 1000×562.5 逻辑像素 → 10×5.625 英寸 */
const PX2IN = 100

interface SampleSlide {
  title: string
  subtitle: string
  animations: PPTAnimation[]
  turningMode?: TurningMode
  /** 参与动画的方块数量，默认 1 */
  blocks?: number
}

const PALETTE = ['4F7DF3', 'F2596B', '32C48D', 'F5A623', '9B6DF3', '00B8D9']

/**
 * 一页一个效果：左上角写效果名，中间放若干色块。
 * 色块用 pptxgenjs 原生 rect —— 样本要验的是时间线，不是几何。
 */
const buildDeck = async (slides: SampleSlide[]): Promise<Buffer> => {
  const pptx = new pptxgen()
  pptx.layout = 'LAYOUT_16x9'

  for (const slide of slides) {
    const s = pptx.addSlide()
    s.background = { color: '0E1220' }

    s.addText(slide.title, {
      x: 60 / PX2IN, y: 40 / PX2IN, w: 880 / PX2IN, h: 60 / PX2IN,
      fontSize: 28, bold: true, color: 'FFFFFF', fontFace: 'Arial',
      objectName: 'label',
    })
    s.addText(slide.subtitle, {
      x: 60 / PX2IN, y: 100 / PX2IN, w: 880 / PX2IN, h: 40 / PX2IN,
      fontSize: 14, color: '8A93AD', fontFace: 'Arial',
      objectName: 'sublabel',
    })

    const count = slide.blocks ?? 1
    const blockW = count === 1 ? 420 : 240
    const gap = 40
    const totalW = count * blockW + (count - 1) * gap
    const startX = (1000 - totalW) / 2

    for (let i = 0; i < count; i++) {
      s.addShape(pptx.ShapeType.rect, {
        x: (startX + i * (blockW + gap)) / PX2IN,
        y: 220 / PX2IN,
        w: blockW / PX2IN,
        h: 220 / PX2IN,
        fill: { color: PALETTE[i % PALETTE.length] },
        objectName: `block${i + 1}`,
      })
    }
  }

  const buffer = await pptx.write({ outputType: 'nodebuffer' }) as Buffer
  const zip = await JSZip.loadAsync(buffer)

  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i]
    const file = zip.file(`ppt/slides/slide${i + 1}.xml`)
    if (!file) throw new Error(`slide${i + 1}.xml 不在包里`)

    const xml = await file.async('string')
    const spidMap = buildSpidMap(xml)

    const { xml: transitionXml } = buildTransitionXml(slide.turningMode)
    const { xml: timingXml, skipped } = buildTimingXml(slide.animations, spidMap)
    if (skipped.length) {
      throw new Error(`第 ${i + 1} 页有动画被跳过：${skipped.map(s => s.reason).join('; ')}`)
    }

    if (transitionXml || timingXml) {
      zip.file(`ppt/slides/slide${i + 1}.xml`, xml.replace('</p:sld>', `${transitionXml}${timingXml}</p:sld>`))
    }
  }

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } })
}

const anim = (
  elId: string,
  effect: AnimationEffect,
  trigger: PPTAnimation['trigger'] = 'click',
  duration = 900,
): PPTAnimation => ({
  id: `anim_${elId}_${effect}`,
  elId,
  effect,
  type: ANIMATION_DEFS[effect].type,
  duration,
  trigger,
})

/** 每个效果一页，单个色块，点击触发 —— 最小可判定单元 */
const slidesForEffects = (effects: AnimationEffect[]): SampleSlide[] =>
  effects.map(effect => {
    const def: AnimationDef = ANIMATION_DEFS[effect]
    const p = def.pptx
    const detail = [
      `presetID=${p.presetId}`,
      `presetClass=${p.presetClass}`,
      p.presetSubtype !== undefined ? `presetSubtype=${p.presetSubtype}` : '',
      p.effectFilter ? `filter=${p.effectFilter.name}${'subtype' in p.effectFilter ? `(${p.effectFilter.subtype})` : ''}` : '',
    ].filter(Boolean).join('  ·  ')

    return {
      title: `${effect}    ${def.name}`,
      subtitle: `${detail}    ${def.cssExact ? '' : '（网页侧为近似）'}`,
      animations: [anim('block1', effect)],
    }
  })

/**
 * 按「哪条 writer 分支在起作用」分组，而不是按 UI 分类分组。
 * 出问题时要定位的是代码分支，不是给用户看的目录。
 */
const FAMILIES: { file: string, label: string, effects: AnimationEffect[] }[] = [
  { file: 'filter-wipe', label: '擦除滤镜', effects: ['wipe', 'wipe-right', 'wipe-up', 'wipe-down', 'exit-wipe'] },
  { file: 'filter-blinds', label: '百叶窗滤镜', effects: ['blinds-h', 'blinds-v', 'exit-blinds'] },
  { file: 'filter-checkerboard', label: '棋盘滤镜', effects: ['checkerboard'] },
  { file: 'filter-dissolve', label: '溶解滤镜', effects: ['dissolve-in', 'exit-dissolve'] },
  { file: 'filter-randombar', label: '随机线条滤镜', effects: ['randombar'] },
  { file: 'filter-strips', label: '阶梯滤镜', effects: ['strips-in'] },
  { file: 'filter-box', label: '盒状滤镜', effects: ['box-in'] },
  { file: 'filter-circle', label: '圆形滤镜', effects: ['circle-in', 'exit-circle'] },
  { file: 'filter-diamond', label: '菱形滤镜', effects: ['diamond-in'] },
  { file: 'filter-plus', label: '十字滤镜', effects: ['plus-in'] },
  { file: 'filter-wedge', label: '楔入滤镜', effects: ['wedge-in'] },
  { file: 'filter-wheel', label: '轮辐滤镜', effects: ['wheel-in'] },
  { file: 'filter-fade', label: '淡入淡出滤镜', effects: ['fade', 'exit-fade'] },

  {
    file: 'behavior-motion',
    label: '位移行为（p:anim ppt_x / ppt_y）',
    effects: ['fade-up', 'fade-down', 'fade-left', 'fade-right',
      'slide-up', 'slide-down', 'slide-left', 'slide-right', 'fly-in', 'exit-fly'],
  },
  {
    file: 'behavior-scale',
    label: '缩放行为（p:animScale）',
    effects: ['scale-in', 'zoom-in', 'exit-scale', 'exit-zoom',
      'pulse-soft', 'pulse', 'pulse-strong',
      'grow-shrink-soft', 'grow-shrink', 'grow-shrink-strong'],
  },
  { file: 'behavior-rotate', label: '旋转行为（p:animRot）', effects: ['spin-in', 'spin'] },
  { file: 'behavior-opacity', label: '透明度行为（p:anim style.opacity）', effects: ['blink'] },
]

/** 触发方式：三层 par 嵌套对不对，只有这一份能看出来 */
const triggerSample = (): SampleSlide[] => [
  {
    title: '三步点击',
    subtitle: '点三次，每次出现一个方块（三个独立的点击步）',
    blocks: 3,
    animations: [
      anim('block1', 'fade-up', 'click'),
      anim('block2', 'fade-up', 'click'),
      anim('block3', 'fade-up', 'click'),
    ],
  },
  {
    title: '一步同时',
    subtitle: '点一次，三个方块同时出现（一个点击步 + 两个 withEffect）',
    blocks: 3,
    animations: [
      anim('block1', 'fade-up', 'click'),
      anim('block2', 'fade-up', 'meantime'),
      anim('block3', 'fade-up', 'meantime'),
    ],
  },
  {
    title: '一步依次',
    subtitle: '点一次，三个方块依次自动出现（一个点击步 + 两个 afterEffect）',
    blocks: 3,
    animations: [
      anim('block1', 'fade-up', 'click'),
      anim('block2', 'fade-up', 'auto'),
      anim('block3', 'fade-up', 'auto'),
    ],
  },
  {
    title: '进页即播',
    subtitle: '不用点，翻到这页第一个方块就该自己出现',
    blocks: 3,
    animations: [
      anim('block1', 'fade-up', 'meantime'),
      anim('block2', 'fade-up', 'auto'),
      anim('block3', 'fade-up', 'auto'),
    ],
  },
  {
    title: '退场时机',
    subtitle: '点一次，方块应该「淡出」而不是「瞬间消失」（visibility 延到效果末尾）',
    animations: [anim('block1', 'exit-fade', 'click', 1200)],
  },
]

const transitionSample = (): SampleSlide[] =>
  SLIDE_ANIMATIONS.map(({ label, value }) => ({
    title: `转场：${label}`,
    subtitle: `turningMode = ${value}    翻到本页时应播放该转场`,
    turningMode: value,
    animations: [],
  }))

const write = async (name: string, slides: SampleSlide[]) => {
  const buffer = await buildDeck(slides)
  const file = path.join(OUT_DIR, `${name}.pptx`)
  await writeFile(file, buffer)
  // eslint-disable-next-line no-console
  console.log(`  ${name}.pptx  （${slides.length} 页）`)
}

const main = async () => {
  await mkdir(OUT_DIR, { recursive: true })
  // eslint-disable-next-line no-console
  console.log(`生成动画样本 → ${OUT_DIR}`)

  for (const family of FAMILIES) {
    await write(family.file, slidesForEffects(family.effects))
  }
  await write('trigger-sequencing', triggerSample())
  await write('slide-transitions', transitionSample())
  await write('all-effects', slidesForEffects(Object.keys(ANIMATION_DEFS) as AnimationEffect[]))

  // eslint-disable-next-line no-console
  console.log(`\n共 ${FAMILIES.length + 3} 份。验证清单见 docs/09-powerpoint-verify.md`)
}

main().catch(err => {
  // eslint-disable-next-line no-console
  console.error(err)
  process.exit(1)
})
