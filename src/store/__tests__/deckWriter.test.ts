/**
 * 单一权威写者的判据
 *
 * docs/10 可迁移清单第 1 条、docs/11 B 期首项。治的是清单里**唯一一条真实改动丢失**：
 * agent 跑着时用户在画布上拖一下，下一条 `agent.deck` 整份覆盖回去 ——
 * 而 `setSlides` 不进撤销历史，**连 Ctrl+Z 都救不回来**。
 *
 * 契约抄 BitFun 的 TurnOwnership（docs/10 第 1.7 节），而且是**对称**的：
 *
 * | 所有权 | 用户写入 | `agent.deck` |
 * |---|---|---|
 * | `agent` | 拒绝（画布锁住） | 应用 |
 * | `user`  | 应用 | **丢弃** |
 *
 * 用真 pinia store 跑真路径（`agentStore.handleMessage` → `slidesStore`），
 * 不搓假对象 —— 丢失就发生在那条路径上，换成假的只是在测我自己的假设。
 *
 * 本文件最初三条断言的是**坏行为**（先把 bug 变成看得见的），
 * 修完翻成下面这些。最后一组「负对照」保留了摘掉守卫后的形状。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useSlidesStore } from '@/store/slides'
import { useAgentStore } from '@/store/agent'
import type { PPTElement, Slide } from '@/types/slides'

const textEl = (id: string, left: number): PPTElement => ({
  id, type: 'text', left, top: 0, width: 100, height: 20, rotate: 0,
  content: `<p>${id}</p>`, defaultFontName: 'Microsoft YaHei', defaultColor: '#111111',
} as unknown as PPTElement)

/** agent 那一侧的 deck：它不知道用户刚动过什么 */
const agentSlides = (mark = 'agent'): Slide[] => [
  { id: 's1', elements: [textEl('el1', 0), textEl('el2', 200), textEl(mark, 400)] },
]

/** 起一份「agent 正在跑」的现场 */
const running = () => {
  const slides = useSlidesStore()
  const agent = useAgentStore()
  slides.setSlides(agentSlides())
  agent.submitTask(1, '做一份季度回顾')
  return { slides, agent }
}

const deckMsg = (mark = 'agent') => ({
  type: 'agent.deck' as const,
  slidesJson: JSON.stringify(agentSlides(mark)),
  version: 5,
})

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('agent 持有所有权时，画布锁住', () => {
  it('提交任务即锁住', () => {
    const { slides } = running()
    expect(slides.deckOwner).toBe('agent')
    expect(slides.isDeckLocked).toBe(true)
  })

  it('拖动元素被拒 —— 这就是原来那次丢失', () => {
    const { slides } = running()
    slides.updateElement({ id: 'el1', props: { left: 999 } })
    expect(slides.slides[0].elements[0].left).toBe(0) // 根本没改进去
  })

  it('增删元素、增删页、改主题全部被拒', () => {
    const { slides } = running()
    const before = JSON.stringify(slides.slides)

    slides.addElement(textEl('用户加的', 500))
    slides.deleteElement('el1')
    slides.addSlide({ id: 's2', elements: [] })
    slides.deleteSlide('s1')
    slides.updateSlide({ background: { type: 'solid', color: '#000' } } as Partial<Slide>)
    slides.setTheme({ backgroundColor: '#000' })

    expect(JSON.stringify(slides.slides)).toBe(before)
    expect(slides.theme.backgroundColor).not.toBe('#000')
  })

  it('agent 自己的写入照常生效', () => {
    const { slides, agent } = running()
    agent.handleMessage(deckMsg('agent 加的'))
    expect(slides.slides[0].elements.some(e => e.id === 'agent 加的')).toBe(true)
  })
})

describe('用户接管之后，所有权反过来', () => {
  it('接管即解锁，画布可写', () => {
    const { slides, agent } = running()
    agent.takeOver()

    expect(slides.deckOwner).toBe('user')
    slides.updateElement({ id: 'el1', props: { left: 999 } })
    expect(slides.slides[0].elements[0].left).toBe(999)
  })

  it('接管后迟到的 agent.deck 被丢弃 —— 不会把用户刚拿回的画布再抢走', () => {
    const { slides, agent } = running()
    agent.takeOver()
    slides.updateElement({ id: 'el1', props: { left: 999 } })

    // 后端任务还在收尾，又推了一条
    agent.handleMessage(deckMsg('迟到的'))

    expect(slides.slides[0].elements[0].left).toBe(999) // 用户的改动还在
    expect(slides.slides[0].elements.some(e => e.id === '迟到的')).toBe(false)
  })

  it('接管不依赖后端确认 —— socket 断了也能解锁', () => {
    // send() 在 socket 未连接时是空转（services/websocket.ts:140）。
    // 若解锁要等后端回消息，断线时画布就永久锁死了 —— 一把鼠标解不开的锁
    const { slides, agent } = running()
    agent.takeOver()
    expect(slides.isDeckLocked).toBe(false)
  })
})

describe('所有权由事件驱动，不从画布推导', () => {
  it('任务正常收尾后自动解锁', () => {
    const { slides, agent } = running()
    agent.handleMessage({ type: 'agent.status', status: 'done', message: '任务完成' })
    expect(slides.deckOwner).toBe('user')
  })

  it('任务出错后同样解锁', () => {
    const { slides, agent } = running()
    agent.handleMessage({ type: 'agent.status', status: 'error', message: '模型调用失败' })
    expect(slides.deckOwner).toBe('user')
  })

  it('中间态状态不解锁', () => {
    const { slides, agent } = running()
    agent.handleMessage({ type: 'agent.status', status: 'thinking', message: '正在思考' })
    agent.handleMessage({ type: 'agent.status', status: 'tool_call', message: '' })
    expect(slides.deckOwner).toBe('agent')
  })

  it('reset 兜底解锁 —— 切文稿 / 登出时不能留下一把没人解得开的锁', () => {
    const { slides, agent } = running()
    agent.reset()
    expect(slides.deckOwner).toBe('user')
  })
})

describe('绕过细粒度 action 的两条路也挡住了', () => {
  it('撤销在锁定期间不生效', async () => {
    running()
    const { useSnapshotStore } = await import('@/store/snapshot')
    const snapshot = useSnapshotStore()
    snapshot.snapshotCursor = 3
    snapshot.snapshotLength = 5

    await snapshot.unDo()
    // 没走到读 IndexedDB 那一步就返回了；cursor 不动即证明被挡下
    expect(snapshot.snapshotCursor).toBe(3)
  })

  it('重做同样不生效', async () => {
    const { useSnapshotStore } = await import('@/store/snapshot')
    running()
    const snapshot = useSnapshotStore()
    snapshot.snapshotCursor = 1
    snapshot.snapshotLength = 5

    await snapshot.reDo()
    expect(snapshot.snapshotCursor).toBe(1)
  })

  it('setSlides 刻意不锁 —— 登出清场要能清得掉', () => {
    const { slides } = running()
    // App.vue 的登出 watcher 调的就是这一句。锁住它的话，
    // 换账号登录会看到上一个人的文稿，比它防住的问题更糟
    slides.setSlides([])
    expect(slides.slides).toEqual([])
  })
})

describe('负对照：摘掉守卫就是原来那次丢失', () => {
  it('所有权留在 user 时，用户改动会被 agent.deck 整份盖掉', () => {
    const slides = useSlidesStore()
    const agent = useAgentStore()
    slides.setSlides(agentSlides())
    agent.currentDeckId = 1
    // 不调 submitTask —— 所有权留在 user，等于守卫没生效的那一版

    slides.updateElement({ id: 'el1', props: { left: 999 } })
    expect(slides.slides[0].elements[0].left).toBe(999)

    // 但这条也会被对称守卫挡掉（owner 是 user），所以得手动走旧路径才能重现丢失
    slides.setSlides(agentSlides())

    // ← 这就是修之前每一次 agent.deck 的效果：改动没了，且不进撤销历史
    expect(slides.slides[0].elements[0].left).toBe(0)
  })
})
