import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Navigate, useLocation } from 'react-router-dom'
import { LoaderCircle, LockKeyhole } from 'lucide-react'
import { clearToken, get, getSetupStatus, getToken, setToken } from '../lib/api'

export default function TokenGate({ children }) {
  const [token, setLocal] = useState(getToken() || '')
  const [input, setInput] = useState('')
  const location = useLocation()
  const [attempted, setAttempted] = useState(false)
  const setup = useQuery({
    queryKey: ['setup-status'],
    queryFn: getSetupStatus,
    retry: false,
    staleTime: 30_000,
  })
  const currentToken = token || getToken()
  const auth = useQuery({
    queryKey: ['auth-check', currentToken],
    queryFn: () => get('/admin/auth-check'),
    enabled: Boolean(setup.data?.configured && currentToken),
    retry: false,
    staleTime: 60_000,
  })

  useEffect(() => {
    if (auth.isError && currentToken) {
      clearToken()
      setLocal('')
      setAttempted(true)
    }
  }, [auth.isError, currentToken])

  if (setup.isLoading || (currentToken && auth.isLoading)) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-5 text-slate-600">
        <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm shadow-sm">
          <LoaderCircle size={18} className="animate-spin text-cyan-700" aria-hidden="true" />
          正在确认管理面板状态…
        </div>
      </div>
    )
  }

  if (setup.isError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-5">
        <div role="alert" className="w-full max-w-md rounded-xl border border-red-200 bg-white p-6 shadow-sm">
          <h1 className="text-lg font-semibold text-slate-950">无法连接管理服务</h1>
          <p className="mt-2 text-sm leading-6 text-slate-600">请确认网关正在运行后刷新页面。</p>
          <button type="button" onClick={() => setup.refetch()} className="mt-5 rounded-lg bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800">重新连接</button>
        </div>
      </div>
    )
  }

  if (setup.data && !setup.data.configured) {
    if (location.pathname !== '/settings') return <Navigate to="/settings" replace />
    return children
  }

  if (currentToken && auth.isSuccess) return children

  const authMessage = auth.isError ? '令牌验证失败，请重新输入。' : null

  const submit = () => {
    const value = input.trim()
    if (!value) return
    setToken(value)
    setLocal(value)
  }

  return (
    <div className="relative min-h-screen overflow-hidden bg-white text-slate-950">
      <div className="relative z-10 flex min-h-screen items-center justify-center px-5">
        <div className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-8 shadow-sm">
          <div className="mb-6 inline-flex rounded-lg border border-slate-200 bg-slate-50 p-3 text-slate-700">
            <LockKeyhole size={22} />
          </div>
          <h1 className="text-2xl font-semibold text-slate-950">Office Gateway</h1>
          <p className="mt-2 text-sm leading-6 text-slate-600">输入 Gateway Token 访问管理控制台。</p>
          {(attempted || authMessage) && <p role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{authMessage || '令牌无效或已失效，请重新输入。'}</p>}
          <div className="mt-6 space-y-3">
            <label className="block text-xs font-medium uppercase tracking-[0.14em] text-slate-500" htmlFor="token-input">
              Gateway Token
            </label>
            <input
              id="token-input"
              type="password"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit()
              }}
              placeholder={'\u8f93\u5165\u4ee4\u724c'}
              className="w-full rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-950 outline-none transition-colors placeholder:text-slate-400 focus:border-cyan-700 focus:ring-2 focus:ring-cyan-100"
            />
            <button
              type='button'
              onClick={submit}
              disabled={!input.trim()}
              className="inline-flex w-full cursor-pointer items-center justify-center rounded-lg bg-black px-4 py-2.5 text-sm font-semibold text-white transition-colors duration-200 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {'\u8fdb\u5165\u63a7\u5236\u53f0'}
            </button>
          </div>
          <p className="mt-5 text-center text-xs text-slate-500">{'\u9996\u6b21\u542f\u52a8\u65f6\u4f1a\u81ea\u52a8\u8fdb\u5165\u300c\u7cfb\u7edf\u8bbe\u7f6e\u300d\u914d\u7f6e\u4ee4\u724c\u3002'}</p>
        </div>
      </div>
    </div>
  )
}
