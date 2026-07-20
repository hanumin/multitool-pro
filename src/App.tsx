import { useEffect, useState, useCallback } from 'react'
import Sidebar from './components/Sidebar'
import ServersModule from './components/modules/ServersModule'
import PrintersModule from './components/modules/PrintersModule'
import AudioModule from './components/modules/AudioModule'
import FileCopierModule from './components/modules/FileCopierModule'
import DatabaseModule from './components/modules/DatabaseModule'
import SettingsModal from './components/SettingsModal'
import { ModuleId, MODULES } from './types'

const API = 'http://127.0.0.1:5050'

type Theme = 'dark' | 'light'

interface ChangelogEntry {
  version: string
  title: string
  items: string[]
}

const CHANGELOGS: ChangelogEntry[] = [
  {
    version: '1.4.0',
    title: 'v1.4.0 - File Copier & Sửa lỗi',
    items: [
      'Tích hợp module File Copier - copy file audio/video theo từ khóa.',
      'Tích hợp module Printer Manager - quản lý máy in (win32print).',
      'Tích hợp module Audio Manager - theo dõi mic & thiết bị audio (pycaw).',
      'Fix bugs: settingsOpen dead code, is_default type inconsistency.',
      'Fix bugs: api_audio_set_default comtypes IPolicyConfig crash.',
      'Tối ưu: gộp OpenPrinter calls, chuẩn hóa kiểu dữ liệu API.',
    ]
  },
  {
    version: '1.3.0',
    title: 'v1.3.0 - Dashboard đa mô-đun với Sidebar',
    items: [
      'Thiết kế lại toàn bộ UI với Sidebar navigation chuyên nghiệp.',
      'Tích hợp module quản lý máy in (Printers) - Win32print API.',
      'Tích hợp module quản lý Microphone & Audio (Audio) - pycaw + Registry.',
      'Sửa lỗi Auto-start cùng Windows: tạo file auto-start.ps1 bị thiếu.',
      'Sửa lỗi nút Open không mở tab: dùng Tauri shell plugin open().',
      'Fix bugs: import psutil, MSI install path, APPDATA safety.'
    ]
  },
  {
    version: '1.2.0',
    title: 'v1.2.0 - Chẩn đoán trực tiếp, Biên tập Env & 3 mức dọn dẹp',
    items: [
      'Sửa lỗi giật lệch khung hình khi chuyển tab log.',
      'Đại tu tính năng dọn dẹp với 3 chế độ (Quick Cache, Deep Build, Nuke Reinstall).',
      'Bổ sung bảng Diagnostics đo lường phần cứng thời gian thực.',
      'Tích hợp thông tin nhánh Git và trạng thái sạch/bẩn.',
      'Xây dựng trình soạn thảo file cấu hình biến môi trường.'
    ]
  },
  {
    version: '1.1.0',
    title: 'v1.1.0 - Khay hệ thống, Màu sắc Log & Khởi động ẩn',
    items: [
      'Ẩn cửa sổ Terminal trống nhờ cờ CREATE_NO_WINDOW.',
      'Tích hợp Icon cho khay hệ thống (System Tray Icon).',
      'Tô màu cú pháp log (ANSI Color Parser) chuyên nghiệp.',
      'Hộp thoại Copy/Export log nâng cao.',
      'Cập nhật giao diện Light/Dark Theme cho Cài đặt.'
    ]
  },
  {
    version: '1.0.0',
    title: 'v1.0.0 - Phiên bản đầu tiên',
    items: [
      'Bảng điều khiển máy chủ Next.js và Node.js cục bộ.',
      'Cấu hình cổng và cổng động.',
      'Quản lý bộ nhớ đệm dự án và làm sạch tự động.'
    ]
  }
]

function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = localStorage.getItem('sd-theme')
    if (stored === 'light' || stored === 'dark') return stored
    return 'dark'
  })

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('sd-theme', theme)
  }, [theme])

  const toggle = () => setTheme(t => t === 'dark' ? 'light' : 'dark')
  return { theme, toggle }
}

function App() {
  const { theme, toggle: toggleTheme } = useTheme()
  const [activeModule, setActiveModule] = useState<ModuleId>('servers')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [statusText, setStatusText] = useState('Sẵn sàng')
  const [autostart, setAutostart] = useState(false)
  const [appVersion, setAppVersion] = useState('1.9.3')
  const [changelogOpen, setChangelogOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsRefresh, setSettingsRefresh] = useState(0)
  const [systemIps, setSystemIps] = useState<string[]>(['localhost', '127.0.0.1'])

  useEffect(() => {
    import('@tauri-apps/api/app')
      .then(m => m.getVersion())
      .then(setAppVersion)
      .catch(() => {})
  }, [])

  useEffect(() => {
    fetch(`${API}/api/settings`).then(r => r.json()).then(d => setAutostart(d.autostart)).catch(() => {})
    fetch(`${API}/api/system/ips`).then(r => r.json()).then(d => {
      if (d && Array.isArray(d.ips)) setSystemIps(d.ips)
    }).catch(() => {})
  }, [])

  const toggleAutostart = async () => {
    const next = !autostart
    try {
      const res = await fetch(`${API}/api/settings/autostart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      })
      const d = await res.json()
      if (d.autostart !== undefined) setAutostart(d.autostart)
    } catch { setStatusText('Lỗi chuyển auto-start') }
  }

  const openBrowser = async (url: string) => {
    try {
      const { open } = await import('@tauri-apps/plugin-shell')
      await open(url); return
    } catch {}
    try {
      await fetch(`${API}/api/system/open-browser`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url })
      })
    } catch { window.open(url, '_blank') }
  }

  const minimizeToTray = async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      await getCurrentWindow().hide()
    } catch {}
  }

  const checkUpdate = async () => {
    try {
      const { check } = await import('@tauri-apps/plugin-updater')
      const { relaunch } = await import('@tauri-apps/plugin-process')
      const update = await check()
      if (update) {
        const ok = window.confirm(`Có bản cập nhật ${update.version}. Tải về và cài đặt?`)
        if (ok) {
          setStatusText('Đang tải bản cập nhật...')
          await update.downloadAndInstall()
          await relaunch()
        }
      } else setStatusText('Bạn đang dùng phiên bản mới nhất')
    } catch (e: any) { setStatusText(e?.message || 'Kiểm tra cập nhật thất bại') }
  }

  const shutdown = async () => {
    if (!window.confirm('Dừng dashboard và tất cả dự án?')) return
    try { await fetch(`${API}/api/shutdown`, { method: 'POST' }) } catch {}
    document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;background:#030712;color:#9ca3af;font-family:sans-serif;font-size:14px">Dashboard đã dừng.</div>'
  }

  const activePort = 5050
  const detectedUrls = systemIps.map(ip => {
    if (ip === 'localhost') return `http://localhost:${activePort}`
    return `http://${ip}:${activePort}`
  })

  const moduleName = MODULES.find(m => m.id === activeModule)?.label || ''

  return (
    <div className="h-screen flex select-none bg-[var(--bg)] text-[var(--fg)]">
      {/* Sidebar */}
      <Sidebar
        activeModule={activeModule}
        onModuleChange={setActiveModule}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
        statusText={statusText}
      />

      {/* Main content area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <header className="shrink-0 backdrop-blur-md border-b px-5 py-2.5 flex items-center justify-between"
          style={{ background: 'var(--bg-header)', borderColor: 'var(--border)' }}>
          <div className="flex items-center gap-2">
            <h1 className="text-sm font-semibold tracking-tight" style={{ color: 'var(--fg)' }}>
              {moduleName}
            </h1>
            <span className="text-[10px] px-1.5 py-0.5 rounded font-mono border"
              style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-muted)' }}>
              {activeModule}
            </span>
          </div>

          <div className="flex items-center gap-2">
            {/* Status dots */}
            <div className="flex -space-x-1 mr-1">
              {MODULES.map(mod => (
                <div key={mod.id}
                  className={`w-2 h-2 rounded-full ring-1 ring-gray-700 ${activeModule === mod.id ? 'bg-emerald-400' : ''}`}
                  style={{ backgroundColor: activeModule === mod.id ? undefined : 'var(--fg-dim)' }}
                  title={mod.label} />
              ))}
            </div>

            {/* Settings button */}
            <button onClick={() => setSettingsOpen(true)}
              className="p-1.5 rounded-lg transition-all active:scale-95 cursor-pointer border-0"
              style={{ color: 'var(--fg-muted)', background: 'transparent' }}
              title="Cài đặt">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </button>

            {/* Theme toggle */}
            <button onClick={toggleTheme}
              className="p-1.5 rounded-lg transition-all active:scale-95 cursor-pointer border-0"
              style={{ color: 'var(--fg-muted)', background: 'transparent' }}
              title={theme === 'dark' ? 'Giao diện sáng' : 'Giao diện tối'}>
              {theme === 'dark' ? (
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
                </svg>
              ) : (
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
                </svg>
              )}
            </button>

            {/* Minimize to tray */}
            <button onClick={minimizeToTray}
              className="p-1.5 rounded-lg transition-all active:scale-95 cursor-pointer border-0"
              style={{ color: 'var(--fg-muted)', background: 'transparent' }}
              title="Thu gọn xuống khay hệ thống">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M20 12H4" />
              </svg>
            </button>
          </div>
        </header>

        {/* Module content */}
        <div className="flex-1 min-h-0 overflow-hidden">
          {activeModule === 'servers' && <ServersModule theme={theme} setStatusText={setStatusText} />}
          {activeModule === 'printers' && <PrintersModule theme={theme} setStatusText={setStatusText} />}
          {activeModule === 'audio' && <AudioModule theme={theme} setStatusText={setStatusText} />}
          {activeModule === 'file-copier' && <FileCopierModule theme={theme} setStatusText={setStatusText} />}
          {activeModule === 'database' && <DatabaseModule theme={theme} setStatusText={setStatusText} />}
        </div>

        {/* Bottom Bar */}
        <footer className="shrink-0 backdrop-blur-md border-t px-5 py-1.5 flex items-center justify-between text-[10px]"
          style={{ background: 'var(--bg-header)', borderColor: 'var(--border)', color: 'var(--fg-dim)' }}>
          <div className="flex items-center gap-3 flex-wrap">
            <button onClick={checkUpdate}
              className="hover:underline cursor-pointer bg-transparent border-0"
              style={{ color: 'var(--fg-muted)' }}>Kiểm tra cập nhật</button>
            <span style={{ color: 'var(--fg-dim)' }}>|</span>
            
            {/* URL links */}
            <div className="hidden lg:flex items-center gap-2 font-mono">
              {detectedUrls.map((url, idx) => (
                <span key={url} className="flex items-center gap-2">
                  {idx > 0 && <span style={{ color: 'var(--fg-dim)' }}>|</span>}
                  <button onClick={() => openBrowser(url)}
                    className="hover:underline hover:text-emerald-400 bg-transparent border-0 cursor-pointer p-0"
                    style={{ color: '#3b82f6', fontSize: 'inherit' }}>
                    {url.replace('http://', '')}
                  </button>
                </span>
              ))}
            </div>

            {/* Mobile URL select */}
            <div className="flex lg:hidden">
              <select id="mobile-url-select" name="urlSelect" onChange={e => { if (e.target.value) { openBrowser(e.target.value); e.target.value = '' } }}
                className="px-1 py-0.5 text-[9px] rounded border"
                style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}>
                <option value="">URL...</option>
                {detectedUrls.map(url => (
                  <option key={url} value={url}>{url.replace('http://', '')}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <label htmlFor="autostart-checkbox" className="flex items-center gap-1.5 cursor-pointer select-none" style={{ color: 'var(--fg-dim)' }}>
              <input id="autostart-checkbox" name="autostart" type="checkbox" checked={autostart} onChange={toggleAutostart}
                className="w-3 h-3 rounded cursor-pointer accent-emerald-500" />
              Tự động khởi động
            </label>
            <span style={{ color: 'var(--fg-dim)' }}>|</span>
            <button onClick={() => setChangelogOpen(true)}
              className="hover:underline cursor-pointer font-semibold text-emerald-500 hover:text-emerald-400 transition-colors bg-transparent border-0"
              title="Xem nhật ký thay đổi">
              v{appVersion}
            </button>
          </div>
        </footer>
      </div>

      {/* Settings Modal */}
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)}
        onChanged={() => { setSettingsRefresh(prev => prev + 1) }} />

      {/* Changelog Modal */}
      {changelogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={e => { if (e.target === e.currentTarget) setChangelogOpen(false) }}>
          <div className="w-full max-w-md rounded-2xl border shadow-2xl p-6 transition-colors flex flex-col"
            style={{ backgroundColor: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--fg)' }}>
            <div className="flex items-center justify-between pb-4 border-b" style={{ borderColor: 'var(--border)' }}>
              <h3 className="text-sm font-semibold">Nhật ký thay đổi</h3>
              <button onClick={() => setChangelogOpen(false)}
                className="p-1 rounded-lg hover:bg-black/10 dark:hover:bg-white/10 transition-colors cursor-pointer border-0"
                style={{ color: 'var(--fg-muted)' }}>&times;</button>
            </div>
            <div className="mt-4 space-y-4 max-h-[50vh] overflow-y-auto pr-1">
              {CHANGELOGS.map((ch, idx) => (
                <div key={ch.version} className={idx > 0 ? "pt-4 border-t" : ""} style={{ borderColor: 'var(--border)' }}>
                  <span className="text-xs font-bold text-emerald-500">Version {ch.version}</span>
                  <h4 className="text-xs font-semibold mb-2 mt-1" style={{ color: 'var(--fg-secondary)' }}>{ch.title}</h4>
                  <ul className="list-disc list-inside space-y-1 text-[11px]" style={{ color: 'var(--fg-muted)' }}>
                    {ch.items.map((item, i) => (
                      <li key={i} className="pl-1 -indent-4 ml-4">{item}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            <div className="mt-6 flex justify-end">
              <button onClick={() => setChangelogOpen(false)}
                className="px-4 py-1.5 text-[11px] font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-colors cursor-pointer border-0">Đóng</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
