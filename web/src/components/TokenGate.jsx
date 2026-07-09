import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Navigate, useLocation } from 'react-router-dom'
import { LockKeyhole } from 'lucide-react'
import { setToken, getToken, getSetupStatus } from '../lib/api'

export default function TokenGate({ children }) {
  const [token, setLocal] = useState(getToken() || '')
  const [input, setInput] = useState('')
  const location = useLocation()
  const { data: status, isLoading } = useQuery({
    queryKey: ['setup-status'],
    queryFn: getSetupStatus,
    retry: false,
  })
  const currentToken = token || getToken()

  if (isLoading) return children

  if (status && !status.configured) {
    if (location.pathname !== '/settings') return <Navigate to="/settings" replace />
    return children
  }

  if (currentToken) return children

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
          <p className="mt-2 text-sm leading-6 text-slate-400">{'\u8f93\u5165 Gateway Token \u8bbf\u95ee\u7ba1\u7406\u63a7\u5236\u53f0\u3002'}</p>
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
              className="w-full rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-950 outline-none transition-colors placeholder:text-slate-400 focus:border-black"
            />
            <button
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
