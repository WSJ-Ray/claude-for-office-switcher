import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isDesktopRuntime,
  openExternalUrl,
  PYWEBVIEW_READY_EVENT,
  subscribeToDesktopRuntime,
} from './runtime.js'

test('detects the explicit desktop query marker', () => {
  assert.equal(isDesktopRuntime({ location: { search: '?desktop=1' } }), true)
  assert.equal(isDesktopRuntime({ location: { search: '?view=compact&desktop=1' } }), true)
  assert.equal(isDesktopRuntime({ location: { search: '?desktop=0' } }), false)
})

test('detects an existing pywebview runtime without a query marker', () => {
  assert.equal(isDesktopRuntime({ location: { search: '' }, pywebview: {} }), true)
})

test('falls back to browser mode when no desktop signal exists', () => {
  assert.equal(isDesktopRuntime({ location: { search: '?view=browser' } }), false)
  assert.equal(isDesktopRuntime(undefined), false)
})

test('promotes to desktop mode when pywebviewready fires and cleans up', () => {
  const listeners = new Map()
  const targetWindow = {
    location: { search: '' },
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type, listener) => {
      if (listeners.get(type) === listener) listeners.delete(type)
    },
  }
  let desktopMode = false

  const unsubscribe = subscribeToDesktopRuntime(
    (ready) => { desktopMode = ready },
    targetWindow,
  )

  assert.equal(desktopMode, false)
  listeners.get(PYWEBVIEW_READY_EVENT)()
  assert.equal(desktopMode, true)

  unsubscribe()
  assert.equal(listeners.has(PYWEBVIEW_READY_EVENT), false)
})

test('opens Marketplace URLs through the desktop bridge when available', async () => {
  const calls = []
  const targetWindow = {
    pywebview: {
      api: {
        open_external_url: async (url) => {
          calls.push(url)
          return true
        },
      },
    },
    open: () => {
      throw new Error('browser fallback should not be used')
    },
  }

  const result = await openExternalUrl(
    'https://marketplace.microsoft.com/en-us/product/office/WA200010453',
    targetWindow,
  )

  assert.equal(result, true)
  assert.deepEqual(calls, ['https://marketplace.microsoft.com/en-us/product/office/WA200010453'])
})

test('falls back to a browser tab when the native bridge is unavailable', async () => {
  const calls = []
  const targetWindow = {
    open: (...args) => {
      calls.push(args)
      return {}
    },
  }

  const result = await openExternalUrl('https://marketplace.microsoft.com/page', targetWindow)

  assert.equal(result, true)
  assert.deepEqual(calls, [['https://marketplace.microsoft.com/page', '_blank', 'noopener,noreferrer']])
})
