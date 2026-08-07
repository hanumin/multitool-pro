import { useCallback } from 'react'

interface DataTableProps {
  columns: any[]
  rows: any[]
  totalRows: number
  totalPages: number
  page: number
  onPageChange: (page: number) => void
  selectedTable?: string
  selectedDb?: string
  selectedSchema?: string
  onExportCSV?: () => void
  onExportJSON?: () => void
  renderTopRight?: React.ReactNode
}

// WHY: Reusable data table component — columns + rows tu API response.
// Phan trang server-side (onPageChange goi parent fetch API).
// Export buttons (CSV/JSON) chi hien neu onExport callback duoc truyen.
export default function DataTable({
  columns, rows, totalRows, totalPages, page, onPageChange,
  selectedTable, selectedDb, selectedSchema, onExportCSV, onExportJSON, renderTopRight
}: DataTableProps) {
  // WHY: Export button sub-component — useCallback de tranh re-render khong can thiet.
  // Icon download + format text, onClick tu parent (CSV hoac JSON).
  const ExportBtn = useCallback(({ format, onClick }: { format: string; onClick?: () => void }) => (
    <button onClick={onClick}
      className="px-2 py-1 text-[10px] font-semibold rounded border transition-all active:scale-95 cursor-pointer flex items-center gap-1"
      style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}>
      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
      </svg>
      {format}
    </button>
  ), [])

  return (
    <div className="space-y-2">
      {/* Top bar */}
      <div className="flex items-center justify-between text-xs" style={{ color: 'var(--fg-dim)' }}>
        <div className="flex items-center gap-2">
          <span>{totalRows.toLocaleString()} rows</span>
          {selectedTable && selectedDb && selectedSchema && (
            <span className="text-[10px] font-mono text-emerald-500">
              {selectedDb}.{selectedSchema}.{selectedTable}
            </span>
          )}
        </div>
        <span>Page {page} of {totalPages}</span>
      </div>

      {/* Export toolbar */}
      {(onExportCSV || onExportJSON || renderTopRight) && (
        <div className="flex items-center justify-between mb-1">
          <div />
          <div className="flex gap-1.5">
            {onExportCSV && <ExportBtn format="CSV" onClick={onExportCSV} />}
            {onExportJSON && <ExportBtn format="JSON" onClick={onExportJSON} />}
            {renderTopRight}
          </div>
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto border rounded-lg" style={{ borderColor: 'var(--border)' }}>
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="border-b" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--input-bg)' }}>
              <th className="px-2 py-1.5 text-left text-[10px] uppercase tracking-wider" style={{ color: 'var(--fg-muted)' }}>#</th>
              {columns.map((col: any, i: number) => (
                <th key={i} className="px-2 py-1.5 text-left text-[10px] uppercase tracking-wider" style={{ color: 'var(--fg-muted)' }}>
                  {col.name}
                  <span className="ml-1 text-[8px]" style={{ color: 'var(--fg-dim)' }}>({col.type})</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody key={page}>
            {rows.map((row: any, ri: number) => (
              <tr key={ri} className="border-t hover:brightness-110 animate-row-enter" style={{ borderColor: 'var(--border)', animationDelay: `${ri * 0.03}s` }}>
                <td className="px-2 py-1 text-[10px]" style={{ color: 'var(--fg-dim)' }}>{(page - 1) * 100 + ri + 1}</td>
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
          <button onClick={() => onPageChange(Math.max(1, page - 1))} disabled={page <= 1}
            className="px-2 py-1 text-xs rounded border disabled:opacity-30 cursor-pointer disabled:cursor-default"
            style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}>
            ‹ Prev
          </button>
          <span className="text-xs px-3" style={{ color: 'var(--fg-muted)' }}>
            {page} / {totalPages}
          </span>
          <button onClick={() => onPageChange(Math.min(totalPages, page + 1))} disabled={page >= totalPages}
            className="px-2 py-1 text-xs rounded border disabled:opacity-30 cursor-pointer disabled:cursor-default"
            style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}>
            Next ›
          </button>
        </div>
      )}
    </div>
  )
}
