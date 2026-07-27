import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  AlertTriangle,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Search,
  X
} from 'lucide-react'
import { get } from '../lib/api'
import {
  Dialog,
  EmptyState,
  IconButton,
  InlineNotice,
  PageToolbar,
  StatusBadge
} from '../components/ui'

const PAGE_SIZE = 25
const refreshOptions = [
  { value: 10_000, label: '每 10 秒' },
  { value: 30_000, label: '每 30 秒' },
  { value: 60_000, label: '每 60 秒' }
]

const fmtTime = (ts) => (ts ? String(ts).slice(11, 19) : '-')
const fmtFullTs = (ts) => (ts ? String(ts).replace('T', ' ').slice(0, 19) : '-')
const fmtMs = (ms) => (ms == null ? '-' : `${Number(ms).toFixed(0)} ms`)
const isErr = (log) => (log.status || 0) >= 400 || Boolean(log.error)
const streamLabel = (stream) => (stream ? '流式' : '非流式')

const fmtRefreshTime = (timestamp) => {
  if (!timestamp) return '等待首次加载'
  return new Date(timestamp).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

const normalizeLogs = (response) => {
  const data = Array.isArray(response) ? response : Array.isArray(response?.data) ? response.data : []
  const totalCandidate = response?.meta?.total ?? response?.pagination?.total ?? response?.total
  const total = Number(totalCandidate)
  return { data, total: Number.isFinite(total) && total >= data.length ? total : data.length }
}

/** 获取、筛选并分页展示最近请求日志。 */
export default function Logs() {
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [provider, setProvider] = useState('all')
  const [status, setStatus] = useState('all')
  const [page, setPage] = useState(1)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [refreshInterval, setRefreshInterval] = useState(30_000)
  const [selectedLog, setSelectedLog] = useState(null)

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput.trim()), 220)
    return () => window.clearTimeout(timer)
  }, [searchInput])

  const query = useQuery({
    queryKey: ['logs'],
    queryFn: () => get('/admin/logs?limit=200&offset=0'),
    refetchInterval: autoRefresh ? refreshInterval : false,
    refetchIntervalInBackground: false
  })

  const result = useMemo(() => normalizeLogs(query.data), [query.data])
  const all = result.data
  const providerOptions = useMemo(
    () => ['all', ...Array.from(new Set(all.map((log) => log.provider_name).filter(Boolean)))],
    [all]
  )
  const filteredLogs = useMemo(() => {
    const normalizedSearch = search.toLowerCase()
    return all.filter((log) => {
      if (provider !== 'all' && log.provider_name !== provider) return false
      if (status === 'success' && isErr(log)) return false
      if (status === 'error' && !isErr(log)) return false
      if (!normalizedSearch) return true
      return [log.id, log.client_model, log.provider_name, log.upstream_model, log.error || '']
        .join(' ')
        .toLowerCase()
        .includes(normalizedSearch)
    })
  }, [all, provider, search, status])

  useEffect(() => {
    setPage(1)
  }, [provider, search, status])

  const totalPages = Math.max(1, Math.ceil(filteredLogs.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const visibleLogs = filteredLogs.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)
  const hasFilters = Boolean(searchInput || provider !== 'all' || status !== 'all')
  const hasFatalError = query.isError && !query.data
  const hasRefreshError = query.isError && Boolean(query.data)
  const resultLabel = result.total > all.length
    ? `已载入 ${all.length} / ${result.total}`
    : `${filteredLogs.length} / ${all.length} 条`

  const clearFilters = () => {
    setSearchInput('')
    setSearch('')
    setProvider('all')
    setStatus('all')
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <PageToolbar
        title="请求日志"
        description="查看路由、延迟、Token、Cache 与错误详情。"
        meta={`最近 200 条 · ${resultLabel}`}
        actions={(
          <div className="flex items-center gap-1.5">
            <label className="desktop-toggle-label">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(event) => setAutoRefresh(event.target.checked)}
              />
              自动刷新
            </label>
            <label className="sr-only" htmlFor="logs-refresh-interval">自动刷新间隔</label>
            <select
              id="logs-refresh-interval"
              value={refreshInterval}
              onChange={(event) => setRefreshInterval(Number(event.target.value))}
              disabled={!autoRefresh}
              className="desktop-select w-24"
            >
              {refreshOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            <IconButton size="sm" label="立即刷新" onClick={() => void query.refetch()} disabled={query.isFetching}>
              <RefreshCw size={13} className={query.isFetching ? 'animate-spin text-[var(--accent)]' : ''} />
            </IconButton>
            <span className="min-w-[78px] font-mono text-[10px] text-[var(--text-muted)]" aria-live="polite">
              {query.isFetching ? '正在同步' : fmtRefreshTime(query.dataUpdatedAt)}
            </span>
          </div>
        )}
      />

      {hasRefreshError ? (
        <InlineNotice tone="warning" className="flex items-center justify-between gap-3">
          <span>最新一次日志同步失败：{query.error?.message || '正在显示上一次成功加载的数据。'}</span>
          <button type="button" onClick={() => void query.refetch()} className="desktop-link">重试</button>
        </InlineNotice>
      ) : null}

      <section className="flex min-h-10 items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--surface-subtle)] px-2" aria-label="日志筛选">
        <div className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded border border-[var(--border)] bg-[var(--surface)] px-2.5 focus-within:border-[var(--accent)] focus-within:ring-1 focus-within:ring-[var(--accent-soft)]">
          <Search size={13} aria-hidden="true" className="shrink-0 text-[var(--text-muted)]" />
          <label className="sr-only" htmlFor="logs-search">搜索请求日志</label>
          <input
            id="logs-search"
            type="search"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="搜索 Request ID、model、Provider 或错误"
            className="min-w-0 flex-1 bg-transparent text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
          />
        </div>
        <label className="sr-only" htmlFor="logs-provider">Provider 筛选</label>
        <select id="logs-provider" value={provider} onChange={(event) => setProvider(event.target.value)} className="desktop-select w-36">
          <option value="all">全部 Provider</option>
          {providerOptions.filter((value) => value !== 'all').map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
        <label className="sr-only" htmlFor="logs-status">状态筛选</label>
        <select id="logs-status" value={status} onChange={(event) => setStatus(event.target.value)} className="desktop-select w-28">
          <option value="all">全部状态</option>
          <option value="success">成功</option>
          <option value="error">错误</option>
        </select>
        {hasFilters ? <button type="button" onClick={clearFilters} className="desktop-button"><X size={12} />清除</button> : null}
        <span className="whitespace-nowrap font-mono text-[10px] text-[var(--text-muted)]">仅筛选当前已载入记录</span>
      </section>

      {query.isLoading && !query.data ? <LogsLoading /> : hasFatalError ? (
        <EmptyState
          icon={AlertTriangle}
          title="请求日志暂不可用"
          description={query.error?.message || '无法连接到网关。请确认服务正在运行且登录令牌有效。'}
          action={<button type="button" onClick={() => void query.refetch()} className="desktop-button desktop-button-primary">重新加载</button>}
          className="flex-1"
        />
      ) : (
        <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-[var(--border)] bg-[var(--surface)]" aria-busy={query.isFetching}>
          <div className="grid h-8 shrink-0 grid-cols-[24px_68px_96px_minmax(250px,1fr)_88px_112px_56px] items-center gap-2 border-b border-[var(--border)] bg-[var(--surface-subtle)] px-2 text-[10px] font-semibold text-[var(--text-muted)]">
            <span aria-hidden="true" />
            <span>时间</span>
            <span>Provider</span>
            <span>路由</span>
            <span>延迟</span>
            <span>Token / Cache</span>
            <span>状态</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {visibleLogs.length ? visibleLogs.map((log) => (
              <LogRow key={log.id} log={log} selected={selectedLog?.id === log.id} onSelect={() => setSelectedLog(log)} />
            )) : (
              <EmptyState
                title={hasFilters ? '没有符合条件的请求' : '暂无请求记录'}
                description={hasFilters ? '调整搜索词、Provider 或状态筛选。' : '网关收到请求后，记录会显示在这里。'}
                action={hasFilters ? <button type="button" onClick={clearFilters} className="desktop-button">清除筛选</button> : null}
                className="h-full border-0"
              />
            )}
          </div>
          <div className="flex h-9 shrink-0 items-center justify-between border-t border-[var(--border)] bg-[var(--surface-subtle)] px-2.5">
            <span className="text-[10px] text-[var(--text-muted)]">第 {safePage} / {totalPages} 页 · 每页 {PAGE_SIZE} 条</span>
            <div className="flex items-center gap-1">
              <IconButton size="sm" label="上一页" disabled={safePage === 1} onClick={() => setPage((current) => Math.max(1, current - 1))}><ChevronLeft size={13} /></IconButton>
              <IconButton size="sm" label="下一页" disabled={safePage === totalPages} onClick={() => setPage((current) => Math.min(totalPages, current + 1))}><ChevronRight size={13} /></IconButton>
            </div>
          </div>
        </section>
      )}

      <LogInspector log={selectedLog} onClose={() => setSelectedLog(null)} />
    </div>
  )
}

function LogRow({ log, selected, onSelect }) {
  const inputTokens = log.input_tokens || 0
  const outputTokens = log.output_tokens || 0
  const cacheRead = log.cache_r || 0
  const cacheWrite = log.cache_w || 0
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`grid min-h-11 w-full grid-cols-[24px_68px_96px_minmax(250px,1fr)_88px_112px_56px] items-center gap-2 border-b border-[var(--border-subtle)] px-2 text-left text-xs transition-colors last:border-b-0 ${selected ? 'bg-[var(--accent-soft)]' : 'hover:bg-[var(--surface-hover)]'}`}
    >
      <ChevronRight size={12} aria-hidden="true" className={selected ? 'text-[var(--accent)]' : 'text-[var(--text-tertiary)]'} />
      <span className="font-mono text-[10px] text-[var(--text-muted)]">{fmtTime(log.ts)}</span>
      <span className="truncate font-semibold text-[var(--text-secondary)]" title={log.provider_name || '-'}>{log.provider_name || '-'}</span>
      <span className="min-w-0">
        <span className="flex min-w-0 items-center gap-1 font-mono text-[10px] text-[var(--text-secondary)]">
          <span className="max-w-[46%] truncate" title={log.client_model || '-'}>{log.client_model || '-'}</span>
          <ArrowRight size={10} className="shrink-0 text-[var(--text-tertiary)]" />
          <span className="min-w-0 flex-1 truncate text-[var(--text-muted)]" title={log.upstream_model || '-'}>{log.upstream_model || '-'}</span>
        </span>
        <span className="mt-0.5 block font-mono text-[9px] text-[var(--text-tertiary)]">#{log.id} · {streamLabel(log.stream)}</span>
      </span>
      <span className="font-mono text-[10px] text-[var(--text-secondary)]">
        <span className="block">T {fmtMs(log.ttft_ms)}</span>
        <span className="mt-0.5 block text-[var(--text-muted)]">Σ {fmtMs(log.duration_ms)}</span>
      </span>
      <span className="font-mono text-[10px] text-[var(--text-secondary)]">
        <span className="block">{inputTokens} / {outputTokens}</span>
        <span className={`mt-0.5 block ${cacheRead || cacheWrite ? 'text-[var(--success-strong)]' : 'text-[var(--text-muted)]'}`}>C {cacheRead} / {cacheWrite}</span>
      </span>
      <StatusBadge tone={isErr(log) ? 'danger' : 'success'}>{log.status || (log.error ? 'ERR' : '200')}</StatusBadge>
    </button>
  )
}

function LogInspector({ log, onClose }) {
  return (
    <Dialog open={Boolean(log)} onClose={onClose} ariaLabel="请求日志详情" className="max-w-[420px]" placement="right">
      {log ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-start justify-between border-b border-[var(--border)] px-4 py-3">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold text-[var(--text-primary)]">请求 #{log.id}</h2>
                <StatusBadge tone={isErr(log) ? 'danger' : 'success'}>{log.status || (log.error ? 'ERR' : '200')}</StatusBadge>
              </div>
              <p className="mt-1 font-mono text-[10px] text-[var(--text-muted)]">{fmtFullTs(log.ts)}</p>
            </div>
            <IconButton size="sm" label="关闭详情" onClick={onClose}><X size={14} /></IconButton>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <InspectorSection title="路由">
              <PropertyRow label="Provider" value={log.provider_name || '-'} />
              <PropertyRow label="客户端 model" value={log.client_model || '-'} mono />
              <PropertyRow label="Upstream model" value={log.upstream_model || '-'} mono />
              <PropertyRow label="请求模式" value={streamLabel(log.stream)} />
            </InspectorSection>
            <InspectorSection title="性能">
              <PropertyRow label="TTFT" value={fmtMs(log.ttft_ms)} mono />
              <PropertyRow label="总耗时" value={fmtMs(log.duration_ms)} mono />
              <PropertyRow label="输入 Token" value={log.input_tokens || 0} mono />
              <PropertyRow label="输出 Token" value={log.output_tokens || 0} mono />
              <PropertyRow label="Cache Read" value={log.cache_r || 0} mono />
              <PropertyRow label="Cache Write" value={log.cache_w || 0} mono />
            </InspectorSection>
            {log.error ? (
              <InspectorSection title="错误信息" tone="danger">
                <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--danger-soft)] p-2.5 font-mono text-[10px] leading-4 text-[var(--danger-strong)]">{log.error}</pre>
              </InspectorSection>
            ) : null}
          </div>
        </div>
      ) : null}
    </Dialog>
  )
}

function InspectorSection({ title, tone, children }) {
  return (
    <section className="border-b border-[var(--border)] px-4 py-3 last:border-b-0">
      <h3 className={`mb-2 text-[10px] font-semibold ${tone === 'danger' ? 'text-[var(--danger-strong)]' : 'text-[var(--text-muted)]'}`}>{title}</h3>
      <div className="divide-y divide-[var(--border-subtle)]">{children}</div>
    </section>
  )
}

function PropertyRow({ label, value, mono }) {
  return (
    <div className="grid min-h-8 grid-cols-[112px_minmax(0,1fr)] items-center gap-3 py-1 text-xs">
      <span className="text-[var(--text-muted)]">{label}</span>
      <span className={`min-w-0 break-words text-right text-[var(--text-primary)] ${mono ? 'font-mono text-[10px]' : ''}`}>{value}</span>
    </div>
  )
}

function LogsLoading() {
  return (
    <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-[var(--border)] bg-[var(--surface)]" aria-label="正在加载请求日志" aria-busy="true">
      <div className="h-8 animate-pulse border-b border-[var(--border)] bg-[var(--surface-subtle)]" />
      {[0, 1, 2, 3, 4, 5, 6, 7].map((item) => (
        <div key={item} className="flex h-11 animate-pulse items-center gap-4 border-b border-[var(--border-subtle)] px-3">
          <div className="h-2 w-14 rounded bg-[var(--surface-active)]" />
          <div className="h-2 w-20 rounded bg-[var(--surface-hover)]" />
          <div className="h-2 flex-1 rounded bg-[var(--surface-hover)]" />
          <div className="h-2 w-24 rounded bg-[var(--surface-hover)]" />
        </div>
      ))}
    </div>
  )
}
