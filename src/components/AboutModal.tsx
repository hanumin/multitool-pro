import { useState } from 'react'

interface AboutModalProps {
  open: boolean
  animState: 'enter' | 'exit'
  onClose: () => void
  version: string
}

// WHY: Modal "Giới thiệu" — tabs overview/modules, hỗ trợ enter/exit animation
// (giữ component khi animState='exit' để chạy fade-out trước khi unmount).
export default function AboutModal({ open, animState, onClose, version }: AboutModalProps) {
  const [activeTab, setActiveTab] = useState<'overview' | 'modules'>('overview')

  if (!open && animState !== 'exit') return null

  const MODULES_LIST = [
    {
      icon: '🖥️',
      name: 'Máy chủ (Servers)',
      badge: 'Quản lý Web Services',
      color: 'from-emerald-500/20 to-teal-500/10 border-emerald-500/30 text-emerald-400',
      desc: 'Quản lý & chạy các dự án web (Next.js, Vite, React, Node, Python, Static). Tự động quét cổng mạng (Ports), theo dõi dung lượng RAM/CPU, live terminal log với màu tùy chỉnh và tích hợp Cloudflare Tunnel.'
    },
    {
      icon: '🖨️',
      name: 'Máy in (Printers)',
      badge: 'Quản lý Thiết bị In',
      color: 'from-sky-500/20 to-blue-500/10 border-sky-500/30 text-sky-400',
      desc: 'Bảng điều khiển máy in Windows (WMI). Giám sát trạng thái Online/Offline, kiểm tra DPI, tốc độ in, số trang, in thử nghiệm (Test Print), ghi nhận lịch sử in và hỗ trợ Xuất/Nhập JSON dữ liệu.'
    },
    {
      icon: '🎙️',
      name: 'Âm thanh (Studio Audio)',
      badge: 'Giám sát Microphone',
      color: 'from-amber-500/20 to-orange-500/10 border-amber-500/30 text-amber-400',
      desc: 'Trung tâm Studio âm thanh với bộ lọc sóng âm (Equalizer Spectrum) thời gian thực. Tự động nhận diện ứng dụng đang thu âm, đồng hồ đếm phiên ghi âm và tùy chỉnh độ mờ/màu sắc Widget nổi.'
    },
    {
      icon: '🌐',
      name: 'Cloudflare Tunnel',
      badge: 'Bảo mật Đường truyền',
      color: 'from-indigo-500/20 to-purple-500/10 border-indigo-500/30 text-indigo-400',
      desc: 'Quản lý daemon cloudflared, kiểm tra kết nối tunnel bảo mật, tạo tên miền public công khai cho local server mà không cần mở port router (NAT/Port Forwarding).'
    },
    {
      icon: '🗄️',
      name: 'Cơ sở dữ liệu (Database)',
      badge: 'SQL Management',
      color: 'from-cyan-500/20 to-teal-500/10 border-cyan-500/30 text-cyan-400',
      desc: 'Quản lý và kết nối nhiều loại CSDL (SQLite, PostgreSQL, MySQL). Trình soạn thảo & thực thi câu lệnh SQL, xem danh sách bảng/dữ liệu và xuất kết quả tiện lợi.'
    },
    {
      icon: '📋',
      name: 'Nhật ký (Terminal Logs)',
      badge: 'Giám sát Log tập trung',
      color: 'from-violet-500/20 to-fuchsia-500/10 border-violet-500/30 text-violet-400',
      desc: 'Theo dõi toàn bộ dòng log tập trung từ các máy chủ và dịch vụ. Hỗ trợ lọc theo cấp độ (Error, Warn, Info), tùy chỉnh màu sắc dòng chẵn/lẻ, tìm kiếm từ khóa và tạm dừng cuộn.'
    },
    {
      icon: '📂',
      name: 'Sao chép Tệp (File Copier)',
      badge: 'Đồng bộ Tập tin',
      color: 'from-rose-500/20 to-pink-500/10 border-rose-500/30 text-rose-400',
      desc: 'Bộ công cụ sao chép & đồng bộ tập tin hàng loạt giữa các thư mục dự án với bộ lọc định dạng mở rộng (extension filters) và theo dõi tiến trình sao chép theo thời gian thực.'
    }
  ]

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/65 backdrop-blur-md p-4 ${
        animState === 'enter' ? 'animate-modal-in' : 'animate-modal-out'
      }`}
      onClick={e => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className={`w-full max-w-2xl rounded-2xl border shadow-2xl transition-all overflow-hidden flex flex-col max-h-[85vh] bg-slate-900 border-slate-800 text-slate-100 ${
          animState === 'enter' ? 'animate-modal-content-in' : 'animate-modal-content-out'
        }`}
      >
        {/* Header Bar */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-950/60 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500/20 to-sky-500/20 border border-emerald-500/30 flex items-center justify-center text-xl shadow-sm">
              ⚡
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-bold text-white tracking-tight">Giới thiệu MultiTool Pro</h3>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 font-bold">
                  v{version}
                </span>
              </div>
              <p className="text-xs text-slate-400">Ứng dụng Quản trị Hệ thống & Dịch vụ Nội bộ</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-xl bg-slate-800/80 hover:bg-slate-700 text-slate-400 hover:text-white transition-colors cursor-pointer border-0 flex items-center justify-center text-lg"
          >
            &times;
          </button>
        </div>

        {/* Tab Selection */}
        <div className="flex border-b border-slate-800 bg-slate-950/40 px-6 pt-2 shrink-0 gap-2">
          <button
            onClick={() => setActiveTab('overview')}
            className={`px-4 py-2 text-xs font-semibold rounded-t-xl transition-all cursor-pointer border-b-2 ${
              activeTab === 'overview'
                ? 'border-emerald-400 text-emerald-400 bg-slate-900'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            👤 Thông tin Tác giả & Quyền hạn
          </button>
          <button
            onClick={() => setActiveTab('modules')}
            className={`px-4 py-2 text-xs font-semibold rounded-t-xl transition-all cursor-pointer border-b-2 ${
              activeTab === 'modules'
                ? 'border-emerald-400 text-emerald-400 bg-slate-900'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            🧩 Danh sách Tab & Chức năng ({MODULES_LIST.length})
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="p-6 overflow-y-auto space-y-4 flex-1">
          {activeTab === 'overview' ? (
            <div className="space-y-4">
              {/* Author Hero Card */}
              <div className="p-5 rounded-2xl bg-gradient-to-r from-emerald-950/40 via-slate-900 to-sky-950/40 border border-slate-800 relative overflow-hidden">
                <div className="absolute top-0 right-0 w-40 h-40 bg-emerald-500/10 rounded-full blur-3xl pointer-events-none" />
                <div className="flex items-start gap-4 relative z-10">
                  <div className="w-14 h-14 rounded-2xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-2xl shrink-0 shadow-md">
                    👨‍💻
                  </div>
                  <div className="space-y-1">
                    <span className="text-[10px] uppercase font-bold tracking-wider text-emerald-400">Tác giả phát triển</span>
                    <h4 className="text-lg font-bold text-white">Nguyễn Thành Đạt</h4>
                    <p className="text-xs text-slate-300 leading-relaxed">
                      Phát triển ứng dụng chuyên dụng phục vụ công tác quản trị máy chủ, dịch vụ web, máy in và hệ thống nội bộ.
                    </p>
                  </div>
                </div>
              </div>

              {/* Internal Application Notice */}
              <div className="p-4 rounded-2xl bg-amber-500/10 border border-amber-500/25 flex items-start gap-3">
                <span className="text-xl shrink-0">🔒</span>
                <div>
                  <h5 className="text-xs font-bold text-amber-400 uppercase tracking-wider mb-1">Ứng dụng Nội bộ (Internal Corporate Software)</h5>
                  <p className="text-xs text-slate-300 leading-relaxed">
                    Đây là ứng dụng được thiết kế và đóng gói riêng cho mục đích lưu hành nội bộ. Mọi quyền truy cập, vận hành và phân phối đều được quản lý trực tiếp bởi tác giả.
                  </p>
                </div>
              </div>

              {/* Application Details Grid */}
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="p-3.5 rounded-xl bg-slate-800/40 border border-slate-800/80 space-y-1">
                  <span className="text-[11px] text-slate-400">Nền tảng công nghệ:</span>
                  <p className="font-bold text-slate-200">Tauri v2 + Rust + React + Vite + Python Backend</p>
                </div>
                <div className="p-3.5 rounded-xl bg-slate-800/40 border border-slate-800/80 space-y-1">
                  <span className="text-[11px] text-slate-400">Chế độ vận hành:</span>
                  <p className="font-bold text-emerald-400">Windows Desktop Native & Sub-process Backend</p>
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {MODULES_LIST.map((mod, idx) => (
                <div
                  key={idx}
                  className="p-4 rounded-2xl bg-slate-800/40 border border-slate-800 hover:border-slate-700 transition-all space-y-2"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                      <span className="text-xl">{mod.icon}</span>
                      <h4 className="text-sm font-bold text-white">{mod.name}</h4>
                    </div>
                    <span className={`text-[10px] font-bold px-2.5 py-0.5 rounded-full border bg-gradient-to-r ${mod.color}`}>
                      {mod.badge}
                    </span>
                  </div>
                  <p className="text-xs text-slate-300 leading-relaxed pl-8">
                    {mod.desc}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 border-t border-slate-800 bg-slate-950/80 flex items-center justify-between text-xs text-slate-400 shrink-0">
          <span>© 2026 Nguyễn Thành Đạt · MultiTool Pro Internal System</span>
          <button
            onClick={onClose}
            className="px-5 py-1.5 font-semibold bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl transition-all cursor-pointer border-0 shadow-sm"
          >
            Đóng
          </button>
        </div>
      </div>
    </div>
  )
}
