<template>
  <div class="agent-panel" :class="{ 'collapsed': !expanded }">
    <div class="panel-toggle" @click="expanded = !expanded">
      <span class="toggle-label">AI</span>
      <i-icon-park-outline:right v-if="!expanded" />
      <i-icon-park-outline:left v-else />
    </div>

    <template v-if="expanded">
      <div class="panel-header">
        <span class="panel-title">AI 助手</span>
        <div class="status-dot" :class="status" v-tooltip="statusMessage || status"></div>
      </div>

      <div class="panel-body" ref="bodyRef">
        <div class="tool-calls" v-if="toolCalls.length">
          <div class="tool-call" v-for="(tc, idx) in toolCalls" :key="idx">
            <span class="tool-name">{{ tc.tool }}</span>
            <span class="tool-args">{{ summarizeArgs(tc.args) }}</span>
          </div>
        </div>
        <div class="status-info" v-if="isRunning">
          <div class="thinking-indicator">
            <span class="dot"></span><span class="dot"></span><span class="dot"></span>
          </div>
          <span class="status-text">{{ statusMessage }}</span>
        </div>
        <div class="status-info done" v-else-if="status === 'done'">
          <span class="status-text">{{ statusMessage || '完成' }}</span>
        </div>
        <div class="status-info error" v-else-if="status === 'error'">
          <span class="status-text">{{ statusMessage }}</span>
        </div>
      </div>

      <div class="panel-footer">
        <div class="input-row">
          <TextArea
            v-model:value="promptText"
            placeholder="输入指令，如「生成一份关于人工智能的 PPT」"
            :rows="2"
            @keydown="handleKeydown"
          />
        </div>
        <div class="action-row">
          <div class="context-hint" v-if="selectedCount">
            已选 {{ selectedCount }} 个元素
          </div>
          <div class="action-buttons">
            <Button size="small" v-if="isRunning" @click="agentStore.cancelTask()">取消</Button>
            <Button size="small" type="primary" @click="handleSend" :disabled="!canSend">发送</Button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<script lang="ts" setup>
import { ref, computed, watch, nextTick } from 'vue'
import { storeToRefs } from 'pinia'
import { useMainStore, useAgentStore } from '@/store'
import Button from '@/components/Button.vue'
import TextArea from '@/components/TextArea.vue'

const props = defineProps<{
  deckId: number | null
}>()

const mainStore = useMainStore()
const agentStore = useAgentStore()
const { activeElementIdList } = storeToRefs(mainStore)
const { status, statusMessage, toolCalls, isRunning } = storeToRefs(agentStore)

const expanded = ref(true)
const promptText = ref('')
const bodyRef = ref<HTMLElement>()

const selectedCount = computed(() => activeElementIdList.value.length)
const canSend = computed(() => promptText.value.trim() && !isRunning.value && props.deckId)

const handleSend = () => {
  if (!canSend.value || !props.deckId) return
  const selectedIds = activeElementIdList.value.length ? [...activeElementIdList.value] : undefined
  agentStore.submitTask(props.deckId, promptText.value.trim(), selectedIds)
  promptText.value = ''
}

const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault()
    handleSend()
  }
}

const summarizeArgs = (args: Record<string, unknown>): string => {
  const keys = Object.keys(args)
  if (!keys.length) return ''
  const parts = keys.slice(0, 2).map(k => {
    const v = args[k]
    if (typeof v === 'string') return v.length > 30 ? v.slice(0, 30) + '...' : v
    return String(v)
  })
  if (keys.length > 2) parts.push('...')
  return parts.join(', ')
}

watch(toolCalls, () => {
  nextTick(() => {
    if (bodyRef.value) bodyRef.value.scrollTop = bodyRef.value.scrollHeight
  })
}, { deep: true })
</script>

<style lang="scss" scoped>
.agent-panel {
  width: 280px;
  height: 100%;
  border-left: 1px solid $borderColor;
  background: #fff;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  position: relative;

  &.collapsed {
    width: 32px;
  }
}
.panel-toggle {
  position: absolute;
  top: 8px;
  left: -1px;
  padding: 4px 6px;
  cursor: pointer;
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 2px;
  color: #999;
  z-index: 1;

  .collapsed & {
    position: static;
    width: 100%;
    justify-content: center;
    padding: 8px 0;
    writing-mode: vertical-lr;
    gap: 4px;
  }

  .toggle-label {
    font-weight: 700;
    background: linear-gradient(270deg, #d897fd, #33bcfc);
    background-clip: text;
    color: transparent;
  }
}
.panel-header {
  height: 40px;
  padding: 0 12px 0 36px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid $borderColor;
  flex-shrink: 0;
}
.panel-title {
  font-size: 13px;
  font-weight: 500;
}
.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #ccc;

  &.thinking, &.tool_call { background: #f39c12; animation: pulse-dot 1s infinite; }
  &.done { background: #27ae60; }
  &.error { background: #e74c3c; }
}
@keyframes pulse-dot {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
.panel-body {
  flex: 1;
  padding: 12px;
  @include overflow-overlay();
  font-size: 12px;
}
.tool-calls {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.tool-call {
  background: $lightGray;
  border-radius: 4px;
  padding: 6px 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.tool-name {
  font-weight: 500;
  color: $themeColor;
  font-size: 11px;
}
.tool-args {
  color: #666;
  font-size: 11px;
  word-break: break-all;
}
.status-info {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
  color: #666;
  font-size: 12px;

  &.done { color: #27ae60; }
  &.error { color: #e74c3c; }
}
.thinking-indicator {
  display: flex;
  gap: 3px;

  .dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: #f39c12;
    animation: bounce-dot 1.2s infinite;

    &:nth-child(2) { animation-delay: 0.2s; }
    &:nth-child(3) { animation-delay: 0.4s; }
  }
}
@keyframes bounce-dot {
  0%, 80%, 100% { transform: translateY(0); }
  40% { transform: translateY(-4px); }
}
.panel-footer {
  border-top: 1px solid $borderColor;
  padding: 8px 12px;
  flex-shrink: 0;
}
.input-row {
  margin-bottom: 6px;
}
.action-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.context-hint {
  font-size: 11px;
  color: #999;
  display: flex;
  align-items: center;
  gap: 4px;
}
.action-buttons {
  display: flex;
  gap: 6px;
  margin-left: auto;
}
</style>
