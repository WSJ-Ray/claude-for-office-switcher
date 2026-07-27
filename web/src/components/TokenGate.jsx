import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Navigate, useLocation } from 'react-router-dom'
import { AlertCircle, LockKeyhole, Network } from 'lucide-react'
import { clearToken, get, getSetupStatus, getToken, setToken } from '../lib/api'
import { Spinner } from './ui'

function GateShell({ children, desktopMode = false }) {
  return (
    <div
      className="flex h-[100dvh] min-h-[560px] min-w-[960px] flex-col overflow-auto bg-slate-100 text-slate-950"
      data-runtime={desktopMode ? 'desktop' : 'browser'}
    >
      {!desktopMode && (
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-slate-300 bg-white px-4">
          <span className="flex h-7 w-7 items-center justify-center rounded bg-office-700 text-white">
            <Network size={17} strokeWidth={1.8} aria-hidden="true" />
          </span>
          <span className="text-[13px] font-semibold">Office Gateway</span>
          <span className="h-4 w-px bg-slate-300" aria-hidden="true" />
          <span className="text-xs text-slate-600">安全访问</span>
        </header>
      )}
      <main className="flex min-h-0 flex-1 items-center justify-center px-8 py-6">
        {children}
      </main>
      <footer className="flex h-8 shrink-0 items-center justify-between border-t border-slate-300 bg-slate-50 px-4 text-[11px] text-slate-600">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-600" aria-hidden="true" />
          本地管理服务
        </span>
        <span className="font-mono">port 4000</span>
      </footer>
    </div>
  )
}

/** 根据首次配置和令牌验证状态控制管理端访问。 */
export default function TokenGate({ children, desktopMode = false }) {
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
      <GateShell desktopMode={desktopMode}>
        <div className="flex w-[380px] items-center gap-3 rounded-md border border-slate-300 bg-white px-4 py-3 shadow-[0_4px_16px_rgba(0,0,0,0.08)]" role="status">
          <Spinner className="text-office-700" />
          <div>
            <p className="text-[13px] font-semibold text-slate-900">正在连接管理服务</p>
            <p className="mt-0.5 text-xs text-slate-600">确认配置和访问令牌…</p>
          </div>
        </div>
      </GateShell>
    )
  }

  if (setup.isError) {
    return (
      <GateShell desktopMode={desktopMode}>
        <section role="alert" className="w-[420px] rounded-md border border-slate-300 bg-white shadow-[0_4px_16px_rgba(0,0,0,0.08)]">
          <div className="flex items-start gap-3 border-b border-slate-300 px-4 py-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-red-50 text-red-700">
              <AlertCircle size={18} strokeWidth={1.8} aria-hidden="true" />
            </span>
            <div>
              <h1 className="text-[15px] font-semibold leading-5">无法连接管理服务</h1>
              <p className="mt-1 text-xs leading-5 text-slate-600">请确认网关正在运行，然后重新建立连接。</p>
            </div>
          </div>
          <div className="flex justify-end bg-slate-50 px-4 py-3">
            <button type="button" onClick={() => setup.refetch()} className="h-8 rounded bg-office-700 px-3 text-[13px] font-semibold text-white transition-colors duration-150 hover:bg-office-800 active:bg-office-900">
              重新连接
            </button>
          </div>
        </section>
      </GateShell>
    )
  }

  if (setup.data && !setup.data.configured) {
    if (location.pathname !== '/settings') return <Navigate to="/settings" replace />
    return children
  }

  if (currentToken && auth.isSuccess) return children

  const authMessage = auth.isError ? '令牌验证失败，请重新输入。' : null

  /** 保存非空令牌并触发鉴权查询。 */
  const submit = (event) => {
    event.preventDefault()
    const value = input.trim()
    if (!value) return
    setToken(value)
    setLocal(value)
  }

  return (
    <GateShell desktopMode={desktopMode}>
      <section className="w-[420px] rounded-md border border-slate-300 bg-white shadow-[0_4px_16px_rgba(0,0,0,0.08)]" aria-labelledby="gateway-login-title">
        <div className="flex items-start gap-3 border-b border-slate-300 px-4 py-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-office-50 text-office-800">
            <LockKeyhole size={18} strokeWidth={1.8} aria-hidden="true" />
          </span>
          <div>
            <h1 id="gateway-login-title" className="text-[15px] font-semibold leading-5">连接 Office Gateway</h1>
            <p className="mt-1 text-xs leading-5 text-slate-600">输入 Gateway Token 访问管理控制台。</p>
          </div>
        </div>

        <form onSubmit={submit} className="px-4 py-4">
          {(attempted || authMessage) ? (
            <div role="alert" className="mb-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs leading-5 text-red-800">
              {authMessage || '令牌无效或已失效，请重新输入。'}
            </div>
          ) : null}
          <label className="block text-xs font-semibold text-slate-800" htmlFor="token-input">
            Gateway Token
          </label>
          <input
            id="token-input"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="输入令牌"
            className="mt-1.5 h-8 w-full rounded border border-slate-400 bg-white px-2.5 font-mono text-[13px] text-slate-950 outline-none transition-colors duration-150 placeholder:text-slate-500 focus:border-office-700 focus:ring-1 focus:ring-office-700"
          />
          <p className="mt-1.5 text-[11px] leading-4 text-slate-600">令牌仅保存在当前设备的浏览器存储中。</p>
          <div className="mt-4 flex justify-end">
            <button
              type="submit"
              disabled={!input.trim()}
              className="inline-flex h-8 min-w-24 cursor-pointer items-center justify-center rounded bg-office-700 px-3 text-[13px] font-semibold text-white transition-colors duration-150 hover:bg-office-800 active:bg-office-900 disabled:pointer-events-none disabled:opacity-45"
            >
              进入控制台
            </button>
          </div>
        </form>
        <p className="border-t border-slate-200 bg-slate-50 px-4 py-2 text-[11px] leading-4 text-slate-600">
          首次启动会自动进入“系统设置”配置令牌。
        </p>
      </section>
    </GateShell>
  )
}
