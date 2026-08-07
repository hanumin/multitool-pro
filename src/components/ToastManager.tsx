import { createContext, useContext, useState, useCallback, useRef, type ReactNode } from 'react'

export type ToastType = 'success' | 'error' | 'info' | 'warning'

export interface Toast {
  id: number
  type: ToastType
  title: string
  message?: string
  duration?: number
  exiting?: boolean
}

interface ToastContextValue {
  toasts: Toast[]
  addToast: (toast: Omit<Toast, 'id'>) => void
  removeToast: (id: number) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within ToastProvider')
  return ctx
}

// WHY: Toast notification system với auto-dismiss và exit animation.
// Dùng context để bất kỳ component nào cũng có thể gọi addToast().
// Mỗi toast có type (success/error/info/warning), title, message, duration.
// Auto-dismiss sau duration ms + exit animation 300ms trước khi xóa khỏi DOM.
export default function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(0)

  // WHY: Xóa toast — đánh dấu `exiting` để chạy exit animation 300ms trước khi
  // thật sự gỡ khỏi DOM (tránh nhảy hình).
  const removeToast = useCallback((id: number) => {
    setToasts(prev => prev.map(t => t.id === id ? { ...t, exiting: true } : t))
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id))
    }, 300)
  }, [])

  // WHY: Thêm toast mới — id tăng dần qua ref (không phụ thuộc state cũ), tự
  // dismiss sau `duration` ms (mặc định 4000).
  const addToast = useCallback((toast: Omit<Toast, 'id'>) => {
    const id = nextId.current++
    const duration = toast.duration ?? 4000
    setToasts(prev => [...prev, { ...toast, id }])
    if (duration > 0) {
      setTimeout(() => removeToast(id), duration)
    }
  }, [removeToast])

  const ICONS: Record<ToastType, string> = {
    success: '✅',
    error: '❌',
    info: 'ℹ️',
    warning: '⚠️',
  }

  const COLORS: Record<ToastType, { border: string; bg: string; iconBg: string }> = {
    success: { border: 'rgba(34,197,94,0.3)', bg: 'rgba(34,197,94,0.08)', iconBg: 'rgba(34,197,94,0.15)' },
    error:   { border: 'rgba(239,68,68,0.3)', bg: 'rgba(239,68,68,0.08)', iconBg: 'rgba(239,68,68,0.15)' },
    info:    { border: 'rgba(59,130,246,0.3)', bg: 'rgba(59,130,246,0.08)', iconBg: 'rgba(59,130,246,0.15)' },
    warning: { border: 'rgba(234,179,8,0.3)', bg: 'rgba(234,179,8,0.08)', iconBg: 'rgba(234,179,8,0.15)' },
  }

  return (
    <ToastContext.Provider value={{ toasts, addToast, removeToast }}>
      {children}

      {/* Toast container — fixed bottom-right, above everything */}
      <div className="fixed bottom-4 right-4 z-[99999] flex flex-col gap-2 pointer-events-none">
        {toasts.map(toast => {
          const c = COLORS[toast.type]
          return (
            <div key={toast.id}
              className={`pointer-events-auto max-w-sm w-[340px] rounded-xl border shadow-2xl backdrop-blur-xl transition-all duration-300 ${
                toast.exiting ? 'animate-toast-exit' : 'animate-toast-enter'
              }`}
              style={{
                backgroundColor: c.bg,
                borderColor: c.border,
                backdropFilter: 'blur(16px)',
              }}>
              <div className="flex items-start gap-2.5 p-3">
                {/* Icon */}
                <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 text-sm"
                  style={{ backgroundColor: c.iconBg }}>
                  {ICONS[toast.type]}
                </div>
                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-semibold" style={{ color: '#f1f5f9' }}>{toast.title}</div>
                  {toast.message && (
                    <div className="text-[11px] mt-0.5 leading-relaxed" style={{ color: 'rgba(148,163,184,0.9)' }}>
                      {toast.message}
                    </div>
                  )}
                </div>
                {/* Close button */}
                <button onClick={() => removeToast(toast.id)}
                  className="p-0.5 rounded-md hover:bg-white/10 transition-colors cursor-pointer border-0 shrink-0 mt-0.5"
                  style={{ color: 'rgba(148,163,184,0.5)' }}>
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              {/* Progress bar — đếm ngược thời gian tồn tại */}
              {toast.duration && toast.duration > 0 && !toast.exiting && (
                <div className="h-0.5 rounded-full mx-3 mb-2 overflow-hidden" style={{ backgroundColor: 'rgba(255,255,255,0.06)' }}>
                  <div className="h-full rounded-full animate-toast-timer origin-left"
                    style={{
                      backgroundColor: c.border.replace('0.3', '0.6'),
                      animationDuration: `${toast.duration}ms`,
                    }} />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </ToastContext.Provider>
  )
}
