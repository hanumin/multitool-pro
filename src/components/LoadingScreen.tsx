import { useEffect, useState, useRef } from 'react'
import { API, fetchWithRetry } from '../utils/apiFetch'
import type { PreloadedData } from '../types'

interface PreloadStep {
  id: string
  label: string
  icon: string
  progress: number
  status: 'waiting' | 'loading' | 'done' | 'error'
}

interface Props {
  onComplete: (data: PreloadedData) => void
}

// WHY: Mỗi step tương ứng với 1 module, có API endpoint riêng để preload dữ liệu thật.
// progress: 0 = chưa làm, 100 = hoàn thành (dùng để hiển thị progress bar mượt).
// status: waiting → loading → done | error
interface ModuleApi {
  id: string
  label: string
  icon: string
  fetch: () => Promise<FetchResult>
}

// WHY: Định nghĩa API endpoints cho từng module. Các API này được gọi SONG SONG
// khi LoadingScreen chạy, để warm backend cache + lấy dữ liệu khởi tạo.
// Mỗi API được gọi với timeout 8s để tránh loading screen kéo dài vô hạn.
// Mỗi fetch trả về { response, data } để LoadingScreen collect dữ liệu và
// truyền xuống App → từng module, giúp module render ngay không cần chờ fetch đầu tiên.
interface FetchResult {
  response: Response | null
  data: any
}

const MODULE_APIS: ModuleApi[] = [
  { id: 'connecting', label: 'Kết nối backend', icon: '🔌', fetch: async (): Promise<FetchResult> => {
    const r = await fetchWithRetry(`${API}/api/preload`, { signal: AbortSignal.timeout(6000) })
    const d = r.ok ? await r.json() : null
    return { response: r, data: d }
  }},
  { id: 'servers', label: 'Máy chủ', icon: '🖥️', fetch: async (): Promise<FetchResult> => {
    const r = await fetchWithRetry(`${API}/api/projects`, { signal: AbortSignal.timeout(8000) })
    const d = r.ok ? await r.json() : null
    return { response: r, data: d }
  }},
  { id: 'printers', label: 'Máy in', icon: '🖨️', fetch: async (): Promise<FetchResult> => {
    const [r1, r2] = await Promise.all([
      fetchWithRetry(`${API}/api/printers`, { signal: AbortSignal.timeout(8000) }),
      fetchWithRetry(`${API}/api/printer/settings`, { signal: AbortSignal.timeout(5000) }),
    ])
    const d1 = r1.ok ? await r1.json() : null
    const d2 = r2.ok ? await r2.json() : null
    return { response: r1, data: { printers: d1, printerSettings: d2 } }
  }},
  { id: 'audio', label: 'Âm thanh', icon: '🎤', fetch: async (): Promise<FetchResult> => {
    const r = await fetchWithRetry(`${API}/api/audio/devices`, { signal: AbortSignal.timeout(8000) })
    const d = r.ok ? await r.json() : null
    return { response: r, data: d }
  }},
  { id: 'file-copier', label: 'Sao chép tập tin', icon: '📋', fetch: async (): Promise<FetchResult> => {
    const r = await fetchWithRetry(`${API}/api/file-copier/count`, { 
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      signal: AbortSignal.timeout(5000) 
    })
    const d = r.ok ? await r.json() : null
    return { response: r, data: d }
  }},
  { id: 'database', label: 'Cơ sở dữ liệu', icon: '🗄️', fetch: async (): Promise<FetchResult> => {
    const r = await fetchWithRetry(`${API}/api/database/connections`, { signal: AbortSignal.timeout(5000) })
    const d = r.ok ? await r.json() : null
    return { response: r, data: d }
  }},
  { id: 'tunnels', label: 'Tunnel', icon: '🌐', fetch: async (): Promise<FetchResult> => {
    const r = await fetchWithRetry(`${API}/api/cloudflared/check`, { signal: AbortSignal.timeout(8000) })
    const d = r.ok ? await r.json() : null
    return { response: r, data: d }
  }},
  { id: 'logs', label: 'Nhật ký', icon: '📝', fetch: async (): Promise<FetchResult> => {
    const r = await fetchWithRetry(`${API}/api/debug-log`, { signal: AbortSignal.timeout(5000) })
    const d = r.ok ? await r.json() : null
    return { response: r, data: d }
  }},
  { id: 'ready', label: 'Sẵn sàng', icon: '✨', fetch: async (): Promise<FetchResult> => ({ response: null, data: null }) },
]

// WHY: Màn hình loading chuyên nghiệp khi khởi động app.
// Hiển thị tiến trình khởi tạo từng module với animation mượt mà.
// Gọi API THẬT cho từng module, không phải animation giả.
export default function LoadingScreen({ onComplete }: Props) {
  const [steps, setSteps] = useState<PreloadStep[]>(
    MODULE_APIS.map((m, i) => ({
      id: m.id, label: m.label, icon: m.icon,
      progress: i === 0 ? 15 : 0,
      status: i === 0 ? 'loading' : 'waiting' as const,
    }))
  )
  const [currentStepIdx, setCurrentStepIdx] = useState(0)
  const [overallProgress, setOverallProgress] = useState(1)
  const [fadeOut, setFadeOut] = useState(false)
  const [showTip, setShowTip] = useState('')
  const startedAt = useRef(Date.now())

  const TIPS = [
    '💡 Mẹo: Bạn có thể thu nhỏ app xuống khay hệ thống bằng nút — ở góc phải',
    '💡 Mẹo: Nhấn Ctrl+F để tìm kiếm nhanh trong log',
    '💡 Mẹo: Bật Polling nền để module tự động cập nhật ngay cả khi không mở',
    '💡 Mẹo: Click vào badge LỖI/CẢNH BÁO để lọc nhanh log',
    '💡 Mẹo: Dùng Tunnel để chia sẻ server local ra internet qua Cloudflare',
  ]

  // WHY: Collect dữ liệu preload từ các API response.
  // Dữ liệu này được truyền xuống từng module để skip initial fetch.
  const preloadedData = useRef<PreloadedData>({})

  // WHY: Update progress của một step mượt mà (dùng cho animation).
  // Gọi setInterval để tăng dần progress từ current → target.
  const animateProgress = (idx: number, target: number, duration = 200) => {
    return new Promise<void>(resolve => {
      const startTime = Date.now()
      const step = steps[idx]
      const startProgress = step?.progress ?? 0
      const range = target - startProgress
      if (range <= 0) { resolve(); return }
      
      const timer = setInterval(() => {
        const elapsed = Date.now() - startTime
        const pct = Math.min(elapsed / duration, 1)
        // Ease-out cubic
        const eased = 1 - Math.pow(1 - pct, 3)
        const current = Math.round(startProgress + range * eased)
        
        setSteps(prev => prev.map((s, i) => i === idx ? { ...s, progress: Math.min(current, target) } : s))
        
        // Update overall progress
        setOverallProgress(prev => {
          const stepsTotal = MODULE_APIS.length
          const stepValue = (current / 100) * (100 / stepsTotal)
          const baseValue = idx * (100 / stepsTotal)
          return Math.min(Math.round(baseValue + stepValue), 99)
        })
        
        if (pct >= 1) {
          clearInterval(timer)
          resolve()
        }
      }, 16)
    })
  }

  useEffect(() => {
    let cancelled = false

    const run = async () => {
      // WHY: Fire tất cả API calls song song ngay từ đầu.
      // Khi mỗi promise resolve, step tương ứng được đánh dấu hoàn thành.
      // Data từ mỗi API response được flatten và collect vào preloadedData.
      const promises = MODULE_APIS.map((mod, idx) => 
        (async () => {
          try {
            const result = await mod.fetch()
            if (cancelled) return
            // WHY: Flatten dữ liệu vào preloadedData với key chuẩn
            if (result?.data) {
              const flat: PreloadedData = { ...preloadedData.current }
              if (mod.id === 'printers') {
                flat.printers = (result.data as any).printers
                flat.printerSettings = (result.data as any).printerSettings
              } else if (mod.id === 'audio') {
                flat.audioDevices = result.data
              } else if (mod.id === 'tunnels') {
                flat.cloudflared = result.data
              } else if (mod.id === 'database') {
                // WHY: Backend trả về { connections: [...] }, cần extract array
                // để khớp với PreloadedData.databaseConnections: PreloadedDbConnection[]
                flat.databaseConnections = ((result.data as any)?.connections) || []
              } else if (mod.id === 'logs') {
                // WHY: Backend trả về { log: "..." }, cần transform thành { lines: [...] }
                // để khớp với PreloadedDebugLog interface.
                const logStr = (result.data as any)?.log || ''
                flat.debugLog = { lines: logStr.split('\n').filter((l: string) => l.trim()) }
              } else              if (mod.id === 'servers') {
                // WHY: Chỉ lấy projects từ /api/projects (servers step) để tránh race với /api/preload
                flat.projects = result.data as any
              } else if (mod.id === 'file-copier' || mod.id === 'connecting') {
                // WHY: Các module không có field riêng trong PreloadedData, bỏ qua
              } else {
                ;(flat as any)[mod.id] = result.data
              }
              preloadedData.current = flat
            }
            setSteps(prev => {
              if (prev[idx]?.status === 'done') return prev
              return prev.map((s, i) => i === idx ? { ...s, status: 'done' as const, progress: 100 } : s)
            })
          } catch (err: any) {
            if (cancelled) return
            setSteps(prev => {
              if (prev[idx]?.status === 'done') return prev
              return prev.map((s, i) => i === idx ? { ...s, status: 'error' as const, progress: 100 } : s)
            })
          }
        })()
      )

      // WHY: Chạy UI step-by-step animation song song với API calls.
      // Step 0: Kết nối backend (chờ ít nhất 400ms để UI visible)
      await animateProgress(0, 60, 300)
      await sleep(400)
      await animateProgress(0, 100, 200)
      setSteps(prev => prev.map((s, i) => i === 0 ? { ...s, status: 'done' as const, progress: 100 } : s))

      for (let i = 1; i < MODULE_APIS.length - 1; i++) {
        if (cancelled) return
        setCurrentStepIdx(i)
        setSteps(prev => prev.map((s, j) => j === i ? { ...s, status: 'loading' as const } : s))
        await animateProgress(i, 20, 150)

        // WHY: Chờ API của step này hoàn thành, nhưng tối đa 6s.
        // Nếu API đã xong trước đó (do fire song song), await resolve ngay.
        const stepPromise = promises[i]
        const timeout = sleep(6000).then(() => { throw new Error('timeout') })
        try {
          await Promise.race([stepPromise, timeout])
        } catch {}
        
        if (cancelled) return

        // WHY: Animate progress lên 100% + show tip.
        await animateProgress(i, 100, 200)
        setSteps(prev => prev.map((s, j) => j === i ? { ...s, status: 'done' as const, progress: 100 } : s))
        
        // Show random tip ở các step chẵn
        if (i % 2 === 0) {
          setShowTip(TIPS[Math.floor(Math.random() * TIPS.length)])
        }
      }

      // Final step: Ready
      if (cancelled) return
      setCurrentStepIdx(MODULE_APIS.length - 1)
      setSteps(prev => prev.map((s, i) => i === MODULE_APIS.length - 1 ? { ...s, status: 'loading' as const } : s))
      await animateProgress(MODULE_APIS.length - 1, 100, 400)
      
      const elapsed = Math.round((Date.now() - startedAt.current) / 100) / 10
      setShowTip(`✨ Đã sẵn sàng trong ${elapsed} giây`)

      // WHY: Delay tối thiểu 800ms để user thấy "Sẵn sàng" trước khi fade.
      await sleep(800)
      if (cancelled) return

      // Fade out + notify parent với preloaded data
      setFadeOut(true)
      await sleep(500)
      if (cancelled) return
      onComplete(preloadedData.current)
    }

    run()
    return () => { cancelled = true }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

  return (
    <div className={`fixed inset-0 z-[9999] flex flex-col items-center justify-center transition-opacity duration-500 ${fadeOut ? 'opacity-0' : 'opacity-100'}`}
      style={{
        background: 'radial-gradient(ellipse at 50% 30%, #0a1628 0%, #030712 70%)',
        fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif",
      }}>
      {/* Animated background grid */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute inset-0 opacity-[0.03]" style={{
          backgroundImage: 'linear-gradient(rgba(52,211,153,0.3) 1px, transparent 1px), linear-gradient(90deg, rgba(52,211,153,0.3) 1px, transparent 1px)',
          backgroundSize: '60px 60px',
        }} />
        {/* Glow orbs */}
        <div className="absolute -top-40 -left-40 w-[500px] h-[500px] rounded-full blur-[120px] opacity-20 animate-pulse" style={{ background: 'radial-gradient(circle, rgba(52,211,153,0.4), transparent 70%)' }} />
        <div className="absolute -bottom-40 -right-40 w-[500px] h-[500px] rounded-full blur-[120px] opacity-20 animate-pulse" style={{ background: 'radial-gradient(circle, rgba(96,165,250,0.3), transparent 70%)', animationDelay: '2s' }} />
      </div>

      {/* Content */}
      <div className="relative z-10 flex flex-col items-center w-full max-w-md px-6">
        {/* Logo area */}
        <div className="mb-8 text-center">
          <div className="relative inline-flex items-center justify-center w-16 h-16 mb-4">
            <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-emerald-400/20 to-blue-500/20 animate-pulse" />
            <div className="absolute inset-0 rounded-2xl border border-emerald-500/20" />
            <div className="relative text-3xl">⚡</div>
          </div>
          <h1 className="text-xl font-bold tracking-tight" style={{ color: '#f1f5f9' }}>
            MultiTool Pro
          </h1>
          <p className="text-xs mt-1" style={{ color: 'rgba(148,163,184,0.7)' }}>
            Đang khởi tạo các module...
          </p>
        </div>

        {/* Progress bar */}
        <div className="w-full mb-6">
          <div className="relative h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: 'rgba(255,255,255,0.06)' }}>
            <div className="absolute inset-0 rounded-full transition-all duration-300 ease-out"
              style={{
                width: `${overallProgress}%`,
                background: 'linear-gradient(90deg, #34d399, #60a5fa, #34d399)',
                backgroundSize: '200% 100%',
                animation: 'loading-bar-shimmer 2s linear infinite',
                boxShadow: '0 0 12px rgba(52,211,153,0.4)',
              }} />
          </div>
          <span className="text-[10px] font-mono mt-1.5 block text-right" style={{ color: 'rgba(148,163,184,0.5)' }}>
            {overallProgress}%
          </span>
        </div>

        {/* Steps */}
        <div className="w-full space-y-1.5 mb-6">
          {steps.map((step, idx) => {
            const isActive = idx === currentStepIdx
            const isDone = step.status === 'done'
            const isError = step.status === 'error'
            const isWaiting = step.status === 'waiting'
            return (
              <div key={step.id}
                className={`flex items-center gap-3 px-3 py-2 rounded-lg transition-all duration-300 ${
                  isActive ? 'bg-white/[0.04] border border-emerald-500/20' :
                  isDone ? 'bg-white/[0.02] border border-transparent' :
                  isError ? 'bg-white/[0.02] border border-amber-500/20' :
                  'border border-transparent'
                }`}>
                {/* Icon */}
                <div className={`relative w-6 h-6 flex items-center justify-center rounded-md text-xs transition-all duration-300 ${
                  isDone ? 'scale-100' : isActive ? 'scale-110' : 'scale-90 opacity-40'
                }`}>
                  {isDone ? (
                    <div className="absolute inset-0 rounded-md bg-emerald-500/20 flex items-center justify-center">
                      <svg className="w-3 h-3 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                      </svg>
                    </div>
                  ) : isError ? (
                    <div className="absolute inset-0 rounded-md bg-amber-500/20 flex items-center justify-center">
                      <svg className="w-3 h-3 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </div>
                  ) : (
                    <span className={isActive ? '' : 'opacity-40'}>{step.icon}</span>
                  )}
                  {isActive && !isDone && !isError && (
                    <div className="absolute -inset-0.5 rounded-md border-2 border-emerald-500/30 animate-ping opacity-30" />
                  )}
                </div>
                {/* Label */}
                <span className={`flex-1 text-xs font-medium transition-all duration-300 ${
                  isDone ? 'text-emerald-400' : isError ? 'text-amber-400' : isActive ? 'text-gray-200' : 'text-gray-500'
                }`}>
                  {step.label}
                </span>
                {/* Progress indicator */}
                <div className="flex items-center gap-1.5">
                  {isActive && step.progress < 100 && !isError && (
                    <div className="flex gap-0.5">
                      {[0,1,2].map(i => (
                        <div key={i} className="w-0.5 h-2.5 rounded-full bg-emerald-400/60 animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
                      ))}
                    </div>
                  )}
                  {isDone && (
                    <span className="text-[10px] font-mono text-emerald-500/60">OK</span>
                  )}
                  {isError && (
                    <span className="text-[10px] font-mono text-amber-500/60">--</span>
                  )}
                  {isWaiting && (
                    <span className="text-[10px] font-mono text-gray-600">--</span>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        {/* Tip */}
        {showTip && (
          <div className="text-[11px] text-center px-4 py-2 rounded-lg transition-opacity duration-500 animate-fade-in"
            style={{ color: 'rgba(148,163,184,0.6)', backgroundColor: 'rgba(255,255,255,0.03)' }}>
            {showTip}
          </div>
        )}

        {/* Version */}
        <div className="mt-8 text-[10px] font-mono" style={{ color: 'rgba(148,163,184,0.25)' }}>
          v1.10.0
        </div>
      </div>
    </div>
  )
}
