import type { Directive, DirectiveBinding } from 'vue'
import tippy, { type Instance, type Placement } from 'tippy.js'

import './tooltip.scss'

const TOOLTIP_INSTANCE = 'TOOLTIP_INSTANCE'

interface CustomHTMLElement extends HTMLElement {
  [TOOLTIP_INSTANCE]?: Instance
}

type Delay = number | [number | null, number | null]

interface BindingValue {
  content: string
  placement?: Placement
  delay?: Delay
}

/**
 * 取出要显示的文案。
 *
 * **null / undefined 必须收住。** `v-tooltip="cond ? a : undefined"` 是很自然的
 * 写法，而这里原本直接读 `binding.value.content` —— 一个 undefined 就抛
 * TypeError，并且是在 `mounted` 钩子里抛，**整个宿主组件跟着挂掉**。
 * R-68 实测撞到过：面板上的一个条件 tooltip 让整块 AgentPanel 起不来。
 *
 * 空串表示「不显示」，由调用方决定，这里只负责不炸。
 */
const contentOf = (value: BindingValue | string | null | undefined): string => {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  return value.content ?? ''
}

const TooltipDirective: Directive = {
  mounted(el: CustomHTMLElement, binding: DirectiveBinding<BindingValue | string>) {
    const content = contentOf(binding.value)
    let placement: Placement = 'top'
    let delay: Delay = [300, 0]

    if (binding.value && typeof binding.value !== 'string') {
      if (binding.value.placement !== undefined) placement = binding.value.placement
      if (binding.value.delay !== undefined) delay = binding.value.delay
    }

    el[TOOLTIP_INSTANCE] = tippy(el, {
      content,
      theme: 'tooltip',
      duration: 100,
      animation: 'scale',
      allowHTML: true,
      placement,
      delay,
    })
  },

  updated(el: CustomHTMLElement, binding: DirectiveBinding<BindingValue | string>) {
    if (el[TOOLTIP_INSTANCE]) el[TOOLTIP_INSTANCE].setContent(contentOf(binding.value))
  },
  
  unmounted(el: CustomHTMLElement) {
    if (el[TOOLTIP_INSTANCE]) el[TOOLTIP_INSTANCE].destroy()
  },
}

export default TooltipDirective