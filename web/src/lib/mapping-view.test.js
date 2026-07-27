import test from 'node:test'
import assert from 'node:assert/strict'
import { groupMappings, providersForMapping, routeReasonLabel } from './mapping-view.js'

test('keeps custom client models while preserving the known model groups', () => {
  const groups = groupMappings([
    { id: 9, client_model: 'team-sonnet-routing', priority: 2, routable: true },
    { id: 8, client_model: 'team-sonnet-routing', priority: 1, routable: false }
  ])

  assert.equal(groups.length, 4)
  assert.equal(groups.at(-1).clientModel, 'team-sonnet-routing')
  assert.deepEqual(groups.at(-1).rows.map((row) => row.id), [8, 9])
})

test('keeps the current disabled provider available while excluding duplicate candidates', () => {
  const providers = [
    { id: 1, enabled: false },
    { id: 2, enabled: true },
    { id: 3, enabled: true }
  ]
  const mappings = [
    { id: 10, provider_id: 1, client_model: 'claude-sonnet' },
    { id: 11, provider_id: 2, client_model: 'claude-sonnet' }
  ]
  const result = providersForMapping({
    providers,
    mappings,
    form: { id: 10, provider_id: 1, client_model: 'claude-sonnet' }
  })

  assert.deepEqual(result.map((provider) => provider.id), [1, 3])
})

test('translates route exclusion reasons for the inspector', () => {
  assert.equal(routeReasonLabel('provider_disabled'), 'Provider 已停用')
  assert.equal(routeReasonLabel('unknown'), '当前不可路由')
})
