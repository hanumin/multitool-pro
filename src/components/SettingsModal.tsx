import { useEffect, useState } from 'react'
import { ModuleId, PLATFORM_MODULES } from '../types'
import { type LogColors, DEFAULT_LOG_COLORS } from '../utils/logStyles'
import { API, fetchWithRetry } from '../utils/apiFetch'

// WHY: Danh sách cấp độ log cho Settings — tương ứng với LogColors keys + DEFAULT_LOG_COLORS.
const LOG_COLOR_LEVELS: { key: keyof LogColors; label: string; icon: string; desc: string }[] = [
  { key: 'error',     label: 'Lỗi (Error)',       icon: '🔴', desc: 'Các dòng log chứa lỗi hoặc ngoại lệ' },
  { key: 'warn',      label: 'Cảnh báo (Warn)',    icon: '🟡', desc: 'Cảnh báo hiệu năng hoặc cấu hình' },
  { key: 'success',   label: 'Thành công (OK)',    icon: '🟢', desc: 'Khởi động hoàn tất, phản hồi 200 OK' },
  { key: 'build',     label: 'Xây dựng (Build)',  icon: '🔵', desc: 'Quá trình biên dịch Vite/Webpack/Tauri' },
  { key: 'tunnel',    label: 'Cloudflare Tunnel', icon: '🌐', desc: 'Thông tin kết nối đường hầm ra internet' },
  { key: 'metrics',   label: 'Chỉ số (Metrics)',  icon: '🟣', desc: 'Mức tiêu thụ CPU/RAM và tài nguyên' },
  { key: 'cleanup',   label: 'Dọn dẹp (Cleanup)', icon: '🩷', desc: 'Xóa cache, dọn rác node_modules' },
  { key: 'debug',     label: 'Gỡ lỗi (Debug)',    icon: '⚪', desc: 'Thông tin chi tiết hỗ trợ gỡ lỗi' },
  { key: 'defaultText', label: 'Văn bản mặc định',icon: '📄', desc: 'Các dòng log thông thường' },
]

interface Project {
  name: string
  path: string
  command: string
  port: number
  start_on_launch?: boolean
  type?: 'node' | 'custom'
  process_name?: string
  framework?: string
  confidence?: number
  detected?: boolean
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
  animState?: 'enter' | 'exit'
}

type TabType = 'general' | 'projects' | 'logColors'

// WHY: Modal Settings trung tâm — tabs General (port range/theme), Projects
// (CRUD + auto-detect + start_on_launch), LogColors; anim enter/exit như About.
export default function SettingsModal({
  open,
  onClose,
  onChanged,
  backgroundPolling,
  onBackgroundPollingChange,
  logColors,
  onLogColorsChange,
  theme,
  onToggleTheme,
  animState = 'enter'
}: Props) {
  const [activeTab, setActiveTab] = useState<TabType>('general')
  const [projects, setProjects] = useState<Project[]>([])
  const [edit, setEdit] = useState<Partial<Project> | null>(null)
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [reloading, setReloading] = useState(false)
  const [loadingConfig, setLoadingConfig] = useState(false)
  const [detecting, setDetecting] = useState(false)

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

  // WHY: Tải config + running status song song khi mở modal — projects từ
  // /api/config (cấu hình), running map từ /api/projects (liveness thật).
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

  // WHY: Lưu project (thêm mới POST hoặc cập nhật PUT theo editingIndex) — sau
  // khi thêm có tùy chọn start ngay; luôn refetch config + báo onChanged cho App.
  const saveProject = async () => {
    if (!edit || !edit.name) {
      setError('Cần nhập tên')
      return
    }
    if (edit.type !== 'custom' && !edit.path) {
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

  // WHY: Lưu cài đặt chung (portMin/portMax) qua PUT /api/config — backend dùng
  // range này khi tự gán port cho project mới.
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

  // WHY: Xóa project khỏi config — cảnh báo trước nếu project đang chạy (xóa sẽ
  // không stop process, chỉ gỡ khỏi danh sách quản lý).
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

  // WHY: Reload config từ đĩa (sau khi user sửa file config.json ngoài app) —
  // POST /api/config/reload để backend đọc lại rồi fetch về UI.
  const reloadConfig = async () => {
    setReloading(true)
    try {
      await fetchWithRetry(`${API}/api/config/reload`, { method: 'POST' })
      await fetchConfig()
      onChanged()
    } catch {}
    setReloading(false)
  }

  // WHY: Chọn thư mục project qua dialog Tauri (plugin-dialog) — chỉ chạy trong
  // desktop runtime; browser fallback báo lỗi cho user.
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

  // WHY: Auto-detect framework/command/port cho path đã điền — POST
  // /api/config/projects/detect rồi auto-fill form + badge framework/confidence.
  const detectFromPath = async () => {
    if (!edit?.path) { setError('Chọn thư mục trước khi tự phát hiện'); return }
    setDetecting(true); setError('')
    try {
      const res = await fetchWithRetry(`${API}/api/config/projects/detect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: edit.path }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Không phát hiện thấy project')
        setEdit(p => p ? { ...p, detected: false, framework: undefined } : p)
        return
      }
      const det = data.project
      setEdit(p => ({
        ...(p || { name: '', path: '', command: '', port: 4000 }),
        name: det.name,
        path: det.path ?? p?.path,
        command: det.command,
        port: det.port ?? 4000,
        framework: det.framework,
        confidence: det.confidence,
        detected: true,
      }))
    } catch {
      setError('Không phát hiện thất bại')
    }
    setDetecting(false)
  }

  if (!open) return null

  return (
    <div className={`fixed inset-0 z-50 flex items-center justify-center bg-black/65 backdrop-blur-md ${animState === 'enter' ? 'animate-modal-in' : 'animate-modal-out'}`}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className={`w-full max-w-4xl h-[80vh] rounded-2xl shadow-2xl overflow-hidden flex flex-col border transition-all duration-200 ${animState === 'enter' ? 'animate-modal-content-in' : 'animate-modal-content-out'}`}
        style={{ backgroundColor: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--fg)' }}>
        
        {/* WHY: Header redesign — gradient accent bar 2px trên cùng + icon trong container
            gradient + subtitle 2 dòng. Nổi bật hơn header phẳng trước đây. */}
        <div className="relative shrink-0">
          <div className="absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-emerald-500 via-teal-400 to-emerald-500" />
          <div className="flex items-center justify-between px-5 py-3 border-b backdrop-blur-md"
            style={{ borderColor: 'var(--border)', background: 'linear-gradient(180deg, rgba(52,211,153,0.08), transparent)' }}>
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-emerald-400/25 to-emerald-600/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400 shadow-sm shadow-emerald-500/10 shrink-0">
                <span className="text-base">⚙️</span>
              </div>
              <div>
                <h2 className="text-sm font-bold tracking-tight leading-tight" style={{ color: 'var(--fg)' }}>Cấu hình hệ thống</h2>
                <p className="text-[10px] mt-0.5" style={{ color: 'var(--fg-muted)' }}>Quản lý máy chủ · cổng dịch vụ · màu sắc log</p>
              </div>
            </div>
            <button onClick={onClose}
              className="p-1.5 rounded-lg transition-all active:scale-95 hover:bg-white/10 border-0 cursor-pointer text-slate-400 hover:text-white focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:outline-none"
              aria-label="Đóng cửa sổ" title="Đóng cửa sổ">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Modal Main Content — Professional 2-Column Layout */}
        <div className="flex-1 min-h-0 flex overflow-hidden">
          {/* Left Navigation Sidebar — nền sáng hơn thân modal (var(--bg-card)) và
              label inactive màu slate-300 (thay vì slate-400/đậm) để dễ đọc — trước
              đây menu xám đen + chữ xám đậm bị khó nhìn. */}
          <div className="w-56 border-r shrink-0 p-2.5 space-y-1 bg-white/[0.03]" style={{ borderColor: 'var(--border)', background: 'var(--bg-card)' }}>
            <button
              onClick={() => setActiveTab('general')}
              className={`relative w-full flex items-center gap-2.5 pl-4 pr-3 py-2.5 rounded-xl text-xs font-semibold transition-all cursor-pointer border-0 text-left ${
                activeTab === 'general'
                  ? 'bg-emerald-500/12 text-emerald-400'
                  : 'hover:bg-white/10 text-slate-300 hover:text-white'
              }`}
            >
              {/* WHY: Accent bar trái khi active — kiểu VSCode settings, dễ nhận tab đang chọn */}
              {activeTab === 'general' && (
                <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)]" />
              )}
              <span className={`w-6 h-6 rounded-lg flex items-center justify-center text-sm shrink-0 transition-colors ${activeTab === 'general' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-white/10 text-slate-300'}`}>🎛️</span>
              <span className="truncate">Cài đặt chung</span>
            </button>

            <button
              onClick={() => setActiveTab('projects')}
              className={`relative w-full flex items-center justify-between pl-4 pr-3 py-2.5 rounded-xl text-xs font-semibold transition-all cursor-pointer border-0 text-left ${
                activeTab === 'projects'
                  ? 'bg-emerald-500/12 text-emerald-400'
                  : 'hover:bg-white/10 text-slate-300 hover:text-white'
              }`}
            >
              {activeTab === 'projects' && (
                <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)]" />
              )}
              <div className="flex items-center gap-2.5 truncate">
                <span className={`w-6 h-6 rounded-lg flex items-center justify-center text-sm shrink-0 transition-colors ${activeTab === 'projects' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-white/10 text-slate-300'}`}>🖥️</span>
                <span className="truncate">Máy chủ ({projects.length})</span>
              </div>
              {projects.filter(p => runningStatus[p.name]).length > 0 && (
                <span className="px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-emerald-500 text-slate-950 shrink-0">
                  {projects.filter(p => runningStatus[p.name]).length}
                </span>
              )}
            </button>

            <button
              onClick={() => setActiveTab('logColors')}
              className={`relative w-full flex items-center gap-2.5 pl-4 pr-3 py-2.5 rounded-xl text-xs font-semibold transition-all cursor-pointer border-0 text-left ${
                activeTab === 'logColors'
                  ? 'bg-emerald-500/12 text-emerald-400'
                  : 'hover:bg-white/10 text-slate-300 hover:text-white'
              }`}
            >
              {activeTab === 'logColors' && (
                <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)]" />
              )}
              <span className={`w-6 h-6 rounded-lg flex items-center justify-center text-sm shrink-0 transition-colors ${activeTab === 'logColors' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-white/10 text-slate-300'}`}>🎨</span>
              <span className="truncate">Màu sắc dòng log</span>
            </button>
          </div>

          {/* Right Active Tab Panel */}
          <div className="flex-1 overflow-y-auto p-6 space-y-6">
            {error && (
              <div className="bg-red-500/15 border border-red-500/30 text-red-400 px-4 py-2.5 rounded-xl text-xs flex items-center justify-between shadow-sm">
                <span>⚠️ {error}</span>
                <button onClick={() => setError('')} className="ml-2 text-red-400 hover:text-white border-0 bg-transparent cursor-pointer">&times;</button>
              </div>
            )}

            {loadingConfig ? (
              <div className="flex flex-col items-center justify-center py-20 space-y-3">
                <div className="animate-spin rounded-full h-7 w-7 border-b-2 border-emerald-400" />
                <span className="text-xs text-slate-400">Đang đồng bộ cấu hình từ hệ thống...</span>
              </div>
            ) : (
              <>
                {/* ── Tab 1: General Settings ── */}
                {activeTab === 'general' && (
                  <div className="space-y-6 animate-page-enter">
                    {/* Port Range Section */}
                    <div className="rounded-2xl p-5 border space-y-4 shadow-sm"
                      style={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border)' }}>
                      <div className="flex items-center justify-between border-b pb-3" style={{ borderColor: 'var(--border)' }}>
                        <div>
                          <h3 className="text-xs font-bold uppercase tracking-wider text-emerald-400">Dải Cổng Mạng (Port Range)</h3>
                          <p className="text-[11px] text-slate-400 mt-0.5">Tự động quét và gán cổng chạy dịch vụ trong khoảng này</p>
                        </div>
                        <button onClick={saveGlobalSettings}
                          className="px-3 py-1.5 text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-all active:scale-95 cursor-pointer border-0 shadow-sm">
                          Lưu khoảng cổng
                        </button>
                      </div>
                      <div className="grid grid-cols-2 gap-4 pt-1">
                        <div>
                          <label htmlFor="settings-port-min" className="text-xs font-medium mb-1.5 block" style={{ color: 'var(--fg-muted)' }}>Cổng tối thiểu (Port Min)</label>
                          <input id="settings-port-min" name="portMin" type="number" value={portMin} onChange={e => setPortMin(parseInt(e.target.value) || 0)}
                            className="w-full border rounded-xl px-3.5 py-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-emerald-500 transition-colors"
                            style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--fg)' }} />
                        </div>
                        <div>
                          <label htmlFor="settings-port-max" className="text-xs font-medium mb-1.5 block" style={{ color: 'var(--fg-muted)' }}>Cổng tối đa (Port Max)</label>
                          <input id="settings-port-max" name="portMax" type="number" value={portMax} onChange={e => setPortMax(parseInt(e.target.value) || 0)}
                            className="w-full border rounded-xl px-3.5 py-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-emerald-500 transition-colors"
                            style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--fg)' }} />
                        </div>
                      </div>
                    </div>

                    {/* Theme Toggle Section */}
                    {theme && onToggleTheme && (
                      <div className="rounded-2xl p-5 border space-y-3 shadow-sm"
                        style={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border)' }}>
                        <div className="flex items-center justify-between">
                          <div>
                            <h3 className="text-xs font-bold uppercase tracking-wider text-emerald-400">Giao diện ứng dụng</h3>
                            <p className="text-[11px] text-slate-400 mt-0.5">
                              {theme === 'dark' ? '🌙 Chế độ tối (Dark Mode) — Tối ưu làm việc đêm' : '☀️ Chế độ sáng (Light Mode)'}
                            </p>
                          </div>
                          <button onClick={onToggleTheme}
                            className="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-xl border transition-all active:scale-95 cursor-pointer hover:bg-white/10"
                            style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}>
                            {theme === 'dark' ? (
                              <><span className="text-amber-400">☀️</span> Chuyển giao diện sáng</>
                            ) : (
                              <><span className="text-sky-400">🌙</span> Chuyển giao diện tối</>
                            )}
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Background Polling Section */}
                    {backgroundPolling && onBackgroundPollingChange && (
                      <div className="rounded-2xl p-5 border space-y-4 shadow-sm"
                        style={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border)' }}>
                        <div className="flex items-center justify-between border-b pb-3" style={{ borderColor: 'var(--border)' }}>
                          <div>
                            <h3 className="text-xs font-bold uppercase tracking-wider text-emerald-400">Chạy ngầm (Background Polling)</h3>
                            <p className="text-[11px] text-slate-400 mt-0.5">Duy trì tự động cập nhật dữ liệu khi switch tab</p>
                          </div>
                          <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                            {Object.values(backgroundPolling).some(Boolean)
                              ? `${Object.entries(backgroundPolling).filter(([,v]) => v).length} tab active`
                              : '💤 Tối ưu CPU'}
                          </span>
                        </div>
                        <div className="space-y-2">
                          {/* WHY: Chỉ liệt kê module khả dụng trên nền tảng hiện tại — trên Mac
                              không hiện polling toggle cho Máy in/Âm thanh/Tunnel (đã ẩn). */}
                          {PLATFORM_MODULES.filter(mod => mod.polls).map(mod => {
                            const isOn = backgroundPolling[mod.id]
                            return (
                              <div key={mod.id}
                                className="flex items-center justify-between px-3.5 py-2.5 rounded-xl border transition-all"
                                style={{ backgroundColor: isOn ? 'rgba(34,197,94,0.06)' : 'var(--input-bg)', borderColor: isOn ? 'rgba(34,197,94,0.25)' : 'var(--border)' }}>
                                <div className="flex items-center gap-3">
                                  <span className="text-base">{mod.icon}</span>
                                  <div>
                                    <span className="text-xs font-bold" style={{ color: 'var(--fg)' }}>{mod.label}</span>
                                    <p className="text-[10px] text-slate-400">{mod.description}</p>
                                  </div>
                                </div>
                                <label className="relative inline-flex items-center cursor-pointer">
                                  <input type="checkbox" id={`bg-polling-${mod.id}`} name={`bg-polling-${mod.id}`} checked={isOn}
                                    onChange={e => onBackgroundPollingChange({ ...backgroundPolling, [mod.id]: e.target.checked })}
                                    className="sr-only peer" />
                                  <div className="w-8 h-4 rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-emerald-500 bg-slate-700" />
                                </label>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* ── Tab 2: Projects Management ── */}
                {activeTab === 'projects' && (
                  <div className="space-y-6 animate-page-enter">
                    <div className="flex items-center justify-between border-b pb-3" style={{ borderColor: 'var(--border)' }}>
                      <div>
                        <h3 className="text-xs font-bold uppercase tracking-wider text-emerald-400">Danh sách máy chủ ({projects.length})</h3>
                        <p className="text-[11px] text-slate-400 mt-0.5">Quản lý các thư mục ứng dụng web và script khởi động</p>
                      </div>
                      <div className="flex gap-2">
                        <button onClick={reloadConfig} disabled={reloading}
                          className="px-3 py-1.5 text-xs font-semibold border rounded-xl transition-all disabled:opacity-40 active:scale-95 cursor-pointer hover:bg-white/10"
                          style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}>
                          {reloading ? '⏳ Đang tải...' : '🔄 Đọc lại từ đĩa'}
                        </button>
                        <button onClick={() => { setEdit({ name: '', path: '', command: 'npm run dev', port: 4000, type: 'node', start_on_launch: false }); setEditingIndex(null); setStartAfterAdd(false) }}
                          className="px-3 py-1.5 text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl transition-all active:scale-95 cursor-pointer border-0 shadow-sm flex items-center gap-1">
                          <span>+</span> Thêm dự án
                        </button>
                      </div>
                    </div>

                    {/* Add / Edit Form Card */}
                    {edit && (
                      <div className="rounded-2xl p-5 border space-y-4 shadow-lg ring-1 ring-emerald-500/30"
                        style={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border)' }}>
                        <div className="flex items-center justify-between border-b pb-2" style={{ borderColor: 'var(--border)' }}>
                          <h4 className="text-xs font-bold text-emerald-400">
                            {editingIndex !== null ? `📝 Sửa dự án: ${projects[editingIndex]?.name}` : '➕ Thêm máy chủ dự án mới'}
                          </h4>
                          <button onClick={() => { setEdit(null); setEditingIndex(null); setStartAfterAdd(false) }}
                            className="text-slate-400 hover:text-white text-xs border-0 bg-transparent cursor-pointer">✕ Đóng</button>
                        </div>

                        {/* Loại máy chủ: Node.js dev server hoặc Lệnh tùy chỉnh (buzz-fwd, tool nền...) */}
                        <div>
                          <label htmlFor="settings-proj-type" className="text-xs font-medium mb-1 block" style={{ color: 'var(--fg-muted)' }}>Loại máy chủ</label>
                          <div className="grid grid-cols-2 gap-2">
                            <button type="button" onClick={() => setEdit(p => p ? { ...p, type: 'node' } : p)}
                              className={`px-3 py-2 text-xs font-semibold rounded-xl border transition-all cursor-pointer flex items-center gap-2 ${
                                edit.type !== 'custom' ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30 shadow-sm' : 'hover:bg-white/5 text-slate-400 border-slate-700'
                              }`}>
                              🟢 Dự án Node.js
                              <span className="text-[9px] font-normal text-slate-500 ml-auto text-right">npm/vite/next + tunnel + dọn dẹp</span>
                            </button>
                            <button type="button" onClick={() => setEdit(p => p ? { ...p, type: 'custom', detected: false } : p)}
                              className={`px-3 py-2 text-xs font-semibold rounded-xl border transition-all cursor-pointer flex items-center gap-2 ${
                                edit.type === 'custom' ? 'bg-sky-500/15 text-sky-400 border-sky-500/30 shadow-sm' : 'hover:bg-white/5 text-slate-400 border-slate-700'
                              }`}>
                              🔧 Lệnh tùy chỉnh
                              <span className="text-[9px] font-normal text-slate-500 ml-auto text-right">chạy tool nền, port-forward...</span>
                            </button>
                          </div>
                          {edit.type === 'custom' && (
                            <p className="text-[10px] mt-1.5 text-sky-400/80">Chỉ chạy lệnh + xem log. Không cần thư mục project, node_modules, tunnel hay dọn dẹp.</p>
                          )}
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <label htmlFor="settings-proj-name" className="text-xs font-medium mb-1 block" style={{ color: 'var(--fg-muted)' }}>Tên máy chủ *</label>
                            <input id="settings-proj-name" name="projName" value={edit.name || ''} onChange={e => setEdit(p => ({ ...p, name: e.target.value }))}
                              className="w-full border rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-emerald-500 transition-colors"
                              style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--fg)' }}
                              placeholder="FrontendApp" />
                          </div>
                          <div>
                            <label htmlFor="settings-proj-port" className="text-xs font-medium mb-1 block" style={{ color: 'var(--fg-muted)' }}>Cổng (Port){edit.type === 'custom' ? ' — tùy chọn' : ''}</label>
                            <input id="settings-proj-port" name="projPort" type="number" value={edit.port ?? 4000} onChange={e => setEdit(p => ({ ...p, port: parseInt(e.target.value) || 0 }))}
                              className="w-full border rounded-xl px-3 py-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-emerald-500 transition-colors"
                              style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--fg)' }} />
                          </div>
                        </div>

                        <div>
                          <label htmlFor="settings-proj-path" className="text-xs font-medium mb-1 block" style={{ color: 'var(--fg-muted)' }}>
                            {edit.type === 'custom' ? 'Thư mục làm việc (tùy chọn)' : 'Đường dẫn thư mục *'}
                          </label>
                          <div className="flex gap-2">
                            <input id="settings-proj-path" name="projPath" value={edit.path || ''} onChange={e => setEdit(p => ({ ...p, path: e.target.value }))}
                              className="flex-1 border rounded-xl px-3 py-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-emerald-500 transition-colors"
                              style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--fg)' }}
                              placeholder={edit.type === 'custom' ? 'C:\Users\...\tools (thư mục chứa lệnh)' : 'C:\Users\...\my-project'} />
                            <button onClick={browseFolder}
                              className="px-3 py-2 text-xs font-semibold border rounded-xl transition-all shrink-0 active:scale-95 cursor-pointer hover:bg-white/10"
                              style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}>
                              📁 Chọn thư mục...
                            </button>
                            {edit.type !== 'custom' && (
                              <button onClick={detectFromPath} disabled={detecting}
                                className="px-3 py-2 text-xs font-semibold border rounded-xl transition-all shrink-0 active:scale-95 cursor-pointer hover:bg-white/10 disabled:opacity-50"
                                style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}>
                                {detecting ? '⏳ Đang phát hiện...' : '🔍 Tự phát hiện'}
                              </button>
                            )}
                          </div>
                          {/* WHY: Badge framework sau auto-detect — hiện confidence + lệnh/port đã điền sẵn */}
                          {edit.detected && edit.framework && (
                            <div className="mt-1.5 rounded-lg px-2.5 py-1.5 text-[11px] border"
                              style={{ backgroundColor: 'rgba(251,191,36,0.08)', borderColor: 'rgba(251,191,36,0.25)', color: '#fbbf24' }}>
                              ⚡ Đã phát hiện <b>{edit.framework}</b> · độ tin cậy {Math.round((edit.confidence ?? 0) * 100)}%
                              <span className="ml-1.5" style={{ color: 'var(--fg-secondary)' }}>
                                → {edit.command || 'npm run dev'} · :{edit.port}
                              </span>
                            </div>
                          )}
                        </div>

                        <div>
                          <label htmlFor="settings-proj-command" className="text-xs font-medium mb-1 block" style={{ color: 'var(--fg-muted)' }}>Lệnh chạy (Start command) {edit.type === 'custom' ? '*' : ''}</label>
                          {edit.type === 'custom' ? (
                            <div className="grid grid-cols-3 gap-2">
                              <input id="settings-proj-command" name="projCommand" value={edit.command || ''} onChange={e => setEdit(p => ({ ...p, command: e.target.value }))}
                                className="col-span-2 border rounded-xl px-3 py-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-emerald-500 transition-colors"
                                style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--fg)' }}
                                placeholder="node buzz-fwd.js  hoặc  python relay.py  hoặc  tool.exe" />
                              <div className="flex items-center gap-1 text-[10px] px-2 py-1 rounded-lg border"
                                style={{ backgroundColor: 'rgba(56,189,248,0.06)', borderColor: 'rgba(56,189,248,0.2)', color: 'var(--fg-secondary)' }}>
                                <span className="shrink-0">💡</span>
                                <span className="truncate">Dùng {'{port}'} để chèn cổng đã nhập</span>
                              </div>
                            </div>
                          ) : (
                            <div className="grid grid-cols-3 gap-2">
                              <select id="settings-proj-command-template" name="projCommandTemplate" onChange={e => {
                                const val = e.target.value
                                if (val) {
                                  setEdit(p => p ? { ...p, command: val } : null)
                                }
                              }}
                              className="border rounded-xl px-2 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-emerald-500 transition-colors"
                              style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--fg)' }}>
                                <option value="">⚡ Chọn mẫu lệnh...</option>
                                <option value="npm run dev">npm run dev</option>
                                <option value="npm run dev -- -p {port}">npm run dev -- -p {'{port}'}</option>
                                <option value="npm start">npm start</option>
                                <option value="yarn dev">yarn dev</option>
                                <option value="yarn dev -p {port}">yarn dev -p {'{port}'}</option>
                              </select>
                              <input id="settings-proj-command" name="projCommand" value={edit.command || ''} onChange={e => setEdit(p => ({ ...p, command: e.target.value }))}
                                className="col-span-2 border rounded-xl px-3 py-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-emerald-500 transition-colors"
                                style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--fg)' }}
                                placeholder="npm run dev" />
                            </div>
                          )}
                        </div>

                        {edit.type === 'custom' && (
                          <div>
                            <label htmlFor="settings-proj-process-name" className="text-xs font-medium mb-1 block" style={{ color: 'var(--fg-muted)' }}>
                              Tên tiến trình (để phát hiện đang chạy) — tùy chọn
                            </label>
                            <input id="settings-proj-process-name" name="projProcessName" value={edit.process_name || ''} onChange={e => setEdit(p => ({ ...p, process_name: e.target.value }))}
                              className="w-full border rounded-xl px-3 py-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-sky-500 transition-colors"
                              style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--fg)' }}
                              placeholder="node" />
                            <p className="text-[10px] mt-1 text-slate-400">
                              Điền tên file tiến trình (vd <code className="font-mono">node</code>, <code className="font-mono">python</code>, <code className="font-mono">buzz-fwd</code>) để app nhận biết lệnh đang chạy khi khởi động lại — tránh chạy 2 bản.
                            </p>
                          </div>
                        )}

                        <div className={editingIndex === null ? 'grid grid-cols-2 gap-3' : ''}>
                          <label htmlFor="settings-start-on-launch" className="flex items-center gap-2 text-xs select-none cursor-pointer text-slate-300">
                            <input id="settings-start-on-launch" name="startOnLaunch" type="checkbox" checked={!!edit.start_on_launch}
                              onChange={e => setEdit(p => p ? { ...p, start_on_launch: e.target.checked } : p)}
                              className="w-4 h-4 rounded accent-emerald-500 cursor-pointer" />
                            <span>⚡ Tự khởi động cùng ứng dụng</span>
                          </label>
                          {editingIndex === null && (
                            <label htmlFor="settings-start-after-add" className="flex items-center gap-2 text-xs select-none cursor-pointer text-slate-300">
                              <input id="settings-start-after-add" name="startAfterAdd" type="checkbox" checked={startAfterAdd} onChange={e => setStartAfterAdd(e.target.checked)}
                                className="w-4 h-4 rounded accent-emerald-500 cursor-pointer" />
                              <span>Khởi động server ngay sau khi thêm</span>
                            </label>
                          )}
                        </div>

                        <div className="flex justify-end gap-2 pt-2 border-t" style={{ borderColor: 'var(--border)' }}>
                          <button onClick={() => { setEdit(null); setEditingIndex(null); setStartAfterAdd(false) }}
                            className="px-4 py-1.5 text-xs font-semibold border rounded-xl transition-all active:scale-95 cursor-pointer"
                            style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}>
                            Hủy
                          </button>
                          <button onClick={saveProject}
                            className="px-5 py-1.5 text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl transition-all active:scale-95 cursor-pointer border-0 shadow-sm">
                            {editingIndex !== null ? 'Lưu thay đổi' : 'Xác nhận thêm'}
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Projects Cards List */}
                    <div className="space-y-2.5">
                      {projects.length === 0 && (
                        <p className="text-xs italic py-10 text-center text-slate-400">Chưa có dự án nào được cấu hình.</p>
                      )}
                      {projects.map((p, i) => (
                        <div key={p.name}
                          className="flex items-center justify-between rounded-2xl p-4 border transition-all hover:border-slate-600 group"
                          style={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border)' }}>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-sm font-bold" style={{ color: 'var(--fg)' }}>{p.name}</span>
                              {p.type === 'custom' && (
                                <span className="text-[9px] font-bold px-2 py-0.5 rounded-lg border" style={{ color: '#38bdf8', borderColor: 'rgba(56,189,248,0.3)', backgroundColor: 'rgba(56,189,248,0.08)' }}>
                                  🔧 Lệnh tùy chỉnh
                                </span>
                              )}
                              {!!p.port && (
                                <span className="text-xs font-mono font-bold border px-2 py-0.5 rounded-lg bg-slate-800 text-emerald-400 border-slate-700">
                                  :{p.port}
                                </span>
                              )}
                              {runningStatus[p.name] && (
                                <span className="text-[10px] bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 px-2 py-0.5 rounded-full font-bold flex items-center gap-1">
                                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" /> ĐANG CHẠY
                                </span>
                              )}
                            </div>
                            <p className="text-xs truncate mt-1 font-mono text-slate-400">{p.path}</p>
                            <p className="text-xs font-mono text-amber-400/90 mt-0.5">⚡ {p.command}</p>
                          </div>
                          <div className="flex gap-2 opacity-80 group-hover:opacity-100 transition-opacity shrink-0 ml-4">
                            <button onClick={() => { setEdit({ ...p }); setEditingIndex(i) }}
                              className="px-3 py-1.5 text-xs font-semibold bg-blue-500/15 text-blue-400 hover:bg-blue-500/25 border border-blue-500/30 rounded-xl transition-all active:scale-95 cursor-pointer">
                              Sửa
                            </button>
                            <button onClick={() => deleteProject(p.name)}
                              className="px-3 py-1.5 text-xs font-semibold bg-red-500/15 text-red-400 hover:bg-red-500/25 border border-red-500/30 rounded-xl transition-all active:scale-95 cursor-pointer">
                              Xóa
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* ── Tab 3: Log Colors Customization ── */}
                {activeTab === 'logColors' && logColors !== undefined && onLogColorsChange && (
                  <div className="space-y-6 animate-page-enter">
                    <div className="flex items-center justify-between border-b pb-3" style={{ borderColor: 'var(--border)' }}>
                      <div>
                        <h3 className="text-xs font-bold uppercase tracking-wider text-emerald-400">Bảng Màu Cấp Độ Log</h3>
                        <p className="text-[11px] text-slate-400 mt-0.5">Tùy chỉnh màu sắc hiển thị cho từng loại log trong Terminal</p>
                      </div>
                      <button onClick={() => {
                        const hasCustom = Object.keys(logColors).length > 0
                        if (hasCustom && !window.confirm('Đặt lại tất cả màu về mặc định?')) return
                        onLogColorsChange({})
                      }}
                        className="px-3 py-1.5 text-xs font-semibold rounded-xl border transition-all active:scale-95 cursor-pointer hover:bg-white/10"
                        style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-muted)' }}>
                        🔄 Đặt lại mặc định
                      </button>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      {LOG_COLOR_LEVELS.map(({ key, label, icon, desc }) => {
                        const currentColor = logColors[key] || DEFAULT_LOG_COLORS[key]
                        return (
                          <div key={key}
                            className="flex items-center justify-between p-3.5 rounded-2xl border transition-all hover:bg-white/[0.02]"
                            style={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border)' }}>
                            <div className="flex items-center gap-3 min-w-0">
                              <span className="text-lg shrink-0">{icon}</span>
                              <div className="min-w-0">
                                <span className="text-xs font-bold block truncate" style={{ color: 'var(--fg)' }}>{label}</span>
                                <span className="text-[10px] text-slate-400 block truncate">{desc}</span>
                              </div>
                            </div>
                            <div className="relative shrink-0 ml-2">
                              <input type="color" id={`log-color-${key}`} name={`log-color-${key}`} value={currentColor}
                                onChange={e => onLogColorsChange({ ...logColors, [key]: e.target.value })}
                                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                                title={`Thay đổi màu ${label}`} />
                              <div className="w-8 h-8 rounded-xl border-2 shadow-md transition-transform active:scale-90 flex items-center justify-center font-bold text-xs"
                                style={{ backgroundColor: currentColor, borderColor: 'rgba(255,255,255,0.2)' }}>
                                A
                              </div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* WHY: Footer — hint lưu tự động + nút Đóng rõ ràng (bố cục modal hoàn chỉnh) */}
        <div className="shrink-0 px-5 py-2.5 border-t flex items-center justify-between gap-3"
          style={{ borderColor: 'var(--border)', background: 'var(--bg-card)' }}>
          <span className="text-[10px] truncate" style={{ color: 'var(--fg-dim)' }}>
            💡 Thay đổi được lưu khi bạn nhấn nút Lưu / Xác nhận tương ứng
          </span>
          <button onClick={onClose}
            className="shrink-0 px-4 py-1.5 text-xs font-semibold border rounded-xl transition-all active:scale-95 cursor-pointer hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:outline-none"
            style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}>
            Đóng
          </button>
        </div>
      </div>
    </div>
  )
}
