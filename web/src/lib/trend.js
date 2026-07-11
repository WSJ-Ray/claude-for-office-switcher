export const statsPath = (range) => `/admin/stats?range=${range}`

export const trendTickInterval = (range) => ({
  '24h': 3,
  '7d': 0,
  '30d': 4
}[range] ?? 3)
