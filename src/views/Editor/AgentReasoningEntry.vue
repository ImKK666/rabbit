<template>
  <div class="log-entry reasoning-entry">
    <div class="reasoning-header" @click="emit('toggle')">
      <span class="reasoning-icon" :class="{ live: !entry.done }">✦</span>
      <span class="reasoning-title">{{ entry.done ? '思考完成' : '正在思考…' }}</span>
      <span class="reasoning-chars">{{ entry.content.length }} 字</span>
      <span class="expand-arrow" :class="{ open }">▸</span>
    </div>
    <div class="reasoning-body" ref="bodyRef" v-if="open">{{ entry.content }}</div>
  </div>
</template>

<script lang="ts" setup>
/**
 * 单个思考块。
 *
 * ## 为什么从 AgentPanel 里抽出来
 *
 * 思考块自己是一个滚动容器（`max-height` + `overflow-y: auto`），
 * 流式输出要跟着往下滚，就得拿到**它自己那个 DOM 元素**。
 * 留在父组件的 `v-for` 里只能靠函数式 ref 维护一张 `Map<下标, 元素>` ——
 * 而 `v-if` 会让元素反复挂载卸载，那张表的清理是必然会漏的那种活。
 *
 * 抽出来之后每块自管自，没有任何簿记。
 *
 * **顺带解决一个性能问题**：父组件那个 `watch(log, { deep: true })`
 * 会在每一条 reasoning 增量（几个字符）上做一次全日志深度遍历。
 * 这里只 watch 自己的 `content` 字符串。
 *
 * ## 开合状态仍归父组件
 *
 * `expandedEntries` 是按日志下标存的，切换会话 / 清空时要整体清掉
 * （父组件里有 7 处 `clear()`）。所以这里只收 `open` 和抛 `toggle`，
 * 不自己持有状态 —— 否则那 7 处清理会全部失效。
 */
import { ref } from 'vue'
import { useStickToBottom } from '@/hooks/useStickToBottom'

const props = defineProps<{
  entry: { role: string, content: string, done: boolean }
  open: boolean
}>()

const emit = defineEmits<{ (e: 'toggle'): void }>()

const bodyRef = ref<HTMLElement>()

// 只跟自己的正文。用户在这块里往上滚之后就不再拽他 —— 判断在 composable 里
useStickToBottom(bodyRef, () => props.entry.content)
</script>

<style lang="scss" scoped>
// 这些样式原来在 AgentPanel.vue 里。搬过来是因为 scoped CSS 只给
// **子组件的根元素**打父作用域标记，内部节点（header / body）拿不到 ——
// 留在父组件里会静默失效
.reasoning-entry {
  background: #faf8ff;
  border: 1px solid #e9e2f5;
  overflow: hidden;
}
.reasoning-header {
  padding: 6px 8px;
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  font-size: 11px;

  &:hover { background: #f3eeff; }
}
.reasoning-icon {
  font-size: 11px;
  color: #8b6fd4;

  // 只在真的还在想的时候闪，想完了停住 —— 一个不停跳的图标比转圈更烦
  &.live { animation: rb-reasoning-pulse 1.2s ease-in-out infinite; }
}
@keyframes rb-reasoning-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: .35; }
}
.reasoning-title {
  font-weight: 600;
  color: #6b5b95;
  flex-shrink: 0;
}
.reasoning-chars {
  color: #a99cc4;
  flex: 1;
}
.reasoning-body {
  border-top: 1px solid #e9e2f5;
  padding: 6px 8px;
  max-height: 220px;
  overflow-y: auto;
  font-size: 11px;
  line-height: 1.6;
  color: #6d6a75;
  white-space: pre-wrap;
  word-break: break-word;

  // 这块滚到底之后，滚轮不要接着把整个面板带走 ——
  // 「我在小块里看东西，结果外面跟着跑」是另一半烦人的来源
  overscroll-behavior: contain;
}

// 和 AgentPanel 里那份是同一条规则。工具调用也在用它，
// 而 scoped 样式跨不过组件边界，所以这里留一份
.expand-arrow {
  font-size: 10px;
  color: #999;
  transition: transform .15s;
  flex-shrink: 0;

  &.open { transform: rotate(90deg); }
}
</style>
