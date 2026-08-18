<template>
  <div class="personal-settings">
    <div class="section-header">
      <h3>个人设置</h3>
    </div>

    <div class="sub-section">
      <div class="sub-title">模型偏好</div>
      <p class="sub-desc">留空则使用管理员设置的全局默认模型。</p>

      <div class="role-grid">
        <div class="role-card" v-for="role in ROLES" :key="role.key">
          <div class="role-name">{{ role.key }}</div>
          <div class="role-label">{{ role.name }}</div>
          <div class="role-default" v-if="globalDefaults[role.key]">
            全局默认: {{ globalDefaults[role.key] }}
          </div>
          <Select
            class="role-select"
            :value="preferences[role.key] || ''"
            :options="modelOptionsWithDefault"
            defaultLabel="未设置"
            @update:value="v => handleSetPref(role.key, v)"
          />
        </div>
      </div>
    </div>

    <div class="divider"></div>

    <div class="sub-section">
      <div class="sub-title">修改密码</div>
      <div class="password-form">
        <div class="form-group">
          <label>旧密码</label>
          <Input v-model:value="oldPassword" placeholder="输入当前密码" />
        </div>
        <div class="form-group">
          <label>新密码</label>
          <Input v-model:value="newPassword" placeholder="至少 6 位" />
        </div>
        <div class="form-group">
          <label>确认新密码</label>
          <Input v-model:value="confirmPassword" placeholder="再次输入新密码" />
        </div>
        <div class="form-actions">
          <span class="pwd-msg" v-if="pwdMsg" :class="pwdOk ? 'success' : 'fail'">{{ pwdMsg }}</span>
          <Button type="primary" size="small" @click="handleChangePassword">保存</Button>
        </div>
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { userApi, adminApi } from '@/services'
import { useAuthStore } from '@/store'
import Button from '@/components/Button.vue'
import Input from '@/components/Input.vue'
import Select from '@/components/Select.vue'

const authStore = useAuthStore()

const ROLES = [
  { key: 'planner', name: '规划者', desc: '分析用户意图，制定执行计划' },
  { key: 'generator', name: '生成者', desc: '生成和修改演示文稿内容' },
  { key: 'reviewer', name: '审查者', desc: '校验排版和内容质量' },
  { key: 'editor', name: '编辑者', desc: '处理局部元素的调整' },
]

interface Model { id: number; displayName: string }

const models = ref<Model[]>([])
const preferences = reactive<Record<string, string | number>>({
  planner: '', generator: '', reviewer: '', editor: '',
})
const globalDefaults = reactive<Record<string, string>>({
  planner: '', generator: '', reviewer: '', editor: '',
})

const modelOptionsWithDefault = computed(() => [
  { label: '使用默认', value: '' as string | number },
  ...models.value.map(m => ({ label: m.displayName, value: m.id as string | number })),
])

const load = async () => {
  try {
    const mRes = await userApi.models() as any
    models.value = mRes.models || []

    const pRes = await userApi.preferences() as any
    for (const p of (pRes.preferences || [])) {
      if (p.source === 'user') preferences[p.role] = p.modelConfigId
      else preferences[p.role] = ''
    }

    if (authStore.isAdmin) {
      const dRes = await adminApi.listRoleDefaults() as any
      const allModels = await adminApi.listModels() as any
      const modelMap = new Map<number, string>((allModels.models || []).map((m: any) => [m.id, m.displayName]))
      for (const d of (dRes.defaults || [])) {
        globalDefaults[d.role] = modelMap.get(d.modelConfigId) || `#${d.modelConfigId}`
      }
    }
  }
  catch { /* */ }
}

const handleSetPref = async (role: string, value: string | number) => {
  if (!value || value === '') {
    preferences[role] = ''
    return
  }
  preferences[role] = Number(value)
  try {
    await userApi.setPreference(role, Number(value))
  }
  catch (err: any) { alert(err?.response?.data?.error || '设置失败') }
}

const oldPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const pwdMsg = ref('')
const pwdOk = ref(false)

const handleChangePassword = async () => {
  pwdMsg.value = ''
  if (newPassword.value.length < 6) { pwdMsg.value = '新密码至少 6 位'; pwdOk.value = false; return }
  if (newPassword.value !== confirmPassword.value) { pwdMsg.value = '两次密码不一致'; pwdOk.value = false; return }
  try {
    await userApi.changePassword(oldPassword.value, newPassword.value)
    pwdMsg.value = '密码已修改'
    pwdOk.value = true
    oldPassword.value = ''
    newPassword.value = ''
    confirmPassword.value = ''
  }
  catch (err: any) {
    pwdMsg.value = err?.response?.data?.error || '修改失败'
    pwdOk.value = false
  }
}

onMounted(load)
</script>

<style lang="scss" scoped>
.section-header {
  margin-bottom: 20px;
  h3 { font-size: 18px; font-weight: 600; margin: 0; }
}
.sub-section {
  margin-bottom: 24px;
}
.sub-title {
  font-size: 15px;
  font-weight: 500;
  margin-bottom: 4px;
}
.sub-desc {
  font-size: 13px;
  color: #999;
  margin-bottom: 16px;
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
.role-default {
  font-size: 12px;
  color: #999;
  margin-bottom: 8px;
}
.role-select {
  width: 100%;
}
.divider {
  height: 1px;
  background: $borderColor;
  margin: 24px 0;
}
.password-form {
  max-width: 360px;
}
.form-group {
  margin-bottom: 12px;
  label {
    display: block;
    font-size: 13px;
    color: #666;
    margin-bottom: 4px;
  }
}
.form-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  margin-top: 16px;
}
.pwd-msg {
  font-size: 13px;
  &.success { color: #27ae60; }
  &.fail { color: #e74c3c; }
}
</style>
