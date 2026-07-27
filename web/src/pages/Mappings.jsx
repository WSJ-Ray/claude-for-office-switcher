import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  CircleAlert,
  Eye,
  GripVertical,
  Pencil,
  Plus,
  RefreshCw,
  Route,
  Trash2,
  X
} from 'lucide-react'
import { del, get, post, put } from '../lib/api'
import {
  ConfirmDialog,
  Dialog,
  EmptyState,
  IconButton,
  InlineNotice,
  PageToolbar,
  Spinner,
  StatusBadge
} from '../components/ui'
import { moveItem, moveTarget } from '../lib/reorder'
import {
  groupMappings,
  KNOWN_CLIENT_MODELS,
  providersForMapping,
  routeReasonLabel
} from '../lib/mapping-view'

/** 管理模型映射、路由预检和故障转移顺序。 */
export default function Mappings() {
  const queryClient = useQueryClient()
  const mappingsQuery = useQuery({ queryKey: ['mappings'], queryFn: () => get('/admin/mappings') })
  const providersQuery = useQuery({ queryKey: ['providers'], queryFn: () => get('/admin/providers') })
  const [selectedModel, setSelectedModel] = useState(KNOWN_CLIENT_MODELS[0].id)
  const [form, setForm] = useState(null)
  const [showPreflight, setShowPreflight] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [actionError, setActionError] = useState(null)

  const providers = providersQuery.data?.data || []
  const mappings = mappingsQuery.data?.data || []
  const groups = useMemo(() => groupMappings(mappings), [mappings])
  const activeGroup = groups.find((group) => group.clientModel === selectedModel) || groups[0]
  const activeModel = activeGroup?.clientModel || KNOWN_CLIENT_MODELS[0].id

  /** 刷新映射列表和路由预检缓存。 */
  const invalidateRoutes = () => {
    queryClient.invalidateQueries({ queryKey: ['mappings'] })
    queryClient.invalidateQueries({ queryKey: ['route-preflight'] })
  }

  const saveMapping = useMutation({
    mutationFn: (payload) => payload.id
      ? put(`/admin/mappings/${payload.id}`, payload)
      : post('/admin/mappings', payload),
    onSuccess: () => {
      invalidateRoutes()
      setForm(null)
    },
    onError: (error) => setActionError(error.message || '保存映射失败。')
  })
  const reorderMappings = useMutation({
    mutationFn: ({ clientModel, mappingIds }) => put('/admin/mappings/reorder', {
      client_model: clientModel,
      mapping_ids: mappingIds
    }),
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
    onSuccess: () => {
      invalidateRoutes()
      setDeleteTarget(null)
    },
    onError: (error) => setActionError(error.message || '删除映射失败。')
  })
  const preflight = useQuery({
    queryKey: ['route-preflight', activeModel],
    queryFn: () => get(`/admin/routes/preflight?client_model=${encodeURIComponent(activeModel)}`),
    enabled: showPreflight && Boolean(activeModel),
    retry: false
  })

  const openNew = () => {
    setActionError(null)
    const used = new Set((activeGroup?.rows || []).map((row) => row.provider_id))
    const firstProvider = providers.find((provider) => provider.enabled && !used.has(provider.id))
    setForm({
      id: null,
      client_model: activeModel,
      provider_id: firstProvider?.id || '',
      upstream_model: '',
      enabled: true
    })
  }

  const selectModel = (clientModel) => {
    setSelectedModel(clientModel)
    setShowPreflight(false)
    setActionError(null)
  }

  const reorder = (orderedRows) => {
    reorderMappings.mutate({
      clientModel: activeModel,
      mappingIds: orderedRows.map((row) => row.id)
    })
  }

  const loading = mappingsQuery.isLoading || providersQuery.isLoading
  const fatalError = mappingsQuery.isError || providersQuery.isError

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <PageToolbar
        title="模型映射"
        description="按客户端模型维护故障转移顺序与实际路由。"
        meta={`${mappings.length} 条映射 · ${providers.filter((provider) => provider.enabled).length} 个启用 Provider`}
        actions={(
          <button type="button" onClick={openNew} disabled={!providers.length || loading} className="desktop-button desktop-button-primary">
            <Plus size={14} aria-hidden="true" />
            新增映射
          </button>
        )}
      />

      {actionError ? <InlineNotice tone="danger">{actionError}</InlineNotice> : null}
      {!loading && !providers.length ? (
        <InlineNotice tone="warning">请先创建并启用 Provider，再建立模型映射。</InlineNotice>
      ) : null}

      {loading ? <MappingLoading /> : fatalError ? (
        <MappingError
          message={mappingsQuery.error?.message || providersQuery.error?.message}
          onRetry={() => {
            void mappingsQuery.refetch()
            void providersQuery.refetch()
          }}
        />
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[184px_minmax(0,1fr)] overflow-hidden rounded-md border border-[var(--border)] bg-[var(--surface)] xl:grid-cols-[220px_minmax(0,1fr)]">
          <aside className="min-h-0 overflow-y-auto border-r border-[var(--border)] bg-[var(--surface-subtle)]" aria-label="客户端模型">
            <div className="border-b border-[var(--border)] px-3 py-2 text-xs font-semibold text-[var(--text-secondary)]">
              客户端模型
            </div>
            <div className="p-1.5">
              {groups.map((group) => {
                const active = group.clientModel === activeModel
                return (
                  <button
                    key={group.clientModel}
                    type="button"
                    onClick={() => selectModel(group.clientModel)}
                    className={`mb-0.5 flex w-full items-center gap-2 rounded px-2 py-2 text-left transition-colors ${active ? 'bg-[var(--accent-soft)] text-[var(--accent-strong)]' : 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]'}`}
                  >
                    <Route size={14} aria-hidden="true" className="shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-semibold capitalize">{group.label}</span>
                      <span className="mt-0.5 block truncate font-mono text-[10px] opacity-75">{group.clientModel}</span>
                    </span>
                    <span className="font-mono text-[10px]">{group.routable}/{group.rows.length}</span>
                  </button>
                )
              })}
            </div>
          </aside>

          <section className="flex min-h-0 min-w-0 flex-col">
            <div className="flex min-h-12 items-center justify-between gap-3 border-b border-[var(--border)] px-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="truncate text-sm font-semibold text-[var(--text-primary)]">{activeGroup?.label}</h2>
                  <StatusBadge tone={activeGroup?.routable ? 'success' : 'warning'}>
                    {activeGroup?.routable ? `${activeGroup.routable} 个可路由` : '无可路由候选'}
                  </StatusBadge>
                </div>
                <p className="mt-0.5 truncate font-mono text-[10px] text-[var(--text-muted)]">{activeModel}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <button type="button" onClick={() => setShowPreflight((value) => !value)} className="desktop-button" aria-pressed={showPreflight}>
                  <Eye size={14} aria-hidden="true" />
                  实际路由
                </button>
                <button type="button" onClick={openNew} disabled={!providers.length} className="desktop-button">
                  <Plus size={14} aria-hidden="true" />
                  添加候选
                </button>
              </div>
            </div>

            {showPreflight ? <PreflightPanel query={preflight} /> : null}

            <div className="min-h-0 flex-1 overflow-auto">
              {activeGroup?.rows.length ? (
                <>
                  <div className="sticky top-0 z-10 grid h-8 grid-cols-[32px_minmax(120px,0.9fr)_minmax(180px,1.2fr)_92px_92px] items-center gap-2 border-b border-[var(--border)] bg-[var(--surface-subtle)] px-3 text-[10px] font-semibold text-[var(--text-muted)]">
                    <span aria-hidden="true" />
                    <span>Provider</span>
                    <span>Upstream model</span>
                    <span>路由状态</span>
                    <span className="text-right">操作</span>
                  </div>
                  <MappingRows
                    rows={activeGroup.rows}
                    onReorder={reorder}
                    pending={reorderMappings.isPending}
                    mutationPending={mutateMapping.isPending}
                    mutationId={mutateMapping.variables?.id}
                    onEdit={(row) => setForm({ ...row })}
                    onToggle={(row) => mutateMapping.mutate({ id: row.id, payload: { enabled: !row.enabled } })}
                    onDelete={setDeleteTarget}
                  />
                </>
              ) : (
                <EmptyState
                  icon={Route}
                  title="尚未配置候选"
                  description="添加 Provider 后，它会成为此客户端模型故障转移队列的一部分。"
                  action={<button type="button" onClick={openNew} disabled={!providers.length} className="desktop-button desktop-button-primary">添加候选</button>}
                  className="h-full border-0"
                />
              )}
            </div>
          </section>
        </div>
      )}

      {form ? (
        <MappingDialog
          form={form}
          mappings={mappings}
          providers={providers}
          clientModels={groups.map((group) => group.clientModel)}
          onClose={() => setForm(null)}
          onSave={(payload) => saveMapping.mutate(payload)}
          saving={saveMapping.isPending}
        />
      ) : null}

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && deleteMapping.mutate(deleteTarget.id)}
        title="删除模型映射"
        description={deleteTarget ? `将从 ${activeGroup?.label} 队列中删除 ${deleteTarget.provider_name}。后续候选优先级会自动连续排列。` : ''}
        confirmLabel="删除映射"
        pending={deleteMapping.isPending}
      />
    </div>
  )
}

/** 渲染支持拖拽和键盘重排的映射表格。 */
function MappingRows({ rows, onReorder, pending, mutationPending, mutationId, onEdit, onToggle, onDelete }) {
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
    if (keyboardIndex !== index || !['ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault()
    if (pending) return
    const target = moveTarget(index, event.key === 'ArrowUp' ? -1 : 1, rows.length)
    if (target !== index) onReorder(moveItem(rows, index, target))
    setKeyboardIndex(null)
  }

  return (
    <div className="divide-y divide-[var(--border-subtle)]">
      {rows.map((row, index) => {
        const rowPending = mutationPending && mutationId === row.id
        return (
          <div
            key={row.id}
            onDragOver={(event) => {
              if (draggedIndex !== null && !pending) {
                event.preventDefault()
                setDropIndex(index)
              }
            }}
            onDrop={(event) => handleDrop(event, index)}
            className={`grid min-h-10 grid-cols-[32px_minmax(120px,0.9fr)_minmax(180px,1.2fr)_92px_92px] items-center gap-2 px-3 text-xs transition-colors ${draggedIndex === index ? 'opacity-40' : ''} ${dropIndex === index && draggedIndex !== index ? 'bg-[var(--accent-soft)]' : 'hover:bg-[var(--surface-hover)]'}`}
          >
            <button
              type="button"
              draggable={!pending}
              aria-label={`拖拽 ${row.provider_name} 以调整故障转移顺序`}
              aria-grabbed={keyboardIndex === index}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move'
                setDraggedIndex(index)
              }}
              onDragEnd={finishDrag}
              onKeyDown={(event) => handleKeyDown(event, index)}
              disabled={pending}
              className="flex h-7 w-7 cursor-grab items-center justify-center rounded text-[var(--text-muted)] hover:bg-[var(--surface-active)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed"
              title="拖拽或按 Enter 后使用方向键调整顺序"
            >
              {pending ? <Spinner className="h-3.5 w-3.5" /> : <GripVertical size={14} />}
            </button>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-[var(--surface-active)] font-mono text-[10px] text-[var(--text-muted)]">{index + 1}</span>
                <span className="truncate font-semibold text-[var(--text-primary)]">{row.provider_name}</span>
              </div>
            </div>
            <div className="min-w-0">
              <div className="truncate font-mono text-[11px] text-[var(--text-secondary)]" title={row.upstream_model}>{row.upstream_model}</div>
              <div className="mt-0.5 truncate text-[10px] text-[var(--text-muted)]">{row.provider_format}</div>
            </div>
            <RouteState row={row} />
            <div className="flex justify-end gap-0.5">
              {rowPending ? <Spinner className="mx-2 h-3.5 w-3.5 text-[var(--accent)]" /> : (
                <>
                  <IconButton size="sm" label="编辑映射" onClick={() => onEdit(row)}><Pencil size={13} /></IconButton>
                  <IconButton size="sm" label={row.enabled ? '停用映射' : '启用映射'} onClick={() => onToggle(row)} tone={row.enabled ? 'neutral' : 'warning'}><CircleAlert size={13} /></IconButton>
                  <IconButton size="sm" label="删除映射" onClick={() => onDelete(row)} tone="danger"><Trash2 size={13} /></IconButton>
                </>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function RouteState({ row }) {
  if (row.routable) return <StatusBadge tone="success">可路由</StatusBadge>
  return <StatusBadge tone="warning" title={routeReasonLabel(row.not_routable_reason)}>{routeReasonLabel(row.not_routable_reason)}</StatusBadge>
}

function PreflightPanel({ query }) {
  if (query.isLoading) {
    return <div className="flex min-h-10 items-center border-b border-[var(--border)] bg-[var(--accent-soft)] px-3 text-xs text-[var(--text-secondary)]"><Spinner className="mr-2 h-3.5 w-3.5" />计算路由候选…</div>
  }
  if (query.isError) {
    return <div className="border-b border-[var(--border)] p-2"><InlineNotice tone="danger">无法读取路由预检：{query.error.message}</InlineNotice></div>
  }
  const data = query.data
  if (!data) return null
  return (
    <div className="border-b border-[var(--border)] bg-[var(--accent-soft)] px-3 py-2.5">
      <div className="flex items-start gap-3">
        <Route size={15} className="mt-0.5 shrink-0 text-[var(--accent)]" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-[var(--text-primary)]">实际尝试顺序</p>
          {data.candidates?.length ? (
            <ol className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
              {data.candidates.map((item, index) => (
                <li key={`${item.mapping_id || 'default'}-${item.provider_id}`} className="flex min-w-0 items-center gap-1.5 text-xs text-[var(--text-secondary)]">
                  <span className="font-mono text-[var(--accent-strong)]">{index + 1}.</span>
                  <span className="font-semibold">{item.provider_name}</span>
                  <span className="max-w-48 truncate font-mono text-[10px] text-[var(--text-muted)]">{item.upstream_model}</span>
                  {item.source === 'default' ? <StatusBadge tone="warning">默认回退</StatusBadge> : null}
                </li>
              ))}
            </ol>
          ) : <p className="mt-1 text-xs text-[var(--danger)]">没有可路由的映射或默认 Provider。</p>}
          {data.exclusions?.length ? (
            <p className="mt-1.5 text-[10px] text-[var(--text-muted)]">已排除：{data.exclusions.map((item) => `${item.provider_name}（${routeReasonLabel(item.reason)}）`).join('，')}</p>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function MappingDialog({ form, mappings, providers, clientModels, onClose, onSave, saving }) {
  const [value, setValue] = useState(form)
  const [models, setModels] = useState(null)
  const [loadingModels, setLoadingModels] = useState(false)
  const [error, setError] = useState(null)
  const available = providersForMapping({ providers, mappings, form: value })
  const selectedProvider = providers.find((provider) => provider.id === Number(value.provider_id))

  const fetchModels = async () => {
    if (!value.provider_id) return
    setLoadingModels(true)
    setModels(null)
    try {
      setModels(await get(`/admin/providers/${value.provider_id}/models`))
    } catch (requestError) {
      setModels({ ok: false, error: requestError.message })
    } finally {
      setLoadingModels(false)
    }
  }

  const submit = (event) => {
    event.preventDefault()
    const clientModel = value.client_model.trim()
    if (!value.provider_id || !clientModel || !value.upstream_model.trim()) {
      setError('请完整填写映射信息。')
      return
    }
    if (!/(sonnet|opus|haiku)/i.test(clientModel)) {
      setError('客户端 model 必须包含 sonnet、opus 或 haiku。')
      return
    }
    onSave({
      ...value,
      provider_id: Number(value.provider_id),
      client_model: clientModel,
      upstream_model: value.upstream_model.trim()
    })
  }

  return (
    <Dialog open onClose={onClose} ariaLabel={value.id ? '编辑模型映射' : '新增模型映射'} className="max-w-[500px]" placement="right">
      <form className="flex min-h-0 flex-1 flex-col" onSubmit={submit}>
        <div className="flex items-start justify-between border-b border-[var(--border)] px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">{value.id ? '编辑模型映射' : '新增模型映射'}</h2>
            <p className="mt-1 text-xs text-[var(--text-muted)]">配置客户端模型的上游候选。</p>
          </div>
          <IconButton size="sm" label="关闭" onClick={onClose}><X size={14} /></IconButton>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
          <label className="block">
            <Label>客户端 model</Label>
            <input
              list="mapping-client-models"
              value={value.client_model}
              onChange={(event) => {
                setValue((current) => ({ ...current, client_model: event.target.value, provider_id: '' }))
                setModels(null)
              }}
              className="desktop-input mt-1.5 w-full font-mono"
            />
            <datalist id="mapping-client-models">
              {clientModels.map((model) => <option key={model} value={model} />)}
            </datalist>
            <p className="mt-1 text-[10px] text-[var(--text-muted)]">Office 仅识别包含 sonnet、opus 或 haiku 的模型 ID。</p>
          </label>
          <label className="block">
            <Label>Provider</Label>
            <select
              value={value.provider_id}
              onChange={(event) => {
                setValue((current) => ({ ...current, provider_id: event.target.value }))
                setModels(null)
              }}
              className="desktop-input mt-1.5 w-full"
            >
              <option value="">选择 Provider</option>
              {available.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name} · {provider.format}{provider.enabled ? '' : ' · 已停用'}
                </option>
              ))}
            </select>
            {!available.length ? <p className="mt-1 text-[10px] text-[var(--warning-strong)]">此模型没有可添加的 Provider。</p> : null}
          </label>
          <label className="block">
            <span className="flex items-center justify-between">
              <Label>Upstream model</Label>
              <button type="button" onClick={fetchModels} disabled={!value.provider_id || loadingModels} className="desktop-link">
                <RefreshCw size={12} className={loadingModels ? 'animate-spin' : ''} />
                读取列表
              </button>
            </span>
            <input
              data-autofocus
              value={value.upstream_model}
              onChange={(event) => setValue((current) => ({ ...current, upstream_model: event.target.value }))}
              placeholder="例如 deepseek-chat"
              className="desktop-input mt-1.5 w-full font-mono"
            />
            {selectedProvider ? <p className="mt-1 text-[10px] text-[var(--text-muted)]">模型列表仅用于辅助选择，不验证消息转换或流式响应。</p> : null}
          </label>
          {models ? models.ok ? (
            <div className="max-h-44 overflow-y-auto rounded border border-[var(--border)] bg-[var(--surface-subtle)] p-2">
              {models.models?.length ? (
                <div className="divide-y divide-[var(--border-subtle)]">
                  {models.models.slice(0, 30).map((model) => (
                    <button key={model} type="button" onClick={() => setValue((current) => ({ ...current, upstream_model: model }))} className="flex w-full items-center px-2 py-1.5 text-left font-mono text-[11px] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]">
                      {model}
                    </button>
                  ))}
                </div>
              ) : <p className="px-2 py-3 text-xs text-[var(--text-muted)]">上游未返回模型，可手动填写。</p>}
            </div>
          ) : <InlineNotice tone="danger">读取失败：{models.error}</InlineNotice> : null}
          {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}
        </div>
        <div className="flex justify-end gap-2 border-t border-[var(--border)] px-4 py-3">
          <button type="button" onClick={onClose} className="desktop-button">取消</button>
          <button type="submit" disabled={saving || !available.length} className="desktop-button desktop-button-primary">
            {saving ? <Spinner className="h-3.5 w-3.5" /> : null}
            保存映射
          </button>
        </div>
      </form>
    </Dialog>
  )
}

function MappingLoading() {
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[184px_minmax(0,1fr)] overflow-hidden rounded-md border border-[var(--border)] bg-[var(--surface)]">
      <div className="border-r border-[var(--border)] bg-[var(--surface-subtle)] p-2">
        {[0, 1, 2].map((item) => <div key={item} className="mb-1 h-10 animate-pulse rounded bg-[var(--surface-active)]" />)}
      </div>
      <div className="p-3">
        {[0, 1, 2, 3, 4, 5].map((item) => <div key={item} className="h-10 animate-pulse border-b border-[var(--border-subtle)] bg-[var(--surface)]" />)}
      </div>
    </div>
  )
}

function MappingError({ message, onRetry }) {
  return (
    <EmptyState
      icon={AlertTriangle}
      title="模型映射暂不可用"
      description={message || '无法读取 Provider 或映射配置。'}
      action={<button type="button" onClick={onRetry} className="desktop-button desktop-button-primary">重新加载</button>}
      className="flex-1"
    />
  )
}

function Label({ children }) {
  return <span className="text-xs font-medium text-[var(--text-secondary)]">{children}</span>
}
