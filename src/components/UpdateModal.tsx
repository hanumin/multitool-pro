import { useState } from 'react'

// WHY: Các trạng thái (phase) của luồng cập nhật — 1 popup duy nhất xử lý cả kiểm
// tra lẫn cài đặt (chuẩn thiết kế update prompt quốc tế: không ngắt giữa chừng, luôn
// có trạng thái rõ ràng + nút thoát). checking/available/downloading/installing/
// done/latest/error đủ cho mọi trường hợp từ lúc bấm "Kiểm tra cập nhật".
export type UpdatePhase =
  | 'checking'
  | 'available'
  | 'downloading'
  | 'installing'
  | 'done'
  | 'latest'
  | 'error'

export interface UpdateInfo {
  version: string
  date?: string
  body?: string
}

interface UpdateModalProps {
  open: boolean
  animState: 'enter' | 'exit'
  phase: UpdatePhase
  currentVersion: string
  update: UpdateInfo | null
  progress: { percent: number; downloaded: number; total: number }
  error?: string
  onClose: () => void
  onInstall: () => void
  onRetry: () => void
  onViewChangelog: () => void
}

// WHY: Popup auto-update — thiết kế theo chuẩn UX update dialog của các app lớn
// (VS Code, Discord, Slack): 1 câu mô tả "có gì mới", 2 hành động rõ ràng
// ("Cập nhật ngay" / "Để sau"), progress bar thực tế khi tải, trạng thái cài đặt
// trước khi relaunch (user thấy rõ app sắp khởi động lại), và nút retry khi lỗi.
// Màu slate cố định (không theo theme) để popup hệ thống luôn nhất quán + nổi bật.
export default function UpdateModal({
  open, animState, phase, currentVersion, update, progress, error,
  onClose, onInstall, onRetry, onViewChangelog,
}: UpdateModalProps) {
  // WHY: Tab changelog trong popup — bấm "Có gì mới" mở rộng xem chi tiết ngay
  // trong popup (không phải mở modal khác chồng lên).
  const [showNotes, setShowNotes] = useState(false)

  if (!open && animState !== 'exit') return null

  // WHY: Định dạng dung lượng cho progress bar — hiển thị KB/MB thân thiện thay vì
  // số byte thô (chuẩn UX download dialog: user cần biết đã tải bao nhiêu / tổng bao
  // nhiêu, không cần độ chính xác byte).
  const fmtBytes = (b: number) => {
    if (b <= 0) return '0 KB'
    const mb = b / (1024 * 1024)
    if (mb < 1) return `${Math.round(b / 1024)} KB`
    return `${mb.toFixed(1)} MB`
  }

  // WHY: Render nội dung chính theo phase — mỗi trạng thái (checking/available/
  // downloading/installing/done/latest/error) có icon + mô tả + hành động riêng.
  // Tách thành hàm để JSX chính ngắn gọn, dễ theo dõi luồng update.
  const renderBody = () => {
    switch (phase) {
      case 'checking':
        return (
          <div className="flex flex-col items-center py-6">
            <div className="w-12 h-12 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center mb-4">
              <div className="w-6 h-6 border-[3px] border-emerald-400/20 border-t-emerald-400 rounded-full animate-spin" />
            </div>
            <p className="text-sm font-semibold text-white">Đang kiểm tra cập nhật...</p>
            <p className="text-xs text-slate-400 mt-1.5">So sánh phiên bản hiện tại với bản mới nhất trên GitHub</p>
          </div>
        )

      case 'latest':
        return (
          <div className="flex flex-col items-center py-6 text-center">
            <div className="w-12 h-12 rounded-2xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-2xl mb-4">✅</div>
            <p className="text-sm font-bold text-white">Bạn đang dùng phiên bản mới nhất</p>
            <p className="text-xs text-slate-400 mt-1.5">
              MultiTool Pro <span className="font-mono text-emerald-400 font-bold">v{currentVersion}</span> — không cần cập nhật.
            </p>
          </div>
        )

      case 'available':
        return (
          <div className="space-y-4">
            <div className="flex items-center gap-3.5">
              <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-emerald-500/20 to-sky-500/15 border border-emerald-500/30 flex items-center justify-center text-2xl shrink-0 shadow-md">🚀</div>
              <div>
                <p className="text-sm font-bold text-white">Có bản cập nhật mới</p>
                <p className="text-xs text-slate-400 mt-0.5">
                  <span className="font-mono text-slate-500 line-through">v{currentVersion}</span>
                  <span className="mx-1.5 text-slate-500">→</span>
                  <span className="font-mono text-emerald-400 font-bold">v{update?.version ?? ''}</span>
                </p>
              </div>
            </div>

            <div className="p-3.5 rounded-xl bg-slate-800/50 border border-slate-800 text-xs text-slate-300 leading-relaxed">
              <span className="font-bold text-emerald-400">Có gì mới: </span>
              {update?.body ? (
                <span className="whitespace-pre-line">{update.body}</span>
              ) : (
                <span>Bản cập nhật này mang đến cải tiến hiệu năng, sửa lỗi và các tính năng mới. Thời gian tải khoảng 1-2 phút tùy kết nối.</span>
              )}
            </div>

            {update?.body && (
              <button onClick={() => setShowNotes(s => !s)}
                className="text-[11px] font-semibold text-emerald-400 hover:text-emerald-300 transition-colors bg-transparent border-0 cursor-pointer flex items-center gap-1">
                {showNotes ? '▾ Thu gọn ghi chú phát hành' : '▸ Xem ghi chú phát hành đầy đủ'}
              </button>
            )}
            {showNotes && update?.body && (
              <div className="max-h-32 overflow-y-auto p-3 rounded-xl bg-slate-900/80 border border-slate-800 text-[11px] text-slate-400 whitespace-pre-line">
                {update.body}
              </div>
            )}
          </div>
        )

      case 'downloading': {
        const pct = Math.min(100, progress.percent)
        return (
          <div className="space-y-4">
            <div className="flex items-center gap-3.5">
              <div className="w-12 h-12 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center mb-1 shrink-0">
                <div className="w-5 h-5 border-[3px] border-emerald-400/20 border-t-emerald-400 rounded-full animate-spin" />
              </div>
              <div>
                <p className="text-sm font-bold text-white">Đang tải bản cập nhật v{update?.version}</p>
                <p className="text-xs text-slate-400 mt-0.5">{fmtBytes(progress.downloaded)} / {fmtBytes(progress.total)}</p>
              </div>
            </div>
            <div className="h-2.5 rounded-full bg-slate-800 overflow-hidden">
              <div className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-teal-400 transition-all duration-300"
                style={{ width: `${pct}%` }} />
            </div>
            <p className="text-[11px] font-mono text-emerald-400 text-right">{pct}%</p>
          </div>
        )
      }

      case 'installing':
        return (
          <div className="flex flex-col items-center py-6 text-center">
            <div className="w-12 h-12 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center mb-4">
              <div className="w-6 h-6 border-[3px] border-emerald-400/20 border-t-emerald-400 rounded-full animate-spin" />
            </div>
            <p className="text-sm font-bold text-white">Đang cài đặt...</p>
            <p className="text-xs text-slate-400 mt-1.5 leading-relaxed">
              App sẽ tự động đóng và khởi động lại với phiên bản mới.
              <br />Vui lòng không tắt máy trong lúc này.
            </p>
          </div>
        )

      case 'done':
        return (
          <div className="flex flex-col items-center py-6 text-center">
            <div className="w-12 h-12 rounded-2xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-2xl mb-4">🎉</div>
            <p className="text-sm font-bold text-white">Cập nhật thành công!</p>
            <p className="text-xs text-slate-400 mt-1.5">
              Đã cài đặt <span className="font-mono text-emerald-400 font-bold">v{update?.version}</span>. App sẽ khởi động lại ngay bây giờ.
            </p>
          </div>
        )

      case 'error':
        return (
          <div className="flex flex-col items-center py-6 text-center">
            <div className="w-12 h-12 rounded-2xl bg-rose-500/15 border border-rose-500/30 flex items-center justify-center text-2xl mb-4">⚠️</div>
            <p className="text-sm font-bold text-white">Không thể cập nhật</p>
            <p className="text-xs text-slate-400 mt-1.5 leading-relaxed max-w-xs break-words">
              {error || 'Đã xảy ra lỗi không mong muốn khi kiểm tra hoặc tải bản cập nhật.'}
            </p>
            <p className="text-[11px] text-slate-500 mt-2">Bạn vẫn có thể tiếp tục sử dụng phiên bản hiện tại.</p>
          </div>
        )

      default:
        return null
    }
  }

  // WHY: Render hành động ở footer theo phase — available có "Để sau/Cập nhật ngay",
  // error có "Đóng/Thử lại", done/latest chỉ có "OK". Trả null (không có footer) khi
  // đang tải/cài đặt vì không nên cho user tương tác giữa chừng.
  const renderFooter = () => {
    switch (phase) {
      case 'available':
        return (
          <div className="flex gap-2.5">
            <button onClick={onClose}
              className="flex-1 px-4 py-2 text-xs font-semibold border rounded-xl transition-all active:scale-95 cursor-pointer hover:bg-slate-800"
              style={{ backgroundColor: 'transparent', borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}>
              Để sau
            </button>
            <button onClick={onInstall}
              className="flex-[1.6] px-4 py-2 text-xs font-bold bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl transition-all active:scale-95 cursor-pointer border-0 shadow-md shadow-emerald-500/20 flex items-center justify-center gap-1.5">
              ⬇️ Cập nhật ngay
            </button>
          </div>
        )
      case 'error':
        return (
          <div className="flex gap-2.5">
            <button onClick={onClose}
              className="flex-1 px-4 py-2 text-xs font-semibold border rounded-xl transition-all active:scale-95 cursor-pointer hover:bg-slate-800"
              style={{ backgroundColor: 'transparent', borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}>
              Đóng
            </button>
            <button onClick={onRetry}
              className="flex-[1.4] px-4 py-2 text-xs font-bold bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl transition-all active:scale-95 cursor-pointer border-0 shadow-md shadow-emerald-500/20">
              🔄 Thử lại
            </button>
          </div>
        )
      case 'done':
      case 'latest':
        return (
          <button onClick={onClose}
            className="flex-1 px-4 py-2 text-xs font-bold bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl transition-all active:scale-95 cursor-pointer border-0 shadow-md shadow-emerald-500/20">
            OK
          </button>
        )
      case 'checking':
        return (
          <button onClick={onClose}
            className="flex-1 px-4 py-2 text-xs font-semibold border rounded-xl transition-all active:scale-95 cursor-pointer hover:bg-slate-800"
            style={{ backgroundColor: 'transparent', borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}>
            Đóng
          </button>
        )
      default:
        return null
    }
  }

  // WHY: Trong lúc tải/cài đặt không cho đóng popup (chuẩn update flow) — tránh user
  // đóng giữa chừng làm hỏng quá trình cài. Nút × và backdrop click vẫn hoạt động ở
  // các phase khác.
  const dismissible = !['downloading', 'installing'].includes(phase)

  return (
    <div
      className={`fixed inset-0 z-[100000] flex items-center justify-center bg-black/65 backdrop-blur-md p-4 ${
        animState === 'enter' ? 'animate-modal-in' : 'animate-modal-out'
      }`}
      onClick={e => {
        if (dismissible && e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className={`w-full max-w-md rounded-2xl border shadow-2xl overflow-hidden bg-slate-900 border-slate-800 text-slate-100 ${
          animState === 'enter' ? 'animate-modal-content-in' : 'animate-modal-content-out'
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-800 bg-slate-950/60">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-emerald-500/20 to-sky-500/20 border border-emerald-500/30 flex items-center justify-center text-sm">🔄</div>
            <div>
              <h3 className="text-sm font-bold text-white leading-tight">Cập nhật MultiTool Pro</h3>
              <p className="text-[10px] text-slate-500">
                {phase === 'available' ? `Bản mới: v${update?.version}` : `Phiên bản hiện tại: v${currentVersion}`}
              </p>
            </div>
          </div>
          {dismissible && (
            <button onClick={onClose}
              className="w-7 h-7 rounded-lg bg-slate-800/80 hover:bg-slate-700 text-slate-400 hover:text-white transition-colors cursor-pointer border-0 flex items-center justify-center text-base">
              &times;
            </button>
          )}
        </div>

        {/* Body */}
        <div className="px-5 py-4">
          {renderBody()}

          {/* Xem nhật ký thay đổi khi có bản mới */}
          {phase === 'available' && (
            <button onClick={onViewChangelog}
              className="w-full mt-3 py-1.5 text-[11px] font-semibold rounded-lg border border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-500 transition-colors cursor-pointer bg-transparent">
              📋 Xem đầy đủ nhật ký thay đổi
            </button>
          )}
        </div>

        {/* Footer */}
        {renderFooter() && (
          <div className="px-5 py-3.5 border-t border-slate-800 bg-slate-950/60">
            {renderFooter()}
          </div>
        )}
      </div>
    </div>
  )
}
