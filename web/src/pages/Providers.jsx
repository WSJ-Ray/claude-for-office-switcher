import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, CircleOff, Pencil, Plus, Server, Trash2, XCircle } from 'lucide-react'
import { del, get, post, put } from '../lib/api'
import ProviderForm from '../components/ProviderForm'
import { IconButton, InlineNotice, Spinner } from '../components/ui'

export default function Providers() {
  const queryClient = useQueryClient()
  const providerQuery = useQuery({ queryKey: ['providers'], queryFn: () => get('/admin/providers') })
  const [editing, setEditing] = useState(undefined)
  const [testResult, setTestResult] = useState(null)
  const [error, setError] = useState(null)
  const providers = providerQuery.data?.data || []

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['providers'] })
    queryClient.invalidateQueries({ queryKey: ['mappings'] })
    queryClient.invalidateQueries({ queryKey: ['route-preflight'] })
  }
  const toggle = useMutation({ mutationFn: ({ id, enabled }) => put(`/admin/providers/${id}`, { enabled }), onSuccess: refresh, onError: (mutationError) => setError(mutationError.message) })
  const remove = useMutation({ mutationFn: (id) => del(`/admin/providers/${id}`), onSuccess: refresh, onError: (mutationError) => setError(mutationError.message) })
  const discover = useMutation({
    mutationFn: (id) => post(`/admin/providers/${id}/test`),
    onSuccess: (result) => setTestResult({ ok: true, ...result }),
    onError: (mutationError) => setTestResult({ ok: false, error: mutationError.message || '无法读取模型列表。' })
  })

  const enabled = providers.filter((provider) => provider.enabled).length
  const defaultProvider = providers.find((provider) => provider.is_default)
  return <div className="mx-auto max-w-7xl space-y-6">
    <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end"><div><p className="text-sm font-semibold text-cyan-700">PROVIDERS</p><h1 className="mt-1 text-2xl font-semibold text-slate-950">Provider 配置</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">管理上游 API 端点及其启用状态。模型映射决定各端点实际承担的请求。</p></div><button type="button" onClick={() => setEditing(null)} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-slate-950 px-4 text-sm font-semibold text-white hover:bg-slate-800"><Plus size={17} />新增 Provider</button></header>

    <div className="grid gap-3 sm:grid-cols-3"><Stat label="Provider 总数" value={providers.length} /><Stat label="已启用" value={enabled} tone="emerald" /><Stat label="默认 Provider" value={defaultProvider?.name || '未设置'} tone="amber" /></div>
    {error && <InlineNotice tone="danger">{error}</InlineNotice>}
    {testResult && <InlineNotice tone={testResult.ok ? 'success' : 'danger'}>{testResult.ok ? `模型发现成功：读取到 ${testResult.models} 个上游模型${testResult.cached ? '（缓存结果）' : ''}${testResult.latency_ms ? `，耗时 ${testResult.latency_ms}ms` : ''}。此操作不验证映射、消息转换或流式响应。` : `模型发现失败：${testResult.error}`}</InlineNotice>}
    {providerQuery.isLoading ? <Panel><Spinner className="mr-2" />加载 Provider…</Panel> : providerQuery.isError ? <InlineNotice tone="danger">无法读取 Provider。请检查管理令牌或后端服务。</InlineNotice> : !providers.length ? <Panel><Server size={26} className="mx-auto text-slate-400" /><p className="mt-3">还没有 Provider。添加一个上游端点后，再建立模型映射。</p></Panel> : <div className="grid gap-3 lg:grid-cols-2">{providers.map((provider) => <ProviderCard key={provider.id} provider={provider} discovering={discover.isPending} onDiscover={() => discover.mutate(provider.id)} onEdit={() => setEditing(provider)} onToggle={() => toggle.mutate({ id: provider.id, enabled: !provider.enabled })} onDelete={() => { if (window.confirm(`删除 ${provider.name}？关联映射将失效。`)) remove.mutate(provider.id) }} />)}</div>}
    {editing !== undefined && <ProviderForm provider={editing} onClose={() => setEditing(undefined)} />}
  </div>
}

function ProviderCard({ provider, discovering, onDiscover, onEdit, onToggle, onDelete }) {
  return <article className="rounded-lg border border-slate-200 bg-white p-4"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><div className="flex items-center gap-2"><span className={`h-2.5 w-2.5 rounded-full ${provider.enabled ? 'bg-emerald-500' : 'bg-slate-300'}`} /><h2 className="truncate font-semibold text-slate-950">{provider.name}</h2>{provider.is_default && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-800">默认</span>}</div><p className="mt-2 truncate font-mono text-xs text-slate-500">{provider.base_url}</p></div><span className="shrink-0 rounded-full border border-slate-200 bg-slate-50 px-2 py-1 font-mono text-xs text-slate-600">{formatName(provider.format)}</span></div><div className="mt-4 flex items-center justify-between gap-3 border-t border-slate-100 pt-3"><button type="button" role="switch" aria-checked={provider.enabled} onClick={onToggle} className={`inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium ${provider.enabled ? 'bg-emerald-50 text-emerald-800' : 'bg-slate-100 text-slate-600'}`}>{provider.enabled ? <CheckCircle2 size={16} /> : <CircleOff size={16} />}{provider.enabled ? '已启用' : '已停用'}</button><div className="flex gap-1"><IconButton label="读取模型列表" onClick={onDiscover} disabled={discovering}><Server size={16} /></IconButton><IconButton label="编辑 Provider" onClick={onEdit}><Pencil size={16} /></IconButton><IconButton label="删除 Provider" onClick={onDelete} className="text-red-700 hover:border-red-300 hover:text-red-800"><Trash2 size={16} /></IconButton></div></div></article>
}

function Stat({ label, value, tone = 'cyan' }) { const color = tone === 'emerald' ? 'text-emerald-700' : tone === 'amber' ? 'text-amber-700' : 'text-cyan-700'; return <div className="rounded-lg border border-slate-200 bg-white p-4"><p className="text-xs font-medium text-slate-500">{label}</p><p className={`mt-2 truncate text-xl font-semibold ${color}`}>{value}</p></div> }
function Panel({ children }) { return <div className="rounded-lg border border-slate-200 bg-white px-5 py-12 text-center text-sm text-slate-500">{children}</div> }
function formatName(format) { return ({ anthropic: 'Anthropic', openai_chat: 'OpenAI Chat', openai_responses: 'Responses', url_adaptive: 'Adaptive URL' })[format] || format }
