export const KNOWN_CLIENT_MODELS = [
  { id: 'claude-sonnet-4-5-20250929', label: 'Sonnet' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku' },
  { id: 'claude-opus-4-5-20250929', label: 'Opus' }
]

export const modelFamily = (model = '') =>
  ['sonnet', 'haiku', 'opus'].find((name) => model.toLowerCase().includes(name)) || 'custom'

export const groupMappings = (mappings = []) => {
  const groups = new Map(KNOWN_CLIENT_MODELS.map((model) => [model.id, []]))
  mappings.forEach((mapping) => {
    if (!groups.has(mapping.client_model)) groups.set(mapping.client_model, [])
    groups.get(mapping.client_model).push(mapping)
  })

  return [...groups.entries()].map(([clientModel, rows]) => ({
    clientModel,
    label: KNOWN_CLIENT_MODELS.find((model) => model.id === clientModel)?.label || modelFamily(clientModel),
    rows: [...rows].sort((a, b) => a.priority - b.priority || a.id - b.id),
    routable: rows.filter((row) => row.routable).length
  }))
}

export const routeReasonLabel = (reason) => ({
  provider_disabled: 'Provider 已停用',
  unsupported_provider_format: '运行时不支持此格式',
  mapping_disabled: '映射已停用'
})[reason] || '当前不可路由'

export const providersForMapping = ({ providers = [], mappings = [], form }) => {
  if (!form) return []
  const usedIds = new Set(
    mappings
      .filter((mapping) => mapping.client_model === form.client_model && mapping.id !== form.id)
      .map((mapping) => mapping.provider_id)
  )

  return providers.filter((provider) => {
    const isCurrent = provider.id === Number(form.provider_id)
    return !usedIds.has(provider.id) && (provider.enabled || isCurrent)
  })
}
