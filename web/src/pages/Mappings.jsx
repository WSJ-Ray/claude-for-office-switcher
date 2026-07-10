import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, CircleAlert, Eye, GripVertical, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { del, get, post, put } from '../lib/api'
import { Dialog, IconButton, InlineNotice, Spinner } from '../components/ui'
import { moveItem, moveTarget } from '../lib/reorder'

const CLIENT_MODELS = [
  { id: 'claude-sonnet-4-5-20250929', label: 'Sonnet' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku' },
  { id: 'claude-opus-4-5-20250929', label: 'Opus' }
]

const family = (model = '') => ['sonnet', 'haiku', 'opus'].find((name) => model.toLowerCase().includes(name)) || 'other'

export default function Mappings() {
  const queryClient = useQueryClient()
  const mappingsQuery = useQuery({ queryKey: ['mappings'], queryFn: () => get('/admin/mappings') })
  const providersQuery = useQuery({ queryKey: ['providers'], queryFn: () => get('/admin/providers') })
  const [form, setForm] = useState(null)
  const [preflightModel, setPreflightModel] = useState(null)
  const [actionError, setActionError] = useState(null)
  const providers = providersQuery.data?.data || []
  const mappings = mappingsQuery.data?.data || []

  const grouped = useMemo(() => {
    const groups = new Map(CLIENT_MODELS.map((model) => [model.id, []]))
    mappings.forEach((mapping) => {
      if (!groups.has(mapping.client_model)) groups.set(mapping.client_model, [])
      groups.get(mapping.client_model).push(mapping)
    })
    return [...groups.entries()].map(([clientModel, rows]) => ({
      clientModel,
      label: CLIENT_MODELS.find((model) => model.id === clientModel)?.label || family(clientModel),
      rows: rows.sort((a, b) => a.priority - b.priority || a.id - b.id)
    }))
  }, [mappings])

  const invalidateRoutes = () => {
    queryClient.invalidateQueries({ queryKey: ['mappings'] })
    queryClient.invalidateQueries({ queryKey: ['route-preflight'] })
  }
  const saveMapping = useMutation({
    mutationFn: (payload) => payload.id
      ? put(`/admin/mappings/${payload.id}`, payload)
      : post('/admin/mappings', payload),
    onSuccess: () => { invalidateRoutes(); setForm(null) },
    onError: (error) => setActionError(error.message || '保存映射失败。')
  })
  const reorderMappings = useMutation({
    mutationFn: ({ clientModel, mappingIds }) => put('/admin/mappings/reorder', { client_model: clientModel, mapping_ids: mappingIds }),
    onSuccess: invalidateRoutes,
    onError: (error) => setActionError(error.message || '更新优先级失败。')
  })
  const mutateMapping = useMutation({
    mutationFn: ({ id, payload }) => put(`/admin/mappings/${id}`, payload),
    onSuccess: invalidateRoutes,
    onError: (error) => setActionError(error.message || '更新映射失败。')
  })
  const deleteMapping = useMutation({
    mutationFn: (id) => del(`/admin/mappings/${id}`),
    onSuccess: invalidateRoutes,
    onError: (error) => setActionError(error.message || '删除映射失败。')
  })
  const preflight = useQuery({
    queryKey: ['route-preflight', preflightModel],
    queryFn: () => get(`/admin/routes/preflight?client_model=${encodeURIComponent(preflightModel)}`),
    enabled: Boolean(preflightModel),
    retry: false
  })

  const openNew = (clientModel = CLIENT_MODELS[0].id) => {
    setActionError(null)
    setForm({ id: null, client_model: clientModel, provider_id: providers[0]?.id || '', upstream_model: '', enabled: true })
  }
  const reorder = (clientModel, orderedRows) => {
    reorderMappings.mutate({ clientModel, mappingIds: orderedRows.map((row) => row.id) })
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="text-sm font-semibold text-cyan-700">ROUTING</p>
          <h1 className="mt-1 text-2xl font-semibold text-slate-950">模型映射</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">每个客户端模型拥有独立的故障转移队列。队列第一项优先，只有可路由的 Provider 才会被实际使用。</p>
        </div>
        <button type="button" onClick={() => openNew()} disabled={!providers.length} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-slate-950 px-4 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"><Plus size={17} />新增映射</button>
      </header>

      {actionError && <InlineNotice tone="danger">{actionError}</InlineNotice>}
      {providersQuery.isError && <InlineNotice tone="danger">无法读取 Provider。请先确认管理令牌和服务状态。</InlineNotice>}
      {!providers.length && !providersQuery.isLoading && <InlineNotice tone="warning">先创建并启用至少一个 Provider，才能建立模型映射。</InlineNotice>}

      {mappingsQuery.isLoading ? <LoadingPanel /> : (
        <div className="space-y-4">
          {grouped.map(({ clientModel, label, rows }) => (
            <section key={clientModel} className="overflow-hidden rounded-lg border border-slate-200 bg-white">
              <div className="flex flex-col justify-between gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3 sm:flex-row sm:items-center">
                <div className="min-w-0"><h2 className="text-sm font-semibold text-slate-950">{label}</h2><p className="mt-1 truncate font-mono text-xs text-slate-500">{clientModel}</p></div>
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => setPreflightModel(preflightModel === clientModel ? null : clientModel)} className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700 hover:border-cyan-300 hover:bg-cyan-50"><Eye size={15} />实际路由</button>
                  <button type="button" onClick={() => openNew(clientModel)} disabled={!providers.length} className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700 hover:border-cyan-300 hover:bg-cyan-50"><Plus size={15} />添加</button>
                </div>
              </div>
              {preflightModel === clientModel && <PreflightPanel query={preflight} />}
              {rows.length ? <MappingRows rows={rows} onReorder={(orderedRows) => reorder(clientModel, orderedRows)} pending={reorderMappings.isPending} onEdit={setForm} onToggle={(row) => mutateMapping.mutate({ id: row.id, payload: { enabled: !row.enabled } })} onDelete={(row) => { if (window.confirm(`删除 ${row.provider_name} 的映射？`)) deleteMapping.mutate(row.id) }} /> : <div className="px-4 py-9 text-center text-sm text-slate-500">尚未配置候选。没有可用映射时，服务会尝试已启用的默认 Provider。</div>}
            </section>
          ))}
        </div>
      )}
      {form && <MappingDialog form={form} providers={providers} onClose={() => setForm(null)} onSave={(payload) => saveMapping.mutate(payload)} saving={saveMapping.isPending} />}
    </div>
  )
}

function MappingRows({ rows, onReorder, pending, onEdit, onToggle, onDelete }) {
  const [draggedIndex, setDraggedIndex] = useState(null)
  const [dropIndex, setDropIndex] = useState(null)
  const [keyboardIndex, setKeyboardIndex] = useState(null)

  const finishDrag = () => {
    setDraggedIndex(null)
    setDropIndex(null)
  }
  const handleDrop = (event, index) => {
    event.preventDefault()
    if (!pending && draggedIndex !== null && draggedIndex !== index) onReorder(moveItem(rows, draggedIndex, index))
    finishDrag()
  }
  const handleKeyDown = (event, index) => {
    if (event.key === 'Escape') {
      setKeyboardIndex(null)
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      setKeyboardIndex((current) => current === index ? null : index)
      return
    }
    if (keyboardIndex !== index || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
    event.preventDefault()
    if (pending) return
    const target = moveTarget(index, event.key === 'ArrowUp' ? -1 : 1, rows.length)
    if (target !== index) onReorder(moveItem(rows, index, target))
    setKeyboardIndex(null)
  }

  return <div className="divide-y divide-slate-100">{rows.map((row, index) => <div key={row.id} onDragOver={(event) => { if (draggedIndex !== null && !pending) { event.preventDefault(); setDropIndex(index) } }} onDrop={(event) => handleDrop(event, index)} className={`flex flex-col gap-3 px-4 py-3 transition-colors sm:flex-row sm:items-center ${draggedIndex === index ? 'opacity-40' : ''} ${dropIndex === index && draggedIndex !== index ? 'bg-cyan-50 shadow-[inset_0_2px_0_0_rgb(6_182_212)]' : ''}`}><div className="flex min-w-0 flex-1 items-center gap-3"><button type="button" draggable={!pending} aria-label={`拖拽 ${row.provider_name} 以调整故障转移顺序`} aria-grabbed={keyboardIndex === index} onDragStart={(event) => { event.dataTransfer.effectAllowed = 'move'; setDraggedIndex(index) }} onDragEnd={finishDrag} onKeyDown={(event) => handleKeyDown(event, index)} disabled={pending} className="flex h-11 w-8 shrink-0 cursor-grab items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-600 disabled:cursor-not-allowed" title="拖拽调整顺序"><GripVertical size={18} /></button><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-100 font-mono text-xs text-slate-600">{index + 1}</span><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="font-medium text-slate-950">{row.provider_name}</span><RouteState row={row} /></div><p className="mt-1 truncate font-mono text-xs text-slate-500">{row.upstream_model}</p></div></div><div className="flex items-center justify-end gap-1"><IconButton label="编辑映射" onClick={() => onEdit({ ...row })}><Pencil size={16} /></IconButton><IconButton label={row.enabled ? '停用映射' : '启用映射'} onClick={() => onToggle(row)} className={row.enabled ? '' : 'text-amber-700'}><CircleAlert size={16} /></IconButton><IconButton label="删除映射" onClick={() => onDelete(row)} className="text-red-700 hover:border-red-300 hover:text-red-800"><Trash2 size={16} /></IconButton></div></div>)}</div>
}

function RouteState({ row }) {
  if (row.routable) return <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">可路由</span>
  const label = row.not_routable_reason === 'provider_disabled' ? 'Provider 已停用' : row.not_routable_reason === 'unsupported_provider_format' ? '格式不受运行时支持' : '映射已停用'
  return <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800">{label}</span>
}

function PreflightPanel({ query }) {
  if (query.isLoading) return <div className="border-b border-slate-200 px-4 py-3 text-sm text-slate-500"><Spinner className="mr-2 align-middle" />计算路由候选…</div>
  if (query.isError) return <div className="border-b border-slate-200 px-4 py-3"><InlineNotice tone="danger">无法读取路由预检：{query.error.message}</InlineNotice></div>
  const data = query.data
  if (!data) return null
  return <div className="border-b border-slate-200 bg-cyan-50/50 px-4 py-3"><p className="text-sm font-semibold text-slate-950">本次请求将依次尝试</p>{data.candidates?.length ? <ol className="mt-2 space-y-1.5">{data.candidates.map((item, index) => <li key={`${item.mapping_id || 'default'}-${item.provider_id}`} className="flex flex-wrap gap-x-2 text-sm text-slate-700"><span className="font-mono text-cyan-800">{index + 1}.</span><span>{item.provider_name}</span><span className="font-mono text-slate-500">{item.upstream_model}</span>{item.source === 'default' && <span className="text-xs text-amber-800">默认 Provider</span>}</li>)}</ol> : <p className="mt-1 text-sm text-red-700">没有可路由的映射或默认 Provider。</p>}{data.exclusions?.length ? <p className="mt-3 text-xs text-slate-600">已排除：{data.exclusions.map((item) => `${item.provider_name}（${item.reason}）`).join('，')}</p> : null}</div>
}

function MappingDialog({ form, providers, onClose, onSave, saving }) {
  const [value, setValue] = useState(form)
  const [models, setModels] = useState(null)
  const [loadingModels, setLoadingModels] = useState(false)
  const [error, setError] = useState(null)
  const available = providers.filter((provider) => provider.enabled)
  const selectedProvider = providers.find((provider) => provider.id === Number(value.provider_id))
  const fetchModels = async () => {
    if (!value.provider_id) return
    setLoadingModels(true); setModels(null)
    try { setModels(await get(`/admin/providers/${value.provider_id}/models`)) } catch (requestError) { setModels({ ok: false, error: requestError.message }) } finally { setLoadingModels(false) }
  }
  return <Dialog open onClose={onClose} ariaLabel={value.id ? '编辑模型映射' : '新增模型映射'} className="max-w-xl"><form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => { event.preventDefault(); if (!value.provider_id || !value.client_model || !value.upstream_model) { setError('请完整填写映射信息。'); return }; onSave({ ...value, provider_id: Number(value.provider_id) }) }}><div className="flex items-start justify-between border-b border-slate-200 px-5 py-4"><div><h2 className="text-lg font-semibold text-slate-950">{value.id ? '编辑模型映射' : '新增模型映射'}</h2><p className="mt-1 text-sm text-slate-500">将 Claude Office 模型加入上游故障转移队列。</p></div><IconButton label="关闭" onClick={onClose} className="border-0"><ChevronDown size={18} /></IconButton></div><div className="space-y-5 overflow-y-auto px-5 py-5"><label className="block"><Label>客户端 model</Label><select value={value.client_model} onChange={(event) => setValue((current) => ({ ...current, client_model: event.target.value }))} className="mt-1.5 min-h-11 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm">{CLIENT_MODELS.map((model) => <option key={model.id} value={model.id}>{model.label} - {model.id}</option>)}</select></label><label className="block"><Label>Provider</Label><select value={value.provider_id} onChange={(event) => { setValue((current) => ({ ...current, provider_id: event.target.value })); setModels(null) }} className="mt-1.5 min-h-11 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm">{available.map((provider) => <option key={provider.id} value={provider.id}>{provider.name} ({provider.format})</option>)}</select>{!available.length && <p className="mt-1 text-xs text-amber-700">没有启用的 Provider；请先到 Provider 页面启用一个端点。</p>}</label><label className="block"><span className="flex items-center justify-between"><Label>upstream model</Label><button type="button" onClick={fetchModels} disabled={!value.provider_id || loadingModels} className="inline-flex min-h-8 items-center gap-1 text-xs text-cyan-800 disabled:opacity-50"><RefreshCw size={13} className={loadingModels ? 'animate-spin' : ''} />读取列表</button></span><input data-autofocus value={value.upstream_model} onChange={(event) => setValue((current) => ({ ...current, upstream_model: event.target.value }))} placeholder="例如 deepseek-chat" className="mt-1.5 min-h-11 w-full rounded-lg border border-slate-200 px-3 font-mono text-sm" />{selectedProvider && <p className="mt-1 text-xs text-slate-500">{selectedProvider.name} 的模型列表仅用于辅助选择。</p>}</label>{models && (models.ok ? <div className="flex flex-wrap gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3">{models.models?.length ? models.models.slice(0, 20).map((model) => <button key={model} type="button" onClick={() => setValue((current) => ({ ...current, upstream_model: model }))} className={`rounded-md border px-2 py-1 font-mono text-xs ${value.upstream_model === model ? 'border-cyan-300 bg-cyan-50' : 'border-slate-200 bg-white'}`}>{model}</button>) : <span className="text-xs text-slate-500">上游未返回模型，可手动填写。</span>}</div> : <InlineNotice tone="danger">读取失败：{models.error}</InlineNotice>)}{error && <InlineNotice tone="danger">{error}</InlineNotice>}</div><div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-4"><button type="button" onClick={onClose} className="min-h-11 rounded-lg px-4 text-sm text-slate-600 hover:bg-slate-100">取消</button><button type="submit" disabled={saving || !available.length} className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-slate-950 px-4 text-sm font-semibold text-white disabled:opacity-50">{saving && <Spinner />}保存映射</button></div></form></Dialog>
}

function LoadingPanel() { return <div className="flex min-h-40 items-center justify-center rounded-lg border border-slate-200 bg-white text-sm text-slate-500"><Spinner className="mr-2" />加载映射…</div> }
function Label({ children }) { return <span className="text-xs font-medium text-slate-600">{children}</span> }
