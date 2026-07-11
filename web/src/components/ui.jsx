import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'

export const cx = (...values) => values.filter(Boolean).join(' ')

export function Spinner({ className = '' }) {
  return (
    <span
      aria-hidden="true"
      className={cx('inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent', className)}
    />
  )
}

export function IconButton({ label, className = '', children, type = 'button', ...props }) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={cx(
        'inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 transition-colors hover:border-slate-300 hover:bg-slate-50 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      {...props}
    >
      {children}
    </button>
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
 * A compact accessible dialog primitive. Keep the visual contents in the caller,
 * while this component owns portal placement, focus management, Escape and backdrop behavior.
 */
export function Dialog({
  open,
  onClose,
  ariaLabel,
  children,
  className = '',
  closeOnBackdrop = true
}) {
  const dialogRef = useRef(null)
  const previousFocusRef = useRef(null)
  const dialogId = useId()

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
        onClose?.()
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
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
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
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center p-3 sm:items-center sm:p-6">
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-slate-950/45 backdrop-blur-[1px]"
        onMouseDown={closeOnBackdrop ? onClose : undefined}
      />
      <section
        ref={dialogRef}
        id={dialogId}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        className={cx(
          'relative flex max-h-[calc(100dvh-1.5rem)] w-full flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl shadow-slate-950/20 sm:max-h-[calc(100dvh-3rem)]',
          className
        )}
      >
        {children}
      </section>
    </div>,
    document.body
  )
}

export function InlineNotice({ tone = 'info', children, className = '' }) {
  const styles = {
    info: 'border-cyan-200 bg-cyan-50 text-cyan-950',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-950',
    warning: 'border-amber-200 bg-amber-50 text-amber-950',
    danger: 'border-red-200 bg-red-50 text-red-950'
  }

  return <div className={cx('rounded-lg border px-3 py-2.5 text-sm leading-5', styles[tone], className)}>{children}</div>
}
