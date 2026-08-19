/**
 * R-17 / R-25 · OOXML 动画树生成器（纯函数）
 *
 * 输入：PPTAnimation[] + spidMap (Map<elId, spid>)
 * 输出：可直接插入 slide XML 的 <p:timing>...</p:timing> 字符串
 *
 * ## 时间线结构（R-25 重写）
 *
 * 第一版是两层 `<p:par>`，和 PowerPoint 自己写出来的文件对不上。真实结构是**三层**，
 * 每层各管一件事 —— 这是从「点击/之后/同时」三种触发方式推出来的必然形状：
 *
 *   <p:seq nodeType="mainSeq">
 *     <p:par>                       ← ① 点击步：stCondLst 为 indefinite，等用户点
 *       <p:par>                     ← ② 子步：delay=0，一个「上一条之后」开一个
 *         <p:par nodeType="...">    ← ③ 效果：真正的 presetID / 行为树
 *         <p:par nodeType="withEffect"/>  ← 同一子步内的都是「与上一条同时」
 *
 * 少了第 ① 层，PowerPoint 拿不到「在这里停下来等点击」的信号，
 * 整页动画会连成一串自动播完 —— 网页侧看着对，导出后就不对了。
 *
 * ## 退场动画的 visibility 时机
 *
 * `<p:set style.visibility=hidden>` 必须**延到效果结束**（delay = dur-1），
 * 第一版写的是 delay=0：元素先瞬间消失，淡出动画再对着空气播。
 *
 * 结构参照 ECMA-376 §19.5（CT_TLTimeNodeParallel / CT_TLCommonTimeNodeData）
 * 与真实 PowerPoint 产物。ground truth 校验方式见 docs/08-expressiveness.md。
 *
 * 不碰 DOM、不碰 ZIP、不碰文件系统。
 */

import type { PPTAnimation, AnimationEffect } from '@/types/slides'
import {
  ANIMATION_DEFS,
  formatEffectFilter,
  type PptxAnimationPreset,
  type PptxMotion,
} from '@/configs/animation'
import { groupTriggersIntoSteps } from '@/utils/animationSteps'

export interface TimingBuildResult {
  xml: string
  skipped: SkippedAnimation[]
}

export interface SkippedAnimation {
  animation: PPTAnimation
  reason: string
}

interface EligibleAnimation {
  animation: PPTAnimation
  preset: PptxAnimationPreset
  spid: number
}

/** 一个「子步」＝ 同时播放的一组效果；一个「点击步」＝ 若干个顺序执行的子步 */
type SubStep = EligibleAnimation[]
interface ClickStep {
  /** true = 等用户点击（stCondLst 用 indefinite）；false = 进页即播 */
  waitsForClick: boolean
  subSteps: SubStep[]
}

export const getAnimationPreset = (effect: string): PptxAnimationPreset | undefined => {
  const def = ANIMATION_DEFS[effect as AnimationEffect]
  return def?.pptx
}

// ---------------------------------------------------------------------------
// id 分配
//
// tmRoot 必须是 1、mainSeq 必须是 2（PowerPoint 自己就是这么写的，
// 虽然规范只要求树内唯一，但对齐它能少一类「为什么我这份不认」的排查）。
// ---------------------------------------------------------------------------

let _nextId = 0
const nextId = () => ++_nextId
const resetIds = () => {
  _nextId = 0 
}

const motionFormula = (motion: PptxMotion): { attr: string, from: string, to: string } => {
  switch (motion) {
    case 'fromBottom':
      return { attr: 'ppt_y', from: '#ppt_y+#ppt_h/2', to: '#ppt_y' }
    case 'fromTop':
      return { attr: 'ppt_y', from: '#ppt_y-#ppt_h/2', to: '#ppt_y' }
    case 'fromLeft':
      return { attr: 'ppt_x', from: '#ppt_x-#ppt_w/2', to: '#ppt_x' }
    case 'fromRight':
      return { attr: 'ppt_x', from: '#ppt_x+#ppt_w/2', to: '#ppt_x' }
    case 'fromTrace':
      return { attr: 'ppt_y', from: '#ppt_y+#ppt_h/2', to: '#ppt_y' }
    default:
      return { attr: 'ppt_y', from: '#ppt_y+#ppt_h/2', to: '#ppt_y' }
  }
}

const exitMotionFormula = (motion: PptxMotion): { attr: string, from: string, to: string } => {
  switch (motion) {
    case 'fromBottom':
      return { attr: 'ppt_y', from: '#ppt_y', to: '#ppt_y+#ppt_h/2' }
    case 'fromTop':
      return { attr: 'ppt_y', from: '#ppt_y', to: '#ppt_y-#ppt_h/2' }
    case 'fromLeft':
      return { attr: 'ppt_x', from: '#ppt_x', to: '#ppt_x-#ppt_w/2' }
    case 'fromRight':
      return { attr: 'ppt_x', from: '#ppt_x', to: '#ppt_x+#ppt_w/2' }
    case 'fromTrace':
      return { attr: 'ppt_y', from: '#ppt_y', to: '#ppt_y+#ppt_h/2' }
    default:
      return { attr: 'ppt_y', from: '#ppt_y', to: '#ppt_y+#ppt_h/2' }
  }
}

const buildBehaviorXml = (anim: EligibleAnimation): string => {
  const { preset, animation } = anim
  const dur = animation.duration
  const spid = anim.spid
  const isExit = preset.presetClass === 'exit'
  const isEmph = preset.presetClass === 'emph'
  const accel = isExit ? '70000' : isEmph ? '20000' : '0'
  const decel = isExit ? '0' : isEmph ? '60000' : '70000'

  const parts: string[] = []

  // 1. 可见性开关
  //    入场：一开始就置 visible（delay=0），后面的效果负责「怎么出现」
  //    退场：效果播完的最后 1ms 才置 hidden，否则元素先没了动画对着空气播
  const visibilitySet = isEmph ? '' : (() => {
    const visTo = isExit ? 'hidden' : 'visible'
    const delay = isExit ? Math.max(dur - 1, 0) : 0
    return (
      `<p:set>` +
        `<p:cBhvr>` +
          `<p:cTn id="${nextId()}" dur="1" fill="hold">` +
            `<p:stCondLst><p:cond delay="${delay}"/></p:stCondLst>` +
          `</p:cTn>` +
          `<p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl>` +
          `<p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst>` +
        `</p:cBhvr>` +
        `<p:to><p:strVal val="${visTo}"/></p:to>` +
      `</p:set>`
    )
  })()

  // 入场的 set 在最前，退场的 set 在最后 —— 和 PowerPoint 自己的写法一致
  if (!isExit && visibilitySet) parts.push(visibilitySet)

  // 2. 淡入淡出
  if (preset.fade) {
    const trans = preset.transition || 'in'
    parts.push(
      `<p:animEffect transition="${trans}" filter="fade">` +
        `<p:cBhvr>` +
          `<p:cTn id="${nextId()}" dur="${dur}" accel="${accel}" decel="${decel}"/>` +
          `<p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl>` +
        `</p:cBhvr>` +
      `</p:animEffect>`
    )
  }

  // 3. 转场滤镜（擦除 / 百叶窗 / 棋盘 / 圆形 / 菱形 / 十字 / 轮辐 / 楔入 / 溶解 …）
  //    第一版这里只有 `effectFilter === 'wipe'` 一个硬编码分支。
  if (preset.effectFilter) {
    const trans = preset.transition || 'in'
    parts.push(
      `<p:animEffect transition="${trans}" filter="${formatEffectFilter(preset.effectFilter)}">` +
        `<p:cBhvr>` +
          `<p:cTn id="${nextId()}" dur="${dur}" accel="${accel}" decel="${decel}"/>` +
          `<p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl>` +
        `</p:cBhvr>` +
      `</p:animEffect>`
    )
  }

  // 4. 位移
  if (preset.motion) {
    const m = isExit ? exitMotionFormula(preset.motion) : motionFormula(preset.motion)
    parts.push(
      `<p:anim calcmode="lin" valueType="num">` +
        `<p:cBhvr>` +
          `<p:cTn id="${nextId()}" dur="${dur}" accel="${accel}" decel="${decel}" fill="hold"/>` +
          `<p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl>` +
          `<p:attrNameLst><p:attrName>${m.attr}</p:attrName></p:attrNameLst>` +
        `</p:cBhvr>` +
        `<p:tavLst>` +
          `<p:tav tm="0"><p:val><p:strVal val="${m.from}"/></p:val></p:tav>` +
          `<p:tav tm="100000"><p:val><p:strVal val="${m.to}"/></p:val></p:tav>` +
        `</p:tavLst>` +
      `</p:anim>`
    )
  }

  // 5. 缩放（入场 / 退场，单程）
  if (preset.scaleFrom !== undefined && preset.scaleTo !== undefined && !isEmph) {
    parts.push(
      `<p:animScale>` +
        `<p:cBhvr>` +
          `<p:cTn id="${nextId()}" dur="${dur}" accel="${accel}" decel="${decel}" fill="hold"/>` +
          `<p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl>` +
        `</p:cBhvr>` +
        `<p:from x="${preset.scaleFrom}" y="${preset.scaleFrom}"/>` +
        `<p:to x="${preset.scaleTo}" y="${preset.scaleTo}"/>` +
      `</p:animScale>`
    )
  }

  // 6. 强调缩放（去而复返）
  //
  //    脉冲   100% → peak → 100%，峰值在正中
  //    缩放强调 100% → low → high → 100%，先收后放（多一次收缩，强调感更强）
  //
  //    关键是**第一段必须从 100000 起步**。第一版直接 `from=scaleFrom`，
  //    grow-shrink 的 scaleFrom 是 95000，于是元素在 t=0 瞬间弹到 95% 再开始长 ——
  //    网页侧的 @mixin grow-shrink-keyframes 是从 scale(1) 平滑收到 0.95 的，
  //    两边对不上，而且那个瞬跳在 PowerPoint 里看着就是个 bug。
  //
  //    时间分配与 assets/styles/animation-extra.scss 的关键帧一一对应（30% / 70%），
  //    改一处要同步改另一处。
  if (preset.scaleFrom !== undefined && preset.scaleTo !== undefined && isEmph) {
    const stops: [number, number][] = preset.scaleFrom === 100000
      ? [[0, 100000], [0.5, preset.scaleTo], [1, 100000]]
      : [[0, 100000], [0.3, preset.scaleFrom], [0.7, preset.scaleTo], [1, 100000]]

    for (let i = 0; i < stops.length - 1; i++) {
      const delay = Math.round(stops[i][0] * dur)
      const segDur = Math.round(stops[i + 1][0] * dur) - delay
      const isLast = i === stops.length - 2
      parts.push(
        `<p:animScale>` +
          `<p:cBhvr>` +
            `<p:cTn id="${nextId()}" dur="${segDur}" accel="${accel}" decel="${decel}"` +
            ` fill="${isLast ? 'remove' : 'hold'}"` +
            (delay > 0
              ? `><p:stCondLst><p:cond delay="${delay}"/></p:stCondLst></p:cTn>`
              : `/>`) +
            `<p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl>` +
          `</p:cBhvr>` +
          `<p:from x="${stops[i][1]}" y="${stops[i][1]}"/>` +
          `<p:to x="${stops[i + 1][1]}" y="${stops[i + 1][1]}"/>` +
        `</p:animScale>`
      )
    }
  }

  // 7. 旋转
  //    rotateBy  → 相对旋转（陀螺旋转这类强调），一圈 = 21600000
  //    from/to   → 绝对角度（旋转进入）
  //    attrNameLst 是必须的：不写 PowerPoint 不知道该动哪个属性
  if (preset.rotateBy !== undefined) {
    parts.push(
      `<p:animRot by="${preset.rotateBy}">` +
        `<p:cBhvr>` +
          `<p:cTn id="${nextId()}" dur="${dur}" fill="remove"/>` +
          `<p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl>` +
          `<p:attrNameLst><p:attrName>r</p:attrName></p:attrNameLst>` +
        `</p:cBhvr>` +
      `</p:animRot>`
    )
  }
  else if (preset.rotateFrom !== undefined && preset.rotateTo !== undefined) {
    parts.push(
      `<p:animRot from="${preset.rotateFrom}" to="${preset.rotateTo}">` +
        `<p:cBhvr>` +
          `<p:cTn id="${nextId()}" dur="${dur}" accel="${accel}" decel="${decel}" fill="hold"/>` +
          `<p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl>` +
          `<p:attrNameLst><p:attrName>r</p:attrName></p:attrNameLst>` +
        `</p:cBhvr>` +
      `</p:animRot>`
    )
  }

  // 8. 透明度脉冲（强调「闪烁」）—— 掉到 dip 再回到 1
  if (preset.opacityDip !== undefined) {
    parts.push(
      `<p:anim calcmode="lin" valueType="num">` +
        `<p:cBhvr>` +
          `<p:cTn id="${nextId()}" dur="${dur}" fill="remove"/>` +
          `<p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl>` +
          `<p:attrNameLst><p:attrName>style.opacity</p:attrName></p:attrNameLst>` +
        `</p:cBhvr>` +
        `<p:tavLst>` +
          `<p:tav tm="0"><p:val><p:fltVal val="1"/></p:val></p:tav>` +
          `<p:tav tm="50000"><p:val><p:fltVal val="${preset.opacityDip}"/></p:val></p:tav>` +
          `<p:tav tm="100000"><p:val><p:fltVal val="1"/></p:val></p:tav>` +
        `</p:tavLst>` +
      `</p:anim>`
    )
  }

  if (isExit && visibilitySet) parts.push(visibilitySet)

  return parts.join('')
}

/** ③ 效果层：真正带 presetID 的那个 <p:par> */
const buildEffectXml = (anim: EligibleAnimation, nodeType: string): string => {
  const { preset } = anim
  const id = nextId()
  const sub = preset.presetSubtype !== undefined ? ` presetSubtype="${preset.presetSubtype}"` : ''

  return (
    `<p:par>` +
      `<p:cTn id="${id}" presetID="${preset.presetId}" presetClass="${preset.presetClass}"${sub}` +
      ` fill="hold" grpId="0" nodeType="${nodeType}">` +
        `<p:stCondLst><p:cond delay="0"/></p:stCondLst>` +
        `<p:childTnLst>` +
          buildBehaviorXml(anim) +
        `</p:childTnLst>` +
      `</p:cTn>` +
    `</p:par>`
  )
}

/**
 * PPTist trigger → 时间线分组。
 *
 * 规则本身在 `@/utils/animationSteps` —— 网页播放、PPTX 导出、kernel 的出场顺序 lint
 * 三处共用同一份，这里只负责把下标换回带 preset / spid 的条目。
 */
const groupIntoSteps = (eligible: EligibleAnimation[]): ClickStep[] =>
  groupTriggersIntoSteps(eligible.map(a => a.animation.trigger)).map(step => ({
    waitsForClick: step.waitsForClick,
    subSteps: step.subSteps.map(group => group.map(i => eligible[i])),
  }))

/** 效果在时间线里的位置 → OOXML nodeType */
const nodeTypeFor = (stepIndex: number, subStepIndex: number, effectIndex: number, waitsForClick: boolean): string => {
  if (effectIndex > 0) return 'withEffect'
  if (subStepIndex > 0) return 'afterEffect'
  if (waitsForClick) return 'clickEffect'
  // 整页第一条且不等点击 —— 进页自动播
  return stepIndex === 0 ? 'withEffect' : 'afterEffect'
}

/**
 * 生成 <p:timing> XML 片段
 */
export const buildTimingXml = (
  animations: PPTAnimation[],
  spidMap: Map<string, number>,
): TimingBuildResult => {
  const skipped: SkippedAnimation[] = []

  const eligible: EligibleAnimation[] = []
  for (const anim of animations) {
    if (anim.exportBehavior === 'web-only') {
      skipped.push({ animation: anim, reason: 'exportBehavior 为 web-only，跳过' })
      continue
    }
    const spid = spidMap.get(anim.elId)
    if (spid === undefined) {
      skipped.push({ animation: anim, reason: `elId "${anim.elId}" 在 spidMap 中查不到，跳过` })
      continue
    }
    const preset = getAnimationPreset(anim.effect)
    if (!preset) {
      skipped.push({ animation: anim, reason: `effect "${anim.effect}" 没有对应的 PPTX preset，跳过` })
      continue
    }
    eligible.push({ animation: anim, preset, spid })
  }

  if (!eligible.length) return { xml: '', skipped }

  // tmRoot=1 / mainSeq=2 先占位，其余节点从 3 开始
  resetIds()
  const tmRootId = nextId()
  const mainSeqId = nextId()

  const steps = groupIntoSteps(eligible)

  // id 必须按**文档顺序**递增：外层容器先取号，再构造子节点。
  // 反过来写（先建子节点再给容器取号）id 是乱序的 —— 规范只要求唯一，
  // 但和 PowerPoint 自己的产物对不上，排查时凭空多一个变量。
  const stepXmls = steps.map((step, stepIndex) => {
    const stepId = nextId()
    const startCond = step.waitsForClick ? 'indefinite' : '0'

    const subStepXmls = step.subSteps.map((subStep, subStepIndex) => {
      const subStepId = nextId()
      const effectXmls = subStep.map((anim, effectIndex) =>
        buildEffectXml(anim, nodeTypeFor(stepIndex, subStepIndex, effectIndex, step.waitsForClick)),
      )

      // ② 子步层
      return (
        `<p:par>` +
          `<p:cTn id="${subStepId}" fill="hold">` +
            `<p:stCondLst><p:cond delay="0"/></p:stCondLst>` +
            `<p:childTnLst>` +
              effectXmls.join('') +
            `</p:childTnLst>` +
          `</p:cTn>` +
        `</p:par>`
      )
    })

    // ① 点击步层
    return (
      `<p:par>` +
        `<p:cTn id="${stepId}" fill="hold">` +
          `<p:stCondLst><p:cond delay="${startCond}"/></p:stCondLst>` +
          `<p:childTnLst>` +
            subStepXmls.join('') +
          `</p:childTnLst>` +
        `</p:cTn>` +
      `</p:par>`
    )
  })

  // build list：每个被动画作用的形状登记一次
  const uniqueSpids = [...new Set(eligible.map(a => a.spid))]
  const bldEntries = uniqueSpids.map(spid => `<p:bldP spid="${spid}" grpId="0"/>`).join('')

  const xml =
    `<p:timing>` +
      `<p:tnLst>` +
        `<p:par>` +
          `<p:cTn id="${tmRootId}" dur="indefinite" restart="never" nodeType="tmRoot">` +
            `<p:childTnLst>` +
              `<p:seq concurrent="1" nextAc="seek">` +
                `<p:cTn id="${mainSeqId}" dur="indefinite" nodeType="mainSeq">` +
                  `<p:childTnLst>` +
                    stepXmls.join('') +
                  `</p:childTnLst>` +
                `</p:cTn>` +
                `<p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst>` +
                `<p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst>` +
              `</p:seq>` +
            `</p:childTnLst>` +
          `</p:cTn>` +
        `</p:par>` +
      `</p:tnLst>` +
      `<p:bldLst>` +
        bldEntries +
      `</p:bldLst>` +
    `</p:timing>`

  return { xml, skipped }
}
