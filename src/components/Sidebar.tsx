import { ModuleId, MODULES, ModuleDef } from '../types'

interface SidebarProps {
  activeModule: ModuleId
  onModuleChange: (id: ModuleId) => void
  collapsed: boolean
  onToggleCollapse: () => void
  statusText: string
}

export default function Sidebar({ activeModule, onModuleChange, collapsed, onToggleCollapse, statusText }: SidebarProps) {
  return (
    <aside
      className="flex flex-col border-r shrink-0 transition-all duration-300 select-none"
      style={{
        width: collapsed ? 56 : 200,
        background: 'var(--bg-sidebar)',
        borderColor: 'var(--border)',
      }}
    >
      {/* Logo area */}
      <div
        className="flex items-center gap-2.5 px-3 py-3 border-b shrink-0"
        style={{ borderColor: 'var(--border)' }}
      >
        <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-emerald-400 to-emerald-600 flex items-center justify-center shadow-lg shadow-emerald-500/20 shrink-0">
          <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M12 5l7 7-7 7" />
          </svg>
        </div>
        {!collapsed && (
          <div className="min-w-0">
            <h1 className="text-sm font-semibold tracking-tight truncate" style={{ color: 'var(--fg)' }}>
              Bảng điều khiển
            </h1>
            <p className="text-[9px] truncate" style={{ color: 'var(--fg-muted)' }}>v1.5.0</p>
          </div>
        )}
        {/* Toggle collapse button */}
        <button
          onClick={onToggleCollapse}
          className="ml-auto p-1 rounded-md hover:bg-black/10 dark:hover:bg-white/10 transition-colors shrink-0"
          style={{ color: 'var(--fg-dim)' }}
          title={collapsed ? 'Mở rộng' : 'Thu gọn'}
        >
          <svg
            className="w-3.5 h-3.5 transition-transform duration-200"
            style={{ transform: collapsed ? 'rotate(180deg)' : 'none' }}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
          </svg>
        </button>
      </div>

      {/* Navigation items */}
      <nav className="flex-1 px-2 py-3 space-y-1 overflow-y-auto">
        {MODULES.map((mod: ModuleDef) => {
          const isActive = activeModule === mod.id
          return (
            <button
              key={mod.id}
              onClick={() => onModuleChange(mod.id)}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg transition-all duration-150 cursor-pointer border-0 text-left ${
                isActive
                  ? 'bg-emerald-500/15 text-emerald-500 shadow-sm shadow-emerald-500/10'
                  : 'hover:bg-black/5 dark:hover:bg-white/5'
              }`}
              style={{
                color: isActive ? undefined : 'var(--fg-secondary)',
              }}
              title={collapsed ? mod.label : undefined}
            >
              <span className="text-lg shrink-0">{mod.icon}</span>
              {!collapsed && (
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium truncate">{mod.label}</div>
                  <div className="text-[9px] truncate" style={{ color: 'var(--fg-dim)' }}>
                    {mod.description}
                  </div>
                </div>
              )}
              {isActive && !collapsed && (
                <div className="w-1 h-4 rounded-full bg-emerald-500 shrink-0" />
              )}
            </button>
          )
        })}
      </nav>

      {/* Status footer */}
      {!collapsed && (
        <div
          className="px-3 py-2 border-t text-[10px] shrink-0"
          style={{ borderColor: 'var(--border)', color: 'var(--fg-dim)' }}
        >
          <div className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500/70" />
            <span className="truncate">{statusText}</span>
          </div>
        </div>
      )}
    </aside>
  )
}
