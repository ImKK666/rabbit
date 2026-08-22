/**
 * 策划稿 —— R-63 阶段化工作流的第一层（docs/16-workflow-redesign.md）
 *
 * 抄两个参照的「把想清楚做成一个独立阶段」：
 *   - ppt-agent-workflow-san 的「策划稿」：逐页规划卡（目的 / 要记住什么 /
 *     视觉形式），内容先于设计，闸门确认的是**方案**不是成品
 *   - GordenSuperPPTSkills 的「outline 层决策」：每页版式、段落结构、
 *     配色统一全部在规划层一次定死，执行层只照抄；错在方案里改一段 JSON，
 *     而不是重排几十页
 *
 * ## 为什么是独立的纯函数模块而不是 kernel 的一部分
 *
 * kernel 的职责是「deck 的校验与变更」，输入输出都是 deck；
 * 策划稿是**另一个载体**（conversations.plan_json），校验的是「方案」。
 * 两边共用同一套版式事实（LAYOUT_META 的 pace / 变体清单），
 * 所以这里 import layouts / kernel 的纯类型，而不反向。
 *
 * 三条本在 lintDeck 里的设计判据（相邻雷同 / 单一版式占比 / 节奏间隔）
 * 在这里**前置**成方案的硬错误 —— 方案写错当场拒，比建完几十页再报、
 * 再靠逐页重排修，便宜一个数量级（日志实测：会话 76 为改色重排了 169 次）。
 */

import { z } from 'zod'
import { LAYOUT_PATTERNS, LAYOUT_META, type LayoutPattern } from './layouts'
import type { Slide } from '@/types/slides'
import type { LintIssue } from './kernel'

// ---------------------------------------------------------------------------
// 类型与 schema
// ---------------------------------------------------------------------------

export interface PlanSlide {
  /** 将来直接当 slideId 用 —— 建页时 addSlide 传它 */
  id: string
  title: string
  /** 这页的目的（给谁看什么、为什么在这一页） */
  purpose: string
  /** 观众要记住的一句话 */
  keyMessage: string
  pattern: LayoutPattern
  /** 仅 title-center / bullets / cards 支持，默认 A */
  variant?: 'A' | 'B'
  /** 并列模块数 —— 内容密度基线的前置检查（P6） */
  modules: number
}

export interface PlanSection {
  id: string
  title: string
  /** 这段要干什么 */
  purpose: string
  slides: PlanSlide[]
}

export interface DeckPlan {
  version: 1
  /** 一句话叙事线 —— 闸门时给用户看 */
  narrative: string
  /** 一句话视觉意图 —— 闸门时给用户看 */
  styleIntent: string
  sections: PlanSection[]
}

/** 支持 B 变体的三个版式 —— 和 applyLayout / LAYOUT_VARIANTS 是同一份事实 */
const VARIANT_PATTERNS = new Set<LayoutPattern>(['title-center', 'bullets', 'cards'])

const PLAN_SLIDE_SCHEMA = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  purpose: z.string().min(1),
  keyMessage: z.string().min(1),
  pattern: z.enum(LAYOUT_PATTERNS),
  variant: z.enum(['A', 'B']).optional(),
  modules: z.number().int().min(0),
})

export const DECK_PLAN_SCHEMA = z.object({
  version: z.literal(1),
  narrative: z.string().min(1),
  styleIntent: z.string().min(1),
  sections: z.array(z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    purpose: z.string().min(1),
    slides: z.array(PLAN_SLIDE_SCHEMA).min(1),
  })).min(1),
})

// ---------------------------------------------------------------------------
// 判据阈值
// ---------------------------------------------------------------------------

/**
 * 连续内容页上限（方案级）。
 *
 * kernel lint ⑧ 的告警线是 6 页（`MAX_CONTENT_RUN = 5`，超过才报）；
 * 这里取 4 —— 方案是硬闸门，比事后 lint 严一档是刻意的：
 * 方案通过 = 建成后 lint ⑧ 一定不红；反过来在方案里改一串 JSON
 * 比建完再重排便宜得多。
 */
const PLAN_MAX_CONTENT_RUN = 4

/** 单一版式占比上限 —— 与 kernel lint ⑦ 同数（0.4 / 5 页起查 / 至少 3 页） */
const SPREAD_TOP_RATIO = 0.4
const SPREAD_MIN_SLIDES = 5
const SPREAD_MIN_COUNT = 2

/** 内容页的最少并列模块数 —— 与 roles.ts「内容密度基线」同数 */
const MIN_MODULES = 3

/** 段落序列比较的起查长度：单页段落不构成「模板复制」 */
const SECTION_SIG_MIN_LEN = 2

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

/**
 * 一段的版式序列签名 —— P5 拿它判「两个段落是不是同一套模板」。
 * 变体算进签名：cards A 和 cards B 是两种结构，整段用变体拉开不算复制。
 */
export const planSectionSignature = (section: PlanSection): string =>
  section.slides.map(s => `${s.pattern}|${s.variant ?? 'A'}`).join('+')

export type PlanValidation =
  | { ok: true, plan: DeckPlan }
  | { ok: false, errors: string[] }

/**
 * 校验一份策划稿（P1–P8）。
 *
 * 生产路径里形状已经被工具的 zod 参数挡过（`DECK_PLAN_SCHEMA`），
 * 这里对 `unknown` 再 safeParse 一遍是防「绕过工具直接喂」——
 * 负对照测的就是这一层。语义规则 P1–P8 只在这一处。
 */
export const validatePlan = (raw: unknown): PlanValidation => {
  const shape = DECK_PLAN_SCHEMA.safeParse(raw)
  if (!shape.success) {
    return {
      ok: false,
      errors: shape.error.issues.map(i => `方案形状不对（${i.path.join('.') || '根'}）：${i.message}`),
    }
  }
  const plan = shape.data
  const errors: string[] = []
  const allSlides = plan.sections.flatMap(s => s.slides)

  // P8 页数：至少封面 + 一页
  if (allSlides.length < 2) {
    errors.push(`方案只有 ${allSlides.length} 页 —— 至少 2 页（封面 + 至少一页内容）`)
  }

  // P1 变体只属于三个版式
  const variantMap = new Map<string, number>()
  for (const s of allSlides) {
    if (s.variant && !VARIANT_PATTERNS.has(s.pattern)) {
      errors.push(`「${s.id}」用了 ${s.pattern} 的变体 —— ${s.pattern} 没有 B 变体，只有 title-center / bullets / cards 支持`)
    }
    const v = s.variant ?? 'A'
    variantMap.set(`${s.pattern}|${v}`, (variantMap.get(`${s.pattern}|${v}`) ?? 0) + 1)
  }

  // P2 相邻两页不得同版式同变体（与 kernel lint ① 同键）
  for (let i = 1; i < allSlides.length; i++) {
    const prev = allSlides[i - 1]
    const cur = allSlides[i]
    if (prev.pattern === cur.pattern && (prev.variant ?? 'A') === (cur.variant ?? 'A')) {
      errors.push(`「${cur.id}」与上一页「${prev.id}」都是 ${cur.pattern}（同变体）—— 相邻两页换一个版式，或给 cards / bullets / title-center 用 B 变体`)
    }
  }

  // P3 单一版式占比（与 kernel lint ⑦ 同判据，版式名不带变体）
  if (allSlides.length >= SPREAD_MIN_SLIDES) {
    const counts = new Map<LayoutPattern, number>()
    for (const s of allSlides) counts.set(s.pattern, (counts.get(s.pattern) ?? 0) + 1)
    const [top, n] = [...counts].sort((a, b) => b[1] - a[1])[0]
    if (n > Math.max(SPREAD_MIN_COUNT, allSlides.length * SPREAD_TOP_RATIO)) {
      errors.push(`${allSlides.length} 页里有 ${n} 页都是「${LAYOUT_META[top].name}」（${Math.round(n / allSlides.length * 100)}%）—— 一个版式占全篇，换几个（有对比用 compare，有先后用 timeline，有图用 split-figure / image-grid）`)
    }
  }

  // P4 节奏：连续内容页（与 kernel lint ⑧ 同口径，阈值更严一档）
  {
    let run = 0
    let runStart: PlanSlide | undefined
    for (const s of allSlides) {
      if (LAYOUT_META[s.pattern].pace === 'content') {
        if (run === 0) runStart = s
        run++
      }
      else {
        if (run > PLAN_MAX_CONTENT_RUN && runStart) {
          errors.push(`从「${runStart.id}」起连着 ${run} 页都是内容页 —— 每 3~4 页插一页 section / stat / quote / full-figure 喘口气`)
        }
        run = 0
        runStart = undefined
      }
    }
    if (run > PLAN_MAX_CONTENT_RUN && runStart) {
      errors.push(`从「${runStart.id}」起连着 ${run} 页都是内容页 —— 每 3~4 页插一页 section / stat / quote / full-figure 喘口气`)
    }
  }

  // P5 段落序列去重 —— 日志实测的「5 个部门分组模板整组复制」就死在这
  for (let i = 0; i < plan.sections.length; i++) {
    for (let j = i + 1; j < plan.sections.length; j++) {
      const a = plan.sections[i]
      const b = plan.sections[j]
      if (a.slides.length < SECTION_SIG_MIN_LEN || b.slides.length < SECTION_SIG_MIN_LEN) continue
      if (planSectionSignature(a) === planSectionSignature(b)) {
        errors.push(
          `第 ${i + 1} 段「${a.title}」和第 ${j + 1} 段「${b.title}」的版式序列完全相同`
          + `（${planSectionSignature(a)}）—— 这是把同一套模板复制了两遍。`
          + `换掉至少一半版式，或给 cards / bullets / title-center 用 B 变体拉开`,
        )
      }
    }
  }

  // P6 内容页的密度与要点：modules 达标 + keyMessage 非空
  for (const [si, section] of plan.sections.entries()) {
    for (const s of section.slides) {
      if (LAYOUT_META[s.pattern].pace !== 'content') continue
      if (s.modules < MIN_MODULES) {
        errors.push(`「${s.id}」（第 ${si + 1} 段）是内容页但只有 ${s.modules} 个并列模块 —— 内容密度基线是至少 ${MIN_MODULES} 个（每个 = 标题 + 要点 + 一个指标）。内容不够先做厚：结构化拆解真实材料，不是放大字号填空`)
      }
      if (!s.keyMessage.trim()) {
        errors.push(`「${s.id}」（第 ${si + 1} 段）没有 keyMessage —— 每页都要写「观众要记住的一句话」`)
      }
    }
  }

  // P7 id 唯一
  const slideIds = new Set<string>()
  for (const s of allSlides) {
    if (slideIds.has(s.id)) errors.push(`页面 id「${s.id}」重复 —— 每页一个唯一 id，将来直接当 slideId 用`)
    slideIds.add(s.id)
  }
  const sectionIds = new Set<string>()
  for (const sec of plan.sections) {
    if (sectionIds.has(sec.id)) errors.push(`段落 id「${sec.id}」重复`)
    sectionIds.add(sec.id)
  }

  return errors.length ? { ok: false, errors } : { ok: true, plan }
}

// ---------------------------------------------------------------------------
// lint ⑫ · 策划稿一致性
// ---------------------------------------------------------------------------

/**
 * 建页之后：deck 有没有照方案走。
 *
 * 只出 warning 不拒绝 —— 局部调整、用户改主意都是合法的；但漂移必须被看见。
 * 两层各查一个方向：
 *   - 页对方案：已排版的页 pattern|variant 与方案声明不符 → 「版式偏离策划稿」
 *   - 方案对页：方案里声明了、deck 里连页都没有 → 「策划稿里的页还没建」
 * deck 里多出来的、方案没有的页不报（用户后加的页、局部调整都是它）。
 */
export const lintPlanAdherence = (plan: DeckPlan, slides: Slide[]): LintIssue[] => {
  const issues: LintIssue[] = []
  const byId = new Map(plan.sections.flatMap(s => s.slides).map(s => [s.id, s]))
  const deckIds = new Set(slides.map(s => s.id))

  for (const [i, slide] of slides.entries()) {
    if (!slide.layout) continue
    const entry = byId.get(slide.id)
    if (!entry) continue
    const built = `${slide.layout}|${slide.layoutVariant ?? 'A'}`
    const planned = `${entry.pattern}|${entry.variant ?? 'A'}`
    if (built !== planned) {
      issues.push({
        level: 'warning',
        slideId: slide.id,
        message: `第 ${i + 1} 页建成了「${built}」，与策划稿声明的「${planned}」不一致 —— 要么按方案重排，要么 setPlan 更新方案`,
      })
    }
  }

  for (const [si, section] of plan.sections.entries()) {
    for (const entry of section.slides) {
      if (!deckIds.has(entry.id)) {
        issues.push({
          level: 'warning',
          slideId: entry.id,
          message: `策划稿第 ${si + 1} 段里的「${entry.title}」还没有建 —— 按方案补上，或者 setPlan 更新方案`,
        })
      }
    }
  }

  return issues
}
