<template>
  <div class="model-settings">
    <div class="section-header">
      <h3>模型管理</h3>
    </div>

    <div class="toolbar">
      <Select
        v-model:value="selectedProviderId"
        :options="providerOptions"
        defaultLabel="选择服务商"
      />
      <Button size="small" @click="handleFetch" :disabled="!selectedProviderId || fetching">
        {{ fetching ? '拉取中...' : '拉取模型' }}
      </Button>
      <span class="fetch-hint" v-if="fetchHint">{{ fetchHint }}</span>
    </div>

    <div class="model-table" v-if="filteredModels.length">
      <div class="table-header">
        <span class="col-switch">启用</span>
        <span class="col-id">模型 ID</span>
        <span class="col-name">显示名</span>
        <span class="col-img">生图</span>
        <span class="col-img">读图</span>
        <span class="col-rate">每分钟上限</span>
        <span class="col-test">测试</span>
        <span class="col-del">删除</span>
      </div>
      <template v-for="m in filteredModels" :key="m.id">
      <div class="table-row">
        <span class="col-switch">
          <Switch :value="m.enabled" @update:value="v => handleToggle(m.id, v)" />
        </span>
        <span class="col-id">{{ m.modelName }}</span>
        <span class="col-name">
          <Input
            :value="m.displayName"
            @blur="(e: Event) => handleRename(m.id, (e.target as HTMLInputElement)?.value)"
          />
        </span>
        <!--
          「生图」和「读图」是**两个独立维度**，四种组合都真实存在：
            deepseek-v4-pro        生✗ 读✗
            gemini-3.7-flash       生✗ 读✓   ← 渲染后反思的视觉复核要这一档
            gemini-3.1-flash-image 生✓ 读✓
          合成一个开关的话，一个只会看图的模型会跑进「生图用哪个模型」的下拉里
        -->
        <span class="col-img">
          <Switch :value="m.supportsImages" @update:value="v => handleImages(m.id, v)" />
        </span>
        <span class="col-img">
          <Switch :value="m.supportsVision" @update:value="v => handleVision(m.id, v)" />
        </span>
        <span class="col-rate">
          <!--
            留空 = 不限。给生图模型用的：实测 gemini-3.1-flash-image 连发第 4 张
            就被上游 429，限流放在我们这边是为了让「配额用完」变成可预期的结果
            （工具回一句「改用搜图」），而不是等上游甩 429
          -->
          <Input
            class="rate-input"
            :value="m.rateLimitPerMin === null ? '' : String(m.rateLimitPerMin)"
            placeholder="不限"
            @blur="(e: Event) => handleRateLimit(m.id, (e.target as HTMLInputElement)?.value)"
          />
        </span>
        <span class="col-test">
          <Button size="small" class="test-btn" :disabled="testingId !== null" @click="handleTestModel(m)">
            {{ testingId === m.id ? '测试中...' : '测试' }}
          </Button>
        </span>
        <span class="col-del">
          <Button size="small" class="del-btn" @click="handleDelete(m)">✕</Button>
        </span>
      </div>
      <div class="row-result" v-if="testResults[m.id]">
        <span :class="testResults[m.id].ok ? 'ok' : 'fail'">
          {{ testResults[m.id].ok
            ? `✓ ${testResults[m.id].elapsed}ms · ${testResults[m.id].text}`
            : `✗ ${testResults[m.id].elapsed !== undefined ? testResults[m.id].elapsed + 'ms · ' : ''}${testResults[m.id].error}` }}
        </span>
        <span class="row-result-hint" v-if="!testResults[m.id].ok && testResults[m.id].hint">
          {{ testResults[m.id].hint }}
        </span>
      </div>
      </template>
    </div>
    <div class="empty-tip" v-else>
      {{ selectedProviderId ? '该服务商下暂无模型，点击「拉取模型」获取' : '请先选择服务商' }}
    </div>
  </div>
</template>

<script lang="ts" setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { adminApi } from '@/services'
import Button from '@/components/Button.vue'
import Input from '@/components/Input.vue'
import Select from '@/components/Select.vue'
import Switch from '@/components/Switch.vue'

interface ModelConfig {
  id: number
  providerId: number
  modelName: string
  displayName: string
  supportsImages: boolean
  supportsVision: boolean
  enabled: boolean
  rateLimitPerMin: number | null
}

interface Provider {
  id: number
  name: string
}

const providers = ref<Provider[]>([])
const models = ref<ModelConfig[]>([])
const selectedProviderId = ref<string | number>('')
const fetching = ref(false)
const fetchHint = ref('')

const providerOptions = computed(() =>
  providers.value.map(p => ({ label: p.name, value: p.id }))
)

const filteredModels = computed(() => {
  if (!selectedProviderId.value) return models.value
  return models.value.filter(m => m.providerId === Number(selectedProviderId.value))
})

const load = async () => {
  try {
    const [pRes, mRes] = await Promise.all([
      adminApi.listProviders() as any,
      adminApi.listModels() as any,
    ])
    providers.value = pRes.providers || []
    models.value = mRes.models || []
  }
  catch { /* */ }
}

const handleFetch = async () => {
  if (!selectedProviderId.value) return
  fetching.value = true
  fetchHint.value = ''
  try {
    const res = await adminApi.fetchModels(Number(selectedProviderId.value)) as any
    if (res.error) {
      fetchHint.value = `拉取失败: ${res.error}`
      return
    }
    const remote: { id: string, name: string }[] = res.models || []
    const existing = new Set(models.value.filter(m => m.providerId === Number(selectedProviderId.value)).map(m => m.modelName))
    let added = 0
    for (const rm of remote) {
      if (!existing.has(rm.id)) {
        await adminApi.createModel({
          providerId: Number(selectedProviderId.value),
          modelName: rm.id,
          displayName: rm.name || rm.id,
          enabled: false,
        })
        added++
      }
    }
    fetchHint.value = `已拉取 ${remote.length} 个模型，新增 ${added} 个`
    await load()
  }
  catch (err: any) {
    fetchHint.value = `拉取失败: ${err?.response?.data?.error || '请求失败'}`
  }
  finally {
    fetching.value = false
  }
}

const handleToggle = async (id: number, enabled: boolean) => {
  await adminApi.updateModel(id, { enabled })
  const m = models.value.find(m => m.id === id)
  if (m) m.enabled = enabled
}

const handleRename = async (id: number, name: string) => {
  if (!name) return
  await adminApi.updateModel(id, { displayName: name })
  const m = models.value.find(m => m.id === id)
  if (m) m.displayName = name
}

/** 空 / 0 / 非法输入一律当「不限」—— 打错字不该变成一个把 agent 卡死的限流值 */
const handleRateLimit = async (id: number, raw: string) => {
  const trimmed = (raw ?? '').trim()
  const parsed = trimmed === '' ? null : Number(trimmed)
  const value = parsed !== null && Number.isInteger(parsed) && parsed > 0 ? parsed : null

  await adminApi.updateModel(id, { rateLimitPerMin: value })
  const m = models.value.find(x => x.id === id)
  if (m) m.rateLimitPerMin = value
}

const handleImages = async (id: number, val: boolean) => {
  await adminApi.updateModel(id, { supportsImages: val })
  const m = models.value.find(m => m.id === id)
  if (m) m.supportsImages = val
}

/** 能读图 —— 渲染后反思的视觉复核靠它筛模型（`reflect` 角色） */
const handleVision = async (id: number, val: boolean) => {
  await adminApi.updateModel(id, { supportsVision: val })
  const m = models.value.find(x => x.id === id)
  if (m) m.supportsVision = val
}

/**
 * 删模型 —— 之前有 API 没有按钮，模型只能越积越多。
 * 后端会清掉引用（角色默认 / 用户偏好删行，生图选择置空），这里把结果说清楚。
 */
const handleDelete = async (m: ModelConfig) => {
  if (!confirm(`确定删除模型「${m.displayName}」？\n\n引用它的角色默认 / 用户偏好会被清空，生图模型选择会被置空。`)) return
  try {
    const res = await adminApi.deleteModel(m.id) as any
    await load()
    if (res?.clearedRoleDefaults || res?.clearedUserPrefs || res?.clearedAssetSources) {
      alert(
        `已删除「${m.displayName}」：清空角色默认 ${res.clearedRoleDefaults ?? 0} 条、`
        + `用户偏好 ${res.clearedUserPrefs ?? 0} 条、生图选择 ${res.clearedAssetSources ?? 0} 处`,
      )
    }
  }
  catch (err: any) {
    alert(err?.response?.data?.error || '删除失败')
  }
}

/**
 * 单个模型的真实连通测试：后端发一句两字对话并量耗时。
 * 一次只测一个（testingId 非空时别的按钮都禁用），结果落在该行下面。
 */
const testingId = ref<number | null>(null)
const testResults = reactive<Record<number, {
  ok: boolean
  elapsed?: number
  text?: string
  error?: string
  hint?: string
}>>({})

const handleTestModel = async (m: ModelConfig) => {
  if (testingId.value !== null) return
  testingId.value = m.id
  delete testResults[m.id]
  try {
    testResults[m.id] = await adminApi.testModel(m.id) as any
  }
  catch (err: any) {
    testResults[m.id] = { ok: false, error: err?.response?.data?.error || '测试请求失败' }
  }
  finally {
    testingId.value = null
  }
}

onMounted(load)
</script>

<style lang="scss" scoped>
.section-header {
  margin-bottom: 20px;
  h3 { font-size: 18px; font-weight: 600; margin: 0; }
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 16px;
}
.fetch-hint {
  font-size: 13px;
  color: #666;
}
.model-table {
  border: 1px solid $borderColor;
  border-radius: 8px;
  overflow: hidden;
}
.table-header {
  display: flex;
  align-items: center;
  padding: 10px 16px;
  background: #f8f9fa;
  font-size: 13px;
  font-weight: 500;
  color: #666;
  border-bottom: 1px solid $borderColor;
}
.table-row {
  display: flex;
  align-items: center;
  padding: 8px 16px;
  border-bottom: 1px solid #f0f0f0;
  font-size: 13px;

  &:last-child { border-bottom: none; }
}
.col-switch { width: 60px; flex-shrink: 0; }
.col-id { width: 200px; flex-shrink: 0; color: #666; font-family: monospace; }
.col-name { flex: 1; min-width: 0; padding: 0 8px; }
.col-img { width: 60px; flex-shrink: 0; }
.col-rate { width: 96px; flex-shrink: 0; }
.rate-input { width: 88px; }
.col-test { width: 76px; flex-shrink: 0; text-align: center; }
.col-del { width: 48px; flex-shrink: 0; text-align: center; }
.test-btn { color: $themeColor; }
.row-result {
  padding: 6px 16px 8px;
  font-size: 12px;
  border-bottom: 1px solid #f0f0f0;

  .ok { color: #27ae60; }
  .fail { color: #e74c3c; }
}
.row-result-hint {
  display: block;
  margin-top: 2px;
  color: #999;
  font-size: 11px;
}
.del-btn {
  color: #c0392b;
  border-color: transparent;
  background: transparent;

  &:hover {
    background: #fdf0ef;
  }
}
.empty-tip {
  color: #999;
  text-align: center;
  padding: 40px 0;
}
</style>
