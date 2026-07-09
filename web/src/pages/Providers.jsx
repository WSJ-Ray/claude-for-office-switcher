import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Pencil, Play, Plus, Server, Trash2, XCircle } from 'lucide-react'
import { get, post, put, del } from '../lib/api'
import ProviderForm from '../components/ProviderForm'

const formatLabel = {
  anthropic: 'Anthropic',
  openai_chat: 'OpenAI Chat',
  openai_responses: 'Responses',
  vertex: 'Vertex AI'
}

export default function Providers() {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({ queryKey: ['providers'], queryFn: () => get('/admin/providers') })
  const [show, setShow] = useState(false)
  const [edit, setEdit] = useState(null)
  const [testResult, setTestResult] = useState(null)

  const providers = data?.data || []
  const enabledCount = providers.filter((provider) => provider.enabled).length

  const delM = useMutation({
    mutationFn: (id) => del(`/admin/providers/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['providers'] })
  })
  const toggleM = useMutation({
    mutationFn: ({ id, enabled }) => put(`/admin/providers/${id}`, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['providers'] })
  })
  const testM = useMutation({
    mutationFn: (id) => post(`/admin/providers/${id}/test`),
    onSuccess: (result) => setTestResult({ ok: true, ...result }),
    onError: (e) => setTestResult({ ok: false, error: e.message })
  })

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <PageHeader
          eyebrow="Providers"
          title="Provider 配置"
          desc="管理 upstream API 端点，控制启用状态、默认 Provider 与模型预览。"
        />
        <button
          onClick={() => {
            setEdit(null)
            setShow(true)
          }}
          className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg bg-black px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-slate-800"
        >
          <Plus size={16} />
          新增 Provider
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Stat label="Provider 总数" value={providers.length} />
        <Stat label="启用中" value={enabledCount} tone="emerald" />
        <Stat label="默认 Provider" value={providers.find((provider) => provider.is_default)?.name || '-'} tone="amber" />
      </div>

      <div className="hidden overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm md:block">
        <div className="overflow-x-auto">
          <div className="min-w-[930px]">
        <div className="grid grid-cols-[220px_140px_minmax(240px,1fr)_90px_90px_150px] gap-4 border-b border-slate-200 bg-slate-50 px-5 py-3 text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
          <div>名称</div>
          <div>格式</div>
          <div>Base URL</div>
          <div>启用</div>
          <div>默认</div>
          <div className="text-right">操作</div>
        </div>

        {isLoading && <div className="px-5 py-10 text-center text-sm text-slate-400">加载中...</div>}
        {!isLoading && providers.length === 0 && (
          <div className="px-5 py-12 text-center">
            <Server className="mx-auto text-slate-600" size={28} />
            <p className="mt-3 text-sm text-slate-400">还没有 Provider，先新增一个 upstream API 端点。</p>
          </div>
        )}

        {providers.map((provider) => (
          <div key={provider.id} className="grid grid-cols-[220px_140px_minmax(240px,1fr)_90px_90px_150px] items-center gap-4 border-b border-slate-200 px-5 py-4 text-sm last:border-b-0">
            <div className="flex min-w-0 items-center gap-3">
              <span className={provider.enabled ? 'h-2 w-2 rounded-full bg-emerald-500' : 'h-2 w-2 rounded-full bg-slate-300'} />
              <span className="truncate font-medium text-slate-950">{provider.name}</span>
            </div>
            <div>
              <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 font-mono text-xs text-slate-600">
                {formatLabel[provider.format] || provider.format}
              </span>
            </div>
            <div className="truncate font-mono text-xs text-slate-400">{provider.base_url}</div>
            <div>
              <button
                onClick={() => toggleM.mutate({ id: provider.id, enabled: !provider.enabled })}
                className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
                  provider.enabled
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                    : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50 hover:text-slate-950'
                }`}
              >
                {provider.enabled ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
                {provider.enabled ? '启用' : '停用'}
              </button>
            </div>
            <div className="text-sm text-slate-500">{provider.is_default ? <span className="text-amber-700">默认</span> : '-'}</div>
            <div className="flex justify-end gap-1.5">
              <IconButton title="测试连接" onClick={() => testM.mutate(provider.id)} icon={Play} />
              <IconButton
                title="编辑"
                onClick={() => {
                  setEdit(provider)
                  setShow(true)
                }}
                icon={Pencil}
              />
              <IconButton
                title="删除"
                danger
                onClick={() => {
                  if (confirm('删除该 Provider？相关映射会失效。')) delM.mutate(provider.id)
                }}
                icon={Trash2}
              />
            </div>
          </div>
        ))}
          </div>
        </div>
      </div>

      <div className="grid gap-3 md:hidden">
        {isLoading && <div className="rounded-lg border border-slate-200 bg-white px-4 py-10 text-center text-sm text-slate-500">加载中...</div>}
        {!isLoading && providers.length === 0 && (
          <div className="rounded-lg border border-slate-200 bg-white px-4 py-10 text-center">
            <Server className="mx-auto text-slate-400" size={28} />
            <p className="mt-3 text-sm text-slate-500">还没有 Provider，先新增一个 upstream API 端点。</p>
          </div>
        )}
        {providers.map((provider) => (
          <div key={provider.id} className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <span className={provider.enabled ? 'h-2 w-2 rounded-full bg-emerald-500' : 'h-2 w-2 rounded-full bg-slate-300'} />
                  <span className="truncate font-medium text-slate-950">{provider.name}</span>
                </div>
                <div className="mt-2 truncate font-mono text-xs text-slate-500">{provider.base_url}</div>
              </div>
              <span className="shrink-0 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 font-mono text-xs text-slate-600">
                {formatLabel[provider.format] || provider.format}
              </span>
            </div>
            <div className="mt-4 flex items-center justify-between gap-3">
              <button
                onClick={() => toggleM.mutate({ id: provider.id, enabled: !provider.enabled })}
                className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
                  provider.enabled
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                    : 'border-slate-200 bg-white text-slate-500'
                }`}
              >
                {provider.enabled ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
                {provider.enabled ? '启用' : '停用'}
              </button>
              <div className="flex gap-1.5">
                <IconButton title="测试连接" onClick={() => testM.mutate(provider.id)} icon={Play} />
                <IconButton title="编辑" onClick={() => { setEdit(provider); setShow(true) }} icon={Pencil} />
                <IconButton
                  title="删除"
                  danger
                  onClick={() => {
                    if (confirm('删除该 Provider？相关映射会失效。')) delM.mutate(provider.id)
                  }}
                  icon={Trash2}
                />
              </div>
            </div>
          </div>
        ))}
      </div>

      {testResult && (
        <div className={`rounded-lg border px-4 py-3 text-sm ${
          testResult.ok
            ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
            : 'border-red-200 bg-red-50 text-red-700'
        }`}>
          {testResult.ok
            ? `连接成功，发现 ${testResult.models} 个 model${testResult.latency_ms != null ? `，耗时 ${testResult.latency_ms}ms` : ''}`
            : `连接失败：${testResult.error}`}
        </div>
      )}

      {show && <ProviderForm provider={edit} onClose={() => setShow(false)} />}
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

const Stat = ({ label, value, tone = 'cyan' }) => {
  const color = tone === 'emerald' ? 'text-emerald-700' : tone === 'amber' ? 'text-amber-700' : 'text-blue-700'
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="text-xs font-medium uppercase tracking-[0.14em] text-slate-500">{label}</div>
      <div className={`mt-2 truncate text-2xl font-semibold ${color}`}>{value}</div>
    </div>
  )
}

const IconButton = ({ title, onClick, icon: Icon, danger }) => (
  <button
    type="button"
    onClick={onClick}
    title={title}
    className={`inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg border border-slate-200 bg-white transition-colors hover:bg-slate-50 ${
      danger ? 'text-red-600 hover:border-red-200' : 'text-slate-600 hover:border-blue-200'
    }`}
  >
    <Icon size={14} />
  </button>
)
