/**
 * Tool Layer — agent 可调用的工具集
 *
 * 每个工具用 Vercel AI SDK 的 tool() 定义，Zod 做参数校验。
 * 写操作全部经 kernel 校验后才应用到 deck 状态。
 *
 * 工具签名参考 Presenton 的七类分类（outline / slide / element / component / theme / assets / context），
 * 简化为读 + 写两类。
 */

import { tool } from 'ai'
import { z } from 'zod'
import type { Slide, SlideTheme, PPTElement } from '@/types/slides'
import {
  findElementsByType,
  applyUpdateElement,
  applyAddElement,
  applyDeleteElement,
  applyAddSlide,
  applyUpdateSlide,
  applyDeleteSlide,
  applySetTheme,
  applyAddAnimations,
  applyRemoveAnimations,
  applyAnimationPreset,
  lintDeck,
  ANIMATION_EFFECTS,
  type KernelOutcome,
} from './kernel'

// ---------------------------------------------------------------------------
// Deck 状态持有者
// ---------------------------------------------------------------------------

export interface DeckState {
  slides: Slide[]
  theme: SlideTheme
  version: number
}

export type DeckStateAccessor = {
  get: () => DeckState
  set: (state: DeckState) => void
  onChange?: () => void
}

const applyMutation = (
  accessor: DeckStateAccessor,
  outcome: KernelOutcome,
): string => {
  if (!outcome.ok) return JSON.stringify({ ok: false, error: outcome.error })
  const state = accessor.get()
  accessor.set({ ...state, slides: outcome.data, version: state.version + 1 })
  accessor.onChange?.()

  // errors 此前被 filter 掉了 —— agent 写出零尺寸元素、留下孤儿动画，
  // 拿到的都是干净的 { ok: true }，永远学不到自己写错了。两级都要回传。
  const errors = outcome.issues.filter(i => i.level === 'error').map(i => i.message)
  const warnings = outcome.issues.filter(i => i.level === 'warning').map(i => i.message)

  return JSON.stringify({
    ok: true,
    version: state.version + 1,
    errors: errors.length ? errors : undefined,
    warnings: warnings.length ? warnings : undefined,
    hint: errors.length ? '本次修改已应用，但存在 error 级问题，请立即修复' : undefined,
  })
}

/** 元素摘要 —— getDeck / findElements 共用，别把整份 HTML content 灌给模型 */
const summarizeElement = (el: PPTElement) => ({
  id: el.id,
  type: el.type,
  ...('left' in el ? { left: el.left, top: el.top, width: el.width } : {}),
  ...('height' in el ? { height: el.height } : {}),
  ...(el.name ? { name: el.name } : {}),
  ...(el.type === 'text'
    ? { textType: el.textType, text: el.content.replace(/<[^>]*>/g, '').slice(0, 60) }
    : {}),
  ...(el.type === 'image' ? { src: el.src, imageType: el.imageType } : {}),
})

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

export const createAgentTools = (accessor: DeckStateAccessor) => ({
  // --- 读 ---

  getDeck: tool({
    description: '获取当前演示文稿的结构总览。传 includeElements=true 可一次拿到每页所有元素的摘要（id/类型/位置/文本前 60 字），审查和整体调整时用这个，比逐页 getSlide 省很多步',
    parameters: z.object({
      includeElements: z.boolean().optional().describe('是否连每页元素摘要一起返回，默认 false'),
    }),
    execute: async ({ includeElements }) => {
      const { slides, theme, version } = accessor.get()
      return JSON.stringify({
        slideCount: slides.length,
        slides: slides.map((s, i) => ({
          index: i,
          id: s.id,
          type: s.type,
          elementCount: s.elements.length,
          animationCount: s.animations?.length || 0,
          background: s.background?.type,
          ...(includeElements
            ? {
              elements: s.elements.map(summarizeElement),
              animations: s.animations?.map(a => ({ id: a.id, elId: a.elId, effect: a.effect, trigger: a.trigger })),
            }
            : {}),
        })),
        theme: { backgroundColor: theme.backgroundColor, fontColor: theme.fontColor, fontName: theme.fontName },
        version,
      })
    },
  }),

  getSlide: tool({
    description: '获取指定页面的完整数据，包括所有元素和动画',
    parameters: z.object({
      slideId: z.string().describe('幻灯片 ID'),
    }),
    execute: async ({ slideId }) => {
      const { slides } = accessor.get()
      const slide = slides.find(s => s.id === slideId)
      if (!slide) return JSON.stringify({ error: `幻灯片 "${slideId}" 不存在` })
      return JSON.stringify(slide)
    },
  }),

  findElements: tool({
    description: '按条件查找元素。可按页面、文本类型（title/subtitle/content 等）筛选',
    parameters: z.object({
      slideId: z.string().optional().describe('限定在某一页查找，不传则全局查找'),
      textType: z.string().optional().describe('文本语义类型：title, subtitle, content, item, itemTitle 等'),
    }),
    execute: async ({ slideId, textType }) => {
      const { slides } = accessor.get()
      const elements = findElementsByType(slides, slideId, textType)
      return JSON.stringify(elements.map(summarizeElement))
    },
  }),

  lintDeck: tool({
    description: '对整份演示文稿做几何校验，检测越界、空元素、孤儿动画等问题',
    parameters: z.object({}),
    execute: async () => {
      const { slides } = accessor.get()
      const issues = lintDeck(slides)
      return JSON.stringify({ issueCount: issues.length, issues })
    },
  }),

  // --- 写 ---

  updateElement: tool({
    description: '更新元素属性。可以改位置、大小、文本内容、颜色、字体等',
    parameters: z.object({
      elementId: z.string().describe('要修改的元素 ID'),
      props: z.record(z.unknown()).describe('要更新的属性键值对，如 { "left": 100, "content": "<p>新内容</p>" }'),
    }),
    execute: async ({ elementId, props }) => {
      const state = accessor.get()
      return applyMutation(accessor, applyUpdateElement(state.slides, elementId, props))
    },
  }),

  addElement: tool({
    description: '在指定页面添加元素。必须提供完整的元素数据',
    parameters: z.object({
      slideId: z.string().describe('目标幻灯片 ID'),
      element: z.record(z.unknown()).describe('完整的元素数据，必须包含 id, type, left, top, width, height, rotate 等'),
    }),
    execute: async ({ slideId, element }) => {
      const state = accessor.get()
      return applyMutation(accessor, applyAddElement(state.slides, slideId, element as unknown as PPTElement))
    },
  }),

  deleteElement: tool({
    description: '删除元素及其关联的动画',
    parameters: z.object({
      elementId: z.string().describe('要删除的元素 ID'),
    }),
    execute: async ({ elementId }) => {
      const state = accessor.get()
      return applyMutation(accessor, applyDeleteElement(state.slides, elementId))
    },
  }),

  addSlide: tool({
    description: '添加新页面。可指定插入位置',
    parameters: z.object({
      slide: z.record(z.unknown()).describe('完整的幻灯片数据，必须包含 id 和 elements'),
      afterIndex: z.number().int().optional().describe('在哪个索引之后插入，不传则追加到末尾'),
    }),
    execute: async ({ slide, afterIndex }) => {
      const state = accessor.get()
      return applyMutation(accessor, applyAddSlide(state.slides, slide as unknown as Slide, afterIndex))
    },
  }),

  updateSlide: tool({
    description: '更新页面属性（背景、备注、翻页方式等）。不要用这个改元素，用 updateElement',
    parameters: z.object({
      slideId: z.string().describe('幻灯片 ID'),
      props: z.record(z.unknown()).describe('要更新的属性，如 { "background": { "type": "solid", "color": "#fff" } }'),
    }),
    execute: async ({ slideId, props }) => {
      const state = accessor.get()
      return applyMutation(accessor, applyUpdateSlide(state.slides, slideId, props as Partial<Slide>))
    },
  }),

  deleteSlide: tool({
    description: '删除一页幻灯片。不能删除最后一页',
    parameters: z.object({
      slideId: z.string().describe('要删除的幻灯片 ID'),
    }),
    execute: async ({ slideId }) => {
      const state = accessor.get()
      return applyMutation(accessor, applyDeleteSlide(state.slides, slideId))
    },
  }),

  setTheme: tool({
    description: '更新演示文稿主题（背景色、字体颜色、字体名等）',
    parameters: z.object({
      props: z.record(z.unknown()).describe('要更新的主题属性，如 { "backgroundColor": "#1a1a2e", "fontColor": "#eee" }'),
    }),
    execute: async ({ props }) => {
      const state = accessor.get()
      const outcome = applySetTheme(state.theme, props as Partial<SlideTheme>)
      if (!outcome.ok) return JSON.stringify({ ok: false, error: outcome.error })
      accessor.set({ ...state, theme: outcome.data, version: state.version + 1 })
      accessor.onChange?.()
      return JSON.stringify({ ok: true, version: state.version + 1 })
    },
  }),

  setAnimationPreset: tool({
    description: '给整页套用动画方案，一次调用生成全页合法的动画时间线。想让一页元素「依次出现」「标题先出再出内容」时优先用这个，比逐个 addAnimation 省很多步。会覆盖该页原有动画',
    parameters: z.object({
      slideId: z.string().describe('幻灯片 ID'),
      preset: z.enum(['sequential', 'title-then-content', 'all-at-once', 'none']).describe(
        'sequential=按阅读顺序依次入场 / title-then-content=标题先入其余随后同时入 / all-at-once=全部同时入场 / none=清空本页动画',
      ),
      effect: z.enum(ANIMATION_EFFECTS).optional().describe('入场效果，默认 fade-up'),
      duration: z.number().int().min(100).max(5000).optional().describe('持续时间（毫秒），默认 600'),
    }),
    execute: async ({ slideId, preset, effect, duration }) => {
      const state = accessor.get()
      return applyMutation(accessor, applyAnimationPreset(state.slides, slideId, preset, { effect, duration }))
    },
  }),

  addAnimation: tool({
    description: '给指定元素追加动画。可一次传多条（数组）。整页统一编排请优先用 setAnimationPreset',
    parameters: z.object({
      slideId: z.string().describe('幻灯片 ID'),
      animations: z.array(z.object({
        id: z.string().describe('动画 ID，全页唯一，如 anim_xxx'),
        elId: z.string().describe('目标元素 ID，必须在本页存在'),
        effect: z.enum(ANIMATION_EFFECTS).describe('动画效果'),
        type: z.enum(['in', 'out', 'attention']).describe('必须与 effect 自洽：exit-* 是 out，pulse-*/grow-shrink-* 是 attention，其余是 in'),
        duration: z.number().int().min(100).max(5000).describe('持续时间（毫秒），推荐 500~1000'),
        trigger: z.enum(['click', 'meantime', 'auto']).describe('click=点击触发新一步, meantime=与上一条同时, auto=上一条结束后自动'),
      })).min(1).describe('动画配置数组'),
    }),
    execute: async ({ slideId, animations }) => {
      const state = accessor.get()
      return applyMutation(accessor, applyAddAnimations(state.slides, slideId, animations))
    },
  }),

  removeAnimation: tool({
    description: '删除动画。可按 animationIds、按 elementIds，或 all=true 清空整页。改动画时先删再加',
    parameters: z.object({
      slideId: z.string().describe('幻灯片 ID'),
      animationIds: z.array(z.string()).optional().describe('按动画 ID 删'),
      elementIds: z.array(z.string()).optional().describe('删掉这些元素身上的全部动画'),
      all: z.boolean().optional().describe('清空本页所有动画'),
    }),
    execute: async ({ slideId, animationIds, elementIds, all }) => {
      const state = accessor.get()
      return applyMutation(accessor, applyRemoveAnimations(state.slides, slideId, { animationIds, elementIds, all }))
    },
  }),

  setSlideBackground: tool({
    description: '设置页面背景（纯色、渐变、图片）',
    parameters: z.object({
      slideId: z.string().describe('幻灯片 ID'),
      background: z.object({
        type: z.enum(['solid', 'image', 'gradient']).describe('背景类型'),
        color: z.string().optional().describe('纯色背景颜色，如 #0a0e27'),
        image: z.object({
          src: z.string(),
          size: z.enum(['cover', 'contain', 'repeat']),
        }).optional().describe('图片背景'),
        gradient: z.object({
          type: z.enum(['linear', 'radial']),
          colors: z.array(z.object({ pos: z.number(), color: z.string() })),
          rotate: z.number(),
        }).optional().describe('渐变背景'),
      }).describe('背景配置'),
    }),
    execute: async ({ slideId, background }) => {
      const state = accessor.get()
      return applyMutation(accessor, applyUpdateSlide(state.slides, slideId, { background } as Partial<Slide>))
    },
  }),
})

export type AgentTools = ReturnType<typeof createAgentTools>
