const DESKTOP_QUERY_VALUE = '1'
export const PYWEBVIEW_READY_EVENT = 'pywebviewready'

const getBrowserWindow = () => (
  typeof window === 'undefined' ? undefined : window
)

export const isDesktopRuntime = (targetWindow = getBrowserWindow()) => {
  if (!targetWindow) return false

  const search = targetWindow.location?.search
  const markedAsDesktop = typeof search === 'string'
    && new URLSearchParams(search).get('desktop') === DESKTOP_QUERY_VALUE

  return markedAsDesktop || Boolean(targetWindow.pywebview)
}

export const subscribeToDesktopRuntime = (onReady, targetWindow = getBrowserWindow()) => {
  if (!targetWindow?.addEventListener) return () => {}

  const handleReady = () => onReady(true)
  targetWindow.addEventListener(PYWEBVIEW_READY_EVENT, handleReady)

  // Covers pywebview becoming available between React's initial render and effect setup.
  if (isDesktopRuntime(targetWindow)) handleReady()

  return () => targetWindow.removeEventListener?.(PYWEBVIEW_READY_EVENT, handleReady)
}
