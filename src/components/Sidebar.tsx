import { ModuleId, PLATFORM_MODULES, ModuleDef } from '../types'

interface SidebarProps {
  activeModule: ModuleId
  onModuleChange: (id: ModuleId) => void
  collapsed: boolean
  onToggleCollapse: () => void
  statusText: string
  appVersion?: string
}

// WHY: Collapsed = 56px (chỉ icon), expanded = 220px (icon + label + description).
// Dùng --bg-sidebar CSS variable để theme-aware (dark sidebar riêng biệt với main bg).
export default function Sidebar({ activeModule, onModuleChange, collapsed, onToggleCollapse, statusText, appVersion }: SidebarProps) {
  return (
    <aside
      className="flex flex-col border-r shrink-0 select-none"
      style={{
        width: collapsed ? 56 : 220,
        background: 'var(--bg-sidebar)',
        borderColor: 'var(--border)',
        transition: 'width 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
      }}
    >
      {/* Logo area */}
      <div
        className="flex items-center gap-2.5 px-3 py-3 border-b shrink-0"
        style={{ borderColor: 'var(--border)' }}
      >
        <div className="sidebar-logo w-7 h-7 rounded-lg bg-gradient-to-br from-emerald-400 to-emerald-600 flex items-center justify-center shadow-lg shadow-emerald-500/20 shrink-0">
          <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M12 5l7 7-7 7" />
          </svg>
        </div>
        {!collapsed && (
          <div className="sidebar-expand-content min-w-0">
            <h1 className="text-sm font-semibold tracking-tight truncate" style={{ color: 'var(--fg)' }}>
              Bảng điều khiển
            </h1>
            <p className="text-xs truncate" style={{ color: 'var(--fg-muted)' }}>{appVersion ? `v${appVersion}` : ''}</p>
          </div>
        )}
      </div>

      {/* WHY: Chỉ hiển thị module khả dụng trên nền tảng hiện tại (PLATFORM_MODULES) —
          trên Mac sẽ tự ẩn Máy in/Âm thanh/Tunnel (Windows-only). */}
      <nav className="flex-1 px-2 py-3 space-y-1 overflow-y-auto">
        {PLATFORM_MODULES.map((mod: ModuleDef, idx: number) => {
          const isActive = activeModule === mod.id
          return (
            <button
              key={mod.id}
              onClick={() => onModuleChange(mod.id)}
              className={`sidebar-item w-full flex items-center gap-2.5 px-3 py-2 rounded-lg transition-all cursor-pointer border-0 text-left ${
                isActive
                  ? 'bg-emerald-500/15 text-emerald-500 shadow-sm shadow-emerald-500/10 sidebar-item-active'
                  : 'hover:bg-black/5 dark:hover:bg-white/5'
              }`}
              style={{
                color: isActive ? undefined : 'var(--fg-secondary)',
              }}
              title={collapsed ? mod.label : undefined}
            >
              <span className="sidebar-icon text-lg shrink-0">{mod.icon}</span>
              {!collapsed && (
                <div className="sidebar-expand-content min-w-0 flex-1" style={{ animationDelay: `${idx * 0.04}s` }}>
                  <div className={`sidebar-label text-xs truncate transition-all ${isActive ? 'font-bold text-emerald-500 tracking-wide scale-[1.02] origin-left' : 'font-medium'}`}>
                    {mod.label}
                  </div>
                  <div className="sidebar-label text-[11px] truncate" style={{ color: isActive ? 'var(--fg-secondary)' : 'var(--fg-dim)' }}>
                    {mod.description}
                  </div>
                </div>
              )}
              {isActive && !collapsed && (
                <div className="sidebar-active-bar w-1 h-4 rounded-full bg-emerald-500 shrink-0" />
              )}
            </button>
          )
        })}
      </nav>

      {/* Status & Collapse Toggle Footer at bottom — Yêu cầu 3 */}
      <div className="border-t shrink-0 p-2 flex flex-col gap-1.5" style={{ borderColor: 'var(--border)' }}>
        {!collapsed && statusText && (
          <div className="sidebar-expand-content px-1.5 py-0.5 text-xs truncate" style={{ color: 'var(--fg-dim)' }}>
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500/70 animate-dot-pulse shrink-0" key={`dot-${statusText}`} />
              <span className="truncate animate-status-in" key={statusText}>{statusText}</span>
            </div>
          </div>
        )}
        <button
          onClick={onToggleCollapse}
          className={`w-full flex items-center justify-center gap-2 py-2 px-2 rounded-lg text-xs font-medium transition-all cursor-pointer border-0 ${
            collapsed
              ? 'hover:bg-emerald-500/15 text-emerald-400 bg-emerald-500/10'
              : 'hover:bg-black/5 dark:hover:bg-white/5 text-slate-400 hover:text-slate-200'
          }`}
          title={collapsed ? 'Mở rộng thanh menu' : 'Thu gọn thanh menu'}
        >
          <svg
            className="transition-transform duration-300"
            style={{ transform: collapsed ? 'rotate(180deg)' : 'rotate(0deg)' }}
            width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
          </svg>
          {!collapsed && <span>Thu gọn thanh menu</span>}
        </button>
      </div>
    </aside>
  )
}
