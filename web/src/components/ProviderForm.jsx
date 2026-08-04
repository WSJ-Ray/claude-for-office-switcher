import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, Copy, Eye, Save, X } from 'lucide-react'
import { get, post, put } from '../lib/api'
import { canSaveProvider, providerPreviewPayload } from '../lib/provider-view'
import { Dialog, IconButton, InlineNotice, Spinner, StatusBadge } from './ui'

const FALLBACK_FORMATS = [
  { format: 'anthropic', label: 'Anthropic Messages', description: 'Anthropic Messages API compatible endpoint.', base_url_placeholder: 'https://api.deepseek.com/anthropic', extra_config_fields: [] },
  { format: 'openai_chat', label: 'OpenAI Chat Completions', description: 'OpenAI Chat Completions translated to Anthropic Messages.', base_url_placeholder: 'https://api.openai.com/v1', extra_config_fields: [] },
  { format: 'openai_responses', label: 'OpenAI Responses', description: 'OpenAI Responses translated to Anthropic Messages.', base_url_placeholder: 'https://api.openai.com/v1', extra_config_fields: [{ key: 'store', label: 'Store responses upstream', type: 'boolean', default: true }] },
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

/** 新增或编辑 Provider 的桌面属性面板。 */
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
    } catch {
      return { value: null, error: '高级配置必须是有效的 JSON。' }
    }
  }, [extraText])
  const canSave = canSaveProvider({ form, isEdit, extraError: parsedExtra.error })

  const updateForm = (key, value) => {
    setForm((current) => ({ ...current, [key]: value }))
    setError(null)
  }
  const updateExtra = (key, value) => {
    const next = { ...(parsedExtra.value || form.extra_config), [key]: value }
    if (value === '') delete next[key]
    updateForm('extra_config', next)
    setExtraText(JSON.stringify(next, null, 2))
  }
  const payload = () => ({ ...form, extra_config: parsedExtra.value || form.extra_config })

  const saveProvider = useMutation({
    mutationFn: (data) => isEdit
      ? put(`/admin/providers/${provider.id}`, data)
      : post('/admin/providers', data),
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
      setModels(await post('/admin/providers/preview-models', providerPreviewPayload({
        form,
        providerId: provider?.id,
        extraConfig: parsedExtra.value
      })))
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

  const pending = saveProvider.isPending

  return (
    <Dialog
      open
      placement="right"
      onClose={pending ? undefined : onClose}
      closeOnBackdrop={!pending}
      ariaLabel={isEdit ? '编辑 Provider' : '新增 Provider'}
      className="max-w-[440px]"
    >
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault()
          if (!canSave) {
            setError(parsedExtra.error || '请填写名称、Base URL 和必需的 API Key。')
            return
          }
          saveProvider.mutate(payload())
        }}
      >
        <header className="flex min-h-[52px] items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--surface-subtle)] px-4 py-2">
          <div className="min-w-0">
            <h2 className="truncate text-[15px] font-semibold leading-5 text-[var(--text-primary)]">
              {isEdit ? '编辑 Provider' : '新增 Provider'}
            </h2>
            <p className="truncate text-[11px] leading-4 text-[var(--text-muted)]">
              {isEdit ? `ID ${provider.id} · ${provider.name}` : '配置上游端点与路由参与状态'}
            </p>
          </div>
          <IconButton label="关闭" size="sm" onClick={onClose} disabled={pending} className="border-transparent bg-transparent">
            <X size={16} />
          </IconButton>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <PanelSection title="连接">
            <Field label="名称" value={form.name} onChange={(value) => updateForm('name', value)} placeholder="例如 DeepSeek" autoFocus />
            <label className="block">
              <Label>端点格式</Label>
              <select
                value={form.format}
                onChange={(event) => {
                  updateForm('format', event.target.value)
                  setModels(null)
                }}
                className="desktop-select mt-1 w-full"
              >
                {formats.map((item) => <option key={item.format} value={item.format}>{item.label}</option>)}
              </select>
              {selectedFormat?.description ? <p className="mt-1 text-[11px] leading-4 text-[var(--text-muted)]">{selectedFormat.description}</p> : null}
            </label>
            {capabilityQuery.isError ? <InlineNotice tone="warning">无法读取运行时能力目录，当前显示兼容格式。</InlineNotice> : null}
            <Field
              label="Base URL"
              value={form.base_url}
              onChange={(value) => updateForm('base_url', value)}
              placeholder={selectedFormat?.base_url_placeholder || 'https://api.example.com'}
              mono
            />
            <Field
              label="API Key"
              value={form.api_key}
              onChange={(value) => updateForm('api_key', value)}
              placeholder={isEdit ? '留空或保留掩码表示不修改' : 'sk-...'}
              helper={isEdit ? '留空或保持当前掩码均不会覆盖已保存的 Key。' : undefined}
              mono
              secret
            />
          </PanelSection>

          <PanelSection title="运行状态">
            <PropertyToggle
              label="启用 Provider"
              description="允许该端点参与已配置的故障转移队列。"
              checked={form.enabled}
              onChange={(value) => updateForm('enabled', value)}
            />
            <PropertyToggle
              label="设为默认 Provider"
              description="作为没有显式路由时的默认上游端点。"
              checked={form.is_default}
              onChange={(value) => updateForm('is_default', value)}
            />
          </PanelSection>

          <section className="border-b border-[var(--border)]">
            <button
              type="button"
              onClick={() => setShowAdvanced((value) => !value)}
              aria-expanded={showAdvanced}
              className="flex h-9 w-full items-center justify-between px-4 text-left text-xs font-semibold text-[var(--text-secondary)] transition-colors duration-150 hover:bg-[var(--surface-hover)]"
            >
              <span>高级配置</span>
              <ChevronDown size={15} className={`transition-transform duration-150 ${showAdvanced ? 'rotate-180' : ''}`} />
            </button>
            {showAdvanced ? (
              <div className="space-y-3 border-t border-[var(--border-subtle)] px-4 py-3">
                {(selectedFormat?.extra_config_fields || []).map((field) => field.type === 'boolean' ? (
                  <PropertyToggle
                    key={field.key}
                    label={field.label}
                    checked={Boolean(parsedExtra.value?.[field.key] ?? field.default)}
                    onChange={(value) => updateExtra(field.key, value)}
                    compact
                  />
                ) : (
                  <Field
                    key={field.key}
                    label={field.label}
                    value={parsedExtra.value?.[field.key] || ''}
                    onChange={(value) => updateExtra(field.key, value)}
                    placeholder={field.placeholder || ''}
                  />
                ))}
                <label className="block">
                  <Label>原始 JSON</Label>
                  <textarea
                    value={extraText}
                    onChange={(event) => {
                      setExtraText(event.target.value)
                      setError(null)
                    }}
                    rows={5}
                    spellCheck="false"
                    className="desktop-input mt-1 !h-auto min-h-24 w-full resize-y py-2 font-mono leading-4"
                    placeholder='{"organization":"org_xxx"}'
                  />
                </label>
                {parsedExtra.error ? <InlineNotice tone="danger">{parsedExtra.error}</InlineNotice> : null}
              </div>
            ) : null}
          </section>

          <PanelSection
            title="模型发现"
            action={(
              <button
                type="button"
                onClick={previewModels}
                disabled={fetchingModels || !form.base_url || (!isEdit && !form.api_key)}
                className="desktop-button"
              >
                {fetchingModels ? <Spinner /> : <Eye size={14} />}
                {fetchingModels ? '读取中' : '读取模型'}
              </button>
            )}
          >
            <p className="text-[11px] leading-4 text-[var(--text-muted)]">验证模型列表端点与鉴权，不验证映射、格式转换或流式响应。</p>
            {models ? (
              models.ok ? (
                <div className="overflow-hidden rounded border border-[var(--border)]">
                  <div className="flex h-8 items-center justify-between border-b border-[var(--border-subtle)] bg-[var(--surface-subtle)] px-2">
                    <StatusBadge tone="success">读取成功</StatusBadge>
                    <span className="font-mono text-[10px] text-[var(--text-muted)]">{models.models?.length || 0} 个模型</span>
                  </div>
                  <div className="max-h-40 divide-y divide-[var(--border-subtle)] overflow-y-auto">
                    {(models.models || []).slice(0, 20).map((model) => (
                      <button
                        key={model}
                        type="button"
                        onClick={() => copyModel(model)}
                        title={`复制 ${model}`}
                        className="flex h-7 w-full items-center justify-between gap-2 px-2 text-left font-mono text-[10px] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
                      >
                        <span className="truncate">{model}</span>
                        <Copy size={12} className="shrink-0 text-[var(--text-tertiary)]" />
                      </button>
                    ))}
                    {!models.models?.length ? <div className="px-2 py-3 text-center text-[11px] text-[var(--text-muted)]">上游未返回模型。</div> : null}
                  </div>
                </div>
              ) : <InlineNotice tone="danger">读取失败：{models.error}</InlineNotice>
            ) : null}
          </PanelSection>

          {error ? <div className="px-4 py-3"><InlineNotice tone="danger">{error}</InlineNotice></div> : null}
        </div>

        <footer className="flex min-h-[52px] items-center justify-end gap-2 border-t border-[var(--border)] bg-[var(--surface-subtle)] px-4 py-2">
          <button type="button" onClick={onClose} disabled={pending} className="desktop-button">取消</button>
          <button type="submit" disabled={!canSave || pending} className="desktop-button desktop-button-primary min-w-24">
            {pending ? <Spinner /> : <Save size={14} />}
            {pending ? '保存中' : '保存 Provider'}
          </button>
        </footer>
      </form>
    </Dialog>
  )
}

function PanelSection({ title, action, children }) {
  return (
    <section className="border-b border-[var(--border)] px-4 py-3">
      <div className="mb-2 flex min-h-7 items-center justify-between gap-3">
        <h3 className="text-xs font-semibold text-[var(--text-secondary)]">{title}</h3>
        {action}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  )
}

function Label({ children }) {
  return <span className="text-[11px] font-medium text-[var(--text-secondary)]">{children}</span>
}

function Field({ label, value, onChange, placeholder, helper, mono = false, secret = false, autoFocus = false }) {
  return (
    <label className="block">
      <Label>{label}</Label>
      <input
        data-autofocus={autoFocus || undefined}
        type={secret ? 'password' : 'text'}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        spellCheck={mono ? 'false' : undefined}
        className={`desktop-input mt-1 w-full ${mono ? 'font-mono' : ''}`}
      />
      {helper ? <span className="mt-1 block text-[10px] leading-4 text-[var(--text-muted)]">{helper}</span> : null}
    </label>
  )
}

function PropertyToggle({ label, description, checked, onChange, compact = false }) {
  return (
    <label className={`flex cursor-pointer items-center justify-between gap-3 rounded border border-[var(--border-subtle)] px-2.5 hover:bg-[var(--surface-hover)] ${compact ? 'min-h-8' : 'min-h-10 py-1.5'}`}>
      <span className="min-w-0">
        <span className="block text-xs font-medium text-[var(--text-primary)]">{label}</span>
        {description ? <span className="block text-[10px] leading-4 text-[var(--text-muted)]">{description}</span> : null}
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="h-3.5 w-3.5 shrink-0 cursor-pointer rounded-sm border-slate-400"
        style={{ accentColor: 'var(--accent)' }}
      />
    </label>
  )
}
