<template>
  <div class="auth-page">
    <div class="auth-card">
      <div class="auth-title">Rabbit</div>
      <div class="auth-subtitle">{{ isLogin ? '登录' : '注册' }}</div>

      <div class="auth-form">
        <div class="form-item">
          <Input v-model:value="username" placeholder="用户名" @keydown.enter="handleSubmit" />
        </div>
        <div class="form-item">
          <Input v-model:value="password" type="password" placeholder="密码" @keydown.enter="handleSubmit" />
        </div>
        <div class="form-item" v-if="!isLogin">
          <Input v-model:value="confirmPassword" type="password" placeholder="确认密码" @keydown.enter="handleSubmit" />
        </div>
        <div class="error-msg" v-if="errorMsg">{{ errorMsg }}</div>
        <Button class="submit-btn" type="primary" @click="handleSubmit" :disabled="loading">
          {{ loading ? '请稍候...' : (isLogin ? '登录' : '注册') }}
        </Button>
        <div class="switch-mode" @click="toggleMode">
          {{ isLogin ? '没有账号？去注册' : '已有账号？去登录' }}
        </div>
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { ref } from 'vue'
import { useAuthStore } from '@/store'
import Input from '@/components/Input.vue'
import Button from '@/components/Button.vue'

const emit = defineEmits<{
  (event: 'success'): void
}>()

const authStore = useAuthStore()

const isLogin = ref(true)
const username = ref('')
const password = ref('')
const confirmPassword = ref('')
const errorMsg = ref('')
const loading = ref(false)

const toggleMode = () => {
  isLogin.value = !isLogin.value
  errorMsg.value = ''
}

const handleSubmit = async () => {
  errorMsg.value = ''

  if (!username.value.trim() || !password.value) {
    errorMsg.value = '请填写用户名和密码'
    return
  }
  if (!isLogin.value && password.value !== confirmPassword.value) {
    errorMsg.value = '两次密码不一致'
    return
  }
  if (!isLogin.value && password.value.length < 6) {
    errorMsg.value = '密码至少 6 位'
    return
  }

  loading.value = true
  try {
    if (isLogin.value) {
      await authStore.login(username.value.trim(), password.value)
    }
    else {
      await authStore.register(username.value.trim(), password.value)
    }
    emit('success')
  }
  catch (err: any) {
    errorMsg.value = err?.response?.data?.error || err?.message || '操作失败'
  }
  finally {
    loading.value = false
  }
}
</script>

<style lang="scss" scoped>
.auth-page {
  height: 100%;
  display: flex;
  justify-content: center;
  align-items: center;
  background: linear-gradient(135deg, #f5f7fa 0%, #e4e9f0 100%);
}
.auth-card {
  width: 360px;
  padding: 40px 32px;
  background: #fff;
  border-radius: 8px;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.08);
}
.auth-title {
  font-size: 28px;
  font-weight: 700;
  text-align: center;
  background: linear-gradient(270deg, #d897fd, #33bcfc);
  background-clip: text;
  color: transparent;
  margin-bottom: 4px;
}
.auth-subtitle {
  font-size: 14px;
  color: #999;
  text-align: center;
  margin-bottom: 28px;
}
.form-item {
  margin-bottom: 16px;
}
.error-msg {
  color: #e74c3c;
  font-size: 12px;
  margin-bottom: 12px;
}
.submit-btn {
  width: 100%;
  height: 38px;
  font-size: 14px;
}
.switch-mode {
  text-align: center;
  margin-top: 16px;
  font-size: 13px;
  color: $themeColor;
  cursor: pointer;

  &:hover {
    text-decoration: underline;
  }
}
</style>
