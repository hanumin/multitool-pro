import { useEffect, useRef, useState } from 'react'
import { getSupabase } from '../lib/supabase'
import {
  emojiFallbackFor,
  safeAvatarBg,
  resolveAvatarValue,
  MASCOTS_DIR_DEFAULT,
  DEFAULT_AVATAR_BG,
} from '../lib/avatars'
import AvatarPickerDialog from './AvatarPickerDialog'
import type { User } from '@supabase/supabase-js'

interface UserMenuProps {
  collapsed: boolean
  user: User | null
  onSignOut: () => void
}

interface ProfileInfo {
  displayName: string
  email: string
  // WHY: Giá trị avatar THÔ từ DB (emoji / `codex:<slug>` / URL) — cần để truyền lại
  // cho popup đổi avatar khởi tạo lựa chọn đúng (không phải URL đã resolve).
  rawAvatar: string | null
  avatarUrl: string | null
  avatarEmoji: string | null
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
// từ OAuth), rồi avatar_emoji (resolve qua resolveAvatarValue: linh vật Codex
// `codex:<slug>` → R2, URL/đường dẫn tự nhập, tên file ảnh dog.png → linh vật CỤC BỘ
// qua backend, còn lại là emoji), cuối cùng là dịch vụ avatar công cộng DiceBear
// (initials — miễn phí, không cần key) với nền emerald đồng bộ theme app.
function resolveAvatar(profile: any, user: User | null, displayName: string, mascotsDir: string): { type: 'url' | 'emoji' | 'dicebear'; value: string } {
  const meta = user?.user_metadata ?? {}
  const url = profile?.avatar_url || meta.avatar_url
  if (typeof url === 'string' && url.trim().startsWith('http')) return { type: 'url', value: url.trim() }
  const emoji = profile?.avatar_emoji
  if (typeof emoji === 'string' && emoji.trim()) {
    const resolved = resolveAvatarValue(emoji.trim(), mascotsDir)
    if (resolved.isImage) return { type: 'url', value: resolved.src }
    return { type: 'emoji', value: resolved.emoji }
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
  // WHY: Màu nền avatar lấy từ user_settings.settings_json.avatar_bg (bên web cũng
  // đọc/ghi cột này) — dùng cho vòng tròn emoji; safeAvatarBg chặn class lạ từ DB.
  const [avatarBg, setAvatarBg] = useState<string>(DEFAULT_AVATAR_BG)
  // WHY: Thư mục linh vật CỤC BỘ lấy từ settings_json.mascots_dir (được popup đổi
  // avatar lưu) — dùng để render avatar dạng tên file (dog.png) qua backend.
  const [mascotsDir, setMascotsDir] = useState<string>(MASCOTS_DIR_DEFAULT)
  // WHY: Popup đổi avatar — mở khi bấm vào vòng avatar hoặc mục "Đổi avatar" trong
  // dropdown. Popup tự lưu về Supabase rồi báo qua onSaved để refresh sidebar.
  const [pickerOpen, setPickerOpen] = useState(false)

  // WHY: Tải profile + màu nền avatar (best-effort) — tách thành hàm để gọi lại sau
  // khi đổi avatar xong (refresh sidebar) và khi user thay đổi. Không gây crash nếu
  // bảng chưa tồn tại hoặc RLS chặn (fallback user_metadata + email).
  const loadProfile = () => {
    setAvatarError(false)
    ;(async () => {
      try {
        const supabase = getSupabase()
        let p: any = null
        if (user) {
          const { data } = await supabase
            .from('user_profiles')
            .select('full_name, nickname, username, avatar_url, avatar_emoji')
            .eq('id', user.id)
            .maybeSingle()
          p = data ?? null
          // WHY: Lấy màu nền avatar + thư mục linh vật cục bộ (best-effort) từ
          // settings_json — nếu bảng không tồn tại/RLS chặn thì giữ mặc định.
          try {
            const { data: settings } = await supabase
              .from('user_settings')
              .select('settings_json')
              .eq('user_id', user.id)
              .maybeSingle()
            const sjson = settings?.settings_json as Record<string, unknown> | null
            const bg = sjson?.avatar_bg
            if (typeof bg === 'string') setAvatarBg(safeAvatarBg(bg))
            const dir = sjson?.mascots_dir
            if (typeof dir === 'string' && dir.trim()) setMascotsDir(dir.trim())
          } catch {
            // WHY: user_settings không tồn tại/RLS chặn → giữ mặc định.
          }
        }
        const displayName = resolveDisplayName(p, user)
        const avatar = resolveAvatar(p, user, displayName, mascotsDir)
        setProfile({
          displayName,
          email: user?.email ?? '',
          rawAvatar: typeof p?.avatar_emoji === 'string' && p.avatar_emoji.trim() ? p.avatar_emoji : null,
          avatarUrl: avatar.type === 'url' ? avatar.value : avatar.type === 'dicebear' ? avatar.value : null,
          avatarEmoji: avatar.type === 'emoji' ? avatar.value : null,
        })
      } catch {
        setProfile({
          displayName: resolveDisplayName(null, user),
          email: user?.email ?? '',
          rawAvatar: null,
          avatarUrl: user?.user_metadata?.avatar_url || null,
          avatarEmoji: null,
        })
      }
    })()
  }

  // WHY: Load profile khi mount + mỗi khi user đổi (vd đăng nhập tài khoản khác).
  useEffect(() => { loadProfile() }, [user])

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

  // WHY: Vòng avatar — NHẤN VÀO mở popup đổi avatar (span onClick + stopPropagation
  // để không bật dropdown bên ngoài). Ảnh (codex/URL) phủ nền emerald mờ; emoji hiển
  // thị trên màu nền avatar_bg đã chọn (safeAvatarBg). Hover hiện vòng ring + icon
  // camera nhỏ gợi ý "bấm để đổi".
  const avatarNode = (
    <span
      role="button"
      tabIndex={0}
      onClick={e => { e.stopPropagation(); setPickerOpen(true) }}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); setPickerOpen(true) } }}
      className={`relative w-8 h-8 rounded-full shrink-0 cursor-pointer transition-all duration-200 group/avatar ${
        !avatarError && profile?.avatarUrl ? '' : avatarBg
      } ${menuOpen ? '' : 'hover:ring-2 hover:ring-emerald-400/70'}`}
      title="Đổi avatar"
      aria-label="Đổi avatar"
    >
      {!avatarError && profile?.avatarUrl ? (
        <img
          src={profile.avatarUrl}
          alt={displayName}
          className="w-8 h-8 rounded-full object-cover shrink-0 bg-emerald-500/20"
          draggable={false}
          onError={() => setAvatarError(true)}
        />
      ) : (
        <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm ${avatarBg}`}>
          {profile?.avatarEmoji ?? emojiFallbackFor(profile?.rawAvatar)}
        </div>
      )}
      {/* WHY: Icon camera nhỏ góc phải dưới khi hover — gợi ý có thể đổi avatar. */}
      <span className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full bg-emerald-500 border border-white/20 flex items-center justify-center opacity-0 group-hover/avatar:opacity-100 transition-opacity">
        <svg width="7" height="7" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth={3}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z" />
          <circle cx="12" cy="13" r="4" />
        </svg>
      </span>
    </span>
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
            {/* WHY: Mục "Đổi avatar" trong dropdown — mở cùng popup đổi avatar (cách
                thứ 2 ngoài bấm trực tiếp vào vòng avatar). */}
            <button
              onClick={() => { setMenuOpen(false); setPickerOpen(true) }}
              className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-xs font-medium transition-colors cursor-pointer border-0 text-left hover:bg-black/5 dark:hover:bg-white/5"
              style={{ color: 'var(--fg-secondary)' }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 10v6M18 13h6" />
              </svg>
              Đổi avatar
            </button>
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

      {/* WHY: Popup đổi avatar — mở bằng cách bấm vòng avatar hoặc mục "Đổi avatar".
          Sau khi lưu (onSaved) → load lại profile + màu nền để sidebar cập nhật ngay. */}
      <AvatarPickerDialog
        open={pickerOpen}
        userId={user?.id ?? ''}
        currentValue={profile?.rawAvatar ?? null}
        currentBg={avatarBg}
        currentMascotsDir={mascotsDir}
        onClose={() => setPickerOpen(false)}
        onSaved={() => { setPickerOpen(false); loadProfile() }}
      />

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
