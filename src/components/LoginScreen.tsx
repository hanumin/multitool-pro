import { useState, useRef } from 'react'
import { getSupabase } from '../lib/supabase'
import type { Session } from '@supabase/supabase-js'

// WHY: Các chế độ hiển thị của màn hình đăng nhập — login (đăng nhập), register
// (tạo tài khoản mới), forgot (quên mật khẩu → nhập email nhận link reset).
type AuthMode = 'login' | 'register' | 'forgot'

interface LoginScreenProps {
  // WHY: rememberMe quyết định session có tồn tại qua lần mở app sau hay không
  // (xem logic duy trì đăng nhập bên dưới) — App cần biết để lưu flag + cài idle timeout.
  onAuthenticated: (session: Session, rememberMe: boolean) => void
}

// WHY: Màn hình đăng nhập dùng Supabase Auth CHUNG của project english-topics —
// tài khoản tạo từ bất kỳ app nào (web tiếng Anh, MultiTool Pro...) đều dùng chung
// 1 pool users, đăng nhập được ở mọi app. User đã chọn: tất cả user đã đăng ký đều
// được phép vào app (không chặn theo role).
export default function LoginScreen({ onAuthenticated }: LoginScreenProps) {
  const [mode, setMode] = useState<AuthMode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  // WHY: Mặc định BẬT duy trì đăng nhập (chuẩn app desktop: Discord/VS Code mặc định
  // nhớ phiên). Nếu user bỏ tick → session chỉ sống trong 1 phiên: tự đăng xuất khi
  // đóng app và sau 30 phút không hoạt động (App.tsx chịu trách nhiệm enforce).
  const [rememberMe, setRememberMe] = useState(true)
  const busyRef = useRef(false)

  // WHY: Reset trạng thái lỗi/thông báo mỗi khi chuyển chế độ — tránh lỗi cũ hiện
  // khi user chuyển sang tab khác.
  const switchMode = (m: AuthMode) => {
    setMode(m)
    setError(null)
    setMessage(null)
  }

  // WHY: Validate email nhanh phía client trước khi gọi API (tránh request thừa).
  // Không cần validate quá chặt — Supabase tự validate lại ở server.
  const isValidEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)

  // WHY: Handler chính theo mode — login/register/forgot đều dùng API Supabase
  // (signInWithPassword / signUp / resetPasswordForEmail). busyRef chống double-click.
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
    if (mode === 'register') {
      if (password.length < 6) {
        setError('Mật khẩu phải có ít nhất 6 ký tự')
        return
      }
      if (password !== confirmPassword) {
        setError('Mật khẩu xác nhận không khớp')
        return
      }
    }

    busyRef.current = true
    setLoading(true)
    try {
      const supabase = getSupabase()
      if (mode === 'register') {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            // WHY: Lưu nguồn gốc tài khoản để phân biệt app nào tạo user này
            // (hữu ích sau này nếu cần thống kê/quản lý nhiều app).
            data: { source: 'multitool-pro' },
          },
        })
        if (error) throw error
        if (!data.session) {
          // WHY: Nếu Supabase đang bật "email confirm" → user phải xác nhận email
          // trước khi đăng nhập. Hiện thông báo hướng dẫn thay vì coi là lỗi.
          setMessage(`Đăng ký thành công! Kiểm tra email ${email} để xác nhận tài khoản, sau đó đăng nhập.`)
          setMode('login')
          setPassword('')
          setConfirmPassword('')
          return
        }
        onAuthenticated(data.session, rememberMe)
      } else {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) throw error
        onAuthenticated(data.session, rememberMe)
      }
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
      {/* WHY: Hiệu ứng nền gradient mờ phía sau — tạo cảm giác hiện đại, không chói */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute -top-32 -left-32 w-96 h-96 bg-emerald-500/10 rounded-full blur-3xl" />
        <div className="absolute -bottom-32 -right-32 w-96 h-96 bg-sky-500/10 rounded-full blur-3xl" />
      </div>

      <div className="relative z-10 w-full max-w-sm mx-4">
        {/* Logo + Tiêu đề */}
        <div className="flex flex-col items-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-emerald-400 to-emerald-600 flex items-center justify-center text-3xl shadow-lg shadow-emerald-500/25 mb-4">
            🛠️
          </div>
          <h1 className="text-2xl font-bold text-white tracking-tight">MultiTool Pro</h1>
          <p className="text-xs text-slate-400 mt-1.5">Đăng nhập để sử dụng bảng điều khiển</p>
        </div>

        {/* Card đăng nhập */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900/90 backdrop-blur p-6 shadow-2xl">
          {/* Tab switch */}
          <div className="flex mb-5 bg-slate-800/60 rounded-xl p-1">
            {([
              { id: 'login', label: 'Đăng nhập' },
              { id: 'register', label: 'Đăng ký' },
            ] as { id: AuthMode; label: string }[]).map(t => (
              <button
                key={t.id}
                onClick={() => switchMode(t.id)}
                className={`flex-1 py-2 text-xs font-semibold rounded-lg transition-all cursor-pointer border-0 ${
                  mode === t.id
                    ? 'bg-emerald-600 text-white shadow'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

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

            {mode === 'register' && (
              <div>
                <label className="block text-[11px] font-medium text-slate-400 mb-1.5">Xác nhận mật khẩu</label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={e => setConfirmPassword(e.target.value)}
                  placeholder="••••••••"
                  className={inputCls}
                  required
                />
              </div>
            )}

            {/* WHY: Chỉ hiện "Quên mật khẩu" ở chế độ login — ở register/forgot không
                cần (forgot đang hiển thị form nhập email rồi). */}
            {/* WHY: Checkbox duy trì đăng nhập — nằm giữa mật khẩu và nút submit ở cả
                login lẫn register. Nếu KHÔNG tick: session bị xóa khi đóng app và tự
                đăng xuất sau 30 phút không hoạt động (chuẩn an toàn của các app web/desktop). */}
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
              ) : mode === 'register' ? (
                'Tạo tài khoản'
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

        <p className="text-center text-[10px] text-slate-600 mt-5">
          Đăng nhập bằng tài khoản chung của hệ thống · Bảo mật bởi Supabase Auth
        </p>
      </div>
    </div>
  )
}
