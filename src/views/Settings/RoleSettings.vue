<template>
  <div class="role-settings">
    <div class="section-header">
      <h3>角色默认模型配置</h3>
      <p class="section-desc">设置每个 Agent 角色的全局默认模型。用户可在个人设置中覆盖。</p>
    </div>

    <div class="role-grid">
      <div class="role-card" v-for="role in ROLES" :key="role.key">
        <div class="role-name">{{ role.key }}</div>
        <div class="role-label">{{ role.name }}</div>
        <div class="role-desc">{{ role.desc }}</div>
        <Select
          class="role-select"
          :value="defaults[role.key] || ''"
          :options="modelOptions"
          defaultLabel="未设置"
          @update:value="v => handleSetDefault(role.key, Number(v))"
        />
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { adminApi } from '@/services'
import Select from '@/components/Select.vue'

// R-51：四个角色合成一个。这一维保留是因为第二个域（research）
// 接进来时要按域配不同的模型，见 server/src/db/schema.ts 的 AgentRole
const ROLES = [
  { key: 'deck', name: '演示文稿', desc: '生成、改造、局部调整演示文稿' },
]

interface ModelConfig {
  id: number
  displayName: string
  enabled: boolean
}

const models = ref<ModelConfig[]>([])
const defaults = reactive<Record<string, number | string>>({ deck: '' })

const modelOptions = computed(() =>
  models.value.filter(m => m.enabled).map(m => ({ label: m.displayName, value: m.id }))
)

const load = async () => {
  try {
    const [mRes, dRes] = await Promise.all([
      adminApi.listModels() as any,
      adminApi.listRoleDefaults() as any,
    ])
    models.value = mRes.models || []
    for (const d of (dRes.defaults || [])) {
      defaults[d.role] = d.modelConfigId
    }
  }
  catch { /* */ }
}

const handleSetDefault = async (role: string, modelConfigId: number) => {
  defaults[role] = modelConfigId
  try {
    await adminApi.setRoleDefault(role, modelConfigId)
  }
  catch (err: any) {
    alert(err?.response?.data?.error || '设置失败') 
  }
}

onMounted(load)
</script>

<style lang="scss" scoped>
.section-header {
  margin-bottom: 20px;
  h3 { font-size: 18px; font-weight: 600; margin: 0; }
}
.section-desc {
  font-size: 13px;
  color: #999;
  margin-top: 4px;
}
.role-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
.role-card {
  border: 1px solid $borderColor;
  border-radius: 8px;
  padding: 16px;
}
.role-name {
  font-size: 15px;
  font-weight: 600;
  text-transform: capitalize;
  margin-bottom: 2px;
}
.role-label {
  font-size: 13px;
  color: $themeColor;
  margin-bottom: 4px;
}
.role-desc {
  font-size: 12px;
  color: #999;
  margin-bottom: 12px;
}
.role-select {
  width: 100%;
}
</style>
