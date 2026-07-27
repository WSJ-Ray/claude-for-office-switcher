import test from 'node:test'
import assert from 'node:assert/strict'
import { dashboardErrorRate, getDashboardDiagnostics, getDashboardHealth } from './dashboard.js'

test('reports a warning when providers exist but all are disabled', () => {
  const health = getDashboardHealth({
    stats: { summary: { total: 0, errors: 0 }, recent: [] },
    providers: [{ id: 1, enabled: false }, { id: 2, enabled: false }]
  })

  assert.deepEqual(health, { label: '没有启用的 Provider', tone: 'warning' })
})

test('reports healthy only when an enabled provider has no request failures', () => {
  const health = getDashboardHealth({
    stats: { summary: { total: 20, errors: 0 }, recent: [{ status: 200 }] },
    providers: [{ id: 1, enabled: true }]
  })

  assert.deepEqual(health, { label: '运行正常', tone: 'success' })
})

test('uses a danger state for an error rate of five percent or more', () => {
  assert.equal(dashboardErrorRate({ total: 20, errors: 1 }), 5)
  assert.equal(getDashboardHealth({
    stats: { summary: { total: 20, errors: 1 }, recent: [] },
    providers: [{ enabled: true }]
  }).tone, 'danger')
})

test('returns only actionable diagnostics', () => {
  assert.deepEqual(getDashboardDiagnostics({
    stats: { summary: { total: 10, errors: 0 }, mappings_count: 2, recent: [] },
    providers: [{ enabled: true }]
  }), [])

  assert.deepEqual(
    getDashboardDiagnostics({
      stats: { summary: { total: 0, errors: 0 }, mappings_count: 0, recent: [] },
      providers: [{ enabled: false }]
    }).map((item) => item.id),
    ['provider-disabled', 'mapping-missing']
  )
})
