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
import { TURNING_MODES } from '@/configs/animation'
import { SHAPE_CATALOG_KEYS, describeShapeCatalog } from '@/configs/shapeCatalog'
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
  applyAddShape,
  applyAddChart,
  applyAddTable,
  applyAddLine,
  applyArrangeElements,
  applyLayoutToSlide,
  applySetSlideTransition,
  lintDeck,
  ANIMATION_EFFECTS,
  CHART_TYPES,
  type KernelOutcome,
} from './kernel'
import { LAYOUT_PATTERNS, describeLayouts } from './layouts'
import { buildPalette, describePaletteStyles, TYPE_SCALE, SPACING, SAFE } from './design'

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
  /**
   * 状态变更后的回调。**可以是异步的，且必须被 await** ——
   * 落库挂在这里（见 runtime/commit.ts），不等它落地就返回的话，
   * 工具会回一句 `{ ok: true }` 告诉 agent「改好了」，而那次写入其实还在飞。
   *
   * 改成 async 之后 17 个调用点一个字都没动：它们全是
   * `return applyMutation(...)` 且外层已经是 `async execute`。
   */
  onChange?: () => void | Promise<void>
}

const applyMutation = async (
  accessor: DeckStateAccessor,
  outcome: KernelOutcome,
): Promise<string> => {
  if (!outcome.ok) return JSON.stringify({ ok: false, error: outcome.error })
  const state = accessor.get()
  accessor.set({ ...state, slides: outcome.data, version: state.version + 1 })
  await accessor.onChange?.()

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
    description: '检查整份演示文稿。两类问题：几何（越界、文本重叠、空元素、孤儿动画）和设计（相邻页版式重复、整页没有非文本元素、动画种类太少）。收尾前必须跑一次',
    parameters: z.object({
      designChecks: z.boolean().optional().describe('是否包含设计类检查，默认 true'),
    }),
    execute: async ({ designChecks }) => {
      const { slides } = accessor.get()
      const issues = lintDeck(slides, { designChecks })
      return JSON.stringify({ issueCount: issues.length, issues })
    },
  }),

  getDesignTokens: tool({
    description: '获取当前主题推导出的设计规范：颜色角色（主色/强调色/正文/次要文字/卡片底/描边）、字号阶梯、间距栅格、安全区、可选的配色风格。自己配色前先调这个，别凭空编颜色',
    parameters: z.object({
      style: z.enum(['business', 'tech', 'academic', 'vivid']).optional()
        .describe('按哪个风格推导。不传按 business'),
    }),
    execute: async ({ style }) => {
      const { theme } = accessor.get()
      const palette = buildPalette(theme, undefined, style)
      return JSON.stringify({
        palette,
        style: style ?? 'business',
        styles: describePaletteStyles(),
        typeScale: TYPE_SCALE,
        spacing: SPACING,
        safeArea: { left: SAFE.left, top: SAFE.top, right: SAFE.right, bottom: SAFE.bottom },
        canvas: { width: 1000, height: 562.5 },
        hint: '同一个角色在整份文稿里只用一个取值。字号只在阶梯里挑，不要用阶梯之外的数值。'
          + '**风格整份文稿只选一个**，每页 applyLayout 都传同一个值 —— 换来换去等于没有风格',
      })
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
      await accessor.onChange?.()
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

  // --- 版式 / 图形 ---

  applyLayout: tool({
    description: `按语义版式重排一整页 —— **做新页面的首选做法**。你给版式名和内容，坐标、字号、间距、配色、层次、出场动画全部自动算，产出必然对齐、必然符合设计规范。

${describeLayouts()}

注意：会清空该页原有元素重排（版式的价值来自「所有元素同属一套网格」）。要微调请在 applyLayout 之后用 updateElement。
相邻两页不要用同一个版式 —— lintDeck 会报。`,
    parameters: z.object({
      slideId: z.string().describe('幻灯片 ID'),
      pattern: z.enum(LAYOUT_PATTERNS).describe('版式名'),
      content: z.object({
        eyebrow: z.string().optional().describe('标题上方的小标签：章节名/分类/日期。section 版式用它当章节号（如 "03"）'),
        title: z.string().optional().describe('主标题'),
        subtitle: z.string().optional().describe('副标题 / 一句话说明'),
        items: z.array(z.object({
          label: z.string().optional().describe('时间轴节点的标签，如 "2024" "第一步"'),
          title: z.string().optional().describe('条目标题'),
          body: z.string().optional().describe('条目正文，一到两句'),
        })).optional().describe('并列条目，数量要求见版式说明'),
        stat: z.object({
          value: z.string().describe('要放大的数字或短句，如 "87%" "3.2 亿"'),
          label: z.string().optional().describe('这个数字是什么'),
          note: z.string().optional().describe('补充说明'),
        }).optional().describe('stat 版式专用'),
        quote: z.string().optional().describe('quote 版式专用：引述的那段话'),
        source: z.string().optional().describe('出处 / 数据来源'),
        image: z.object({
          src: z.string().describe('必须是 searchImage / generateImage 返回的 asset:// 地址，不能填图库网址'),
          width: z.number().optional().describe('图片真实宽度，把工具返回值原样抄进来'),
          height: z.number().optional().describe('图片真实高度，把工具返回值原样抄进来'),
          luminance: z.tuple([z.number(), z.number()]).optional()
            .describe('图片亮度，把工具返回的 luminance 原样抄进来。少了它背景遮罩只能按中位数压，深色照片会被压灰'),
        }).optional().describe('本页配图。只有标了「可配图」的版式吃它，摆放位置/裁剪/遮罩全部自动算'),
      }).describe('版式内容'),
      animate: z.boolean().optional().describe('是否生成出场动画，默认 true。每个版式的编排各不相同'),
      style: z.enum(['business', 'tech', 'academic', 'vivid']).optional()
        .describe('配色风格。**整份文稿只选一个，每页都传同一个** —— 选哪个是内容决策（学术汇报和产品发布会本来就该长得不一样），具体色值由代码定'),
      typography: z.enum(['classic', 'scholarly', 'editorial', 'minimal', 'impact', 'warm']).optional()
        .describe('字体配对。**整份文稿只选一个，每页都传同一个**，规则和 style 完全一样 —— 选哪套字是内容决策（讲书法的稿子和讲芯片的稿子不该用同一套字），display 配哪个 body、每个字体的字宽表由代码定。不传就是 classic'),
      primaryColor: z.string().optional().describe('覆盖本页主色，如 #2f6feb'),
      accentColor: z.string().optional().describe('覆盖本页强调色'),
      backgroundColor: z.string().optional().describe('覆盖本页背景色'),
    }),
    execute: async ({ slideId, pattern, content, animate, style, typography, primaryColor, accentColor, backgroundColor }) => {
      const state = accessor.get()
      const paletteOverride = {
        ...(primaryColor ? { primary: primaryColor } : {}),
        ...(accentColor ? { accent: accentColor } : {}),
        ...(backgroundColor ? { background: backgroundColor } : {}),
      }
      return applyMutation(accessor, applyLayoutToSlide(
        state.slides, slideId, state.theme, pattern, content,
        { animate, style, typography, paletteOverride: Object.keys(paletteOverride).length ? paletteOverride : undefined },
      ))
    },
  }),

  addShape: tool({
    description: `添加一个形状。**按名字选，不要写 SVG path** —— 路径由形状库生成。

${describeShapeCatalog()}

高频用法：bar 做标题下划条 / 分隔线，roundRect 做卡片底板，pill 做标签，chevron 排流程，ellipse 做序号圆点，donut 做进度环。
纯文字的页面几乎一定不好看 —— 每页至少放一个形状。`,
    parameters: z.object({
      slideId: z.string().describe('幻灯片 ID'),
      shape: z.enum(SHAPE_CATALOG_KEYS).describe('形状名'),
      left: z.number().describe('左边距'),
      top: z.number().describe('上边距'),
      width: z.number().positive().describe('宽'),
      height: z.number().positive().describe('高'),
      fill: z.string().describe('填充色 hex，如 #2f6feb。用 getDesignTokens 拿主色/强调色'),
      opacity: z.number().min(0).max(1).optional().describe('不透明度。装饰性色块建议 0.1~0.2'),
      rotate: z.number().optional().describe('旋转角度'),
      outlineColor: z.string().optional().describe('描边色'),
      outlineWidth: z.number().optional().describe('描边宽度，默认 1'),
      shadow: z.boolean().optional().describe('加投影。卡片底板建议开'),
      text: z.string().optional().describe('形状内文字（纯文本，会自动居中）'),
      textColor: z.string().optional().describe('形状内文字颜色'),
      textSize: z.number().optional().describe('形状内文字字号'),
      name: z.string().optional().describe('元素名，方便后续引用'),
    }),
    execute: async ({ slideId, ...spec }) => {
      const state = accessor.get()
      return applyMutation(accessor, applyAddShape(state.slides, slideId, spec))
    },
  }),

  addChart: tool({
    description: '添加图表。有数字就画图表，别用文字罗列数字 —— 这是提升信息密度最直接的一招。series 的条数要等于 legends 的条数，每条 series 的点数要等于 labels 的个数',
    parameters: z.object({
      slideId: z.string().describe('幻灯片 ID'),
      chartType: z.enum(CHART_TYPES).describe('bar=柱状 / column=条形(横) / line=折线 / area=面积 / pie=饼 / ring=环 / radar=雷达 / scatter=散点'),
      left: z.number().describe('左边距'),
      top: z.number().describe('上边距'),
      width: z.number().positive().describe('宽，建议 ≥ 360'),
      height: z.number().positive().describe('高，建议 ≥ 240'),
      labels: z.array(z.string()).min(1).describe('横轴分类，如 ["2021","2022","2023"]'),
      legends: z.array(z.string()).min(1).describe('系列名，如 ["营收","利润"]'),
      series: z.array(z.array(z.number())).min(1).describe('每个系列一组数，长度必须等于 labels 长度'),
      themeColors: z.array(z.string()).optional().describe('系列配色，不传则用主题的主色+强调色'),
      stack: z.boolean().optional().describe('堆叠（bar/column）'),
      lineSmooth: z.boolean().optional().describe('平滑曲线（line）'),
      name: z.string().optional(),
    }),
    execute: async ({ slideId, ...spec }) => {
      const state = accessor.get()
      return applyMutation(accessor, applyAddChart(state.slides, slideId, state.theme, spec))
    },
  }),

  addTable: tool({
    description: '添加表格。适合规格对比、参数清单这类结构化数据。rows 是二维字符串数组，每行列数必须一致',
    parameters: z.object({
      slideId: z.string().describe('幻灯片 ID'),
      left: z.number().describe('左边距'),
      top: z.number().describe('上边距'),
      width: z.number().positive().describe('总宽'),
      rows: z.array(z.array(z.string())).min(1).describe('二维数据，首行默认是表头'),
      header: z.boolean().optional().describe('首行是否为表头，默认 true'),
      colWidths: z.array(z.number()).optional().describe('各列宽度权重，会自动归一化。不传则等宽'),
      rowHeight: z.number().optional().describe('行高，默认 40'),
      themeColor: z.string().optional().describe('表头底色，默认用主题主色'),
      name: z.string().optional(),
    }),
    execute: async ({ slideId, ...spec }) => {
      const state = accessor.get()
      return applyMutation(accessor, applyAddTable(state.slides, slideId, state.theme, spec))
    },
  }),

  addLine: tool({
    description: '添加线条。做分隔线、连接线、指向箭头。end 是相对起点的偏移量：水平线用 [长度, 0]，垂直线用 [0, 长度]',
    parameters: z.object({
      slideId: z.string().describe('幻灯片 ID'),
      left: z.number().describe('起点 x'),
      top: z.number().describe('起点 y'),
      end: z.tuple([z.number(), z.number()]).describe('终点相对起点的偏移，如 [800, 0] 是一条 800 长的水平线'),
      color: z.string().describe('颜色 hex'),
      style: z.enum(['solid', 'dashed', 'dotted']).optional().describe('线型，默认 solid'),
      width: z.number().optional().describe('线宽，默认 2'),
      startPoint: z.enum(['', 'arrow', 'dot']).optional().describe('起点样式'),
      endPoint: z.enum(['', 'arrow', 'dot']).optional().describe('终点样式，指向关系用 arrow'),
      name: z.string().optional(),
    }),
    execute: async ({ slideId, ...spec }) => {
      const state = accessor.get()
      return applyMutation(accessor, applyAddLine(state.slides, slideId, spec))
    },
  }),

  arrangeElements: tool({
    description: '对齐 / 等距分布一组元素。手填的坐标差几像素肉眼看不出差在哪，只会觉得这页「有点脏」—— 摆完一组并列元素就调一次这个',
    parameters: z.object({
      elementIds: z.array(z.string()).min(2).describe('要排列的元素 ID，必须在同一页'),
      align: z.enum(['left', 'right', 'hcenter', 'top', 'bottom', 'vcenter']).optional()
        .describe('对齐方式：left/right/hcenter 管水平，top/bottom/vcenter 管垂直'),
      distribute: z.enum(['horizontal', 'vertical']).optional()
        .describe('等距分布方向。不传 gap 时保持首尾不动、中间均分'),
      gap: z.number().optional().describe('固定间距（配合 distribute）。首元素不动，其余按此间距排开'),
    }),
    execute: async ({ elementIds, align, distribute, gap }) => {
      const state = accessor.get()
      return applyMutation(accessor, applyArrangeElements(state.slides, elementIds, { align, distribute, gap }))
    },
  }),

  setSlideTransition: tool({
    description: '设置翻页转场。整份文稿建议只用一到两种（统一节奏），章节转场页可以用不一样的强调切换。全部会写进 PPTX 的 <p:transition>，导出后照样播',
    parameters: z.object({
      slideId: z.string().describe('幻灯片 ID'),
      turningMode: z.enum(TURNING_MODES as [string, ...string[]]).describe(
        'no=无 / fade=淡入淡出（最稳妥）/ slideX=左右推移 / slideY=上下推移 / scale=放大 / scaleReverse=缩小 / scaleX=左右展开 / scaleY=上下展开 / rotate=旋转 / random=随机。slideX3D / slideY3D 导出时会降级成普通推移',
      ),
    }),
    execute: async ({ slideId, turningMode }) => {
      const state = accessor.get()
      return applyMutation(accessor, applySetSlideTransition(state.slides, slideId, turningMode))
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
