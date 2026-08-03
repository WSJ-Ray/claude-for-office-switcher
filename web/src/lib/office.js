/** 将单个 Office 主机状态归一化为界面状态。 */
const OFFICE_APP_KEYS = ['word', 'powerpoint', 'excel']

const hostState = (host = {}, pendingInstall = false) => {
  if (host.conflict) return 'conflict'
  if (host.managed_installed) return 'managed'
  if (pendingInstall && !host.official_installed) return 'pending'
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
export function getOfficeUiState(status = {}, pendingInstallApps = []) {
  const pendingSet = new Set(pendingInstallApps)
  const hosts = Object.fromEntries(
    OFFICE_APP_KEYS.map((key) => [
      key,
      {
        ...status.apps?.[key],
        state: hostState(status.apps?.[key], pendingSet.has(key)),
        pending_install: pendingSet.has(key),
      },
    ]),
  )
  const managed = Object.values(hosts).some((host) => host.state === 'managed')
  const conflicts = Object.entries(hosts)
    .filter(([, host]) => host.state === 'conflict')
    .map(([key]) => key)
  const readiness = readinessReason(status)
  const setupTargets = OFFICE_APP_KEYS.filter((key) => {
    const host = hosts[key]
    return !host.conflict && (host.official_installed || host.managed_installed)
  })
  const setupReason = readiness
    || (conflicts.length
      ? '检测到外部 Developer 注册冲突，请先修复冲突并配置。'
      : setupTargets.length
        ? ''
        : '请先从 Microsoft Marketplace 安装至少一个 Office 插件。')

  return {
    hosts,
    conflicts,
    install: Object.fromEntries(OFFICE_APP_KEYS.map((key) => {
      const host = hosts[key]
      return [key, {
        visible: !host.official_installed && !host.managed_installed && !host.conflict,
        disabled: Boolean(readiness) || host.pending_install,
        url: host.marketplace_url || '',
        label: host.pending_install ? '等待安装' : '从 Microsoft Marketplace 安装',
      }]
    })),
    uninstall: Object.fromEntries(OFFICE_APP_KEYS.map((key) => {
      const host = hosts[key]
      return [key, {
        visible: Boolean(host.managed_installed),
        disabled: !status.local_access || host.pending_install,
        label: '卸载插件',
      }]
    })),
    manage: Object.fromEntries(OFFICE_APP_KEYS.map((key) => {
      const host = hosts[key]
      return [key, {
        visible: Boolean(host.official_installed),
        disabled: !host.marketplace_url || host.pending_install,
        url: host.marketplace_url || '',
        label: '管理官方插件',
      }]
    })),
    setup: {
      disabled: Boolean(setupReason),
      reason: setupReason,
      targets: setupTargets,
      label: managed ? '重新配置' : '连接 Gateway',
    },
    repair: {
      visible: conflicts.length > 0,
      disabled: Boolean(readiness),
      reason: readiness,
      targets: conflicts,
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
