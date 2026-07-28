import { useEffect, useState } from 'react'
import { ModuleId, MODULES } from '../types'
import { type LogColors, DEFAULT_LOG_COLORS } from '../utils/logStyles'
import { API, fetchWithRetry } from '../utils/apiFetch'

// WHY: Danh sách cấp độ log cho Settings — tương ứng với LogColors keys + DEFAULT_LOG_COLORS.
const LOG_COLOR_LEVELS: { key: keyof LogColors; label: string; icon: string }[] = [
  { key: 'error',     label: 'Lỗi',         icon: '🔴' },
  { key: 'warn',      label: 'Cảnh báo',    icon: '🟡' },
  { key: 'success',   label: 'Thành công',  icon: '🟢' },
  { key: 'build',     label: 'Xây dựng',    icon: '🔵' },
  { key: 'tunnel',    label: 'Tunnel',      icon: '🌐' },
  { key: 'metrics',   label: 'Chỉ số',      icon: '🟣' },
  { key: 'cleanup',   label: 'Dọn dẹp',     icon: '🩷' },
  { key: 'debug',     label: 'Gỡ lỗi',      icon: '⚪' },
  { key: 'defaultText', label: 'Mặc định',  icon: '📄' },
]

interface Project {
  name: string
  path: string
  command: string
  port: number
}

interface Props {
  open: boolean
  onClose: () => void
  onChanged: () => void
  backgroundPolling?: Record<ModuleId, boolean>
  onBackgroundPollingChange?: (polling: Record<ModuleId, boolean>) => void
  logColors?: LogColors
  onLogColorsChange?: (colors: LogColors) => void
  theme?: 'dark' | 'light'
  onToggleTheme?: () => void
}

// WHY: Modal cài đặt toàn hệ thống — quản lý projects (CRUD), port range, reload config.
// open/onClose controlled component (parent App quyết định hiển thị).
// onChanged callback để App refresh status khi settings thay đổi.
export default function SettingsModal({ open, onClose, onChanged, backgroundPolling, onBackgroundPollingChange, logColors, onLogColorsChange, theme, onToggleTheme }: Props) {
  const [projects, setProjects] = useState<Project[]>([])
  const [edit, setEdit] = useState<Partial<Project> | null>(null)
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [reloading, setReloading] = useState(false)
  const [loadingConfig, setLoadingConfig] = useState(false)

  // Global settings
  const [portMin, setPortMin] = useState(4000)
  const [portMax, setPortMax] = useState(4999)

  // Running statuses of projects
  const [runningStatus, setRunningStatus] = useState<Record<string, boolean>>({})

  // Option to auto-start project after adding
  const [startAfterAdd, setStartAfterAdd] = useState(false)

  useEffect(() => {
    if (open) fetchConfig()
  }, [open])

  // WHY: fetchWithRetry đã xử lý retry tự động (exponential backoff 300ms, 1s, 2.5s).
  // Không cần manual retry loop nữa.
  const fetchConfig = async () => {
    setLoadingConfig(true)
    setError('')
    try {
      const [configRes, projectsRes] = await Promise.all([
        fetchWithRetry(`${API}/api/config`),
        fetchWithRetry(`${API}/api/projects`)
      ])
      
      if (!configRes.ok || !projectsRes.ok) {
        throw new Error('Server response not OK')
      }

      const configData = await configRes.json()
      const projectsData = await projectsRes.json()

      setProjects(configData.projects || [])
      setPortMin(configData.portMin ?? 4000)
      setPortMax(configData.portMax ?? 4999)

      const runningMap: Record<string, boolean> = {}
      projectsData.forEach((p: any) => {
        runningMap[p.name] = p.running
      })
      setRunningStatus(runningMap)
      setError('')
    } catch (err) {
      setError('Không thể tải cấu hình sau nhiều lần thử')
    } finally {
      setLoadingConfig(false)
    }
  }

  // WHY: POST create vs PUT update — phân biệt bằng editingIndex (null = new, number = edit).
  // Nếu startAfterAdd và là project mới → start ngay sau khi thêm.
  const saveProject = async () => {
    if (!edit || !edit.name || !edit.path) {
      setError('Cần nhập tên và đường dẫn')
      return
    }
    setError('')
    try {
      const isNew = editingIndex === null
      if (!isNew) {
        const oldName = projects[editingIndex].name
        const res = await fetchWithRetry(`${API}/api/config/projects/${encodeURIComponent(oldName)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(edit),
        })
        if (!res.ok) {
          const e = await res.json()
          setError(e.error)
          return
        }
      } else {
        const res = await fetchWithRetry(`${API}/api/config/projects`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(edit),
        })
        if (!res.ok) {
          const e = await res.json()
          setError(e.error)
          return
        }

        // Start project immediately after adding if user checked the option
        if (startAfterAdd) {
          await fetchWithRetry(`${API}/api/projects/${encodeURIComponent(edit.name)}/start`, {
            method: 'POST'
          })
        }
      }
      setEdit(null)
      setEditingIndex(null)
      setStartAfterAdd(false)
      await fetchConfig()
      onChanged()
    } catch {
      setError('Lưu thất bại')
    }
  }

  // WHY: PUT /api/config với portMin/portMax. Gửi toàn bộ config object (backend merge).
  // FetchConfig + onChanged để đồng bộ App state với modal state.
  const saveGlobalSettings = async () => {
    setError('')
    try {
      const res = await fetchWithRetry(`${API}/api/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ portMin, portMax }),
      })
      if (!res.ok) {
        const e = await res.json()
        setError(e.error)
      } else {
        await fetchConfig()
        onChanged()
      }
    } catch {
      setError('Lưu cài đặt chung thất bại')
    }
  }

  // WHY: Confirm trước khi xóa — nếu project đang chạy, cảnh báo riêng.
  // DELETE API endpoint + fetchConfig refresh.
  const deleteProject = async (name: string) => {
    const isRunning = runningStatus[name]
    const confirmMsg = isRunning
      ? `"${name}" đang chạy. Dừng và xóa dự án này?`
      : `Xóa "${name}"?`
    
    if (!window.confirm(confirmMsg)) return
    try {
      await fetchWithRetry(`${API}/api/config/projects/${encodeURIComponent(name)}`, { method: 'DELETE' })
      await fetchConfig()
      onChanged()
    } catch {
      setError('Xóa thất bại')
    }
  }

  // WHY: POST /api/config/reload — đọc lại file config từ disk (không restart backend).
  // Dùng khi user sửa file config thủ công.
  const reloadConfig = async () => {
    setReloading(true)
    try {
      await fetchWithRetry(`${API}/api/config/reload`, { method: 'POST' })
      await fetchConfig()
      onChanged()
    } catch {}
    setReloading(false)
  }

  // WHY: Browse file system directory using Tauri's dialog API
  const browseFolder = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({ directory: true, multiple: false })
      if (selected && typeof selected === 'string') {
        setEdit(p => p ? { ...p, path: selected } : null)
      }
    } catch (err) {
      console.error('Failed to open folder dialog:', err)
      setError('Chọn thư mục chỉ khả dụng khi chạy trong ứng dụng desktop.')
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="w-full max-w-2xl max-h-[85vh] rounded-2xl shadow-2xl overflow-hidden flex flex-col border transition-colors duration-200"
        style={{ backgroundColor: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--fg)' }}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b shrink-0"
          style={{ borderColor: 'var(--border)' }}>
          <h2 className="text-sm font-semibold">Cài đặt</h2>
          <button onClick={onClose}
            className="p-1 rounded-lg transition-all active:scale-95 hover:bg-black/10 dark:hover:bg-white/10"
            style={{ color: 'var(--fg-muted)' }}>
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-6 overflow-y-auto flex-1 space-y-6">
          {error && (
            <div className="bg-red-900/20 border border-red-800 text-red-400 px-4 py-2 rounded-lg text-xs flex items-center justify-between">
              <span>{error}</span>
              <button onClick={() => setError('')} className="ml-2 text-red-400 hover:text-red-200">&times;</button>
            </div>
          )}

          {loadingConfig ? (
            <div className="flex flex-col items-center justify-center py-12 space-y-3">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-emerald-500" />
              <span className="text-xs text-gray-400">Đang tải cấu hình...</span>
            </div>
          ) : (
            <>
              {/* Global Settings */}
              <div className="rounded-xl p-5 border space-y-4 transition-colors duration-200"
                style={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border)' }}>
                <h3 className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--fg-secondary)' }}>Cài đặt chung</h3>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="settings-port-min" className="text-xs mb-1 block" style={{ color: 'var(--fg-muted)' }}>Cổng tối thiểu</label>
                    <input id="settings-port-min" name="portMin" type="number" value={portMin} onChange={e => setPortMin(parseInt(e.target.value) || 0)}
                      className="w-full border rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500 transition-colors duration-200"
                      style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--fg)' }} />
                  </div>
                  <div>
                    <label htmlFor="settings-port-max" className="text-xs mb-1 block" style={{ color: 'var(--fg-muted)' }}>Cổng tối đa</label>
                    <input id="settings-port-max" name="portMax" type="number" value={portMax} onChange={e => setPortMax(parseInt(e.target.value) || 0)}
                      className="w-full border rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500 transition-colors duration-200"
                      style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--fg)' }} />
                  </div>
                </div>
              </div>

              {/* Theme Toggle */}
              {theme && onToggleTheme && (
                <div className="rounded-xl p-5 border space-y-3 transition-colors duration-200"
                  style={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border)' }}>
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--fg-secondary)' }}>
                        Giao diện
                      </h3>
                      <p className="text-[10px] mt-0.5" style={{ color: 'var(--fg-muted)' }}>
                        {theme === 'dark' ? '🌙 Giao diện tối' : '☀️ Giao diện sáng'}
                      </p>
                    </div>
                    <button onClick={onToggleTheme}
                      className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-lg border transition-all active:scale-95 cursor-pointer hover:bg-black/5 dark:hover:bg-white/5"
                      style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}>
                      {theme === 'dark' ? (
                        <><svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
                        </svg>
                        Chuyển sáng</>
                      ) : (
                        <><svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
                        </svg>
                        Chuyển tối</>
                      )}
                    </button>
                  </div>
                </div>
              )}

              {/* Background Polling Toggles */}
              {backgroundPolling && onBackgroundPollingChange && (
                <div className="rounded-xl p-5 border space-y-3 transition-colors duration-200"
                  style={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border)' }}>
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--fg-secondary)' }}>
                      Polling nền
                    </h3>
                    <span className="text-[10px]" style={{ color: 'var(--fg-muted)' }}>
                      Cho phép module chạy ngầm khi không được chọn
                    </span>
                  </div>
                  <div className="space-y-1.5">
                    {MODULES.filter(mod => mod.polls).map(mod => {
                      const isOn = backgroundPolling[mod.id]
                      return (
                        <div key={mod.id}
                          className="flex items-center justify-between px-3 py-2 rounded-lg transition-colors"
                          style={{ backgroundColor: isOn ? 'rgba(34,197,94,0.05)' : 'transparent' }}>
                          <div className="flex items-center gap-2.5">
                            <span className="text-sm">{mod.icon}</span>
                            <div>
                              <span className="text-xs font-medium" style={{ color: 'var(--fg)' }}>{mod.label}</span>
                              <span className="text-[10px] ml-2" style={{ color: 'var(--fg-muted)' }}>{mod.description}</span>
                            </div>
                          </div>
                          <label className="relative inline-flex items-center cursor-pointer">
                            <input type="checkbox" id={`bg-polling-${mod.id}`} name={`bg-polling-${mod.id}`} checked={isOn}
                              onChange={e => onBackgroundPollingChange({ ...backgroundPolling, [mod.id]: e.target.checked })}
                              className="sr-only peer" />
                            <div className="w-8 h-4 rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-emerald-500 bg-gray-600/40" />
                          </label>
                        </div>
                      )
                    })}
                  </div>
                  <div className="pt-1 text-[10px]" style={{ color: 'var(--fg-muted)' }}>
                    {Object.values(backgroundPolling).some(Boolean)
                      ? `✅ Đang bật polling nền cho ${Object.entries(backgroundPolling).filter(([,v]) => v).length} module`
                      : '💤 Tất cả module chỉ poll khi được chọn (tiết kiệm tài nguyên nhất)'}
                  </div>
                </div>
              )}

              {/* Log Color Customization */}
              {logColors !== undefined && onLogColorsChange && (
                <div className="rounded-xl p-5 border space-y-3 transition-colors duration-200"
                  style={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border)' }}>
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--fg-secondary)' }}>
                      Màu sắc log
                    </h3>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px]" style={{ color: 'var(--fg-muted)' }}>Tùy chỉnh màu chữ cho từng cấp độ log</span>
                      <button onClick={() => {
                        const hasCustom = Object.keys(logColors).length > 0
                        if (hasCustom && !window.confirm('Đặt lại tất cả màu về mặc định?')) return
                        onLogColorsChange({})
                      }}
                        className="px-2 py-0.5 text-[8px] font-semibold rounded border transition-colors active:scale-95 cursor-pointer"
                        style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-muted)' }}>
                        Đặt lại
                      </button>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {LOG_COLOR_LEVELS.map(({ key, label, icon }) => {
                      const currentColor = logColors[key] || DEFAULT_LOG_COLORS[key]
                      return (
                        <div key={key}
                          className="flex items-center gap-2 px-3 py-2 rounded-lg transition-colors hover:bg-white/[0.02]">
                          <span className="text-sm">{icon}</span>
                          <div className="flex-1 min-w-0">
                            <span className="text-xs font-medium" style={{ color: 'var(--fg)' }}>{label}</span>
                          </div>
                          <div className="relative">
                            <input type="color" id={`log-color-${key}`} name={`log-color-${key}`} value={currentColor}
                              onChange={e => onLogColorsChange({ ...logColors, [key]: e.target.value })}
                              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                              title={`Thay đổi màu ${label}`} />
                            <div className="w-6 h-6 rounded-md border shadow-sm transition-transform active:scale-95"
                              style={{ backgroundColor: currentColor, borderColor: 'var(--border)' }} />
                          </div>
                        </div>
                      )
                    })}
                  </div>
                  <div className="pt-1 text-[10px]" style={{ color: 'var(--fg-muted)' }}>
                    {Object.keys(logColors).length > 0
                      ? `🎨 Đã tùy chỉnh ${Object.keys(logColors).length}/${LOG_COLOR_LEVELS.length} màu`
                      : 'Màu mặc định — nhấn vào ô màu để thay đổi'}
                  </div>
                </div>
              )}

              {/* Projects list */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--fg-secondary)' }}>Dự án</h3>
                  <div className="flex gap-2">
                    <button onClick={reloadConfig} disabled={reloading}
                      className="px-2.5 py-1 text-xs font-medium border rounded-lg transition-colors disabled:opacity-40 active:scale-95 cursor-pointer"
                      style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}>
                      {reloading ? '...' : 'Tải lại từ đĩa'}
                    </button>
                    <button onClick={() => { setEdit({ name: '', path: '', command: 'npm run dev', port: 4000 }); setEditingIndex(null); setStartAfterAdd(false) }}
                      className="px-2.5 py-1 text-xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-colors active:scale-95 cursor-pointer">
                      + Thêm dự án
                    </button>
                  </div>
                </div>

                <div className="space-y-2">
                  {projects.length === 0 && (
                    <p className="text-xs italic py-4 text-center" style={{ color: 'var(--fg-dim)' }}>Chưa có dự án nào.</p>
                  )}
                  {projects.map((p, i) => (
                    <div key={p.name}
                      className="flex items-center justify-between rounded-lg px-4 py-3 border transition-colors duration-200 group"
                      style={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border)' }}>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium" style={{ color: 'var(--fg)' }}>{p.name}</span>
                          <span className="text-xs font-mono border px-1.5 py-0.5 rounded transition-colors duration-200"
                            style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-muted)' }}>
                            :{p.port}
                          </span>
                          {runningStatus[p.name] && (
                            <span className="text-[10px] bg-emerald-500/15 text-emerald-500 border border-emerald-500/20 px-1 py-0.5 rounded font-medium">
                              ĐANG CHẠY
                            </span>
                          )}
                        </div>
                        <p className="text-xs truncate mt-0.5 font-mono" style={{ color: 'var(--fg-muted)' }}>{p.path}</p>
                        <p className="text-xs font-mono" style={{ color: 'var(--fg-dim)' }}>{p.command}</p>
                      </div>
                      <div className="flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0 ml-3">
                        <button onClick={() => { setEdit({ ...p }); setEditingIndex(i) }}
                          className="px-2 py-1 text-xs font-medium bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 rounded-lg transition-colors active:scale-95 cursor-pointer">
                          Sửa
                        </button>
                        <button onClick={() => deleteProject(p.name)}
                          className="px-2 py-1 text-xs font-medium bg-red-500/10 text-red-400 hover:bg-red-500/20 rounded-lg transition-colors active:scale-95 cursor-pointer">
                          Xóa
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Edit / Add form */}
              {edit && (
                <div className="rounded-xl p-5 border space-y-4 transition-colors duration-200"
                  style={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border)' }}>
                  <h3 className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--fg-secondary)' }}>
                    {editingIndex !== null ? 'Sửa dự án' : 'Thêm dự án'}
                  </h3>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label htmlFor="settings-proj-name" className="text-xs mb-1 block" style={{ color: 'var(--fg-muted)' }}>Tên *</label>
                      <input id="settings-proj-name" name="projName" value={edit.name || ''} onChange={e => setEdit(p => ({ ...p, name: e.target.value }))}
                        className="w-full border rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500 transition-colors duration-200"
                        style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--fg)' }}
                        placeholder="MyApp" />
                    </div>
                    <div>
                      <label htmlFor="settings-proj-port" className="text-xs mb-1 block" style={{ color: 'var(--fg-muted)' }}>Port</label>
                      <input id="settings-proj-port" name="projPort" type="number" value={edit.port ?? 4000} onChange={e => setEdit(p => ({ ...p, port: parseInt(e.target.value) || 0 }))}
                        className="w-full border rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500 transition-colors duration-200"
                        style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--fg)' }} />
                    </div>
                  </div>

                  <div>
                    <label htmlFor="settings-proj-path" className="text-xs mb-1 block" style={{ color: 'var(--fg-muted)' }}>Đường dẫn *</label>
                    <div className="flex gap-2">
                      <input id="settings-proj-path" name="projPath" value={edit.path || ''} onChange={e => setEdit(p => ({ ...p, path: e.target.value }))}
                        className="flex-1 border rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500 transition-colors duration-200"
                        style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--fg)' }}
                        placeholder="C:\Users\...\my-project" />
                      <button onClick={browseFolder}
                        className="px-3 py-2 text-xs font-medium border rounded-lg transition-colors shrink-0 active:scale-95 cursor-pointer"
                        style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}>
                        Chọn...
                      </button>
                    </div>
                  </div>

                  <div>
                    <label htmlFor="settings-proj-command" className="text-xs mb-1 block" style={{ color: 'var(--fg-muted)' }}>Lệnh</label>
                    <div className="grid grid-cols-3 gap-2">
                      <select id="settings-proj-command-template" name="projCommandTemplate" onChange={e => {
                        const val = e.target.value
                        if (val) {
                          setEdit(p => p ? { ...p, command: val } : null)
                        }
                      }}
                      className="border rounded-lg px-2 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-emerald-500 transition-colors duration-200"
                      style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--fg)' }}>
                        <option value="" style={{ background: 'var(--bg)', color: 'var(--fg)' }}>Mẫu...</option>
                        <option value="npm run dev" style={{ background: 'var(--bg)', color: 'var(--fg)' }}>npm run dev</option>
                        <option value="npm run dev -- -p {port}" style={{ background: 'var(--bg)', color: 'var(--fg)' }}>npm run dev -- -p {'{port}'}</option>
                        <option value="npm start" style={{ background: 'var(--bg)', color: 'var(--fg)' }}>npm start</option>
                        <option value="yarn dev" style={{ background: 'var(--bg)', color: 'var(--fg)' }}>yarn dev</option>
                        <option value="yarn dev -p {port}" style={{ background: 'var(--bg)', color: 'var(--fg)' }}>yarn dev -p {'{port}'}</option>
                      </select>
                      <input id="settings-proj-command" name="projCommand" value={edit.command || ''} onChange={e => setEdit(p => ({ ...p, command: e.target.value }))}
                        className="col-span-2 border rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500 transition-colors duration-200"
                        style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--fg)' }}
                        placeholder="npm run dev" />
                    </div>
                  </div>

                  {editingIndex === null && (
                    <label htmlFor="settings-start-after-add" className="flex items-center gap-2 text-xs select-none cursor-pointer" style={{ color: 'var(--fg-secondary)' }}>
                      <input id="settings-start-after-add" name="startAfterAdd" type="checkbox" checked={startAfterAdd} onChange={e => setStartAfterAdd(e.target.checked)}
                        className="w-3.5 h-3.5 rounded border-gray-700 bg-gray-900 accent-emerald-500 cursor-pointer" />
                      Start project immediately after adding
                    </label>
                  )}

                  <div className="flex justify-end gap-2 pt-2">
                    <button onClick={() => { setEdit(null); setEditingIndex(null); setStartAfterAdd(false) }}
                      className="px-3 py-1.5 text-xs font-medium border rounded-lg transition-colors active:scale-95 cursor-pointer"
                      style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}>
                      Hủy
                    </button>
                    <button onClick={saveProject}
                      className="px-4 py-1.5 text-xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-colors active:scale-95 cursor-pointer">
                      {editingIndex !== null ? 'Save Changes' : 'Add Project'}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
