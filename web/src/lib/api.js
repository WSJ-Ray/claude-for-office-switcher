import { getApiErrorMessage } from './office'

const TOKEN_KEY = 'gateway_token'

/** 读取浏览器中保存的网关令牌。 */
export const getToken = () => localStorage.getItem(TOKEN_KEY) || ''
/** 将网关令牌保存到浏览器本地存储。 */
export const setToken = (t) => localStorage.setItem(TOKEN_KEY, t)
/** 从浏览器本地存储中删除网关令牌。 */
export const clearToken = () => localStorage.removeItem(TOKEN_KEY)

/** 根据当前令牌生成兼容的鉴权请求头。 */
const authHeaders = () => {
  const t = getToken()
  return t ? { 'x-api-key': t, Authorization: `Bearer ${t}` } : {}
}

/** 发送 JSON API 请求并将错误响应转换为带状态信息的 Error。 */
const api = async (path, opts = {}) => {
  const r = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...(opts.headers || {})
    }
  })
  if (!r.ok) {
    let detail = ''
    try { detail = (await r.json()).detail || '' } catch { detail = await r.text() }
    const error = new Error(getApiErrorMessage(detail, `${r.status}`))
    error.status = r.status
    error.code = typeof detail === 'object' ? detail.code : undefined
    throw error
  }
  return r.status === 204 ? null : r.json()
}

/** 向指定路径发送 GET 请求。 */
export const get = (p) => api(p)
/** 向指定路径发送 JSON POST 请求。 */
export const post = (p, body) => api(p, { method: 'POST', body: JSON.stringify(body || {}) })
/** 向指定路径发送 JSON PUT 请求。 */
export const put = (p, body) => api(p, { method: 'PUT', body: JSON.stringify(body || {}) })
/** 向指定路径发送 DELETE 请求。 */
export const del = (p) => api(p, { method: 'DELETE' })

// ── 设置项 ────────────────────────────────────────────────────────

/** 获取网关首次设置状态。 */
export const getSetupStatus = () => api('/admin/setup-status')

/** 获取已掩码的系统设置。 */
export const getSettings = () => api('/admin/settings')

/** 更新系统设置。 */
export const updateSettings = (data) => api('/admin/settings', { method: 'PUT', body: JSON.stringify(data) })

/** 获取本机 Office 集成状态。 */
export const getOfficeStatus = () => api('/admin/office/status')
/** 安装或刷新本机 Office 集成。 */
export const setupOffice = () => api('/admin/office/setup', { method: 'POST' })
/** 修复 Office 开发者注册冲突并重新配置。 */
export const repairOfficeConflicts = () => api('/admin/office/conflicts/repair', { method: 'POST' })
/** 移除本机受管 Office 集成。 */
export const removeOffice = () => api('/admin/office/setup', { method: 'DELETE' })
