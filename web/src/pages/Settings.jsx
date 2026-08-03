import { useCallback, useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  CheckCircle2,
  CircleAlert,
  Download,
  KeyRound,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldAlert,
  Wrench
} from 'lucide-react'
import {
  Dialog,
  IconButton,
  InlineNotice,
  PageToolbar,
  Spinner,
  StatusBadge
} from '../components/ui'
import {
  getOfficeStatus,
  getSettings,
  repairOfficeConflicts,
  removeOffice,
  setupOffice,
  updateSettings
} from '../lib/api'
import { getOfficeUiState } from '../lib/office'

const HOST_DETAILS = {
  word: { title: 'Word', process: 'WINWORD.EXE' },
  powerpoint: { title: 'PowerPoint', process: 'POWERPNT.EXE' },
  excel: { title: 'Excel', process: 'EXCEL.EXE' }
}

const STATUS_COPY = {
  conflict: { label: '注册冲突', tone: 'danger' },
  managed: { label: '已托管', tone: 'success' },
  official: { label: '官方插件已检测', tone: 'info' },
  available: { label: '可配置', tone: 'neutral' },
  unavailable: { label: '未检测到', tone: 'neutral' }
}

/** 管理网关令牌和本机 Office 集成设置。 */
export default function Settings() {
  const queryClient = useQueryClient()
  const [token, setTokenInput] = useState('')
  const [saved, setSaved] = useState(false)
  const [tokenError, setTokenError] = useState(null)
  const [officeNotice, setOfficeNotice] = useState(null)
  const [repairOpen, setRepairOpen] = useState(false)

  const settingsQuery = useQuery({ queryKey: ['settings'], queryFn: getSettings })
  const officeQuery = useQuery({ queryKey: ['office-status'], queryFn: getOfficeStatus })

  useEffect(() => {
    if (!saved) return undefined
    const timer = window.setTimeout(() => setSaved(false), 3000)
    return () => window.clearTimeout(timer)
  }, [saved])

  const refreshOffice = async () => {
    await queryClient.invalidateQueries({ queryKey: ['office-status'] })
  }

  const saveMutation = useMutation({
    mutationFn: updateSettings,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['settings'] }),
        queryClient.invalidateQueries({ queryKey: ['office-status'] })
      ])
      setSaved(true)
      setTokenError(null)
    },
    onError: (error) => setTokenError(error.message)
  })
  const setupMutation = useMutation({
    mutationFn: setupOffice,
    onSuccess: async (result) => {
      await refreshOffice()
      setOfficeNotice({ type: 'success', restart: result.restart_required })
    },
    onError: (error) => setOfficeNotice({ type: 'error', message: error.message })
  })
  const removeMutation = useMutation({
    mutationFn: removeOffice,
    onSuccess: async (result) => {
      await refreshOffice()
      setOfficeNotice({ type: 'removed', restart: result.restart_required })
    },
    onError: (error) => setOfficeNotice({ type: 'error', message: error.message })
  })
  const repairMutation = useMutation({
    mutationFn: repairOfficeConflicts,
    onSuccess: async (result) => {
      setRepairOpen(false)
      await refreshOffice()
      setOfficeNotice({
        type: 'repaired',
        apps: result.repaired_apps || [],
        restart: result.restart_required
      })
    },
    onError: (error) => {
      setRepairOpen(false)
      setOfficeNotice({ type: 'error', message: error.message })
    }
  })

  const configured = settingsQuery.data?.has_token ?? false
  const officeState = getOfficeUiState(officeQuery.data)
  const busy = setupMutation.isPending || removeMutation.isPending || repairMutation.isPending

  const closeRepairDialog = useCallback(() => {
    if (!repairMutation.isPending) setRepairOpen(false)
  }, [repairMutation.isPending])

  const handleSave = () => {
    const next = token.trim()
    if (next) saveMutation.mutate({ gateway_token: next })
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <PageToolbar
        title="系统设置"
        description="管理 Office Gateway 令牌与本机 Office 集成。"
        meta={configured ? 'Gateway Token 已配置' : '需要配置 Gateway Token'}
      />

      <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-[var(--border)] bg-[var(--surface)]">
        <SettingsSection
          icon={KeyRound}
          title="Gateway Token"
          description="用于 Office Gateway 客户端的访问认证。"
          aside={<StatusBadge tone={configured ? 'success' : 'warning'}>{configured ? '已配置' : '未配置'}</StatusBadge>}
        >
          {settingsQuery.isError ? <ErrorBanner message={settingsQuery.error.message} retry={settingsQuery.refetch} /> : null}
          {settingsQuery.isLoading ? <PropertySkeleton rows={2} /> : (
            <div className="grid grid-cols-[minmax(180px,0.8fr)_minmax(360px,1.2fr)] items-end gap-4">
              <div>
                <label className="text-xs font-medium text-[var(--text-secondary)]" htmlFor="gateway-token">Token</label>
                <p className="mt-1 text-[10px] leading-4 text-[var(--text-muted)]">保存新 Token 后，Office 客户端需使用新令牌重新连接。</p>
              </div>
              <div className="flex items-center gap-2">
                <input
                  id="gateway-token"
                  type="password"
                  value={token}
                  onChange={(event) => setTokenInput(event.target.value)}
                  placeholder={configured ? '输入新 Token' : '设置 Gateway Token'}
                  className="desktop-input min-w-0 flex-1 font-mono"
                />
                <button type="button" onClick={handleSave} disabled={saveMutation.isPending || !token.trim()} className="desktop-button desktop-button-primary">
                  {saveMutation.isPending ? <Spinner className="h-3.5 w-3.5" /> : <Save size={13} />}
                  {saveMutation.isPending ? '保存中' : '保存'}
                </button>
              </div>
            </div>
          )}
          {tokenError ? <InlineNotice tone="danger" className="mt-3">{tokenError}</InlineNotice> : null}
          {saved ? <InlineNotice tone="success" className="mt-3">设置已保存。</InlineNotice> : null}
        </SettingsSection>

        <SettingsSection
          title="Claude for Office"
          description="管理 Word、PowerPoint 和 Excel 的本机 Developer 注册。"
          aside={(
            <IconButton size="sm" label="重新检测 Office" onClick={() => void officeQuery.refetch()} disabled={officeQuery.isFetching || busy}>
              <RefreshCw size={13} className={officeQuery.isFetching ? 'animate-spin text-[var(--accent)]' : ''} />
            </IconButton>
          )}
        >
          {officeQuery.isError ? <ErrorBanner message={officeQuery.error.message} retry={officeQuery.refetch} /> : officeQuery.isLoading ? (
            <PropertySkeleton rows={6} />
          ) : (
            <>
              <div className="grid grid-cols-3 divide-x divide-[var(--border)] rounded border border-[var(--border)] bg-[var(--surface-subtle)]">
                <Readiness label="Windows" ready={Boolean(officeQuery.data?.supported)} detail={officeQuery.data?.platform || '未检测'} />
                <Readiness label="Office" ready={Boolean(officeQuery.data?.office?.installed)} detail={officeQuery.data?.office?.version || '未检测到'} />
                <Readiness label="Gateway" ready={Boolean(officeQuery.data?.gateway_ready)} detail={officeQuery.data?.gateway_url || '等待配置'} />
              </div>

              <div className="mt-3 overflow-hidden rounded border border-[var(--border)]">
                <div className="grid h-8 grid-cols-[130px_minmax(0,1fr)_100px] items-center gap-3 border-b border-[var(--border)] bg-[var(--surface-subtle)] px-3 text-[10px] font-semibold text-[var(--text-muted)]">
                  <span>应用</span>
                  <span>安装位置</span>
                  <span>状态</span>
                </div>
                <div className="divide-y divide-[var(--border-subtle)]">
                  {Object.entries(HOST_DETAILS).map(([key, meta]) => <HostRow key={key} meta={meta} host={officeState.hosts[key]} />)}
                </div>
              </div>

              {officeState.restartHint ? (
                <InlineNotice tone="warning" className="mt-3">关闭并重新打开正在运行的 Word、PowerPoint 或 Excel，配置才会生效。</InlineNotice>
              ) : null}
              {officeState.setup.reason ? <InlineNotice className="mt-3">{officeState.setup.reason}</InlineNotice> : null}
              {officeNotice ? <OfficeNotice notice={officeNotice} /> : null}

              <div className="mt-3 flex items-center gap-2 border-t border-[var(--border)] pt-3">
                {officeState.repair.visible ? (
                  <button
                    type="button"
                    onClick={() => {
                      setOfficeNotice(null)
                      setRepairOpen(true)
                    }}
                    disabled={officeState.repair.disabled || busy}
                    className="desktop-button desktop-button-danger"
                  >
                    <Wrench size={13} />
                    {officeState.repair.label}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setOfficeNotice(null)
                      setupMutation.mutate()
                    }}
                    disabled={officeState.setup.disabled || busy}
                    className="desktop-button desktop-button-primary"
                  >
                    {setupMutation.isPending ? <Spinner className="h-3.5 w-3.5" /> : <Download size={13} />}
                    {setupMutation.isPending ? '正在配置' : officeState.setup.label}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setOfficeNotice(null)
                    removeMutation.mutate()
                  }}
                  disabled={officeState.remove.disabled || busy}
                  className="desktop-button"
                >
                  {removeMutation.isPending ? <Spinner className="h-3.5 w-3.5" /> : <RotateCcw size={13} />}
                  {removeMutation.isPending ? '正在恢复' : '恢复官方插件'}
                </button>
              </div>
            </>
          )}
        </SettingsSection>
      </div>

      <RepairConflictDialog
        open={repairOpen}
        conflicts={officeState.conflicts}
        pending={repairMutation.isPending}
        onClose={closeRepairDialog}
        onConfirm={() => repairMutation.mutate()}
      />
    </div>
  )
}

function SettingsSection({ icon: Icon, title, description, aside, children }) {
  return (
    <section className="border-b border-[var(--border)] last:border-b-0">
      <header className="flex items-start justify-between gap-4 border-b border-[var(--border-subtle)] bg-[var(--surface-subtle)] px-4 py-3">
        <div className="flex min-w-0 items-start gap-2.5">
          {Icon ? <Icon size={15} className="mt-0.5 shrink-0 text-[var(--accent)]" aria-hidden="true" /> : null}
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">{title}</h2>
            <p className="mt-0.5 text-xs text-[var(--text-muted)]">{description}</p>
          </div>
        </div>
        {aside}
      </header>
      <div className="px-4 py-4">{children}</div>
    </section>
  )
}

function Readiness({ label, ready, detail }) {
  return (
    <div className="min-w-0 px-3 py-2.5">
      <div className="flex items-center gap-1.5">
        {ready ? <CheckCircle2 size={13} className="text-[var(--success-strong)]" /> : <CircleAlert size={13} className="text-[var(--text-tertiary)]" />}
        <span className="text-xs font-semibold text-[var(--text-secondary)]">{label}</span>
      </div>
      <p className="mt-1 truncate font-mono text-[10px] text-[var(--text-muted)]" title={detail}>{detail}</p>
    </div>
  )
}

function HostRow({ meta, host = {} }) {
  const status = STATUS_COPY[host.state] || STATUS_COPY.unavailable
  return (
    <div className="grid min-h-11 grid-cols-[130px_minmax(0,1fr)_100px] items-center gap-3 px-3 text-xs hover:bg-[var(--surface-hover)]">
      <div className="min-w-0">
        <span className="font-semibold text-[var(--text-primary)]">{meta.title}</span>
        {host.running ? <span className="ml-2 text-[10px] text-[var(--warning-strong)]">运行中</span> : null}
      </div>
      <span className="truncate font-mono text-[10px] text-[var(--text-muted)]" title={host.executable_path || meta.process}>
        {host.application_installed ? (host.executable_path || meta.process) : '未检测到桌面应用'}
      </span>
      <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
    </div>
  )
}

function OfficeNotice({ notice }) {
  if (notice.type === 'error') return <InlineNotice tone="danger" className="mt-3">{notice.message}</InlineNotice>
  const repairedApps = (notice.apps || []).map((key) => HOST_DETAILS[key]?.title).filter(Boolean)
  const action = notice.type === 'removed'
    ? '已恢复官方插件。'
    : notice.type === 'repaired'
      ? repairedApps.length
        ? `已清除 ${repairedApps.join('、')} 的冲突注册并完成配置。`
        : '未发现需要清除的冲突，Claude for Office 已配置。'
      : 'Claude for Office 已配置。'
  return <InlineNotice tone="success" className="mt-3">{action}{notice.restart ? ' 请关闭并重新打开 Office 应用。' : ''}</InlineNotice>
}

function RepairConflictDialog({ open, conflicts, pending, onClose, onConfirm }) {
  return (
    <Dialog open={open} onClose={onClose} closeOnBackdrop={!pending} ariaLabel="修复 Developer 注册冲突" className="max-w-lg">
      <div className="flex items-start gap-3 border-b border-[var(--border)] px-4 py-3">
        <ShieldAlert size={18} className="mt-0.5 shrink-0 text-[var(--danger-strong)]" />
        <div>
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">修复 Developer 注册冲突</h2>
          <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">外部 Developer 注册将被永久清除，并替换为 Gateway 配置。</p>
        </div>
      </div>
      <div className="space-y-3 overflow-y-auto px-4 py-4">
        <div className="divide-y divide-[var(--border-subtle)] rounded border border-[var(--border)]">
          {conflicts.map((key) => (
            <div key={key} className="flex min-h-9 items-center justify-between gap-3 px-3 text-xs">
              <span className="font-semibold text-[var(--text-primary)]">{HOST_DETAILS[key]?.title || key}</span>
              <StatusBadge tone="danger">注册冲突</StatusBadge>
            </div>
          ))}
        </div>
        <InlineNotice tone="danger">原有 Developer 注册不会保留，且无法通过“恢复官方插件”找回。官方商店加载项不会被删除。</InlineNotice>
      </div>
      <div className="flex justify-end gap-2 border-t border-[var(--border)] px-4 py-3">
        <button data-autofocus type="button" onClick={onClose} disabled={pending} className="desktop-button">取消</button>
        <button type="button" onClick={onConfirm} disabled={pending} className="desktop-button desktop-button-danger">
          {pending ? <Spinner className="h-3.5 w-3.5" /> : <Wrench size={13} />}
          {pending ? '正在修复' : '清除并安装'}
        </button>
      </div>
    </Dialog>
  )
}

function ErrorBanner({ message, retry }) {
  return (
    <InlineNotice tone="danger" className="flex items-center justify-between gap-3">
      <span className="flex min-w-0 items-center gap-2"><AlertTriangle size={14} className="shrink-0" />{message || '请求失败。'}</span>
      <button type="button" onClick={() => retry()} className="desktop-link shrink-0">重试</button>
    </InlineNotice>
  )
}

function PropertySkeleton({ rows }) {
  return (
    <div className="animate-pulse divide-y divide-[var(--border-subtle)]">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex h-10 items-center justify-between">
          <div className="h-2 w-28 rounded bg-[var(--surface-active)]" />
          <div className="h-6 w-56 rounded bg-[var(--surface-hover)]" />
        </div>
      ))}
    </div>
  )
}
