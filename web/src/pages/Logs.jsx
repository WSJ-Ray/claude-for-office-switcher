import { Fragment, useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight, Check, ChevronDown, ChevronRight, Search } from 'lucide-react'
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

export default function Logs() {
  const [search, setSearch] = useState('')
  const [provider, setProvider] = useState('all')
  const [status, setStatus] = useState('all')
  const [expandedIds, setExpandedIds] = useState({})
  const toggleExpand = (id) => setExpandedIds((prev) => ({ ...prev, [id]: !prev[id] }))
  const { data } = useQuery({
    queryKey: ['logs'],
    queryFn: () => get('/admin/logs?limit=200'),
    refetchInterval: 5000
  })

  const all = data?.data || []
  const providerOptions = ['all', ...Array.from(new Set(all.map((log) => log.provider_name).filter(Boolean)))]

  const logs = all.filter((log) => {
    if (provider !== 'all' && log.provider_name !== provider) return false
    if (status === 'success' && isErr(log)) return false
    if (status === 'error' && !isErr(log)) return false
    if (search) {
      const query = search.toLowerCase()
      const hay = [log.client_model, log.provider_name, log.upstream_model, log.error || ''].join(' ').toLowerCase()
      if (!hay.includes(query)) return false
    }
    return true
  })

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <PageHeader
        eyebrow="Logs"
        title="请求日志"
        desc="实时请求记录：耗时、TTFT、Token、Cache 与错误信息。"
      />

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex w-full items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 md:w-96">
          <Search size={16} className="text-slate-500" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索 model / Provider / upstream / 错误"
            className="min-w-0 flex-1 bg-transparent text-sm text-slate-950 outline-none placeholder:text-slate-400"
          />
        </div>
        <Dropdown value={provider} onChange={setProvider} options={providerOptions} labelOf={(value) => (value === 'all' ? '全部 Provider' : value)} />
        <Dropdown value={status} onChange={setStatus} options={['all', 'success', 'error']} labelOf={(value) => ({ all: '全部状态', success: '成功', error: '错误' }[value])} />
        <span className="ml-auto font-mono text-xs text-slate-500">{logs.length} / {all.length} 条</span>
      </div>

      <div className="hidden overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm md:block">
        <div className="overflow-x-auto">
          <div className="min-w-[1160px]">
            <div className="grid grid-cols-[36px_110px_130px_250px_minmax(220px,1fr)_80px_90px_140px_90px_90px] gap-4 border-b border-slate-200 bg-slate-50 px-5 py-3 text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
              <div />
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

            {logs.length === 0 && <div className="px-5 py-12 text-center text-sm text-slate-500">暂无请求记录</div>}

            {logs.map((log) => (
              <LogRow
                key={log.id}
                log={log}
                expanded={!!expandedIds[log.id]}
                onToggle={() => toggleExpand(log.id)}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="grid gap-3 md:hidden">
        {logs.length === 0 && <div className="rounded-lg border border-slate-200 bg-white px-4 py-10 text-center text-sm text-slate-500">暂无请求记录</div>}
        {logs.map((log) => {
          const expanded = !!expandedIds[log.id]
          return (
            <div key={log.id} className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
              <button type="button" onClick={() => toggleExpand(log.id)} className="w-full cursor-pointer text-left">
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
              {expanded && <ExpandedLog log={log} />}
            </div>
          )
        })}
      </div>
    </div>
  )
}

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
        <div className="border-b border-slate-200 bg-slate-50 px-8 py-5">
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

const Dropdown = ({ value, onChange, options, labelOf }) => {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return
    const onDown = (event) => {
      if (ref.current && !ref.current.contains(event.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((next) => !next)}
        className="flex min-w-[150px] cursor-pointer items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-700 transition-colors hover:bg-slate-50"
      >
        <span>{labelOf(value)}</span>
        <ChevronDown size={14} className={`ml-auto text-slate-500 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute z-20 mt-2 max-h-72 min-w-full overflow-auto rounded-lg border border-slate-200 bg-white p-1 shadow-xl">
          {options.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => {
                onChange(option)
                setOpen(false)
              }}
              className={`flex w-full items-center justify-between gap-4 rounded-md px-3 py-2 text-left text-sm hover:bg-slate-50 ${
                option === value ? 'text-blue-700' : 'text-slate-700'
              }`}
            >
              <span>{labelOf(option)}</span>
              {option === value && <Check size={14} />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

const PageHeader = ({ eyebrow, title, desc }) => (
  <div>
    <p className="text-sm font-semibold uppercase tracking-[0.16em] text-blue-700">{eyebrow}</p>
    <h1 className="mt-2 text-3xl font-semibold text-slate-950">{title}</h1>
    <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">{desc}</p>
  </div>
)
