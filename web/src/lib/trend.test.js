import test from 'node:test'
import assert from 'node:assert/strict'
import { statsPath, trendTickInterval } from './trend.js'

test('builds a statistics request for the selected trend range', () => {
  assert.equal(statsPath('24h'), '/admin/stats?range=24h')
  assert.equal(statsPath('7d'), '/admin/stats?range=7d')
  assert.equal(statsPath('30d'), '/admin/stats?range=30d')
})

test('uses sparse ticks for wider trend ranges', () => {
  assert.equal(trendTickInterval('24h'), 3)
  assert.equal(trendTickInterval('7d'), 0)
  assert.equal(trendTickInterval('30d'), 4)
})
