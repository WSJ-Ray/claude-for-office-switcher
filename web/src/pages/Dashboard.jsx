import { useQuery } from '@tanstack/react-query'
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Clock3,
  DatabaseZap,
  Gauge,
  Route,
  Server,
  Zap
} from 'lucide-react'
import { get } from '../lib/api'

const fmtMs = (ms) => (ms == null ? '-' : `${(ms / 1000).toFixed(2)}s`)
const fmtNum = (n) => Number(n || 0).toLocaleString()
const fmtCompact = (n) =>
  Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(n || 0))

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

const toneClass = {
  blue: 'border-blue-100 bg-blue-50 text-blue-700',
  emerald: 'border-emerald-100 bg-emerald-50 text-emerald-700',
  amber: 'border-amber-100 bg-amber-50 text-amber-700',
  slate: 'border-slate-200 bg-slate-50 text-slate-700',
  red: 'border-red-100 bg-red-50 text-red-700'
}

const statusOf = (stats, providers, errorRate) => {
  if (!providers.length) return { label: '需要配置 Provider', tone: 'amber' }
  if (Number(errorRate) >= 5) return { label: '错误率偏高', tone: 'red' }
  if ((stats?.recent || []).some((item) => (item.status || 0) >= 400 || item.error)) {
    return { label: '存在失败请求', tone: 'amber' }
  }
  return { label: '运行正常', tone: 'emerald' }
}

const MetricCard = ({ icon: Icon, label, value, detail, tone = 'blue' }) => (
  <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-xs font-medium text-slate-500">{label}</p>
        <div className="mt-2 truncate text-2xl font-semibold leading-none text-slate-950">{value}</div>
      </div>
      <div className={`rounded-lg border p-2 ${toneClass[tone]}`}>
        <Icon size={17} aria-hidden="true" />
      </div>
    </div>
    <p className="mt-3 truncate text-sm text-slate-500">{detail}</p>
  </div>
)

const RequestTrend = ({ hourly }) => {
  const chartData = hourly.length > 0
    ? hourly.slice(-24)
    : Array.from({ length: 24 }, (_, i) => ({ hour: `${String(i).padStart(2, '0')}:00`, count: 0, errors: 0 }))
  const max = Math.max(1, ...chartData.map((item) => item.count))
  const hasTraffic = chartData.some((item) => item.count > 0)
  const tickIndexes = chartData
    .map((_, index) => index)
    .filter((index) => index % 4 === 0 || index === chartData.length - 1)

  return (
    <Panel title="24 小时请求趋势" icon={BarChart3} aside={hasTraffic ? `峰值 ${fmtNum(max)}` : '等待流量'}>
      <div>
        <div className="flex h-52 items-end gap-2 border-b border-slate-200 pb-3">
          {chartData.map((item, index) => {
            const height = Math.max(4, (item.count / max) * 100)
            const errorHeight = item.count > 0 ? Math.max(3, (item.errors / item.count) * height) : 0
            return (
              <div key={`${item.hour}-${index}`} className="flex h-full min-w-0 flex-1 flex-col justify-end">
                <div className="relative flex min-h-1 flex-1 items-end rounded-sm bg-slate-100">
                  <div
                    className="w-full rounded-sm bg-blue-500"
                    style={{ height: `${height}%` }}
                    title={`${item.hour} 请求 ${item.count}`}
                  />
                  {item.errors > 0 && (
                    <div
                      className="absolute bottom-0 left-0 w-full rounded-sm bg-amber-400"
                      style={{ height: `${errorHeight}%` }}
                      title={`${item.hour} 错误 ${item.errors}`}
                    />
                  )}
                </div>
              </div>
            )
          })}
        </div>
        <div className="relative mt-2 h-4 font-mono text-[11px] text-slate-500">
          {tickIndexes.map((index) => {
            const isFirst = index === 0
            const isLast = index === chartData.length - 1
            const left = chartData.length > 1 ? (index / (chartData.length - 1)) * 100 : 0
            return (
              <span
                key={`${chartData[index].hour}-${index}`}
                className="absolute whitespace-nowrap"
                style={{ left: `${left}%`, transform: isFirst ? 'translateX(0)' : isLast ? 'translateX(-100%)' : 'translateX(-50%)' }}
              >
                {chartData[index].hour}
              </span>
            )
          })}
        </div>
      </div>
      <div className="mt-3 flex items-center gap-4 text-xs text-slate-500">
        <Legend color="bg-blue-500" label="请求" />
        <Legend color="bg-amber-400" label="错误" />
      </div>
    </Panel>
  )
}

const ProviderBars = ({ providers }) => {
  const max = Math.max(1, ...providers.map((provider) => provider.count))

  return (
    <div className="space-y-4">
      {providers.length === 0 && <EmptyState>暂无 Provider 流量</EmptyState>}
      {providers.slice(0, 6).map((provider) => {
        const pct = (provider.count / max) * 100
        const errorPct = provider.count > 0 ? (provider.errors / provider.count) * 100 : 0
        return (
          <div key={provider.name} className="space-y-2">
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="truncate font-medium text-slate-900">{provider.name}</span>
              <span className="font-mono text-xs text-slate-500">{fmtNum(provider.count)} 次</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-slate-100">
              <div
                className={errorPct > 0 ? 'h-full rounded-full bg-amber-400' : 'h-full rounded-full bg-blue-500'}
                style={{ width: `${Math.max(pct, provider.count > 0 ? 5 : 0)}%` }}
              />
            </div>
            <div className="flex justify-between text-xs text-slate-500">
              <span>TTFT {fmtMs(provider.avg_ttft_ms)}</span>
              <span>{errorPct.toFixed(1)}% 错误</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

const RecentActivity = ({ recent }) => (
  <div className="space-y-2">
    {recent.length === 0 && <EmptyState>暂无最近请求</EmptyState>}
    {recent.slice(0, 8).map((item) => {
      const failed = (item.status || 0) >= 400 || item.error
      return (
        <div key={item.id} className="grid grid-cols-[76px_minmax(0,1fr)_80px_70px] items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm">
          <span className="font-mono text-xs text-slate-500">{String(item.ts || '').slice(11, 19) || '--:--:--'}</span>
          <span className="truncate text-slate-800">{item.client_model || '未知 model'}</span>
          <span className="truncate font-mono text-xs text-slate-500">{fmtMs(item.duration_ms)}</span>
          <span className={`justify-self-end rounded-full border px-2 py-0.5 font-mono text-xs ${failed ? 'border-amber-200 bg-amber-50 text-amber-700' : 'border-emerald-200 bg-emerald-50 text-emerald-700'}`}>
            {item.status || (failed ? 'ERR' : '200')}
          </span>
        </div>
      )
    })}
  </div>
)

const Checklist = ({ providers, mappingsCount, summary }) => {
  const items = [
    {
      label: 'Provider 已配置',
      ok: providers.length > 0,
      detail: providers.length > 0 ? `${providers.length} 个 Provider` : '请先新增 upstream Provider'
    },
    {
      label: '存在启用 Provider',
      ok: providers.some((provider) => provider.enabled),
      detail: providers.some((provider) => provider.enabled) ? '可接收路由请求' : '至少启用一个 Provider'
    },
    {
      label: 'model 映射',
      ok: mappingsCount > 0,
      detail: mappingsCount > 0 ? `${mappingsCount} 条映射` : '未配置映射时会依赖默认路由'
    },
    {
      label: '错误率',
      ok: summary.total === 0 || (summary.errors / summary.total) < 0.05,
      detail: summary.total === 0 ? '暂无请求' : `${((summary.errors / summary.total) * 100).toFixed(1)}%`
    }
  ]

  return (
    <Panel title="配置检查" icon={Route}>
      <div className="space-y-3">
        {items.map((item) => (
          <div key={item.label} className="flex items-start gap-3 rounded-lg border border-slate-200 bg-white px-3 py-3">
            <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${item.ok ? 'bg-emerald-500' : 'bg-amber-400'}`} />
            <div className="min-w-0">
              <div className="font-medium text-slate-900">{item.label}</div>
              <div className="mt-1 text-sm text-slate-500">{item.detail}</div>
            </div>
          </div>
        ))}
      </div>
    </Panel>
  )
}

export default function Dashboard() {
  const { data: stats, isFetching } = useQuery({
    queryKey: ['stats'],
    queryFn: () => get('/admin/stats'),
    refetchInterval: 5000
  })
  const { data: providers } = useQuery({
    queryKey: ['providers'],
    queryFn: () => get('/admin/providers'),
    refetchInterval: 5000
  })

  const summary = stats?.summary || summaryFallback
  const providerList = providers?.data || []
  const enabledProviders = providerList.filter((provider) => provider.enabled).length
  const totalTokens = (Number(summary.input_tokens) || 0) + (Number(summary.output_tokens) || 0)
  const errorRate = summary.total > 0 ? ((summary.errors / summary.total) * 100).toFixed(1) : '0.0'
  const cacheDenom = (Number(summary.input_tokens) || 0) + (Number(summary.cache_r) || 0) + (Number(summary.cache_w) || 0)
  const cacheHit = cacheDenom > 0 ? `${(((Number(summary.cache_r) || 0) / cacheDenom) * 100).toFixed(1)}%` : '-'
  const serviceStatus = statusOf(stats, providerList, errorRate)

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <section className="flex flex-col justify-between gap-4 border-b border-slate-200 pb-5 lg:flex-row lg:items-end">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-3xl font-semibold text-slate-950">控制台概览</h1>
            <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${toneClass[serviceStatus.tone]}`}>
              <span className="h-1.5 w-1.5 rounded-full bg-current" />
              {serviceStatus.label}
            </span>
          </div>
          <p className="mt-2 text-sm text-slate-500">
            实时查看请求、Provider、Token、TTFT 与 Cache 指标。
          </p>
        </div>
        <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-500">
          <Activity size={14} className={isFetching ? 'text-blue-600' : 'text-slate-400'} />
          {isFetching ? '正在刷新' : '每 5 秒自动刷新'}
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard icon={Gauge} label="总请求数" value={fmtCompact(summary.total)} detail={`${fmtNum(summary.errors)} 个失败请求`} tone={Number(errorRate) > 5 ? 'amber' : 'blue'} />
        <MetricCard icon={AlertTriangle} label="错误率" value={`${errorRate}%`} detail={`平均延迟 ${fmtMs(summary.avg_duration_ms)}`} tone={Number(errorRate) > 5 ? 'red' : 'emerald'} />
        <MetricCard icon={DatabaseZap} label="Token 用量" value={fmtCompact(totalTokens)} detail={`Cache 命中 ${cacheHit}`} tone="slate" />
        <MetricCard icon={Server} label="Provider" value={`${enabledProviders}/${providerList.length}`} detail={`${fmtNum(stats?.mappings_count || 0)} 个已映射 model`} tone="amber" />
      </section>

      <section className="grid gap-5 xl:grid-cols-[1.25fr_0.75fr]">
        <RequestTrend hourly={stats?.hourly || []} />
        <Panel title="关键延迟" icon={Clock3}>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
            <LatencyItem label="平均 TTFT" value={fmtMs(summary.avg_ttft_ms)} />
            <LatencyItem label="平均总耗时" value={fmtMs(summary.avg_duration_ms)} />
            <LatencyItem label="输入 Token" value={fmtCompact(summary.input_tokens)} />
            <LatencyItem label="输出 Token" value={fmtCompact(summary.output_tokens)} />
          </div>
        </Panel>
      </section>

      <section className="grid gap-5 lg:grid-cols-[0.9fr_1.1fr]">
        <Panel title="Provider 流量" icon={BarChart3}>
          <ProviderBars providers={stats?.by_provider || []} />
        </Panel>
        <Panel title="最近请求" icon={Zap}>
          <RecentActivity recent={stats?.recent || []} />
        </Panel>
      </section>

      <Checklist providers={providerList} mappingsCount={stats?.mappings_count || 0} summary={summary} />
    </div>
  )
}

const Panel = ({ title, icon: Icon, aside, children }) => (
  <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
    <div className="mb-5 flex items-center justify-between gap-4">
      <div className="flex items-center gap-2">
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-2 text-slate-600">
          <Icon size={17} aria-hidden="true" />
        </div>
        <h2 className="text-base font-semibold text-slate-950">{title}</h2>
      </div>
      {aside && <span className="font-mono text-xs text-slate-500">{aside}</span>}
    </div>
    {children}
  </div>
)

const LatencyItem = ({ label, value }) => (
  <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
    <div className="text-xs text-slate-500">{label}</div>
    <div className="mt-1 font-mono text-xl font-semibold text-slate-950">{value}</div>
  </div>
)

const Legend = ({ color, label }) => (
  <span className="inline-flex items-center gap-1.5">
    <span className={`h-2 w-2 rounded-full ${color}`} />
    {label}
  </span>
)

const EmptyState = ({ children }) => (
  <div className="rounded-lg border border-dashed border-slate-200 bg-white px-4 py-8 text-center text-sm text-slate-500">
    {children}
  </div>
)
