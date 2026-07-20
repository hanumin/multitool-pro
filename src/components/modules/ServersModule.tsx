import { useState, useEffect, useRef, useCallback } from 'react'
import Convert from 'ansi-to-html'

const API = 'http://127.0.0.1:5050'

const ansiConverter = new Convert({
  newline: false,
  escapeXML: true,
  colors: {
    0: '#000000', 1: '#ef4444', 2: '#22c55e', 3: '#eab308',
    4: '#3b82f6', 5: '#a855f7', 6: '#06b6d4', 7: '#f3f4f6',
  }
})

interface Project {
  name: string; port: number; path: string; command?: string; running: boolean
}

interface ServersModuleProps {
  theme: 'dark' | 'light'
  setStatusText: (t: string) => void
}

export default function ServersModule({ theme, setStatusText }: ServersModuleProps) {
  const [projects, setProjects] = useState<Project[]>([])
  const [activeTab, setActiveTab] = useState('All')
  const [logs, setLogs] = useState<Record<string, string[]>>({ All: [] })
  const [fullLogs, setFullLogs] = useState<Record<string, string[]>>({ All: [] })
  const [exportLimit, setExportLimit] = useState<number>(0)
  const [exportFormat, setExportFormat] = useState<'txt' | 'md' | 'json'>('md')
  const [loading, setLoading] = useState<Record<string, boolean>>({})
  const [clearing, setClearing] = useState<Record<string, boolean>>({})
  const [diagnostics, setDiagnostics] = useState<Record<string, any>>({})
  const [expandedProject, setExpandedProject] = useState<string | null>(null)
  const [envEditingProject, setEnvEditingProject] = useState<string | null>(null)
  const [envFileName, setEnvFileName] = useState('.env.local')
  const [envContent, setEnvContent] = useState('')
  const [envSaving, setEnvSaving] = useState(false)
  const [batchLoading, setBatchLoading] = useState(false)
  const [portConflicts, setPortConflicts] = useState<Record<number, string[]>>({})
  const [logSearch, setLogSearch] = useState('')
  const [logFilter, setLogFilter] = useState<'all' | 'info' | 'warn' | 'error'>('all')
  const [projectScripts, setProjectScripts] = useState<Record<string, string[]>>({})
  const [diskSizes, setDiskSizes] = useState<Record<string, Record<string, number>>>({})
  const logEndRef = useRef<HTMLDivElement>(null)
  const prevTabRef = useRef(activeTab)

  // WHY: Fetch port conflicts for all project ports
  const scanPortConflicts = useCallback(async () => {
    const ports = projects.map(p => p.port)
    if (ports.length === 0) return
    try {
      const res = await fetch(`${API}/api/system/port-scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ports })
      })
      if (res.ok) {
        const data = await res.json()
        // WHY: Set fresh data, các port không còn conflict sẽ tự động bị xóa
        setPortConflicts(data.ports || {})
      } else {
        setPortConflicts({})
      }
    } catch {
      setPortConflicts({})
    }
  }, [projects])

  // WHY: Fetch disk usage and npm scripts for each running project
  const fetchProjectExtras = useCallback(async () => {
    for (const p of projects) {
      if (p.running) {
        // Fetch scripts
        try {
          const res = await fetch(`${API}/api/projects/${encodeURIComponent(p.name)}/scripts`)
          if (res.ok) {
            const data = await res.json()
            setProjectScripts(prev => ({ ...prev, [p.name]: Object.keys(data.scripts || {}) }))
          }
        } catch {}
        // Fetch disk usage
        try {
          const res = await fetch(`${API}/api/projects/${encodeURIComponent(p.name)}/disk-usage`)
          if (res.ok) {
            const data = await res.json()
            setDiskSizes(prev => ({ ...prev, [p.name]: data.sizes || {} }))
          }
        } catch {}
      }
    }
  }, [projects])

  // WHY: Scan ports and fetch extras periodically
  useEffect(() => {
    if (projects.length === 0) return
    scanPortConflicts()
    fetchProjectExtras()
    const interval = setInterval(() => {
      scanPortConflicts()
      fetchProjectExtras()
    }, 15000)
    return () => clearInterval(interval)
  }, [scanPortConflicts, fetchProjectExtras])

  const fetchDiagnostics = useCallback(async (name: string) => {
    try {
      const res = await fetch(`${API}/api/projects/${encodeURIComponent(name)}/diagnostics`)
      if (res.ok) {
        const data = await res.json()
        setDiagnostics(prev => ({ ...prev, [name]: data }))
      }
    } catch {}
  }, [])

  // WHY: Dùng ref để theo dõi project list hiện tại, tránh re-create interval mỗi 3 giây
  const projectsRef = useRef(projects)
  projectsRef.current = projects

  useEffect(() => {
    if (!expandedProject) return
    // WHY: Kiểm tra project tồn tại bằng ref, không gây re-render
    if (!projectsRef.current.some(p => p.name === expandedProject)) {
      setExpandedProject(null)
      return
    }
    fetchDiagnostics(expandedProject)
    const interval = setInterval(() => {
      // WHY: Kiểm tra lại mỗi lần interval để đảm bảo project vẫn tồn tại
      if (!projectsRef.current.some(p => p.name === expandedProject)) {
        setExpandedProject(null)
        return
      }
      fetchDiagnostics(expandedProject)
    }, 2000)
    return () => clearInterval(interval)
  }, [expandedProject, fetchDiagnostics])

  const fetchProjects = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/projects`)
      const data: Project[] = await res.json()
      setProjects(data)
      const running = data.filter(p => p.running).length
      setStatusText(`${running}/${data.length} servers running`)
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        await invoke('update_tray_status', { running, total: data.length })
      } catch {}
    } catch { setStatusText('Reconnecting...') }
  }, [setStatusText])

  // WHY: Expose global functions for tray menu (Start All / Stop All)
  // Phải đặt SAU fetchProjects để tránh used-before-declaration error
  useEffect(() => {
    const startAll = async () => {
      try { await fetch(`${API}/api/projects/start-all`, { method: 'POST' }); await fetchProjects() } catch {}
    }
    const stopAll = async () => {
      try { await fetch(`${API}/api/projects/stop-all`, { method: 'POST' }); await fetchProjects() } catch {}
    }
    ;(window as any).__startAll = startAll
    ;(window as any).__stopAll = stopAll
    return () => {
      delete (window as any).__startAll
      delete (window as any).__stopAll
    }
  }, [fetchProjects])

  const fetchLogs = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/logs/all`)
      const data: Record<string, string[]> = await res.json()
      const merged: Record<string, string[]> = { All: [] }
      const fullMerged: Record<string, string[]> = { All: [] }
      Object.entries(data).forEach(([name, lines]) => {
        merged[name] = lines.slice(-300)
        lines.slice(-300).forEach(l => merged.All.push(l))
        fullMerged[name] = lines
        lines.forEach(l => fullMerged.All.push(l))
      })
      setLogs(merged)
      setFullLogs(fullMerged)
    } catch {}
  }, [])

  useEffect(() => {
    fetchProjects()
    fetchLogs()
    const i1 = setInterval(fetchProjects, 3000)
    const i2 = setInterval(fetchLogs, 2000)
    return () => { clearInterval(i1); clearInterval(i2) }
  }, [fetchProjects, fetchLogs])

  useEffect(() => {
    const current = logEndRef.current
    if (!current) return
    const container = current.parentElement
    if (!container) return
    const tabChanged = prevTabRef.current !== activeTab
    prevTabRef.current = activeTab
    if (tabChanged) current.scrollIntoView({ behavior: 'smooth' })
    else {
      const isAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 50
      if (isAtBottom) {
        // WHY: Instant scroll cho log realtime để user không bị giật khi đọc
        current.scrollIntoView({ behavior: 'instant' })
      }
    }
  }, [logs, activeTab])

  const act = async (name: string, action: 'start' | 'stop') => {
    setLoading(p => ({ ...p, [name]: true }))
    try {
      const res = await fetch(`${API}/api/projects/${encodeURIComponent(name)}/${action}`, { method: 'POST' })
      if (res.ok) setStatusText(`${action === 'start' ? 'Started' : 'Stopped'} ${name}`)
      else { const e = await res.json(); setStatusText(e.error || 'Failed') }
      await fetchProjects()
    } catch { setStatusText('Connection failed') }
    finally { setLoading(p => ({ ...p, [name]: false })) }
  }

  const cleanProject = async (name: string, type: 'basic' | 'deep' | 'nuke') => {
    let msg = `Run clean (${type}) for ${name}?`
    if (type === 'deep') msg = 'Deep clean will stop the server and delete build folders. Continue?'
    else if (type === 'nuke') msg = `⚠️ NUKE CLEAN will delete node_modules and reinstall. Continue?`
    if (!window.confirm(msg)) return
    setClearing(c => ({ ...c, [name]: true }))
    try {
      const res = await fetch(`${API}/api/projects/${encodeURIComponent(name)}/clean`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type })
      })
      const data = await res.json()
      if (res.ok) {
        if (data.status === 'nuked_reinstalling') {
          setStatusText(`Nuked ${name}! Running npm install...`)
          setActiveTab(name)
        } else setStatusText(`Đã dọn ${data.removed?.join(', ') || 'không có gì'} cho ${name}`)
      } else setStatusText(data.error || 'Dọn dẹp thất bại')
      await fetchProjects()
    } catch { setStatusText('Connection failed') }
    finally { setClearing(c => ({ ...c, [name]: false })) }
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

  const openEnvEditor = async (name: string) => {
    setEnvEditingProject(name)
    setEnvContent('')
    try {
      const res = await fetch(`${API}/api/projects/${encodeURIComponent(name)}/env`)
      if (res.ok) { const d = await res.json(); setEnvFileName(d.fileName); setEnvContent(d.content) }
    } catch { setStatusText('Failed to load env file') }
  }

  const saveEnvFile = async () => {
    if (!envEditingProject) return
    setEnvSaving(true)
    try {
      const res = await fetch(`${API}/api/projects/${encodeURIComponent(envEditingProject)}/env`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: envFileName, content: envContent })
      })
      if (res.ok) { setStatusText(`Saved ${envFileName}`); setEnvEditingProject(null) }
      else { const e = await res.json(); setStatusText(e.error || 'Failed') }
    } catch { setStatusText('Connection failed') }
    finally { setEnvSaving(false) }
  }

  const getExportLines = (limit: number) => {
    const lines = fullLogs[activeTab] || []
    return limit === 0 || limit >= lines.length ? lines : lines.slice(-limit)
  }

  const formatLogs = (lines: string[], format: 'txt' | 'md' | 'json') => {
    if (format === 'json') return JSON.stringify(lines, null, 2)
    if (format === 'md') {
      return `# MultiTool Pro Logs - ${activeTab}\nDate: ${new Date().toLocaleString()}\nLimit: ${exportLimit === 0 ? 'All' : exportLimit} lines\n\n\`\`\`text\n${lines.join('\n')}\n\`\`\`\n`
    }
    return lines.join('\n')
  }

  const handleCopyLog = () => {
    const targetLines = getExportLines(exportLimit)
    if (!targetLines.length) { setStatusText('No logs to copy'); return }
    const content = formatLogs(targetLines, exportFormat)
    navigator.clipboard.writeText(content)
    setStatusText(`Copied ${targetLines.length} lines as ${exportFormat.toUpperCase()}`)
  }

  const handleDownloadLog = async () => {
    const lines = fullLogs[activeTab] || []
    if (!lines.length) { setStatusText('No logs to download'); return }
    try {
      const params = new URLSearchParams({
        project: activeTab,
        format: exportFormat,
        limit: String(exportLimit),
        search: logSearch
      })
      const res = await fetch(`${API}/api/logs/export?${params}`)
      if (!res.ok) { setStatusText('Download failed'); return }
      const blob = await res.blob()
      const contentDisposition = res.headers.get('Content-Disposition')
      let filename = `logs_${activeTab.toLowerCase().replace(/\s+/g, '_')}.${exportFormat === 'txt' ? 'log' : exportFormat}`
      if (contentDisposition) {
        const match = contentDisposition.match(/filename="?([^"]+)"?/)
        if (match) filename = match[1]
      }
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = filename
      document.body.appendChild(a); a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      setStatusText(`Downloaded ${filename}`)
    } catch (e: any) { setStatusText(`❌ ${e.message}`) }
  }

  const handleExportLog = async () => {
    const targetLines = getExportLines(exportLimit)
    if (!targetLines.length) { setStatusText('No logs to export'); return }
    const content = formatLogs(targetLines, exportFormat)
    const fileExt = exportFormat === 'txt' ? 'log' : exportFormat
    const defaultName = `logs_${activeTab.toLowerCase().replace(/\s+/g, '_')}_${exportLimit === 0 ? 'all' : exportLimit}.${fileExt}`
    try {
      const { save } = await import('@tauri-apps/plugin-dialog')
      const selectedPath = await save({ title: 'Export Server Logs', defaultPath: defaultName, filters: [{ name: exportFormat.toUpperCase(), extensions: [fileExt] }] })
      if (!selectedPath) { setStatusText('Export cancelled'); return }
      setStatusText('Saving...')
      const res = await fetch(`${API}/api/logs/save-to-file`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: selectedPath, content }) })
      setStatusText(res.ok ? `Exported to ${selectedPath.split(/[\\/]/).pop()}` : (await res.json()).error || 'Failed')
    } catch (err: any) { setStatusText(err?.message || 'Export error') }
  }

  const displayLines = logs[activeTab] || []
  const tabs = ['All', ...projects.map(p => p.name)]

  return (
    <div className="flex flex-col h-full">
      {/* Batch Actions Toolbar */}
      <div className="shrink-0 flex items-center justify-between px-4 pt-3 pb-1">
        <div className="flex items-center gap-2">
          <button onClick={async () => {
            setBatchLoading(true)
            try {
              await fetch(`${API}/api/projects/start-all`, { method: 'POST' })
              setStatusText('Started all projects')
              await fetchProjects()
            } catch { setStatusText('Failed to start all') }
            finally { setBatchLoading(false) }
          }} disabled={batchLoading}
            className="px-3 py-1.5 text-[11px] font-semibold rounded-lg transition-all cursor-pointer disabled:opacity-30 active:scale-95 bg-emerald-500/15 text-emerald-500 hover:bg-emerald-500/25 ring-1 ring-emerald-500/20 border-0 flex items-center gap-1.5">
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5.636 18.364a9 9 0 010-12.728m12.728 0a9 9 0 010 12.728m-9.9-2.829a5 5 0 010-7.07m7.072 0a5 5 0 010 7.07M13 12a1 1 0 11-2 0 1 1 0 012 0z" />
            </svg>
            Bật tất cả
          </button>
          <button onClick={async () => {
            setBatchLoading(true)
            try {
              await fetch(`${API}/api/projects/stop-all`, { method: 'POST' })
              setStatusText('Stopped all projects')
              await fetchProjects()
            } catch { setStatusText('Failed to stop all') }
            finally { setBatchLoading(false) }
          }} disabled={batchLoading}
            className="px-3 py-1.5 text-[11px] font-semibold rounded-lg transition-all cursor-pointer disabled:opacity-30 active:scale-95 bg-red-500/10 text-red-400 hover:bg-red-500/20 ring-1 ring-red-500/15 border-0 flex items-center gap-1.5">
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 10a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z" />
            </svg>
            Tắt tất cả
          </button>
        </div>
        <div className="flex items-center gap-1.5" style={{ color: 'var(--fg-dim)' }}>
          <span className="text-[10px]">{projects.filter(p => p.running).length}/{projects.length} đang chạy</span>
          {batchLoading && (
            <div className="animate-spin rounded-full h-3 w-3 border-b border-emerald-500" />
          )}
        </div>
      </div>

      {/* Server Cards */}
      <div className="shrink-0 grid grid-cols-2 gap-3 px-4 pb-2">
        {projects.map(p => (
          <div key={p.name} className="relative group rounded-xl border backdrop-blur p-4 transition-all duration-200 flex flex-col justify-between"
            style={{ background: 'var(--bg-card)', borderColor: 'var(--border)' }}>
            <div className={`absolute left-0 top-2 bottom-2 w-0.5 rounded-full transition-colors duration-300 ${p.running ? 'bg-emerald-400 shadow-sm shadow-emerald-400/50' : ''}`}
              style={{ background: p.running ? undefined : 'var(--fg-dim)' }} />
            <div>
              <div className="flex items-start justify-between pl-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h2 className="text-sm font-medium truncate" style={{ color: 'var(--fg)' }}>{p.name}</h2>
                    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-semibold ${p.running ? 'bg-emerald-500/15 text-emerald-500 ring-1 ring-emerald-500/20' : 'bg-red-500/10 text-red-400 ring-1 ring-red-500/15'}`}>
                      <span className={`w-1 h-1 rounded-full ${p.running ? 'bg-emerald-400 animate-pulse' : 'bg-red-400'}`} />
                      {p.running ? 'ĐANG CHẠY' : 'ĐÃ DỪNG'}
                    </span>
                  </div>
                  <p className="text-[10px] mt-1 truncate font-mono" style={{ color: 'var(--fg-dim)' }} title={p.path}>{p.path}</p>
                </div>
                <button onClick={() => setExpandedProject(expandedProject === p.name ? null : p.name)}
                  className="p-1 rounded-lg hover:bg-black/10 dark:hover:bg-white/10 transition-colors ml-2 shrink-0 border-0"
                  style={{ color: 'var(--fg-muted)' }} title="Chẩn đoán & Biến môi trường">
                  <svg className="w-3.5 h-3.5 transition-transform duration-200" style={{ transform: expandedProject === p.name ? 'rotate(180deg)' : 'none' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                  </svg>
                </button>
              </div>
              {expandedProject === p.name && (
                <div className="mt-3 pt-3 border-t border-dashed space-y-2 text-[10px] pl-3" style={{ borderColor: 'var(--border)' }}>
                  <div className="grid grid-cols-2 gap-2">
                    <div><span style={{ color: 'var(--fg-muted)' }}>Bộ nhớ:</span> <span className="font-mono" style={{ color: 'var(--fg-secondary)' }}>{diagnostics[p.name]?.memory ? `${(diagnostics[p.name].memory / 1024 / 1024).toFixed(1)} MB` : p.running ? '...' : 'Không hoạt động'}</span></div>
                    <div><span style={{ color: 'var(--fg-muted)' }}>CPU:</span> <span className="font-mono" style={{ color: 'var(--fg-secondary)' }}>{diagnostics[p.name]?.cpu !== undefined ? `${diagnostics[p.name].cpu}%` : p.running ? '...' : 'Inactive'}</span></div>
                    {/* Uptime */}
                    <div><span style={{ color: 'var(--fg-muted)' }}>Uptime:</span> <span className="font-mono" style={{ color: diagnostics[p.name]?.uptime_seconds > 3600 ? '#22c55e' : 'var(--fg-secondary)' }}>{diagnostics[p.name]?.uptime || (p.running ? '...' : '-')}</span></div>
                    <div><span style={{ color: 'var(--fg-muted)' }}>Node:</span> <span className="font-mono" style={{ color: 'var(--fg-secondary)' }}>{diagnostics[p.name]?.env?.node || '...'} {diagnostics[p.name]?.env?.npm ? `(npm ${diagnostics[p.name].env.npm})` : ''}</span></div>
                  </div>
                  {diagnostics[p.name]?.git && (
                    <div className="flex items-center gap-2 flex-wrap">
                      <span style={{ color: 'var(--fg-muted)' }}>Git:</span>
                      <span className="font-mono text-emerald-500">{diagnostics[p.name].git.branch}</span>
                      <span className={`px-1 rounded text-[8px] font-mono ${diagnostics[p.name].git.is_dirty ? 'bg-amber-500/10 text-amber-500 border border-amber-500/15' : 'bg-emerald-500/10 text-emerald-500 border border-emerald-500/15'}`}>
                        {diagnostics[p.name].git.is_dirty ? `${diagnostics[p.name].git.dirty_count} đã sửa` : 'sạch'}
                      </span>
                    </div>
                  )}
                  {/* Quick Actions Row */}
                  <div className="flex items-center gap-1.5 pt-1 flex-wrap">
                    <button onClick={() => openEnvEditor(p.name)} className="px-2 py-1 text-[9px] font-semibold rounded border transition-colors active:scale-95 cursor-pointer"
                      style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}>📝 Sửa .env</button>
                    {/* Quick SSL */}
                    <button onClick={async () => {
                      try {
                        const res = await fetch(`${API}/api/projects/${encodeURIComponent(p.name)}/ssl`, { method: 'POST' })
                        const data = await res.json()
                        if (res.ok) setStatusText(`✅ SSL cert created: ${data.cert}`)
                        else if (data.instructions) setStatusText(`❌ ${data.error}. ${data.instructions}`)
                        else setStatusText(`❌ ${data.error}`)
                      } catch { setStatusText('Failed to create SSL cert') }
                    }}
                      className="px-2 py-1 text-[9px] font-semibold rounded border transition-colors active:scale-95 cursor-pointer"
                      style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}>🔒 SSL</button>
                  </div>
                </div>
              )}
            </div>
            <div className="flex items-center justify-between mt-3 pl-3">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[11px] font-mono" style={{ color: 'var(--fg-muted)' }}><span style={{ color: 'var(--fg-dim)' }}>Cổng</span> {p.port}</span>
                {p.running && (
                  <button onClick={() => openBrowser(`http://localhost:${p.port}`)}
                    className="text-[11px] underline underline-offset-2 hover:text-blue-400 bg-transparent border-0 cursor-pointer p-0" style={{ color: '#3b82f6', textDecorationColor: '#3b82f680' }}>Mở</button>
                )}
                {/* Port Conflict Badge */}
                {portConflicts[p.port] && portConflicts[p.port].length > 0 && (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[8px] font-semibold bg-red-500/15 text-red-400 ring-1 ring-red-500/20"
                    title={`Conflict on port ${p.port}: ${portConflicts[p.port].map((c: any) => `${c.name} (PID:${c.pid})`).join(', ')}`}>
                    ⚔️ Conflict
                  </span>
                )}
                {/* Disk Usage Badge */}
                {diskSizes[p.name]?.node_modules && (
                  <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[8px] font-mono ${
                    diskSizes[p.name].node_modules > 500
                      ? 'bg-amber-500/15 text-amber-400 ring-1 ring-amber-500/20'
                      : 'bg-emerald-500/10 text-emerald-500 ring-1 ring-emerald-500/15'
                  }`} title={`node_modules: ${diskSizes[p.name].node_modules}MB | .next: ${diskSizes[p.name]['.next'] || 0}MB`}>
                    📦 {diskSizes[p.name].node_modules}MB
                  </span>
                )}
                {/* Quick File Explorer */}
                <button onClick={async () => {
                  try {
                    await fetch(`${API}/api/system/open-explorer`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ path: p.path })
                    })
                    setStatusText(`Opened ${p.path}`)
                  } catch {
                    try {
                      const { open } = await import('@tauri-apps/plugin-shell')
                      await open(p.path)
                    } catch { setStatusText('Failed to open explorer') }
                  }
                }}
                  className="text-[10px] px-1.5 py-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 transition-colors border-0 cursor-pointer"
                  style={{ color: 'var(--fg-muted)' }} title="Mở trong File Explorer">
                  📁
                </button>
                {/* Quick npm Scripts */}
                {projectScripts[p.name] && projectScripts[p.name].length > 0 && (
                  <select onChange={async e => {
                    const script = e.target.value
                    if (!script) return
                    try {
                      await fetch(`${API}/api/projects/${encodeURIComponent(p.name)}/run-script`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ script })
                      })
                      setStatusText(`Running ${script} for ${p.name}`)
                      setActiveTab(p.name)
                      await fetchProjects()
                    } catch { setStatusText('Failed to run script') }
                    e.target.value = ''
                  }}
                    className="px-1.5 py-0.5 text-[8px] rounded border cursor-pointer"
                    style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}>
                    <option value="">⚡ Script</option>
                    {projectScripts[p.name].filter(s => ['build','lint','test','typecheck','format','preview'].includes(s)).map(s => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                )}
              </div>
              <div className="flex gap-1.5 items-center">
                <button onClick={() => act(p.name, 'start')} disabled={p.running || loading[p.name]}
                  className="px-3 py-1.5 text-[11px] font-semibold rounded-lg transition-all cursor-pointer disabled:opacity-30 active:scale-95 bg-emerald-500/15 text-emerald-500 hover:bg-emerald-500/25 ring-1 ring-emerald-500/20 border-0">
                  {loading[p.name] ? '...' : 'Bắt đầu'}
                </button>
                <button onClick={() => act(p.name, 'stop')} disabled={!p.running || loading[p.name]}
                  className="px-3 py-1.5 text-[11px] font-semibold rounded-lg transition-all cursor-pointer disabled:opacity-30 active:scale-95 bg-red-500/10 text-red-400 hover:bg-red-500/20 ring-1 ring-red-500/15 border-0">
                  {loading[p.name] ? '...' : 'Dừng'}
                </button>
                <select onChange={e => { const v = e.target.value as 'basic' | 'deep' | 'nuke'; if (v) { cleanProject(p.name, v); e.target.value = '' } }}
                  disabled={clearing[p.name]} className="px-2 py-1.5 text-[11px] font-semibold rounded-lg cursor-pointer border transition-colors"
                  style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}>
                  <option value="">Dọn...</option>
                  <option value="basic">Cache nhanh</option>
                  <option value="deep">Build sâu</option>
                  <option value="nuke">Xóa sạch & Cài lại</option>
                </select>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Log Viewer */}
      <div className="flex-1 min-h-0 px-4 pb-4">
        <div className="h-full rounded-xl border flex flex-col overflow-hidden backdrop-blur"
          style={{ background: 'var(--bg-log)', borderColor: 'var(--border)' }}>
          <div className="shrink-0 flex flex-col">
            <div className="flex items-center justify-between px-4 py-2 border-b" style={{ borderColor: 'var(--border)' }}>
              <div className="flex gap-0.5 overflow-x-auto">
                {tabs.map(tab => {
                  const isActive = activeTab === tab
                  return (
                    <button key={tab} onClick={() => setActiveTab(tab)}
                      className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-all border cursor-pointer`}
                      style={isActive
                        ? { background: theme === 'light' ? '#10b981' : 'var(--input-bg)', color: theme === 'light' ? '#fff' : '#10b981', borderColor: 'rgba(16,185,129,0.2)' }
                        : { color: theme === 'light' ? '#000' : '#fff', backgroundColor: 'transparent', borderColor: 'transparent' }}>
                      {tab}
                      {tab !== 'All' && (
                        <span className={`ml-1.5 px-1 py-0.5 rounded text-[9px] font-mono ${projects.find(p => p.name === tab)?.running ? 'bg-emerald-500/10 text-emerald-400' : ''}`}
                          style={!projects.find(p => p.name === tab)?.running ? { background: theme === 'light' ? '#e5e7eb' : 'var(--input-bg)', color: theme === 'light' ? '#6b7280' : 'var(--fg-dim)' } : {}}>
                          {projects.find(p => p.name === tab)?.running ? 'BẬT' : 'TẮT'}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
              <div className="flex items-center gap-1.5 shrink-0 ml-2">
                <select id="log-export-limit" name="exportLimit" value={exportLimit} onChange={e => setExportLimit(Number(e.target.value))}
                  className="px-1.5 py-0.5 text-[10px] font-medium rounded-md cursor-pointer border"
                  style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}>
                  <option value={100}>100 dòng</option>
                  <option value={500}>500 dòng</option>
                  <option value={1000}>1000 dòng</option>
                  <option value={0}>Tất cả</option>
                </select>
                <select id="log-export-format" name="exportFormat" value={exportFormat} onChange={e => setExportFormat(e.target.value as any)}
                  className="px-1.5 py-0.5 text-[10px] font-medium rounded-md cursor-pointer border"
                  style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}>
                  <option value="txt">Văn bản</option>
                  <option value="md">Markdown</option>
                  <option value="json">JSON</option>
                </select>
                <button onClick={handleExportLog}
                  className="px-2.5 py-0.5 text-[10px] font-medium rounded-md border transition-all active:scale-95 cursor-pointer"
                  style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}>
                  <svg className="w-2.5 h-2.5 inline mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  Lưu
                </button>
                <button onClick={handleCopyLog}
                  className="px-2.5 py-0.5 text-[10px] font-medium rounded-md transition-all active:scale-95 cursor-pointer bg-emerald-600 hover:bg-emerald-500 text-white border-0 flex items-center gap-1">
                  <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
                  </svg>
                  Copy
                </button>
                <button onClick={handleDownloadLog}
                  className="px-2.5 py-0.5 text-[10px] font-medium rounded-md border transition-all active:scale-95 cursor-pointer flex items-center gap-1"
                  style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}>
                  <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  Tải
                </button>
              </div>
            </div>
            {/* Log Search & Filter Bar */}
            <div className="flex items-center gap-2 px-4 py-1.5 border-b" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--input-bg)' }}>
              <div className="relative flex-1">
                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[9px]" style={{ color: 'var(--fg-dim)' }}>🔍</span>
                <input id="log-search" name="logSearch" type="text" value={logSearch} onChange={e => setLogSearch(e.target.value)}
                  placeholder="Tìm kiếm trong log..."
                  className="w-full pl-6 pr-2 py-1 text-[10px] rounded border focus:outline-none focus:ring-1 focus:ring-emerald-500/30 transition-all"
                  style={{ backgroundColor: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--fg)' }} />
              </div>
              <select id="log-filter" name="logFilter" value={logFilter} onChange={e => setLogFilter(e.target.value as any)}
                className="px-1.5 py-1 text-[10px] rounded border cursor-pointer"
                style={{ backgroundColor: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}>
                <option value="all">Tất cả</option>
                <option value="info">ℹ️ Info</option>
                <option value="warn">⚠️ Warning</option>
                <option value="error">🚫 Error</option>
              </select>
              {logSearch && (
                <button onClick={() => setLogSearch('')}
                  className="text-[9px] px-1.5 py-1 rounded hover:bg-black/10 dark:hover:bg-white/10 transition-colors border-0 cursor-pointer"
                  style={{ color: 'var(--fg-muted)' }}>✕</button>
              )}
              <span className="text-[9px] font-mono" style={{ color: 'var(--fg-dim)' }}>
                {(() => {
                  const filtered = logSearch ? displayLines.filter(l => l.toLowerCase().includes(logSearch.toLowerCase())) : displayLines
                  return `${filtered.length}/${displayLines.length}`
                })()}
              </span>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-3 font-mono text-xs leading-relaxed" style={{ color: 'var(--fg-secondary)' }}>
            {displayLines.length === 0 ? (
              <div className="flex items-center justify-center h-full">
                <div className="text-center">
                  <svg className="w-8 h-8 mx-auto mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} style={{ color: 'var(--fg-dim)' }}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 013.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                  </svg>
                  <p style={{ color: 'var(--fg-dim)' }} className="text-xs">Chưa có log. Hãy khởi động máy chủ.</p>
                </div>
              </div>
            ) : (
              (() => {
                const filtered = logSearch
                  ? displayLines.filter(l => l.toLowerCase().includes(logSearch.toLowerCase()))
                  : displayLines
                const levelFiltered = logFilter === 'all' ? filtered : filtered.filter(l => {
                  if (logFilter === 'error') return l.toLowerCase().includes('error') || l.toLowerCase().includes('fail') || l.toLowerCase().includes('exception')
                  if (logFilter === 'warn') return l.toLowerCase().includes('warn') || l.toLowerCase().includes('warning')
                  if (logFilter === 'info') return !l.toLowerCase().includes('error') && !l.toLowerCase().includes('warn') && !l.toLowerCase().includes('fail')
                  return true
                })
                if (levelFiltered.length === 0) {
                  return (
                    <div className="flex items-center justify-center h-full">
                      <p className="text-xs italic" style={{ color: 'var(--fg-dim)' }}>Không có log phù hợp với bộ lọc</p>
                    </div>
                  )
                }
                return levelFiltered.map((line, i) => {
                  // Highlight search matches
                  let html = ansiConverter.toHtml(line)
                  if (logSearch) {
                    const escapedSearch = logSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                    try {
                      html = html.replace(
                        new RegExp(`(${escapedSearch})`, 'gi'),
                        '<mark style="background-color:rgba(251,191,36,0.3);color:#fbbf24;border-radius:2px">$1</mark>'
                      )
                    } catch {}
                  }
                  return (
                    <div key={i} className={`whitespace-pre-wrap break-all hover:bg-white/[0.03] px-1 -mx-1 rounded transition-colors ${
                      line.toLowerCase().includes('error') ? 'border-l-2 border-red-500/30 pl-2' :
                      line.toLowerCase().includes('warn') ? 'border-l-2 border-amber-500/30 pl-2' : ''
                    }`}
                      style={{ color: 'var(--fg-secondary)' }} dangerouslySetInnerHTML={{ __html: html }} />
                  )
                })
              })()
            )}
            <div ref={logEndRef} />
          </div>
        </div>
      </div>

      {/* Env Editor Modal */}
      {envEditingProject && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={e => { if (e.target === e.currentTarget) setEnvEditingProject(null) }}>
          <div className="w-full max-w-lg rounded-2xl border shadow-2xl p-6 transition-colors flex flex-col"
            style={{ backgroundColor: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--fg)' }}>
            <div className="flex items-center justify-between pb-4 border-b" style={{ borderColor: 'var(--border)' }}>
              <div>
                <label htmlFor="env-editor" className="text-sm font-semibold cursor-pointer">Biến môi trường</label>
                <p className="text-[10px] font-mono text-gray-500">{envEditingProject} › {envFileName}</p>
              </div>
              <button onClick={() => setEnvEditingProject(null)}
                className="p-1 rounded-lg hover:bg-black/10 dark:hover:bg-white/10 transition-colors cursor-pointer border-0"
                style={{ color: 'var(--fg-muted)' }}>&times;</button>
            </div>
            <textarea id="env-editor" name="envContent" value={envContent} onChange={e => setEnvContent(e.target.value)} rows={12}
              className="w-full border rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-emerald-500 mt-4"
              style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--fg)' }}
              placeholder="# PORT=4000\n# DATABASE_URL=..." />
            <div className="mt-6 flex justify-end gap-2">
              <button onClick={() => setEnvEditingProject(null)}
                className="px-3 py-1.5 text-[11px] font-medium border rounded-lg transition-colors active:scale-95 cursor-pointer"
                style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}>Hủy</button>
              <button onClick={saveEnvFile} disabled={envSaving}
                className="px-4 py-1.5 text-[11px] font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-colors active:scale-95 cursor-pointer disabled:opacity-50 border-0">
                {envSaving ? 'Saving...' : 'Lưu tập tin'}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}
