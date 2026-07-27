/** 生成指定趋势范围的统计 API 地址。 */
export const statsPath = (range) => `/admin/stats?range=${range}`

/** 返回趋势图在指定范围下的横轴标签间隔。 */
export const trendTickInterval = (range) => ({
  '24h': 3,
  '7d': 0,
  '30d': 4
}[range] ?? 3)
