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
        <div class="log-entries" v-if="log.length">
          <template v-for="(entry, idx) in log" :key="idx">
            <!-- 用户输入 -->
            <div class="log-entry user-msg" v-if="entry.type === 'text' && entry.role === 'user'">
              <div class="entry-label">你</div>
              <div class="entry-content">{{ entry.content }}</div>
            </div>

            <!-- 角色文本输出 -->
            <div class="log-entry role-msg" v-else-if="entry.type === 'text' && entry.role !== 'user'">
              <div class="entry-label">{{ roleLabel(entry.role) }}</div>
              <div class="entry-content" v-html="formatContent(entry.content)"></div>
            </div>

            <!-- 工具调用 -->
            <div class="log-entry tool-entry" v-else-if="entry.type === 'tool'">
              <div class="tool-header" @click="toggleExpand(idx)">
                <span class="tool-icon">⚙</span>
                <span class="tool-name">{{ entry.tool }}</span>
                <span class="tool-args-preview">{{ summarizeArgs(entry.args) }}</span>
                <span class="expand-arrow" :class="{ open: expandedEntries.has(idx) }">▸</span>
              </div>
              <div class="tool-detail" v-if="expandedEntries.has(idx)">
                <div class="detail-section" v-if="Object.keys(entry.args).length">
                  <div class="detail-label">参数</div>
                  <pre class="detail-json">{{ JSON.stringify(entry.args, null, 2) }}</pre>
                </div>
                <div class="detail-section" v-if="entry.result">
                  <div class="detail-label">结果</div>
                  <pre class="detail-json">{{ entry.result }}</pre>
                </div>
              </div>
            </div>

            <!-- 状态变化 -->
            <div class="log-entry status-entry" v-else-if="entry.type === 'status' && entry.message">
              <span class="status-icon" :class="entry.status">●</span>
              <span class="status-msg">{{ entry.message }}</span>
            </div>
          </template>
        </div>

        <div class="empty-hint" v-else>
          输入指令开始使用 AI 助手
        </div>

        <div class="thinking-bar" v-if="isRunning">
          <span class="dot"></span><span class="dot"></span><span class="dot"></span>
          <span class="thinking-text">{{ statusMessage }}</span>
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
import { ref, reactive, computed, watch, nextTick } from 'vue'
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
const { status, statusMessage, log, isRunning } = storeToRefs(agentStore)

const expanded = ref(true)
const promptText = ref('')
const bodyRef = ref<HTMLElement>()
const expandedEntries = reactive(new Set<number>())

const selectedCount = computed(() => activeElementIdList.value.length)
const canSend = computed(() => promptText.value.trim() && !isRunning.value && props.deckId)

const handleSend = () => {
  if (!canSend.value || !props.deckId) return
  expandedEntries.clear()
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

const toggleExpand = (idx: number) => {
  if (expandedEntries.has(idx)) expandedEntries.delete(idx)
  else expandedEntries.add(idx)
}

const roleLabel = (role: string): string => {
  const labels: Record<string, string> = {
    planner: 'Planner',
    generator: 'Generator',
    reviewer: 'Reviewer',
    editor: 'Editor',
  }
  return labels[role] || role
}

const formatContent = (content: string): string => {
  return content
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>')
}

const summarizeArgs = (args: Record<string, unknown>): string => {
  const keys = Object.keys(args)
  if (!keys.length) return ''
  const parts = keys.slice(0, 2).map(k => {
    const v = args[k]
    if (typeof v === 'string') return v.length > 20 ? v.slice(0, 20) + '...' : v
    if (typeof v === 'object') return '{...}'
    return String(v)
  })
  if (keys.length > 2) parts.push('...')
  return parts.join(', ')
}

watch(log, () => {
  nextTick(() => {
    if (bodyRef.value) bodyRef.value.scrollTop = bodyRef.value.scrollHeight
  })
}, { deep: true })
</script>

<style lang="scss" scoped>
.agent-panel {
  width: 320px;
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
.empty-hint {
  color: #bbb;
  text-align: center;
  padding: 40px 0;
  font-size: 13px;
}
.log-entries {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.log-entry {
  border-radius: 6px;
}

// 用户消息
.user-msg {
  background: #e8f4fd;
  padding: 8px 10px;

  .entry-label {
    font-size: 10px;
    font-weight: 600;
    color: #2980b9;
    margin-bottom: 3px;
  }
  .entry-content {
    font-size: 12px;
    color: #333;
    line-height: 1.5;
  }
}

// 角色输出
.role-msg {
  background: $lightGray;
  padding: 8px 10px;

  .entry-label {
    font-size: 10px;
    font-weight: 600;
    color: $themeColor;
    margin-bottom: 3px;
  }
  .entry-content {
    font-size: 12px;
    color: #333;
    line-height: 1.5;
    word-break: break-word;
  }
}

// 工具调用
.tool-entry {
  background: #f0f0f0;
  border: 1px solid #e0e0e0;
  overflow: hidden;
}
.tool-header {
  padding: 6px 8px;
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  font-size: 11px;

  &:hover { background: #e8e8e8; }
}
.tool-icon { font-size: 12px; }
.tool-name {
  font-weight: 600;
  color: #555;
  flex-shrink: 0;
}
.tool-args-preview {
  color: #888;
  flex: 1;
  @include ellipsis-oneline();
}
.expand-arrow {
  font-size: 10px;
  color: #999;
  transition: transform .15s;
  flex-shrink: 0;

  &.open { transform: rotate(90deg); }
}
.tool-detail {
  border-top: 1px solid #e0e0e0;
  padding: 6px 8px;
}
.detail-section {
  margin-bottom: 6px;
  &:last-child { margin-bottom: 0; }
}
.detail-label {
  font-size: 10px;
  font-weight: 600;
  color: #888;
  margin-bottom: 2px;
}
.detail-json {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: #555;
  background: #fff;
  padding: 6px;
  border-radius: 3px;
  margin: 0;
  max-height: 200px;
  @include overflow-overlay();
  white-space: pre-wrap;
  word-break: break-all;
}

// 状态
.status-entry {
  padding: 4px 8px;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: #888;
}
.status-icon {
  font-size: 8px;
  &.thinking, &.tool_call { color: #f39c12; }
  &.done { color: #27ae60; }
  &.error { color: #e74c3c; }
}

// 底部思考指示
.thinking-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 0;
  color: #f39c12;
  font-size: 12px;

  .dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: #f39c12;
    animation: bounce-dot 1.2s infinite;

    &:nth-child(2) { animation-delay: 0.2s; }
    &:nth-child(3) { animation-delay: 0.4s; }
  }
  .thinking-text {
    margin-left: 4px;
    color: #999;
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
}
.action-buttons {
  display: flex;
  gap: 6px;
  margin-left: auto;
}
</style>
