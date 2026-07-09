import { useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Boxes,
  Check,
  Copy,
  Hash,
  MessageSquare,
  MessagesSquare,
  Sparkles,
  X,
  Zap
} from 'lucide-react'
import { post, put } from '../lib/api'

const FORMATS = [
  { value: 'anthropic', label: 'Anthropic 原生', Icon: Hash, hint: '直连 Anthropic Messages' },
  { value: 'openai_chat', label: 'OpenAI Chat', Icon: MessageSquare, hint: '自动格式转换' },
  { value: 'openai_responses', label: 'OpenAI Responses', Icon: MessagesSquare, hint: 'Responses API' },
  { value: 'vertex', label: 'Vertex AI', Icon: Sparkles, hint: 'Gemini / Vertex' }
]

export default function ProviderForm({ provider, onClose }) {
  const qc = useQueryClient()
  const isEdit = !!provider
  const [form, setForm] = useState({
    name: provider?.name || '',
    format: provider?.format || 'anthropic',
    base_url: provider?.base_url || '',
    api_key: provider?.api_key || '',
    enabled: provider?.enabled ?? true,
    is_default: provider?.is_default ?? false,
    extra_config: provider?.extra_config || {}
  })
  const [extraText, setExtraText] = useState(JSON.stringify(provider?.extra_config || {}, null, 2))
  const [models, setModels] = useState(null)
  const [fetching, setFetching] = useState(false)
  const [err, setErr] = useState(null)

  const parsedExtra = useMemo(() => {
    try {
      return { ok: true, value: JSON.parse(extraText || '{}') }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  }, [extraText])

  const payload = () => ({
    ...form,
    extra_config: parsedExtra.ok ? parsedExtra.value : form.extra_config
  })

  const saveM = useMutation({
    mutationFn: (data) => isEdit ? put(`/admin/providers/${provider.id}`, data) : post('/admin/providers', data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['providers'] })
      onClose()
    },
    onError: (e) => setErr(e.message)
  })

  const fetchModels = async () => {
    if (!parsedExtra.ok) {
      setErr(`高级配置 JSON 无效：${parsedExtra.error}`)
      return
    }
    setFetching(true)
    setModels(null)
    setErr(null)
    try {
      const result = await post('/admin/providers/preview-models', payload())
      setModels(result)
    } catch (e) {
      setModels({ ok: false, error: e.message })
    } finally {
      setFetching(false)
    }
  }

  const save = () => {
    if (!parsedExtra.ok) {
      setErr(`高级配置 JSON 无效：${parsedExtra.error}`)
      return
    }
    saveM.mutate(payload())
  }

  const set = (key, value) => setForm((prev) => ({ ...prev, [key]: value }))
  const updateExtra = (key, value) => {
    const next = { ...(parsedExtra.ok ? parsedExtra.value : form.extra_config), [key]: value }
    if (!value) delete next[key]
    setExtraText(JSON.stringify(next, null, 2))
    setForm((prev) => ({ ...prev, extra_config: next }))
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 py-6" onClick={onClose}>
      <div
        className="max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
          <div>
            <h2 className="text-xl font-semibold text-slate-950">{isEdit ? '编辑 Provider' : '新增 Provider'}</h2>
            <p className="mt-1 text-sm text-slate-500">配置一个 API 端点，gateway 会按模型映射路由到它。</p>
          </div>
          <button onClick={onClose} className="rounded-lg border border-slate-200 bg-white p-2 text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-950">
            <X size={16} />
          </button>
        </div>

        <div className="space-y-6 px-6 py-6">
          <section>
            <Label>端点格式</Label>
            <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {FORMATS.map((item) => {
                const active = form.format === item.value
                return (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() => set('format', item.value)}
                    className={`rounded-lg border p-3 text-left transition-colors duration-200 ${
                      active
                        ? 'border-blue-200 bg-blue-50'
                        : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <item.Icon size={16} className={active ? 'text-blue-700' : 'text-slate-500'} />
                      {active && <Check size={15} className="text-blue-700" />}
                    </div>
                    <div className="mt-3 text-sm font-semibold text-slate-950">{item.label}</div>
                    <div className="mt-1 text-xs text-slate-500">{item.hint}</div>
                  </button>
                )
              })}
            </div>
          </section>

          <section className="grid gap-4 md:grid-cols-2">
            <Field label="名称" value={form.name} onChange={(v) => set('name', v)} placeholder="例如 DeepSeek" />
            <Field label="Base URL" value={form.base_url} onChange={(v) => set('base_url', v)} placeholder="https://api.deepseek.com/anthropic" mono />
            <Field label="API Key" value={form.api_key} onChange={(v) => set('api_key', v)} placeholder="sk-..." mono secret />
            <div className="grid grid-cols-2 gap-3">
              <Switch label="启用" on={form.enabled} onChange={(v) => set('enabled', v)} />
              <Switch label="默认 Provider" on={form.is_default} onChange={(v) => set('is_default', v)} />
            </div>
          </section>

          <section>
            <div className="flex items-center justify-between gap-3">
              <Label>高级配置 JSON</Label>
              {(form.format === 'anthropic') && (
                <button
                  type="button"
                  onClick={() => updateExtra('enable_prompt_caching', !parsedExtra.value?.enable_prompt_caching)}
                  className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                    parsedExtra.value?.enable_prompt_caching
                      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                      : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50 hover:text-slate-950'
                  }`}
                >
                  Prompt Cache
                </button>
              )}
            </div>
            <textarea
              value={extraText}
              onChange={(e) => setExtraText(e.target.value)}
              rows={5}
              className="mt-2 w-full rounded-lg border border-slate-200 bg-white px-3.5 py-3 font-mono text-xs leading-5 text-slate-950 outline-none transition-colors placeholder:text-slate-400 focus:border-blue-500"
              placeholder='{"organization":"org_xxx"}'
            />
            {!parsedExtra.ok && <p className="mt-2 text-xs text-red-700">JSON 无效：{parsedExtra.error}</p>}
          </section>

          <section className="rounded-lg border border-slate-200 bg-slate-50 p-4">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
              <div>
                <h3 className="text-sm font-semibold text-slate-950">上游模型预览</h3>
                <p className="mt-1 text-xs text-slate-500">使用当前表单配置调用上游 list models 接口。</p>
              </div>
              <button
                onClick={fetchModels}
                disabled={fetching || !form.base_url}
                className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 transition-colors hover:border-blue-200 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Boxes size={15} className="text-blue-700" />
                {fetching ? '获取中...' : '获取模型列表'}
              </button>
            </div>

            {models && (
              <div className="mt-4 rounded-lg border border-slate-200 bg-white p-3">
                {models.ok ? (
                  <>
                    <div className="text-sm text-emerald-700">
                      连接成功，共 {models.models.length} 个 model
                      {models.latency_ms != null && <span className="font-mono text-slate-500"> / {models.latency_ms}ms</span>}
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {models.models.slice(0, 8).map((model) => (
                        <button
                          key={model}
                          type="button"
                          onClick={() => navigator.clipboard?.writeText(model)}
                          className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1 font-mono text-xs text-slate-700 hover:border-blue-200"
                          title="复制 model ID"
                        >
                          <Copy size={11} className="text-slate-500" />
                          {model}
                        </button>
                      ))}
                      {models.models.length > 8 && <span className="px-2.5 py-1 text-xs text-slate-500">+ {models.models.length - 8} more</span>}
                    </div>
                  </>
                ) : (
                  <div className="text-sm text-red-700">连接失败：{models.error}</div>
                )}
              </div>
            )}
          </section>

          {err && <div className="text-sm text-red-700">{err}</div>}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-slate-200 px-6 py-4">
          <button
            onClick={fetchModels}
            disabled={fetching || !form.base_url}
            className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 transition-colors hover:border-amber-200 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Zap size={15} className="text-amber-700" />
            测试连接
          </button>
          <div className="flex gap-2">
            <button onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-950">
              取消
            </button>
            <button
              onClick={save}
              disabled={!form.name || !form.base_url || saveM.isPending || !parsedExtra.ok}
              className="rounded-lg bg-black px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saveM.isPending ? '保存中...' : '保存'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

const Label = ({ children }) => (
  <div className="text-xs font-medium uppercase tracking-[0.14em] text-slate-500">{children}</div>
)

const Field = ({ label, value, onChange, placeholder, mono, secret }) => (
  <label className="block">
    <Label>{label}</Label>
    <input
      type={secret ? 'password' : 'text'}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={`mt-2 w-full rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-950 outline-none transition-colors placeholder:text-slate-400 focus:border-blue-500 ${mono ? 'font-mono' : ''}`}
    />
  </label>
)

const Switch = ({ label, on, onChange }) => (
  <button
    type="button"
    onClick={() => onChange(!on)}
    className={`flex h-full min-h-[68px] cursor-pointer items-center justify-between gap-3 rounded-lg border px-3.5 py-3 text-left transition-colors ${
      on ? 'border-blue-200 bg-blue-50' : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'
    }`}
  >
    <span className="text-sm font-medium text-slate-950">{label}</span>
    <span className={`relative h-5 w-9 rounded-full transition-colors ${on ? 'bg-black' : 'bg-slate-300'}`}>
      <span className={`absolute top-1 h-3 w-3 rounded-full bg-white transition-transform ${on ? 'translate-x-5' : 'translate-x-1'}`} />
    </span>
  </button>
)
