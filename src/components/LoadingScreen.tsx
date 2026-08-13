import { useEffect, useState, useRef } from 'react'
import { API, fetchWithRetry } from '../utils/apiFetch'
import { PLATFORM_MODULES } from '../types'
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

// WHY: Lọc các step preload theo nền tảng hiện tại — trên Mac bỏ Máy in/Âm thanh/
// Tunnel (Windows-only) để không gọi API backend Windows-only (tránh lỗi + chờ timeout).
// 'connecting'/'ready' luôn giữ.
const VISIBLE_APIS: ModuleApi[] = MODULE_APIS.filter(m =>
  m.id === 'connecting' || m.id === 'ready' || PLATFORM_MODULES.some(x => x.id === m.id)
)

// WHY: Component nhỏ để fetch version từ Tauri API dynamic.
function AppVersion() {
  const [ver, setVer] = useState('')
  useEffect(() => {
    import('@tauri-apps/api/app')
      .then(m => m.getVersion().then(setVer))
      .catch(() => setVer('1.11.5'))
  }, [])
  return <>{ver ? `v${ver}` : ''}</>
}

// WHY: Màn hình loading chuyên nghiệp khi khởi động app.
// Hiển thị tiến trình khởi tạo từng module với animation mượt mà.
// Gọi API THẬT cho từng module, không phải animation giả.
export default function LoadingScreen({ onComplete }: Props) {
  const [steps, setSteps] = useState<PreloadStep[]>(
    VISIBLE_APIS.map((m, i) => ({
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
  // WHY: preloadedRaw lưu response THÔ của từng module (map theo id) — KHÔNG merge
  // incrementally như trước. Trước đây mỗi promise chạy `{ ...preloadedData.current }`
  // rồi ghi đè → race condition: 2 promise resolve đồng thời, promise sau ghi đè
  // snapshot cũ làm MẤT dữ liệu của promise trước (e.g. audio chậm resolve sau → đè
  // mất debugLog → tab Log trắng). Giờ build PreloadedData một lần, nguyên tử, sau khi
  // MỌI promise settle → không còn race.
  const preloadedRaw = useRef<Record<string, unknown>>({})

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
          const stepsTotal = VISIBLE_APIS.length
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

  // WHY: Build PreloadedData MỘT LẦN từ các response đã collect — chạy sau khi mọi
  // promise settle nên KHÔNG có race. Mapping giữ nguyên chuẩn cũ (extract từng field).
  const buildPreloadedData = (): PreloadedData => {
    const res = preloadedRaw.current
    const flat: PreloadedData = {}
    if (res.printers) {
      flat.printers = (res.printers as any)?.printers
      flat.printerSettings = (res.printers as any)?.printerSettings
    }
    if (res.audio) flat.audioDevices = res.audio as any
    if (res.tunnels) flat.cloudflared = res.tunnels as any
    if (res.database) {
      flat.databaseConnections = ((res.database as any)?.connections) || []
    }
    if (res.logs) {
      // WHY: Backend trả về { log: "..." }, transform thành { lines: [...] }
      const logStr = (res.logs as any)?.log || ''
      flat.debugLog = { lines: logStr.split('\n').filter((l: string) => l.trim()) }
    }
    if (res.servers) flat.projects = res.servers as any
    return flat
  }

  useEffect(() => {
    let cancelled = false
    // WHY: Hàm async xử lý khởi chạy và lắng nghe kết quả preload API.
    const run = async () => {
      // WHY: Fire tất cả API calls song song ngay từ đầu.
      // Khi mỗi promise resolve, step tương ứng được đánh dấu hoàn thành.
      // Data từ mỗi API response được flatten và collect vào preloadedData.
      const promises = VISIBLE_APIS.map((mod, idx) => 
        (async () => {
          try {
            const result = await mod.fetch()
            if (cancelled) return
            // WHY: Chỉ collect response THÔ theo mod.id — flatten được thực hiện
            // MỘT LẦN trong buildPreloadedData() sau khi mọi promise settle (atomic).
            if (result?.data) {
              preloadedRaw.current[mod.id] = result.data
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

      for (let i = 1; i < VISIBLE_APIS.length - 1; i++) {
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
      setCurrentStepIdx(VISIBLE_APIS.length - 1)
      setSteps(prev => prev.map((s, i) => i === VISIBLE_APIS.length - 1 ? { ...s, status: 'loading' as const } : s))
      await animateProgress(VISIBLE_APIS.length - 1, 100, 400)
      
      const elapsed = Math.round((Date.now() - startedAt.current) / 100) / 10
      setShowTip(`✨ Đã sẵn sàng trong ${elapsed} giây`)

      // WHY: Delay tối thiểu 800ms để user thấy "Sẵn sàng" trước khi fade.
      await sleep(800)
      if (cancelled) return

      // Fade out + notify parent với preloaded data
      setFadeOut(true)
      await sleep(500)
      if (cancelled) return
      // WHY: Build toàn bộ preloaded data một lần (atomic) — tránh race làm mất field
      onComplete(buildPreloadedData())
    }

    run()
    return () => { cancelled = true }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // WHY: Promise sleep đơn giản cho delay/retry trong LoadingScreen.
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

  return (
    <div className={`fixed inset-0 z-[9999] flex flex-col items-center justify-center transition-opacity duration-500 ${fadeOut ? 'opacity-0' : 'opacity-100'}`}
      style={{
        background: 'radial-gradient(ellipse at 50% 30%, #0b1329 0%, #030712 80%)',
        fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif",
      }}>
      {/* Animated background grid & Ambient Glow */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute inset-0 opacity-[0.04]" style={{
          backgroundImage: 'linear-gradient(rgba(52,211,153,0.3) 1px, transparent 1px), linear-gradient(90deg, rgba(52,211,153,0.3) 1px, transparent 1px)',
          backgroundSize: '50px 50px',
        }} />
        {/* Glow orbs */}
        <div className="absolute -top-40 -left-40 w-[600px] h-[600px] rounded-full blur-[140px] opacity-25 animate-pulse" style={{ background: 'radial-gradient(circle, rgba(52,211,153,0.4), transparent 70%)' }} />
        <div className="absolute -bottom-40 -right-40 w-[600px] h-[600px] rounded-full blur-[140px] opacity-25 animate-pulse" style={{ background: 'radial-gradient(circle, rgba(56,189,248,0.35), transparent 70%)', animationDelay: '2s' }} />
      </div>

      {/* Content Container — Tăng chiều rộng lên max-w-3xl cho rộng rãi 2 bên */}
      <div className="relative z-10 flex flex-col items-center w-full max-w-3xl px-6">
        {/* Logo & Header */}
        <div className="mb-6 text-center">
          <div className="relative inline-flex items-center justify-center w-20 h-20 mb-3">
            <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-emerald-400/25 via-sky-500/20 to-blue-600/25 animate-pulse blur-sm" />
            <div className="absolute inset-0 rounded-2xl border border-emerald-500/35 bg-slate-950/60 backdrop-blur-md" />
            <div className="relative text-4xl transform hover:scale-110 transition-transform">⚡</div>
          </div>
          <h1 className="text-2xl font-black tracking-tight bg-gradient-to-r from-white via-slate-100 to-slate-300 bg-clip-text text-transparent">
            MultiTool Pro
          </h1>
          <p className="text-xs text-slate-400 mt-1 font-medium">
            Hệ thống Quản trị & Dịch vụ Multi-App · Đang khởi tạo các module...
          </p>
        </div>

        {/* Master Progress Bar — Tăng rộng toàn chiều ngang max-w-3xl */}
        <div className="w-full mb-6 bg-slate-900/80 border border-slate-800/80 rounded-2xl p-3.5 backdrop-blur-md shadow-sm">
          <div className="flex items-center justify-between text-xs mb-2">
            <span className="font-semibold text-slate-300 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
              Tiến trình khởi động hệ thống
            </span>
            <span className="font-mono font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2.5 py-0.5 rounded-full text-[11px]">
              {overallProgress}%
            </span>
          </div>
          <div className="relative h-2.5 rounded-full overflow-hidden bg-slate-950/80 border border-slate-800">
            <div className="absolute inset-0 rounded-full transition-all duration-300 ease-out"
              style={{
                width: `${overallProgress}%`,
                background: 'linear-gradient(90deg, #10b981, #38bdf8, #818cf8, #10b981)',
                backgroundSize: '200% 100%',
                animation: 'loading-bar-shimmer 2s linear infinite',
                boxShadow: '0 0 15px rgba(52,211,153,0.5)',
              }} />
          </div>
        </div>

        {/* Modules Grid — 3 Cột rộng rãi tràn đều 2 bên */}
        <div className="w-full grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
          {steps.map((step, idx) => {
            const isActive = idx === currentStepIdx
            const isDone = step.status === 'done'
            const isError = step.status === 'error'
            const isWaiting = step.status === 'waiting'
            return (
              <div key={step.id}
                className={`flex items-center gap-3 px-3.5 py-2.5 rounded-xl border transition-all duration-300 backdrop-blur-md ${
                  isActive ? 'bg-emerald-500/10 border-emerald-500/35 shadow-md shadow-emerald-500/5' :
                  isDone ? 'bg-slate-900/60 border-slate-800/80' :
                  isError ? 'bg-amber-500/10 border-amber-500/30' :
                  'bg-slate-950/30 border-slate-900/60 opacity-60'
                }`}>
                {/* Icon */}
                <div className={`relative w-7 h-7 flex items-center justify-center rounded-lg text-sm shrink-0 transition-all duration-300 ${
                  isDone ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' :
                  isError ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30' :
                  isActive ? 'bg-sky-500/20 border border-sky-500/30 scale-105' :
                  'bg-slate-800/40 text-slate-500 border border-slate-800'
                }`}>
                  {isDone ? (
                    <svg className="w-3.5 h-3.5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                    </svg>
                  ) : isError ? (
                    <svg className="w-3.5 h-3.5 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  ) : (
                    <span>{step.icon}</span>
                  )}
                </div>

                {/* Label */}
                <span className={`flex-1 text-xs font-semibold truncate transition-colors duration-300 ${
                  isDone ? 'text-slate-200' : isError ? 'text-amber-400' : isActive ? 'text-emerald-400 font-bold' : 'text-slate-400'
                }`}>
                  {step.label}
                </span>

                {/* Progress Status Badge */}
                <div className="shrink-0 flex items-center">
                  {isActive && step.progress < 100 && !isError && (
                    <span className="text-[10px] font-mono font-bold text-sky-400 animate-pulse">
                      {step.progress}%
                    </span>
                  )}
                  {isDone && (
                    <span className="text-[10px] font-mono font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-0.5 rounded">
                      OK
                    </span>
                  )}
                  {isError && (
                    <span className="text-[10px] font-mono font-bold text-amber-400 bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.5 rounded">
                      WAIT
                    </span>
                  )}
                  {isWaiting && (
                    <span className="text-[10px] font-mono text-slate-600">--</span>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        {/* Tip Box Container — Tăng mở rộng max-w-2xl & cố định min-height 48px */}
        <div className="w-full max-w-2xl min-h-[48px] flex items-center justify-center border border-slate-800/80 bg-slate-900/60 backdrop-blur-md rounded-2xl px-6 py-2.5 shadow-sm text-center text-xs text-slate-300 font-medium transition-all duration-300">
          {showTip ? (
            <span className="animate-fade-in leading-relaxed text-slate-300 font-medium">
              {showTip}
            </span>
          ) : (
            <span className="text-slate-500 italic text-[11px]">Đang tải dữ liệu cấu hình hệ thống...</span>
          )}
        </div>

        {/* Dynamic Version */}
        <div className="mt-6 text-[10px] font-mono text-slate-500 tracking-wider">
          <AppVersion />
        </div>
      </div>
    </div>
  )
}
