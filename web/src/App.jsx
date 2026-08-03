import { useEffect, useState } from 'react'
import { Routes, Route } from 'react-router-dom'
import Layout from './components/Layout'
import Dashboard from './pages/Dashboard'
import Providers from './pages/Providers'
import Mappings from './pages/Mappings'
import Logs from './pages/Logs'
import Settings from './pages/Settings'
import { isDesktopRuntime, subscribeToDesktopRuntime } from './lib/runtime'

/** 组合主布局和管理端页面路由。 */
export default function App() {
  const [desktopMode, setDesktopMode] = useState(() => isDesktopRuntime())

  useEffect(
    () => subscribeToDesktopRuntime(() => setDesktopMode(true)),
    [],
  )

  return (
    <Routes>
      <Route element={<Layout desktopMode={desktopMode} />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/providers" element={<Providers />} />
        <Route path="/mappings" element={<Mappings />} />
        <Route path="/logs" element={<Logs />} />
        <Route path="/settings" element={<Settings />} />
      </Route>
    </Routes>
  )
}
