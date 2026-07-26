import { useState, lazy, Suspense } from 'react'
import { downloadBlobFromResponse } from '../../../utils/downloadBlob'

const CodeEditor = lazy(() => import('@uiw/react-textarea-code-editor'))
const DataTable = lazy(() => import('./DataTable'))

import { API, fetchWithRetry } from '../../../utils/apiFetch'

interface SqlQueryViewProps {
  connectedDb: string | null
  selectedDb: string
  selectedSchema: string
  theme: 'dark' | 'light'
  setStatusText: (t: string) => void
}

// WHY: SQL editor component — dung @uiw/react-textarea-code-editor cho syntax highlighting.
// Ket qua query hien thi trong DataTable (reuse).
// Ctrl+Enter shortcut de chay query (handleKeyDown).
export default function SqlQueryView({ connectedDb, selectedDb, selectedSchema, theme, setStatusText }: SqlQueryViewProps) {
  const [customQuery, setCustomQuery] = useState('')
  const [queryResult, setQueryResult] = useState<any>(null)
  const [queryError, setQueryError] = useState('')
  const [loading, setLoading] = useState(false)
  const [lastExportQuery, setLastExportQuery] = useState('')

  // WHY: Export query result — dung lai API /api/database/export backend.
  // Tao filename tu format (csv/json), download ve may.
  const exportQueryResult = async (format: 'csv' | 'json') => {
    if (!connectedDb || !queryResult?.columns?.length) { setStatusText('No query results to export'); return }
    try {
      const q = customQuery || lastExportQuery
      setStatusText(`Exporting query results as ${format.toUpperCase()}...`)
      const res = await fetchWithRetry(`${API}/api/database/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId: connectedDb, database: selectedDb, query: q, format })
      })
      if (!res.ok) { const err = await res.json(); setStatusText(`❌ ${err.error}`); return }
      const filename = await downloadBlobFromResponse(res, `query_result.${format}`)
      setStatusText(`✅ Exported ${filename}`)
    } catch (e: any) { setStatusText(`❌ ${e.message}`) }
  }

  // WHY: Goi API /api/database/query — hien thi ket qua trong DataTable.
  // Xu ly ca SELECT (columns + rows) va INSERT/UPDATE (affected_rows).
  const runCustomQuery = async () => {
    if (!customQuery.trim()) return
    setLoading(true)
    setQueryError('')
    setQueryResult(null)
    try {
      const res = await fetchWithRetry(`${API}/api/database/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId: connectedDb, database: selectedDb, query: customQuery })
      })
      const data = await res.json()
      if (data.success !== false) {
        setQueryResult(data)
        setLastExportQuery(customQuery)
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

  // WHY: Ctrl+Enter (hoac Cmd+Enter macOS) de chay query nhanh.
  // Ngan preventDefault de tranh them newline khi nhan Enter voi modifier.
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      runCustomQuery()
    }
  }

  return (
    <div className="space-y-3">
      {/* SQL Editor */}
      <div className="relative border rounded-lg" style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--input-border)' }}>
        <Suspense fallback={
          <div className="flex items-center justify-center py-8">
            <div className="flex items-center gap-2">
              <div className="animate-spin rounded-full h-4 w-4 border-b border-emerald-500" />
              <span className="text-xs" style={{ color: 'var(--fg-dim)' }}>Loading editor...</span>
            </div>
          </div>
        }>
          <CodeEditor
            id="db-sql-editor"
            value={customQuery}
            language="sql"
            placeholder="SELECT * FROM users LIMIT 10;"
            onChange={(evn) => setCustomQuery(evn.target.value)}
            onKeyDown={handleKeyDown}
            padding={12}
            minHeight={96}
            className="!text-xs !font-mono focus:outline-none"
            style={{
              fontSize: 12,
              fontFamily: 'ui-monospace,SFMono-Regular,SF Mono,Consolas,Liberation Mono,Menlo,monospace',
              backgroundColor: 'var(--input-bg)',
              '--color': 'var(--fg)',
              '--placeholder': 'var(--fg-dim)',
              '--selection': 'rgba(16,185,129,0.3)',
              '--punctuation': 'var(--fg-muted)',
              '--keyword': '#22c55e',
              '--string': '#f59e0b',
              '--number': '#a855f7',
              '--function': '#3b82f6',
              '--comment': '#6b7280',
            } as any}
          />
        </Suspense>
        <button onClick={runCustomQuery} disabled={loading || !customQuery.trim()}
          className="absolute bottom-2 right-2 px-3 py-1 text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg disabled:opacity-50 transition-colors border-0 cursor-pointer flex items-center gap-1">
          {loading && <div className="animate-spin rounded-full h-2.5 w-2.5 border-b border-white" />}
          ▶ Chạy
          <span className="opacity-50 text-[8px] ml-0.5">Ctrl+Enter</span>
        </button>
      </div>

      {/* Error */}
      {queryError && (
        <div className="px-3 py-2 rounded-lg text-xs font-mono bg-red-500/10 text-red-400 border border-red-500/20">
          {queryError}
        </div>
      )}

      {/* Result table */}
      {queryResult && queryResult.columns && (
        <Suspense fallback={<div className="flex items-center justify-center py-4"><div className="animate-spin rounded-full h-4 w-4 border-b border-emerald-500" /></div>}>
          <DataTable
            columns={queryResult.columns}
            rows={queryResult.rows}
            totalRows={queryResult.row_count}
            totalPages={1}
            page={1}
            onPageChange={() => {}}
            onExportCSV={() => exportQueryResult('csv')}
            onExportJSON={() => exportQueryResult('json')}
            renderTopRight={
              queryResult.affected_rows !== undefined && (
                <span className="text-xs text-emerald-400 flex items-center">
                  {queryResult.affected_rows} rows affected
                </span>
              )
            }
          />
        </Suspense>
      )}

      {/* Success non-query */}
      {queryResult && !queryResult.columns && queryResult.affected_rows !== undefined && (
        <div className="px-3 py-2 rounded-lg text-xs bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
          ✅ Query executed. {queryResult.affected_rows} rows affected.
        </div>
      )}
    </div>
  )
}
