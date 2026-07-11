import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronDown, Copy, Eye, LoaderCircle, X, Zap } from 'lucide-react'
import { get, post, put } from '../lib/api'
import { Dialog, IconButton, InlineNotice } from './ui'
import { switchThumbPosition } from '../lib/switch'

const FALLBACK_FORMATS = [
  { format: 'anthropic', label: 'Anthropic Messages', description: 'Anthropic Messages API compatible endpoint.', base_url_placeholder: 'https://api.deepseek.com/anthropic', extra_config_fields: [] },
  { format: 'openai_chat', label: 'OpenAI Chat Completions', description: 'OpenAI Chat Completions translated to Anthropic Messages.', base_url_placeholder: 'https://api.openai.com/v1', extra_config_fields: [] },
  { format: 'openai_responses', label: 'OpenAI Responses', description: 'OpenAI Responses translated to Anthropic Messages.', base_url_placeholder: 'https://api.openai.com/v1', extra_config_fields: [] },
  { format: 'url_adaptive', label: 'Adaptive Anthropic URL', description: 'Anthropic-compatible endpoint with flexible URL input.', base_url_placeholder: 'https://gateway.example.com/v1/anthropic', extra_config_fields: [] }
]

const initialValue = (provider) => ({
  name: provider?.name || '',
  format: provider?.format || 'anthropic',
  base_url: provider?.base_url || '',
  api_key: provider?.api_key || '',
  enabled: provider?.enabled ?? true,
  is_default: provider?.is_default ?? false,
  extra_config: provider?.extra_config || {}
})

export default function ProviderForm({ provider, onClose }) {
  const queryClient = useQueryClient()
  const isEdit = Boolean(provider)
  const [form, setForm] = useState(() => initialValue(provider))
  const [extraText, setExtraText] = useState(() => JSON.stringify(provider?.extra_config || {}, null, 2))
  const [showAdvanced, setShowAdvanced] = useState(Boolean(Object.keys(provider?.extra_config || {}).length))
  const [models, setModels] = useState(null)
  const [fetchingModels, setFetchingModels] = useState(false)
  const [error, setError] = useState(null)

  const capabilityQuery = useQuery({
    queryKey: ['provider-capabilities'],
    queryFn: () => get('/admin/provider-capabilities'),
    staleTime: 5 * 60 * 1000,
    retry: false
  })
  const formats = useMemo(() => {
    const catalog = capabilityQuery.data?.data
    return Array.isArray(catalog) && catalog.length ? catalog : FALLBACK_FORMATS
  }, [capabilityQuery.data])
  const selectedFormat = formats.find((item) => item.format === form.format) || formats[0]
  const parsedExtra = useMemo(() => {
    try {
      return { value: JSON.parse(extraText || '{}'), error: null }
    } catch (parseError) {
      return { value: null, error: '高级配置必须是有效的 JSON。' }
    }
  }, [extraText])

  const updateForm = (key, value) => setForm((current) => ({ ...current, [key]: value }))
  const updateExtra = (key, value) => {
    const next = { ...(parsedExtra.value || form.extra_config), [key]: value }
    if (value === '') delete next[key]
    updateForm('extra_config', next)
    setExtraText(JSON.stringify(next, null, 2))
  }
  const providerPayload = () => ({ ...form, extra_config: parsedExtra.value || form.extra_config })

  const saveProvider = useMutation({
    mutationFn: (payload) => isEdit
      ? put(`/admin/providers/${provider.id}`, payload)
      : post('/admin/providers', payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['providers'] })
      queryClient.invalidateQueries({ queryKey: ['mappings'] })
      onClose()
    },
    onError: (mutationError) => setError(mutationError.message || '保存 Provider 失败。')
  })

  const previewModels = async () => {
    if (!parsedExtra.value) {
      setError(parsedExtra.error)
      return
    }
    setFetchingModels(true)
    setError(null)
    setModels(null)
    try {
      setModels(await post('/admin/providers/preview-models', providerPayload()))
    } catch (requestError) {
      setModels({ ok: false, error: requestError.message || '无法读取模型列表。' })
    } finally {
      setFetchingModels(false)
    }
  }

  const copyModel = async (model) => {
    try {
      await navigator.clipboard.writeText(model)
    } catch {
      setError('无法复制模型 ID，请手动选择复制。')
    }
  }

  return (
    <Dialog open onClose={onClose} ariaLabel={isEdit ? '编辑 Provider' : '新增 Provider'} className="max-w-3xl">
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault()
          if (!parsedExtra.value) {
            setError(parsedExtra.error)
            return
          }
          saveProvider.mutate(providerPayload())
        }}
      >
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4 sm:px-6 sm:py-5">
          <div>
            <h2 className="text-lg font-semibold text-slate-950">{isEdit ? '编辑 Provider' : '新增 Provider'}</h2>
            <p className="mt-1 text-sm text-slate-500">配置上游端点，再在模型映射中决定其参与的路由队列。</p>
          </div>
          <IconButton label="关闭" onClick={onClose} disabled={saveProvider.isPending} className="shrink-0 border-0">
            <X size={18} />
          </IconButton>
        </div>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5 sm:px-6 sm:py-6">
          <section>
            <Label>端点格式</Label>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {formats.map((item) => {
                const active = form.format === item.format
                return (
                  <button
                    key={item.format}
                    type="button"
                    aria-pressed={active}
                    onClick={() => { updateForm('format', item.format); setModels(null); setError(null) }}
                    className={`min-h-24 rounded-lg border p-3 text-left transition-colors ${active ? 'border-cyan-300 bg-cyan-50' : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'}`}
                  >
                    <span className="flex items-center justify-between gap-3">
                      <span className="text-sm font-semibold text-slate-950">{item.label}</span>
                      {active && <Check size={16} className="text-cyan-700" />}
                    </span>
                    <span className="mt-2 block text-xs leading-5 text-slate-500">{item.description}</span>
                  </button>
                )
              })}
            </div>
            {capabilityQuery.isError && <p className="mt-2 text-xs text-amber-700">无法读取运行时能力目录，当前显示兼容格式。</p>}
          </section>

          <section className="grid gap-4 md:grid-cols-2">
            <Field label="名称" value={form.name} onChange={(value) => updateForm('name', value)} placeholder="例如 DeepSeek" autoFocus />
            <Field label="Base URL" value={form.base_url} onChange={(value) => updateForm('base_url', value)} placeholder={selectedFormat?.base_url_placeholder || 'https://api.example.com'} mono />
            <Field label="API Key" value={form.api_key} onChange={(value) => updateForm('api_key', value)} placeholder={isEdit ? '留空或保持掩码表示不修改' : 'sk-...'} mono secret />
            <div className="grid grid-cols-2 gap-3">
              <Toggle label="启用" checked={form.enabled} onChange={(value) => updateForm('enabled', value)} />
              <Toggle label="默认 Provider" checked={form.is_default} onChange={(value) => updateForm('is_default', value)} />
            </div>
          </section>

          <section>
            <button type="button" onClick={() => setShowAdvanced((value) => !value)} aria-expanded={showAdvanced} className="flex w-full items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-3 text-left hover:bg-slate-100">
              <span>
                <span className="block text-sm font-semibold text-slate-950">高级配置</span>
                <span className="mt-0.5 block text-xs text-slate-500">仅传递该 Provider 所需的扩展参数。</span>
              </span>
              <ChevronDown size={17} className={showAdvanced ? 'rotate-180 transition-transform' : 'transition-transform'} />
            </button>
            {showAdvanced && (
              <div className="mt-2 space-y-3 rounded-lg border border-slate-200 p-3.5">
                {(selectedFormat?.extra_config_fields || []).map((field) => field.type === 'boolean' ? (
                  <Toggle key={field.key} label={field.label} checked={Boolean(parsedExtra.value?.[field.key] ?? field.default)} onChange={(value) => updateExtra(field.key, value)} compact />
                ) : (
                  <Field key={field.key} label={field.label} value={parsedExtra.value?.[field.key] || ''} onChange={(value) => updateExtra(field.key, value)} placeholder={field.placeholder || ''} />
                ))}
                <label className="block">
                  <Label>原始 JSON</Label>
                  <textarea value={extraText} onChange={(event) => setExtraText(event.target.value)} rows={5} className="mt-2 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono text-xs leading-5 text-slate-950" placeholder='{"organization":"org_xxx"}' />
                </label>
                {parsedExtra.error && <InlineNotice tone="danger">{parsedExtra.error}</InlineNotice>}
              </div>
            )}
          </section>

          <section className="rounded-lg border border-slate-200 bg-slate-50 p-4">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
              <div>
                <h3 className="text-sm font-semibold text-slate-950">模型列表预览</h3>
                <p className="mt-1 text-xs leading-5 text-slate-500">仅验证上游模型列表与该端点鉴权；不会验证映射、消息转换或流式响应。</p>
              </div>
              <button type="button" onClick={previewModels} disabled={fetchingModels || !form.base_url} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 text-sm font-medium text-slate-700 hover:border-cyan-300 hover:bg-cyan-50 disabled:cursor-not-allowed disabled:opacity-50">
                {fetchingModels ? <LoaderCircle size={16} className="animate-spin" /> : <Eye size={16} />}
                {fetchingModels ? '读取中' : '读取模型'}
              </button>
            </div>
            {models && (
              <div className="mt-3">
                {models.ok ? (
                  <div className="rounded-lg border border-emerald-200 bg-white p-3">
                    <p className="text-sm text-emerald-800">发现 {models.models?.length || 0} 个模型。</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {(models.models || []).slice(0, 12).map((model) => <button key={model} type="button" onClick={() => copyModel(model)} className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 font-mono text-xs text-slate-700 hover:border-cyan-300"><Copy size={12} />{model}</button>)}
                    </div>
                  </div>
                ) : <InlineNotice tone="danger">读取失败：{models.error}</InlineNotice>}
              </div>
            )}
          </section>
          {error && <InlineNotice tone="danger">{error}</InlineNotice>}
        </div>

        <div className="flex flex-col-reverse justify-between gap-3 border-t border-slate-200 px-5 py-4 sm:flex-row sm:items-center sm:px-6">
          <p className="text-xs text-slate-500">保存后即可在模型映射中加入路由队列。</p>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} disabled={saveProvider.isPending} className="min-h-11 rounded-lg px-4 text-sm text-slate-600 hover:bg-slate-100">取消</button>
            <button type="submit" disabled={!form.name || !form.base_url || !form.api_key || saveProvider.isPending || Boolean(parsedExtra.error)} className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-slate-950 px-4 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50">
              {saveProvider.isPending ? <LoaderCircle size={16} className="animate-spin" /> : <Zap size={16} />}
              {saveProvider.isPending ? '保存中' : '保存 Provider'}
            </button>
          </div>
        </div>
      </form>
    </Dialog>
  )
}

function Label({ children }) {
  return <span className="text-xs font-medium text-slate-600">{children}</span>
}

function Field({ label, value, onChange, placeholder, mono = false, secret = false, autoFocus = false }) {
  return <label className="block"><Label>{label}</Label><input data-autofocus={autoFocus || undefined} type={secret ? 'password' : 'text'} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} className={`mt-1.5 min-h-11 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-950 placeholder:text-slate-400 ${mono ? 'font-mono' : ''}`} /></label>
}

function Toggle({ label, checked, onChange, compact = false }) {
  return <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className={`flex w-full items-center justify-between gap-3 rounded-lg border px-3 ${compact ? 'min-h-11' : 'min-h-[68px]'} ${checked ? 'border-cyan-300 bg-cyan-50' : 'border-slate-200 bg-white hover:bg-slate-50'}`}><span className="text-sm font-medium text-slate-900">{label}</span><span className={`relative h-5 w-9 rounded-full ${checked ? 'bg-cyan-700' : 'bg-slate-300'}`}><span className={`absolute top-1 h-3 w-3 rounded-full bg-white transition-transform ${switchThumbPosition(checked)}`} /></span></button>
}
