import { useEffect, useRef, useState } from 'react'
import { getSupabase } from '../lib/supabase'
import type { User } from '@supabase/supabase-js'

interface UserMenuProps {
  collapsed: boolean
  user: User | null
  onSignOut: () => void
}

interface ProfileInfo {
  displayName: string
  email: string
  avatarUrl: string | null
  avatarEmoji: string | null
}

// WHY: Base URL của thư viện linh vật Codex Pets tự-host trên Cloudflare R2 của
// project english-topics (bucket `site-assets-english4tumi`, prefix `codex-pet-avatar`).
// Đồng bộ với hằng số NEXT_PUBLIC_CODEX_PETS_BASE_URL bên web — KHÔNG hardcode đổi
// chỗ khác nếu domain thay đổi, chỉ cần sửa ở đây.
const CODEX_PETS_BASE_URL = 'https://site-assets-english4tumi.luongphamhanhnguyen.com/codex-pet-avatar'

// WHY: Ánh xạ slug ngắn legacy → slug chuẩn của repo awesome-codex-pet (giống web).
// owl/dino đã bị gỡ khỏi upstream nên trỏ slug "chết" → ảnh 404 → img onError
// fallback về emoji (🦉/🦖) thay vì khung vỡ.
const CODEX_LEGACY_SLUGS: Record<string, string> = {
  cat: 'salary-cat--zuochunjie',
  dog: 'corgi-companion--cxian0928-afk',
  fox: 'jesse-the-fox--itjesse',
  owl: 'owl--legeling',
  dino: 'dino--legeling',
}

// WHY: Resolve chuỗi `codex:<slug>` → URL ảnh R2 (webp động idle — giống user menu
// bên web). R2 keys đều chữ thường nên lowercase toàn bộ slug; trả '' nếu slug rỗng.
function resolveCodexUrl(value: string): string {
  const rawSlug = value.slice('codex:'.length).trim().toLowerCase()
  if (!rawSlug) return ''
  const targetSlug = CODEX_LEGACY_SLUGS[rawSlug] || rawSlug
  return `${CODEX_PETS_BASE_URL}/${targetSlug}/webp/idle.webp`
}

// WHY: Emoji fallback theo từ khóa slug khi ảnh Codex 404 (đồng bộ logic web —
// getEmojiFallback): nhìn slug chứa con gì thì hiện emoji con đó, mặc định 👤.
function emojiFallbackFor(value: string | null | undefined): string {
  const lower = (value ?? '').toLowerCase()
  if (lower.includes('cat')) return '🐱'
  if (lower.includes('dog')) return '🐶'
  if (lower.includes('fox')) return '🦊'
  if (lower.includes('owl')) return '🦉'
  if (lower.includes('dino')) return '🦖'
  if (lower.includes('bear')) return '🐻'
  if (lower.includes('panda')) return '🐼'
  if (lower.includes('frog')) return '🐸'
  if (lower.includes('duck')) return '🦆'
  if (lower.includes('bunny') || lower.includes('rabbit')) return '🐰'
  if (lower.includes('penguin')) return '🐧'
  if (lower.includes('dragon')) return '🐉'
  if (lower.includes('lion')) return '🦁'
  if (lower.includes('tiger')) return '🐯'
  if (lower.includes('monkey')) return '🐒'
  return '👤'
}

// WHY: Tên hiển thị ưu tiên dữ liệu từ bảng user_profiles (english-topics), sau đó
// user_metadata (vd OAuth Google trả full_name), cuối cùng fallback phần trước @
// của email — chuẩn fallback của các app (Discord/GitHub hiện tên, không có thì email).
function resolveDisplayName(profile: any, user: User | null): string {
  const meta = user?.user_metadata ?? {}
  const fromProfile = profile?.full_name || profile?.nickname || profile?.username
  const fromMeta = meta.full_name || meta.name || meta.display_name
  const emailFallback = user?.email ? user.email.split('@')[0] || user.email : 'Người dùng'
  return (fromProfile || fromMeta || emailFallback || 'Người dùng') as string
}

// WHY: Avatar ưu tiên URL thật (user_profiles.avatar_url / user_metadata.avatar_url
// từ OAuth), rồi avatar_emoji (nếu user đặt emoji HOẶC linh vật Codex dạng
// `codex:<slug>` — resolve sang URL R2, HOẶC URL/đường dẫn tự nhập), cuối cùng là
// dịch vụ avatar công cộng DiceBear (initials — cộng đồng dev dùng phổ biến, miễn
// phí, không cần key) với nền emerald đồng bộ theme app.
function resolveAvatar(profile: any, user: User | null, displayName: string): { type: 'url' | 'emoji' | 'dicebear'; value: string } {
  const meta = user?.user_metadata ?? {}
  const url = profile?.avatar_url || meta.avatar_url
  if (typeof url === 'string' && url.trim().startsWith('http')) return { type: 'url', value: url.trim() }
  const emoji = profile?.avatar_emoji
  if (typeof emoji === 'string' && emoji.trim()) {
    const trimmed = emoji.trim()
    const lower = trimmed.toLowerCase()
    // WHY: `codex:<slug>` — linh vật Codex Pets tự-host trên R2 (dữ liệu thật từ
    // user_profiles của english-topics). Không hiện chuỗi thô nữa, resolve sang ảnh.
    if (lower.startsWith('codex:')) {
      const r2 = resolveCodexUrl(trimmed)
      if (r2) return { type: 'url', value: r2 }
    }
    // WHY: URL / đường dẫn tự nhập (custom avatar) cũng hiện bằng <img>.
    if (lower.startsWith('http') || trimmed.startsWith('/')) return { type: 'url', value: trimmed }
    return { type: 'emoji', value: trimmed }
  }
  // WHY: DiceBear initials — seed = 2 chữ cái đầu (tối đa 2 từ), nền emerald 3 tông.
  const words = displayName.trim().split(/\s+/).filter(Boolean)
  const initials = words.length > 1
    ? (words[0][0] + words[1][0]).toUpperCase()
    : (words[0]?.slice(0, 2) || 'MT').toUpperCase()
  return { type: 'dicebear', value: `https://api.dicebear.com/9.x/initials/svg?seed=${encodeURIComponent(initials)}&backgroundColor=059669,10b981,34d399&radius=50` }
}

// WHY: Khung user ở góc dưới sidebar — avatar + tên lấy từ Supabase. Nhấn vào mở menu
// dropdown: Đổi mật khẩu (modal cập nhật password qua auth.updateUser) và Đăng xuất.
// Đổi mật khẩu xử lý nội bộ (chỉ cần session hiện tại, không cần App biết).
export default function UserMenu({ collapsed, user, onSignOut }: UserMenuProps) {
  const [profile, setProfile] = useState<ProfileInfo | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  // WHY: Modal đổi mật khẩu — open đóng/mở, còn lại là form state. busyRef chống
  // double-submit giống LoginScreen.
  const [pwOpen, setPwOpen] = useState(false)
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [pwError, setPwError] = useState<string | null>(null)
  const [pwMessage, setPwMessage] = useState<string | null>(null)
  const [pwLoading, setPwLoading] = useState(false)
  const busyRef = useRef(false)
  const menuRef = useRef<HTMLDivElement>(null)
  // WHY: Ảnh avatar lỗi (vd slug codex:owl/dino đã bị gỡ upstream → 404) → fallback
  // về emoji theo từ khóa slug thay vì hiện khung ảnh vỡ (giống web getEmojiFallback).
  const [avatarError, setAvatarError] = useState(false)

  // WHY: Lấy thông tin profile (best-effort) khi mount — nếu bảng user_profiles không
  // tồn tại hoặc RLS chặn thì fallback về user_metadata + email. Không gây crash.
  useEffect(() => {
    let disposed = false
    // WHY: Reset cờ lỗi ảnh mỗi khi (re)load profile (vd đăng xuất → đăng nhập user
    // khác) — không để ảnh lỗi của user cũ ảnh hưởng avatar mới.
    setAvatarError(false)
    ;(async () => {
      try {
        const supabase = getSupabase()
        const name = resolveDisplayName(null, user)
        let p: any = null
        if (user) {
          const { data } = await supabase
            .from('user_profiles')
            .select('full_name, nickname, username, avatar_url, avatar_emoji')
            .eq('id', user.id)
            .maybeSingle()
          p = data ?? null
        }
        if (disposed) return
        const displayName = resolveDisplayName(p, user)
        const avatar = resolveAvatar(p, user, displayName)
        setProfile({
          displayName,
          email: user?.email ?? '',
          avatarUrl: avatar.type === 'url' ? avatar.value : avatar.type === 'dicebear' ? avatar.value : null,
          avatarEmoji: avatar.type === 'emoji' ? avatar.value : null,
        })
      } catch {
        if (!disposed) {
          setProfile({
            displayName: resolveDisplayName(null, user),
            email: user?.email ?? '',
            avatarUrl: user?.user_metadata?.avatar_url || null,
            avatarEmoji: null,
          })
        }
      }
    })()
    return () => { disposed = true }
  }, [user])

  // WHY: Đóng menu khi click bên ngoài (chuẩn dropdown) — tránh menu dính mở.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const displayName = profile?.displayName || 'Người dùng'
  const email = profile?.email || ''

  // WHY: Đổi mật khẩu — gọi auth.updateUser({ password }) với session hiện tại (không
  // cần mật khẩu cũ theo cấu hình mặc định). Validate client-side trước khi gọi API.
  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busyRef.current) return
    setPwError(null)
    setPwMessage(null)
    if (newPassword.length < 6) {
      setPwError('Mật khẩu mới phải có ít nhất 6 ký tự')
      return
    }
    if (newPassword !== confirmPassword) {
      setPwError('Mật khẩu xác nhận không khớp')
      return
    }
    busyRef.current = true
    setPwLoading(true)
    try {
      const { error } = await getSupabase().auth.updateUser({ password: newPassword })
      if (error) throw error
      setPwMessage('Đã đổi mật khẩu thành công!')
      setNewPassword('')
      setConfirmPassword('')
      // WHY: Đóng modal sau 1.2s để user kịp đọc thông báo thành công.
      setTimeout(() => { setPwOpen(false); setPwMessage(null) }, 1200)
    } catch (err: any) {
      setPwError(err?.message || 'Đổi mật khẩu thất bại. Vui lòng thử lại.')
    } finally {
      busyRef.current = false
      setPwLoading(false)
    }
  }

  const avatarNode = profile?.avatarUrl && !avatarError ? (
    <img
      src={profile.avatarUrl}
      alt={displayName}
      className="w-8 h-8 rounded-full object-cover shrink-0 bg-emerald-500/20"
      draggable={false}
      onError={() => setAvatarError(true)}
    />
  ) : (
    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-emerald-400 to-emerald-600 flex items-center justify-center text-sm shrink-0">
      {profile?.avatarEmoji ?? emojiFallbackFor(profile?.avatarUrl) }
    </div>
  )

  return (
    <>
      <div className="relative px-2 pb-2" ref={menuRef}>
        <button
          onClick={() => setMenuOpen(o => !o)}
          className={`w-full flex items-center gap-2.5 px-2 py-2 rounded-lg transition-all cursor-pointer border-0 group ${
            menuOpen
              ? 'bg-emerald-500/15'
              : 'hover:bg-black/5 dark:hover:bg-white/5'
          }`}
          title={collapsed ? displayName : undefined}
          aria-label="Menu tài khoản"
          aria-expanded={menuOpen}
        >
          {avatarNode}
          {!collapsed && (
            <div className="min-w-0 flex-1 text-left">
              <div className="text-xs font-semibold truncate" style={{ color: 'var(--fg)' }}>{displayName}</div>
              <div className="text-[10px] truncate" style={{ color: 'var(--fg-dim)' }}>{email}</div>
            </div>
          )}
          {!collapsed && (
            <svg
              className={`transition-transform duration-200 shrink-0 ${menuOpen ? 'rotate-180' : ''}`}
              width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
              style={{ color: 'var(--fg-dim)' }}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          )}
        </button>

        {/* WHY: Dropdown menu — bottom-full để mở HƯỚNG LÊN (sidebar ở sát mép dưới màn
            hình, mở xuống sẽ bị tràn). z-50 cao hơn mọi frame nội dung để không bị che. */}
        {menuOpen && (
          <div
            className={`absolute bottom-full mb-2 rounded-xl border shadow-2xl p-1.5 animate-scale-in z-50 ${
              collapsed ? 'left-0 w-52' : 'left-0 right-0'
            }`}
            style={{ background: 'var(--bg-sidebar)', borderColor: 'var(--border)' }}
          >
            <div className="px-2.5 py-2 border-b" style={{ borderColor: 'var(--border)' }}>
              <div className="text-xs font-semibold truncate" style={{ color: 'var(--fg)' }}>{displayName}</div>
              <div className="text-[10px] truncate mt-0.5" style={{ color: 'var(--fg-dim)' }}>{email}</div>
            </div>
            <button
              onClick={() => { setMenuOpen(false); setPwError(null); setPwMessage(null); setPwOpen(true) }}
              className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-xs font-medium transition-colors cursor-pointer border-0 text-left hover:bg-black/5 dark:hover:bg-white/5"
              style={{ color: 'var(--fg-secondary)' }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <rect x="3" y="11" width="18" height="11" rx="2" />
                <path d="M7 11V7a5 5 0 0110 0v4" />
              </svg>
              Đổi mật khẩu
            </button>
            <button
              onClick={onSignOut}
              className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-xs font-medium text-rose-400 hover:text-rose-300 hover:bg-rose-500/10 transition-colors cursor-pointer border-0 text-left"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
              Đăng xuất
            </button>
          </div>
        )}
      </div>

      {/* WHY: Modal đổi mật khẩu — nền tối nhẹ (không blur) để popup nổi rõ, click nền
          đóng. Form đơn giản: mật khẩu mới + xác nhận (updateUser không cần mật khẩu
          cũ theo cấu hình mặc định của Supabase). */}
      {pwOpen && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40"
          onMouseDown={() => setPwOpen(false)}
        >
          <div
            className="w-full max-w-sm mx-4 rounded-2xl border shadow-2xl p-6 animate-scale-in"
            style={{ background: 'var(--bg-card)', borderColor: 'var(--border)' }}
            onMouseDown={e => e.stopPropagation()}
          >
            <h3 className="text-sm font-bold mb-1" style={{ color: 'var(--fg)' }}>Đổi mật khẩu</h3>
            <p className="text-[11px] mb-4" style={{ color: 'var(--fg-dim)' }}>
              Đặt mật khẩu mới cho tài khoản <span className="font-medium">{email}</span>
            </p>
            <form onSubmit={changePassword} className="space-y-3">
              <div>
                <label className="block text-[11px] font-medium mb-1.5" style={{ color: 'var(--fg-dim)' }}>Mật khẩu mới</label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={e => setNewPassword(e.target.value)}
                  placeholder="Ít nhất 6 ký tự"
                  className="w-full px-3.5 py-2.5 text-sm rounded-xl border transition-all focus:outline-none focus:ring-2 bg-slate-800/60 border-slate-700 text-slate-100 placeholder-slate-500 focus:border-emerald-500 focus:ring-emerald-500/20"
                  autoFocus
                  required
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium mb-1.5" style={{ color: 'var(--fg-dim)' }}>Xác nhận mật khẩu mới</label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={e => setConfirmPassword(e.target.value)}
                  placeholder="Nhập lại mật khẩu mới"
                  className="w-full px-3.5 py-2.5 text-sm rounded-xl border transition-all focus:outline-none focus:ring-2 bg-slate-800/60 border-slate-700 text-slate-100 placeholder-slate-500 focus:border-emerald-500 focus:ring-emerald-500/20"
                  required
                />
              </div>
              {pwError && (
                <div className="px-3 py-2 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-400 text-[11px] leading-relaxed">
                  {pwError}
                </div>
              )}
              {pwMessage && (
                <div className="px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-[11px] leading-relaxed">
                  {pwMessage}
                </div>
              )}
              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setPwOpen(false)}
                  className="flex-1 py-2.5 text-sm font-semibold rounded-xl border transition-colors cursor-pointer hover:bg-black/5 dark:hover:bg-white/5"
                  style={{ color: 'var(--fg-secondary)', borderColor: 'var(--border)' }}
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  disabled={pwLoading}
                  className="flex-1 py-2.5 text-sm font-bold bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-white rounded-xl transition-all active:scale-[0.98] cursor-pointer border-0 shadow-lg shadow-emerald-500/20 flex items-center justify-center gap-2"
                >
                  {pwLoading ? (
                    <>
                      <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                      Đang lưu...
                    </>
                  ) : 'Lưu mật khẩu'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  )
}
