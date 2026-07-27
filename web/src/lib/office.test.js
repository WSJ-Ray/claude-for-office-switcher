import test from 'node:test'
import assert from 'node:assert/strict'
import { getApiErrorMessage, getOfficeUiState } from './office.js'

const readyStatus = {
  supported: true,
  local_access: true,
  gateway_ready: true,
  office: { installed: true, running: false },
  apps: {
    word: { application_installed: true, official_installed: true, managed_installed: false, running: false, conflict: false },
    powerpoint: { application_installed: true, official_installed: false, managed_installed: false, running: false, conflict: false },
    excel: { application_installed: true, official_installed: false, managed_installed: false, running: false, conflict: false },
  },
}

test('enables initial setup when the local Windows gateway and Office are ready', () => {
  const state = getOfficeUiState(readyStatus)

  assert.equal(state.setup.disabled, false)
  assert.equal(state.setup.label, '一键安装并配置')
  assert.equal(state.repair.visible, false)
  assert.equal(state.remove.disabled, true)
  assert.equal(state.hosts.word.state, 'official')
  assert.equal(state.hosts.powerpoint.state, 'available')
  assert.equal(state.hosts.excel.state, 'available')
})

test('explains why setup is disabled when the gateway token is missing', () => {
  const state = getOfficeUiState({ ...readyStatus, gateway_ready: false })

  assert.equal(state.setup.disabled, true)
  assert.match(state.setup.reason, /Token/)
})

test('blocks setup when an external developer override owns Excel', () => {
  const state = getOfficeUiState({
    ...readyStatus,
    apps: {
      ...readyStatus.apps,
      excel: { ...readyStatus.apps.excel, conflict: true },
    },
  })

  assert.equal(state.setup.disabled, true)
  assert.match(state.setup.reason, /Developer/)
  assert.deepEqual(state.conflicts, ['excel'])
  assert.equal(state.repair.visible, true)
  assert.equal(state.repair.disabled, false)
  assert.equal(state.repair.label, '修复冲突并配置')
  assert.equal(state.hosts.excel.state, 'conflict')
})

test('disables conflict repair until all setup prerequisites are ready', () => {
  const state = getOfficeUiState({
    ...readyStatus,
    gateway_ready: false,
    apps: {
      ...readyStatus.apps,
      word: { ...readyStatus.apps.word, conflict: true },
      excel: { ...readyStatus.apps.excel, conflict: true },
    },
  })

  assert.deepEqual(state.conflicts, ['word', 'excel'])
  assert.equal(state.repair.visible, true)
  assert.equal(state.repair.disabled, true)
  assert.match(state.repair.reason, /Token/)
})

test('uses reconfigure and restore actions for a managed installation', () => {
  const state = getOfficeUiState({
    ...readyStatus,
    office: { installed: true, running: true },
    apps: {
      word: { ...readyStatus.apps.word, managed_installed: true, running: true },
      powerpoint: { ...readyStatus.apps.powerpoint, managed_installed: true },
      excel: { ...readyStatus.apps.excel, managed_installed: true, running: true },
    },
  })

  assert.equal(state.setup.label, '重新配置')
  assert.equal(state.remove.disabled, false)
  assert.equal(state.restartHint, true)
  assert.equal(state.hosts.excel.state, 'managed')
  assert.equal(state.hosts.excel.running, true)
})

test('reports the official Claude Excel add-in independently of the gateway add-in', () => {
  const state = getOfficeUiState({
    ...readyStatus,
    apps: {
      ...readyStatus.apps,
      excel: { ...readyStatus.apps.excel, official_installed: true },
    },
  })

  assert.equal(state.hosts.excel.state, 'official')
  assert.equal(state.setup.disabled, false)
})

test('extracts a user-facing message from structured API errors', () => {
  assert.equal(
    getApiErrorMessage({ code: 'gateway_token_missing', message: 'Configure a gateway token first.' }),
    'Configure a gateway token first.',
  )
  assert.equal(getApiErrorMessage('Invalid token'), 'Invalid token')
})
