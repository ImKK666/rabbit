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

const app = createApp(App)
app.use(Directive)
app.use(createPinia())
app.mount('#app')
