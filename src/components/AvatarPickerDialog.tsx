import { useEffect, useState } from 'react'
import { getSupabase } from '../lib/supabase'
import {
  CODEX_PETS_BASE_URL,
  AVATAR_EMOJIS,
  AVATAR_BG_OPTIONS,
  safeAvatarBg,
  emojiFallbackFor,
  isImageFileName,
  resolveAvatarValue,
  fetchCodexPets,
} from '../lib/avatars'

// WHY: Popup đổi avatar — tham khảo AvatarPickerDialog của web english-topics:
// 2 tab (Codex Pets / Emojis) + preview lớn + chọn màu nền đại diện.
// Lưu 2 thứ về Supabase: user_profiles.avatar_emoji (giá trị avatar — emoji hoặc mã
// codex:<slug>) và user_settings.settings_json.avatar_bg (class màu nền, đúng cấu
// trúc bên web để 2 app đọc/ghi tương thích lẫn nhau).
interface AvatarPickerDialogProps {
  open: boolean
  userId: string
  // WHY: Giá trị avatar hiện tại (avatar_emoji) để khởi tạo lựa chọn — có thể là
  // emoji hoặc `codex:<slug>`.
  currentValue: string | null
  // WHY: Class màu nền hiện tại (settings_json.avatar_bg) — null nếu chưa từng lưu.
  currentBg: string | null
  onClose: () => void
  // WHY: Báo UserMenu biết đã lưu xong (kèm giá trị mới) để refresh avatar sidebar.
  onSaved: (value: string, bg: string) => void
}

type PickerTab = 'codex' | 'emoji'

// WHY: Giá trị mặc định khi chưa có avatar — biểu tượng 👤 như bên web.
const DEFAULT_AVATAR = '👤'

export default function AvatarPickerDialog({
  open, userId, currentValue, currentBg, onClose, onSaved,
}: AvatarPickerDialogProps) {
  const [tab, setTab] = useState<PickerTab>('codex')
  // WHY: Giá trị avatar đang chọn (chưa lưu) — khởi tạo từ avatar hiện tại.
  const [value, setValue] = useState<string>(DEFAULT_AVATAR)
  // WHY: Màu nền đang chọn — khởi tạo từ settings hiện tại (safeAvatarBg chặn class lạ).
  const [bg, setBg] = useState<string>(() => safeAvatarBg(currentBg))
  const [pets, setPets] = useState<{ slug: string; name: string }[]>([])
  const [loadingPets, setLoadingPets] = useState(false)
  const [petsError, setPetsError] = useState(false)
  // WHY: Các slug linh vật bị 404 khi tải ảnh (bị gỡ khỏi upstream) → fallback emoji
  // thay vì hiện khung vỡ (giống logic getEmojiFallback bên web).
  const [brokenPets, setBrokenPets] = useState<Set<string>>(new Set())
  const [previewError, setPreviewError] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  // WHY: Mỗi lần mở popup — reset trạng thái + nạp lại danh sách Codex Pets (fresh),
  // đồng thời đồng bộ lựa chọn với giá trị hiện tại (user có thể đã đổi từ nơi khác).
  useEffect(() => {
    if (!open) return
    setValue(currentValue || DEFAULT_AVATAR)
    setBg(safeAvatarBg(currentBg))
    setPreviewError(false)
    setError(null)
    setSaved(false)
    setBrokenPets(new Set())
    let disposed = false
    ;(async () => {
      setLoadingPets(true)
      setPetsError(false)
      const list = await fetchCodexPets()
      if (disposed) return
      setPets(list)
      setPetsError(list.length === 0)
      setLoadingPets(false)
    })()
    return () => { disposed = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // WHY: Đóng popup khi nhấn ESC (chuẩn modal) — user không phải dùng chuột.
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  const trimmedValue = value.trim()

  // WHY: Resolve giá trị avatar đang chọn sang cách hiển thị (ảnh/emoji) — xử lý cả
  // codex:<slug> → R2 và emoji (dùng chung resolveAvatarValue với sidebar, vẫn hỗ trợ
  // URL/tên file nếu avatar cũ đang lưu dạng đó).
  const resolvedPreview = resolveAvatarValue(trimmedValue)
  const isImage = resolvedPreview.isImage && !!resolvedPreview.src
  const previewSrc = resolvedPreview.src

  // WHY: Tên hiển thị dưới preview — slug pet có tên thật (Firefly...), URL lấy phần
  // cuối đường dẫn, emoji hiện thẳng emoji (giống web activeAvatarName).
  const previewName = (() => {
    if (trimmedValue.toLowerCase().startsWith('codex:')) {
      const slug = trimmedValue.slice(6).trim().toLowerCase()
      const found = pets.find(p => p.slug === slug)
      return found ? found.name : slug
    }
    if (trimmedValue.includes('/') || trimmedValue.includes('.')) {
      return trimmedValue.split('/').pop() || trimmedValue
    }
    return trimmedValue
  })()

  // WHY: Phân nhóm giá trị đang chọn để hiện badge dưới preview (giống web).
  const previewGroup = (() => {
    const v = trimmedValue.toLowerCase()
    if (v.startsWith('codex:')) return 'Thư viện Codex Pets'
    if (isImageFileName(trimmedValue)) return 'Linh vật Cục bộ'
    if ((AVATAR_EMOJIS as readonly string[]).includes(trimmedValue)) return 'Bộ sưu tập Emojis'
    if (v.startsWith('http') || trimmedValue.startsWith('/')) return 'URL ảnh tùy chỉnh'
    return 'Emoji'
  })()

  // WHY: Lưu avatar — update user_profiles.avatar_emoji + (best-effort) màu nền vào
  // user_settings.settings_json.avatar_bg. Nếu bảng user_settings bị RLS chặn thì vẫn
  // lưu được avatar (không làm hỏng luồng chính).
  const handleSave = async () => {
    if (saving) return
    const finalValue = trimmedValue || DEFAULT_AVATAR
    setSaving(true)
    setError(null)
    try {
      const supabase = getSupabase()
      const { error: e1 } = await supabase
        .from('user_profiles')
        .update({ avatar_emoji: finalValue, updated_at: new Date().toISOString() })
        .eq('id', userId)
      if (e1) throw e1
      // WHY: Lưu màu nền — best-effort (user_settings có thể chưa có row → insert).
      try {
        const { data: settings } = await supabase
          .from('user_settings')
          .select('settings_json')
          .eq('user_id', userId)
          .maybeSingle()
        const nextJson = {
          ...((settings?.settings_json as Record<string, unknown>) || {}),
          avatar_bg: bg,
        }
        if (settings) {
          await supabase
            .from('user_settings')
            .update({ settings_json: nextJson, updated_at: new Date().toISOString() })
            .eq('user_id', userId)
        } else {
          await supabase
            .from('user_settings')
            .insert({ user_id: userId, settings_json: nextJson })
        }
      } catch {
        // WHY: RLS/tables chưa tồn tại — không chặn lưu avatar.
      }
      setSaved(true)
      onSaved(finalValue, bg)
      // WHY: Đóng sau 900ms để user kịp thấy trạng thái "Đã lưu ✓" (giống web toast).
      setTimeout(onClose, 900)
    } catch (err: any) {
      setError(err?.message || 'Không lưu được avatar. Vui lòng thử lại.')
    } finally {
      setSaving(false)
    }
  }

  if (!open) return null

  // WHY: Nút chuyển tab (Codex Pets / Emojis) — tab đang chọn nổi bật màu emerald,
  // tab khác mờ; dùng chung cho cả 2 tab để tránh lặp JSX.
  const tabBtn = (t: PickerTab, label: string, icon: string) => (
    <button
      type="button"
      onClick={() => setTab(t)}
      className={`flex-1 py-2 text-xs font-semibold rounded-lg transition-all cursor-pointer border-0 flex items-center justify-center gap-1.5 ${
        tab === t
          ? 'bg-emerald-500/15 text-emerald-400 shadow-sm border border-emerald-500/25'
          : 'text-slate-400 hover:text-slate-200 hover:bg-white/5 border border-transparent'
      }`}
    >
      <span>{icon}</span> {label}
    </button>
  )

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        className="w-full max-w-3xl rounded-2xl border shadow-2xl animate-scale-in flex flex-col max-h-[92vh]"
        style={{ background: 'var(--bg-card)', borderColor: 'var(--border)' }}
        onMouseDown={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b shrink-0" style={{ borderColor: 'var(--border)' }}>
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-sm">🖼️</div>
            <div>
              <h3 className="text-sm font-bold" style={{ color: 'var(--fg)' }}>Đổi avatar</h3>
              <p className="text-[10px]" style={{ color: 'var(--fg-dim)' }}>Chọn linh vật Codex Pets hoặc emoji</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-lg hover:bg-white/10 text-slate-400 hover:text-white transition-colors cursor-pointer border-0 flex items-center justify-center text-base"
            aria-label="Đóng"
          >
            &times;
          </button>
        </div>

        {/* Body: preview trái + tabs phải */}
        <div className="flex-1 overflow-hidden p-4 flex flex-col sm:flex-row gap-4 min-h-0">
          {/* Preview column */}
          <div className="w-full sm:w-60 shrink-0 flex flex-col items-center gap-3.5 rounded-xl border p-4" style={{ borderColor: 'var(--border)' }}>
            <div className="flex flex-col items-center w-full">
              <span className="text-[10px] font-bold uppercase tracking-widest mb-2" style={{ color: 'var(--fg-dim)' }}>Xem trước</span>
              <div
                className={`w-28 h-28 rounded-full flex items-center justify-center text-5xl shadow-xl border border-white/10 overflow-hidden shrink-0 transition-transform duration-200 ${bg}`}
              >
                {isImage && previewSrc && !previewError ? (
                  <img
                    src={previewSrc}
                    alt="avatar-preview"
                    className="w-full h-full object-contain p-1.5"
                    draggable={false}
                    onError={() => setPreviewError(true)}
                  />
                ) : (
                  <span className="select-none">{resolvedPreview.emoji}</span>
                )}
              </div>
              <div className="text-center mt-2.5 w-full">
                <div className="text-xs font-bold truncate max-w-full px-2" style={{ color: 'var(--fg)' }}>{previewName}</div>
                <span className="inline-block px-2.5 py-0.5 mt-1 text-[9px] font-bold rounded-full border" style={{ color: 'var(--fg-dim)', borderColor: 'var(--border)' }}>
                  {previewGroup}
                </span>
              </div>
            </div>

            {/* Màu nền */}
            <div className="w-full pt-3 border-t" style={{ borderColor: 'var(--border)' }}>
              <span className="block text-center text-[10px] font-bold uppercase tracking-widest mb-2" style={{ color: 'var(--fg-dim)' }}>
                Màu nền đại diện
              </span>
              <div className="grid grid-cols-6 gap-1.5">
                {AVATAR_BG_OPTIONS.map(opt => (
                  <button
                    type="button"
                    key={opt.id}
                    onClick={() => setBg(opt.class)}
                    title={opt.name}
                    className={`w-full aspect-square rounded-full border-2 transition-all cursor-pointer ${opt.class} ${
                      bg === opt.class
                        ? 'ring-2 ring-emerald-400 border-white scale-110'
                        : 'border-white/10 hover:scale-105'
                    }`}
                  />
                ))}
              </div>
            </div>
          </div>

          {/* Tabs column */}
          <div className="flex-1 min-h-0 flex flex-col">
            <div className="flex gap-1.5 p-1 rounded-xl shrink-0" style={{ background: 'rgba(255,255,255,0.04)' }}>
              {tabBtn('codex', 'Codex Pets', '🐾')}
              {tabBtn('emoji', 'Emojis', '😀')}
            </div>

            <div className="flex-1 min-h-0 mt-3 overflow-y-auto rounded-xl border p-2" style={{ borderColor: 'var(--border)' }}>
              {tab === 'codex' && (
                loadingPets ? (
                  <div className="h-full min-h-32 flex flex-col items-center justify-center gap-2 text-xs" style={{ color: 'var(--fg-dim)' }}>
                    <span className="w-5 h-5 border-2 border-emerald-400/20 border-t-emerald-400 rounded-full animate-spin" />
                    Đang tải thư viện Codex...
                  </div>
                ) : petsError ? (
                  <div className="h-full min-h-32 flex flex-col items-center justify-center gap-2 text-xs" style={{ color: 'var(--fg-dim)' }}>
                    Không tải được danh sách linh vật.
                    <button
                      type="button"
                      onClick={() => { setLoadingPets(true); setPetsError(false); fetchCodexPets().then(l => { setPets(l); setPetsError(l.length === 0); setLoadingPets(false) }) }}
                      className="px-3 py-1.5 rounded-lg border text-xs font-semibold cursor-pointer transition-colors hover:bg-white/5"
                      style={{ color: 'var(--fg-secondary)', borderColor: 'var(--border)' }}
                    >
                      🔄 Thử lại
                    </button>
                  </div>
                ) : (
                  <div className="grid grid-cols-4 sm:grid-cols-5 gap-2">
                    {pets.map(pet => {
                      const petValue = `codex:${pet.slug}`
                      const selected = trimmedValue === petValue
                      const broken = brokenPets.has(pet.slug)
                      return (
                        <button
                          type="button"
                          key={pet.slug}
                          onClick={() => { setValue(petValue); setPreviewError(false) }}
                          title={pet.name}
                          className={`w-full aspect-square rounded-xl border-2 transition-all duration-150 cursor-pointer flex items-center justify-center overflow-hidden p-0.5 ${
                            selected
                              ? 'border-emerald-400 ring-2 ring-emerald-400/30'
                              : 'border-transparent hover:border-white/20 hover:bg-white/5'
                          }`}
                        >
                          {broken ? (
                            <span className="text-2xl select-none">{emojiFallbackFor(pet.slug)}</span>
                          ) : (
                            <img
                              src={`${CODEX_PETS_BASE_URL}/${pet.slug}/webp/idle.webp`}
                              alt={pet.name}
                              loading="lazy"
                              className="w-full h-full object-contain"
                              draggable={false}
                              onError={() => setBrokenPets(prev => new Set(prev).add(pet.slug))}
                            />
                          )}
                        </button>
                      )
                    })}
                  </div>
                )
              )}

              {tab === 'emoji' && (
                <div className="grid grid-cols-5 sm:grid-cols-6 gap-2">
                  {AVATAR_EMOJIS.map(emoji => (
                    <button
                      type="button"
                      key={emoji}
                      onClick={() => { setValue(emoji); setPreviewError(false) }}
                      className={`w-full aspect-square text-3xl rounded-xl border-2 transition-all duration-150 cursor-pointer flex items-center justify-center hover:bg-white/5 ${
                        trimmedValue === emoji ? 'border-emerald-400 ring-2 ring-emerald-400/30' : 'border-transparent'
                      }`}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              )}

            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2.5 px-5 py-3.5 border-t shrink-0" style={{ borderColor: 'var(--border)' }}>
          {error && (
            <span className="text-[11px] text-rose-400 mr-auto">{error}</span>
          )}
          {saved && (
            <span className="text-[11px] text-emerald-400 mr-auto">✓ Đã lưu!</span>
          )}
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-semibold rounded-xl border transition-colors cursor-pointer hover:bg-white/5"
            style={{ color: 'var(--fg-secondary)', borderColor: 'var(--border)' }}
          >
            Hủy
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="px-5 py-2 text-xs font-bold bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-white rounded-xl transition-all active:scale-[0.98] cursor-pointer border-0 shadow-md shadow-emerald-500/20 flex items-center gap-1.5"
          >
            {saving ? (
              <>
                <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Đang lưu...
              </>
            ) : (
              'Lưu avatar'
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
