import axios from 'axios'
import message from '@/utils/message'

const instance = axios.create({ timeout: 1000 * 300 })

instance.interceptors.response.use(
  response => {
    if (response.status >= 200 && response.status < 400) {
      return Promise.resolve(response.data)
    }

    message.error('未知的请求错误！')
    return Promise.reject(response)
  },
  error => {
    if (error && error.response) {
      const data = error.response.data
      const msg = data?.error || error.message || '请求失败'

      if (error.response.status >= 500) {
        message.error('服务器遇到未知错误！')
      }

      return Promise.reject({ message: msg, status: error.response.status, data })
    }

    message.error('连接到服务器失败 或 服务器响应超时！')
    return Promise.reject({ message: error.message || '网络错误' })
  }
)

export default instance