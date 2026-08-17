import axios from './axios'
import fetchRequest from './fetch'

// TODO(R-01): 改指自建后端。server.pptist.cn 是 PPTist 作者的托管服务，
//   其服务端不开源。下面 4 个端点是本项目要接管的全部接口面。
// TODO(R-02): 新增 agent 通道，至少三个：
//   POST /agent/task        提交任务（含选中元素 id 作为上下文）
//   GET  /agent/events      SSE 事件流（工具调用进度 · pending 资产 · 错误）
//   GET  /agent/deck        整份 deck 下发（Q4 定的是整份替换，不做细粒度 patch）
// export const SERVER_URL = 'http://localhost:5000'
export const SERVER_URL = (import.meta.env.MODE === 'development') ? '/api' : 'https://server.pptist.cn'

interface ImageSearchPayload {
  query: string;
  orientation?: 'landscape' | 'portrait' | 'square' | 'all';
  locale?: 'zh' | 'en';
  order?: 'popular' | 'latest';
  size?: 'large' | 'medium' | 'small';
  image_type?: 'all' | 'photo' | 'illustration' | 'vector';
  page?: number;
  per_page?: number;
}

interface AIPPTOutlinePayload {
  content: string
  language: string
  provider: string
  model: string
}

interface AIPPTPayload {
  content: string
  language: string
  style: string
  provider: string
  model: string
}

interface AIWritingPayload {
  content: string
  command: string
}

export default {
  getMockData(filename: string): Promise<any> {
    return axios.get(`./mocks/${filename}.json`)
  },

  searchImage(body: ImageSearchPayload): Promise<any> {
    return axios.post(`${SERVER_URL}/tools/img_search`, body)
  },

  AIPPT_Outline({
    content,
    language,
    provider,
    model,
  }: AIPPTOutlinePayload): Promise<any> {
    return fetchRequest(`${SERVER_URL}/tools/aippt_outline`, {
      method: 'POST',
      body: JSON.stringify({
        content,
        language,
        provider,
        model,
        stream: true,
      }),
    })
  },

  AIPPT({
    content,
    language,
    style,
    provider,
    model,
  }: AIPPTPayload): Promise<any> {
    return fetchRequest(`${SERVER_URL}/tools/aippt`, {
      method: 'POST',
      body: JSON.stringify({
        content,
        language,
        provider,
        model,
        style,
        stream: true,
      }),
    })
  },

  AI_Writing({
    content,
    command,
  }: AIWritingPayload): Promise<any> {
    return fetchRequest(`${SERVER_URL}/tools/ai_writing`, {
      method: 'POST',
      body: JSON.stringify({
        content,
        command,
        stream: true,
      }),
    })
  },
}