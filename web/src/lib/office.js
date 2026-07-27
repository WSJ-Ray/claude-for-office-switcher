/** 将单个 Office 主机状态归一化为界面状态。 */
const hostState = (host = {}) => {
  if (host.conflict) return 'conflict'
  if (host.managed_installed) return 'managed'
  if (host.official_installed) return 'official'
  if (host.application_installed) return 'available'
  return 'unavailable'
}

/** 返回阻止 Office 配置操作的首个就绪条件说明。 */
const readinessReason = (status = {}) => {
  if (!status.supported) return '仅支持 Windows 桌面版 Office。'
  if (!status.local_access) return '请从本机浏览器访问管理面板后再操作。'
  if (!status.gateway_ready) return '请先配置 Gateway Token。'
  if (!status.office?.installed) return '未检测到 Microsoft Office Click-to-Run。'
  return ''
}

/** 将 Office API 状态转换为页面操作和展示所需的界面状态。 */
export function getOfficeUiState(status = {}) {
  const hosts = Object.fromEntries(
    ['word', 'powerpoint', 'excel'].map((key) => [
      key,
      { ...status.apps?.[key], state: hostState(status.apps?.[key]) },
    ]),
  )
  const managed = Object.values(hosts).some((host) => host.state === 'managed')
  const conflicts = Object.entries(hosts)
    .filter(([, host]) => host.state === 'conflict')
    .map(([key]) => key)
  const readiness = readinessReason(status)
  const setupReason = readiness || (
    conflicts.length
      ? '检测到外部 Developer 注册冲突，请使用“修复冲突并配置”。'
      : ''
  )

  return {
    hosts,
    conflicts,
    setup: {
      disabled: Boolean(setupReason),
      reason: setupReason,
      label: managed ? '重新配置' : '一键安装并配置',
    },
    repair: {
      visible: conflicts.length > 0,
      disabled: Boolean(readiness),
      reason: readiness,
      label: '修复冲突并配置',
    },
    remove: {
      disabled: !managed || !status.local_access,
      reason: !status.local_access ? '请从本机浏览器访问管理面板后再操作。' : '',
    },
    restartHint: Boolean(status.office?.running),
  }
}

/** 从结构化或文本 API 错误中提取面向用户的消息。 */
export function getApiErrorMessage(detail, fallback = '请求失败。') {
  if (typeof detail === 'string') return detail || fallback
  if (detail && typeof detail.message === 'string') return detail.message
  return fallback
}
