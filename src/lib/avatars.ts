import { API } from '../utils/apiFetch'

// ============================================================================
// AVATARS — hằng số + helper dùng chung cho avatar hệ sinh thái english-topics
// ============================================================================
// WHY: Tập trung mọi logic resolve avatar (linh vật Codex Pets tự-host R2, emoji,
// màu nền) vào 1 module — UserMenu (sidebar) và AvatarPickerDialog (popup đổi
// avatar) dùng chung, không duplicate. Đồng bộ với web project english-topics:
//   - CODEX_PETS_BASE_URL == NEXT_PUBLIC_CODEX_PETS_BASE_URL bên web
//   - AVATAR_BG_OPTIONS[].class == chuỗi class Tailwind v4 (bg-linear-to-br...) mà
//     web lưu vào user_settings.settings_json.avatar_bg → 2 app đọc/ghi tương thích
// ============================================================================

// WHY: Base URL của thư viện linh vật Codex Pets tự-host trên Cloudflare R2 của
// project english-topics (bucket `site-assets-english4tumi`, prefix `codex-pet-avatar`).
// Nếu domain đổi chỉ cần sửa ở đây (giống NEXT_PUBLIC_CODEX_PETS_BASE_URL bên web).
export const CODEX_PETS_BASE_URL = 'https://site-assets-english4tumi.luongphamhanhnguyen.com/codex-pet-avatar'

// WHY: URL pets.json (danh sách linh vật) — R2 trước (nếu CORS cho phép), fallback
// GitHub raw (luôn trả Access-Control-Allow-Origin: *) vì R2 custom domain KHÔNG gửi
// header CORS → browser/webview fetch R2 bị chặn. Ảnh (img tag) không cần CORS nên
// luôn tải từ R2 (nhanh, ổn định).
export const CODEX_PETS_REGISTRY_URLS = [
  `${CODEX_PETS_BASE_URL}/pets.json`,
  'https://raw.githubusercontent.com/legeling/awesome-codex-pet/main/pets.json',
]

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
export function resolveCodexUrl(value: string): string {
  const rawSlug = value.slice('codex:'.length).trim().toLowerCase()
  if (!rawSlug) return ''
  const targetSlug = CODEX_LEGACY_SLUGS[rawSlug] || rawSlug
  return `${CODEX_PETS_BASE_URL}/${targetSlug}/webp/idle.webp`
}

// WHY: Emoji fallback theo từ khóa slug khi ảnh Codex 404 (đồng bộ logic web —
// getEmojiFallback): nhìn slug chứa con gì thì hiện emoji con đó, mặc định 👤.
export function emojiFallbackFor(value: string | null | undefined): string {
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

// WHY: Bộ emoji đơn giản cho tab Emojis — sao chép đúng AVATAR_OPTIONS bên web để
// 2 app hiển thị cùng 1 tập lựa chọn.
export const AVATAR_EMOJIS = [
  '👦', '👧', '🧒', '👶', '🐶', '🐱', '🐰', '🦊',
  '🐻', '🐼', '🐨', '🦁', '🐯', '🐮', '🐷', '🐸',
  '🦄', '🐲', '🌟', '🚀',
] as const

// WHY: Màu nền avatar (8 mẫu: 6 solid + 4 gradient) — class chuỗi GIỐNG HỆT bên web
// (bg-linear-to-br — Tailwind v4) nên lưu vào settings_json.avatar_bg là 2 app đọc
// được lẫn nhau. Mặc định là gradient emerald hiện tại của app.
export interface AvatarBgOption {
  id: string
  name: string
  class: string
}

export const AVATAR_BG_OPTIONS: AvatarBgOption[] = [
  { id: 'solid-green', name: 'Xanh lá', class: 'bg-emerald-500' },
  { id: 'solid-blue', name: 'Xanh dương', class: 'bg-blue-500' },
  { id: 'solid-purple', name: 'Tím', class: 'bg-purple-500' },
  { id: 'solid-orange', name: 'Cam', class: 'bg-orange-500' },
  { id: 'solid-pink', name: 'Hồng', class: 'bg-pink-500' },
  { id: 'solid-yellow', name: 'Vàng', class: 'bg-amber-400' },
  { id: 'grad-ocean', name: 'Đại dương', class: 'bg-linear-to-br from-cyan-400 to-blue-600' },
  { id: 'grad-emerald', name: 'Xanh ngọc', class: 'bg-linear-to-br from-emerald-400 to-teal-600' },
  { id: 'grad-sunset', name: 'Hoàng hôn', class: 'bg-linear-to-br from-orange-400 to-pink-600' },
  { id: 'grad-lavender', name: 'Oải hương', class: 'bg-linear-to-br from-purple-400 to-indigo-600' },
  { id: 'grad-fire', name: 'Ngọn lửa', class: 'bg-linear-to-br from-rose-500 to-orange-500' },
]

// WHY: Mặc định của app — gradient emerald (giữ nguyên giao diện hiện tại) khi user
// chưa chọn màu nền nào. Dùng class Tailwind v4 chuẩn (bg-linear-to-br) để web đọc
// lại được, và cũng nằm trong AVATAR_BG_OPTIONS để app compile.
export const DEFAULT_AVATAR_BG = 'bg-linear-to-br from-emerald-400 to-teal-600'

// WHY: Kiểm tra class nền có nằm trong danh sách hợp lệ không (tránh class lạ từ DB
// không được Tailwind compile → nền trong suốt); không hợp lệ → trả default.
export function safeAvatarBg(bg: string | null | undefined): string {
  if (bg && AVATAR_BG_OPTIONS.some(o => o.class === bg)) return bg
  return DEFAULT_AVATAR_BG
}

// WHY: Fetch danh sách linh vật Codex Pets — thử R2 trước, fallback GitHub raw (xem
// CODEX_PETS_REGISTRY_URLS). Trả mảng { slug, name } (hoặc [] khi cả 2 đều lỗi).
export async function fetchCodexPets(): Promise<{ slug: string; name: string }[]> {
  for (const url of CODEX_PETS_REGISTRY_URLS) {
    try {
      const res = await fetch(url)
      if (!res.ok) continue
      const data = await res.json()
      if (Array.isArray(data) && data.length > 0) {
        return data.map((p: any) => ({
          slug: String(p?.slug ?? '').trim(),
          name: String(p?.name ?? p?.slug ?? ''),
        })).filter(p => p.slug)
      }
    } catch {
      // WHY: R2 chặn CORS sẽ throw TypeError — nhảy sang fallback tiếp theo.
    }
  }
  return []
}

// ---------------------------------------------------------------------------
// LINH VẬT CỤC BỘ (tab "Cục bộ") — file ảnh trong thư mục public/mascots của web
// english-topics trên CÙNG MÁY, đọc qua backend localhost:5050 (không CORS).
// ---------------------------------------------------------------------------

// WHY: Thư mục mặc định — public/mascots của web english-topics (nguồn chân lý giống
// web). Đường dẫn máy thật nên user có thể sửa trong popup; lựa chọn được lưu vào
// settings_json.mascots_dir để lần sau + sidebar render đúng.
export const MASCOTS_DIR_DEFAULT =
  'C:/Users/nguyenthanhdat_pc/Desktop/1_LAM_WEB_HOC_BE_MINH/english-topics_v2_nextjs/public/mascots'

// WHY: Đuôi file ảnh được chấp nhận — đồng bộ với backend + web (png/jpg/jpeg/gif/webp/svg).
const LOCAL_IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']

// WHY: Kiểm tra chuỗi có phải tên file ảnh (vd dog.png) không — dùng để phân biệt
// "linh vật cục bộ" với emoji khi avatar_emoji lưu chỉ tên file (giống web).
export function isImageFileName(v: string): boolean {
  const lower = v.toLowerCase()
  return LOCAL_IMAGE_EXTS.some(ext => lower.endsWith(ext))
}

// WHY: URL ảnh linh vật cục bộ qua backend (localhost:5050 — cùng origin webview nên
// không dính CORS như fetch thẳng web). encodeURIComponent 2 tham số dir + file.
export function localMascotUrl(dir: string, file: string): string {
  return `${API}/mascots/local?dir=${encodeURIComponent(dir)}&file=${encodeURIComponent(file)}`
}

// WHY: Fetch danh sách file ảnh trong thư mục cục bộ (qua backend). Trả [] khi thư
// mục không tồn tại / backend chưa chạy / có lỗi — popup hiện trạng thái trống.
export async function fetchLocalMascots(dir: string): Promise<string[]> {
  try {
    const res = await fetch(`${API}/api/mascots/local?dir=${encodeURIComponent(dir)}`)
    if (!res.ok) return []
    const data = await res.json()
    return Array.isArray(data) ? data.filter((f): f is string => typeof f === 'string') : []
  } catch {
    return []
  }
}

// WHY: Resolve 1 giá trị avatar bất kỳ → cách hiển thị (ảnh/emoji) — dùng chung cho
// preview popup + sidebar. Thứ tự: codex:<slug> → R2; http/path → nguyên URL; tên
// file ảnh (dog.png) → linh vật cục bộ qua backend (chỉ khi truyền mascotsDir —
// popup đổi avatar đã bỏ tab Cục bộ nên gọi 1 tham số); còn lại là emoji.
export function resolveAvatarValue(
  value: string,
  mascotsDir: string = MASCOTS_DIR_DEFAULT,
): { isImage: boolean; src: string; emoji: string } {
  const trimmed = value.trim()
  const lower = trimmed.toLowerCase()
  if (lower.startsWith('codex:')) {
    const r2 = resolveCodexUrl(trimmed)
    if (r2) return { isImage: true, src: r2, emoji: emojiFallbackFor(trimmed) }
  }
  if (lower.startsWith('http') || trimmed.startsWith('/')) {
    return { isImage: true, src: trimmed, emoji: emojiFallbackFor(trimmed) }
  }
  if (isImageFileName(trimmed)) {
    return { isImage: true, src: localMascotUrl(mascotsDir, trimmed), emoji: emojiFallbackFor(trimmed) }
  }
  return { isImage: false, src: '', emoji: trimmed || '👤' }
}
