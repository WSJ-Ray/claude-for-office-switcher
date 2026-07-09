import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Pencil,
  Plus,
  RefreshCw,
  Trash2
} from 'lucide-react'
import { get, post, put, del } from '../lib/api'

const CLIENT_MODELS = [
  { id: 'claude-sonnet-4-5-20250929', label: 'Sonnet' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku' },
  { id: 'claude-opus-4-5-20250929', label: 'Opus' },
]
const GROUP_ORDER = ['sonnet', 'haiku', 'opus']

const familyOf = (clientModel = '') => {
  const model = String(clientModel).toLowerCase()
  if (model.includes('sonnet')) return 'sonnet'
  if (model.includes('haiku')) return 'haiku'
  if (model.includes('opus')) return 'opus'
  return 'other'
}

const modelForFamily = (family) => CLIENT_MODELS.find((model) => model.id.includes(family)) || CLIENT_MODELS[0]

export default function Mappings() {
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['mappings'], queryFn: () => get('/admin/mappings') })
  const { data: provs } = useQuery({ queryKey: ['providers'], queryFn: () => get('/admin/providers') })
  const [open, setOpen] = useState(false)
  const [collapsed, setCollapsed] = useState({})
  const [form, setForm] = useState({ id: null, provider_id: 0, client_model: CLIENT_MODELS[0].id, upstream_model: '' })
  const [err, setErr] = useState(null)
  const [models, setModels] = useState(null)
  const [loadingModels, setLoadingModels] = useState(false)

  const providers = provs?.data || []

  const saveM = useMutation({
    mutationFn: (payload) => (payload.id ? put(`/admin/mappings/${payload.id}`, payload) : post('/admin/mappings', payload)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['mappings'] })
      setOpen(false)
    },
    onError: (e) => setErr(e.message)
  })
  const delM = useMutation({
    mutationFn: (id) => del(`/admin/mappings/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mappings'] })
  })
  const toggleM = useMutation({
    mutationFn: ({ id, enabled }) => put(`/admin/mappings/${id}`, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mappings'] })
  })
  const swapM = useMutation({
    mutationFn: async ({ a, b }) => {
      await put(`/admin/mappings/${a.id}`, { priority: b.priority })
      await put(`/admin/mappings/${b.id}`, { priority: a.priority })
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mappings'] })
  })

  const groups = useMemo(() => {
    const output = Object.fromEntries(GROUP_ORDER.map((family) => [family, []]))
    for (const mapping of data?.data || []) {
      const family = familyOf(mapping.client_model)
      if (output[family]) output[family].push(mapping)
    }
    for (const family of GROUP_ORDER) {
      output[family].sort((a, b) => (a.priority - b.priority) || (a.id - b.id))
    }
    return output
  }, [data])

  const fetchModels = async (providerId) => {
    if (!providerId) return
    setLoadingModels(true)
    setModels(null)
    try {
      const result = await get(`/admin/providers/${providerId}/models`)
      setModels(result)
    } catch (e) {
      setModels({ ok: false, error: e.message, models: [] })
    } finally {
      setLoadingModels(false)
    }
  }

  const startNew = (clientModel = CLIENT_MODELS[0].id) => {
    const providerId = providers[0]?.id || 0
    setForm({ id: null, provider_id: providerId, client_model: clientModel, upstream_model: '' })
    setErr(null)
    setModels(null)
    setOpen(true)
    if (providerId) fetchModels(providerId)
  }

  const startEdit = (mapping) => {
    setForm({
      id: mapping.id,
      provider_id: mapping.provider_id,
      client_model: mapping.client_model,
      upstream_model: mapping.upstream_model
    })
    setErr(null)
    setModels(null)
    setOpen(true)
    fetchModels(mapping.provider_id)
  }

  const moveRow = (rows, index, dir) => {
    const nextIndex = index + dir
    if (nextIndex < 0 || nextIndex >= rows.length) return
    const a = rows[index]
    const b = rows[nextIndex]
    swapM.mutate({ a, b })
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <PageHeader
          eyebrow="Routing"
          title="模型映射"
          desc="把 Claude Office 客户端 model 映射到 upstream model，同组内按顺序 fallback。"
        />
        <button
          onClick={() => startNew()}
          disabled={providers.length === 0}
          className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg bg-black px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Plus size={16} />
          新增映射
        </button>
      </div>

      {providers.length === 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          需要先配置至少一个 Provider，才能新增模型映射。
        </div>
      )}

      <div className="space-y-4">
        {GROUP_ORDER.map((family) => {
          const rows = groups[family]
          const isOpen = !collapsed[family]
          const clientModel = modelForFamily(family)
          return (
            <div key={family} className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
              <button
                onClick={() => setCollapsed((prev) => ({ ...prev, [family]: isOpen }))}
                className="flex w-full cursor-pointer items-center justify-between gap-4 border-b border-slate-200 bg-slate-50 px-5 py-4 text-left transition-colors hover:bg-slate-100"
              >
                <div className="flex min-w-0 items-center gap-3">
                  {isOpen ? <ChevronDown size={16} className="text-slate-500" /> : <ChevronRight size={16} className="text-slate-500" />}
                  <div>
                    <div className="font-semibold text-slate-950">{clientModel.label}</div>
                    <div className="mt-1 truncate font-mono text-xs text-slate-500">{clientModel.id}</div>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-500">
                    {rows.length} 条候选
                  </span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      startNew(clientModel.id)
                    }}
                    disabled={providers.length === 0}
                    className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:border-blue-200 hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Plus size={13} />
                    添加
                  </button>
                </div>
              </button>

              {isOpen && (
                <>
                  <div className="hidden overflow-x-auto md:block">
                    <div className="min-w-[760px]">
                      <div className="grid grid-cols-[60px_160px_minmax(260px,1fr)_110px_130px] gap-4 px-5 py-3 text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
                        <div>顺序</div>
                        <div>Provider</div>
                        <div>upstream model</div>
                        <div>状态</div>
                        <div className="text-right">操作</div>
                      </div>
                      {rows.length === 0 && <div className="border-t border-slate-200 px-5 py-8 text-center text-sm text-slate-500">暂无候选映射</div>}
                      {rows.map((mapping, index) => (
                        <div key={mapping.id} className="grid grid-cols-[60px_160px_minmax(260px,1fr)_110px_130px] items-center gap-4 border-t border-slate-200 px-5 py-3 text-sm">
                          <div className="flex items-center gap-1">
                            <button onClick={() => moveRow(rows, index, -1)} disabled={index === 0} className="rounded-md p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-950 disabled:opacity-30" title="上移">
                              <ArrowUp size={14} />
                            </button>
                            <button onClick={() => moveRow(rows, index, 1)} disabled={index === rows.length - 1} className="rounded-md p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-950 disabled:opacity-30" title="下移">
                              <ArrowDown size={14} />
                            </button>
                          </div>
                          <div className="flex min-w-0 items-center gap-2">
                            <span className={mapping.enabled ? 'h-2 w-2 rounded-full bg-emerald-500' : 'h-2 w-2 rounded-full bg-slate-300'} />
                            <span className="truncate text-slate-950">{mapping.provider_name}</span>
                          </div>
                          <div className="flex min-w-0 items-center gap-2 font-mono text-xs text-slate-600">
                            <span className="shrink-0 text-slate-400">#{index + 1}</span>
                            <ArrowRight size={13} className="shrink-0 text-slate-400" />
                            <span className="truncate">{mapping.upstream_model}</span>
                          </div>
                          <StatusToggle mapping={mapping} toggleM={toggleM} />
                          <div className="flex justify-end gap-1.5">
                            <IconButton title="编辑" onClick={() => startEdit(mapping)} icon={Pencil} />
                            <IconButton
                              title="删除"
                              danger
                              onClick={() => {
                                if (confirm('删除该映射候选？')) delM.mutate(mapping.id)
                              }}
                              icon={Trash2}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="grid gap-3 p-4 md:hidden">
                    {rows.length === 0 && <div className="rounded-lg border border-dashed border-slate-200 px-4 py-8 text-center text-sm text-slate-500">暂无候选映射</div>}
                    {rows.map((mapping, index) => (
                      <div key={mapping.id} className="rounded-lg border border-slate-200 bg-white p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className={mapping.enabled ? 'h-2 w-2 rounded-full bg-emerald-500' : 'h-2 w-2 rounded-full bg-slate-300'} />
                              <span className="truncate font-medium text-slate-950">{mapping.provider_name}</span>
                            </div>
                            <div className="mt-2 truncate font-mono text-xs text-slate-600">{mapping.upstream_model}</div>
                          </div>
                          <StatusToggle mapping={mapping} toggleM={toggleM} />
                        </div>
                        <div className="mt-3 flex items-center justify-between">
                          <div className="flex items-center gap-1">
                            <button onClick={() => moveRow(rows, index, -1)} disabled={index === 0} className="rounded-md p-1 text-slate-500 hover:bg-slate-100 disabled:opacity-30" title="上移">
                              <ArrowUp size={14} />
                            </button>
                            <button onClick={() => moveRow(rows, index, 1)} disabled={index === rows.length - 1} className="rounded-md p-1 text-slate-500 hover:bg-slate-100 disabled:opacity-30" title="下移">
                              <ArrowDown size={14} />
                            </button>
                            <span className="ml-1 font-mono text-xs text-slate-500">#{index + 1}</span>
                          </div>
                          <div className="flex gap-1.5">
                            <IconButton title="编辑" onClick={() => startEdit(mapping)} icon={Pencil} />
                            <IconButton title="删除" danger onClick={() => { if (confirm('删除该映射候选？')) delM.mutate(mapping.id) }} icon={Trash2} />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )
        })}
      </div>

      {open && (
        <MappingDialog
          form={form}
          setForm={setForm}
          providers={providers}
          models={models}
          loadingModels={loadingModels}
          err={err}
          onClose={() => setOpen(false)}
          onProviderChange={(providerId) => {
            setForm((prev) => ({ ...prev, provider_id: providerId }))
            fetchModels(providerId)
          }}
          onFetchModels={() => fetchModels(form.provider_id)}
          onSave={() => saveM.mutate({ ...form, enabled: true })}
          isSaving={saveM.isPending}
        />
      )}
    </div>
  )
}

const StatusToggle = ({ mapping, toggleM }) => (
  <button
    onClick={() => toggleM.mutate({ id: mapping.id, enabled: !mapping.enabled })}
    className={`w-fit rounded-full border px-2.5 py-1 text-xs font-medium ${
      mapping.enabled
        ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
        : 'border-slate-200 bg-white text-slate-500'
    }`}
  >
    {mapping.enabled ? '已启用' : '已停用'}
  </button>
)

const MappingDialog = ({ form, setForm, providers, models, loadingModels, err, onClose, onProviderChange, onFetchModels, onSave, isSaving }) => (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 py-6" onClick={onClose}>
    <div className="w-full max-w-2xl rounded-lg border border-slate-200 bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
      <div className="border-b border-slate-200 px-6 py-5">
        <h2 className="text-xl font-semibold text-slate-950">{form.id ? '编辑映射' : '新增映射'}</h2>
        <p className="mt-1 text-sm text-slate-500">新增候选会加入对应客户端 model 的 fallback 队列。</p>
      </div>
      <div className="space-y-5 px-6 py-6">
        <div>
          <Label>客户端 model</Label>
          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            {CLIENT_MODELS.map((model) => {
              const active = form.client_model === model.id
              return (
                <button
                  key={model.id}
                  type="button"
                  onClick={() => setForm((prev) => ({ ...prev, client_model: model.id }))}
                  className={`rounded-lg border p-3 text-left transition-colors ${active ? 'border-blue-200 bg-blue-50' : 'border-slate-200 bg-white hover:bg-slate-50'}`}
                >
                  <div className="text-sm font-semibold text-slate-950">{model.label}</div>
                  <div className="mt-1 truncate font-mono text-[11px] text-slate-500">{model.id}</div>
                </button>
              )
            })}
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <label>
            <Label>Provider</Label>
            <select
              value={form.provider_id}
              onChange={(e) => onProviderChange(+e.target.value)}
              className="mt-2 w-full rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-950 outline-none focus:border-blue-500"
            >
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>{provider.name}</option>
              ))}
            </select>
          </label>
          <label>
            <div className="flex items-center justify-between">
              <Label>upstream model</Label>
              <button
                type="button"
                onClick={onFetchModels}
                disabled={loadingModels || !form.provider_id}
                className="inline-flex items-center gap-1 text-xs text-blue-700 disabled:opacity-50"
              >
                <RefreshCw size={12} className={loadingModels ? 'animate-spin' : ''} />
                {loadingModels ? '获取中' : '刷新'}
              </button>
            </div>
            <input
              value={form.upstream_model}
              onChange={(e) => setForm((prev) => ({ ...prev, upstream_model: e.target.value }))}
              placeholder="deepseek-chat"
              className="mt-2 w-full rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 font-mono text-sm text-slate-950 outline-none placeholder:text-slate-400 focus:border-blue-500"
            />
          </label>
        </div>

        {models && (
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            {models.ok ? (
              <div className="flex flex-wrap gap-2">
                {models.models.length === 0 && <span className="text-xs text-slate-500">上游返回 0 个 model，可手动填写。</span>}
                {models.models.map((model) => (
                  <button
                    key={model}
                    type="button"
                    onClick={() => setForm((prev) => ({ ...prev, upstream_model: model }))}
                    className={`rounded-md border px-2.5 py-1 font-mono text-xs ${form.upstream_model === model ? 'border-blue-200 bg-blue-50 text-blue-700' : 'border-slate-200 bg-white text-slate-600 hover:border-blue-200'}`}
                  >
                    {model}
                  </button>
                ))}
              </div>
            ) : (
              <div className="text-sm text-red-700">获取失败：{models.error}</div>
            )}
          </div>
        )}

        {err && <div className="text-sm text-red-700">{err}</div>}
      </div>
      <div className="flex justify-end gap-2 border-t border-slate-200 px-6 py-4">
        <button onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-950">取消</button>
        <button
          onClick={onSave}
          disabled={!form.provider_id || !form.client_model || !form.upstream_model || isSaving}
          className="rounded-lg bg-black px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSaving ? '保存中...' : '保存'}
        </button>
      </div>
    </div>
  </div>
)

const PageHeader = ({ eyebrow, title, desc }) => (
  <div>
    <p className="text-sm font-semibold uppercase tracking-[0.16em] text-blue-700">{eyebrow}</p>
    <h1 className="mt-2 text-3xl font-semibold text-slate-950">{title}</h1>
    <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">{desc}</p>
  </div>
)

const Label = ({ children }) => (
  <div className="text-xs font-medium uppercase tracking-[0.14em] text-slate-500">{children}</div>
)

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
