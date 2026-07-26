import { useState, useEffect, useCallback } from 'react'

import { API, fetchWithRetry } from '../../utils/apiFetch'

interface SourceDir {
  key: string
  label: string
  path: string
  count: number
}

interface FileCopierModuleProps {
  theme: 'dark' | 'light'
  setStatusText: (t: string) => void
}

// WHY: Module sao chép file audio/video theo từ khóa từ nhiều thư mục nguồn.
// Hỗ trợ dry-run (chạy thử) và copy thật với MD5 verification.
// Dùng Tauri dialog để chọn thư mục, backend xử lý scan + copy.
export default function FileCopierModule({ theme, setStatusText }: FileCopierModuleProps) {
  const [sourceDirs, setSourceDirs] = useState<SourceDir[]>([
    { key: 'src1', label: 'Audio Tách Ghép Âm', path: '', count: 0 },
    { key: 'src2', label: 'Video Tách Ghép Âm', path: '', count: 0 },
    { key: 'src3', label: 'Audio Đọc 1 Lần LK', path: '', count: 0 },
    { key: 'src4', label: 'Audio Đọc 1 Lần HC', path: '', count: 0 },
    { key: 'src5', label: 'Từ điển 1', path: '', count: 0 },
    { key: 'src6', label: 'Từ điển 2', path: '', count: 0 },
  ])
  const [destDir, setDestDir] = useState('')
  const [keywords, setKeywords] = useState('')
  const [keywordMode, setKeywordMode] = useState<'manual' | 'file'>('manual')
  const [keywordFilePath, setKeywordFilePath] = useState('')
  const [fileExtensions, setFileExtensions] = useState('.mp3,.mp4,.wav,.flac')
  const [verifyMd5, setVerifyMd5] = useState(true)
  const [conflictMode, setConflictMode] = useState<'overwrite' | 'skip' | 'rename'>('overwrite')
  const [isRunning, setIsRunning] = useState(false)
  const [progress, setProgress] = useState(0)
  const [statusMessage, setStatusMessage] = useState('Sẵn sàng')
  const [logs, setLogs] = useState<string[]>([])
  const [scanningDir, setScanningDir] = useState<string | null>(null)

  // WHY: Logger dùng icon prefix + timestamp + keep 200 dòng cuối,
  // tránh memory leak từ log quá dài.
  const addLog = (msg: string, type: 'info' | 'success' | 'warning' | 'error' = 'info') => {
    const icon = type === 'success' ? '✅' : type === 'warning' ? '⚠️' : type === 'error' ? '❌' : 'ℹ️'
    const timestamp = new Date().toLocaleTimeString()
    setLogs(prev => [...prev.slice(-200), `[${timestamp}] ${icon} ${msg}`])
  }

  // WHY: Dùng Tauri dialog (dynamic import) để chọn thư mục nguồn.
  // Gọi backend đếm file ngay sau khi chọn để hiển thị số lượng.
  // KHÔNG dùng state tạm — update sourceDirs trực tiếp.
  const selectSourceDir = async (key: string) => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({ directory: true, multiple: false, title: `Chọn ${key}` })
      if (selected) {
        const path = typeof selected === 'string' ? selected : selected[0]
        setSourceDirs(prev => prev.map(d => d.key === key ? { ...d, path } : d))
        setScanningDir(key)
        try {
          const res = await fetchWithRetry(`${API}/api/file-copier/count`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path, extensions: fileExtensions.split(',').map(e => e.trim()) })
          })
          if (res.ok) {
            const data = await res.json()
            setSourceDirs(prev => prev.map(d => d.key === key ? { ...d, count: data.count } : d))
            addLog(`📁 ${key}: ${data.count} file`, 'success')
          }
        } catch { addLog(`Không thể đếm file trong ${key}`, 'error') }
        finally { setScanningDir(null) }
      }
    } catch { addLog('Không thể mở hộp thoại chọn thư mục', 'error') }
  }

  // WHY: Tương tự selectSourceDir, dùng Tauri dialog chọn thư mục đích.
  // Độc lập với source dirs — user có thể chọn sau.
  const selectDestDir = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({ directory: true, multiple: false, title: 'Chọn thư mục đích' })
      if (selected) {
        const path = typeof selected === 'string' ? selected : selected[0]
        setDestDir(path)
        addLog(`📁 Đích: ${path}`, 'info')
      }
    } catch { addLog('Không thể mở hộp thoại chọn thư mục', 'error') }
  }

  // WHY: Chọn file .txt chứa từ khóa, gửi lên backend parse.
  // Backend trả về keywords array → merge vào state keywords (textarea).
  // Cho phép keywordMode='file' thay vì gõ tay.
  const selectKeywordFile = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({ multiple: false, title: 'Chọn file từ khóa', filters: [{ name: 'Text', extensions: ['txt'] }] })
      if (selected) {
        const path = typeof selected === 'string' ? selected : selected[0]
        setKeywordFilePath(path)
        try {
          const res = await fetchWithRetry(`${API}/api/file-copier/read-keywords`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path })
          })
          if (res.ok) {
            const data = await res.json()
            setKeywords(data.keywords?.join('\n') || '')
            addLog(`📄 Đã tải ${data.count} từ khóa từ file`, 'success')
          }
        } catch { addLog('Không thể đọc file từ khóa', 'error') }
      }
    } catch { addLog('Không thể mở hộp thoại chọn file', 'error') }
  }

  // WHY: Reset toàn bộ state về mặc định — không gọi API,
  // chỉ cleanup local state để user bắt đầu lại.
  const resetAll = () => {
    setSourceDirs(prev => prev.map(d => ({ ...d, path: '', count: 0 })))
    setDestDir('')
    setKeywords('')
    setKeywordFilePath('')
    setLogs([])
    setProgress(0)
    setStatusMessage('Sẵn sàng')
    addLog('🔄 Đã đặt lại tất cả', 'info')
  }

  // WHY: Hàm chính — gửi lệnh copy/dry-run lên backend.
  // dryRun=true: chạy thử (tìm file nhưng không copy).
  // dryRun=false: thực hiện copy thật.
  // Validate inputs TRƯỚC khi gửi request để tránh lỗi backend.
  // Backend trả về found_count + not_found_count + logs chi tiết.
  const runCopy = async (dryRun: boolean) => {
    const validSources = sourceDirs.filter(d => d.path)
    if (validSources.length === 0) { addLog('Vui lòng chọn ít nhất một thư mục nguồn', 'error'); return }
    if (!destDir) { addLog('Vui lòng chọn thư mục đích', 'error'); return }
    if (!keywords.trim()) { addLog('Vui lòng nhập từ khóa', 'error'); return }

    const keywordList = keywords.split('\n').map(k => k.trim()).filter(k => k)
    if (keywordList.length === 0) { addLog('Không có từ khóa hợp lệ', 'error'); return }

    setIsRunning(true)
    setProgress(0)
    setStatusMessage(dryRun ? 'Đang chạy thử...' : 'Đang sao chép...')
    addLog(`🚀 Bắt đầu ${dryRun ? 'CHẠY THỬ' : 'SAO CHÉP'} với ${keywordList.length} từ khóa`, dryRun ? 'warning' : 'success')

    try {
      const res = await fetchWithRetry(`${API}/api/file-copier/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sources: validSources.map(s => ({ key: s.key, path: s.path })),
          dest_dir: destDir,
          keywords: keywordList,
          extensions: fileExtensions.split(',').map((e: string) => e.trim()).filter((e: string) => e),
          conflict_mode: conflictMode,
          verify_md5: verifyMd5,
          dry_run: dryRun,
        })
      })

      if (!res.ok) {
        const err = await res.json()
        addLog(`Lỗi: ${err.error || 'Lỗi không xác định'}`, 'error')
        setIsRunning(false)
        setStatusMessage('Thất bại')
        return
      }

      const data = await res.json()
      addLog(`\n📊 Kết quả:`, 'info')
      addLog(`   Đã tìm & sao chép: ${data.found_count} file`, 'success')
      addLog(`   Không tìm thấy: ${data.not_found_count} từ khóa`, data.not_found_count > 0 ? 'warning' : 'info')
      if (data.logs && data.logs.length > 0) {
        data.logs.forEach((l: string) => {
          if (l.startsWith('✅')) addLog(l.substring(2), 'success')
          else if (l.startsWith('⚠️')) addLog(l.substring(2), 'warning')
          else if (l.startsWith('❌')) addLog(l.substring(2), 'error')
          else addLog(l, 'info')
        })
      }
      setProgress(100)
      setStatusMessage(dryRun ? 'Chạy thử hoàn tất' : 'Sao chép hoàn tất!')
      addLog(`\n${dryRun ? 'Chạy thử' : 'Sao chép'} hoàn tất!`, 'success')
    } catch (e: any) {
      addLog(`❌ ${e.message || 'Kết nối thất bại'}`, 'error')
      setStatusMessage('Lỗi')
    } finally {
      setIsRunning(false)
    }
  }

  return (
    <div className="flex flex-col h-full p-4 gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold" style={{ color: 'var(--fg)' }}>📂 Sao chép tập tin</h2>
          <p className="text-xs" style={{ color: 'var(--fg-muted)' }}>Tìm và sao chép file âm thanh/video theo từ khóa</p>
        </div>
        <div className="flex gap-2">
          <button onClick={resetAll}
            className="px-3 py-1.5 text-xs font-medium rounded-lg border transition-all active:scale-95 cursor-pointer"
            style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}>
            🔄 Đặt lại
          </button>
        </div>
      </div>

      <div className="flex-1 flex gap-4 min-h-0">
        {/* Left: Controls */}
        <div className="w-[60%] flex flex-col gap-3 overflow-y-auto pr-1">
          {/* Keywords */}
          <div className="rounded-xl border backdrop-blur p-4" style={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border)' }}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs font-semibold" style={{ color: 'var(--fg-secondary)' }}>🔑 Từ khóa</h3>
              <div className="flex gap-1">
                <button onClick={() => setKeywordMode('manual')}
                  className={`px-2 py-0.5 text-xs rounded-lg transition-all cursor-pointer border-0 ${keywordMode === 'manual' ? 'bg-emerald-500/15 text-emerald-500 ring-1 ring-emerald-500/20' : 'hover:bg-black/5 dark:hover:bg-white/5'}`}
                  style={{ color: keywordMode === 'manual' ? undefined : 'var(--fg-muted)' }}>Thủ công</button>
                <button onClick={() => setKeywordMode('file')}
                  className={`px-2 py-0.5 text-xs rounded-lg transition-all cursor-pointer border-0 ${keywordMode === 'file' ? 'bg-emerald-500/15 text-emerald-500 ring-1 ring-emerald-500/20' : 'hover:bg-black/5 dark:hover:bg-white/5'}`}
                  style={{ color: keywordMode === 'file' ? undefined : 'var(--fg-muted)' }}>Từ tập tin</button>
              </div>
            </div>
            {keywordMode === 'file' ? (
              <div className="flex items-center gap-2">
                <input id="fc-keyword-file" name="keywordFile" type="text" readOnly value={keywordFilePath}
                  className="flex-1 px-2 py-1.5 text-xs rounded-lg border font-mono"
                  style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}
                  placeholder="Chọn file từ khóa..." />
                <button onClick={selectKeywordFile}
                  className="px-3 py-1.5 text-xs font-medium rounded-lg bg-emerald-500/15 text-emerald-500 hover:bg-emerald-500/25 transition-all cursor-pointer border-0">Chọn</button>
              </div>
            ) : (
              <textarea id="fc-keywords" name="keywords" value={keywords} onChange={e => setKeywords(e.target.value)}
                className="w-full px-2 py-1.5 text-xs font-mono rounded-lg border resize-none focus:outline-none focus:ring-1 focus:ring-emerald-500"
                style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg)' }}
                rows={4} placeholder="Nhập từ khóa, mỗi từ một dòng&#10;Ví dụ:&#10;cellist&#10;population explosion" />
            )}
          </div>

          {/* Source Directories */}
          <div className="rounded-xl border backdrop-blur p-4" style={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border)' }}>
            <h3 className="text-xs font-semibold mb-3" style={{ color: 'var(--fg-secondary)' }}>📁 Thư mục nguồn</h3>
            <div className="space-y-1.5">
              {sourceDirs.map(dir => (
                <div key={dir.key} className="flex items-center gap-2 text-xs">
                  <span className="w-36 shrink-0 truncate" style={{ color: 'var(--fg-muted)' }} title={dir.label}>{dir.label}</span>
                  <div className="flex-1 flex items-center gap-1 min-w-0">
                    <span className="flex-1 truncate px-1.5 py-1 rounded font-mono"
                      style={{ backgroundColor: 'var(--input-bg)', color: dir.path ? 'var(--fg-secondary)' : 'var(--fg-dim)' }}>
                      {dir.path || 'Chưa chọn'}
                    </span>
                    {dir.count > 0 && (
                      <span className="shrink-0 px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 font-mono">{dir.count} file</span>
                    )}
                    {scanningDir === dir.key && (
                      <span className="animate-spin shrink-0">⏳</span>
                    )}
                  </div>
                  <button onClick={() => selectSourceDir(dir.key)}
                    className="px-2 py-1 rounded font-medium cursor-pointer border-0 hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
                    style={{ color: 'var(--fg-muted)' }}>Chọn</button>
                </div>
              ))}
            </div>
          </div>

          {/* Destination & Settings */}
          <div className="flex gap-3">
            <div className="flex-1 rounded-xl border backdrop-blur p-4" style={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border)' }}>
              <h3 className="text-xs font-semibold mb-3" style={{ color: 'var(--fg-secondary)' }}>🎯 Thư mục đích</h3>
              <div className="flex items-center gap-2 text-xs">
                <input id="fc-dest-dir" name="destDir" type="text" readOnly value={destDir}
                  className="flex-1 px-2 py-1.5 rounded-lg border font-mono"
                  style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}
                  placeholder="Chọn thư mục đích..." />
                <button onClick={selectDestDir}
                  className="px-3 py-1.5 rounded-lg font-medium transition-all cursor-pointer border-0 bg-emerald-500/15 text-emerald-500 hover:bg-emerald-500/25">Chọn</button>
              </div>
            </div>
            <div className="rounded-xl border backdrop-blur p-4" style={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border)' }}>
              <h3 className="text-xs font-semibold mb-3" style={{ color: 'var(--fg-secondary)' }}>⚙️ Cài đặt</h3>
              <div className="space-y-2 text-xs">
                <div className="flex items-center gap-2">
                  <span style={{ color: 'var(--fg-muted)' }}>Đuôi file:</span>
                  <input id="fc-extensions" name="fileExtensions" type="text" value={fileExtensions} onChange={e => setFileExtensions(e.target.value)}
                    className="flex-1 px-1.5 py-1 rounded border font-mono"
                    style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-secondary)' }} />
                </div>
                <label htmlFor="filecopier-verify-md5" className="flex items-center gap-2 cursor-pointer">
                  <input id="filecopier-verify-md5" name="verifyMd5" type="checkbox" checked={verifyMd5} onChange={e => setVerifyMd5(e.target.checked)}
                    className="accent-emerald-500" />
                  <span style={{ color: 'var(--fg-muted)' }}>Xác minh MD5</span>
                </label>
                <div className="flex items-center gap-2">
                  <span style={{ color: 'var(--fg-muted)' }}>Xung đột:</span>
                  <select id="filecopier-conflict-mode" name="conflictMode" value={conflictMode} onChange={e => setConflictMode(e.target.value as any)}
                    className="px-1.5 py-1 rounded border text-xs"
                    style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}>
                    <option value="overwrite">Ghi đè</option>
                    <option value="skip">Bỏ qua</option>
                    <option value="rename">Đổi tên</option>
                  </select>
                </div>
              </div>
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex gap-2">
            <button onClick={() => runCopy(true)} disabled={isRunning}
              className="flex-1 px-4 py-2 text-xs font-bold rounded-xl transition-all active:scale-[0.98] disabled:opacity-40 cursor-pointer border-0"
              style={{ backgroundColor: '#f59e0b20', color: '#f59e0b', border: '1px solid #f59e0b30' }}>
              🏃 Chạy thử
            </button>
            <button onClick={() => runCopy(false)} disabled={isRunning}
              className="flex-1 px-4 py-2 text-xs font-bold rounded-xl transition-all active:scale-[0.98] disabled:opacity-40 cursor-pointer border-0"
              style={{ backgroundColor: '#22c55e20', color: '#22c55e', border: '1px solid #22c55e30' }}>
              📋 Bắt đầu sao chép
            </button>
          </div>

          {/* Progress bar */}
          {isRunning && (
            <div className="w-full h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--border)' }}>
              <div className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-emerald-400 transition-all duration-300"
                style={{ width: `${progress}%` }} />
            </div>
          )}
          <div className="text-xs text-center" style={{ color: 'var(--fg-dim)' }}>{statusMessage}</div>
        </div>

        {/* Right: Logs */}
        <div className="w-[40%] rounded-xl border backdrop-blur flex flex-col overflow-hidden"
          style={{ backgroundColor: 'var(--bg-log)', borderColor: 'var(--border)' }}>
          <div className="shrink-0 flex items-center justify-between px-3 py-2 border-b text-xs font-semibold"
            style={{ borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}>
            <span>📋 Nhật ký</span>
            <button onClick={() => setLogs([])}
              className="text-[10px] px-1.5 py-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 transition-colors cursor-pointer border-0"
              style={{ color: 'var(--fg-muted)' }}>Xóa</button>
          </div>
          <div className="flex-1 overflow-y-auto p-2 font-mono text-xs leading-relaxed" style={{ color: 'var(--fg-secondary)' }}>
            {logs.length === 0 ? (
              <div className="flex items-center justify-center h-full italic" style={{ color: 'var(--fg-dim)' }}>
                Chưa có nhật ký
              </div>
            ) : (
              logs.map((line, i) => (
                <div key={i} className="whitespace-pre-wrap break-all" style={{ color: 'var(--fg-secondary)' }}>{line}</div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
