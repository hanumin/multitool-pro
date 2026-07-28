import { useState, useEffect, useCallback, lazy, Suspense } from 'react'
import { downloadBlobFromResponse } from '../../utils/downloadBlob'

const SqlQueryView = lazy(() => import('./database/SqlQueryView'))
const ConnectionForm = lazy(() => import('./database/ConnectionForm'))
const DataTable = lazy(() => import('./database/DataTable'))

import { API, fetchWithRetry } from '../../utils/apiFetch'
import { useToast } from '../../components/ToastManager'
import type { PreloadedData } from '../../types'

interface DbConnection {
  id?: string
  name: string
  type: 'postgresql' | 'mysql'
  host: string
  port: number
  database: string
  user: string
  password: string
}

interface TableInfo {
  name: string
  rows: number
}

interface DatabaseModuleProps {
  theme: 'dark' | 'light'
  setStatusText: (t: string) => void
  inactive?: boolean
  preloadedData?: PreloadedData
}

// WHY: Module quản lý database — kết nối PostgreSQL/MySQL, duyệt schema/tables, SQL query editor.
// Sidebar trái: danh sách connections + tree view databases/schemas/tables.
// Content chính: DataTable browser hoặc SQL Query view (tab switch).
export default function DatabaseModule({ theme, setStatusText, inactive, preloadedData }: DatabaseModuleProps) {
  const { addToast } = useToast()

  // WHY: Dùng preloaded databaseConnections để connections list hiển thị ngay
  // khi app khởi động, không cần chờ fetch API lần đầu.
  const preloadedConns = preloadedData?.databaseConnections
  const [connections, setConnections] = useState<DbConnection[]>(preloadedConns || [])
  const [showConnectionForm, setShowConnectionForm] = useState(false)
  const [editConn, setEditConn] = useState<Partial<DbConnection>>({
    name: '', type: 'postgresql', host: 'localhost', port: 5432, database: '', user: 'postgres', password: ''
  })
  const [testing, setTesting] = useState(false)
  const [connectedDb, setConnectedDb] = useState<string | null>(null)
  const [connectedInfo, setConnectedInfo] = useState<any>(null)
  const [databases, setDatabases] = useState<string[]>([])
  const [selectedDb, setSelectedDb] = useState('')
  const [schemas, setSchemas] = useState<string[]>([])
  const [selectedSchema, setSelectedSchema] = useState('public')
  const [tables, setTables] = useState<TableInfo[]>([])
  const [selectedTable, setSelectedTable] = useState('')
  const [tableData, setTableData] = useState<any>(null)
  const [page, setPage] = useState(1)
  const [activeView, setActiveView] = useState<'browse' | 'query'>('browse')
  const [loading, setLoading] = useState(false)
  const [localDbs, setLocalDbs] = useState<{type: string, host: string, port: number, user: string, password: string, name: string, detected: boolean}[]>([])
  const [scanningLocal, setScanningLocal] = useState(false)

  // WHY: Tự động quét database local (PostgreSQL, MySQL, MariaDB) khi component mount.
  // Dùng [] deps — chỉ chạy 1 lần, không re-scan khi re-render.
  useEffect(() => {
    scanLocalDatabases()
  }, [])

  // WHY: Thử kết nối đến các database server phổ biến trên localhost.
  // Dùng tuần tự (for loop, không Promise.all) để tránh quá tải CPU khi scan.
  // Chỉ phát hiện, không tự động kết nối.
  const scanLocalDatabases = async () => {
    setScanningLocal(true)
    const candidates = [
      { type: 'postgresql', host: 'localhost', port: 5432, user: 'postgres', password: 'postgres', name: 'Local PostgreSQL' },
      { type: 'mysql', host: 'localhost', port: 3306, user: 'root', password: '', name: 'Local MySQL' },
      { type: 'mysql', host: 'localhost', port: 3307, user: 'root', password: '', name: 'Local MariaDB' },
    ]
    const results: typeof localDbs = []
    for (const c of candidates) {
      try {
        const res = await fetchWithRetry(`${API}/api/database/test`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(c)
        })
        const data = await res.json()
        if (data.success) {
          results.push({ ...c, detected: true })
        }
      } catch {}
    }
    setLocalDbs(results)
    setScanningLocal(false)
    if (results.length > 0) {
      setStatusText(`🔍 Phát hiện ${results.length} database server local`)
      addToast({ type: 'info', title: '🗄️ Database local', message: `Phát hiện ${results.length} database server` })
    }
  }

  // WHY: 1-click kết nối: kiểm tra existing connection → save nếu chưa có → connect.
  // Tránh duplicate connections bằng cách check host + port + user + type.
  const quickConnect = async (db: typeof localDbs[0]) => {
    setTesting(true)
    try {
      const existing = connections.find(c =>
        c.host === db.host && c.port === db.port && c.user === db.user && c.type === db.type
      )
      if (existing && existing.id) {
        setStatusText(`✅ Reconnecting to ${db.name}`)
        await connectToDb(existing.id)
        setTesting(false)
        return
      }
      const connPayload = {
        name: db.name,
        type: db.type,
        host: db.host,
        port: db.port,
        database: db.type === 'postgresql' ? 'postgres' : '',
        user: db.user,
        password: db.password,
      }
      const saveRes = await fetchWithRetry(`${API}/api/database/connections`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(connPayload)
      })
      if (!saveRes.ok) { setStatusText(`❌ Failed to save connection`); addToast({ type: 'error', title: '🗄️ Database', message: 'Lưu kết nối thất bại' }); setTesting(false); return }
      const saved = await saveRes.json()
      if (!saved.connection?.id) { setStatusText(`❌ Invalid response from server`); addToast({ type: 'error', title: '🗄️ Database', message: 'Phản hồi từ server không hợp lệ' }); setTesting(false); return }
      setStatusText(`✅ Connected to ${db.name}`)
      addToast({ type: 'success', title: '🗄️ Database', message: `Đã kết nối ${db.name}` })
      const listRes = await fetchWithRetry(`${API}/api/database/connections`)
      const listData = await listRes.json()
      setConnections(listData.connections || [])
      await connectToDb(saved.connection.id)
    } catch (e: any) { setStatusText(`❌ ${e.message}`); addToast({ type: 'error', title: '🗄️ Lỗi kết nối', message: e.message }) }
    finally { setTesting(false) }
  }

  useEffect(() => {
    fetchWithRetry(`${API}/api/database/connections`)
      .then(r => r.json())
      .then(d => setConnections(d.connections || []))
      .catch(() => {})
  }, [])

  // WHY: Test connection → nếu thành công thì save + connect luôn.
  // 2-step: POST /api/database/test (verify) → POST /api/database/connections (save).
  // Sau khi save, refresh danh sách connections từ server để có ID mới.
  const testAndSaveConnection = async () => {
    setTesting(true)
    try {
      const res = await fetchWithRetry(`${API}/api/database/test`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editConn)
      })
      const result = await res.json()
      if (result.success) {
        addToast({ type: 'success', title: '🗄️ Database', message: 'Kết nối thành công' })
        const saveRes = await fetchWithRetry(`${API}/api/database/connections`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(editConn)
        })
        if (saveRes.ok) {
          const saved = await saveRes.json()
          setStatusText(`✅ Connected: ${result.message}`)
          setShowConnectionForm(false)
          const listRes = await fetchWithRetry(`${API}/api/database/connections`)
          const listData = await listRes.json()
          setConnections(listData.connections || [])
          connectToDb(saved.connection?.id || '')
        }
      } else {
        setStatusText(`❌ ${result.error}`)
        addToast({ type: 'error', title: '🗄️ Lỗi database', message: result.error })
      }
    } catch (e: any) { setStatusText(`❌ ${e.message}`); addToast({ type: 'error', title: '🗄️ Lỗi database', message: e.message }) }
    finally { setTesting(false) }
  }

  // WHY: Reset state trước khi connect để tránh hiển thị dữ liệu cũ.
  // setConnectedDb TRƯỚC fetch để UI hiển thị trạng thái "đang kết nối" ngay.
  const connectToDb = async (connId: string) => {
    setLoading(true)
    setConnectedDb(connId)
    setTableData(null)
    setSelectedTable('')
    try {
      const res = await fetchWithRetry(`${API}/api/database/connect`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId: connId })
      })
      const data = await res.json()
      if (data.success) {
        setConnectedInfo(data)
        setDatabases(data.databases || [])
        setSelectedDb(data.databases?.[0] || '')
        setStatusText(`✅ Connected to ${data.connection?.name || 'DB'}`)
        addToast({ type: 'success', title: '🗄️ Đã kết nối', message: `Kết nối ${data.connection?.name || 'DB'} thành công` })
      } else {
        setStatusText(`❌ ${data.error}`)
        addToast({ type: 'error', title: '🗄️ Kết nối thất bại', message: data.error })
        setConnectedDb(null)
      }
    } catch (e: any) { setStatusText(`❌ ${e.message}`); addToast({ type: 'error', title: '🗄️ Lỗi kết nối', message: e.message }) }
    finally { setLoading(false) }
  }

  // WHY: Cascading data loading: connect → databases → schemas → tables → data.
  // Mỗi bước phụ thuộc vào bước trước (connectedDb + selectedDb cần có trước).
  const loadSchemas = useCallback(async () => {
    if (!connectedDb || !selectedDb) return
    try {
      const res = await fetchWithRetry(`${API}/api/database/schemas`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId: connectedDb, database: selectedDb })
      })
      if (res.ok) {
        const data = await res.json()
        setSchemas(data.schemas || [])
        if (data.schemas?.includes('public')) setSelectedSchema('public')
        else setSelectedSchema(data.schemas?.[0] || 'public')
      }
    } catch {}
  }, [connectedDb, selectedDb])

  // WHY: loadTables phụ thuộc vào selectedSchema — tự động reload khi đổi schema.
  // useEffect ở dưới trigger loadTables khi connectedDb/selectedDb/selectedSchema thay đổi.
  const loadTables = useCallback(async () => {
    if (!connectedDb || !selectedDb) return
    setLoading(true)
    try {
      const res = await fetchWithRetry(`${API}/api/database/tables`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId: connectedDb, database: selectedDb, schema: selectedSchema })
      })
      if (res.ok) {
        const data = await res.json()
        setTables(data.tables || [])
      }
    } catch {}
    finally { setLoading(false) }
  }, [connectedDb, selectedDb, selectedSchema])

  useEffect(() => { if (connectedDb && selectedDb) loadSchemas() }, [connectedDb, selectedDb, loadSchemas])
  useEffect(() => { if (connectedDb && selectedDb && selectedSchema) loadTables() }, [connectedDb, selectedDb, selectedSchema, loadTables])

  // WHY: Load data từ table với pagination — POST /api/database/table-data.
  // pageSize = 100 rows mỗi lần để cân bằng speed vs network.
  // Backend trả về columns + rows + total_rows + total_pages.
  const loadTableData = async (tableName: string, pageNum = 1) => {
    setSelectedTable(tableName)
    setPage(pageNum)
    setLoading(true)
    try {
      const res = await fetchWithRetry(`${API}/api/database/table-data`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          connectionId: connectedDb, database: selectedDb,
          schema: selectedSchema, table: tableName,
          page: pageNum, pageSize: 100
        })
      })
      if (res.ok) {
        const data = await res.json()
        setTableData(data)
      }
    } catch {}
    finally { setLoading(false) }
  }

  // WHY: Export table data — POST /api/database/export trả về file stream.
  // Dùng downloadBlobFromResponse utility để parse Content-Disposition + tạo download.
  // Hỗ trợ CSV và JSON format.
  const exportTableData = async (format: 'csv' | 'json') => {
    if (!connectedDb || !selectedTable) { setStatusText('No table selected'); return }
    try {
      setStatusText(`Exporting ${selectedTable} as ${format.toUpperCase()}...`)
      const res = await fetchWithRetry(`${API}/api/database/export`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          connectionId: connectedDb, database: selectedDb,
          schema: selectedSchema, table: selectedTable, format
        })
      })
      if (!res.ok) { const err = await res.json(); setStatusText(`❌ ${err.error}`); addToast({ type: 'error', title: '📤 Lỗi xuất dữ liệu', message: err.error }); return }
      const filename = await downloadBlobFromResponse(res, `${selectedTable}.${format}`)
      setStatusText(`✅ Exported ${filename}`)
      addToast({ type: 'success', title: '📤 Xuất dữ liệu', message: `Đã xuất ${filename}` })
    } catch (e: any) { setStatusText(`❌ ${e.message}`); addToast({ type: 'error', title: '📤 Lỗi xuất dữ liệu', message: e.message }) }
  }

  // WHY: Clear tất cả state liên quan đến connection — không chỉ setConnectedDb(null).
  // Nếu không clear databases/tables/tableData, UI sẽ hiển thị dữ liệu cũ khi connect lại.
  const disconnect = () => {
    setConnectedDb(null)
    setConnectedInfo(null)
    setDatabases([])
    setTables([])
    setTableData(null)
    setStatusText('Disconnected')
    addToast({ type: 'info', title: '🗄️ Database', message: 'Đã ngắt kết nối' })
  }

  // WHY: Xóa kết nối — DELETE /api/database/connections?id=...
  // Nếu đang connected với connId đó, tự động disconnect để tránh stale state.
  // Refresh danh sách connections sau khi xóa.
  const deleteConnection = async (connId: string) => {
    if (!window.confirm('Delete this connection?')) return
    try {
      await fetchWithRetry(`${API}/api/database/connections?id=${connId}`, { method: 'DELETE' })
      addToast({ type: 'info', title: '🗄️ Database', message: 'Đã xóa kết nối' })
      const res = await fetchWithRetry(`${API}/api/database/connections`)
      const data = await res.json()
      setConnections(data.connections || [])
      if (connectedDb === connId) disconnect()
    } catch {}
  }

  // ─── RENDER ──────────────────────────────────────────────────
  return (
    <div className="flex h-full" style={{ display: inactive ? 'none' : 'flex' }}>
      {/* Sidebar: Connection list + DB tree */}
      {!showConnectionForm && (
        <div className="w-56 shrink-0 border-r flex flex-col" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--bg-sidebar)' }}>
          <div className="p-3 border-b flex items-center justify-between" style={{ borderColor: 'var(--border)' }}>
            <h3 className="text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--fg-muted)' }}>Kết nối</h3>
            <button onClick={() => setShowConnectionForm(true)}
              className="p-1 rounded hover:bg-black/10 dark:hover:bg-white/10 transition-colors border-0 cursor-pointer"
              style={{ color: 'var(--fg-muted)' }}>
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {connections.length === 0 && (
              <p className="text-xs italic text-center py-4" style={{ color: 'var(--fg-dim)' }}>Chưa có kết nối</p>
            )}
            {connections.map((conn) => {
              const isConnected = connectedDb === conn.id
              return (
                <div key={conn.id}>
                  <button onClick={() => isConnected ? disconnect() : connectToDb(conn.id || '')}
                    className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs transition-all border-0 cursor-pointer text-left ${
                      isConnected ? 'bg-emerald-500/15 text-emerald-500' : 'hover:bg-black/5 dark:hover:bg-white/5'
                    }`}
                    style={{ color: isConnected ? undefined : 'var(--fg-secondary)' }}>
                    <span className={`w-2 h-2 rounded-full shrink-0 ${isConnected ? 'bg-emerald-400' : ''}`}
                      style={{ backgroundColor: isConnected ? undefined : 'var(--fg-dim)' }} />
                    <span className="truncate flex-1">{conn.name}</span>
                    <span className={`text-[8px] px-1 py-0.5 rounded ${
                      conn.type === 'postgresql' ? 'bg-blue-500/10 text-blue-400' : 'bg-orange-500/10 text-orange-400'
                    }`}>
                      {conn.type === 'postgresql' ? 'PG' : 'MY'}
                    </span>
                  </button>
                  {isConnected && databases.length > 0 && (
                    <div className="ml-3 mt-1 space-y-0.5 pl-2 border-l" style={{ borderColor: 'var(--border)' }}>
                      {databases.map(db => (
                        <div key={db}>
                          <button onClick={() => setSelectedDb(db)}
                            className={`w-full text-left px-2 py-0.5 text-[10px] font-mono rounded transition-colors border-0 cursor-pointer ${
                              selectedDb === db ? 'bg-emerald-500/10 text-emerald-500' : 'hover:bg-black/5 dark:hover:bg-white/5'
                            }`}
                            style={{ color: selectedDb === db ? undefined : 'var(--fg-muted)' }}>
                            🗄️ {db}
                          </button>
                          {selectedDb === db && tables.length > 0 && (
                            <div className="ml-3 space-y-0.5 mb-1">
                              <div className="flex gap-1 px-1 py-0.5 flex-wrap">
                                {schemas.map(s => (
                                  <button key={s} onClick={() => setSelectedSchema(s)}
                                    className={`text-[8px] px-1 py-0.5 rounded transition-colors border-0 cursor-pointer ${
                                      selectedSchema === s ? 'bg-blue-500/15 text-blue-400' : 'hover:bg-black/5 dark:hover:bg-white/5'
                                    }`}
                                    style={{ color: selectedSchema === s ? undefined : 'var(--fg-dim)' }}>
                                    {s}
                                  </button>
                                ))}
                              </div>
                              {tables.slice(0, 30).map(t => (
                                <button key={t.name} onClick={() => { setActiveView('browse'); loadTableData(t.name) }}
                                  className={`w-full text-left px-2 py-0.5 text-[10px] font-mono rounded transition-colors border-0 cursor-pointer flex items-center gap-1 ${
                                    selectedTable === t.name ? 'bg-emerald-500/10 text-emerald-500' : 'hover:bg-black/5 dark:hover:bg-white/5'
                                  }`}
                                  style={{ color: selectedTable === t.name ? undefined : 'var(--fg-muted)' }}>
                                  <span>📋</span>
                                  <span className="truncate">{t.name}</span>
                                  <span className="ml-auto text-[8px]" style={{ color: 'var(--fg-dim)' }}>{t.rows.toLocaleString()}</span>
                                </button>
                              ))}
                              {tables.length > 30 && (
                                <p className="text-[8px] italic px-2" style={{ color: 'var(--fg-dim)' }}>+{tables.length - 30} more</p>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          {connectedDb && (
            <div className="p-2 border-t" style={{ borderColor: 'var(--border)' }}>
              <button onClick={disconnect}
                className="w-full px-2 py-1.5 text-[10px] font-semibold rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors border-0 cursor-pointer">
                ✕ Ngắt kết nối
              </button>
            </div>
          )}
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        {showConnectionForm ? (
          <Suspense fallback={<div className="flex-1 flex items-center justify-center"><div className="animate-spin rounded-full h-5 w-5 border-b border-emerald-500" /></div>}>
            <ConnectionForm
              editConn={editConn}
              setEditConn={setEditConn}
              testing={testing}
              onSave={testAndSaveConnection}
              onCancel={() => setShowConnectionForm(false)}
            />
          </Suspense>
        ) : connectedDb ? (
          <div className="flex-1 flex flex-col min-w-0">
            {/* Toolbar */}
            <div className="shrink-0 flex items-center justify-between px-4 py-2 border-b" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--bg-header)' }}>
              <div className="flex items-center gap-2">
                <button onClick={() => setActiveView('browse')}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md transition-all border-0 cursor-pointer ${
                    activeView === 'browse' ? 'bg-emerald-500/15 text-emerald-500' : 'hover:bg-black/5 dark:hover:bg-white/5'
                  }`}
                  style={{ color: activeView === 'browse' ? undefined : 'var(--fg-secondary)' }}>
                  📋 Duyệt dữ liệu
                </button>
                <button onClick={() => setActiveView('query')}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md transition-all border-0 cursor-pointer ${
                    activeView === 'query' ? 'bg-emerald-500/15 text-emerald-500' : 'hover:bg-black/5 dark:hover:bg-white/5'
                  }`}
                  style={{ color: activeView === 'query' ? undefined : 'var(--fg-secondary)' }}>
                  💻 SQL Query
                </button>
                {connectedInfo && (
                  <span className="text-[10px] px-2 py-0.5 rounded font-mono" style={{ backgroundColor: 'var(--input-bg)', color: 'var(--fg-dim)' }}>
                    {connectedInfo.connection?.type?.toUpperCase() || ''} {connectedInfo.version || ''}
                  </span>
                )}
              </div>
              {loading && <div className="animate-spin rounded-full h-3.5 w-3.5 border-b border-emerald-500" />}
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-4">
              {activeView === 'browse' && (
                <div className="space-y-4">
                  {selectedTable && tableData ? (
                    <Suspense fallback={<div className="flex items-center justify-center py-4"><div className="animate-spin rounded-full h-4 w-4 border-b border-emerald-500" /></div>}>
                    <DataTable
                      columns={tableData.columns}
                      rows={tableData.rows}
                      totalRows={tableData.total_rows}
                      totalPages={tableData.total_pages}
                      page={page}
                      onPageChange={(newPage) => loadTableData(selectedTable, newPage)}
                      selectedTable={selectedTable}
                      selectedDb={selectedDb}
                      selectedSchema={selectedSchema}
                      onExportCSV={() => exportTableData('csv')}
                      onExportJSON={() => exportTableData('json')}
                    />
                    </Suspense>
                  ) : !selectedTable ? (
                    <div className="flex flex-col items-center justify-center py-12">
                      <svg className="w-12 h-12 mb-3 opacity-20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
                      </svg>
                      <p className="text-sm font-medium" style={{ color: 'var(--fg-secondary)' }}>Chọn một table để xem dữ liệu</p>
                      <p className="text-xs mt-1" style={{ color: 'var(--fg-dim)' }}>Click vào table name ở sidebar trái</p>
                    </div>
                  ) : (
                    <div className="flex items-center justify-center py-12">
                      <div className="animate-spin rounded-full h-5 w-5 border-b border-emerald-500" />
                    </div>
                  )}
                </div>
              )}

              {activeView === 'query' && (
                <Suspense fallback={
                  <div className="flex items-center justify-center py-12">
                    <div className="flex flex-col items-center gap-3">
                      <div className="animate-spin rounded-full h-6 w-6 border-b border-emerald-500" />
                      <span className="text-xs" style={{ color: 'var(--fg-dim)' }}>Loading SQL editor...</span>
                    </div>
                  </div>
                }>
                  <SqlQueryView
                    connectedDb={connectedDb}
                    selectedDb={selectedDb}
                    selectedSchema={selectedSchema}
                    theme={theme}
                    setStatusText={setStatusText}
                  />
                </Suspense>
              )}
            </div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center">
            <svg className="w-16 h-16 mb-4 opacity-20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
            </svg>
            <h2 className="text-base font-semibold mb-2" style={{ color: 'var(--fg)' }}>Database Manager</h2>
            <p className="text-xs mb-4" style={{ color: 'var(--fg-dim)' }}>Kết nối đến PostgreSQL / MySQL để quản lý</p>

            {localDbs.length > 0 && (
              <div className="mb-6 text-center">
                <p className="text-xs font-medium mb-2" style={{ color: 'var(--fg-muted)' }}>🔍 Phát hiện database local</p>
                <div className="flex flex-wrap justify-center gap-2">
                  {localDbs.map((db, i) => (
                    <button key={i} onClick={() => quickConnect(db)} disabled={testing}
                      className={`px-4 py-2 text-xs font-semibold rounded-lg transition-all border-0 cursor-pointer flex items-center gap-1.5 ${
                        db.type === 'postgresql'
                          ? 'bg-blue-600 hover:bg-blue-500 text-white'
                          : 'bg-orange-600 hover:bg-orange-500 text-white'
                      }`}>
                      {db.type === 'postgresql' ? '🐘' : '🐬'} {db.name}
                      <span className="opacity-70 text-[10px]">→ 1-click</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {scanningLocal && (
              <div className="flex items-center gap-2 mb-4 text-xs" style={{ color: 'var(--fg-dim)' }}>
                <div className="animate-spin rounded-full h-3 w-3 border-b border-emerald-500" />
                Đang quét database local...
              </div>
            )}

            <div className="flex gap-2">
              <button onClick={() => setShowConnectionForm(true)}
                className="px-4 py-2 text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-colors border-0 cursor-pointer">
                + Thêm kết nối mới
              </button>
              <button onClick={scanLocalDatabases} disabled={scanningLocal}
                className="px-3 py-2 text-xs font-semibold rounded-lg transition-colors border cursor-pointer"
                style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}>
                🔍 Quét lại
              </button>
              {connections.length > 0 && connections.map(conn => (
                <button key={conn.id} onClick={() => connectToDb(conn.id || '')}
                  className={`px-3 py-2 text-xs font-semibold rounded-lg transition-colors border cursor-pointer ${
                    conn.type === 'postgresql'
                      ? 'bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 border-blue-500/20'
                      : 'bg-orange-500/10 text-orange-400 hover:bg-orange-500/20 border-orange-500/20'
                  }`}>
                  {conn.type === 'postgresql' ? '🐘' : '🐬'} {conn.name}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
