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
 * 剔掉了纯装饰性、语义重复的。塞满 prompt 换不来表现力，
 * 只会让模型在一堆近义词里犹豫。
 *
 * ## R-41：图标字形补上了
 *
 * 这里原来写着「『其他形状』『线性』两类共 51 个是 1024 viewBox 的图标字形，
 * 光看 path 无法可靠命名，猜错名字比没有更糟」。
 *
 * **前半句是对的，结论下早了** —— 看不出来是因为没把它们画出来看。
 * 一个 1600 字符的贝塞尔串人眼读不出是云还是锁，渲染成 150px 就一目了然。
 * 工具留在 `scripts/build-shape-sheet.ts`（生成联系表）+ `scripts/shoot-shape-sheet.mjs`
 * （截成 PNG），51 个逐个看过来命的名，存疑的放大再看一遍。
 *
 * 51 个里收了 47 个，**刻意排除 4 个**：
 *   - 3 个是第三方品牌标识（QQ 企鹅 / Twitter 小鸟 / GitLab 狐狸）。
 *     把别家商标交给一个会自动往用户文稿里盖图形的 agent，是给用户埋雷。
 *     它们在 UI 的形状面板里照常可选 —— 人自己挑是人自己的决定。
 *   - 1 个是孤零零的男性符号 ♂，集合里没有配套的 ♀。
 *     它最可能的用途（性别构成对比）恰恰是它一个人干不了的。
 *
 * 图标一律 `fixedRatio: true`：云被拉成 3:1 就不是云了。
 * 51 个的 path 全部过了 `toPoints`（PPTX 导出用的转换器），无一失败。
 *
 * ## 为什么引用 SHAPE_LIST 而不是复制 path
 *
 * 复制就有两份真相。这里按 (分类下标, 条目下标) 引用，
 * 并由 `__tests__/shapeCatalog.test.ts` 逐条钉住每个条目的特征
 * （pathFormula / pptxShapeType / path 前缀）—— 上游一旦重排，测试立刻红。
 */

export type ShapeCategory = 'basic' | 'container' | 'flow' | 'arrow' | 'accent' | 'icon'

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

  // --- 弧形箭头（和上面的直箭头同属箭头分类，只是形态不同）---
  { key: 'arrowUndo', name: '回退弧箭头', category: 'arrow', item: pick(2, 22), fixedRatio: true,
    usage: '回滚、撤销、返回上一步' },
  { key: 'arrowRedo', name: '前进弧箭头', category: 'arrow', item: pick(2, 23), fixedRatio: true,
    usage: '转发、推进、跳到下一步' },

  // ---------------------------------------------------------------------------
  // 图标字形（R-41）
  //
  // 1024 viewBox 的实心 / 线性图标，全部 fixedRatio —— 拉伸就不成样子。
  // usage 一律写「画的是什么 + 典型语义」：模型认的是语义，不是字形。
  // ---------------------------------------------------------------------------

  // 实心图标
  { key: 'heart', name: '心形', category: 'icon', item: pick(3, 0), fixedRatio: true,
    usage: '喜欢、关怀、健康、公益' },
  { key: 'starRound', name: '圆角星', category: 'icon', item: pick(3, 1), fixedRatio: true,
    usage: '收藏、评分 —— 比 star5 圆润，图标感更强，做装饰点缀用 star5' },
  { key: 'cloud', name: '云', category: 'icon', item: pick(3, 2), fixedRatio: true,
    usage: '云服务、云存储、SaaS、天气' },
  { key: 'bolt', name: '闪电', category: 'icon', item: pick(3, 3), fixedRatio: true,
    usage: '高性能、快速、能源、突发' },
  { key: 'flame', name: '火焰', category: 'icon', item: pick(3, 4), fixedRatio: true,
    usage: '热门、爆发式增长、紧急' },
  { key: 'tshirt', name: 'T 恤', category: 'icon', item: pick(3, 5), fixedRatio: true,
    usage: '服饰、零售、周边商品' },
  { key: 'folder', name: '文件夹', category: 'icon', item: pick(3, 6), fixedRatio: true,
    usage: '归档、分类、目录、资料库' },
  { key: 'phone', name: '电话听筒', category: 'icon', item: pick(3, 7), fixedRatio: true,
    usage: '联系方式、客服、通话' },
  { key: 'funnel', name: '漏斗', category: 'icon', item: pick(3, 10), fixedRatio: true,
    usage: '转化漏斗、筛选、逐层收敛' },
  { key: 'crown', name: '皇冠', category: 'icon', item: pick(3, 11), fixedRatio: true,
    usage: '会员、榜首、旗舰版' },
  { key: 'thumbUp', name: '点赞', category: 'icon', item: pick(3, 12), fixedRatio: true,
    usage: '认可、好评、推荐' },
  { key: 'user', name: '用户', category: 'icon', item: pick(3, 13), fixedRatio: true,
    usage: '人物、账号、角色 —— 实心版，线性版是 userLine' },
  { key: 'bird', name: '小鸟', category: 'icon', item: pick(3, 15), fixedRatio: true,
    usage: '轻盈、自由、生态 —— 装饰性较强' },
  { key: 'home', name: '房子', category: 'icon', item: pick(3, 16), fixedRatio: true,
    usage: '首页、地产、居家场景' },
  { key: 'pin', name: '图钉', category: 'icon', item: pick(3, 17), fixedRatio: true,
    usage: '标记重点、置顶、定位' },
  { key: 'wrench', name: '扳手', category: 'icon', item: pick(3, 18), fixedRatio: true,
    usage: '工具、配置、运维、修复' },
  { key: 'checkCircle', name: '圆形对勾', category: 'icon', item: pick(3, 19), fixedRatio: true,
    usage: '完成、通过、支持某项能力' },
  { key: 'minusCircle', name: '圆形减号', category: 'icon', item: pick(3, 20), fixedRatio: true,
    usage: '移除、收起、部分支持' },
  { key: 'closeCircle', name: '圆形叉', category: 'icon', item: pick(3, 21), fixedRatio: true,
    usage: '失败、否决、不支持 —— 和 checkCircle 成对做对比表' },
  { key: 'plusCircle', name: '圆形加号', category: 'icon', item: pick(3, 22), fixedRatio: true,
    usage: '新增、扩展、展开' },
  { key: 'playCircle', name: '圆形播放', category: 'icon', item: pick(3, 23), fixedRatio: true,
    usage: '视频入口、开始、演示' },
  { key: 'clock', name: '时钟', category: 'icon', item: pick(3, 24), fixedRatio: true,
    usage: '时间、时效、排期、耗时' },
  { key: 'chat', name: '对话气泡', category: 'icon', item: pick(3, 25), fixedRatio: true,
    usage: '沟通、评论、客户反馈' },
  { key: 'checkSquare', name: '方形对勾', category: 'icon', item: pick(3, 26), fixedRatio: true,
    usage: '清单项完成 —— 方形一套比圆形一套更「表格感」' },
  { key: 'minusSquare', name: '方形减号', category: 'icon', item: pick(3, 27), fixedRatio: true,
    usage: '清单项移除 / 不适用' },
  { key: 'closeSquare', name: '方形叉', category: 'icon', item: pick(3, 28), fixedRatio: true,
    usage: '清单项否决 / 缺失' },
  { key: 'playSquare', name: '方形播放', category: 'icon', item: pick(3, 29), fixedRatio: true,
    usage: '视频块、媒体位' },
  { key: 'plusSquare', name: '方形加号', category: 'icon', item: pick(3, 30), fixedRatio: true,
    usage: '清单项新增' },
  { key: 'shieldCheck', name: '盾牌对勾', category: 'icon', item: pick(3, 31), fixedRatio: true,
    usage: '安全、合规、质保、风控' },
  { key: 'trash', name: '垃圾桶', category: 'icon', item: pick(3, 32), fixedRatio: true,
    usage: '删除、废弃、回收、降本' },
  { key: 'flag', name: '旗帜', category: 'icon', item: pick(3, 33), fixedRatio: true,
    usage: '里程碑、目标、阶段终点 —— 时间轴上很好用' },
  { key: 'hourglass', name: '沙漏', category: 'icon', item: pick(3, 34), fixedRatio: true,
    usage: '等待、耗时、倒计时、周期' },
  { key: 'tag', name: '标签', category: 'icon', item: pick(3, 35), fixedRatio: true,
    usage: '分类标签、价格、促销' },

  // 线性图标 —— 同一语义有实心版时，线性版更轻，适合正文旁边的小标注
  { key: 'percent', name: '百分号', category: 'icon', item: pick(4, 0), fixedRatio: true,
    usage: '占比、增长率、折扣' },
  { key: 'lineArrowRight', name: '细箭头·右', category: 'icon', item: pick(4, 1), fixedRatio: true,
    usage: '流程指向、因果 —— 比实心 arrowRight 轻得多，不抢视觉' },
  { key: 'lineArrowUp', name: '细箭头·上', category: 'icon', item: pick(4, 2), fixedRatio: true,
    usage: '上升、增长、优先级提高' },
  { key: 'lineArrowLeft', name: '细箭头·左', category: 'icon', item: pick(4, 3), fixedRatio: true,
    usage: '回退、来源、反向' },
  { key: 'lineArrowDown', name: '细箭头·下', category: 'icon', item: pick(4, 4), fixedRatio: true,
    usage: '下降、下钻、成本降低' },
  { key: 'swap', name: '双向交换', category: 'icon', item: pick(4, 5), fixedRatio: true,
    usage: '互换、同步、双向数据流' },
  { key: 'menuLines', name: '三横线', category: 'icon', item: pick(4, 6), fixedRatio: true,
    usage: '列表、菜单、层级结构' },
  { key: 'closeLine', name: '细叉', category: 'icon', item: pick(4, 7), fixedRatio: true,
    usage: '关闭、否定 —— 线性版，比 closeCircle 克制' },
  { key: 'userLine', name: '用户·线性', category: 'icon', item: pick(4, 8), fixedRatio: true,
    usage: '人物、角色、团队 —— 线性版，多个并排时比实心 user 干净' },
  { key: 'mail', name: '信封', category: 'icon', item: pick(4, 9), fixedRatio: true,
    usage: '邮件、订阅、联系方式' },
  { key: 'monitor', name: '显示器', category: 'icon', item: pick(4, 10), fixedRatio: true,
    usage: '桌面端、大屏、演示环境' },
  { key: 'ban', name: '禁止', category: 'icon', item: pick(4, 11), fixedRatio: true,
    usage: '禁用、不支持、风险项' },
  { key: 'document', name: '文档', category: 'icon', item: pick(4, 12), fixedRatio: true,
    usage: '文件、报告、合同、规范' },
  { key: 'funnelLine', name: '漏斗·线性', category: 'icon', item: pick(4, 13), fixedRatio: true,
    usage: '筛选、转化 —— 线性版，做流程图时比实心 funnel 轻' },
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
    basic: [], container: [], flow: [], arrow: [], accent: [], icon: [],
  }
  for (const s of CATALOG) byCategory[s.category].push(s)

  const labels: Record<ShapeCategory, string> = {
    basic: '基础几何', container: '容器', flow: '流程 / 指向', arrow: '箭头', accent: '强调 / 装饰',
    // 图标是「一眼认出画的是什么」的那类，用法和版面形状不同 —— 标签里说清楚
    icon: '图标（等比缩放，配在文字旁边或卡片里，别拉伸）',
  }

  return (Object.keys(labels) as ShapeCategory[])
    .map(cat => `${labels[cat]}：${byCategory[cat].map(s => `${s.key}(${s.name})`).join(' · ')}`)
    .join('\n')
}
