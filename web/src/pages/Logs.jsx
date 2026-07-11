import { Fragment, useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, ArrowRight, ChevronDown, ChevronRight, RefreshCw, Search } from 'lucide-react'
import { get } from '../lib/api'

const fmtTime = (ts) => (ts ? String(ts).slice(11, 19) : '-')
const fmtMs = (ms) => (ms == null ? '-' : `${(ms / 1000).toFixed(2)}s`)
const fmtFullTs = (ts) => (ts ? String(ts).slice(0, 16) : '-')
const tokenPct = (part, total) => (total ? Math.round((part / total) * 100) : 0)
const streamLabel = (stream) => (stream ? '流式' : '非流式')
const isErr = (log) => (log.status || 0) >= 400 || !!log.error

const dotOf = (name) => {
  if (name === 'OpenAI') return 'bg-blue-500'
  if (name === 'Moonshot') return 'bg-amber-500'
  if (name === 'Vertex') return 'bg-violet-500'
  return 'bg-emerald-500'
}

const PAGE_SIZE = 25
const refreshOptions = [
  { value: 10_000, label: '每 10 秒' },
  { value: 30_000, label: '每 30 秒' },
  { value: 60_000, label: '每 60 秒' }
]

const fmtRefreshTime = (timestamp) => {
  if (!timestamp) return '等待首次加载'
  return '上次更新 ' + new Date(timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

const normalizeLogs = (response) => {
  const data = Array.isArray(response) ? response : Array.isArray(response?.data) ? response.data : []
  const candidate = response?.meta?.total ?? response?.pagination?.total ?? response?.total
  const total = Number(candidate)
  return { data, total: Number.isFinite(total) && total >= data.length ? total : data.length }
}

export default function Logs() {
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [provider, setProvider] = useState('all')
  const [status, setStatus] = useState('all')
  const [page, setPage] = useState(1)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [refreshInterval, setRefreshInterval] = useState(30_000)
  const [expandedIds, setExpandedIds] = useState({})
  const toggleExpand = (id) => setExpandedIds((prev) => ({ ...prev, [id]: !prev[id] }))

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput.trim()), 220)
    return () => window.clearTimeout(timer)
  }, [searchInput])

  const { data, isLoading, isFetching, isError, error, dataUpdatedAt, refetch } = useQuery({
    queryKey: ['logs'],
    queryFn: () => get('/admin/logs?limit=200&offset=0'),
    refetchInterval: autoRefresh ? refreshInterval : false,
    refetchIntervalInBackground: false
  })

  const result = useMemo(() => normalizeLogs(data), [data])
  const all = result.data
  const providerOptions = useMemo(() => ['all', ...Array.from(new Set(all.map((log) => log.provider_name).filter(Boolean)))], [all])
  const filteredLogs = useMemo(() => all.filter((log) => {
    if (provider !== 'all' && log.provider_name !== provider) return false
    if (status === 'success' && isErr(log)) return false
    if (status === 'error' && !isErr(log)) return false
    if (search) {
      const query = search.toLowerCase()
      const hay = [log.client_model, log.provider_name, log.upstream_model, log.error || ''].join(' ').toLowerCase()
      if (!hay.includes(query)) return false
    }
    return true
  }), [all, provider, search, status])

  useEffect(() => {
    setPage(1)
  }, [provider, search, status])

  const totalPages = Math.max(1, Math.ceil(filteredLogs.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const visibleLogs = filteredLogs.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)
  const hasFilters = Boolean(searchInput || provider !== 'all' || status !== 'all')
  const hasFatalError = isError && !data
  const hasRefreshError = isError && Boolean(data)
  const resultLabel = result.total > all.length
    ? '当前已载入 ' + all.length + ' / 共 ' + result.total + ' 条'
    : '显示 ' + filteredLogs.length + ' / ' + all.length + ' 条'

  const clearFilters = () => {
    setSearchInput('')
    setSearch('')
    setProvider('all')
    setStatus('all')
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div className="flex flex-col justify-between gap-4 border-b border-slate-200 pb-5 xl:flex-row xl:items-end">
        <PageHeader
          eyebrow="Logs"
          title="请求日志"
          desc="查看请求耗时、TTFT、Token、Cache 与错误信息；筛选仅作用于当前已载入的记录。"
        />
        <div className="flex flex-wrap items-center justify-end gap-2">
          <label className="inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(event) => setAutoRefresh(event.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
            />
            自动刷新
          </label>
          <label className="sr-only" htmlFor="logs-refresh-interval">自动刷新间隔</label>
          <select
            id="logs-refresh-interval"
            value={refreshInterval}
            onChange={(event) => setRefreshInterval(Number(event.target.value))}
            disabled={!autoRefresh}
            className="min-h-10 rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {refreshOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <button
            type="button"
            onClick={() => void refetch()}
            disabled={isFetching}
            className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <RefreshCw size={14} aria-hidden="true" className={isFetching ? 'animate-spin text-blue-600' : 'text-slate-500'} />
            {isFetching ? '刷新中' : '立即刷新'}
          </button>
          <span className="flex min-h-10 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 font-mono text-xs text-slate-500" aria-live="polite">
            <span className={isFetching ? 'h-1.5 w-1.5 rounded-full bg-blue-500' : 'h-1.5 w-1.5 rounded-full bg-slate-400'} />
            {isFetching ? '正在同步日志' : fmtRefreshTime(dataUpdatedAt)}
          </span>
        </div>
      </div>

      {hasRefreshError && (
        <div role="alert" className="flex flex-col gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-2"><AlertTriangle size={17} aria-hidden="true" className="mt-0.5 shrink-0 text-amber-700" /><span>最新一次日志同步失败：{error?.message || '正在显示上一次成功加载的数据。'}</span></div>
          <button type="button" onClick={() => void refetch()} className="self-start rounded-md border border-amber-300 bg-white px-3 py-1.5 text-xs font-semibold text-amber-900 hover:bg-amber-100 sm:self-auto">重试</button>
        </div>
      )}

      <section className="rounded-lg border border-slate-200 bg-slate-50/70 p-3 sm:p-4" aria-label="日志筛选">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="flex w-full items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 lg:max-w-md">
            <Search size={16} aria-hidden="true" className="shrink-0 text-slate-500" />
            <label className="sr-only" htmlFor="logs-search">搜索请求日志</label>
            <input
              id="logs-search"
              type="search"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="搜索 model / Provider / upstream / 错误"
              className="min-w-0 flex-1 bg-transparent text-sm text-slate-950 outline-none placeholder:text-slate-400"
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:flex lg:items-center">
            <div>
              <label className="sr-only" htmlFor="logs-provider">Provider 筛选</label>
              <select id="logs-provider" value={provider} onChange={(event) => setProvider(event.target.value)} className="min-h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700 lg:min-w-40">
                <option value="all">全部 Provider</option>
                {providerOptions.filter((value) => value !== 'all').map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </div>
            <div>
              <label className="sr-only" htmlFor="logs-status">状态筛选</label>
              <select id="logs-status" value={status} onChange={(event) => setStatus(event.target.value)} className="min-h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700 lg:min-w-32">
                <option value="all">全部状态</option>
                <option value="success">成功</option>
                <option value="error">错误</option>
              </select>
            </div>
          </div>
          {hasFilters && <button type="button" onClick={clearFilters} className="min-h-10 rounded-lg px-3 text-sm font-medium text-slate-600 transition-colors hover:bg-white hover:text-slate-950">清除筛选</button>}
          <span className="lg:ml-auto whitespace-nowrap font-mono text-xs text-slate-500" aria-live="polite">{resultLabel}</span>
        </div>
      </section>

      {isLoading && !data && <LogsLoading />}
      {hasFatalError && <LogsUnavailable error={error} onRetry={() => void refetch()} />}

      {!isLoading && !hasFatalError && (
        <>
          <div className="hidden overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm md:block" aria-busy={isFetching}>
            <div className="overflow-x-auto">
              <div className="min-w-[1160px]">
                <div className="grid grid-cols-[36px_110px_130px_250px_minmax(220px,1fr)_80px_90px_140px_90px_90px] gap-4 border-b border-slate-200 bg-slate-50 px-5 py-3 text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
                  <div aria-hidden="true" />
                  <div>时间</div>
                  <div>Provider</div>
                  <div>客户端 model</div>
                  <div>upstream model</div>
                  <div>TTFT</div>
                  <div>总耗时</div>
                  <div>Token 入/出</div>
                  <div>Cache</div>
                  <div>状态</div>
                </div>
                {visibleLogs.length === 0 ? <LogsEmpty hasFilters={hasFilters} onClear={clearFilters} /> : visibleLogs.map((log) => <LogRow key={log.id} log={log} expanded={!!expandedIds[log.id]} onToggle={() => toggleExpand(log.id)} />)}
              </div>
            </div>
          </div>

          <div className="grid gap-3 md:hidden" aria-busy={isFetching}>
            {visibleLogs.length === 0 && <LogsEmpty hasFilters={hasFilters} onClear={clearFilters} compact />}
            {visibleLogs.map((log) => {
              const expanded = !!expandedIds[log.id]
              const detailId = 'mobile-log-detail-' + log.id
              return (
                <div key={log.id} className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
                  <button type="button" onClick={() => toggleExpand(log.id)} aria-expanded={expanded} aria-controls={detailId} className="w-full cursor-pointer text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className={`h-1.5 w-1.5 rounded-full ${dotOf(log.provider_name)}`} />
                          <span className="truncate text-sm font-medium text-slate-950">{log.provider_name || '-'}</span>
                          <span className="font-mono text-xs text-slate-500">{fmtTime(log.ts)}</span>
                        </div>
                        <div className="mt-2 truncate font-mono text-xs text-slate-600">{log.client_model || '-'}</div>
                        <div className="mt-1 truncate font-mono text-xs text-slate-500">{log.upstream_model || '-'}</div>
                      </div>
                      <StatusBadge log={log} />
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-slate-500">
                      <span>TTFT {fmtMs(log.ttft_ms)}</span>
                      <span>总耗时 {fmtMs(log.duration_ms)}</span>
                      <span>Token {log.input_tokens || 0}/{log.output_tokens || 0}</span>
                    </div>
                  </button>
                  {expanded && <div id={detailId}><ExpandedLog log={log} /></div>}
                </div>
              )
            })}
          </div>

          {filteredLogs.length > PAGE_SIZE && (
            <nav className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3 sm:flex-row sm:items-center sm:justify-between" aria-label="日志分页">
              <span className="text-sm text-slate-500">第 {safePage} / {totalPages} 页，每页 {PAGE_SIZE} 条</span>
              <div className="flex items-center gap-2">
                <button type="button" disabled={safePage === 1} onClick={() => setPage((current) => Math.max(1, current - 1))} className="min-h-9 rounded-md border border-slate-200 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50">上一页</button>
                <button type="button" disabled={safePage === totalPages} onClick={() => setPage((current) => Math.min(totalPages, current + 1))} className="min-h-9 rounded-md border border-slate-200 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50">下一页</button>
              </div>
            </nav>
          )}
        </>
      )}
    </div>
  )
}

const LogsLoading = () => (
  <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm" aria-label="正在加载请求日志" aria-busy="true">
    {[0, 1, 2, 3, 4, 5].map((item) => <div key={item} className="flex animate-pulse items-center gap-4 border-b border-slate-100 px-5 py-4 last:border-b-0"><div className="h-3 w-16 rounded bg-slate-200" /><div className="h-3 w-24 rounded bg-slate-100" /><div className="h-3 flex-1 rounded bg-slate-100" /><div className="h-3 w-20 rounded bg-slate-100" /></div>)}
  </div>
)

const LogsUnavailable = ({ error, onRetry }) => (
  <div className="rounded-lg border border-dashed border-slate-300 bg-white px-5 py-14 text-center">
    <AlertTriangle size={24} aria-hidden="true" className="mx-auto text-amber-600" />
    <h2 className="mt-3 text-base font-semibold text-slate-950">请求日志暂不可用</h2>
    <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-500">{error?.message || '无法连接到网关。请确认服务正在运行且登录令牌有效。'}</p>
    <button type="button" onClick={onRetry} className="mt-5 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-slate-700">重新加载</button>
  </div>
)

const LogsEmpty = ({ hasFilters, onClear, compact = false }) => (
  <div className={compact ? 'rounded-lg border border-dashed border-slate-200 bg-white px-4 py-10 text-center' : 'px-5 py-12 text-center'}>
    <p className="text-sm font-medium text-slate-700">{hasFilters ? '没有符合当前筛选条件的请求' : '暂无请求记录'}</p>
    <p className="mt-1 text-sm text-slate-500">{hasFilters ? '尝试调整搜索词、Provider 或状态筛选。' : '网关收到请求后，记录会显示在这里。'}</p>
    {hasFilters && <button type="button" onClick={onClear} className="mt-3 rounded-md px-3 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-50">清除筛选</button>}
  </div>
)

const LogRow = ({ log, expanded, onToggle }) => {
  const inputTokens = log.input_tokens || 0
  const outputTokens = log.output_tokens || 0
  const hasCache = (log.cache_r || 0) > 0 || (log.cache_w || 0) > 0

  return (
    <Fragment>
      <button
        type="button"
        className={`grid w-full cursor-pointer grid-cols-[36px_110px_130px_250px_minmax(220px,1fr)_80px_90px_140px_90px_90px] items-center gap-4 border-b border-slate-200 px-5 py-3 text-left text-sm transition-colors hover:bg-slate-50 ${expanded ? 'bg-slate-50' : ''}`}
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={`log-detail-${log.id}`}
      >
        <div>{expanded ? <ChevronDown size={15} className="text-slate-500" /> : <ChevronRight size={15} className="text-slate-400" />}</div>
        <div className="font-mono text-xs text-slate-500">{fmtTime(log.ts)}</div>
        <div className="flex min-w-0 items-center gap-2">
          <span className={`h-1.5 w-1.5 rounded-full ${dotOf(log.provider_name)}`} />
          <span className="truncate text-slate-700">{log.provider_name || '-'}</span>
        </div>
        <div className="truncate font-mono text-xs text-slate-700">{log.client_model || '-'}</div>
        <div className="flex min-w-0 items-center gap-2 font-mono text-xs text-slate-500">
          <ArrowRight size={12} className="shrink-0 text-slate-400" />
          <span className="truncate">{log.upstream_model || '-'}</span>
        </div>
        <div className="font-mono text-xs text-slate-500">{fmtMs(log.ttft_ms)}</div>
        <div className="font-mono text-xs text-slate-700">{fmtMs(log.duration_ms)}</div>
        <div className="font-mono text-xs text-slate-500">{inputTokens} / {outputTokens}</div>
        <div className={hasCache ? 'font-mono text-xs text-emerald-700' : 'font-mono text-xs text-slate-500'}>
          {log.cache_r || 0}/{log.cache_w || 0}
        </div>
        <StatusBadge log={log} />
      </button>
      {expanded && (
        <div id={`log-detail-${log.id}`} className="border-b border-slate-200 bg-slate-50 px-8 py-5">
          <ExpandedLog log={log} />
        </div>
      )}
    </Fragment>
  )
}

const ExpandedLog = ({ log }) => {
  const inputTokens = log.input_tokens || 0
  const outputTokens = log.output_tokens || 0
  const tokenTotal = inputTokens + outputTokens
  const inputPct = tokenPct(inputTokens, tokenTotal)
  const outputPct = tokenPct(outputTokens, tokenTotal)

  return (
    <div className="mt-4 md:mt-0">
      <div className="grid gap-5 md:grid-cols-2">
        <DetailBlock title="基本信息">
          <Detail label="Request ID" value={`#${log.id}`} mono />
          <Detail label="时间" value={fmtFullTs(log.ts)} mono />
          <Detail label="模式" value={streamLabel(log.stream)} />
          <Detail label="状态码" value={log.status || (log.error ? 'ERR' : '200')} mono danger={isErr(log)} success={!isErr(log)} />
        </DetailBlock>
        <DetailBlock title="性能指标">
          <Detail label="TTFT" value={fmtMs(log.ttft_ms)} mono />
          <Detail label="总耗时" value={fmtMs(log.duration_ms)} mono />
          <Detail label="Token 总量" value={tokenTotal} mono />
          <Detail label="Cache Read/Write" value={`${log.cache_r || 0} / ${log.cache_w || 0}`} mono />
        </DetailBlock>
      </div>

      <div className="mt-5 rounded-lg border border-slate-200 bg-white p-4">
        <div className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Token 详情</div>
        <div className="flex flex-wrap items-center gap-6 text-sm text-slate-600">
          <span>输入 <span className="font-mono text-slate-950">{inputTokens}</span></span>
          <span>输出 <span className="font-mono text-slate-950">{outputTokens}</span></span>
          <span>总量 <span className="font-mono text-slate-950">{tokenTotal}</span></span>
        </div>
        {tokenTotal > 0 && (
          <div className="mt-3 flex items-center gap-3">
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-200">
              <div className="h-full rounded-full bg-blue-500" style={{ width: `${inputPct}%` }} />
            </div>
            <span className="font-mono text-xs text-slate-500">入 {inputPct}% / 出 {outputPct}%</span>
          </div>
        )}
      </div>

      {log.error && (
        <div className="mt-5 rounded-lg border border-red-200 bg-red-50 p-4">
          <div className="text-xs font-semibold uppercase tracking-[0.14em] text-red-700">错误信息</div>
          <pre className="mt-2 max-h-32 overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs leading-5 text-red-700">{log.error}</pre>
        </div>
      )}
    </div>
  )
}

const StatusBadge = ({ log }) => (
  <span className={`inline-flex w-fit rounded-full border px-2.5 py-1 font-mono text-xs font-semibold ${
    isErr(log)
      ? 'border-red-200 bg-red-50 text-red-700'
      : 'border-emerald-200 bg-emerald-50 text-emerald-700'
  }`}>
    {log.status || (log.error ? 'ERR' : '200')}
  </span>
)

const DetailBlock = ({ title, children }) => (
  <div className="rounded-lg border border-slate-200 bg-white p-4">
    <div className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">{title}</div>
    <div className="space-y-2">{children}</div>
  </div>
)

const Detail = ({ label, value, mono, danger, success }) => (
  <div className="flex items-center justify-between gap-4 text-sm">
    <span className="text-slate-500">{label}</span>
    <span className={`${mono ? 'font-mono' : ''} ${danger ? 'text-red-700' : success ? 'text-emerald-700' : 'text-slate-950'}`}>{value}</span>
  </div>
)

const PageHeader = ({ eyebrow, title, desc }) => (
  <div>
    <p className="text-sm font-semibold uppercase tracking-[0.16em] text-blue-700">{eyebrow}</p>
    <h1 className="mt-2 text-3xl font-semibold text-slate-950">{title}</h1>
    <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">{desc}</p>
  </div>
)
