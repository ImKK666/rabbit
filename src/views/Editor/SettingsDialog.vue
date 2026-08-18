<template>
  <div class="settings-dialog">
    <Tabs v-model:value="activeTab" :tabs="tabItems" />

    <div class="settings-body">
      <!-- 用户设置 -->
      <template v-if="activeTab === 'user'">
        <div class="section">
          <div class="section-title">模型偏好</div>
          <div class="section-desc">为每个 Agent 角色选择默认模型，控制成本</div>
          <div class="pref-list">
            <div class="pref-item" v-for="pref in preferences" :key="pref.role">
              <span class="pref-role">{{ ROLE_LABELS[pref.role] }}</span>
              <Select
                class="pref-select"
                :value="String(pref.modelConfigId || '')"
                :options="modelOptions"
                @update:value="v => setPreference(pref.role, Number(v))"
              />
              <span class="pref-source" v-if="pref.source === 'default'">(默认)</span>
            </div>
          </div>
        </div>
        <Divider />
        <div class="section">
          <div class="section-title">修改密码</div>
          <div class="form-row">
            <Input v-model:value="oldPassword" type="password" placeholder="原密码" />
          </div>
          <div class="form-row">
            <Input v-model:value="newPassword" type="password" placeholder="新密码（至少 6 位）" />
          </div>
          <div class="form-row">
            <Button size="small" @click="handleChangePassword">确认修改</Button>
            <span class="msg" :class="{ error: pwdError }">{{ pwdMsg }}</span>
          </div>
        </div>
      </template>

      <!-- 管理员设置 -->
      <template v-if="activeTab === 'admin'">
        <div class="section">
          <div class="section-title">模型提供商</div>
          <div class="item-list">
            <div class="item-row" v-for="p in providers" :key="p.id">
              <span class="item-name">{{ p.name }}</span>
              <span class="item-type">{{ p.providerType }}</span>
              <span class="item-url">{{ p.baseUrl }}</span>
              <span class="item-action delete" @click="deleteProvider(p.id)"><i-icon-park-outline:delete /></span>
            </div>
          </div>
          <div class="add-form">
            <Input v-model:value="newProvider.name" placeholder="名称" class="add-input" />
            <Select
              :value="newProvider.providerType"
              :options="providerTypeOptions"
              @update:value="v => newProvider.providerType = String(v)"
              class="add-input"
            />
            <Input v-model:value="newProvider.baseUrl" placeholder="Base URL" class="add-input" />
            <Input v-model:value="newProvider.apiKey" placeholder="API Key" type="password" class="add-input" />
            <Button size="small" type="primary" @click="addProvider">添加</Button>
          </div>
        </div>
        <Divider />
        <div class="section">
          <div class="section-title">模型白名单</div>
          <div class="item-list">
            <div class="item-row" v-for="m in models" :key="m.id">
              <span class="item-name">{{ m.displayName }}</span>
              <span class="item-type">{{ m.modelName }}</span>
              <Switch :value="m.enabled" @update:value="v => toggleModel(m.id, v)" />
              <span class="item-action delete" @click="deleteModel(m.id)"><i-icon-park-outline:delete /></span>
            </div>
          </div>
          <div class="add-form">
            <Select
              :value="String(newModel.providerId || '')"
              :options="providerOptions"
              @update:value="v => newModel.providerId = Number(v)"
              class="add-input"
              placeholder="提供商"
            />
            <Input v-model:value="newModel.modelName" placeholder="模型名（如 gpt-4o）" class="add-input" />
            <Input v-model:value="newModel.displayName" placeholder="显示名" class="add-input" />
            <Button size="small" type="primary" @click="addModel">添加</Button>
          </div>
        </div>
        <Divider />
        <div class="section">
          <div class="section-title">角色默认模型</div>
          <div class="pref-list">
            <div class="pref-item" v-for="role in ROLES" :key="role">
              <span class="pref-role">{{ ROLE_LABELS[role] }}</span>
              <Select
                class="pref-select"
                :value="String(roleDefaultMap[role] || '')"
                :options="allModelOptions"
                @update:value="v => setRoleDefault(role, Number(v))"
              />
            </div>
          </div>
        </div>
        <Divider />
        <div class="section">
          <div class="section-title">用户管理</div>
          <div class="item-list">
            <div class="item-row" v-for="u in users" :key="u.id">
              <span class="item-name">{{ u.username }}</span>
              <Select
                :value="u.role"
                :options="roleOptions"
                @update:value="v => updateUserRole(u.id, v as 'admin' | 'user')"
                class="role-select"
              />
              <span class="item-action delete" v-if="u.id !== authStore.user?.id" @click="deleteUser(u.id)"><i-icon-park-outline:delete /></span>
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { ref, computed, onMounted, reactive } from 'vue'
import { useAuthStore } from '@/store'
import { userApi, adminApi } from '@/services'
import Tabs from '@/components/Tabs.vue'
import Select from '@/components/Select.vue'
import Input from '@/components/Input.vue'
import Button from '@/components/Button.vue'
import Switch from '@/components/Switch.vue'
import Divider from '@/components/Divider.vue'

const authStore = useAuthStore()

const ROLES = ['planner', 'generator', 'reviewer', 'editor'] as const
const ROLE_LABELS: Record<string, string> = {
  planner: '规划者',
  generator: '生成者',
  reviewer: '审查者',
  editor: '编辑者',
}

const providerTypeOptions = [
  { label: 'OpenAI 兼容', value: 'openai' },
  { label: 'Anthropic', value: 'anthropic' },
  { label: 'Google', value: 'google' },
]

const roleOptions = [
  { label: '管理员', value: 'admin' },
  { label: '普通用户', value: 'user' },
]

const tabItems = computed(() => {
  const items = [{ key: 'user', label: '用户设置' }]
  if (authStore.isAdmin) items.push({ key: 'admin', label: '管理员' })
  return items
})

const activeTab = ref('user')

// --- User prefs ---
interface Preference { role: string; modelConfigId: number | null; source: string }
interface ModelOption { label: string; value: string }

const preferences = ref<Preference[]>([])
const userModels = ref<any[]>([])
const modelOptions = computed<ModelOption[]>(() =>
  userModels.value.map(m => ({ label: `${m.displayName} (${m.providerName})`, value: String(m.id) }))
)

const loadUserData = async () => {
  try {
    const [modelsRes, prefsRes] = await Promise.all([userApi.models(), userApi.preferences()])
    userModels.value = (modelsRes as any).models || []
    preferences.value = (prefsRes as any).preferences || []
  }
  catch { /* empty */ }
}

const setPreference = async (role: string, modelConfigId: number) => {
  try {
    await userApi.setPreference(role, modelConfigId)
    await loadUserData()
  }
  catch { /* empty */ }
}

// --- Password ---
const oldPassword = ref('')
const newPassword = ref('')
const pwdMsg = ref('')
const pwdError = ref(false)

const handleChangePassword = async () => {
  pwdMsg.value = ''
  pwdError.value = false
  if (newPassword.value.length < 6) {
    pwdMsg.value = '新密码至少 6 位'
    pwdError.value = true
    return
  }
  try {
    await userApi.changePassword(oldPassword.value, newPassword.value)
    pwdMsg.value = '修改成功'
    oldPassword.value = ''
    newPassword.value = ''
  }
  catch (err: any) {
    pwdMsg.value = err?.response?.data?.error || '修改失败'
    pwdError.value = true
  }
}

// --- Admin ---
const providers = ref<any[]>([])
const models = ref<any[]>([])
const users = ref<any[]>([])
const roleDefaultMap = ref<Record<string, number>>({})

const newProvider = reactive({ name: '', providerType: 'openai', baseUrl: '', apiKey: '' })
const newModel = reactive({ providerId: 0, modelName: '', displayName: '' })

const providerOptions = computed<ModelOption[]>(() =>
  providers.value.map(p => ({ label: p.name, value: String(p.id) }))
)
const allModelOptions = computed<ModelOption[]>(() =>
  models.value.map(m => ({ label: `${m.displayName} (${m.modelName})`, value: String(m.id) }))
)

const loadAdminData = async () => {
  if (!authStore.isAdmin) return
  try {
    const [pRes, mRes, uRes, rdRes] = await Promise.all([
      adminApi.listProviders(),
      adminApi.listModels(),
      adminApi.listUsers(),
      adminApi.listRoleDefaults(),
    ])
    providers.value = (pRes as any).providers || []
    models.value = (mRes as any).models || []
    users.value = (uRes as any).users || []
    const defaults = (rdRes as any).defaults || []
    roleDefaultMap.value = {}
    for (const d of defaults) roleDefaultMap.value[d.role] = d.modelConfigId
  }
  catch { /* empty */ }
}

const addProvider = async () => {
  try {
    await adminApi.createProvider(newProvider)
    newProvider.name = ''
    newProvider.baseUrl = ''
    newProvider.apiKey = ''
    await loadAdminData()
  }
  catch (err: any) { alert(err?.response?.data?.error || '添加失败') }
}

const deleteProvider = async (id: number) => {
  if (!confirm('确定删除？')) return
  await adminApi.deleteProvider(id)
  await loadAdminData()
}

const addModel = async () => {
  try {
    await adminApi.createModel(newModel)
    newModel.modelName = ''
    newModel.displayName = ''
    await loadAdminData()
    await loadUserData()
  }
  catch (err: any) { alert(err?.response?.data?.error || '添加失败') }
}

const deleteModel = async (id: number) => {
  if (!confirm('确定删除？')) return
  await adminApi.deleteModel(id)
  await loadAdminData()
  await loadUserData()
}

const toggleModel = async (id: number, enabled: boolean) => {
  await adminApi.updateModel(id, { enabled })
  await loadAdminData()
  await loadUserData()
}

const setRoleDefault = async (role: string, modelConfigId: number) => {
  await adminApi.setRoleDefault(role, modelConfigId)
  await loadAdminData()
}

const updateUserRole = async (id: number, role: 'admin' | 'user') => {
  await adminApi.updateUserRole(id, role)
  await loadAdminData()
}

const deleteUser = async (id: number) => {
  if (!confirm('确定删除该用户？')) return
  await adminApi.deleteUser(id)
  await loadAdminData()
}

onMounted(() => {
  loadUserData()
  loadAdminData()
})
</script>

<style lang="scss" scoped>
.settings-dialog {
  width: 100%;
}
.settings-body {
  padding: 16px 20px;
  max-height: 60vh;
  @include overflow-overlay();
}
.section {
  margin-bottom: 8px;
}
.section-title {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 6px;
}
.section-desc {
  font-size: 12px;
  color: #999;
  margin-bottom: 10px;
}
.pref-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.pref-item {
  display: flex;
  align-items: center;
  gap: 10px;
}
.pref-role {
  width: 60px;
  font-size: 13px;
  flex-shrink: 0;
}
.pref-select {
  flex: 1;
}
.pref-source {
  font-size: 11px;
  color: #999;
}
.form-row {
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.msg {
  font-size: 12px;
  color: #27ae60;
  &.error { color: #e74c3c; }
}
.item-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 10px;
}
.item-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  background: $lightGray;
  border-radius: 4px;
  font-size: 12px;
}
.item-name {
  font-weight: 500;
  min-width: 60px;
}
.item-type {
  color: #999;
  flex: 1;
}
.item-url {
  color: #999;
  font-size: 11px;
  max-width: 200px;
  @include ellipsis-oneline();
}
.item-action {
  cursor: pointer;
  font-size: 14px;
  color: #999;
  &.delete:hover { color: #e74c3c; }
}
.role-select {
  width: 100px;
}
.add-form {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
}
.add-input {
  flex: 1;
  min-width: 100px;
}
</style>
