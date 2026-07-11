import { useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import {
  Activity,
  ChevronDown,
  LayoutDashboard,
  ListTree,
  Menu,
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

const isActivePath = (pathname, item) => {
  if (item.end) return pathname === item.to || pathname === '/dashboard'
  return pathname.startsWith(item.to)
}

const navItemClass = (active) => cn(
  'inline-flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-slate-300',
  active
    ? 'bg-black text-white shadow-sm'
    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-950'
)

export default function Layout() {
  const [mobileOpen, setMobileOpen] = useState(false)
  const location = useLocation()
  const activeItem = items.find((item) => isActivePath(location.pathname, item))

  return (
    <div className="min-h-screen bg-white text-slate-950">
      <header className="sticky top-0 z-40 bg-white/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-white/85 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-7xl rounded-lg border border-slate-200 bg-white px-3 py-2 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <NavLink to="/" className="flex min-w-0 cursor-pointer items-center gap-3 rounded-lg pr-2 focus:outline-none focus:ring-2 focus:ring-slate-300">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-black">
                <img src="/favicon.svg" alt="Office Gateway" className="h-6 w-6" />
              </div>
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-slate-950">Office Gateway</div>
                <div className="hidden text-xs text-slate-500 sm:block">AI gateway analytics</div>
              </div>
            </NavLink>

            <nav className="hidden items-center gap-1 rounded-lg bg-slate-50 p-1 lg:flex" aria-label="主导航">
              {items.map((item) => {
                const active = isActivePath(location.pathname, item)
                return (
                  <NavLink key={item.to} to={item.to} end={item.end} className={navItemClass(active)}>
                    <item.icon size={15} className={active ? 'text-white' : 'text-slate-500'} />
                    <span>{item.label}</span>
                  </NavLink>
                )
              })}
            </nav>

            <div className="hidden items-center gap-2 lg:flex">
              <div className="inline-flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-700">
                <Activity size={14} />
                实时监控
              </div>
              <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono text-xs text-slate-500">
                port 4000
              </div>
              <NavLink
                to="/settings"
                className={({ isActive }) => cn(
                  'inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg border transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-slate-300',
                  isActive
                    ? 'border-black bg-black text-white'
                    : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-950'
                )}
                aria-label="系统设置"
                title="系统设置"
              >
                <SettingsIcon size={16} />
              </NavLink>
            </div>

            <button
              type="button"
              onClick={() => setMobileOpen((open) => !open)}
              className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-slate-300 lg:hidden"
              aria-expanded={mobileOpen}
              aria-controls="mobile-nav"
            >
              <Menu size={16} />
              <span className="max-w-24 truncate">{activeItem?.label || '菜单'}</span>
              <ChevronDown size={14} className={cn('transition-transform duration-200', mobileOpen && 'rotate-180')} />
            </button>
          </div>

          {mobileOpen && (
            <nav id="mobile-nav" className="mt-3 grid gap-1 border-t border-slate-200 pt-3 lg:hidden" aria-label="移动端导航">
              {[...items, { to: '/settings', label: '系统设置', icon: SettingsIcon }].map((item) => {
                const active = item.to === '/settings'
                  ? location.pathname.startsWith('/settings')
                  : isActivePath(location.pathname, item)
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.end}
                    onClick={() => setMobileOpen(false)}
                    className={navItemClass(active)}
                  >
                    <item.icon size={15} className={active ? 'text-white' : 'text-slate-500'} />
                    <span>{item.label}</span>
                  </NavLink>
                )
              })}
              <div className="mt-2 flex flex-wrap items-center gap-2 px-1 text-xs">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-emerald-700">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  实时监控
                </span>
                <span className="rounded-full border border-slate-200 px-2.5 py-1 font-mono text-slate-500">port 4000</span>
              </div>
            </nav>
          )}
        </div>
      </header>

      <main className="px-4 pb-10 pt-4 sm:px-6 lg:px-8">
        <Outlet />
      </main>
    </div>
  )
}
