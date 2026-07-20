import { useState, useEffect, useCallback } from 'react'

const API = 'http://127.0.0.1:5050'

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

interface ColumnInfo {
  name: string
  type: string
  nullable: string
}

interface DatabaseModuleProps {
  theme: 'dark' | 'light'
  setStatusText: (t: string) => void
}

export default function DatabaseModule({ theme, setStatusText }: DatabaseModuleProps) {
  const [connections, setConnections] = useState<DbConnection[]>([])
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
  const [customQuery, setCustomQuery] = useState('')
  const [queryResult, setQueryResult] = useState<any>(null)
  const [queryError, setQueryError] = useState('')
  const [activeView, setActiveView] = useState<'browse' | 'query'>('browse')
  const [loading, setLoading] = useState(false)
  const [localDbs, setLocalDbs] = useState<{type: string, host: string, port: number, user: string, password: string, name: string, detected: boolean}[]>([])
  const [scanningLocal, setScanningLocal] = useState(false)

  // Scan for local databases on mount
  useEffect(() => {
    scanLocalDatabases()
  }, [])

  const scanLocalDatabases = async () => {
    setScanningLocal(true)
    const candidates = [
      // PostgreSQL: try localhost first (most common), skip 127.0.0.1 to avoid duplicates
      { type: 'postgresql', host: 'localhost', port: 5432, user: 'postgres', password: 'postgres', name: 'Local PostgreSQL' },
      { type: 'mysql', host: 'localhost', port: 3306, user: 'root', password: '', name: 'Local MySQL' },
      { type: 'mysql', host: 'localhost', port: 3307, user: 'root', password: '', name: 'Local MariaDB' },
    ]
    const results: typeof localDbs = []
    for (const c of candidates) {
      try {
        const res = await fetch(`${API}/api/database/test`, {
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
    }
  }

  const quickConnect = async (db: typeof localDbs[0]) => {
    setTesting(true)
    try {
      // Check if connection already exists (prevent duplicates)
      const existing = connections.find(c =>
        c.host === db.host && c.port === db.port && c.user === db.user && c.type === db.type
      )
      if (existing && existing.id) {
        setStatusText(`✅ Reconnecting to ${db.name}`)
        await connectToDb(existing.id)
        setTesting(false)
        return
      }
      // Save new connection
      const connPayload = {
        name: db.name,
        type: db.type,
        host: db.host,
        port: db.port,
        database: db.type === 'postgresql' ? 'postgres' : '',
        user: db.user,
        password: db.password,
      }
      const saveRes = await fetch(`${API}/api/database/connections`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(connPayload)
      })
      if (!saveRes.ok) {
        setStatusText(`❌ Failed to save connection`)
        setTesting(false)
        return
      }
      const saved = await saveRes.json()
      if (!saved.connection?.id) {
        setStatusText(`❌ Invalid response from server`)
        setTesting(false)
        return
      }
      setStatusText(`✅ Connected to ${db.name}`)
      // Refresh list
      const listRes = await fetch(`${API}/api/database/connections`)
      const listData = await listRes.json()
      setConnections(listData.connections || [])
      // Connect
      await connectToDb(saved.connection.id)
    } catch (e: any) { setStatusText(`❌ ${e.message}`) }
    finally { setTesting(false) }
  }

  // Load saved connections
  useEffect(() => {
    fetch(`${API}/api/database/connections`)
      .then(r => r.json())
      .then(d => setConnections(d.connections || []))
      .catch(() => {})
  }, [])

  const testAndSaveConnection = async () => {
    setTesting(true)
    try {
      const res = await fetch(`${API}/api/database/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editConn)
      })
      const result = await res.json()
      if (result.success) {
        // Save connection
        const saveRes = await fetch(`${API}/api/database/connections`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(editConn)
        })
        if (saveRes.ok) {
          const saved = await saveRes.json()
          setStatusText(`✅ Connected: ${result.message}`)
          setShowConnectionForm(false)
          // Refresh connections list
          const listRes = await fetch(`${API}/api/database/connections`)
          const listData = await listRes.json()
          setConnections(listData.connections || [])
          // Connect to the saved connection
          connectToDb(saved.connection?.id || '')
        }
      } else {
        setStatusText(`❌ ${result.error}`)
      }
    } catch (e: any) {
      setStatusText(`❌ ${e.message}`)
    }
    finally { setTesting(false) }
  }

  const connectToDb = async (connId: string) => {
    setLoading(true)
    setConnectedDb(connId)
    setTableData(null)
    setQueryResult(null)
    setSelectedTable('')
    try {
      const res = await fetch(`${API}/api/database/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId: connId })
      })
      const data = await res.json()
      if (data.success) {
        setConnectedInfo(data)
        setDatabases(data.databases || [])
        setSelectedDb(data.databases?.[0] || '')
        setStatusText(`✅ Connected to ${data.connection?.name || 'DB'}`)
      } else {
        setStatusText(`❌ ${data.error}`)
        setConnectedDb(null)
      }
    } catch (e: any) { setStatusText(`❌ ${e.message}`) }
    finally { setLoading(false) }
  }

  const loadSchemas = useCallback(async () => {
    if (!connectedDb || !selectedDb) return
    try {
      const res = await fetch(`${API}/api/database/schemas`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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

  const loadTables = useCallback(async () => {
    if (!connectedDb || !selectedDb) return
    setLoading(true)
    try {
      const res = await fetch(`${API}/api/database/tables`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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

  const loadTableData = async (tableName: string, pageNum = 1) => {
    setSelectedTable(tableName)
    setPage(pageNum)
    setLoading(true)
    setQueryResult(null)
    try {
      const res = await fetch(`${API}/api/database/table-data`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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

  const runCustomQuery = async () => {
    if (!customQuery.trim()) return
    setLoading(true)
    setQueryError('')
    setQueryResult(null)
    try {
      const res = await fetch(`${API}/api/database/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId: connectedDb, database: selectedDb, query: customQuery })
      })
      const data = await res.json()
      if (data.success !== false) {
        setQueryResult(data)
        if (data.affected_rows !== undefined) {
          setStatusText(`✅ Query executed, affected ${data.affected_rows} rows`)
        } else {
          setStatusText(`✅ ${data.row_count} rows returned`)
        }
      } else {
        setQueryError(data.error || 'Query failed')
      }
    } catch (e: any) { setQueryError(e.message) }
    finally { setLoading(false) }
  }

  const disconnect = () => {
    setConnectedDb(null)
    setConnectedInfo(null)
    setDatabases([])
    setTables([])
    setTableData(null)
    setQueryResult(null)
    setCustomQuery('')
    setStatusText('Disconnected')
  }

  const deleteConnection = async (connId: string) => {
    if (!window.confirm('Delete this connection?')) return
    try {
      await fetch(`${API}/api/database/connections?id=${connId}`, { method: 'DELETE' })
      const res = await fetch(`${API}/api/database/connections`)
      const data = await res.json()
      setConnections(data.connections || [])
      if (connectedDb === connId) disconnect()
    } catch {}
  }

  // Simple JSON table renderer
  const renderTable = (columns: any[], rows: any[], totalRows: number, totalPages: number) => (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-[10px]" style={{ color: 'var(--fg-dim)' }}>
        <span>{totalRows.toLocaleString()} rows</span>
        <span>Page {page} of {totalPages}</span>
      </div>
      <div className="overflow-x-auto border rounded-lg" style={{ borderColor: 'var(--border)' }}>
        <table className="w-full text-[11px] font-mono">
          <thead>
            <tr className="border-b" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--input-bg)' }}>
              <th className="px-2 py-1.5 text-left text-[9px] uppercase tracking-wider" style={{ color: 'var(--fg-muted)' }}>#</th>
              {columns.map((col: any, i: number) => (
                <th key={i} className="px-2 py-1.5 text-left text-[9px] uppercase tracking-wider" style={{ color: 'var(--fg-muted)' }}>
                  {col.name}
                  <span className="ml-1 text-[8px]" style={{ color: 'var(--fg-dim)' }}>({col.type})</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row: any, ri: number) => (
              <tr key={ri} className="border-t hover:brightness-110" style={{ borderColor: 'var(--border)' }}>
                <td className="px-2 py-1 text-[9px]" style={{ color: 'var(--fg-dim)' }}>{(page - 1) * 100 + ri + 1}</td>
                {columns.map((col: any, ci: number) => (
                  <td key={ci} className="px-2 py-1 truncate max-w-[200px]" style={{ color: 'var(--fg-secondary)' }}>
                    {row[col.name] !== null ? (
                      <span className={row[col.name]?.toString().startsWith('http') ? 'text-blue-400 underline' : ''}>
                        {row[col.name]}
                      </span>
                    ) : (
                      <span style={{ color: 'var(--fg-dim)' }}>NULL</span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>

      </div>
      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-1">
          <button onClick={() => {
            const newPage = Math.max(1, page - 1)
            loadTableData(selectedTable, newPage)
          }} disabled={page <= 1}
            className="px-2 py-1 text-[10px] rounded border disabled:opacity-30 cursor-pointer disabled:cursor-default"
            style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}>
            ‹ Prev
          </button>
          <span className="text-[10px] px-3" style={{ color: 'var(--fg-muted)' }}>
            {page} / {totalPages}
          </span>
          <button onClick={() => {
            const newPage = Math.min(totalPages, page + 1)
            loadTableData(selectedTable, newPage)
          }} disabled={page >= totalPages}
            className="px-2 py-1 text-[10px] rounded border disabled:opacity-30 cursor-pointer disabled:cursor-default"
            style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}>
            Next ›
          </button>
        </div>
      )}
    </div>
  )

  // ─── RENDER ──────────────────────────────────────────────────
  return (
    <div className="flex h-full">
      {/* Sidebar: Connection list + DB tree */}
      {!showConnectionForm && (
        <div className="w-56 shrink-0 border-r flex flex-col" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--bg-sidebar)' }}>
          <div className="p-3 border-b flex items-center justify-between" style={{ borderColor: 'var(--border)' }}>
            <h3 className="text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--fg-muted)' }}>Kết nối</h3>
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
              <p className="text-[10px] italic text-center py-4" style={{ color: 'var(--fg-dim)' }}>Chưa có kết nối</p>
            )}
            {connections.map((conn) => {
              const isConnected = connectedDb === conn.id
              const isSelected = connectedDb === conn.id
              return (
                <div key={conn.id}>
                  <button onClick={() => isConnected ? disconnect() : connectToDb(conn.id || '')}
                    className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-[10px] transition-all border-0 cursor-pointer text-left ${
                      isSelected ? 'bg-emerald-500/15 text-emerald-500' : 'hover:bg-black/5 dark:hover:bg-white/5'
                    }`}
                    style={{ color: isSelected ? undefined : 'var(--fg-secondary)' }}>
                    <span className={`w-2 h-2 rounded-full shrink-0 ${isConnected ? 'bg-emerald-400' : ''}`}
                      style={{ backgroundColor: isConnected ? undefined : 'var(--fg-dim)' }} />
                    <span className="truncate flex-1">{conn.name}</span>
                    <span className={`text-[8px] px-1 py-0.5 rounded ${
                      conn.type === 'postgresql' ? 'bg-blue-500/10 text-blue-400' : 'bg-orange-500/10 text-orange-400'
                    }`}>
                      {conn.type === 'postgresql' ? 'PG' : 'MY'}
                    </span>
                  </button>
                  {/* Database tree when connected */}
                  {isConnected && databases.length > 0 && (
                    <div className="ml-3 mt-1 space-y-0.5 pl-2 border-l" style={{ borderColor: 'var(--border)' }}>
                      {databases.map(db => (
                        <div key={db}>
                          <button onClick={() => setSelectedDb(db)}
                            className={`w-full text-left px-2 py-0.5 text-[9px] font-mono rounded transition-colors border-0 cursor-pointer ${
                              selectedDb === db ? 'bg-emerald-500/10 text-emerald-500' : 'hover:bg-black/5 dark:hover:bg-white/5'
                            }`}
                            style={{ color: selectedDb === db ? undefined : 'var(--fg-muted)' }}>
                            🗄️ {db}
                          </button>
                          {/* Tables under selected DB */}
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
                                  className={`w-full text-left px-2 py-0.5 text-[9px] font-mono rounded transition-colors border-0 cursor-pointer flex items-center gap-1 ${
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
                className="w-full px-2 py-1.5 text-[9px] font-semibold rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors border-0 cursor-pointer">
                ✕ Ngắt kết nối
              </button>
            </div>
          )}
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        {showConnectionForm ? (
          <div className="flex-1 overflow-y-auto p-6 max-w-2xl mx-auto w-full">
            <h2 className="text-sm font-semibold mb-4" style={{ color: 'var(--fg)' }}>Thêm kết nối database</h2>
            <div className="space-y-4">
              <div>
                <label className="text-[10px] font-medium block mb-1" style={{ color: 'var(--fg-muted)' }}>Tên kết nối</label>
                <input type="text" value={editConn.name} onChange={e => setEditConn(p => ({ ...p, name: e.target.value }))}
                  className="w-full border rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--fg)' }}
                  placeholder="My Database" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-[10px] font-medium block mb-1" style={{ color: 'var(--fg-muted)' }}>Loại</label>
                  <select value={editConn.type} onChange={e => {
                    const isPg = e.target.value === 'postgresql'
                    setEditConn(p => ({ ...p, type: e.target.value as any, port: isPg ? 5432 : 3306 }))
                  }}
                    className="w-full border rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-emerald-500 cursor-pointer"
                    style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--fg)' }}>
                    <option value="postgresql">PostgreSQL</option>
                    <option value="mysql">MySQL / MariaDB</option>
                  </select>
                </div>
                <div>
                  <label className="text-[10px] font-medium block mb-1" style={{ color: 'var(--fg-muted)' }}>Host</label>
                  <input type="text" value={editConn.host} onChange={e => setEditConn(p => ({ ...p, host: e.target.value }))}
                    className="w-full border rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--fg)' }} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-[10px] font-medium block mb-1" style={{ color: 'var(--fg-muted)' }}>Port</label>
                  <input type="number" value={editConn.port} onChange={e => setEditConn(p => ({ ...p, port: parseInt(e.target.value) || 5432 }))}
                    className="w-full border rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--fg)' }} />
                </div>
                <div>
                  <label className="text-[10px] font-medium block mb-1" style={{ color: 'var(--fg-muted)' }}>Database</label>
                  <input type="text" value={editConn.database} onChange={e => setEditConn(p => ({ ...p, database: e.target.value }))}
                    className="w-full border rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--fg)' }} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-[10px] font-medium block mb-1" style={{ color: 'var(--fg-muted)' }}>User</label>
                  <input type="text" value={editConn.user} onChange={e => setEditConn(p => ({ ...p, user: e.target.value }))}
                    className="w-full border rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--fg)' }} />
                </div>
                <div>
                  <label className="text-[10px] font-medium block mb-1" style={{ color: 'var(--fg-muted)' }}>Password</label>
                  <input type="password" value={editConn.password} onChange={e => setEditConn(p => ({ ...p, password: e.target.value }))}
                    className="w-full border rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--fg)' }} />
                </div>
              </div>
              <div className="flex gap-2 justify-end pt-2">
                <button onClick={() => setShowConnectionForm(false)}
                  className="px-3 py-1.5 text-[11px] font-medium border rounded-lg transition-colors"
                  style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}>
                  Hủy
                </button>
                <button onClick={testAndSaveConnection} disabled={testing}
                  className="px-4 py-1.5 text-[11px] font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-colors disabled:opacity-50 flex items-center gap-1.5">
                  {testing && <div className="animate-spin rounded-full h-3 w-3 border-b border-white" />}
                  {testing ? 'Đang kết nối...' : 'Kiểm tra & Lưu'}
                </button>
              </div>
            </div>
          </div>
        ) : connectedDb ? (
          <div className="flex-1 flex flex-col min-w-0">
            {/* Toolbar */}
            <div className="shrink-0 flex items-center justify-between px-4 py-2 border-b" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--bg-header)' }}>
              <div className="flex items-center gap-2">
                <button onClick={() => setActiveView('browse')}
                  className={`px-2.5 py-1 text-[10px] font-medium rounded-md transition-all border-0 cursor-pointer ${
                    activeView === 'browse' ? 'bg-emerald-500/15 text-emerald-500' : 'hover:bg-black/5 dark:hover:bg-white/5'
                  }`}
                  style={{ color: activeView === 'browse' ? undefined : 'var(--fg-secondary)' }}>
                  📋 Duyệt dữ liệu
                </button>
                <button onClick={() => setActiveView('query')}
                  className={`px-2.5 py-1 text-[10px] font-medium rounded-md transition-all border-0 cursor-pointer ${
                    activeView === 'query' ? 'bg-emerald-500/15 text-emerald-500' : 'hover:bg-black/5 dark:hover:bg-white/5'
                  }`}
                  style={{ color: activeView === 'query' ? undefined : 'var(--fg-secondary)' }}>
                  💻 SQL Query
                </button>
                {connectedInfo && (
                  <span className="text-[9px] px-2 py-0.5 rounded font-mono" style={{ backgroundColor: 'var(--input-bg)', color: 'var(--fg-dim)' }}>
                    {connectedInfo.connection?.type?.toUpperCase() || ''} {connectedInfo.version || ''}
                  </span>
                )}
              </div>
              {loading && (
                <div className="animate-spin rounded-full h-3.5 w-3.5 border-b border-emerald-500" />
              )}
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-4">
              {activeView === 'browse' && (
                <div className="space-y-4">
                  {selectedTable && tableData ? (
                    renderTable(tableData.columns, tableData.rows, tableData.total_rows, tableData.total_pages)
                  ) : !selectedTable ? (
                    <div className="flex flex-col items-center justify-center py-12">
                      <svg className="w-12 h-12 mb-3 opacity-20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
                      </svg>
                      <p className="text-sm font-medium" style={{ color: 'var(--fg-secondary)' }}>Chọn một table để xem dữ liệu</p>
                      <p className="text-[10px] mt-1" style={{ color: 'var(--fg-dim)' }}>Click vào table name ở sidebar trái</p>
                    </div>
                  ) : (
                    <div className="flex items-center justify-center py-12">
                      <div className="animate-spin rounded-full h-5 w-5 border-b border-emerald-500" />
                    </div>
                  )}
                </div>
              )}

              {activeView === 'query' && (
                <div className="space-y-3">
                  <div className="relative">
                    <textarea value={customQuery} onChange={e => setCustomQuery(e.target.value)}
                      rows={4} placeholder="SELECT * FROM users LIMIT 10;"
                      className="w-full border rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-emerald-500"
                      style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--fg)' }} />
                    <button onClick={runCustomQuery} disabled={loading || !customQuery.trim()}
                      className="absolute bottom-2 right-2 px-3 py-1 text-[10px] font-semibold bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg disabled:opacity-50 transition-colors border-0 cursor-pointer flex items-center gap-1">
                      {loading && <div className="animate-spin rounded-full h-2.5 w-2.5 border-b border-white" />}
                      ▶ Chạy
                    </button>
                  </div>

                  {queryError && (
                    <div className="px-3 py-2 rounded-lg text-[10px] font-mono bg-red-500/10 text-red-400 border border-red-500/20">
                      {queryError}
                    </div>
                  )}

                  {queryResult && queryResult.columns && (
                    <div>
                      <div className="text-[10px] mb-2" style={{ color: 'var(--fg-dim)' }}>
                        {queryResult.row_count} rows returned
                        {queryResult.affected_rows !== undefined && queryResult.affected_rows >= 0 && (
                          <span> | {queryResult.affected_rows} rows affected</span>
                        )}
                      </div>
                      {renderTable(queryResult.columns, queryResult.rows, queryResult.row_count, 1)}
                    </div>
                  )}

                  {queryResult && !queryResult.columns && queryResult.affected_rows !== undefined && (
                    <div className="px-3 py-2 rounded-lg text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                      ✅ Query executed. {queryResult.affected_rows} rows affected.
                    </div>
                  )}
                </div>
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

            {/* Quick connect to detected local databases */}
            {localDbs.length > 0 && (
              <div className="mb-6 text-center">
                <p className="text-[10px] font-medium mb-2" style={{ color: 'var(--fg-muted)' }}>🔍 Phát hiện database local</p>
                <div className="flex flex-wrap justify-center gap-2">
                  {localDbs.map((db, i) => (
                    <button key={i} onClick={() => quickConnect(db)} disabled={testing}
                      className={`px-4 py-2 text-[11px] font-semibold rounded-lg transition-all border-0 cursor-pointer flex items-center gap-1.5 ${
                        db.type === 'postgresql'
                          ? 'bg-blue-600 hover:bg-blue-500 text-white'
                          : 'bg-orange-600 hover:bg-orange-500 text-white'
                      }`}>
                      {db.type === 'postgresql' ? '🐘' : '🐬'} {db.name}
                      <span className="opacity-70 text-[9px]">→ 1-click</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {scanningLocal && (
              <div className="flex items-center gap-2 mb-4 text-[10px]" style={{ color: 'var(--fg-dim)' }}>
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
                className="px-3 py-2 text-[11px] font-semibold rounded-lg transition-colors border cursor-pointer"
                style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}>
                🔍 Quét lại
              </button>
              {connections.length > 0 && connections.map(conn => (
                <button key={conn.id} onClick={() => connectToDb(conn.id || '')}
                  className={`px-3 py-2 text-[11px] font-semibold rounded-lg transition-colors border cursor-pointer ${
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
