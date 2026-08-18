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
      </div>
      <div class="table-row" v-for="m in filteredModels" :key="m.id">
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
        <span class="col-img">
          <Switch :value="m.supportsImages" @update:value="v => handleImages(m.id, v)" />
        </span>
      </div>
    </div>
    <div class="empty-tip" v-else>
      {{ selectedProviderId ? '该服务商下暂无模型，点击「拉取模型」获取' : '请先选择服务商' }}
    </div>
  </div>
</template>

<script lang="ts" setup>
import { ref, computed, onMounted } from 'vue'
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
  enabled: boolean
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
  finally { fetching.value = false }
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

const handleImages = async (id: number, val: boolean) => {
  await adminApi.updateModel(id, { supportsImages: val })
  const m = models.value.find(m => m.id === id)
  if (m) m.supportsImages = val
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
.empty-tip {
  color: #999;
  text-align: center;
  padding: 40px 0;
}
</style>
