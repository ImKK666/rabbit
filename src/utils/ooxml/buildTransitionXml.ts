/**
 * R-26 · OOXML 页面转场生成器（纯函数）
 *
 * 输入：Slide.turningMode
 * 输出：可插入 slide XML 的 <p:transition .../> 字符串
 *
 * ## 为什么之前是零支持
 *
 * SLIDE_ANIMATIONS 有 12 种转场，网页侧 PPTist 用 CSS transition 实现，
 * 导出时 pptxgenjs 完全不写 `<p:transition>`（产物里 grep 计数为 0），
 * 整整一个动画品类在 PPTX 里缺席。
 *
 * ## ground truth
 *
 * refs/PPTAgent/pptagent/templates/default/source.pptx 是 PowerPoint 亲手写的，
 * 解包 ppt/slides/slide1.xml 末尾是：
 *
 *   </p:clrMapOvr>
 *   <mc:AlternateContent xmlns:mc="..." xmlns:p14="...">
 *     <mc:Choice Requires="p14"><p:transition spd="med" p14:dur="700"><p:fade/></p:transition></mc:Choice>
 *     <mc:Fallback><p:transition spd="med"><p:fade/></p:transition></mc:Fallback>
 *   </mc:AlternateContent>
 *   </p:sld>
 *
 * 也就是说：位置在 clrMapOvr 之后（符合 ECMA-376 对 CT_Slide 的顺序约束
 * cSld → clrMapOvr → **transition** → timing），而 p14:dur 只是给毫秒级时长的
 * 扩展，Fallback 里的裸 `<p:transition spd>` 才是所有阅读器都认的形态。
 *
 * **我们只写 Fallback 那一种。** 少一层 mc:AlternateContent，
 * 少一个命名空间声明，WPS / Keynote / LibreOffice 全都能认，
 * 代价只是时长粒度退化成 slow/med/fast 三档 —— 这个交易划算。
 *
 * ## 映射原则
 *
 * 只用 ECMA-376 基础 schema 里的转场（CT_SlideTransition 的 19 个子元素），
 * 不碰 p14/p15 扩展（棱锥、蜂巢、涟漪那些）—— 它们在非 PowerPoint 里直接不播。
 * 所以 slideX3D / slideY3D 会降级成普通推移，rotate 降级成 newsflash。
 * 降级是**声明式**的：degraded 字段会告诉调用方哪几页降了级。
 */

import type { TurningMode } from '@/types/slides'

/** ECMA-376 CT_SlideTransition 的 spd 取值 */
export type TransitionSpeed = 'slow' | 'med' | 'fast'

export interface TransitionMapping {
  /** <p:transition> 的子元素，如 `<p:fade/>` */
  element: string
  /** 网页效果在 PPTX 里没有等价物，用了近似替代 */
  degraded?: string
}

/**
 * 12 种 turningMode → OOXML 转场
 *
 * `no` 不在表里 —— 不写 <p:transition> 就是「无」，不需要显式元素。
 * `random` 用 OOXML 自己的 <p:random/>，让 PowerPoint 每次播放随机挑一个，
 * 语义和网页侧的「随机」一致（网页是打开时随机定一个，这里是每次播放随机，
 * 差别可以接受，好过展开成固定的某一种）。
 */
const TRANSITION_MAP: Record<Exclude<TurningMode, 'no'>, TransitionMapping> = {
  random: { element: '<p:random/>' },

  slideX: { element: '<p:push dir="l"/>' },
  slideY: { element: '<p:push dir="u"/>' },

  slideX3D: {
    element: '<p:push dir="l"/>',
    degraded: 'PPTX 基础规范没有 3D 推移（PowerPoint 的 3D 转场是 p14/p15 扩展，换个软件就不播），降级成普通左右推移',
  },
  slideY3D: {
    element: '<p:push dir="u"/>',
    degraded: 'PPTX 基础规范没有 3D 推移，降级成普通上下推移',
  },

  fade: { element: '<p:fade/>' },

  rotate: {
    element: '<p:newsflash/>',
    degraded: 'PPTX 基础规范没有整页旋转，降级成 newsflash（旋转缩放进入）',
  },

  // 展开 / 收拢：<p:split> 的 orient 指的是分割线方向
  //   orient="horz" → 上下两半分开（网页侧的「上下展开」）
  //   orient="vert" → 左右两半分开
  scaleY: { element: '<p:split orient="horz" dir="out"/>' },
  scaleX: { element: '<p:split orient="vert" dir="out"/>' },

  scale: { element: '<p:zoom dir="in"/>' },
  scaleReverse: { element: '<p:zoom dir="out"/>' },
}

export interface TransitionBuildResult {
  xml: string
  /** 降级说明，没降级时为 undefined */
  degraded?: string
}

/**
 * 生成 <p:transition> 片段
 *
 * @param turningMode 缺省 / 'no' / 不认识的值一律返回空串 ——
 *   **不给没设过转场的页面凭空加转场**。网页播放器把缺省当 slideY，
 *   但那是播放器的默认值，不是用户的意图；导入的 pptx 再导出时
 *   平白多出一堆推移动画是实打实的失真。
 */
export const buildTransitionXml = (
  turningMode: string | undefined,
  speed: TransitionSpeed = 'med',
): TransitionBuildResult => {
  if (!turningMode || turningMode === 'no') return { xml: '' }

  const mapping = TRANSITION_MAP[turningMode as Exclude<TurningMode, 'no'>]
  if (!mapping) return { xml: '' }

  return {
    xml: `<p:transition spd="${speed}">${mapping.element}</p:transition>`,
    degraded: mapping.degraded,
  }
}

/** 某个 turningMode 导出后是不是原样保真（给工具描述和 lint 用） */
export const isTransitionExactOnExport = (turningMode: string | undefined): boolean => {
  if (!turningMode || turningMode === 'no') return true
  const mapping = TRANSITION_MAP[turningMode as Exclude<TurningMode, 'no'>]
  return !!mapping && !mapping.degraded
}
