import { SHAPE_LIST, SHAPE_PATH_FORMULAS, type ShapePoolItem } from './shapes'
import type { ShapePathFormulasKeys } from '@/types/slides'

/**
 * R-27 · 形状语义目录
 *
 * `configs/shapes.ts` 有 151 个带 SVG path 的现成形状，但**没有名字** ——
 * 它是给 UI 的图形网格用的，人用眼睛挑，不需要名字。
 *
 * agent 挑不了图。而 08-expressiveness.md 诊断的第 ③ 条正是：
 * prompt 因为「agent 写不对 SVG path」而主动劝退形状，代价是把表现力砍到只剩色块。
 *
 * 这个文件解决的就是这个问题：给其中一个**精选子集**起语义名，
 * agent 按名字选（`addShape` 的参数是 z.enum，选错在 schema 层就被拒），
 * 路径由这里生成，**agent 永远不用碰 SVG path**。
 *
 * ## 为什么不是全部 151 个
 *
 * - 「其他形状」「线性」两类共 51 个是 1024 viewBox 的图标字形（云、锁、灯泡……），
 *   光看 path 无法可靠命名，猜错名字比没有更糟。它们在 UI 里照常可用，
 *   等图标能力（见 server/src/agent/assets.ts 的 TODO）落地时再一起处理。
 * - 剩下的里面也剔掉了纯装饰性、语义重复的。塞满 prompt 换不来表现力，
 *   只会让模型在 60 个近义词里犹豫。
 *
 * ## 为什么引用 SHAPE_LIST 而不是复制 path
 *
 * 复制就有两份真相。这里按 (分类下标, 条目下标) 引用，
 * 并由 `__tests__/shapeCatalog.test.ts` 逐条钉住每个条目的特征
 * （pathFormula / pptxShapeType / path 前缀）—— 上游一旦重排，测试立刻红。
 */

export type ShapeCategory = 'basic' | 'container' | 'flow' | 'arrow' | 'accent'

export interface CatalogShape {
  key: string
  /** 中文名，给 UI 和日志用 */
  name: string
  category: ShapeCategory
  /** 一句话说明什么时候该用它 —— 这句会进 agent 的工具描述 */
  usage: string
  /** 宽高比锁定（圆、正多边形、图标这类拉伸就变形的） */
  fixedRatio?: boolean
  item: ShapePoolItem
}

const pick = (groupIndex: number, childIndex: number): ShapePoolItem => {
  const item = SHAPE_LIST[groupIndex]?.children[childIndex]
  if (!item) throw new Error(`shapeCatalog: SHAPE_LIST[${groupIndex}][${childIndex}] 不存在`)
  return item
}

const CATALOG: CatalogShape[] = [
  // --- 基础几何 ---
  { key: 'rect', name: '矩形', category: 'basic', item: pick(0, 0),
    usage: '色块、背景板、分区底色' },
  { key: 'roundRect', name: '圆角矩形', category: 'basic', item: pick(0, 1),
    usage: '卡片底板 —— 最常用的一个，做卡片就用它' },
  { key: 'snipRect', name: '切角矩形', category: 'basic', item: pick(0, 2),
    usage: '标签、徽章，比圆角更硬朗' },
  { key: 'ellipse', name: '椭圆 / 圆', category: 'basic', item: pick(1, 0), fixedRatio: true,
    usage: '头像位、序号圆点、图标底' },
  { key: 'triangle', name: '三角形', category: 'basic', item: pick(1, 1),
    usage: '指示、装饰角标' },
  { key: 'rightTriangle', name: '直角三角形', category: 'basic', item: pick(1, 2),
    usage: '角落装饰、切割构图' },
  { key: 'parallelogram', name: '平行四边形', category: 'basic', item: pick(1, 4),
    usage: '动感标签、速度感构图' },
  { key: 'trapezoid', name: '梯形', category: 'basic', item: pick(1, 6),
    usage: '漏斗、层级金字塔的一层' },
  { key: 'diamond', name: '菱形', category: 'basic', item: pick(1, 7), fixedRatio: true,
    usage: '流程判断节点、装饰点' },
  { key: 'hexagon', name: '六边形', category: 'basic', item: pick(1, 20), fixedRatio: true,
    usage: '蜂巢式并列、技术感网格' },
  { key: 'octagon', name: '八边形', category: 'basic', item: pick(1, 22), fixedRatio: true,
    usage: '停止 / 警示、强调徽章' },
  { key: 'pill', name: '胶囊', category: 'basic', item: pick(1, 26),
    usage: '标签、tag、状态条 —— 短文字外框的首选' },
  { key: 'halfCircle', name: '半圆', category: 'basic', item: pick(1, 12),
    usage: '装饰弧、页脚弧形分隔' },

  // --- 容器 ---
  { key: 'frame', name: '空心边框', category: 'container', item: pick(1, 34),
    usage: '描边框、强调区域，中间镂空不挡内容' },
  { key: 'donut', name: '圆环', category: 'container', item: pick(1, 35), fixedRatio: true,
    usage: '进度环、占比示意' },
  { key: 'callout', name: '对话框', category: 'container', item: pick(1, 42),
    usage: '引述、旁白、批注' },
  { key: 'roundCallout', name: '圆角对话框', category: 'container', item: pick(1, 43),
    usage: '引述、旁白，比方角更柔和' },

  // --- 流程 / 指向 ---
  { key: 'chevron', name: 'V 形箭头', category: 'flow', item: pick(2, 11),
    usage: '流程步骤条 —— 首选，多个并排就是流程图' },
  { key: 'chevronLeft', name: 'V 形箭头（左）', category: 'flow', item: pick(2, 12),
    usage: '反向流程、回退步骤' },
  { key: 'pentagonArrow', name: '五边形箭头', category: 'flow', item: pick(2, 13),
    usage: '流程的第一段（左边是平的，接得住起点）' },
  { key: 'homePlate', name: '房形标签', category: 'flow', item: pick(2, 14),
    usage: '流程的最后一段（右边是平的，收得住终点）' },
  { key: 'indicator', name: '双向尖标', category: 'flow', item: pick(1, 9),
    usage: '时间轴节点、承上启下的中间段' },
  { key: 'bullet', name: '盾形标记', category: 'flow', item: pick(1, 8),
    usage: '序号牌、章节标记' },

  // --- 箭头 ---
  { key: 'arrowRight', name: '右箭头', category: 'arrow', item: pick(2, 2),
    usage: '因果、推导、指向下一步' },
  { key: 'arrowLeft', name: '左箭头', category: 'arrow', item: pick(2, 3),
    usage: '回溯、反向指向' },
  { key: 'arrowUp', name: '上箭头', category: 'arrow', item: pick(2, 0),
    usage: '增长、上升趋势' },
  { key: 'arrowDown', name: '下箭头', category: 'arrow', item: pick(2, 1),
    usage: '下降、向下拆解' },
  { key: 'arrowLeftRight', name: '左右双箭头', category: 'arrow', item: pick(2, 5),
    usage: '双向关系、对比、互相影响' },
  { key: 'arrowUpDown', name: '上下双箭头', category: 'arrow', item: pick(2, 4),
    usage: '区间、上下浮动' },
  { key: 'arrowThinRight', name: '细右箭头', category: 'arrow', item: pick(2, 15),
    usage: '轻量指向，不抢视觉' },
  { key: 'arrowBentUp', name: '折角箭头', category: 'arrow', item: pick(2, 20),
    usage: '转折、绕行、跨层级跳转' },

  // --- 强调 / 装饰 ---
  { key: 'bar', name: '横条', category: 'accent', item: pick(1, 37),
    usage: '标题下划条、分隔线、强调条 —— 高频，几乎每页都能用一条' },
  { key: 'cross', name: '十字', category: 'accent', item: pick(1, 32),
    usage: '加号、医疗 / 增补语义' },
  { key: 'corner', name: 'L 形角', category: 'accent', item: pick(1, 33),
    usage: '画面四角的框线装饰' },
  { key: 'diagStripe', name: '斜切块', category: 'accent', item: pick(1, 31),
    usage: '封面斜切背景、动感色块' },
  { key: 'star4', name: '四角星', category: 'accent', item: pick(1, 50), fixedRatio: true,
    usage: '闪光点、亮点标记' },
  { key: 'star5', name: '五角星', category: 'accent', item: pick(1, 51), fixedRatio: true,
    usage: '评分、推荐、重点标记' },
]

export const SHAPE_CATALOG: Record<string, CatalogShape> = Object.fromEntries(
  CATALOG.map(s => [s.key, s]),
)

/** 供 zod / z.enum 使用的键数组 */
export const SHAPE_CATALOG_KEYS = CATALOG.map(s => s.key) as [string, ...string[]]

export const getCatalogShape = (key: string): CatalogShape | undefined => SHAPE_CATALOG[key]

export interface ShapeGeometry {
  viewBox: [number, number]
  path: string
  fixedRatio: boolean
  pathFormula?: ShapePathFormulasKeys
  keypoints?: number[]
  special?: boolean
}

/**
 * 按目标尺寸算出形状几何。
 *
 * 逻辑与 `hooks/useCreateElement.ts` 的 createShapeElement 一致：
 * 带 pathFormula 的形状要按实际宽高重算 path 并把 viewBox 换成 [w, h]，
 * 否则圆角会随尺寸一起被拉伸成椭圆角。**这一步不做，宽卡片的圆角就是歪的。**
 */
export const buildShapeGeometry = (key: string, width: number, height: number): ShapeGeometry | null => {
  const shape = SHAPE_CATALOG[key]
  if (!shape) return null

  const { item } = shape
  const geometry: ShapeGeometry = {
    viewBox: item.viewBox,
    path: item.path,
    fixedRatio: shape.fixedRatio ?? false,
    ...(item.special ? { special: true } : {}),
  }

  if (item.pathFormula) {
    const formula = SHAPE_PATH_FORMULAS[item.pathFormula]
    geometry.pathFormula = item.pathFormula
    geometry.viewBox = [width, height]
    if ('editable' in formula && formula.editable) {
      geometry.path = formula.formula(width, height, formula.defaultValue!)
      geometry.keypoints = formula.defaultValue
    }
    else geometry.path = formula.formula(width, height)
  }

  return geometry
}

/** 给 prompt / 工具描述用的紧凑清单 */
export const describeShapeCatalog = (): string => {
  const byCategory: Record<ShapeCategory, CatalogShape[]> = {
    basic: [], container: [], flow: [], arrow: [], accent: [],
  }
  for (const s of CATALOG) byCategory[s.category].push(s)

  const labels: Record<ShapeCategory, string> = {
    basic: '基础几何', container: '容器', flow: '流程 / 指向', arrow: '箭头', accent: '强调 / 装饰',
  }

  return (Object.keys(labels) as ShapeCategory[])
    .map(cat => `${labels[cat]}：${byCategory[cat].map(s => `${s.key}(${s.name})`).join(' · ')}`)
    .join('\n')
}
