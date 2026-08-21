import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'

import 'prosemirror-view/style/prosemirror.css'
import 'animate.css'
import '@/assets/styles/animation-extra.scss' // R-07: 补齐 animate.css 缺失的 12 个效果，须在 animate.css 之后
import '@/assets/styles/asset-skeleton.scss' // R-11: pending 资产骨架屏（全局类 + keyframes，背景内联样式也引用它）
import '@/assets/styles/prosemirror.scss'
import '@/assets/styles/global.scss'
import '@/assets/styles/font.scss'

import Directive from '@/directive'
import { recordCrash, readCrashLog, clearCrashLog, CRASH_LOG_KEY } from '@/utils/crashLog'

const app = createApp(App)

/**
 * 崩溃捕获必须在 `mount` **之前**装 —— 挂载期间就可能出错，
 * 而那正是最容易变成白屏的一段。
 *
 * 三条路都要接：`errorHandler` 只管 Vue 组件内部（渲染 / 生命周期 / watcher），
 * 组件外的同步异常走 `window.onerror`，没 catch 的 Promise 走 `unhandledrejection`。
 * 少接一条就会留下一类「白屏但记录里什么都没有」的情况。
 */
app.config.errorHandler = (err, instance, info) => {
  recordCrash(err, 'vue', {
    component: instance?.$options?.name ?? instance?.$?.type?.__name ?? undefined,
    hook: info,
  })
}
window.addEventListener('error', e => recordCrash(e.error ?? e.message, 'window'))
window.addEventListener('unhandledrejection', e => recordCrash(e.reason, 'promise'))

// 上一次跑崩过就在控制台喊一声 —— 记录活过了刷新，但没人知道去哪儿看等于没有
const previous = readCrashLog()
if (previous.length > 0) {
  console.warn(
    `[crash] 上次运行记录到 ${previous.length} 条未捕获错误（第一条才是根因）：`,
    previous,
    `\n清掉：localStorage.removeItem('${CRASH_LOG_KEY}')`,
  )
}
;(window as unknown as Record<string, unknown>).__crashLog = { read: readCrashLog, clear: clearCrashLog }

app.use(Directive)
app.use(createPinia())
app.mount('#app')
