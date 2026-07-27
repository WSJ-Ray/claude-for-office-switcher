import test from 'node:test'
import assert from 'node:assert/strict'
import { canSaveProvider, providerMappingCounts, providerPreviewPayload } from './provider-view.js'

const baseForm = { name: 'DeepSeek', base_url: 'https://api.example.com', api_key: '' }

test('allows an existing provider to keep its saved API key', () => {
  assert.equal(canSaveProvider({ form: baseForm, isEdit: true, extraError: null }), true)
  assert.equal(canSaveProvider({ form: baseForm, isEdit: false, extraError: null }), false)
})

test('includes provider id when previewing an existing provider', () => {
  const payload = providerPreviewPayload({ form: baseForm, providerId: 42, extraConfig: {} })
  assert.equal(payload.provider_id, 42)
})

test('counts mappings per provider for the compact table', () => {
  const counts = providerMappingCounts([{ provider_id: 1 }, { provider_id: 1 }, { provider_id: 2 }])
  assert.equal(counts.get(1), 2)
  assert.equal(counts.get(2), 1)
})
