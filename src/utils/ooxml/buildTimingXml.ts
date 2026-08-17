/**
 * R-17 · OOXML 动画树生成器（纯函数）
 *
 * 输入：PPTAnimation[] + spidMap (Map<elId, spid>)
 * 输出：可直接插入 slide XML 的 <p:timing>...</p:timing> 字符串
 *
 * 结构参照 refs/oh-my-ppt 的 @arcsin1/html2pptx 测试套件（animation-writer.test.ts）
 * 逆向得出的 OOXML timing 树：
 *
 *   <p:timing>
 *     <p:tnLst>
 *       <p:par>
 *         <p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot">
 *           <p:childTnLst>
 *             <p:seq concurrent="1" nextAc="seek">
 *               <p:cTn id="2" dur="indefinite" nodeType="mainSeq">
 *                 <p:childTnLst>
 *                   ... 每个「点击步」一个 <p:par>，内含效果节点 ...
 *                 </p:childTnLst>
 *               </p:cTn>
 *               <p:prevCondLst>...</p:prevCondLst>
 *               <p:nextCondLst>...</p:nextCondLst>
 *             </p:seq>
 *           </p:childTnLst>
 *         </p:cTn>
 *       </p:par>
 *     </p:tnLst>
 *     <p:bldLst>
 *       <p:bldP spid="X" grpId="0"/>
 *     </p:bldLst>
 *   </p:timing>
 *
 * 不碰 DOM、不碰 ZIP、不碰文件系统。
 */

import type { PPTAnimation, AnimationEffect } from '@/types/slides'
import { ANIMATION_DEFS, type PptxAnimationPreset, type PptxMotion } from '@/configs/animation'

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

export const getAnimationPreset = (effect: string): PptxAnimationPreset | undefined => {
  const def = ANIMATION_DEFS[effect as AnimationEffect]
  return def?.pptx
}

let _nextId = 0
const nextId = () => ++_nextId

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

  // 1. Visibility set (entrance: hidden→visible; exit: visible→hidden)
  if (!isEmph) {
    const visFrom = isExit ? 'visible' : 'hidden'
    const visTo = isExit ? 'hidden' : 'visible'
    parts.push(
      `<p:set>` +
        `<p:cBhvr>` +
          `<p:cTn id="${nextId()}" dur="1" fill="hold">` +
            `<p:stCondLst><p:cond delay="0"/></p:stCondLst>` +
          `</p:cTn>` +
          `<p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl>` +
          `<p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst>` +
        `</p:cBhvr>` +
        `<p:to><p:strVal val="${visTo}"/></p:to>` +
      `</p:set>`
    )
  }

  // 2. Fade effect
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

  // 3. Wipe effect
  if (preset.effectFilter === 'wipe') {
    const trans = preset.transition || 'in'
    const filter = preset.presetSubtype
      ? `wipe(${['', 'r', 'l', 'd', 'u'][preset.presetSubtype] || 'r'})`
      : 'wipe(r)'
    parts.push(
      `<p:animEffect transition="${trans}" filter="${filter}">` +
        `<p:cBhvr>` +
          `<p:cTn id="${nextId()}" dur="${dur}" accel="${accel}" decel="${decel}"/>` +
          `<p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl>` +
        `</p:cBhvr>` +
      `</p:animEffect>`
    )
  }

  // 4. Motion (entrance/exit with directional movement)
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

  // 5. Scale (non-emphasis entrance/exit)
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

  // 6. Emphasis scale (rebound: two phases inside a p:seq)
  if (preset.scaleFrom !== undefined && preset.scaleTo !== undefined && isEmph) {
    const halfDur = Math.floor(dur / 2)
    parts.push(
      `<p:seq>` +
        `<p:cTn id="${nextId()}" dur="indefinite" nodeType="mainSeq">` +
          `<p:childTnLst>` +
            `<p:animScale>` +
              `<p:cBhvr>` +
                `<p:cTn id="${nextId()}" dur="${halfDur}" accel="${accel}" decel="${decel}" fill="hold"/>` +
                `<p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl>` +
              `</p:cBhvr>` +
              `<p:from x="${preset.scaleFrom}" y="${preset.scaleFrom}"/>` +
              `<p:to x="${preset.scaleTo}" y="${preset.scaleTo}"/>` +
            `</p:animScale>` +
            `<p:animScale>` +
              `<p:cBhvr>` +
                `<p:cTn id="${nextId()}" dur="${dur - halfDur}" accel="${accel}" decel="${decel}" fill="remove"/>` +
                `<p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl>` +
              `</p:cBhvr>` +
              `<p:from x="${preset.scaleTo}" y="${preset.scaleTo}"/>` +
              `<p:to x="100000" y="100000"/>` +
            `</p:animScale>` +
          `</p:childTnLst>` +
        `</p:cTn>` +
      `</p:seq>`
    )
  }

  // 7. Rotation
  if (preset.rotateFrom !== undefined && preset.rotateTo !== undefined) {
    parts.push(
      `<p:animRot by="0" from="${preset.rotateFrom}" to="${preset.rotateTo}">` +
        `<p:cBhvr>` +
          `<p:cTn id="${nextId()}" dur="${dur}" accel="${accel}" decel="${decel}" fill="hold"/>` +
          `<p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl>` +
        `</p:cBhvr>` +
      `</p:animRot>`
    )
  }

  return parts.join('')
}

const buildEffectXml = (anim: EligibleAnimation, nodeType: string): string => {
  const { preset, animation } = anim
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
 * PPTist trigger → OOXML nodeType
 *
 * click   → clickEffect（需要用户点击）
 * meantime → withEffect（与上一条同时播放）
 * auto    → afterEffect（上一条结束后自动播放）
 *
 * 第一条如果是 click 以外的 trigger，也映射成 withEffect（自动开始），
 * 这样页面切换后 load 动画不需要额外点击。
 */
const triggerToNodeType = (trigger: string, isFirst: boolean): string => {
  if (trigger === 'click' && !isFirst) return 'clickEffect'
  if (trigger === 'click' && isFirst) return 'clickEffect'
  if (trigger === 'meantime') return 'withEffect'
  if (trigger === 'auto') return 'afterEffect'
  return 'withEffect'
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

  // Reset ID counter for this build
  _nextId = 0

  // Group by click steps: a new click step starts when trigger is 'click'
  // (unless it's the very first animation)
  const steps: EligibleAnimation[][] = []
  for (const anim of eligible) {
    if (anim.animation.trigger === 'click' && steps.length > 0) {
      steps.push([anim])
    }
    else {
      if (!steps.length) steps.push([])
      steps[steps.length - 1].push(anim)
    }
  }

  // Build main sequence children
  const stepXmls: string[] = []
  for (const step of steps) {
    const effectXmls: string[] = []
    for (let i = 0; i < step.length; i++) {
      const anim = step[i]
      const isFirst = i === 0
      const nodeType = triggerToNodeType(anim.animation.trigger, isFirst)
      effectXmls.push(buildEffectXml(anim, nodeType))
    }

    stepXmls.push(
      `<p:par>` +
        `<p:cTn id="${nextId()}" fill="hold">` +
          `<p:stCondLst><p:cond delay="0"/></p:stCondLst>` +
          `<p:childTnLst>` +
            effectXmls.join('') +
          `</p:childTnLst>` +
        `</p:cTn>` +
      `</p:par>`
    )
  }

  // Build list: unique spids
  const uniqueSpids = [...new Set(eligible.map(a => a.spid))]
  const bldEntries = uniqueSpids.map(spid => `<p:bldP spid="${spid}" grpId="0"/>`).join('')

  const xml =
    `<p:timing>` +
      `<p:tnLst>` +
        `<p:par>` +
          `<p:cTn id="${nextId()}" dur="indefinite" restart="never" nodeType="tmRoot">` +
            `<p:childTnLst>` +
              `<p:seq concurrent="1" nextAc="seek">` +
                `<p:cTn id="${nextId()}" dur="indefinite" nodeType="mainSeq">` +
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
