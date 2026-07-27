/** 计算汇总数据中的错误率百分比。 */
export const dashboardErrorRate = (summary = {}) => {
  const total = Number(summary.total) || 0
  if (total <= 0) return 0
  return ((Number(summary.errors) || 0) / total) * 100
}

/** 判断一条最近请求是否失败。 */
export const isFailedRequest = (request = {}) =>
  (Number(request.status) || 0) >= 400 || Boolean(request.error)

/** 根据可路由能力和近期请求结果返回服务健康状态。 */
export const getDashboardHealth = ({ stats, providers = [] } = {}) => {
  if (providers.length === 0) {
    return { label: '需要配置 Provider', tone: 'warning' }
  }
  if (!providers.some((provider) => provider.enabled === true)) {
    return { label: '没有启用的 Provider', tone: 'warning' }
  }

  const errorRate = dashboardErrorRate(stats?.summary)
  if (errorRate >= 5) {
    return { label: '错误率偏高', tone: 'danger' }
  }
  if ((stats?.recent || []).some(isFailedRequest)) {
    return { label: '存在失败请求', tone: 'warning' }
  }
  return { label: '运行正常', tone: 'success' }
}

/** 只返回需要处理的仪表盘诊断项。 */
export const getDashboardDiagnostics = ({ stats, providers = [] } = {}) => {
  const diagnostics = []
  const summary = stats?.summary || {}

  if (providers.length === 0) {
    diagnostics.push({
      id: 'provider-missing',
      tone: 'warning',
      title: '尚未配置 Provider',
      detail: '添加一个上游端点后才能转发请求。'
    })
  } else if (!providers.some((provider) => provider.enabled === true)) {
    diagnostics.push({
      id: 'provider-disabled',
      tone: 'warning',
      title: '所有 Provider 均已停用',
      detail: '至少启用一个 Provider 才能恢复路由。'
    })
  }

  if ((Number(stats?.mappings_count) || 0) === 0) {
    diagnostics.push({
      id: 'mapping-missing',
      tone: 'info',
      title: '尚未配置精确模型映射',
      detail: '请求将依赖默认 Provider 透传客户端模型名。'
    })
  }

  const errorRate = dashboardErrorRate(summary)
  if (errorRate >= 5) {
    diagnostics.push({
      id: 'error-rate',
      tone: 'danger',
      title: `累计错误率 ${errorRate.toFixed(1)}%`,
      detail: `${Number(summary.errors) || 0} / ${Number(summary.total) || 0} 个请求失败。`
    })
  }

  const recentFailures = (stats?.recent || []).filter(isFailedRequest).length
  if (recentFailures > 0) {
    diagnostics.push({
      id: 'recent-failures',
      tone: 'warning',
      title: `最近请求中有 ${recentFailures} 个失败`,
      detail: '可在请求日志中查看上游响应和错误详情。'
    })
  }

  return diagnostics
}
