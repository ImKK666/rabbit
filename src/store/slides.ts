import { defineStore } from 'pinia'
import { omit } from 'lodash'
import type { Slide, SlideTheme, PPTElement, PPTAnimation, SlideTemplate } from '@/types/slides'

interface RemovePropData {
  id: string
  propName: string | string[]
}

interface UpdateElementData {
  id: string | string[]
  props: Partial<PPTElement>
  slideId?: string
}

interface FormatedAnimation {
  animations: PPTAnimation[]
  autoNext: boolean
}

/**
 * R-05 · 清理孤儿动画（就地修改）
 *
 * animations 是 Slide 上的独立数组，靠 elId 引用元素。删除元素时若不同步清理，
 * 条目会永久留在数组里 —— 原实现只在 getters currentSlideAnimations 里读时过滤，
 * 数组本身一直是脏的。人手操作影响有限，agent 反复增删会迅速累积。
 *
 * 在所有会替换 elements 的写入路径上调用，保证引用完整性。
 * 注意：UI 的删除路径走 updateSlide 而不是 deleteElement（见 hooks/useDeleteElement.ts:28），
 * 所以两处都要调，只修一处会漏掉真正的路径。
 */
const pruneOrphanAnimations = (slide: Slide) => {
  if (!slide.animations?.length) return
  const elementIds = new Set(slide.elements.map(el => el.id))
  const animations = slide.animations.filter(item => elementIds.has(item.elId))
  if (animations.length !== slide.animations.length) slide.animations = animations
}

/**
 * 谁此刻有权写这份演示文稿。
 *
 * 抄 BitFun 的 TurnOwnership（docs/10 第 1.7 节）：
 * **同一份文档在同一时刻只有一个权威写者，所有权在终止事件上恰好转移一次。**
 *
 * 治的是 docs/10 可迁移清单第 1 条 —— 清单里唯一一条**真实改动丢失**：
 * agent 跑着时用户在画布上拖一下，下一条 `agent.deck` 整份覆盖回去，
 * 而且 `setSlides` 不进撤销历史，**连 Ctrl+Z 都救不回来**。
 *
 * 规则是**对称**的，这一点很重要：
 * - `agent` 持有时，用户的写入被拒（画布锁住，横幅提示，点「接管」解锁）
 * - `user` 持有时，迟到的 `agent.deck` 被丢弃（用户已经接管了，agent 说了不算）
 *
 * 后半条不是多余的：点「接管」之后**本地立刻转移所有权**，不等后端确认 ——
 * 否则 WebSocket 一断，取消发不出去，画布就永久锁死了。
 * 代价是后端任务还在收尾、还会推几条 `agent.deck`，而它们正好被这半条规则挡住。
 */
export type DeckOwner = 'user' | 'agent'

export interface SlidesState {
  title: string
  theme: SlideTheme
  slides: Slide[]
  slideIndex: number
  version: number
  viewportSize: number
  viewportRatio: number
  templates: SlideTemplate[]
  deckOwner: DeckOwner
}

export const useSlidesStore = defineStore('slides', {
  state: (): SlidesState => ({
    title: '未命名演示文稿', // 幻灯片标题
    theme: {
      themeColors: ['#5b9bd5', '#ed7d31', '#a5a5a5', '#ffc000', '#4472c4', '#70ad47'],
      fontColor: '#333',
      fontName: '',
      backgroundColor: '#fff',
      shadow: {
        h: 3,
        v: 3,
        blur: 2,
        color: '#808080',
      },
      outline: {
        width: 2,
        color: '#525252',
        style: 'solid',
      },
    }, // 主题样式
    slides: [], // 幻灯片页面数据
    slideIndex: 0, // 当前页面索引
    version: 0, // R-06: 每次变更自增，用于与服务端对齐、agent 整份替换时防覆盖
    viewportSize: 1000, // 可视区域宽度基数（逻辑画布宽，非像素非 EMU）
    viewportRatio: 0.5625, // 可视区域比例，默认16:9 → 逻辑画布 1000 × 562.5
    templates: [
      { name: '山河映红', id: 'template_1', cover: './imgs/template_1.webp', origin: '官方制作' },
      { name: '都市蓝调', id: 'template_2', cover: './imgs/template_2.webp', origin: '官方制作' },
      { name: '智感几何', id: 'template_3', cover: './imgs/template_3.webp', origin: '官方制作' },
      { name: '柔光莫兰迪', id: 'template_4', cover: './imgs/template_4.webp', origin: '官方制作' },
      { name: '简约绿意', id: 'template_5', cover: './imgs/template_5.webp', origin: '社区贡献+官方深度完善优化' },
      { name: '暖色复古', id: 'template_6', cover: './imgs/template_6.webp', origin: '社区贡献+官方深度完善优化' },
      { name: '深邃沉稳', id: 'template_7', cover: './imgs/template_7.webp', origin: '社区贡献+官方深度完善优化' },
      { name: '浅蓝小清新', id: 'template_8', cover: './imgs/template_8.webp', origin: '社区贡献+官方深度完善优化' },
    ], // 模板
    deckOwner: 'user', // 谁此刻有权写这份文稿，见 DeckOwner
  }),

  getters: {
    /** 画布是否锁住（agent 持有所有权）。UI 据此置灰并显示横幅 */
    isDeckLocked(state) {
      return state.deckOwner === 'agent'
    },
    currentSlide(state) {
      return state.slides[state.slideIndex]
    },
  
    currentSlideAnimations(state) {
      const currentSlide = state.slides[state.slideIndex]
      if (!currentSlide?.animations) return []

      const els = currentSlide.elements
      const elIds = els.map(el => el.id)
      return currentSlide.animations.filter(animation => elIds.includes(animation.elId))
    },

    // 格式化的当前页动画
    // 将触发条件为“与上一动画同时”的项目向上合并到序列中的同一位置
    // 为触发条件为“上一动画之后”项目的上一项添加自动向下执行标记
    formatedAnimations(state) {
      const currentSlide = state.slides[state.slideIndex]
      if (!currentSlide?.animations) return []

      const els = currentSlide.elements
      const elIds = els.map(el => el.id)
      const animations = currentSlide.animations.filter(animation => elIds.includes(animation.elId))

      const formatedAnimations: FormatedAnimation[] = []
      for (const animation of animations) {
        if (animation.trigger === 'click' || !formatedAnimations.length) {
          formatedAnimations.push({ animations: [animation], autoNext: false })
        }
        else if (animation.trigger === 'meantime') {
          const last = formatedAnimations[formatedAnimations.length - 1]
          last.animations = last.animations.filter(item => item.elId !== animation.elId)
          last.animations.push(animation)
          formatedAnimations[formatedAnimations.length - 1] = last
        }
        else if (animation.trigger === 'auto') {
          const last = formatedAnimations[formatedAnimations.length - 1]
          last.autoNext = true
          formatedAnimations[formatedAnimations.length - 1] = last
          formatedAnimations.push({ animations: [animation], autoNext: false })
        }
      }
      return formatedAnimations
    },
  },

  actions: {
    /**
     * 转移所有权。**由任务的起止事件驱动，不从画布状态推导** ——
     * BitFun 那句「问『这个 Turn 在屏幕上看起来完成了吗』正是这个契约要消除的检查」。
     */
    setDeckOwner(owner: DeckOwner) {
      this.deckOwner = owner
    },

    /**
     * agent 的权威写入。返回是否真的写进去了。
     *
     * 所有权不在 agent 手上就**丢弃**：用户点过「接管」了，
     * 此刻还在路上的 `agent.deck` 属于上一任写者，写进去就是把用户刚拿回的画布又抢走。
     */
    applyAgentDeck(slides: Slide[]) {
      if (this.deckOwner !== 'agent') return false
      this.slides = slides
      this.version++
      return true
    },

    setTitle(title: string) {
      if (!title) this.title = '未命名演示文稿'
      else this.title = title
      this.version++
    },

    setTheme(themeProps: Partial<SlideTheme>) {
      if (this.deckOwner === 'agent') return
      this.theme = { ...this.theme, ...themeProps }
      this.version++
    },

    setViewportSize(size: number) {
      this.viewportSize = size
      this.version++
    },

    setViewportRatio(viewportRatio: number) {
      this.viewportRatio = viewportRatio
      this.version++
    },

    /**
     * 整份替换。**刻意不受所有权约束** —— 这是「装载 / 清空整个文档」的路径：
     * 打开演示文稿、登出清场、导入、撤销重做都走它。
     * 加了锁之后登出时清不掉画布，比它防住的问题更糟。
     *
     * 用户真正会在画布上做的那些操作走下面那些细粒度 action，锁在那儿。
     * 撤销 / 重做单独在 snapshot store 里挡（它们绕过细粒度 action 直接整份替换）。
     */
    setSlides(slides: Slide[], themeProps?: Partial<SlideTheme>) {
      this.slides = slides
      // 不再转调 setTheme：那个已经带所有权守卫，
      // 会让锁定期间的整份替换只写一半（slides 写了、theme 和 version 没跟上）
      if (themeProps) this.theme = { ...this.theme, ...themeProps }
      this.version++
    },
  
    setTemplates(templates: SlideTemplate[]) {
      this.templates = templates
    },
  
    addSlide(slide: Slide | Slide[]) {
      if (this.deckOwner === 'agent') return
      const slides = Array.isArray(slide) ? slide : [slide]
      for (const slide of slides) {
        if (slide.sectionTag) delete slide.sectionTag
      }

      const addIndex = this.slideIndex + 1
      this.slides.splice(addIndex, 0, ...slides)
      this.slideIndex = addIndex
      this.version++
    },

    updateSlide(props: Partial<Slide>, slideId?: string) {
      if (this.deckOwner === 'agent') return
      const slideIndex = slideId ? this.slides.findIndex(item => item.id === slideId) : this.slideIndex
      this.slides[slideIndex] = { ...this.slides[slideIndex], ...props }
      // R-05: elements 被整体替换时清理孤儿动画。UI 的元素删除走这条路
      // （hooks/useDeleteElement.ts 调的是 updateSlide({ elements }) 而非 deleteElement）
      if ('elements' in props) pruneOrphanAnimations(this.slides[slideIndex])
      this.version++
    },

    removeSlideProps(data: RemovePropData) {
      if (this.deckOwner === 'agent') return
      const { id, propName } = data

      const slides = this.slides.map(slide => {
        return slide.id === id ? omit(slide, propName) : slide
      }) as Slide[]
      this.slides = slides
      this.version++
    },

    deleteSlide(slideId: string | string[]) {
      if (this.deckOwner === 'agent') return
      const slidesId = Array.isArray(slideId) ? slideId : [slideId]
      const slides: Slide[] = JSON.parse(JSON.stringify(this.slides))
  
      const deleteSlidesIndex = []
      for (const deletedId of slidesId) {
        const index = slides.findIndex(item => item.id === deletedId)
        deleteSlidesIndex.push(index)

        const deletedSlideSection = slides[index].sectionTag
        if (deletedSlideSection) {
          const handleSlideNext = slides[index + 1]
          if (handleSlideNext && !handleSlideNext.sectionTag) {
            delete slides[index].sectionTag
            slides[index + 1].sectionTag = deletedSlideSection
          }
        }

        slides.splice(index, 1)
      }
      let newIndex = Math.min(...deleteSlidesIndex)
  
      const maxIndex = slides.length - 1
      if (newIndex > maxIndex) newIndex = maxIndex
  
      this.slideIndex = newIndex
      this.slides = slides
      this.version++
    },

    updateSlideIndex(index: number) {
      this.slideIndex = index
    },

    addElement(element: PPTElement | PPTElement[]) {
      if (this.deckOwner === 'agent') return
      const elements = Array.isArray(element) ? element : [element]
      const currentSlideEls = this.slides[this.slideIndex].elements
      const newEls = [...currentSlideEls, ...elements]
      this.slides[this.slideIndex].elements = newEls
      this.version++
    },

    deleteElement(elementId: string | string[]) {
      if (this.deckOwner === 'agent') return
      const elementIdList = Array.isArray(elementId) ? elementId : [elementId]
      const slide = this.slides[this.slideIndex]
      slide.elements = slide.elements.filter(item => !elementIdList.includes(item.id))
      pruneOrphanAnimations(slide) // R-05
      this.version++
    },

    updateElement(data: UpdateElementData) {
      if (this.deckOwner === 'agent') return
      const { id, props, slideId } = data
      const elIdList = typeof id === 'string' ? [id] : id

      const slideIndex = slideId ? this.slides.findIndex(item => item.id === slideId) : this.slideIndex
      const slide = this.slides[slideIndex]
      const elements = slide.elements.map(el => {
        return elIdList.includes(el.id) ? { ...el, ...props } : el
      })
      this.slides[slideIndex].elements = (elements as PPTElement[])
      this.version++
    },

    removeElementProps(data: RemovePropData) {
      if (this.deckOwner === 'agent') return
      const { id, propName } = data
      const propsNames = typeof propName === 'string' ? [propName] : propName

      const slideIndex = this.slideIndex
      const slide = this.slides[slideIndex]
      const elements = slide.elements.map(el => {
        return el.id === id ? omit(el, propsNames) : el
      })
      this.slides[slideIndex].elements = (elements as PPTElement[])
      this.version++
    },
  },
})