import { getApiErrorMessage } from './office'

/** 发送 JSON API 请求并将错误响应转换为带状态信息的 Error。 */
const api = async (path, opts = {}) => {
  const r = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
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

/** 获取已掩码的系统设置。 */
export const getSettings = () => api('/admin/settings')

/** 更新系统设置。 */
export const updateSettings = (data) => api('/admin/settings', { method: 'PUT', body: JSON.stringify(data) })

/** 获取本机 Office 集成状态。 */
export const getOfficeStatus = () => api('/admin/office/status')
/** 安装或刷新指定应用的本机 Office 集成。 */
export const setupOffice = (apps) => api('/admin/office/setup', {
  method: 'POST',
  body: JSON.stringify(apps?.length ? { apps } : {}),
})
/** 修复 Office 开发者注册冲突并重新配置。 */
export const repairOfficeConflicts = (apps) => api('/admin/office/conflicts/repair', {
  method: 'POST',
  body: JSON.stringify(apps?.length ? { apps } : {}),
})
/** 移除本机选定的受管 Office 集成；不传应用时保持全量移除兼容。 */
export const removeOffice = (apps) => api('/admin/office/setup', {
  method: 'DELETE',
  body: JSON.stringify(apps?.length ? { apps } : {}),
})
