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

export const openExternalUrl = async (url, targetWindow = getBrowserWindow()) => {
  if (!targetWindow || typeof url !== 'string') return false

  const nativeOpen = targetWindow.pywebview?.api?.open_external_url
  if (typeof nativeOpen === 'function') {
    try {
      if (await nativeOpen(url)) return true
    } catch {
      // Fall back to the browser opener when the native bridge is unavailable.
    }
  }

  if (typeof targetWindow.open !== 'function') return false
  return Boolean(targetWindow.open(url, '_blank', 'noopener,noreferrer'))
}
