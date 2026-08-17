/**
 * R-17 · OOXML 动画树生成器（纯函数）
 *
 * 输入：PPTAnimation[] + spidMap (Map<elId, spid>)
 * 输出：可直接插入 slide XML 的 <p:timing>...</p:timing> 字符串
 *
 * ⚠️ 当前只是签名骨架（E3 之前不写真实 XML）。
 * docs/05-pptx-export.md 第四节明确警告「不要凭记忆写这棵树」——
 * 必须先在 PowerPoint 里手工做参考 .pptx（E3），解包读真实 XML，
 * 照抄它的嵌套细节、必需属性和节点先后顺序。写错的典型表现是
 * PowerPoint 静默忽略整个 <p:timing> 或弹「需要修复」。
 *
 * E4 打通一个效果（fade）端到端后，E5 铺满 25 个效果。
 *
 * 不碰 DOM、不碰 ZIP、不碰文件系统 —— 这样才能对着 E3 采集的
 * 地面真相做快照测试（vitest）。
 */

import type { PPTAnimation } from '@/types/slides'
import type { AnimationEffect } from '@/types/slides'
import { ANIMATION_DEFS, type PptxAnimationPreset } from '@/configs/animation'

export interface TimingBuildResult {
  xml: string
  skipped: SkippedAnimation[]
}

export interface SkippedAnimation {
  animation: PPTAnimation
  reason: string
}

/**
 * 查找动画效果的 PPTX preset 定义
 */
export const getAnimationPreset = (effect: string): PptxAnimationPreset | undefined => {
  const def = ANIMATION_DEFS[effect as AnimationEffect]
  return def?.pptx
}

/**
 * 生成 <p:timing> XML 片段
 *
 * @param animations 当页的动画列表（已按时间线排序）
 * @param spidMap elId → spid 映射（由 spidMap.ts 的 buildSpidMap 构建）
 * @returns xml 字符串 + 被跳过的动画列表（含原因）
 *
 * 跳过条件（宁可少动画，不要作用错元素）：
 * - elId 在 spidMap 中查不到
 * - effect 没有对应的 PPTX preset
 * - exportBehavior 为 'web-only'
 */
export const buildTimingXml = (
  animations: PPTAnimation[],
  spidMap: Map<string, number>,
): TimingBuildResult => {
  const skipped: SkippedAnimation[] = []

  const eligible = animations.filter(anim => {
    if (anim.exportBehavior === 'web-only') {
      skipped.push({ animation: anim, reason: 'exportBehavior 为 web-only，跳过' })
      return false
    }
    if (!spidMap.has(anim.elId)) {
      skipped.push({ animation: anim, reason: `elId "${anim.elId}" 在 spidMap 中查不到，跳过` })
      return false
    }
    const preset = getAnimationPreset(anim.effect)
    if (!preset) {
      skipped.push({ animation: anim, reason: `effect "${anim.effect}" 没有对应的 PPTX preset，跳过` })
      return false
    }
    return true
  })

  if (!eligible.length) return { xml: '', skipped }

  // TODO(E4): 照着 E3 采集的地面真相组装真实的 <p:timing> 树。
  // 目前返回空串 —— jszip round-trip 不会注入任何内容，等同于现状（无动画导出）。
  return { xml: '', skipped }
}
