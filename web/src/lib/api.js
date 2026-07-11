import { getApiErrorMessage } from './office'

const TOKEN_KEY = 'gateway_token'

export const getToken = () => localStorage.getItem(TOKEN_KEY) || ''
export const setToken = (t) => localStorage.setItem(TOKEN_KEY, t)
export const clearToken = () => localStorage.removeItem(TOKEN_KEY)

const authHeaders = () => {
  const t = getToken()
  return t ? { 'x-api-key': t, Authorization: `Bearer ${t}` } : {}
}

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

export const get = (p) => api(p)
export const post = (p, body) => api(p, { method: 'POST', body: JSON.stringify(body || {}) })
export const put = (p, body) => api(p, { method: 'PUT', body: JSON.stringify(body || {}) })
export const del = (p) => api(p, { method: 'DELETE' })

// ── 设置项 ────────────────────────────────────────────────────────

export const getSetupStatus = () => api('/admin/setup-status')

export const getSettings = () => api('/admin/settings')

export const updateSettings = (data) => api('/admin/settings', { method: 'PUT', body: JSON.stringify(data) })

export const getOfficeStatus = () => api('/admin/office/status')
export const setupOffice = () => api('/admin/office/setup', { method: 'POST' })
export const removeOffice = () => api('/admin/office/setup', { method: 'DELETE' })
