<template>
  <div class="user-management">
    <div class="section-header">
      <h3>用户管理</h3>
    </div>

    <div class="user-table" v-if="users.length">
      <div class="table-header">
        <span class="col-id">ID</span>
        <span class="col-name">用户名</span>
        <span class="col-role">角色</span>
        <span class="col-time">注册时间</span>
        <span class="col-actions">操作</span>
      </div>
      <div class="table-row" v-for="u in users" :key="u.id">
        <span class="col-id">{{ u.id }}</span>
        <span class="col-name">{{ u.username }}</span>
        <span class="col-role">
          <Select
            :value="u.role"
            :options="roleOptions"
            :disabled="u.id === currentUserId"
            @update:value="v => handleRoleChange(u.id, String(v) as 'admin' | 'user')"
          />
        </span>
        <span class="col-time">{{ formatTime(u.createdAt) }}</span>
        <span class="col-actions">
          <template v-if="u.id !== currentUserId">
            <Button size="small" @click="openResetModal(u)">重置密码</Button>
            <Button size="small" @click="handleDelete(u.id)">删除</Button>
          </template>
          <span class="self-hint" v-else>当前用户</span>
        </span>
      </div>
    </div>
    <div class="empty-tip" v-else>暂无用户</div>

    <Modal :visible="resetVisible" :width="400" @closed="resetVisible = false">
      <div class="form-title">重置密码：{{ resetTarget?.username }}</div>
      <div class="form-group">
        <label>新密码</label>
        <Input v-model:value="newPassword" placeholder="至少 6 位" />
      </div>
      <div class="form-actions">
        <Button size="small" @click="resetVisible = false">取消</Button>
        <Button size="small" type="primary" @click="handleReset">确定</Button>
      </div>
    </Modal>
  </div>
</template>

<script lang="ts" setup>
import { ref, onMounted } from 'vue'
import { useAuthStore } from '@/store'
import { adminApi } from '@/services'
import Button from '@/components/Button.vue'
import Input from '@/components/Input.vue'
import Select from '@/components/Select.vue'
import Modal from '@/components/Modal.vue'

const authStore = useAuthStore()
const currentUserId = authStore.user?.id

interface User {
  id: number
  username: string
  role: string
  createdAt: string | number
}

const users = ref<User[]>([])
const resetVisible = ref(false)
const resetTarget = ref<User | null>(null)
const newPassword = ref('')
const roleOptions = [
  { label: '管理员', value: 'admin' },
  { label: '用户', value: 'user' },
]

const load = async () => {
  try {
    const res = await adminApi.listUsers() as any
    users.value = res.users || []
  }
  catch {
    users.value = []
  }
}

const handleRoleChange = async (id: number, role: 'admin' | 'user') => {
  try {
    await adminApi.updateUserRole(id, role)
    const u = users.value.find(u => u.id === id)
    if (u) u.role = role
  }
  catch (err: any) {
    alert(err?.response?.data?.error || '操作失败')
  }
}

const openResetModal = (u: User) => {
  resetTarget.value = u
  newPassword.value = ''
  resetVisible.value = true
}

const handleReset = async () => {
  if (!resetTarget.value || newPassword.value.length < 6) {
    alert('密码至少 6 位')
    return
  }
  try {
    await adminApi.resetPassword(resetTarget.value.id, newPassword.value)
    resetVisible.value = false
    alert('密码已重置')
  }
  catch (err: any) {
    alert(err?.response?.data?.error || '重置失败')
  }
}

const handleDelete = async (id: number) => {
  if (!confirm('确定删除该用户？')) return
  try {
    await adminApi.deleteUser(id)
    users.value = users.value.filter(u => u.id !== id)
  }
  catch (err: any) {
    alert(err?.response?.data?.error || '删除失败')
  }
}

const formatTime = (t: string | number) => {
  if (!t) return ''
  const d = new Date(typeof t === 'number' ? t * 1000 : t)
  return d.toLocaleDateString('zh-CN')
}

onMounted(load)
</script>

<style lang="scss" scoped>
.section-header {
  margin-bottom: 20px;
  h3 { font-size: 18px; font-weight: 600; margin: 0; }
}
.user-table {
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
  padding: 10px 16px;
  font-size: 13px;
  border-bottom: 1px solid #f0f0f0;
  &:last-child { border-bottom: none; }
}
.col-id { width: 50px; flex-shrink: 0; }
.col-name { width: 120px; flex-shrink: 0; }
.col-role { width: 120px; flex-shrink: 0; }
.col-time { width: 100px; flex-shrink: 0; color: #999; }
.col-actions {
  flex: 1;
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
.self-hint {
  font-size: 12px;
  color: #999;
}
.form-title {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 16px;
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
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}
.empty-tip {
  color: #999;
  text-align: center;
  padding: 40px 0;
}
</style>
