import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isDesktopRuntime,
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
