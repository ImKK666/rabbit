/**
 * R-39 · 出场顺序 lint
 *
 * 「一页里先看到什么、后看到什么」和几何、配色一样是可判的，而且判错的代价不小：
 * 顺序不对时观众读到的其实是另一份文稿。三条判据，全部只看 trigger 序列和 textType。
 *
 * ## 这条 lint 守的是哪条路
 *
 * **不是 applyLayout 那条。** 版式的出场编排由 `layouts.ts` 保证，那里有单测逐版式盯着
 * （`layouts.test.ts` 的「出场顺序」一节，10 个版式 × 2 份内容）。
 * 这里守的是**手工搭页**：agent 用 addElement + addAnimation 自己拼时间线，
 * 就可能拼出一个读不通的顺序，而那是它自己能修的。
 *
 * 若哪天它对某个版式页报了警，那说明版式引擎退化了 —— 不是 agent 干的，
 * 也不该由 agent 来修。`kernel-elements.test.ts` 里「applyLayout 产物零告警」
 * 那一组就是在守这条边界：一旦破了，agent 每跑一份 deck 都会收到一条自己修不掉的意见，
 * Reviewer → Generator 白绕一圈（08-expressiveness.md 第四节）。
 *
 * ## 为什么单独一个文件
 *
 * kernel.ts 已经 1400 多行，顶到 eslint 的 max-lines。这一块和变更操作、
 * zod schema 都不耦合，只依赖 Slide 和分步规则，拆出来正好。
 */

// LintIssue 是 kernel 的公共类型，kernel 又会 import 这个文件里的函数 ——
// 但这里是 `import type`，编译时就被抹掉，运行时不存在循环
import type { Slide, PPTElement } from '@/types/slides'
import { groupTriggersIntoSteps, flattenTriggerSteps } from '@/utils/animationSteps'
import type { LintIssue } from './kernel'

/**
 * 标题块：eyebrow（header）和章节号（partNumber）总是紧贴标题排版，
 * 三者之间谁先谁后都是合理的建场顺序，不参与「标题是不是被内容抢了先」的比较。
 */
const TITLE_BLOCK_TEXT_TYPES = new Set(['title', 'header', 'partNumber'])

/** 一条告警里最多点几个元素的名字，多了信息量反而下降 */
const MAX_NAMED_IN_ISSUE = 4

const nameList = (els: PPTElement[]): string => {
  const names = els.slice(0, MAX_NAMED_IN_ISSUE).map(el => `"${el.name || el.id}"`)
  return els.length > MAX_NAMED_IN_ISSUE
    ? `${names.join('、')} 等 ${els.length} 个`
    : names.join('、')
}

/**
 * 一页的出场顺序检查。
 *
 * 判据（详见 layouts.ts 顶部「出场顺序的三条硬规矩」）：
 *
 *   A 覆盖  这一页只要有入场动画，就不该还有**文本**元素没挂 ——
 *           没挂不等于「不动」，等于「动画开始前它就已经在画布上」，
 *           见 views/Screen/ScreenElement.vue 的 needWaitAnimation。
 *           只查文本：一块从头铺到尾的背景板不挂动画是正常设计，报了全是噪音。
 *   B 标题  标题不能排在正文层文本之后。
 *   C 装饰  标题出场之前，不许有整格只有非文本元素的「纯装饰步」。
 */
export const lintSlideAnimationOrder = (slide: Slide, slideIndex?: number): LintIssue[] => {
  const issues: LintIssue[] = []
  const animations = slide.animations ?? []
  const where = slideIndex === undefined ? '' : `第 ${slideIndex + 1} 页`

  const elIds = new Set(slide.elements.map(el => el.id))
  const live = animations.filter(a => elIds.has(a.elId))
  if (!live.some(a => a.type === 'in')) return issues

  // 分步用**全部**动画（一条退场动画照样能开一个点击步），
  // 但「元素第几眼被看到」只认入场动画
  const cells = flattenTriggerSteps(groupTriggersIntoSteps(live.map(a => a.trigger)))
  const cellOf = new Map<string, number>()
  cells.forEach((cell, i) => {
    for (const idx of cell) {
      const anim = live[idx]
      if (anim.type === 'in' && !cellOf.has(anim.elId)) cellOf.set(anim.elId, i)
    }
  })

  const texts = slide.elements.filter(el => el.type === 'text')

  // A · 覆盖
  const naked = texts.filter(el => !cellOf.has(el.id))
  if (naked.length) {
    issues.push({
      level: 'warning',
      slideId: slide.id,
      elementId: naked[0].id,
      message: `${where}有 ${naked.length} 个文本没有入场动画（${nameList(naked)}），`
        + '本页其余元素却有 —— 没挂动画的元素在第一次点击之前就已经显示在画布上了，'
        + '观感是「内容早就在那儿，动画才开始播」。给它们补上动画，或者用 setAnimationPreset 整页重排',
    })
  }

  // B · 标题优先
  const titles = slide.elements.filter(el => el.type === 'text' && el.textType === 'title')
  const bodies = texts.filter(el => !TITLE_BLOCK_TEXT_TYPES.has((el as { textType?: string }).textType ?? ''))

  for (const title of titles) {
    const titleCell = cellOf.get(title.id)
    if (titleCell === undefined) continue

    const earlier = bodies.filter(el => {
      const c = cellOf.get(el.id)
      return c !== undefined && c < titleCell
    })
    if (earlier.length) {
      issues.push({
        level: 'warning',
        slideId: slide.id,
        elementId: title.id,
        message: `${where}标题 "${title.name || title.id}" 排在正文之后出场（第 ${titleCell + 1} 格，`
          + `而 ${nameList(earlier)} 更早）—— 一页要先立标题再上内容，把标题的动画挪到序列最前面`,
      })
    }

    // C · 装饰抢跑
    for (let i = 0; i < titleCell; i++) {
      const els = cells[i].map(idx => slide.elements.find(el => el.id === live[idx].elId)).filter(Boolean) as PPTElement[]
      if (!els.length || els.some(el => el.type === 'text')) continue
      issues.push({
        level: 'warning',
        slideId: slide.id,
        elementId: els[0].id,
        message: `${where}第 ${i + 1} 格只有装饰性图形（${nameList(els)}）在动，标题还没出来 —— `
          + '装饰不该抢在内容前面，把它的 trigger 改成 meantime 让它和标题同时出场',
      })
    }
  }

  return issues
}
