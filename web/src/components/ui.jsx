import { useEffect, useId, useRef } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import { createPortal } from 'react-dom'
import { cn } from '../lib/utils'

/** 合并一组可选类名并解决 Tailwind 样式冲突。 */
export const cx = (...values) => cn(...values)

/** 渲染继承当前文字颜色的加载指示器。 */
export function Spinner({ className = '' }) {
  return (
    <span
      aria-hidden="true"
      className={cx('inline-block h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-current border-r-transparent', className)}
    />
  )
}

const iconButtonSizes = {
  sm: 'h-7 w-7',
  md: 'h-8 w-8',
  lg: 'h-9 w-9',
}

const iconButtonTones = {
  neutral: 'border-slate-300 bg-white text-slate-700 hover:bg-slate-100 hover:text-slate-950 active:bg-slate-200',
  primary: 'border-office-300 bg-office-50 text-office-800 hover:bg-office-100 active:bg-office-200',
  warning: 'border-amber-200 bg-white text-amber-800 hover:border-amber-300 hover:bg-amber-50 active:bg-amber-100',
  danger: 'border-red-200 bg-white text-red-700 hover:border-red-300 hover:bg-red-50 active:bg-red-100',
}

/** 渲染带可访问标签、尺寸和语义状态的紧凑图标按钮。 */
export function IconButton({
  label,
  size = 'md',
  tone = 'neutral',
  className = '',
  children,
  type = 'button',
  ...props
}) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={cx(
        'inline-flex shrink-0 cursor-pointer select-none items-center justify-center rounded border transition duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-office-600 focus-visible:ring-offset-1 active:translate-y-px disabled:pointer-events-none disabled:opacity-45',
        iconButtonSizes[size] || iconButtonSizes.md,
        iconButtonTones[tone] || iconButtonTones.neutral,
        className
      )}
      {...props}
    >
      {children}
    </button>
  )
}

/** 页面标题、元数据、操作和筛选控件的高密度容器。 */
export function PageToolbar({
  title,
  description,
  meta,
  actions,
  children,
  className = '',
}) {
  return (
    <header className={cx('border-b border-slate-300 bg-white', className)}>
      <div className="flex min-h-[52px] items-center justify-between gap-4 px-0 py-1.5">
        <div className="flex min-w-0 items-center gap-3 overflow-hidden">
          <div className="min-w-0">
            <h1 className="truncate text-[17px] font-semibold leading-6 text-slate-950">{title}</h1>
            {description ? <p className="truncate text-xs leading-4 text-slate-600">{description}</p> : null}
          </div>
          {meta ? <div className="flex max-w-[34ch] shrink-0 items-center gap-1.5 truncate border-l border-slate-300 pl-3 text-xs text-slate-600">{meta}</div> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center justify-end gap-1.5">{actions}</div> : null}
      </div>
      {children ? (
        <div className="flex min-h-10 flex-wrap items-center gap-2 border-t border-slate-200 py-1.5">
          {children}
        </div>
      ) : null}
    </header>
  )
}

const badgeTones = {
  neutral: {
    shell: 'border-slate-300 bg-slate-100 text-slate-700',
    dot: 'bg-slate-500',
  },
  info: {
    shell: 'border-office-200 bg-office-50 text-office-900',
    dot: 'bg-office-600',
  },
  success: {
    shell: 'border-emerald-200 bg-emerald-50 text-emerald-900',
    dot: 'bg-emerald-600',
  },
  warning: {
    shell: 'border-amber-200 bg-amber-50 text-amber-950',
    dot: 'bg-amber-600',
  },
  danger: {
    shell: 'border-red-200 bg-red-50 text-red-900',
    dot: 'bg-red-600',
  },
}

/** 以统一色彩和尺寸展示运行状态。 */
export function StatusBadge({ tone = 'neutral', children, className = '', ...props }) {
  const style = badgeTones[tone] || badgeTones.neutral

  return (
    <span className={cx('inline-flex min-h-[22px] items-center gap-1.5 rounded border px-1.5 text-[11px] font-medium leading-4', style.shell, className)} {...props}>
      <span className={cx('h-1.5 w-1.5 shrink-0 rounded-full', style.dot)} aria-hidden="true" />
      <span className="truncate">{children}</span>
    </span>
  )
}

/** 在无数据时提供明确说明和下一步操作。 */
export function EmptyState({ icon: Icon, title, description, action, className = '' }) {
  return (
    <div className={cx('flex min-h-40 flex-col items-center justify-center border border-dashed border-slate-300 bg-slate-50 px-5 py-6 text-center', className)}>
      {Icon ? (
        <span className="mb-3 flex h-8 w-8 items-center justify-center rounded border border-slate-300 bg-white text-slate-500">
          <Icon size={17} strokeWidth={1.7} aria-hidden="true" />
        </span>
      ) : null}
      <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
      {description ? <p className="mt-1 max-w-[54ch] text-xs leading-5 text-slate-600">{description}</p> : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  )
}

const focusableSelector = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(', ')

/**
 * 可访问对话框基础组件，负责 Portal、焦点圈闭、Escape、焦点恢复和背景点击。
 * `right` placement 用于桌面属性面板，默认保持居中对话框行为。
 */
export function Dialog({
  open,
  onClose,
  ariaLabel,
  children,
  className = '',
  closeOnBackdrop = true,
  placement = 'center',
}) {
  const dialogRef = useRef(null)
  const previousFocusRef = useRef(null)
  const onCloseRef = useRef(onClose)
  const dialogId = useId()
  onCloseRef.current = onClose

  useEffect(() => {
    if (!open) return undefined

    previousFocusRef.current = document.activeElement
    const frame = window.requestAnimationFrame(() => {
      const dialog = dialogRef.current
      const preferred = dialog?.querySelector('[data-autofocus]')
      const firstFocusable = dialog?.querySelector(focusableSelector)
      ;(preferred || firstFocusable || dialog)?.focus()
    })

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCloseRef.current?.()
        return
      }
      if (event.key !== 'Tab') return

      const items = [...(dialogRef.current?.querySelectorAll(focusableSelector) || [])]
      if (!items.length) {
        event.preventDefault()
        dialogRef.current?.focus()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const activeElement = document.activeElement
      const focusIsOutside = !dialogRef.current?.contains(activeElement)
      if (event.shiftKey && (activeElement === first || activeElement === dialogRef.current || focusIsOutside)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (activeElement === last || focusIsOutside)) {
        event.preventDefault()
        first.focus()
      }
    }

    const originalOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      window.cancelAnimationFrame(frame)
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = originalOverflow
      previousFocusRef.current?.focus?.()
    }
  }, [open])

  if (!open) return null

  const isRight = placement === 'right'

  return createPortal(
    <div className={cx('fixed inset-0 z-50 flex', isRight ? 'justify-end' : 'items-center justify-center p-4')}>
      <div
        aria-hidden="true"
        className="ui-dialog-backdrop absolute inset-0 bg-slate-950/35"
        onMouseDown={closeOnBackdrop ? onClose : undefined}
      />
      <section
        ref={dialogRef}
        id={dialogId}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        data-placement={isRight ? 'right' : 'center'}
        className={cx(
          'ui-dialog-panel relative flex w-full flex-col overflow-hidden border border-slate-300 bg-white shadow-[0_8px_28px_rgba(0,0,0,0.18)] outline-none',
          isRight
            ? 'h-full max-h-full max-w-[440px] rounded-none border-y-0 border-r-0'
            : 'max-h-[calc(100dvh-2rem)] rounded-md',
          className
        )}
      >
        {children}
      </section>
    </div>,
    document.body
  )
}

/** 统一的破坏性或重要操作确认对话框。 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = '确认',
  tone = 'danger',
  pending = false,
}) {
  const confirmTone = tone === 'danger'
    ? 'bg-red-700 text-white hover:bg-red-800 active:bg-red-900'
    : 'bg-office-700 text-white hover:bg-office-800 active:bg-office-900'

  return (
    <Dialog
      open={open}
      onClose={pending ? undefined : onClose}
      closeOnBackdrop={!pending}
      ariaLabel={title}
      className="max-w-[420px]"
    >
      <div className="flex items-start gap-3 border-b border-slate-300 px-4 py-3">
        <span className={cx('mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded', tone === 'danger' ? 'bg-red-50 text-red-700' : 'bg-office-50 text-office-800')}>
          <AlertTriangle size={17} strokeWidth={1.8} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold leading-5 text-slate-950">{title}</h2>
          {description ? <div className="mt-1 text-xs leading-5 text-slate-600">{description}</div> : null}
        </div>
        <IconButton label="关闭" size="sm" onClick={onClose} disabled={pending} className="border-transparent bg-transparent">
          <X size={16} strokeWidth={1.8} />
        </IconButton>
      </div>
      <div className="flex justify-end gap-2 bg-slate-50 px-4 py-3">
        <button
          type="button"
          data-autofocus
          onClick={onClose}
          disabled={pending}
          className="inline-flex h-8 min-w-16 items-center justify-center rounded border border-slate-300 bg-white px-3 text-[13px] font-medium text-slate-800 transition-colors duration-150 hover:bg-slate-100 active:bg-slate-200 disabled:pointer-events-none disabled:opacity-45"
        >
          取消
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={pending}
          className={cx('inline-flex h-8 min-w-16 items-center justify-center gap-1.5 rounded border border-transparent px-3 text-[13px] font-semibold transition-colors duration-150 disabled:pointer-events-none disabled:opacity-55', confirmTone)}
        >
          {pending ? <Spinner /> : null}
          {confirmLabel}
        </button>
      </div>
    </Dialog>
  )
}

/** 根据提示语气渲染统一的内联通知。 */
export function InlineNotice({ tone = 'info', children, className = '' }) {
  const styles = {
    neutral: 'border-slate-300 bg-slate-50 text-slate-800',
    info: 'border-office-200 bg-office-50 text-office-950',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-950',
    warning: 'border-amber-200 bg-amber-50 text-amber-950',
    danger: 'border-red-200 bg-red-50 text-red-950'
  }

  return (
    <div
      role={tone === 'danger' ? 'alert' : undefined}
      className={cx('rounded border px-3 py-2 text-[13px] leading-5', styles[tone] || styles.info, className)}
    >
      {children}
    </div>
  )
}
