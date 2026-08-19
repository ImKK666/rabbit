/**
 * 版式出场顺序核查台（开发工具，不参与打包）
 *
 *   npm run layout-order                # 全部 10 个版式
 *   npm run layout-order -- cards stat  # 只看指定版式
 *   npm run layout-order -- --json      # 机读
 *
 * ## 为什么要它
 *
 * `scripts/build-animation-lab.ts` 验的是**单个效果的 CSS 本身**动不动、动得对不对。
 * 但「一页里先看到什么、后看到什么」是另一个问题：它由 `layouts.ts` 里
 * `b.animate()` 的**调用顺序 + trigger** 决定，和 CSS 一点关系都没有。
 * 起编辑器逐页放映能看出「顺序不对」，但看不出**为什么**不对 ——
 * 是编排写反了，还是某个元素根本没挂动画（没挂 = 一开始就在，永远排在第一位）。
 * 这两类的处置完全不同，混在一起就只能靠猜。
 *
 * 所以这里把一页拆成三张表：
 *   ① 元素清单（创建顺序 = z 序 = DOM 顺序）—— 谁挂了动画，谁没挂
 *   ② 动画序列（数组顺序）—— 效果 / trigger / 时长
 *   ③ 分步结果 —— 网页侧和 PPTX 侧各算一遍，当场对比
 *
 * ## 不另抄一套规则
 *
 * - 元素与动画：直接调 `buildLayout`，即 agent 走的那个函数
 * - 网页分步：起一个真的 pinia store 读 `formatedAnimations`（`src/store/slides.ts`）
 * - PPTX 分步：调 `groupTriggersIntoSteps`（`src/utils/animationSteps.ts`，导出侧同一份）
 * - 判据：调 `lintSlideAnimationOrder`（`server/src/domains/deck/animationOrder.ts`，lintDeck 同一份）
 *
 * 四处都是生产代码。这个文件里没有任何一行是「顺序规则」或「判据」的第二实现，
 * 它只负责把它们摆到一起看。唯一属于工具自己的检查是最后一条：
 * **网页分步和 PPTX 分步是不是逐格相同** —— 那是这两份实现之间的事，
 * 生产代码里没有谁会去比。
 */

/* eslint-disable no-console -- 命令行核查工具，输出就是它的产物 */
import { createPinia, setActivePinia } from 'pinia'
import { useSlidesStore } from '../src/store/slides'
import { groupTriggersIntoSteps, flattenTriggerSteps } from '../src/utils/animationSteps'
import type { PPTElement, PPTAnimation, Slide } from '../src/types/slides'
import {
  LAYOUT_PATTERNS, LAYOUT_META, buildLayout,
  type LayoutPattern, type LayoutContent,
} from '../server/src/domains/deck/layouts'
import { buildPalette } from '../server/src/domains/deck/design'
import { FULL, MINIMAL, THEME_LIGHT } from './layout-fixtures'
import { lintSlideAnimationOrder } from '../server/src/domains/deck/animationOrder'

/**
 * 样本内容共用 `layout-fixtures.ts`。
 *
 * 原来这里自己写了一套 FULL / MINIMAL，和联系表那套是两份 ——
 * 两边看到的不是同一页，「顺序对了但版面歪了」会从两个工具之间的缝里漏掉。
 */
const PALETTE = buildPalette(THEME_LIGHT)

// ---------------------------------------------------------------------------
// 元素画像
// ---------------------------------------------------------------------------

type Role = 'title' | 'content' | 'decor'

const TEXT_LABEL: Record<string, string> = {
  title: '标题', subtitle: '副标题', content: '正文', item: '条目正文',
  itemTitle: '条目标题', header: 'eyebrow', footer: '出处',
  partNumber: '章节号', itemNumber: '序号数字', notes: '备注',
}

const plain = (html: string) => html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()

/**
 * 元素的语义角色。
 *
 * 文本一律算内容（`itemNumber` 那种序号数字也是 —— 它压在色块上，
 * 色块动它不动就是穿帮）。图形默认算装饰，但**卡片底板 / 对比栏 / 时间轴节点**
 * 这类「内容的载体」按内容算：它们承载文字，不能和文字脱节。
 */
const roleOf = (el: PPTElement): Role => {
  if (el.type === 'text') return el.textType === 'title' ? 'title' : 'content'
  return 'decor'
}

const labelOf = (el: PPTElement): string => {
  if (el.type === 'text') {
    const kind = TEXT_LABEL[el.textType ?? ''] ?? '文本'
    const text = plain(el.content)
    return `${kind}「${text.length > 14 ? `${text.slice(0, 14)}…` : text}」`
  }
  if (el.type === 'line') return el.name ? `线条「${el.name}」` : '线条'
  return el.name ? `形状「${el.name}」` : `形状(${el.type})`
}

// ---------------------------------------------------------------------------
// 分步
// ---------------------------------------------------------------------------

setActivePinia(createPinia())
const store = useSlidesStore()

/** 网页侧真实分步：把这一页塞进 store，读 formatedAnimations */
const webSteps = (elements: PPTElement[], animations: PPTAnimation[]): { elIds: string[], autoNext: boolean }[] => {
  const slide: Slide = { id: 'probe', elements, animations }
  store.setSlides([slide])
  store.updateSlideIndex(0)
  return store.formatedAnimations.map(s => ({
    elIds: s.animations.map(a => a.elId),
    autoNext: s.autoNext,
  }))
}

/** PPTX 侧真实分步：click 步 → 子步（子步之间自动接续，等价于网页的 autoNext） */
const pptxSteps = (animations: PPTAnimation[]): { elIds: string[], autoNext: boolean }[] => {
  const flat: { elIds: string[], autoNext: boolean }[] = []
  const steps = groupTriggersIntoSteps(animations.map(a => a.trigger))
  for (const step of steps) {
    step.subSteps.forEach((group, i) => {
      flat.push({
        elIds: group.map(idx => animations[idx].elId),
        // 后面还有子步 = 播完自动接下一格
        autoNext: i < step.subSteps.length - 1,
      })
    })
  }
  return flat
}

// ---------------------------------------------------------------------------
// 判据
// ---------------------------------------------------------------------------

interface Finding {
  kind: string
  detail: string
}

interface Report {
  pattern: LayoutPattern
  variant: string
  elements: { idx: number, id: string, role: Role, label: string, step: number | null }[]
  animations: { order: number, label: string, effect: string, trigger: string, duration: number, step: number }[]
  steps: { elIds: string[], autoNext: boolean }[]
  findings: Finding[]
}

const analyse = (pattern: LayoutPattern, variant: string, content: LayoutContent): Report => {
  const { elements, animations } = buildLayout(pattern, content, PALETTE, `probe_${pattern}`)

  const web = webSteps(elements, animations)
  const pptx = pptxSteps(animations)

  // 元素 → 它第一次出场的步序号（null = 从来不出场，即一开始就在）
  const stepOf = new Map<string, number>()
  web.forEach((s, i) => {
    for (const id of s.elIds) if (!stepOf.has(id)) stepOf.set(id, i)
  })

  const byId = new Map(elements.map(el => [el.id, el]))

  // A / B / C：直接问 kernel，和 lintDeck 报给 agent 的是同一批话
  const findings: Finding[] = lintSlideAnimationOrder({ id: pattern, elements, animations })
    .map(issue => ({ kind: 'lint', detail: issue.message }))

  // 每格摊平后应当和 flattenTriggerSteps 一致 —— 顺带自查这个工具没算错
  const cells = flattenTriggerSteps(groupTriggersIntoSteps(animations.map(a => a.trigger)))
  if (cells.length !== web.length) {
    findings.push({ kind: '工具自查', detail: `摊平后 ${cells.length} 格，网页 ${web.length} 格` })
  }

  // D 两侧分步是否一致
  const key = (s: { elIds: string[], autoNext: boolean }[]) =>
    s.map(x => `${x.elIds.join('+')}${x.autoNext ? '→' : '.'}`).join(' ')
  if (key(web) !== key(pptx)) {
    findings.push({ kind: 'D-网页PPTX不一致', detail: `网页 ${key(web)}\n    PPTX ${key(pptx)}` })
  }

  return {
    pattern,
    variant,
    elements: elements.map((el, i) => ({
      idx: i + 1,
      id: el.id,
      role: roleOf(el),
      label: labelOf(el),
      step: stepOf.get(el.id) ?? null,
    })),
    animations: animations.map((a, i) => ({
      order: i + 1,
      label: labelOf(byId.get(a.elId)!),
      effect: a.effect,
      trigger: a.trigger,
      duration: a.duration,
      step: stepOf.get(a.elId) ?? -1,
    })),
    steps: web,
    findings,
  }
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

const pad = (s: string, n: number) => {
  // 中文按两格宽算，否则表格全是歪的
  const w = [...s].reduce((acc, ch) => acc + (/[⺀-￯]/.test(ch) ? 2 : 1), 0)
  return s + ' '.repeat(Math.max(0, n - w))
}

const ROLE_TAG: Record<Role, string> = { title: '标题', content: '内容', decor: '装饰' }

const print = (r: Report) => {
  const meta = LAYOUT_META[r.pattern]
  console.log(`\n${'═'.repeat(78)}`)
  console.log(`${r.pattern}（${meta.name}）· ${r.variant}`)
  console.log('═'.repeat(78))

  console.log('\n① 元素清单（创建顺序 = z 序，越靠后越在上层）')
  console.log(`  ${pad('#', 4)}${pad('角色', 6)}${pad('元素', 34)}出场`)
  for (const el of r.elements) {
    const at = el.step === null ? '★ 无动画 —— 进页就在' : `第 ${el.step + 1} 步`
    console.log(`  ${pad(String(el.idx), 4)}${pad(ROLE_TAG[el.role], 6)}${pad(el.label, 34)}${at}`)
  }

  console.log('\n② 动画序列（数组顺序 = 播放顺序）')
  console.log(`  ${pad('#', 4)}${pad('元素', 34)}${pad('效果', 14)}${pad('trigger', 10)}时长`)
  for (const a of r.animations) {
    console.log(`  ${pad(String(a.order), 4)}${pad(a.label, 34)}${pad(a.effect, 14)}${pad(a.trigger, 10)}${a.duration}ms`)
  }

  console.log('\n③ 分步（网页 formatedAnimations，与 PPTX groupTriggersIntoSteps 已对比）')
  let click = 0
  r.steps.forEach((s, i) => {
    const prevAuto = i > 0 && r.steps[i - 1].autoNext
    if (!prevAuto) click++
    const how = prevAuto ? '  ↳ 自动接续' : `点击 ${click}`
    const who = s.elIds.map(id => r.elements.find(e => e.id === id)!.label).join(' ＋ ')
    console.log(`  ${pad(`步 ${i + 1}`, 7)}${pad(how, 13)}${who}`)
  })

  console.log('\n④ 判据')
  if (!r.findings.length) console.log('  ✓ 全部通过')
  for (const f of r.findings) console.log(`  ✗ ${f.kind}：${f.detail}`)
}

const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const only = argv.filter(a => !a.startsWith('--')) as LayoutPattern[]
const targets = only.length ? only : [...LAYOUT_PATTERNS]

const reports = targets.map(p => analyse(p, '内容给满', FULL[p]))
const minimal = targets.map(p => analyse(p, '只给必填', MINIMAL[p]))

if (asJson) {
  console.log(JSON.stringify({ full: reports, minimal }, null, 2))
}
else {
  for (const r of reports) print(r)

  console.log(`\n${'═'.repeat(78)}`)
  console.log('汇总')
  console.log('═'.repeat(78))
  console.log(`  ${pad('版式', 16)}${pad('元素', 6)}${pad('挂了动画', 10)}${pad('格数', 6)}问题`)
  for (const r of reports) {
    const animated = r.elements.filter(e => e.step !== null).length
    console.log(
      `  ${pad(r.pattern, 16)}${pad(String(r.elements.length), 6)}`
      + `${pad(`${animated}/${r.elements.length}`, 10)}${pad(String(r.steps.length), 6)}`
      + `${r.findings.length ? `${r.findings.length} 条` : '—'}`,
    )
  }

  console.log('\n  「只给必填」变体：')
  const brokenMinimal = minimal.filter(r => r.findings.length)
  for (const r of brokenMinimal) {
    for (const f of r.findings) console.log(`    ${pad(r.pattern, 16)}${f.kind}：${f.detail}`)
  }
  if (!brokenMinimal.length) console.log(`    ✓ ${minimal.length} 个版式全部通过`)

  const total = reports.reduce((n, r) => n + r.findings.length, 0)
  console.log(`\n  合计 ${total} 条问题，涉及 ${reports.filter(r => r.findings.length).length} / ${reports.length} 个版式\n`)
}
