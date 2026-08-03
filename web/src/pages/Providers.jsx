import { Fragment, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  CheckCircle2,
  CircleOff,
  Pencil,
  Plus,
  Server,
  Trash2
} from 'lucide-react'
import { del, get, post, put } from '../lib/api'
import ProviderForm from '../components/ProviderForm'
import {
  ConfirmDialog,
  EmptyState,
  IconButton,
  InlineNotice,
  PageToolbar,
  Spinner,
  StatusBadge
} from '../components/ui'
import { providerMappingCounts } from '../lib/provider-view'

/** 获取并管理 Provider 列表及属性面板状态。 */
export default function Providers() {
  const queryClient = useQueryClient()
  const providerQuery = useQuery({ queryKey: ['providers'], queryFn: () => get('/admin/providers') })
  const mappingsQuery = useQuery({ queryKey: ['mappings'], queryFn: () => get('/admin/mappings') })
  const [editing, setEditing] = useState(undefined)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [testResults, setTestResults] = useState({})
  const [error, setError] = useState(null)

  const providers = providerQuery.data?.data || []
  const mappings = mappingsQuery.data?.data || []
  const mappingCounts = useMemo(() => providerMappingCounts(mappings), [mappings])

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['providers'] })
    queryClient.invalidateQueries({ queryKey: ['mappings'] })
    queryClient.invalidateQueries({ queryKey: ['route-preflight'] })
  }

  const toggle = useMutation({
    mutationFn: ({ id, enabled }) => put(`/admin/providers/${id}`, { enabled }),
    onSuccess: refresh,
    onError: (mutationError) => setError(mutationError.message)
  })
  const remove = useMutation({
    mutationFn: (id) => del(`/admin/providers/${id}`),
    onSuccess: () => {
      refresh()
      setDeleteTarget(null)
    },
    onError: (mutationError) => setError(mutationError.message)
  })
  const discover = useMutation({
    mutationFn: (id) => post(`/admin/providers/${id}/test`),
    onMutate: (id) => {
      setError(null)
      setTestResults((current) => ({ ...current, [id]: null }))
    },
    onSuccess: (result, id) => setTestResults((current) => ({ ...current, [id]: { ok: true, ...result } })),
    onError: (mutationError, id) => setTestResults((current) => ({
      ...current,
      [id]: { ok: false, error: mutationError.message || '无法读取模型列表。' }
    }))
  })

  const enabled = providers.filter((provider) => provider.enabled).length
  const defaultProvider = providers.find((provider) => provider.is_default)
  const loading = providerQuery.isLoading || mappingsQuery.isLoading
  const fatalError = providerQuery.isError || mappingsQuery.isError

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <PageToolbar
        title="Provider"
        description="管理上游端点、鉴权和路由参与状态。"
        meta={`${providers.length} 个 · ${enabled} 个启用${defaultProvider ? ` · 默认 ${defaultProvider.name}` : ''}`}
        actions={(
          <button type="button" onClick={() => setEditing(null)} className="desktop-button desktop-button-primary">
            <Plus size={14} />
            新增 Provider
          </button>
        )}
      />

      {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}

      {loading ? <ProviderLoading /> : fatalError ? (
        <EmptyState
          icon={AlertTriangle}
          title="Provider 列表暂不可用"
          description={providerQuery.error?.message || mappingsQuery.error?.message || '请检查后端服务后重试。'}
          action={(
            <button
              type="button"
              onClick={() => {
                void providerQuery.refetch()
                void mappingsQuery.refetch()
              }}
              className="desktop-button desktop-button-primary"
            >
              重新加载
            </button>
          )}
          className="flex-1"
        />
      ) : providers.length ? (
        <section className="min-h-0 flex-1 overflow-auto rounded-md border border-[var(--border)] bg-[var(--surface)]">
          <div className="sticky top-0 z-10 grid h-8 grid-cols-[80px_minmax(120px,0.8fr)_108px_minmax(210px,1.25fr)_68px_72px_116px] items-center gap-2 border-b border-[var(--border)] bg-[var(--surface-subtle)] px-3 text-[10px] font-semibold text-[var(--text-muted)]">
            <span>状态</span>
            <span>名称</span>
            <span>格式</span>
            <span>Base URL</span>
            <span>映射</span>
            <span>默认</span>
            <span className="text-right">操作</span>
          </div>
          <div className="divide-y divide-[var(--border-subtle)]">
            {providers.map((provider) => (
              <Fragment key={provider.id}>
                <ProviderRow
                  provider={provider}
                  mappingCount={mappingCounts.get(provider.id) || 0}
                  discovering={discover.isPending && discover.variables === provider.id}
                  toggling={toggle.isPending && toggle.variables?.id === provider.id}
                  deleting={remove.isPending && remove.variables === provider.id}
                  onDiscover={() => discover.mutate(provider.id)}
                  onEdit={() => setEditing(provider)}
                  onToggle={() => toggle.mutate({ id: provider.id, enabled: !provider.enabled })}
                  onDelete={() => setDeleteTarget(provider)}
                />
                {testResults[provider.id] ? <ProviderTestResult result={testResults[provider.id]} /> : null}
              </Fragment>
            ))}
          </div>
        </section>
      ) : (
        <EmptyState
          icon={Server}
          title="还没有 Provider"
          description="添加上游端点后，即可建立模型映射并接收 Office 请求。"
          action={<button type="button" onClick={() => setEditing(null)} className="desktop-button desktop-button-primary">新增 Provider</button>}
          className="flex-1"
        />
      )}

      {editing !== undefined ? <ProviderForm provider={editing} onClose={() => setEditing(undefined)} /> : null}

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget.id)}
        title="删除 Provider"
        description={deleteTarget ? `将永久删除 ${deleteTarget.name}，并级联删除其 ${mappingCounts.get(deleteTarget.id) || 0} 条模型映射。此操作无法撤销。` : ''}
        confirmLabel="删除 Provider"
        pending={remove.isPending}
      />
    </div>
  )
}

function ProviderRow({ provider, mappingCount, discovering, toggling, deleting, onDiscover, onEdit, onToggle, onDelete }) {
  const pending = discovering || toggling || deleting
  return (
    <div className="grid min-h-11 grid-cols-[80px_minmax(120px,0.8fr)_108px_minmax(210px,1.25fr)_68px_72px_116px] items-center gap-2 px-3 text-xs transition-colors hover:bg-[var(--surface-hover)]">
      <button
        type="button"
        role="switch"
        aria-checked={provider.enabled}
        onClick={onToggle}
        disabled={pending}
        className="flex h-7 w-fit items-center gap-1.5 rounded px-1.5 text-[11px] font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-active)] disabled:opacity-50"
      >
        {toggling ? <Spinner className="h-3.5 w-3.5" /> : provider.enabled ? <CheckCircle2 size={13} className="text-[var(--success-strong)]" /> : <CircleOff size={13} className="text-[var(--text-tertiary)]" />}
        {provider.enabled ? '启用' : '停用'}
      </button>
      <div className="min-w-0">
        <div className="truncate font-semibold text-[var(--text-primary)]" title={provider.name}>{provider.name}</div>
        <div className="mt-0.5 font-mono text-[9px] text-[var(--text-tertiary)]">ID {provider.id}</div>
      </div>
      <span className="truncate font-mono text-[10px] text-[var(--text-secondary)]" title={formatName(provider.format)}>{formatName(provider.format)}</span>
      <span className="truncate font-mono text-[10px] text-[var(--text-muted)]" title={provider.base_url}>{provider.base_url}</span>
      <span className="font-mono text-[11px] text-[var(--text-secondary)]">{mappingCount}</span>
      <span>{provider.is_default ? <StatusBadge tone="info">默认</StatusBadge> : <span className="text-[var(--text-tertiary)]">-</span>}</span>
      <div className="flex justify-end gap-0.5">
        <IconButton size="sm" label="读取模型列表" onClick={onDiscover} disabled={pending}>{discovering ? <Spinner className="h-3.5 w-3.5" /> : <Server size={13} />}</IconButton>
        <IconButton size="sm" label="编辑 Provider" onClick={onEdit} disabled={pending}><Pencil size={13} /></IconButton>
        <IconButton size="sm" label="删除 Provider" onClick={onDelete} disabled={pending} tone="danger"><Trash2 size={13} /></IconButton>
      </div>
    </div>
  )
}

function ProviderTestResult({ result }) {
  const content = result.ok
    ? `模型发现成功：读取到 ${result.models} 个模型${result.cached ? '，使用缓存结果' : ''}${result.latency_ms ? `，耗时 ${result.latency_ms} ms` : ''}。此操作不验证消息转换或流式响应。`
    : `模型发现失败：${result.error}`
  return (
    <div className={`flex min-h-8 items-center gap-2 border-t px-3 py-1.5 text-[10px] ${result.ok ? 'border-[var(--success-border)] bg-[var(--success-soft)] text-[var(--success-strong)]' : 'border-[var(--danger-border)] bg-[var(--danger-soft)] text-[var(--danger-strong)]'}`}>
      {result.ok ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />}
      {content}
    </div>
  )
}

function ProviderLoading() {
  return (
    <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-[var(--border)] bg-[var(--surface)]" aria-label="正在加载 Provider" aria-busy="true">
      <div className="h-8 animate-pulse border-b border-[var(--border)] bg-[var(--surface-subtle)]" />
      {[0, 1, 2, 3, 4, 5].map((item) => (
        <div key={item} className="flex h-11 animate-pulse items-center gap-5 border-b border-[var(--border-subtle)] px-3">
          <div className="h-2 w-14 rounded bg-[var(--surface-active)]" />
          <div className="h-2 w-28 rounded bg-[var(--surface-hover)]" />
          <div className="h-2 flex-1 rounded bg-[var(--surface-hover)]" />
          <div className="h-6 w-24 rounded bg-[var(--surface-hover)]" />
        </div>
      ))}
    </div>
  )
}

function formatName(format) {
  return ({
    anthropic: 'Anthropic',
    openai_chat: 'OpenAI Chat',
    openai_responses: 'Responses',
    url_adaptive: 'Adaptive URL'
  })[format] || format
}
