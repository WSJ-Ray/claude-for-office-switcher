import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BarChart3,
  Clock3,
  DatabaseZap,
  Gauge,
  RefreshCw,
  Route,
  Server,
  Zap
} from 'lucide-react'
import { EmptyState, IconButton, InlineNotice, PageToolbar, StatusBadge } from '../components/ui'
import { get } from '../lib/api'
import { dashboardErrorRate, getDashboardDiagnostics, getDashboardHealth, isFailedRequest } from '../lib/dashboard'
import { statsPath, trendTickInterval } from '../lib/trend'

const fmtMs = (ms) => (ms == null ? '-' : `${(Number(ms) / 1000).toFixed(2)}s`)
const fmtNum = (value) => Number(value || 0).toLocaleString('zh-CN')
const fmtCompact = (value) =>
  Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(value || 0))
const fmtTime = (timestamp) => String(timestamp || '').slice(11, 19) || '--:--:--'

const summaryFallback = {
  total: 0,
  errors: 0,
  input_tokens: 0,
  output_tokens: 0,
  avg_ttft_ms: 0,
  avg_duration_ms: 0,
  cache_r: 0,
  cache_w: 0
}

const refreshOptions = [
  { value: 10_000, label: '10 秒' },
  { value: 30_000, label: '30 秒' },
  { value: 60_000, label: '60 秒' }
]

const trendOptions = [
  { value: '24h', label: '24 小时' },
  { value: '7d', label: '7 天' },
  { value: '30d', label: '30 天' }
]

const fmtRefreshTime = (timestamp) => {
  if (!timestamp) return '等待首次加载'
  return new Date(timestamp).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

/** 获取并展示网关运行指标、趋势和最近活动。 */
export default function Dashboard() {
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [refreshInterval, setRefreshInterval] = useState(30_000)
  const [trendRange, setTrendRange] = useState('24h')
  const statsQuery = useQuery({
    queryKey: ['stats', trendRange],
    queryFn: () => get(statsPath(trendRange)),
    refetchInterval: autoRefresh ? refreshInterval : false,
    refetchIntervalInBackground: false
  })
  const providersQuery = useQuery({
    queryKey: ['providers'],
    queryFn: () => get('/admin/providers'),
    refetchInterval: autoRefresh ? refreshInterval : false,
    refetchIntervalInBackground: false
  })

  const stats = statsQuery.data
  const providersResponse = providersQuery.data
  const isRefreshing = statsQuery.isFetching || providersQuery.isFetching
  const isUnavailable = (!stats || !providersResponse) && (statsQuery.isError || providersQuery.isError)
  const isInitialLoading = !isUnavailable && (!stats || !providersResponse) && (statsQuery.isLoading || providersQuery.isLoading)
  const hasRefreshError = !isUnavailable && (statsQuery.isError || providersQuery.isError)
  const lastUpdatedAt = Math.max(statsQuery.dataUpdatedAt || 0, providersQuery.dataUpdatedAt || 0)
  const refreshError = statsQuery.error || providersQuery.error

  const refetchAll = () => {
    void statsQuery.refetch()
    void providersQuery.refetch()
  }

  const summary = stats?.summary || summaryFallback
  const providerList = providersResponse?.data || []
  const enabledProviders = providerList.filter((provider) => provider.enabled).length
  const totalTokens = (Number(summary.input_tokens) || 0) + (Number(summary.output_tokens) || 0)
  const errorRate = dashboardErrorRate(summary)
  const cacheDenominator = (Number(summary.input_tokens) || 0) + (Number(summary.cache_r) || 0) + (Number(summary.cache_w) || 0)
  const cacheHit = cacheDenominator > 0 ? `${(((Number(summary.cache_r) || 0) / cacheDenominator) * 100).toFixed(1)}%` : '-'
  const serviceStatus = getDashboardHealth({ stats, providers: providerList })
  const diagnostics = getDashboardDiagnostics({ stats, providers: providerList })
  const statusTone = isUnavailable ? 'danger' : isInitialLoading ? 'neutral' : serviceStatus.tone
  const statusLabel = isUnavailable ? '数据不可用' : isInitialLoading ? '读取状态' : serviceStatus.label

  return (
    <div className="space-y-3">
      <PageToolbar
        title="控制台概览"
        description="请求路由、上游性能与资源用量"
        meta={(
          <>
            <StatusBadge tone={statusTone}>{statusLabel}</StatusBadge>
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap font-mono text-[11px] text-slate-500" aria-live="polite">
              <Activity size={13} aria-hidden="true" className={isRefreshing ? 'text-blue-600' : 'text-slate-400'} />
              {isRefreshing ? '正在同步' : `更新于 ${fmtRefreshTime(lastUpdatedAt)}`}
            </span>
          </>
        )}
        actions={(
          <>
            <label className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-[4px] border border-slate-300 bg-white px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(event) => setAutoRefresh(event.target.checked)}
                className="h-3.5 w-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-600"
              />
              自动刷新
            </label>
            <label className="sr-only" htmlFor="dashboard-refresh-interval">自动刷新间隔</label>
            <select
              id="dashboard-refresh-interval"
              value={refreshInterval}
              onChange={(event) => setRefreshInterval(Number(event.target.value))}
              disabled={!autoRefresh}
              className="h-8 rounded-[4px] border border-slate-300 bg-white px-2 text-xs text-slate-700 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
            >
              {refreshOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            <IconButton size="sm" label={isRefreshing ? '正在刷新仪表盘' : '刷新仪表盘'} onClick={refetchAll} disabled={isRefreshing}>
              <RefreshCw size={15} aria-hidden="true" className={isRefreshing ? 'animate-spin' : ''} />
            </IconButton>
          </>
        )}
      />

      {hasRefreshError && (
        <InlineNotice tone="warning" className="rounded-[4px] py-2">
          <div className="flex items-center justify-between gap-3">
            <span className="min-w-0 truncate">最新同步失败：{refreshError?.message || '正在显示上一次成功加载的数据。'}</span>
            <button type="button" onClick={refetchAll} className="h-7 shrink-0 rounded-[4px] px-2.5 text-xs font-semibold hover:bg-amber-100 active:translate-y-px">
              重试
            </button>
          </div>
        </InlineNotice>
      )}

      {isInitialLoading && <DashboardLoading />}
      {isUnavailable && <DashboardUnavailable error={refreshError} onRetry={refetchAll} />}

      {!isInitialLoading && !isUnavailable && (
        <>
          <KpiStrip
            summary={summary}
            totalTokens={totalTokens}
            errorRate={errorRate}
            cacheHit={cacheHit}
            enabledProviders={enabledProviders}
            providerCount={providerList.length}
            mappingsCount={stats?.mappings_count || 0}
          />

          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_272px] items-start gap-3 xl:grid-cols-[minmax(0,1.45fr)_minmax(300px,0.65fr)]">
            <div className="min-w-0 space-y-3">
              <RequestTrend
                trend={stats?.trend || stats?.hourly || []}
                range={trendRange}
                onRangeChange={setTrendRange}
              />
              <RecentRequests recent={stats?.recent || []} />
            </div>

            <aside className="min-w-0 space-y-3" aria-label="运行详情">
              <PerformanceSummary summary={summary} />
              <ProviderTraffic providers={stats?.by_provider || []} />
              {diagnostics.length > 0 && <Diagnostics items={diagnostics} />}
            </aside>
          </div>
        </>
      )}
    </div>
  )
}

const KpiStrip = ({ summary, totalTokens, errorRate, cacheHit, enabledProviders, providerCount, mappingsCount }) => (
  <section className="grid grid-cols-4 divide-x divide-slate-200 overflow-hidden rounded-[4px] border border-slate-200 bg-white" aria-label="累计指标">
    <Metric
      icon={Gauge}
      label="累计请求"
      value={fmtCompact(summary.total)}
      detail={`${fmtNum(summary.errors)} 个失败`}
      danger={errorRate >= 5}
    />
    <Metric
      icon={AlertTriangle}
      label="累计错误率"
      value={`${errorRate.toFixed(1)}%`}
      detail={`平均耗时 ${fmtMs(summary.avg_duration_ms)}`}
      danger={errorRate >= 5}
    />
    <Metric
      icon={DatabaseZap}
      label="Token 用量"
      value={fmtCompact(totalTokens)}
      detail={`Cache 命中 ${cacheHit}`}
    />
    <Metric
      icon={Server}
      label="启用 Provider"
      value={`${enabledProviders}/${providerCount}`}
      detail={`${fmtNum(mappingsCount)} 条模型映射`}
      danger={providerCount === 0 || enabledProviders === 0}
    />
  </section>
)

const Metric = ({ icon: Icon, label, value, detail, danger = false }) => (
  <div className="min-w-0 px-3 py-2.5">
    <div className="flex items-center gap-1.5 text-[11px] font-medium text-slate-600">
      <Icon size={13} aria-hidden="true" className={danger ? 'text-red-600' : 'text-slate-400'} />
      <span className="truncate">{label}</span>
    </div>
    <div className={`mt-1 truncate font-mono text-lg font-semibold leading-6 tabular-nums ${danger ? 'text-red-700' : 'text-slate-950'}`} title={String(value)}>
      {value}
    </div>
    <div className="mt-0.5 truncate text-[11px] text-slate-500" title={detail}>{detail}</div>
  </div>
)

const RequestTrend = ({ trend, range, onRangeChange }) => {
  const fallbackCount = range === '24h' ? 24 : range === '7d' ? 7 : 30
  const chartData = trend.length > 0
    ? trend.map((item) => ({ ...item, label: item.label || item.hour }))
    : Array.from({ length: fallbackCount }, (_, index) => ({
        label: range === '24h' ? `${String(index).padStart(2, '0')}:00` : `${index + 1}`,
        count: 0,
        errors: 0
      }))
  const peak = Math.max(0, ...chartData.map((item) => Number(item.count) || 0))

  return (
    <WorkbenchSection
      title="请求趋势"
      icon={BarChart3}
      aside={(
        <div className="inline-flex rounded-[4px] border border-slate-300 bg-white p-0.5" aria-label="趋势时间范围">
          {trendOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={range === option.value}
              onClick={() => onRangeChange(option.value)}
              className={`h-6 rounded-[3px] px-2 text-[11px] font-medium transition-colors ${
                range === option.value ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-950'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    >
      <div className="px-2 pb-1 pt-2">
        <div className="h-[202px]" role="img" aria-label={`${trendOptions.find((option) => option.value === range)?.label}请求与错误趋势图`}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 4, right: 24, left: -20, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="#e5e7eb" />
              <XAxis dataKey="label" interval={trendTickInterval(range)} tickLine={false} axisLine={false} tick={{ fill: '#64748b', fontSize: 10 }} />
              <YAxis allowDecimals={false} width={36} tickLine={false} axisLine={false} tick={{ fill: '#64748b', fontSize: 10 }} />
              <Tooltip
                cursor={{ stroke: '#94a3b8', strokeWidth: 1 }}
                contentStyle={{ borderRadius: 4, borderColor: '#cbd5e1', boxShadow: '0 6px 18px rgb(15 23 42 / 0.12)', fontSize: 12 }}
                formatter={(value, name) => [fmtNum(value), name === 'count' ? '请求' : '错误']}
              />
              <Line isAnimationActive={false} type="monotone" dataKey="count" stroke="#2563eb" strokeWidth={2} dot={false} activeDot={{ r: 3 }} />
              <Line isAnimationActive={false} type="monotone" dataKey="errors" stroke="#b91c1c" strokeWidth={1.5} dot={false} activeDot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className="flex h-7 items-center justify-between border-t border-slate-100 px-1 text-[11px] text-slate-500">
          <div className="flex items-center gap-3">
            <Legend color="bg-blue-600" label="请求" />
            <Legend color="bg-red-700" label="错误" />
          </div>
          <span className="font-mono tabular-nums">峰值 {fmtNum(peak)}</span>
        </div>
      </div>
    </WorkbenchSection>
  )
}

const PerformanceSummary = ({ summary }) => (
  <WorkbenchSection title="性能概览" icon={Clock3}>
    <dl className="divide-y divide-slate-100">
      <PropertyRow label="平均 TTFT" value={fmtMs(summary.avg_ttft_ms)} />
      <PropertyRow label="平均总耗时" value={fmtMs(summary.avg_duration_ms)} />
      <PropertyRow label="输入 Token" value={fmtCompact(summary.input_tokens)} />
      <PropertyRow label="输出 Token" value={fmtCompact(summary.output_tokens)} />
      <PropertyRow label="Cache 读 / 写" value={`${fmtCompact(summary.cache_r)} / ${fmtCompact(summary.cache_w)}`} />
    </dl>
  </WorkbenchSection>
)

const PropertyRow = ({ label, value }) => (
  <div className="flex h-9 items-center justify-between gap-3 px-3">
    <dt className="truncate text-xs text-slate-600">{label}</dt>
    <dd className="shrink-0 font-mono text-xs font-semibold tabular-nums text-slate-950">{value}</dd>
  </div>
)

const ProviderTraffic = ({ providers }) => {
  const max = Math.max(1, ...providers.map((provider) => Number(provider.count) || 0))

  return (
    <WorkbenchSection title="Provider 流量" icon={Server} aside={providers.length ? `${providers.length} 个` : null}>
      {providers.length === 0 ? (
        <EmptyState
          icon={Server}
          title="暂无 Provider 流量"
          description="网关收到请求后会在此显示分布。"
          className="rounded-none border-0 py-7"
        />
      ) : (
        <div className="divide-y divide-slate-100">
          {providers.slice(0, 6).map((provider) => {
            const count = Number(provider.count) || 0
            const errorRate = count > 0 ? ((Number(provider.errors) || 0) / count) * 100 : 0
            return (
              <div key={provider.name} className="px-3 py-2.5">
                <div className="flex items-center justify-between gap-3 text-xs">
                  <span className="truncate font-medium text-slate-900" title={provider.name}>{provider.name}</span>
                  <span className="shrink-0 font-mono tabular-nums text-slate-700">{fmtNum(count)}</span>
                </div>
                <div className="mt-2 h-1 overflow-hidden rounded-sm bg-slate-100" aria-hidden="true">
                  <div className="h-full bg-blue-600" style={{ width: `${Math.max((count / max) * 100, count > 0 ? 3 : 0)}%` }} />
                </div>
                <div className="mt-1.5 flex items-center justify-between gap-3 font-mono text-[10px] text-slate-500">
                  <span>TTFT {fmtMs(provider.avg_ttft_ms)}</span>
                  <span className={errorRate > 0 ? 'text-red-700' : ''}>{errorRate.toFixed(1)}% 错误</span>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </WorkbenchSection>
  )
}

const RecentRequests = ({ recent }) => (
  <WorkbenchSection title="最近请求" icon={Zap} aside={recent.length ? `最近 ${Math.min(recent.length, 8)} 条` : null}>
    <table className="w-full table-fixed" aria-label="最近请求">
      <colgroup>
        <col className="w-[68px]" />
        <col />
        <col className="w-[104px]" />
        <col className="w-[104px]" />
        <col className="w-[64px]" />
      </colgroup>
      <thead>
        <tr className="h-8 border-b border-slate-200 bg-slate-50 text-left text-[10px] font-semibold text-slate-600">
          <th className="px-3 font-semibold">时间</th>
          <th className="px-2 font-semibold">路由</th>
          <th className="px-2 font-semibold">TTFT / 总耗时</th>
          <th className="px-2 font-semibold">Token / Cache</th>
          <th className="px-2 text-right font-semibold">状态</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {recent.length === 0 && (
          <tr>
            <td colSpan={5}>
              <EmptyState
                icon={Route}
                title="暂无最近请求"
                description="Office 发出首个请求后会显示在这里。"
                className="rounded-none border-0 py-8"
              />
            </td>
          </tr>
        )}
        {recent.slice(0, 8).map((request) => {
          const failed = isFailedRequest(request)
          const routeLabel = `${request.client_model || '未知模型'} -> ${request.provider_name || '未分配'} / ${request.upstream_model || '-'}`
          const tokenLabel = `${fmtNum(request.input_tokens)} / ${fmtNum(request.output_tokens)} · C${fmtNum(request.cache_r)}`
          return (
            <tr key={request.id} className="h-10 text-xs hover:bg-slate-50/80">
              <td className="px-3 font-mono text-[11px] tabular-nums text-slate-500" title={request.ts || ''}>{fmtTime(request.ts)}</td>
              <td className="px-2">
                <div className="flex min-w-0 items-center gap-1.5 font-mono text-[11px]" title={routeLabel}>
                  <span className="max-w-[45%] truncate text-slate-800">{request.client_model || '未知模型'}</span>
                  <ArrowRight size={11} aria-hidden="true" className="shrink-0 text-slate-400" />
                  <span className="min-w-0 truncate text-slate-500">{request.provider_name || '未分配'} / {request.upstream_model || '-'}</span>
                </div>
              </td>
              <td className="px-2 font-mono text-[11px] tabular-nums text-slate-600" title={`TTFT ${fmtMs(request.ttft_ms)}，总耗时 ${fmtMs(request.duration_ms)}`}>
                {fmtMs(request.ttft_ms)} / {fmtMs(request.duration_ms)}
              </td>
              <td className="truncate px-2 font-mono text-[11px] tabular-nums text-slate-600" title={tokenLabel}>{tokenLabel}</td>
              <td className="px-2 text-right">
                <StatusBadge tone={failed ? 'danger' : 'success'} className="font-mono tabular-nums">
                  {request.status || (failed ? 'ERR' : '200')}
                </StatusBadge>
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  </WorkbenchSection>
)

const Diagnostics = ({ items }) => {
  const hasDanger = items.some((item) => item.tone === 'danger')
  return (
    <WorkbenchSection
      title="异常诊断"
      icon={AlertTriangle}
      aside={<StatusBadge tone={hasDanger ? 'danger' : 'warning'}>{items.length} 项</StatusBadge>}
    >
      <div className="divide-y divide-slate-100">
        {items.map((item) => (
          <div key={item.id} className="flex gap-2.5 px-3 py-2.5">
            <AlertTriangle size={14} aria-hidden="true" className={`mt-0.5 shrink-0 ${item.tone === 'danger' ? 'text-red-700' : item.tone === 'info' ? 'text-blue-700' : 'text-amber-700'}`} />
            <div className="min-w-0">
              <div className="text-xs font-semibold text-slate-900">{item.title}</div>
              <p className="mt-0.5 text-[11px] leading-4 text-slate-600">{item.detail}</p>
            </div>
          </div>
        ))}
      </div>
    </WorkbenchSection>
  )
}

const DashboardLoading = () => (
  <div className="space-y-3" aria-label="正在加载监控数据" aria-busy="true">
    <section className="grid grid-cols-4 divide-x divide-slate-200 overflow-hidden rounded-[4px] border border-slate-200 bg-white">
      {[0, 1, 2, 3].map((item) => (
        <div key={item} className="h-[82px] animate-pulse px-3 py-2.5">
          <div className="h-2.5 w-20 rounded-sm bg-slate-200" />
          <div className="mt-2 h-5 w-16 rounded-sm bg-slate-200" />
          <div className="mt-2 h-2.5 w-24 rounded-sm bg-slate-100" />
        </div>
      ))}
    </section>
    <div className="grid grid-cols-[minmax(0,1fr)_272px] items-start gap-3 xl:grid-cols-[minmax(0,1.45fr)_minmax(300px,0.65fr)]">
      <div className="space-y-3">
        <SkeletonPanel className="h-[282px]" />
        <SkeletonPanel className="h-[236px]" />
      </div>
      <div className="space-y-3">
        <SkeletonPanel className="h-[216px]" />
        <SkeletonPanel className="h-[204px]" />
      </div>
    </div>
  </div>
)

const SkeletonPanel = ({ className }) => (
  <div className={`animate-pulse overflow-hidden rounded-[4px] border border-slate-200 bg-white ${className}`}>
    <div className="flex h-9 items-center border-b border-slate-200 bg-slate-50 px-3">
      <div className="h-2.5 w-24 rounded-sm bg-slate-200" />
    </div>
    <div className="space-y-3 p-3">
      <div className="h-3 w-1/3 rounded-sm bg-slate-100" />
      <div className="h-3 w-4/5 rounded-sm bg-slate-100" />
      <div className="h-3 w-2/3 rounded-sm bg-slate-100" />
    </div>
  </div>
)

const DashboardUnavailable = ({ error, onRetry }) => (
  <EmptyState
    icon={AlertTriangle}
    title="监控数据暂不可用"
    description={error?.message || '请检查网关服务和当前管理令牌后重新加载。'}
    action={(
      <button type="button" onClick={onRetry} className="h-8 rounded-[4px] bg-blue-600 px-3 text-xs font-semibold text-white hover:bg-blue-700 active:translate-y-px">
        重新加载
      </button>
    )}
    className="rounded-[4px] py-12"
  />
)

const WorkbenchSection = ({ title, icon: Icon, aside, children }) => (
  <section className="min-w-0 overflow-hidden rounded-[4px] border border-slate-200 bg-white">
    <header className="flex h-9 items-center justify-between gap-3 border-b border-slate-200 bg-slate-50/80 px-3">
      <div className="flex min-w-0 items-center gap-2">
        <Icon size={14} aria-hidden="true" className="shrink-0 text-slate-500" />
        <h2 className="truncate text-xs font-semibold text-slate-900">{title}</h2>
      </div>
      {aside && <div className="shrink-0 text-[11px] text-slate-500">{aside}</div>}
    </header>
    {children}
  </section>
)

const Legend = ({ color, label }) => (
  <span className="inline-flex items-center gap-1.5">
    <span className={`h-1.5 w-1.5 rounded-full ${color}`} />
    {label}
  </span>
)
