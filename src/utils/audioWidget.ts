// WHY: Manager singleton cho cửa sổ widget âm thanh — NGUỒN SỰ THẬT DUY NHẤT.
// Cả App.tsx (tray menu) và AudioModule đều dùng manager này để tránh desync trạng thái.
//
// Bug cũ: mỗi nơi tự gọi WebviewWindow.getByLabel() + show(). Sau close(), getByLabel()
// có thể trả về handle window đang CHẾT (destroy bất đồng bộ) — show() trên handle đó
// fail âm thầm → widget không bao giờ hiện lại khi tắt rồi bật.
//
// Giải pháp:
//   1. Trạng thái open/closing/closedAt nằm ở module level (singleton).
//   2. closedAt timestamp để phát hiện window "stale" (vừa đóng trong 2s) →
//      destroy hẳn + chờ biến mất rồi tạo window MỚI, không show() lại handle đáng ngờ.
//   3. Widget.html phát event 'audio-widget-closed' trước khi destroy (nút ✕) —
//      destroy() KHÔNG trigger close-requested nên cần event tường minh.
//   4. Mutex (opChain) tuần tự hóa open/close/toggle — tránh race khi user click nhanh:
//      close() đang await getByLabel mà open() tạo window mới → close() có thể nhắm
//      nhầm window vừa tạo. Với mutex, các op chạy tuần tự, an toàn.

import type { WebviewWindow } from '@tauri-apps/api/webviewWindow'

const WIDGET_LABEL = 'audio-widget'

// WHY: CLOSE_STALE_MS — ngưỡng 2s. Nếu mở lại trong khoảng này sau khi đóng,
// window cũ có thể chưa bị destroy xong (bất đồng bộ) → phải destroy hẳn + tạo mới.
const CLOSE_STALE_MS = 2000

export interface AudioWidgetOptions {
  width: number
  height: number
  alwaysOnTop?: boolean
}

let open = false
let closing = false
let closedAt = 0
const listeners = new Set<(open: boolean) => void>()

// WHY: Promise-chain mutex — mỗi op chờ op trước hoàn tất rồi mới chạy.
// result.then(cleanup) đảm bảo chuỗi không bị gãy dù op trước reject.
let opChain: Promise<unknown> = Promise.resolve()

function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const result = opChain.then(fn, fn)
  opChain = result.then(() => undefined, () => undefined)
  return result
}

// WHY: notify — broadcast trạng thái open mới tới mọi subscriber (đồng bộ UI
// nút toggle ở AudioModule và tray menu). Listener lỗi bị bỏ qua an toàn.
function notify() {
  for (const cb of listeners) {
    try { cb(open) } catch { /* listener lỗi không ảnh hưởng manager */ }
  }
}

// WHY: isAudioWidgetOpen — trạng thái theo dõi nội bộ (authoritative, sync).
// Trả false khi đang trong quá trình đóng.
export function isAudioWidgetOpen(): boolean {
  return open && !closing
}

// WHY: subscribeAudioWidget — AudioModule và App đăng ký để đồng bộ UI
// (nút toggle trong module, menu tray). Trả về hàm hủy đăng ký.
export function subscribeAudioWidget(cb: (open: boolean) => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

// WHY: getModule — dynamic import để không crash khi chạy trong browser dev mode
// (Tauri API chỉ tồn tại trong desktop runtime).
async function getModule() {
  return await import('@tauri-apps/api/webviewWindow')
}

async function getExisting(): Promise<WebviewWindow | null> {
  try {
    const { WebviewWindow } = await getModule()
    return await WebviewWindow.getByLabel(WIDGET_LABEL)
  } catch {
    return null
  }
}

// WHY: waitGone — sau destroy/close, chờ tới khi getByLabel trả về null
// (window thật sự biến mất khỏi registry), timeout tối đa 5000ms.
// Trước đây 2500ms — WebView2 teardown trên Windows có thể lâu hơn, timeout sớm →
// rơi vào nhánh show() lại handle đang chết → "frame trắng" khi mở lại nhanh.
async function waitGone(timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const existing = await getExisting()
    if (!existing) return
    await new Promise(r => setTimeout(r, 100))
  }
}

// WHY: ensureEventBridge — lắng nghe event 'audio-widget-closed' do widget.html phát
// trước khi destroy (nút ✕ trong widget). destroy() KHÔNG trigger close-requested,
// nên cần event tường minh để main window biết widget đã đóng và reset state.
let bridgeReady = false
async function ensureEventBridge() {
  if (bridgeReady) return
  bridgeReady = true
  try {
    const { listen } = await import('@tauri-apps/api/event')
    await listen('audio-widget-closed', () => {
      closedAt = Date.now()
      closing = false
      open = false
      notify()
    })
  } catch { /* browser dev mode — bỏ qua */ }
}

// WHY: readSavedPos — đọc vị trí đã lưu từ localStorage (widget.html lưu khi kéo/đóng)
// để tạo window đúng vị trí cũ, tránh center flash.
function readSavedPos(): { x?: number; y?: number } {
  try {
    const saved = localStorage.getItem('mic_widget_pos')
    if (saved) {
      const p = JSON.parse(saved)
      if (typeof p.x === 'number' && typeof p.y === 'number') {
        return { x: Math.round(p.x), y: Math.round(p.y) }
      }
    }
  } catch {}
  return {}
}

// WHY: openInternal — logic mở thật sự (chạy trong mutex).
// Nếu window còn sống (không stale) → show/focus reuse.
// Nếu window stale (vừa đóng, đang chết) → destroy hẳn + chờ biến mất rồi tạo MỚI.
async function openInternal(opts: AudioWidgetOptions): Promise<boolean> {
  try {
    await ensureEventBridge()
    const { WebviewWindow } = await getModule()

    const existing = await getExisting()
    const stale = (Date.now() - closedAt) < CLOSE_STALE_MS || closing

    // WHY: Window còn sống + không stale → show/focus bình thường (reuse).
    if (existing && !stale) {
      try {
        await existing.show()
        await existing.setFocus()
        open = true
        closing = false
        notify()
        return true
      } catch { /* handle chết → rơi xuống tạo mới */ }
    }

    // WHY: Window stale (đang chết / vừa đóng) → destroy hẳn + chờ biến mất,
    // rồi tạo window MỚI. KHÔNG show() lại handle nghi ngờ.
    if (existing) {
      // WHY: destroy() cần permission core:window:allow-destroy (đã thêm ở capabilities).
      // Destroy tức thì giải phóng label — tránh race "tạo window cùng label khi WebView2
      // cũ đang dỡ" gây ra window trắng không nội dung khi tắt rồi bật nhanh.
      try { await existing.destroy() } catch {
        try { await existing.close() } catch {}
      }
      await waitGone()
      // WHY: Retry destroy lần 2 — handle vừa destroy là async, có thể chưa ăn
      // destroy đầu; nếu chưa biến mất, thử lần nữa trước khi show() fallback.
      const survived = await getExisting()
      if (survived) {
        try { await survived.destroy() } catch {
          try { await survived.close() } catch {}
        }
        await waitGone()
      }
      // WHY: Fallback — nếu destroy không thành công và window vẫn sống (hiếm),
      // show() nó thay vì tạo window trùng label (sẽ throw "label already exists").
      const stillAlive = await getExisting()
      if (stillAlive) {
        try {
          await stillAlive.show()
          await stillAlive.setFocus()
          open = true
          closing = false
          notify()
          return true
        } catch { /* vẫn chết → tạo mới bên dưới */ }
      }
    }
    closing = false

    const pos = readSavedPos()
    const win = new WebviewWindow(WIDGET_LABEL, {
      url: '/widget.html',
      title: 'Mic Widget',
      decorations: false,
      // WHY: KHÔNG dùng transparent:true — transparent window trên Windows hiển thị
      // MÀU ĐEN quanh nội dung khi setSize thay đổi (WebView2 không paint kịp vùng
      // mới / đang resize → khung đen bọc widget). Widget là hình chữ nhật đặc
      // (không bo góc) nên transparent không cần thiết.
      // backgroundColor khớp theme slate tối → mọi khoảng trống (nếu có) hiển thị
      // tối đồng bộ, không lòe đen, không flash trắng khi webview đang tải.
      transparent: false,
      backgroundColor: '#0f172a',
      alwaysOnTop: opts.alwaysOnTop ?? true,
      width: opts.width,
      height: opts.height,
      // WHY: resizable:true — bắt buộc để setSize() hoạt động trên Windows.
      // Tauri v2 bỏ qua setSize() âm thầm khi window decorations:false + resizable:false
      // (tauri#11975/#12168) → resize-handle chỉ co giãn CSS bên trong khung cố định.
      // Window không decoration nên không sợ user kéo viền; setSize JS là kênh duy nhất.
      resizable: true,
      center: !(pos.x !== undefined && pos.y !== undefined),
      x: pos.x,
      y: pos.y,
    })
    open = true
    // WHY: Reset closedAt NGAY SAU khi tạo window mới thành công — nếu không,
    // 2s sau khi mở vẫn bị coi là stale → destroy lại window vừa tạo (flicker).
    closedAt = 0
    notify()

    // WHY: Lắng nghe lifecycle của window mới để giữ state đồng bộ.
    win.once('tauri://created', () => { open = true; notify() })
    win.once('tauri://error', () => { open = false; notify() })
    try {
      win.onCloseRequested(() => {
        closedAt = Date.now()
        open = false
        closing = true
        notify()
      })
    } catch {}
    return true
  } catch {
    open = false
    notify()
    return false
  }
}

// WHY: openAudioWidget — public API, chạy trong mutex để tránh race với close/toggle.
export function openAudioWidget(opts: AudioWidgetOptions): Promise<boolean> {
  return runExclusive(() => openInternal(opts))
}

// WHY: closeInternal — logic đóng thật sự (chạy trong mutex).
// Ghi closedAt để các lần mở sau coi window là stale → tạo mới thay vì reuse.
async function closeInternal(): Promise<void> {
  closing = true
  closedAt = Date.now()
  open = false
  notify()

  const existing = await getExisting()
  if (existing) {
    // WHY: destroy() trước — teardown tức thì, không qua graceful close (WebView2
    // đang hiển thị trắng trong lúc hủy). close() chỉ là fallback nếu destroy không
    // được (browser dev mode thiếu permission).
    try { await existing.destroy() } catch {
      try { await existing.close() } catch {}
    }
  }
  // WHY: Reset closing sau khi đóng xong — window đã biến mất. Trước đây closing
  // kẹt true vĩnh viễn khiến mọi open() sau luôn đi vào nhánh stale (không bao giờ
  // reuse window, cộng thêm thời gian chờ destroy/waitGone).
  closing = false
}

// WHY: closeAudioWidget — public API, chạy trong mutex.
export function closeAudioWidget(): Promise<void> {
  return runExclusive(() => closeInternal())
}

// WHY: toggleInternal — logic toggle dựa trên trạng thái authoritative + window thực.
// Nếu đang mở (hoặc window sống) → đóng. Nếu đóng/stale → mở (tạo mới nếu cần).
async function toggleInternal(opts: AudioWidgetOptions): Promise<boolean> {
  const existing = await getExisting()
  const stale = (Date.now() - closedAt) < CLOSE_STALE_MS || closing

  if (open && !closing) {
    await closeInternal()
    return false
  }
  if (existing && !stale) {
    await closeInternal()
    return false
  }
  return openInternal(opts)
}

// WHY: toggleAudioWidget — public API, chạy trong mutex.
export function toggleAudioWidget(opts: AudioWidgetOptions): Promise<boolean> {
  return runExclusive(() => toggleInternal(opts))
}
