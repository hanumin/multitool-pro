import { useEffect, useState } from 'react'

const API = 'http://127.0.0.1:5050'

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
}

export default function SettingsModal({ open, onClose, onChanged }: Props) {
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

  // WHY: Retry config fetch 3 times with 1-second delay to withstand backend restarts
  const fetchConfig = async () => {
    setLoadingConfig(true)
    setError('')
    const maxRetries = 3
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const [configRes, projectsRes] = await Promise.all([
          fetch(`${API}/api/config`),
          fetch(`${API}/api/projects`)
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
        setLoadingConfig(false)
        return
      } catch (err) {
        if (attempt === maxRetries) {
          setError('Không thể tải cấu hình sau nhiều lần thử')
          setLoadingConfig(false)
        } else {
          // Wait 1 second before retrying
          await new Promise(resolve => setTimeout(resolve, 1000))
        }
      }
    }
  }

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
        const res = await fetch(`${API}/api/config/projects/${encodeURIComponent(oldName)}`, {
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
        const res = await fetch(`${API}/api/config/projects`, {
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
          await fetch(`${API}/api/projects/${encodeURIComponent(edit.name)}/start`, {
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

  const saveGlobalSettings = async () => {
    setError('')
    try {
      const res = await fetch(`${API}/api/config`, {
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

  const deleteProject = async (name: string) => {
    const isRunning = runningStatus[name]
    const confirmMsg = isRunning
      ? `"${name}" đang chạy. Dừng và xóa dự án này?`
      : `Xóa "${name}"?`
    
    if (!window.confirm(confirmMsg)) return
    try {
      await fetch(`${API}/api/config/projects/${encodeURIComponent(name)}`, { method: 'DELETE' })
      await fetchConfig()
      onChanged()
    } catch {
      setError('Xóa thất bại')
    }
  }

  const reloadConfig = async () => {
    setReloading(true)
    try {
      await fetch(`${API}/api/config/reload`, { method: 'POST' })
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
                    <label className="text-[11px] mb-1 block" style={{ color: 'var(--fg-muted)' }}>Cổng tối thiểu</label>
                    <input type="number" value={portMin} onChange={e => setPortMin(parseInt(e.target.value) || 0)}
                      className="w-full border rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500 transition-colors duration-200"
                      style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--fg)' }} />
                  </div>
                  <div>
                    <label className="text-[11px] mb-1 block" style={{ color: 'var(--fg-muted)' }}>Cổng tối đa</label>
                    <input type="number" value={portMax} onChange={e => setPortMax(parseInt(e.target.value) || 0)}
                      className="w-full border rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500 transition-colors duration-200"
                      style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--fg)' }} />
                  </div>
                </div>
                <div className="flex justify-end">
                  <button onClick={saveGlobalSettings}
                    className="px-3 py-1.5 text-[11px] font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-colors active:scale-95 cursor-pointer">
                    Lưu cài đặt chung
                  </button>
                </div>
              </div>

              {/* Projects list */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--fg-secondary)' }}>Dự án</h3>
                  <div className="flex gap-2">
                    <button onClick={reloadConfig} disabled={reloading}
                      className="px-2.5 py-1 text-[11px] font-medium border rounded-lg transition-colors disabled:opacity-40 active:scale-95 cursor-pointer"
                      style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}>
                      {reloading ? '...' : 'Tải lại từ đĩa'}
                    </button>
                    <button onClick={() => { setEdit({ name: '', path: '', command: 'npm run dev', port: 4000 }); setEditingIndex(null); setStartAfterAdd(false) }}
                      className="px-2.5 py-1 text-[11px] font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-colors active:scale-95 cursor-pointer">
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
                          <span className="text-[10px] font-mono border px-1.5 py-0.5 rounded transition-colors duration-200"
                            style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-muted)' }}>
                            :{p.port}
                          </span>
                          {runningStatus[p.name] && (
                            <span className="text-[9px] bg-emerald-500/15 text-emerald-500 border border-emerald-500/20 px-1 py-0.5 rounded font-medium">
                              ĐANG CHẠY
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] truncate mt-0.5 font-mono" style={{ color: 'var(--fg-muted)' }}>{p.path}</p>
                        <p className="text-[10px] font-mono" style={{ color: 'var(--fg-dim)' }}>{p.command}</p>
                      </div>
                      <div className="flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0 ml-3">
                        <button onClick={() => { setEdit({ ...p }); setEditingIndex(i) }}
                          className="px-2 py-1 text-[10px] font-medium bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 rounded-lg transition-colors active:scale-95 cursor-pointer">
                          Sửa
                        </button>
                        <button onClick={() => deleteProject(p.name)}
                          className="px-2 py-1 text-[10px] font-medium bg-red-500/10 text-red-400 hover:bg-red-500/20 rounded-lg transition-colors active:scale-95 cursor-pointer">
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
                      <label className="text-[11px] mb-1 block" style={{ color: 'var(--fg-muted)' }}>Tên *</label>
                      <input value={edit.name || ''} onChange={e => setEdit(p => ({ ...p, name: e.target.value }))}
                        className="w-full border rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500 transition-colors duration-200"
                        style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--fg)' }}
                        placeholder="MyApp" />
                    </div>
                    <div>
                      <label className="text-[11px] mb-1 block" style={{ color: 'var(--fg-muted)' }}>Port</label>
                      <input type="number" value={edit.port ?? 4000} onChange={e => setEdit(p => ({ ...p, port: parseInt(e.target.value) || 0 }))}
                        className="w-full border rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500 transition-colors duration-200"
                        style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--fg)' }} />
                    </div>
                  </div>

                  <div>
                    <label className="text-[11px] mb-1 block" style={{ color: 'var(--fg-muted)' }}>Đường dẫn *</label>
                    <div className="flex gap-2">
                      <input value={edit.path || ''} onChange={e => setEdit(p => ({ ...p, path: e.target.value }))}
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
                    <label className="text-[11px] mb-1 block" style={{ color: 'var(--fg-muted)' }}>Lệnh</label>
                    <div className="grid grid-cols-3 gap-2">
                      <select onChange={e => {
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
                      <input value={edit.command || ''} onChange={e => setEdit(p => ({ ...p, command: e.target.value }))}
                        className="col-span-2 border rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500 transition-colors duration-200"
                        style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--fg)' }}
                        placeholder="npm run dev" />
                    </div>
                  </div>

                  {editingIndex === null && (
                    <label className="flex items-center gap-2 text-xs select-none cursor-pointer" style={{ color: 'var(--fg-secondary)' }}>
                      <input type="checkbox" checked={startAfterAdd} onChange={e => setStartAfterAdd(e.target.checked)}
                        className="w-3.5 h-3.5 rounded border-gray-700 bg-gray-900 accent-emerald-500 cursor-pointer" />
                      Start project immediately after adding
                    </label>
                  )}

                  <div className="flex justify-end gap-2 pt-2">
                    <button onClick={() => { setEdit(null); setEditingIndex(null); setStartAfterAdd(false) }}
                      className="px-3 py-1.5 text-[11px] font-medium border rounded-lg transition-colors active:scale-95 cursor-pointer"
                      style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}>
                      Hủy
                    </button>
                    <button onClick={saveProject}
                      className="px-4 py-1.5 text-[11px] font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-colors active:scale-95 cursor-pointer">
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
