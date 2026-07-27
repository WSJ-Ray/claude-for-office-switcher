import { NavLink, Outlet, useLocation } from 'react-router-dom'
import {
  Activity,
  LayoutDashboard,
  ListTree,
  Network,
  Server,
  Settings as SettingsIcon,
  Shuffle
} from 'lucide-react'
import { cn } from '../lib/utils'

const items = [
  { to: '/', label: '仪表盘', icon: LayoutDashboard, end: true },
  { to: '/providers', label: 'Provider', icon: Server },
  { to: '/mappings', label: '模型映射', icon: Shuffle },
  { to: '/logs', label: '请求日志', icon: ListTree },
]

/** 判断导航项是否匹配当前路径。 */
const isActivePath = (pathname, item) => {
  if (item.end) return pathname === item.to || pathname === '/dashboard'
  return pathname.startsWith(item.to)
}

/** 根据激活状态生成统一的侧栏导航样式。 */
const navItemClass = (active) => cn(
  'group flex h-9 w-full cursor-pointer select-none items-center justify-center gap-2 rounded px-2 text-[13px] font-medium transition-colors duration-150 xl:justify-start xl:px-2.5',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-office-600 focus-visible:ring-offset-1 focus-visible:ring-offset-slate-100',
  active
    ? 'bg-office-100 text-office-800'
    : 'text-slate-700 hover:bg-slate-200 hover:text-slate-950 active:bg-slate-300'
)

function NavItem({ item, active }) {
  const Icon = item.icon

  return (
    <NavLink
      to={item.to}
      end={item.end}
      className={navItemClass(active)}
      aria-current={active ? 'page' : undefined}
      title={item.label}
    >
      <Icon size={17} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
      <span className="hidden min-w-0 truncate xl:block">{item.label}</span>
    </NavLink>
  )
}

/** 渲染固定侧栏和独立滚动的工作区。 */
export default function Layout({ desktopMode = false }) {
  const location = useLocation()
  const settingsActive = location.pathname.startsWith('/settings')

  return (
    <div
      className="flex h-[100dvh] min-h-[640px] min-w-[960px] overflow-hidden bg-slate-50 text-slate-950"
      data-runtime={desktopMode ? 'desktop' : 'browser'}
    >
      <a
        href="#main-content"
        className="fixed left-16 top-2 z-50 -translate-y-16 rounded bg-office-700 px-3 py-1.5 text-sm font-semibold text-white focus:translate-y-0"
      >
        跳到主要内容
      </a>

      <aside className="flex h-full w-14 shrink-0 flex-col border-r border-slate-300 bg-slate-100 xl:w-[196px]" aria-label="应用侧栏">
        {!desktopMode && (
          <NavLink
            to="/"
            className="flex h-12 shrink-0 items-center justify-center gap-2 border-b border-slate-300 px-2 text-slate-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-office-600 xl:justify-start"
            aria-label="Office Gateway 首页"
            title="Office Gateway"
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-office-700 text-white">
              <Network size={17} strokeWidth={1.8} aria-hidden="true" />
            </span>
            <span className="hidden min-w-0 xl:block">
              <span className="block truncate text-[13px] font-semibold leading-4">Office Gateway</span>
              <span className="block truncate text-[11px] leading-4 text-slate-500">管理控制台</span>
            </span>
          </NavLink>
        )}

        <nav className="flex min-h-0 flex-1 flex-col gap-1 px-1.5 py-2 xl:px-2" aria-label="主导航">
          {items.map((item) => (
            <NavItem key={item.to} item={item} active={isActivePath(location.pathname, item)} />
          ))}
        </nav>

        <div className="shrink-0 border-t border-slate-300 px-1.5 py-2 xl:px-2">
          <NavItem
            item={{ to: '/settings', label: '系统设置', icon: SettingsIcon }}
            active={settingsActive}
          />

          <div className="mt-2 border-t border-slate-300 pt-2">
            <div
              className="flex min-h-7 items-center justify-center gap-2 rounded px-1.5 text-[11px] text-slate-600 xl:justify-start"
              title="管理服务在线"
              aria-label="管理服务在线"
            >
              <span className="relative flex h-4 w-4 shrink-0 items-center justify-center text-emerald-700">
                <Activity size={14} strokeWidth={1.8} aria-hidden="true" className="hidden xl:block" />
                <span className="h-2 w-2 rounded-full bg-emerald-600 xl:hidden" aria-hidden="true" />
              </span>
              <span className="hidden truncate xl:block">服务在线</span>
            </div>
            <div
              className="mt-0.5 flex min-h-6 items-center justify-center rounded px-1 font-mono text-[10px] text-slate-500 xl:justify-start xl:px-1.5 xl:text-[11px]"
              title="Gateway 端口 4000"
            >
              <span className="xl:hidden">4000</span>
              <span className="hidden xl:inline">port 4000</span>
            </div>
          </div>
        </div>
      </aside>

      <main id="main-content" tabIndex={-1} className="h-full min-w-0 flex-1 overflow-y-auto overscroll-contain bg-white outline-none">
        <div className="h-full min-h-0 px-4 pb-5 pt-3 xl:px-5 xl:pb-6 xl:pt-4">
          <Outlet />
        </div>
      </main>
    </div>
  )
}
