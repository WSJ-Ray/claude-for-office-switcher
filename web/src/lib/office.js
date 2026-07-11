const hostState = (host = {}) => {
  if (host.conflict) return 'conflict'
  if (host.managed_installed) return 'managed'
  if (host.official_installed) return 'official'
  if (host.application_installed) return 'available'
  return 'unavailable'
}

const setupReason = (status = {}) => {
  if (!status.supported) return '仅支持 Windows 桌面版 Office。'
  if (!status.local_access) return '请从本机浏览器访问管理面板后再操作。'
  if (!status.gateway_ready) return '请先配置 Gateway Token。'
  if (!status.office?.installed) return '未检测到 Microsoft Office Click-to-Run。'
  if (Object.values(status.apps || {}).some((host) => host.conflict)) {
    return '检测到外部 Developer 注册冲突，请先在 Office 中处理该加载项。'
  }
  return ''
}

export function getOfficeUiState(status = {}) {
  const hosts = Object.fromEntries(
    ['word', 'powerpoint'].map((key) => [
      key,
      { ...status.apps?.[key], state: hostState(status.apps?.[key]) },
    ]),
  )
  const managed = Object.values(hosts).some((host) => host.state === 'managed')
  const reason = setupReason(status)

  return {
    hosts,
    setup: {
      disabled: Boolean(reason),
      reason,
      label: managed ? '重新配置' : '一键安装并配置',
    },
    remove: {
      disabled: !managed || !status.local_access,
      reason: !status.local_access ? '请从本机浏览器访问管理面板后再操作。' : '',
    },
    restartHint: Boolean(status.office?.running),
  }
}

export function getApiErrorMessage(detail, fallback = '请求失败。') {
  if (typeof detail === 'string') return detail || fallback
  if (detail && typeof detail.message === 'string') return detail.message
  return fallback
}
