export const canSaveProvider = ({ form, isEdit, extraError }) => Boolean(
  form.name.trim()
  && form.base_url.trim()
  && (isEdit || form.api_key.trim())
  && !extraError
)

export const providerPreviewPayload = ({ form, providerId, extraConfig }) => ({
  ...(providerId ? { provider_id: providerId } : {}),
  ...form,
  extra_config: extraConfig
})

export const providerMappingCounts = (mappings = []) => {
  const counts = new Map()
  mappings.forEach((mapping) => counts.set(mapping.provider_id, (counts.get(mapping.provider_id) || 0) + 1))
  return counts
}
