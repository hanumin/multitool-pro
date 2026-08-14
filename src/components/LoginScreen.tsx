import { useState, useRef } from 'react'
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
  const busyRef = useRef(false)
  // WHY: Nền động ánh sáng tương tác chuột — bgRef để cập nhật trực tiếp biến CSS
  // --mx/--my khi mousemove (không re-render), ripples = vòng sáng nổ khi click nền.
  const bgRef = useRef<HTMLDivElement>(null)
  const [ripples, setRipples] = useState<{ id: number; x: number; y: number }[]>([])
  const rippleIdRef = useRef(0)

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

  // WHY: Cập nhật --mx/--my (px tính từ tâm) lên DOM mỗi khi chuột di chuyển — các
  // quả cầu sáng dịch theo chuột qua CSS translate. Không setState → không re-render
  // 60 lần/giây, animation chạy hoàn toàn trên GPU/CSS.
  const handleBgMouseMove = (e: React.MouseEvent) => {
    const el = bgRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    el.style.setProperty('--mx', `${e.clientX - rect.left - rect.width / 2}px`)
    el.style.setProperty('--my', `${e.clientY - rect.top - rect.height / 2}px`)
  }

  // WHY: Click TRỰC TIẾP vào nền (không phải form/nút) → tạo vòng sáng nổ tại vị trí
  // chuột — hiệu ứng "chuột tác động lên nền". Vòng tự xóa sau 950ms (animation xong).
  const handleBgClick = (e: React.MouseEvent) => {
    if (e.target !== e.currentTarget) return
    const rect = bgRef.current?.getBoundingClientRect()
    if (!rect) return
    const id = ++rippleIdRef.current
    setRipples(r => [...r, { id, x: e.clientX - rect.left, y: e.clientY - rect.top }])
    setTimeout(() => setRipples(r => r.filter(p => p.id !== id)), 950)
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
    <div className="h-screen flex items-center justify-center bg-slate-950 select-none overflow-hidden relative">
      {/* WHY: Nền động dạng ánh sáng — aurora xoay chậm + 2 quả cầu sáng DI CHUYỂN
          THEO CHUỘT (--mx/--my) + vòng sáng nổ khi click nền. Các phần tử con đều
          pointer-events-none để click/form ở trên không bị chặn. */}
      <div
        ref={bgRef}
        className="login-bg"
        onMouseMove={handleBgMouseMove}
        onClick={handleBgClick}
      >
        <div className="login-aurora" />
        {/* WHY: Quả cầu emerald — dịch theo chuột 0.35x (lớp gần), centered bằng
            transform translate(-50%,-50%) + parallax bằng translate property. */}
        <div
          className="login-orb login-orb--follow"
          style={{
            width: 480, height: 480, left: '50%', top: '42%',
            transform: 'translate(-50%, -50%)',
            translate: 'calc(var(--mx, 0px) * 0.35) calc(var(--my, 0px) * 0.35)',
            background: 'radial-gradient(circle, rgba(16,185,129,0.35), transparent 65%)',
          }}
        />
        {/* WHY: Quả cầu xanh dương — dịch 0.2x (lớp xa, lag hơn) tạo chiều sâu parallax. */}
        <div
          className="login-orb login-orb--follow-delayed"
          style={{
            width: 360, height: 360, left: '50%', top: '58%',
            transform: 'translate(-50%, -50%)',
            translate: 'calc(var(--mx, 0px) * 0.2) calc(var(--my, 0px) * 0.2)',
            background: 'radial-gradient(circle, rgba(14,165,233,0.3), transparent 65%)',
          }}
        />
        {/* WHY: Vòng sáng nổ tại vị trí click nền — vị trí tuyệt đối theo tọa độ click. */}
        {ripples.map(r => (
          <div key={r.id} className="login-ripple" style={{ left: r.x, top: r.y }} />
        ))}
      </div>

      {/* WHY: Nút thu gọn xuống khay ở GÓC PHẢI TRÊN — nhấn vào ẩn cửa sổ nhưng app
          vẫn chạy trong khay hệ thống (không tắt app), giống logic sau khi đăng nhập. */}
      <button
        type="button"
        onClick={minimizeToTray}
        className="absolute top-3 right-3 z-20 w-9 h-9 rounded-xl border flex items-center justify-center transition-all cursor-pointer hover:bg-white/10 active:scale-95 group"
        style={{ borderColor: 'rgba(148,163,184,0.25)', color: '#94a3b8' }}
        title="Thu gọn xuống khay hệ thống (không tắt ứng dụng)"
        aria-label="Thu gọn xuống khay hệ thống"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v9m0 0l-4-4m4 4l4-4M5 21h14" />
        </svg>
      </button>

      {/* WHY: max-w-6xl — trải 2 bên vừa phải (giảm nhẹ so với max-w-7xl) + card login
          rộng hơn (max-w-md) theo yêu cầu cân đối lại bố cục. */}
      <div className="relative z-10 w-full max-w-6xl mx-6 flex flex-col lg:flex-row items-center gap-10 lg:gap-14">
        {/* WHY: Panel giới thiệu bên trái — logo, mô tả và danh sách chức năng chính.
            Ẩn trên màn hình hẹp (lg:flex), hiện đầy đủ trên cửa sổ desktop. */}
        <div className="hidden lg:flex flex-col flex-1 min-w-0">
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
            Một bảng điều khiển duy nhất để quản lý toàn bộ dịch vụ trong hệ sinh thái —
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
                  <div className="text-[11px] leading-snug text-slate-500 mt-0.5">{f.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Card đăng nhập — max-w-md (448px) rộng hơn trước (384px) theo yêu cầu */}
        <div className="w-full max-w-md shrink-0">
          {/* Logo mobile (chỉ hiện khi panel trái bị ẩn) */}
          <div className="flex flex-col items-center mb-6 lg:hidden">
            <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-emerald-400 to-emerald-600 flex items-center justify-center text-2xl shadow-lg shadow-emerald-500/25 mb-3">
              🛠️
            </div>
            <h1 className="text-xl font-bold text-white tracking-tight">MultiTool Pro</h1>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-900/90 backdrop-blur p-6 shadow-2xl">
            <h2 className="text-base font-bold text-white mb-1">Đăng nhập</h2>
            <p className="text-[11px] text-slate-400 mb-5">Vui lòng đăng nhập để sử dụng bảng điều khiển</p>

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
                    <span className="text-[10px] text-slate-500">
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
            className="w-full text-center text-[10px] text-slate-500 hover:text-emerald-300 transition-colors bg-transparent border-0 cursor-pointer mt-5 leading-relaxed"
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
