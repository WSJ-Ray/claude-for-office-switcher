import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CheckCircle2,
  CircleAlert,
  Download,
  KeyRound,
  MonitorCog,
  Power,
  RefreshCw,
  RotateCcw,
  Save,
} from 'lucide-react'
import {
  getOfficeStatus,
  getSettings,
  removeOffice,
  setToken,
  setupOffice,
  updateSettings,
} from '../lib/api'
import { getOfficeUiState } from '../lib/office'

const HOST_DETAILS = {
  word: { title: 'Word', process: 'WINWORD.EXE' },
  powerpoint: { title: 'PowerPoint', process: 'POWERPNT.EXE' },
  excel: { title: 'Excel', process: 'EXCEL.EXE' },
}

const STATUS_COPY = {
  conflict: { label: '注册冲突', className: 'border-red-200 bg-red-50 text-red-700' },
  managed: { label: '已托管', className: 'border-emerald-200 bg-emerald-50 text-emerald-700' },
  official: { label: '官方插件已检测', className: 'border-blue-200 bg-blue-50 text-blue-700' },
  available: { label: '可配置', className: 'border-slate-200 bg-slate-50 text-slate-700' },
  unavailable: { label: '未检测到', className: 'border-slate-200 bg-slate-50 text-slate-500' },
}

export default function Settings() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [token, setTokenInput] = useState('')
  const [saved, setSaved] = useState(false)
  const [tokenError, setTokenError] = useState(null)
  const [officeNotice, setOfficeNotice] = useState(null)

  const settingsQ = useQuery({ queryKey: ['settings'], queryFn: getSettings })
  const officeQ = useQuery({ queryKey: ['office-status'], queryFn: getOfficeStatus })

  const refreshOffice = async () => {
    await qc.invalidateQueries({ queryKey: ['office-status'] })
  }

  const saveM = useMutation({
    mutationFn: updateSettings,
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['settings'] }),
        qc.invalidateQueries({ queryKey: ['setup-status'] }),
        qc.invalidateQueries({ queryKey: ['auth-check'] }),
        qc.invalidateQueries({ queryKey: ['office-status'] }),
      ])
      setSaved(true)
      setTokenError(null)
      if (token) {
        setToken(token)
        navigate('/', { replace: true })
      }
      setTimeout(() => setSaved(false), 3000)
    },
    onError: (error) => setTokenError(error.message),
  })

  const setupM = useMutation({
    mutationFn: setupOffice,
    onSuccess: async (result) => {
      await refreshOffice()
      setOfficeNotice({ type: 'success', restart: result.restart_required })
    },
    onError: (error) => setOfficeNotice({ type: 'error', message: error.message }),
  })

  const removeM = useMutation({
    mutationFn: removeOffice,
    onSuccess: async (result) => {
      await refreshOffice()
      setOfficeNotice({ type: 'removed', restart: result.restart_required })
    },
    onError: (error) => setOfficeNotice({ type: 'error', message: error.message }),
  })

  const configured = settingsQ.data?.has_token ?? false
  const officeState = getOfficeUiState(officeQ.data)
  const busy = setupM.isPending || removeM.isPending

  const handleSave = () => {
    const next = token.trim()
    if (next) saveM.mutate({ gateway_token: next })
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader eyebrow="Settings" title="系统设置" desc="管理网关访问令牌和 Claude for Office 的本机配置。" />

      {settingsQ.isError && <ErrorBanner message={settingsQ.error.message} retry={settingsQ.refetch} />}

      <TokenSettings
        configured={configured}
        isLoading={settingsQ.isLoading}
        token={token}
        setToken={setTokenInput}
        saved={saved}
        error={tokenError}
        saving={saveM.isPending}
        onSave={handleSave}
      />

      <section className="border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex gap-3">
            <div className="border border-violet-100 bg-violet-50 p-2.5 text-violet-700"><MonitorCog size={20} /></div>
            <div>
              <h2 className="text-lg font-semibold text-slate-950">Claude for Office</h2>
              <p className="mt-1 text-sm text-slate-600">Word、PowerPoint 和 Excel 使用本机 Developer 注册加载 Gateway 配置。</p>
            </div>
          </div>
          <button type="button" onClick={() => officeQ.refetch()} disabled={officeQ.isFetching || busy} className="inline-flex items-center gap-2 border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50">
            <RefreshCw size={16} className={officeQ.isFetching ? 'animate-spin' : ''} /> 检测
          </button>
        </div>

        {officeQ.isError ? (
          <div className="mt-5"><ErrorBanner message={officeQ.error.message} retry={officeQ.refetch} /></div>
        ) : (
          <>
            <div className="mt-6 grid gap-px overflow-hidden border border-slate-200 sm:grid-cols-3">
              <Readiness label="Windows" ready={Boolean(officeQ.data?.supported)} detail={officeQ.data?.platform || '检测中'} />
              <Readiness label="Office" ready={Boolean(officeQ.data?.office?.installed)} detail={officeQ.data?.office?.version || '未检测到'} />
              <Readiness label="Gateway" ready={Boolean(officeQ.data?.gateway_ready)} detail={officeQ.data?.gateway_url || '等待检测'} />
            </div>

            <div className="mt-5 divide-y divide-slate-200 border-y border-slate-200">
              {Object.entries(HOST_DETAILS).map(([key, meta]) => <HostRow key={key} meta={meta} host={officeState.hosts[key]} />)}
            </div>

            {officeState.restartHint && <div className="mt-4 flex gap-2 border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-800"><CircleAlert size={17} className="mt-0.5 shrink-0" />关闭并重新打开正在运行的 Word、PowerPoint 或 Excel，配置才会生效。</div>}
            {officeState.setup.reason && <div className="mt-4 border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700">{officeState.setup.reason}</div>}
            {officeNotice && <OfficeNotice notice={officeNotice} />}

            <div className="mt-5 flex flex-wrap gap-3">
              <button type="button" onClick={() => { setOfficeNotice(null); setupM.mutate() }} disabled={officeState.setup.disabled || busy} className="inline-flex items-center gap-2 bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50">
                <Download size={16} /> {setupM.isPending ? '正在配置...' : officeState.setup.label}
              </button>
              <button type="button" onClick={() => { setOfficeNotice(null); removeM.mutate() }} disabled={officeState.remove.disabled || busy} className="inline-flex items-center gap-2 border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50">
                <RotateCcw size={16} /> {removeM.isPending ? '正在恢复...' : '恢复官方插件'}
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  )
}

function TokenSettings({ configured, isLoading, token, setToken, saved, error, saving, onSave }) {
  return <section className="border border-slate-200 bg-white p-6 shadow-sm">
    <div className="flex items-center gap-3"><div className="border border-blue-100 bg-blue-50 p-2.5 text-blue-700"><KeyRound size={20} /></div><div><h2 className="text-lg font-semibold text-slate-950">Gateway Token</h2><p className="mt-1 text-sm text-slate-600">用于管理面板和 Office Gateway 的访问认证。</p></div></div>
    <div className="mt-5 max-w-xl space-y-2"><label className="text-xs font-medium uppercase tracking-[0.14em] text-slate-500" htmlFor="gateway-token">Token</label><input id="gateway-token" type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder={isLoading ? '加载中...' : configured ? '输入新令牌' : '设置网关令牌'} className="w-full border border-slate-200 bg-white px-3.5 py-2.5 font-mono text-sm text-slate-950 outline-none focus:border-cyan-700 focus:ring-2 focus:ring-cyan-100" /></div>
    {error && <div className="mt-4 text-sm text-red-700">{error}</div>}
    {saved && <div className="mt-4 text-sm text-emerald-700">设置已保存。</div>}
    <button type="button" onClick={onSave} disabled={saving || !token.trim()} className="mt-5 inline-flex items-center gap-2 bg-black px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"><Save size={16} />{saving ? '保存中...' : '保存设置'}</button>
  </section>
}

function Readiness({ label, ready, detail }) {
  return <div className="p-4"><div className="flex items-center justify-between"><span className="text-sm font-medium text-slate-700">{label}</span>{ready ? <CheckCircle2 size={17} className="text-emerald-600" /> : <CircleAlert size={17} className="text-slate-400" />}</div><p className="mt-2 truncate font-mono text-xs text-slate-500" title={detail}>{detail}</p></div>
}

function HostRow({ meta, host = {} }) {
  const status = STATUS_COPY[host.state] || STATUS_COPY.unavailable
  return <div className="flex flex-wrap items-center justify-between gap-3 py-4"><div><div className="flex items-center gap-2"><h3 className="font-semibold text-slate-950">{meta.title}</h3>{host.running && <span className="inline-flex items-center gap-1 text-xs text-amber-700"><Power size={13} />运行中</span>}</div><p className="mt-1 font-mono text-xs text-slate-500">{host.application_installed ? (host.executable_path || meta.process) : '未检测到桌面应用'}</p></div><span className={`border px-2.5 py-1 text-xs font-medium ${status.className}`}>{status.label}</span></div>
}

function OfficeNotice({ notice }) {
  if (notice.type === 'error') return <div className="mt-4 border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-800">{notice.message}</div>
  const action = notice.type === 'removed' ? '已恢复官方插件。' : 'Claude for Office 已配置。'
  return <div className="mt-4 border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-800">{action}{notice.restart && ' 请关闭并重新打开 Word、PowerPoint 或 Excel。'}</div>
}

function ErrorBanner({ message, retry }) {
  return <div role="alert" className="flex items-center justify-between gap-4 border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"><span>{message || '请求失败。'}</span><button type="button" onClick={() => retry()} className="shrink-0 font-semibold underline underline-offset-2">重试</button></div>
}

function PageHeader({ eyebrow, title, desc }) {
  return <div><p className="text-sm font-semibold uppercase tracking-[0.16em] text-blue-700">{eyebrow}</p><h1 className="mt-2 text-3xl font-semibold text-slate-950">{title}</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">{desc}</p></div>
}
