import { useState, useRef } from 'react'
import Particles, { ParticlesProvider } from '@tsparticles/react'
import { loadSlim } from '@tsparticles/slim'
import type { ISourceOptions } from '@tsparticles/engine'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { getSupabase } from '../lib/supabase'
import type { Session } from '@supabase/supabase-js'

// WHY: Các chế độ hiển thị của màn hình đăng nhập — login (đăng nhập) và forgot
// (quên mật khẩu → nhập email nhận link reset). Tab Đăng ký đã bị ẩn theo yêu cầu:
// tài khoản được tạo/quản lý tập trung tại hệ thống luongphamhanhnguyen.com.
type AuthMode = 'login' | 'forgot'

interface LoginScreenProps {
  // WHY: rememberMe quyết định session có tồn tại qua lần mở app sau hay không
  // (xem logic duy trì đăng nhập bên dưới) — App cần biết để lưu flag + cài idle timeout.
  onAuthenticated: (session: Session, rememberMe: boolean) => void
  // WHY: Version hiển thị dưới footer login — lấy từ App (đã đọc từ Tauri) để không
  // phải duplicate logic lấy version trong LoginScreen.
  appVersion?: string
}

// WHY: Cổng quản lý tài khoản của hệ sinh thái — mở bằng trình duyệt ngoài khi user
// bấm vào dòng label dưới form đăng nhập (yêu cầu: nhấn vào mở tab mới trang này).
const ACCOUNT_PORTAL_URL = 'https://luongphamhanhnguyen.com'

// WHY: 3 preset nền động tsParticles để user so sánh — lights (quả cầu sáng trôi),
// network (mạng lưới điểm nối), flow (hạt sáng bay lên). Chọn qua nút nhỏ góc phải
// dưới, lựa chọn persist localStorage.
type BgEffect = 'lights' | 'network' | 'flow'

const BG_EFFECT_LABELS: Record<BgEffect, string> = {
  lights: 'ÁNH SÁNG — quả cầu sáng trôi',
  network: 'LƯỚI — mạng lưới điểm',
  flow: 'DÒNG — hạt sáng bay lên',
}

// WHY: Options tsParticles (canvas 2D — ổn định trên mọi nền tảng, không dính lỗi
// tương thích WebGL/three.js như Vanta). Giữ tông emerald/sky/slate của app; mọi
// preset đều có tương tác chuột: hover → grab/link/repulse/attract, click → push hạt.
const BG_PRESETS: Record<BgEffect, ISourceOptions> = {
  lights: {
    fullScreen: { enable: false },
    background: { color: { value: 'transparent' } },
    fpsLimit: 60,
    detectRetina: true,
    particles: {
      number: { value: 42, density: { enable: true } },
      color: { value: ['#10b981', '#34d399', '#0ea5e9'] },
      shape: { type: 'circle' },
      opacity: { value: 0.3 },
      size: { value: { min: 10, max: 26 } },
      links: { enable: true, distance: 170, color: '#10b981', opacity: 0.12, width: 1 },
      move: { enable: true, speed: 0.7, direction: 'none', random: true, straight: false, outModes: { default: 'out' } },
    },
    interactivity: {
      detectsOn: 'canvas',
      events: { onHover: { enable: true, mode: ['grab', 'link'] }, onClick: { enable: true, mode: 'push' } },
      modes: { grab: { distance: 160, links: { opacity: 0.3 } }, push: { quantity: 2 } },
    },
  },
  network: {
    fullScreen: { enable: false },
    background: { color: { value: 'transparent' } },
    fpsLimit: 60,
    detectRetina: true,
    particles: {
      number: { value: 70, density: { enable: true } },
      color: { value: '#34d399' },
      shape: { type: 'circle' },
      opacity: { value: 0.7 },
      size: { value: { min: 2, max: 4 } },
      links: { enable: true, distance: 130, color: '#10b981', opacity: 0.45, width: 1 },
      move: { enable: true, speed: 1.1, direction: 'none', random: true, outModes: { default: 'out' } },
    },
    interactivity: {
      detectsOn: 'canvas',
      events: { onHover: { enable: true, mode: 'repulse' }, onClick: { enable: true, mode: 'push' } },
      modes: { repulse: { distance: 90, duration: 0.4 }, push: { quantity: 3 } },
    },
  },
  flow: {
    fullScreen: { enable: false },
    background: { color: { value: 'transparent' } },
    fpsLimit: 60,
    detectRetina: true,
    particles: {
      number: { value: 60, density: { enable: true } },
      color: { value: ['#10b981', '#0ea5e9', '#a7f3d0'] },
      shape: { type: 'circle' },
      opacity: { value: 0.5, animation: { enable: true, speed: 1, sync: false } },
      size: { value: { min: 4, max: 12 }, animation: { enable: true, speed: 3, sync: false } },
      move: { enable: true, speed: 1.6, direction: 'top', random: true, straight: false, outModes: { default: 'out' } },
    },
    interactivity: {
      detectsOn: 'canvas',
      events: { onHover: { enable: true, mode: 'attract' }, onClick: { enable: true, mode: 'push' } },
      modes: { attract: { distance: 200, duration: 0.5, speed: 4 }, push: { quantity: 2 } },
    },
  },
}

// WHY: Danh sách chức năng chính hiển thị ở panel giới thiệu bên trái màn hình login
// (đồng bộ với các module thực tế trong app — Máy chủ/Máy in/Âm thanh/Database...).
const FEATURES = [
  { icon: '🖥️', title: 'Quản lý máy chủ', desc: 'Bật/tắt server dev, tunnel Cloudflare, giám sát trạng thái' },
  { icon: '🖨️', title: 'Giám sát máy in', desc: 'Theo dõi trạng thái máy in, số trang in, cảnh báo lỗi' },
  { icon: '🎤', title: 'Âm thanh', desc: 'Giám sát mic & thiết bị âm thanh theo thời gian thực' },
  { icon: '🗄️', title: 'Cơ sở dữ liệu', desc: 'Quản lý PostgreSQL / MySQL, chạy truy vấn nhanh' },
  { icon: '📂', title: 'Sao chép tệp', desc: 'Tự động sao chép file audio/video theo từ khóa' },
  { icon: '📋', title: 'Nhật ký hệ thống', desc: 'Xem log, chẩn đoán lỗi và theo dõi sự kiện' },
]

// WHY: Mở link bằng trình duyệt NGOÀI (không phải trong webview) — 2 lớp fallback
// giống App.tsx: plugin-shell (Tauri runtime) → window.open (khi chạy browser dev).
const openExternal = async (url: string) => {
  try {
    const { open } = await import('@tauri-apps/plugin-shell')
    await open(url)
    return
  } catch {}
  window.open(url, '_blank')
}



// WHY: Màn hình đăng nhập dùng Supabase Auth CHUNG của hệ sinh thái — tài khoản do
// trang luongphamhanhnguyen.com quản lý, mọi app (MultiTool Pro, web tiếng Anh...)
// đăng nhập chung 1 pool users. Chỉ giữ chế độ login + quên mật khẩu (ẩn đăng ký).
export default function LoginScreen({ onAuthenticated, appVersion }: LoginScreenProps) {
  const [mode, setMode] = useState<AuthMode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  // WHY: Mặc định BẬT duy trì đăng nhập (chuẩn app desktop: Discord/VS Code mặc định
  // nhớ phiên). Nếu user bỏ tick → session chỉ sống trong 1 phiên: tự đăng xuất khi
  // đóng app và sau 30 phút không hoạt động (App.tsx chịu trách nhiệm enforce).
  const [rememberMe, setRememberMe] = useState(true)
  // WHY: Giảm sáng nền khi nhập mật khẩu (chống nhìn lén shoulder-surfing) — bật khi
  // ô mật khẩu được focus, tắt khi blur; card đăng nhập vẫn sáng trên lớp phủ tối.
  const [passwordFocused, setPasswordFocused] = useState(false)
  const busyRef = useRef(false)
  // WHY: Nền động ánh sáng tương tác chuột — bgRef để cập nhật trực tiếp biến CSS
  // --mx/--my khi mousemove (không re-render), ripples = vòng sáng nổ khi click nền.
  const bgRef = useRef<HTMLDivElement>(null)
  const [ripples, setRipples] = useState<{ id: number; x: number; y: number }[]>([])
  const rippleIdRef = useRef(0)
  // WHY: Hiệu ứng nền đang chọn — đọc từ localStorage (giữ lựa chọn trước đó), mặc
  // định 'lights' (quả cầu sáng trôi — hiệu ứng ánh sáng phù hợp tông emerald).
  const [bgEffect, setBgEffect] = useState<BgEffect>(() => {
    try {
      const s = localStorage.getItem('sd-login-bg-effect')
      if (s === 'lights' || s === 'network' || s === 'flow') return s
    } catch {}
    return 'lights'
  })

  // WHY: Reset trạng thái lỗi/thông báo mỗi khi chuyển chế độ — tránh lỗi cũ hiện
  // khi user chuyển qua lại login/forgot.
  const switchMode = (m: AuthMode) => {
    setMode(m)
    setError(null)
    setMessage(null)
  }

  // WHY: Validate email nhanh phía client trước khi gọi API (tránh request thừa).
  // Không cần validate quá chặt — Supabase tự validate lại ở server.
  const isValidEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)

  // WHY: Dấu mốc thời gian mousedown gần nhất trên vùng kéo — phân biệt click nhanh
  // (nổ vòng sáng) với kéo thật (kéo lâu hơn 250ms → click sau mouseup bị nuốt).
  const lastDragMouseDownRef = useRef(0)

  // WHY: Chặn kéo bắt đầu từ phần tử tương tác (input/button/label...) — chuột trái
  // trên form phải gõ/chọn bình thường; chỉ kéo khi bấm vào vùng KHÔNG tương tác
  // (nền, panel tính năng, khoảng trống card...).
  const isInteractive = (el: HTMLElement | null): boolean =>
    !!el?.closest('input, button, textarea, select, label, a, [role="button"], [contenteditable="true"]')

  // WHY: Bắt đầu kéo bằng chuột TRÁI (button===0, đúng chuẩn Windows) ở vùng không
  // tương tác. Dùng startDragging NATIVE (cơ chế giống titlebar — OS tự kéo, cửa sổ
  // BÁM SÁT chuột, mượt tuyệt đối). Manual setPosition trước đây bị lag IPC nên kéo
  // giật/rời chuột. startDragging chỉ hoạt động với chuột trái (lý do lần trước fail
  // vì dùng chuột phải). Permission allow-start-dragging đã có trong capabilities.
  const handleRootMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    if (isInteractive(e.target as HTMLElement)) return
    e.preventDefault()
    lastDragMouseDownRef.current = Date.now()
    try {
      getCurrentWindow().startDragging().catch(() => {})
    } catch {}
  }

  // WHY: Click vào NỀN (gồm cả canvas tsParticles — child của .login-bg) → tạo vòng
  // sáng nổ tại vị trí chuột; click vào form/card (ngoài .login-bg) thì không. Dùng
  // closest thay vì so sánh target để bắt cả click trên canvas. Vòng tự xóa sau 950ms.
  // Nếu mousedown→click lâu hơn 250ms (kéo thật) → nuốt click, không nổ vòng sáng.
  const handleBgClick = (e: React.MouseEvent) => {
    // WHY: Kéo thật (>250ms) → click sau mouseup bị nuốt; reset mốc để lần click sau
    // bình thường (được tính là click mới).
    if (Date.now() - lastDragMouseDownRef.current > 250) {
      lastDragMouseDownRef.current = 0
      return
    }
    if (!(e.target as HTMLElement).closest?.('.login-bg')) return
    const rect = bgRef.current?.getBoundingClientRect()
    if (!rect) return
    const id = ++rippleIdRef.current
    setRipples(r => [...r, { id, x: e.clientX - rect.left, y: e.clientY - rect.top }])
    setTimeout(() => setRipples(r => r.filter(p => p.id !== id)), 950)
  }

  // WHY: Vòng qua lights → network → flow khi bấm nút hiệu ứng — persist lựa chọn
  // để lần mở sau giữ nguyên hiệu ứng user đã chọn.
  const cycleBgEffect = () => {
    setBgEffect(prev => {
      const next: BgEffect = prev === 'lights' ? 'network' : prev === 'network' ? 'flow' : 'lights'
      try { localStorage.setItem('sd-login-bg-effect', next) } catch {}
      return next
    })
  }

  // WHY: Thu gọn xuống khay hệ thống — logic giống nút thu gọn sau khi đăng nhập
  // (App.minimizeToTray): ẩn cửa sổ, app VẪN chạy trong khay/taskbar, không tắt app.
  // Dynamic import để không crash khi chạy browser dev (không có Tauri API).
  const minimizeToTray = async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      await getCurrentWindow().hide()
    } catch {}
  }

  // WHY: Handler chính theo mode — login (signInWithPassword) / forgot
  // (resetPasswordForEmail). busyRef chống double-click.
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busyRef.current) return
    setError(null)
    setMessage(null)

    if (!isValidEmail(email)) {
      setError('Email không hợp lệ')
      return
    }

    if (mode === 'forgot') {
      busyRef.current = true
      setLoading(true)
      try {
        const supabase = getSupabase()
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          // WHY: Redirect về trang login web english-topics (đã cấu hình trong
          // Supabase Dashboard) — user bấm link trong email → đặt mật khẩu mới trên
          // web → quay lại app đăng nhập bằng mật khẩu mới.
          redirectTo: 'https://english-topics.vercel.app/login',
        })
        if (error) throw error
        setMessage(`Đã gửi email đặt lại mật khẩu đến ${email}. Vui lòng kiểm tra hộp thư.`)
      } catch (err: any) {
        setError(err?.message || 'Không gửi được email đặt lại mật khẩu')
      } finally {
        busyRef.current = false
        setLoading(false)
      }
      return
    }

    if (!password) {
      setError('Vui lòng nhập mật khẩu')
      return
    }

    busyRef.current = true
    setLoading(true)
    try {
      const { data, error } = await getSupabase().auth.signInWithPassword({ email, password })
      if (error) throw error
      onAuthenticated(data.session, rememberMe)
    } catch (err: any) {
      setError(err?.message || 'Đăng nhập thất bại')
    } finally {
      busyRef.current = false
      setLoading(false)
    }
  }

  const inputCls =
    'w-full px-3.5 py-2.5 text-sm rounded-xl border transition-all focus:outline-none focus:ring-2 ' +
    'bg-slate-800/60 border-slate-700 text-slate-100 placeholder-slate-500 focus:border-emerald-500 focus:ring-emerald-500/20'

  return (
    <div
      className="h-screen flex items-center justify-center bg-slate-950 select-none overflow-hidden relative"
      // WHY: Kéo native bằng chuột TRÁI (mousedown trên vùng không tương tác →
      // startDragging). onContextMenu preventDefault để chặn menu chuột phải mặc định
      // của WebView2/Edge (menu 'Save image' hiện khi nhấp phải nền — theo yêu cầu bỏ).
      onMouseDown={handleRootMouseDown}
      onContextMenu={e => e.preventDefault()}
    >
      {/* WHY: Lớp giảm sáng khi nhập mật khẩu — phủ tối + blur nhẹ toàn màn hình
          ngoại trừ card đăng nhập (card z-20 nằm trên overlay z-[15]). opacity chuyển
          mượt 300ms khi focus/blur; pointer-events-none để không chặn thao tác gõ. */}
      <div
        className="fixed inset-0 z-[15] bg-slate-950/65 backdrop-blur-[2px] pointer-events-none transition-opacity duration-300"
        style={{ opacity: passwordFocused ? 1 : 0 }}
      />

      {/* WHY: Nền động ánh sáng tsParticles (repo nhiều sao, canvas 2D ổn định) —
          canvas vẽ hạt sáng chạy liên tục + tương tác chuột (hover/click). Canvas giữ
          pointer-events để nhận tương tác; click nền vẫn nổ vòng sáng qua handleBgClick. */}
      <div ref={bgRef} className="login-bg" onClick={handleBgClick}>
        {/* WHY: Particles — ParticlesProvider nạp engine slim (links, grab, repulse,
            push...) 1 lần; đổi bgEffect → options mới được áp lại trên cùng canvas. */}
        <ParticlesProvider init={async engine => { await loadSlim(engine) }}>
          <Particles
            id="login-particles"
            className="absolute inset-0"
            options={BG_PRESETS[bgEffect]}
          />
        </ParticlesProvider>
        {/* WHY: Vòng sáng nổ tại vị trí click nền — vị trí tuyệt đối theo tọa độ click. */}
        {ripples.map(r => (
          <div key={r.id} className="login-ripple" style={{ left: r.x, top: r.y }} />
        ))}
      </div>

      {/* WHY: Nút X đỏ hình vuông ở GÓC PHẢI TRÊN — nhấn vào ẩn cửa sổ nhưng app vẫn
          chạy trong khay hệ thống (không tắt app), giống logic sau khi đăng nhập. */}
      <button
        type="button"
        onClick={minimizeToTray}
        className="absolute top-3 right-3 z-20 w-9 h-9 rounded-lg bg-rose-600 hover:bg-rose-500 active:bg-rose-700 text-white flex items-center justify-center transition-all cursor-pointer shadow-lg shadow-rose-950/40"
        title="Thu gọn xuống khay hệ thống (không tắt ứng dụng)"
        aria-label="Thu gọn xuống khay hệ thống"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>

      {/* WHY: Nút đổi hiệu ứng nền ở GÓC PHẢI DƯỚI — bấm vòng qua WAVES/NET/FOG để
          user tự so sánh cái nào đẹp hơn; tooltip hiện tên effect đang dùng. */}
      <button
        type="button"
        onClick={cycleBgEffect}
        className="absolute bottom-3 right-3 z-20 w-8 h-8 rounded-full border flex items-center justify-center transition-all cursor-pointer hover:bg-white/10 active:scale-95"
        style={{ borderColor: 'rgba(148,163,184,0.25)', color: '#94a3b8' }}
        title={`Đổi hiệu ứng nền (đang: ${BG_EFFECT_LABELS[bgEffect]}) — bấm để so sánh WAVES / NET / FOG`}
        aria-label="Đổi hiệu ứng nền"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2m0 14v2m9-9h-2M5 12H3m14.5-6.5L16 6.6M8 17.4l-1.5 1.5m11 0L16 17.4M8 6.6L6.5 5.1" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      </button>

      {/* WHY: max-w-6xl — trải 2 bên vừa phải (giảm nhẹ so với max-w-7xl) + card login
          rộng hơn (max-w-md) theo yêu cầu cân đối lại bố cục. */}
      {/* WHY: Container content — bỏ z-index (không tạo stacking context) để card
          (z-20) vượt lên trên lớp giảm sáng (z-[15]) ở cấp trang; panel trái không
          z-index nên nằm dưới lớp giảm sáng (bị tối khi nhập mật khẩu). */}
      <div className="relative w-full max-w-6xl mx-6 flex flex-col lg:flex-row items-center gap-10 lg:gap-14">
        {/* WHY: Panel giới thiệu bên trái — logo, mô tả và danh sách chức năng chính.
            Ẩn trên màn hình hẹp (lg:flex), hiện đầy đủ trên cửa sổ desktop.
            lg:self-start → tiêu đề MultiTool Pro thẳng hàng ngang với cạnh TRÊN của
            frame đăng nhập (yêu cầu: chỉnh label trái cao lên). */}
        <div className="hidden lg:flex flex-col flex-1 min-w-0 lg:self-start">
          <div className="flex items-center gap-3 mb-5">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-emerald-400 to-emerald-600 flex items-center justify-center text-2xl shadow-lg shadow-emerald-500/25 shrink-0">
              🛠️
            </div>
            <div>
              <h1 className="text-2xl font-bold text-white tracking-tight">MultiTool Pro</h1>
              {/* WHY: "Phần mềm" (không phải "Hệ thống") — đây là phần mềm desktop,
                  không phải trang web (yêu cầu đổi label). */}
              <p className="text-xs text-slate-400 mt-0.5">Phần mềm Quản trị & Dịch vụ Multi-App Nội bộ</p>
            </div>
          </div>

          <p className="text-[13px] leading-relaxed text-slate-300 mb-6">
            Một phần mềm duy nhất để quản lý toàn bộ dịch vụ trong hệ sinh thái —
            từ máy chủ, tunnel, cơ sở dữ liệu đến giám sát máy in, âm thanh và nhật ký.
          </p>

          {/* WHY: Grid 2 cột liệt kê tính năng — mỗi mục icon + tiêu đề + mô tả ngắn.
              (2 cột để vừa với chiều rộng panel khi giảm container xuống max-w-6xl). */}
          <div className="grid grid-cols-2 gap-x-8 gap-y-5">
            {FEATURES.map(f => (
              <div key={f.title} className="flex items-start gap-3">
                <span className="w-9 h-9 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-lg shrink-0">
                  {f.icon}
                </span>
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-slate-200">{f.title}</div>
                  {/* WHY: Mô tả chuyển sang màu trắng theo yêu cầu (trước đây slate-500). */}
                  <div className="text-[11px] leading-snug text-white mt-0.5">{f.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Card đăng nhập — max-w-md (448px) rộng hơn trước (384px) theo yêu cầu.
            relative z-20 → card luôn SÁNG trên lớp giảm sáng khi nhập mật khẩu. */}
        <div className="relative z-20 w-full max-w-md shrink-0">
          {/* Logo mobile (chỉ hiện khi panel trái bị ẩn) */}
          <div className="flex flex-col items-center mb-6 lg:hidden">
            <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-emerald-400 to-emerald-600 flex items-center justify-center text-2xl shadow-lg shadow-emerald-500/25 mb-3">
              🛠️
            </div>
            <h1 className="text-xl font-bold text-white tracking-tight">MultiTool Pro</h1>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-900/90 backdrop-blur p-6 shadow-2xl">
            <h2 className="text-base font-bold text-white mb-1">Đăng nhập</h2>
            {/* WHY: Sub-label của card đăng nhập — chuyển trắng theo yêu cầu. */}
            <p className="text-[11px] text-white mb-5">Vui lòng đăng nhập để sử dụng phần mềm</p>

            <form onSubmit={handleSubmit} className="space-y-3.5">
              <div>
                <label className="block text-[11px] font-medium text-slate-400 mb-1.5">Email</label>
                <input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className={inputCls}
                  autoFocus
                  required
                />
              </div>

              {mode !== 'forgot' && (
                <div>
                  <label className="block text-[11px] font-medium text-slate-400 mb-1.5">Mật khẩu</label>
                  <input
                    type="password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    onFocus={() => setPasswordFocused(true)}
                    onBlur={() => setPasswordFocused(false)}
                    placeholder="••••••••"
                    className={inputCls}
                    required
                  />
                </div>
              )}

              {/* WHY: Checkbox duy trì đăng nhập — nếu KHÔNG tick: session bị xóa khi
                  đóng app và tự đăng xuất sau 30 phút không hoạt động (chuẩn an toàn). */}
              {mode !== 'forgot' && (
                <label className="flex items-center gap-2.5 cursor-pointer select-none py-0.5">
                  <input
                    type="checkbox"
                    checked={rememberMe}
                    onChange={e => setRememberMe(e.target.checked)}
                    className="w-3.5 h-3.5 rounded accent-emerald-500 cursor-pointer"
                  />
                  <span className="flex flex-col">
                    <span className="text-xs font-medium text-slate-300">Duy trì đăng nhập</span>
                    <span className="text-[10px] text-white">
                      {rememberMe
                        ? 'Giữ đăng nhập giữa các lần mở ứng dụng'
                        : 'Tự đăng xuất khi đóng ứng dụng & sau 30 phút không hoạt động'}
                    </span>
                  </span>
                </label>
              )}

              {mode === 'login' && (
                <div className="flex justify-end -mt-1">
                  <button
                    type="button"
                    onClick={() => switchMode('forgot')}
                    className="text-[11px] font-medium text-emerald-400 hover:text-emerald-300 transition-colors bg-transparent border-0 cursor-pointer"
                  >
                    Quên mật khẩu?
                  </button>
                </div>
              )}

              {/* Error / Message banner */}
              {error && (
                <div className="px-3 py-2 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-400 text-[11px] leading-relaxed">
                  {error}
                </div>
              )}
              {message && (
                <div className="px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-[11px] leading-relaxed">
                  {message}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full py-2.5 text-sm font-bold bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-white rounded-xl transition-all active:scale-[0.98] cursor-pointer border-0 shadow-lg shadow-emerald-500/20 flex items-center justify-center gap-2"
              >
                {loading ? (
                  <>
                    <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    {mode === 'forgot' ? 'Đang gửi...' : 'Đang xử lý...'}
                  </>
                ) : mode === 'forgot' ? (
                  'Gửi email đặt lại mật khẩu'
                ) : (
                  'Đăng nhập'
                )}
              </button>

              {mode === 'forgot' && (
                <button
                  type="button"
                  onClick={() => switchMode('login')}
                  className="w-full text-[11px] font-medium text-slate-400 hover:text-slate-200 transition-colors bg-transparent border-0 cursor-pointer py-1"
                >
                  ← Quay lại đăng nhập
                </button>
              )}
            </form>
          </div>

          {/* WHY: Label footer — nhấn vào mở trang quản lý tài khoản hệ thống bằng
              trình duyệt ngoài. Cụm domain GIỮ NGUYÊN style như label (không đậm,
              không gạch chân, không màu) nhưng vẫn click mở trang (yêu cầu). */}
          <button
            type="button"
            onClick={() => openExternal(ACCOUNT_PORTAL_URL)}
            className="w-full text-center text-[10px] text-white hover:text-emerald-300 transition-colors bg-transparent border-0 cursor-pointer mt-5 leading-relaxed"
            title={`Mở ${ACCOUNT_PORTAL_URL} trong trình duyệt`}
          >
            Đăng nhập bằng tài khoản của hệ thống luongphamhanhnguyen.com
          </button>

          {/* WHY: Version hiển thị dưới footer login — nhỏ, mờ, không tương tác. */}
          {appVersion && (
            <div className="text-center text-[10px] text-slate-600 mt-1.5 select-none">
              MultiTool Pro v{appVersion}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
