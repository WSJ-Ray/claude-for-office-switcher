import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { KeyRound, Save } from 'lucide-react'
import { getSettings, updateSettings, setToken } from '../lib/api'

export default function Settings() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { data: settings, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: getSettings,
  })
  const [token, setTokenInput] = useState('')
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState(null)

  const saveM = useMutation({
    mutationFn: (data) => updateSettings(data),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['settings'] }),
        qc.invalidateQueries({ queryKey: ['setup-status'] }),
      ])
      setSaved(true)
      setErr(null)
      if (token) {
        setToken(token)
        navigate('/', { replace: true })
      }
      setTimeout(() => setSaved(false), 3000)
    },
    onError: (e) => setErr(e.message),
  })

  const configured = settings?.has_token ?? false
  const handleSave = () => {
    const next = token.trim()
    if (!next) return
    saveM.mutate({ gateway_token: next })
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        eyebrow="Settings"
        title="系统设置"
        desc="配置管理控制台访问令牌。首次启动时需要先设置 Gateway Token。"
      />

      {!configured && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          网关令牌尚未配置，请先设置一个令牌后再使用管理面板。
        </div>
      )}

      <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <div className="mb-6 flex items-center gap-3">
          <div className="rounded-lg border border-blue-100 bg-blue-50 p-2.5 text-blue-700">
            <KeyRound size={20} />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-slate-950">Gateway Token</h2>
            <p className="mt-1 text-sm text-slate-400">用于登录管理面板的密码。保存后会写入本地浏览器并立即生效。</p>
          </div>
        </div>

        <div className="max-w-xl space-y-2">
          <label className="text-xs font-medium uppercase tracking-[0.14em] text-slate-500" htmlFor="gateway-token">
            Token
          </label>
          <input
            id="gateway-token"
            type="password"
            value={token}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder={isLoading ? '加载中...' : configured ? '输入新令牌（留空则不修改）' : '设置网关令牌'}
            className="w-full rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 font-mono text-sm text-slate-950 outline-none transition-colors placeholder:text-slate-400 focus:border-blue-500"
          />
          {!isLoading && configured && (
            <div className="text-xs text-slate-500">当前：{settings?.gateway_token || '（未设置）'}</div>
          )}
        </div>

        {err && <div className="mt-4 text-sm text-red-700">{err}</div>}
        {saved && <div className="mt-4 text-sm text-emerald-700">已保存</div>}

        <button
          onClick={handleSave}
          disabled={saveM.isPending || !token.trim()}
          className="mt-6 inline-flex cursor-pointer items-center gap-2 rounded-lg bg-black px-4 py-2.5 text-sm font-semibold text-white transition-colors duration-200 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Save size={16} />
          {saveM.isPending ? '保存中...' : '保存设置'}
        </button>
      </div>
    </div>
  )
}

const PageHeader = ({ eyebrow, title, desc }) => (
  <div>
    <p className="text-sm font-semibold uppercase tracking-[0.16em] text-blue-700">{eyebrow}</p>
    <h1 className="mt-2 text-3xl font-semibold text-slate-950">{title}</h1>
    <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">{desc}</p>
  </div>
)
