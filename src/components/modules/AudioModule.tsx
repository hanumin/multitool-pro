import { useState, useEffect, useCallback, useRef } from 'react'
import { AudioDevice, MicStatus, type PreloadedData } from '../../types'

import { API, fetchWithRetry } from '../../utils/apiFetch'
import { useToast } from '../../components/ToastManager'
import { openAudioWidget, toggleAudioWidget, isAudioWidgetOpen, subscribeAudioWidget } from '../../utils/audioWidget'
import { invoke } from '@tauri-apps/api/core'


interface AudioSession {
  datetime: string
  duration: number
  app_using: string
  mic_name: string
}

interface AudioSettings {
  sound_enabled: boolean
  selected_sound: string | null
  icon_theme: string
  color_mic_on: string
  color_mic_off: string
  show_widget_on_mic: boolean
  always_on_top: boolean
  widget_opacity: number
  widget_width?: number
  widget_height?: number
  pos_x?: number
  pos_y?: number
}

interface AudioModuleProps {
  theme: 'dark' | 'light'
  setStatusText: (t: string) => void
  inactive?: boolean
  backgroundPolling?: boolean
  onBackgroundPollingChange?: (enabled: boolean) => void
  preloadedData?: PreloadedData
}

// WHY: Module quản lý âm thanh — mic status, devices, timer, widget.
// Polling: fetchAll 30s, fetchMicStatus 5s.
// Widget: cửa sổ Tauri thứ 2 (audio-widget) độc lập với main window, tồn tại khi app thu nhỏ.
export default function AudioModule({ theme, setStatusText, inactive, backgroundPolling, onBackgroundPollingChange, preloadedData }: AudioModuleProps) {
  const { addToast } = useToast()
  const pollAbortRef = useRef<AbortController | null>(null)
  const [micStatus, setMicStatus] = useState<MicStatus | null>(null)
  // WHY: Dùng preloaded data để skip loading flash.
  const preloadedDevices = preloadedData?.audioDevices?.devices
  const preloadedAudioSettings = preloadedData?.audioSettings
  const [devices, setDevices] = useState<AudioDevice[]>(preloadedDevices || [])
  const [selectedDevice, setSelectedDevice] = useState<string | null>(null)
  const [volume, setVolume] = useState(0)
  const [muted, setMuted] = useState(false)
  
  // Timer features
  const [sessionTimer, setSessionTimer] = useState(0)
  const [lastSessionDuration, setLastSessionDuration] = useState(0)
  const previousWasActiveRef = useRef(false)
  const sessionTimerRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const audioSettingsRef = useRef<AudioSettings>({
    sound_enabled: true, selected_sound: null, icon_theme: '1',
    color_mic_on: '#008000', color_mic_off: '#c3063c',
    show_widget_on_mic: false, always_on_top: true, widget_opacity: 1.0,
    widget_width: 220, widget_height: 220
  })
  
  // Settings & customization
  const [audioSettings, setAudioSettings] = useState<AudioSettings>({
    sound_enabled: true, selected_sound: null, icon_theme: '1',
    color_mic_on: '#008000', color_mic_off: '#c3063c',
    show_widget_on_mic: false, always_on_top: true, widget_opacity: 1.0,
    widget_width: 220, widget_height: 220,
    ...((preloadedAudioSettings as Partial<AudioSettings>) || {}),
  })
  const [soundFiles, setSoundFiles] = useState<string[]>([])
  const [sessionHistory, setSessionHistory] = useState<AudioSession[]>([])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  // WHY: Guard chống bấm nhiều lần nút set-default — request set-default có thể mất
  // 1-5s (backend retry verify). Trước đây bấm liên tục → nhiều POST song song cùng
  // thao tác COM trên thiết bị âm thanh → tranh chấp, treo, phải bấm lại nhiều lần.
  const [settingDefaultId, setSettingDefaultId] = useState<string | null>(null)
  // WHY: Ref đồng bộ với state — chặn double-click trong cùng 1 tick (React state
  // cập nhật bất đồng bộ, 2 click rất nhanh có thể cùng đọc settingDefaultId=null).
  const settingDefaultRef = useRef<string | null>(null)
  
  // Widget mode: sử dụng Tauri WebviewWindow (cửa sổ phụ) thay vì fixed div trong app
  const [widgetOpen, setWidgetOpen] = useState(false)
  const widgetOpenRef = useRef(false)

  // WHY: Backend health status — hiển thị trong header để user biết backend có chạy không
  const [backendStatus, setBackendStatus] = useState<'checking' | 'running' | 'stopped'>('checking')

  // WHY: Kiểm tra backend health - gọi từ Tauri command
  const checkBackendHealth = useCallback(async () => {
    try {
      const healthy = await invoke<boolean>('check_backend_health')
      setBackendStatus(healthy ? 'running' : 'stopped')
    } catch {
      setBackendStatus('stopped')
    }
  }, [])

  // WHY: Chạy health check khi mount và mỗi 30s
  useEffect(() => {
    checkBackendHealth()
    const interval = setInterval(checkBackendHealth, 30000)
    return () => clearInterval(interval)
  }, [checkBackendHealth])

  // WHY: Tạo/mở cửa sổ widget âm thanh độc lập — DELEGATE cho shared manager.
  // QUAN TRỌNG: Không tự getByLabel + show() ở đây. Manager (src/utils/audioWidget.ts)
  // là single source of truth, xử lý stale handle sau close() (bug "tắt rồi bật không hiện")
  // và đồng bộ trạng thái với App.tsx (tray menu).
  const openWidgetWindow = useCallback(async () => {
    await openAudioWidget({
      width: Math.max(150, Math.min(400, audioSettings.widget_width || 200)),
      height: Math.max(150, Math.min(400, audioSettings.widget_height || 200)),
    })
  }, [audioSettings.widget_width, audioSettings.widget_height])

  // WHY: Đóng cửa sổ widget — delegate cho shared manager.
  // WHY: Toggle widget window — delegate cho shared manager (state authoritative).
  const toggleWidget = useCallback(async () => {
    try {
      await toggleAudioWidget({
        width: Math.max(150, Math.min(400, audioSettings.widget_width || 200)),
        height: Math.max(150, Math.min(400, audioSettings.widget_height || 200)),
      })
    } catch {
      setStatusText('Không thể thao tác widget')
    }
  }, [audioSettings.widget_width, audioSettings.widget_height, setStatusText])

  // WHY: Đồng bộ widgetOpen với shared manager — cả tray menu (App.tsx) lẫn nút module
  // đều cập nhật qua manager, nên UI luôn khớp trạng thái thực tế của cửa sổ.
  // isAudioWidgetOpen() là boolean sync (manager state authoritative).
  useEffect(() => {
    setWidgetOpen(isAudioWidgetOpen())
    const unsubscribe = subscribeAudioWidget((open) => {
      setWidgetOpen(open)
      widgetOpenRef.current = open
    })
    return unsubscribe
  }, [])

  // WHY: Fetch song song devices + settings + sound files + history
  // Dùng Promise.all để giảm thời gian loading (4 API cùng lúc).
  const fetchAll = useCallback(async () => {
    try {
      const signalOpts = { signal: pollAbortRef.current?.signal }
      const [devicesRes, settingsRes, soundRes, historyRes] = await Promise.all([
        fetchWithRetry(`${API}/api/audio/devices`, signalOpts),
        fetchWithRetry(`${API}/api/audio/settings`, signalOpts),
        fetchWithRetry(`${API}/api/audio/sound-files`, signalOpts),
        fetchWithRetry(`${API}/api/audio/session-history`, signalOpts),
      ])
      if (devicesRes.ok) {
        const data = await devicesRes.json()
        setDevices(data.devices || [])
        setStatusText(`${data.devices?.length || 0} thiết bị âm thanh`)
      }
      if (settingsRes.ok) {
        const data = await settingsRes.json()
        setAudioSettings(data.settings)
      }
      if (soundRes.ok) {
        const data = await soundRes.json()
        setSoundFiles(data.sound_files || [])
      }
      if (historyRes.ok) {
        const data = await historyRes.json()
        setSessionHistory(data.sessions || [])
      }
    } catch {
      setStatusText('Đang tải dữ liệu...')
      addToast({ type: 'warning', title: '🔌 Mất kết nối âm thanh', message: 'Không thể kết nối tới backend' })
    }
  }, [setStatusText, addToast])

  // WHY: Dùng refs để fetchMicStatus (chạy mỗi 5s) không cần re-create.
  // Nếu dùng state trực tiếp, useCallback phải rebuild mỗi khi state thay đổi → interval bị clear/reset.
  useEffect(() => {
    audioSettingsRef.current = audioSettings
  }, [audioSettings])
  useEffect(() => {
    widgetOpenRef.current = widgetOpen
  }, [widgetOpen])

  // WHY: Mic level real-time (RMS 0-1) + peak hold — dữ liệu thật cho VU meter.
  // Lưu ở state để UI re-render mượt (poll 200ms, không cần ref).
  const [micLevel, setMicLevel] = useState(0)
  const [peakLevel, setPeakLevel] = useState(0)
  const peakLevelRef = useRef(0)

  // Poll mức âm thanh micro real-time (RMS 0.0-1.0) mỗi 200ms.
  // Dùng fetch thường (KHÔNG fetchWithRetry) — endpoint poll 200ms cần nhẹ,
  // retry + backoff sẽ chồng request khi backend tạm lỗi.
  // Backend dùng sounddevice.InputStream + idle auto-stop (5s không poll là tự tắt)
  // nên không lo pythonw.exe giữ mic vĩnh viễn.
  // WHY: Peak hold giữ giá trị đỉnh rồi decay dần để hiển thị vạch peak.
  const fetchMicLevel = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/audio/mic-level`, { signal: pollAbortRef.current?.signal })
      if (res.ok) {
        const data = await res.json()
        const lvl = Math.max(0, Math.min(1, Number(data.level) || 0))
        setMicLevel(lvl)
        // WHY: Peak hold — giữ đỉnh, decay 6%/poll (~1s đầy đủ) để vạch peak tụt từ từ
        peakLevelRef.current = Math.max(lvl, peakLevelRef.current - 0.06)
        setPeakLevel(peakLevelRef.current)
      }
    } catch {}
  }, [])

  // WHY: Polling mic status mỗi 5s — cần phản hồi khi mic bật/tắt.
  // Dùng refs (không phải state) để callback ổn định, tránh re-create interval.
  // previousWasActiveRef: phát hiện transition active→inactive để log session.
  const fetchMicStatus = useCallback(async () => {
    try {
      const res = await fetchWithRetry(`${API}/api/audio/mic-status`, { signal: pollAbortRef.current?.signal })
      if (res.ok) {
        const data: MicStatus = await res.json()
        setMicStatus(data)
        const settings = audioSettingsRef.current
        
        // Timer management
        if (data.active && !previousWasActiveRef.current) {
            // Mic just turned on
            setSessionTimer(0)
            previousWasActiveRef.current = true
            addToast({ type: 'info', title: '🎤 Mic đang hoạt động', message: data.mic_name || 'Mic đã bật' })
          // Play alert sound if enabled
          if (settings.sound_enabled) {
            try {
              const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)()
              const oscillator = audioCtx.createOscillator()
              const gain = audioCtx.createGain()
              oscillator.connect(gain)
              gain.connect(audioCtx.destination)
              oscillator.frequency.value = 1000
              oscillator.type = 'sine'
              gain.gain.value = 0.1
              oscillator.start()
              oscillator.stop(audioCtx.currentTime + 0.15)
            } catch {}
          }
          // Auto-show widget (Tauri window) if enabled
          if (settings.show_widget_on_mic && !widgetOpenRef.current) {
            openWidgetWindow()
          }
        } else if (!data.active && previousWasActiveRef.current) {
          // Mic just turned off - save session
          previousWasActiveRef.current = false
          setLastSessionDuration(sessionTimerRef.current)
          addToast({ type: 'info', title: '🎤 Mic đã tắt', message: `Phiên mic kéo dài ${Math.floor(sessionTimerRef.current / 60)} phút` })
          // Auto-hide widget if enabled (widget tự động đóng)
          if (settings.show_widget_on_mic && widgetOpenRef.current) {
            // Widget tự quản lý, không tự động close — user có thể muốn giữ widget để xem thông tin
            // Chỉ close nếu user muốn
          }
          if (sessionTimerRef.current > 2) {
            fetchWithRetry(`${API}/api/audio/session-log`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                duration: sessionTimerRef.current,
                app_using: data.app_using_mic || 'Unknown',
                mic_name: data.mic_name || 'Unknown'
              })
            }).catch(() => {})
          }
        }
      }
    } catch {}
  }, [openWidgetWindow]) // openWidgetWindow ổn định (useCallback)

  // WHY: Timer chỉ chạy khi mic đang active (microphone đang được dùng).
  // Tự động clear khi mic tắt — không tốn tài nguyên nền.
  // Dùng sessionTimerRef (ref) kết hợp setSessionTimer (state) để:
  //   - Ref: đọc giá trị ngay lập tức trong fetchMicStatus (không stale)
  //   - State: trigger re-render UI hiển thị đồng hồ
  useEffect(() => {
    if (micStatus?.active) {
      timerRef.current = setInterval(() => {
        setSessionTimer(prev => {
          sessionTimerRef.current = prev + 1
          return prev + 1
        })
      }, 1000)
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [micStatus?.active])

  // WHY: Polling audio — chỉ chạy khi module active. Khi inactive: clear intervals.
  // Stagger 500ms để tránh request burst khi nhiều module cùng mount.
  useEffect(() => {
    if (inactive && !backgroundPolling) return
    // Abort any in-flight requests from previous poll cycle
    if (pollAbortRef.current) pollAbortRef.current.abort()
    pollAbortRef.current = new AbortController()
    const initialTimer = setTimeout(() => {
      fetchAll()
      fetchMicStatus()
      fetchMicLevel()
    }, 500)
    const i1 = setInterval(fetchAll, 30000)
    const i2 = setInterval(fetchMicStatus, 5000)
    const i3 = setInterval(fetchMicLevel, 200)
    return () => {
      clearTimeout(initialTimer)
      pollAbortRef.current?.abort()
      clearInterval(i1); clearInterval(i2); clearInterval(i3)
    }
  }, [fetchAll, fetchMicStatus, fetchMicLevel, inactive, backgroundPolling])

  // Device selection
  useEffect(() => {
    if (selectedDevice !== null) {
      const dev = devices.find(d => d.id === selectedDevice)
      if (dev) { setVolume(dev.volume); setMuted(dev.muted) }
    }
  }, [selectedDevice, devices])

  // WHY: Toggle mute device — POST mute API + fetchAll refresh.
  // Local state muted cập nhật ngay (optimistic UI).
  // WHY: dev.id là chuỗi GUID (audio v2) — encodeURIComponent để bỏ { } . an toàn trong URL.
  const toggleMute = async (id: string) => {
    const dev = devices.find(d => d.id === id)
    const wasMuted = muted
    try {
      const res = await fetchWithRetry(`${API}/api/audio/devices/${encodeURIComponent(id)}/mute`, { method: 'POST' })
      if (res.ok) {
        setMuted(!wasMuted)
        fetchAll()
        addToast({ type: 'success', title: wasMuted ? '🔊 Bật tiếng' : '🔇 Tắt tiếng', message: `${dev?.name || 'Thiết bị'} đã ${wasMuted ? 'bật' : 'tắt'} tiếng` })
      } else {
        const errData = await res.json().catch(() => ({ error: 'Lỗi không xác định' }))
        addToast({ type: 'error', title: '🔇 Thao tác thất bại', message: errData.error })
      }
    } catch {
      addToast({ type: 'error', title: '🔌 Mất kết nối', message: 'Không thể kết nối tới backend' })
    }
  }

  // WHY: Set volume — PUT volume API + local state.
  // Clamp 0-100 (backend cũng làm).
  const setVolumeLevel = async (id: string, vol: number) => {
    try {
      await fetchWithRetry(`${API}/api/audio/devices/${encodeURIComponent(id)}/volume`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ volume: vol })
      })
      setVolume(vol)
    } catch {}
  }

  // WHY: Set default audio device — POST default API + UI feedback.
  // Refresh devices list để thay đổi default badge (backend v2 tính is_default từ
  // Windows Core Audio thật, nên badge di chuyển chính xác sau khi đổi).
  // WHY: Hiện toast LỖI khi res không ok — trước đây nuốt lỗi âm thầm (user tưởng
  // "không đặt được" dù API có thể báo 404/500).
  // WHY: Phân biệt rõ 2 loại lỗi:
  //   - Backend trả 4xx/5xx: hiển thị đúng errData.error (backend có ghi [audio][ERROR]
  //     vào debug.log → tab Nhật ký SẼ thấy dòng lỗi).
  //   - Network error (fetch throw): backend không phản hồi (đang treo/khởi động lại) →
  //     KHÔNG có log mới nào được ghi — hiện thông báo rõ ràng + gợi ý kiểm tra tab Nhật ký
  //     / chờ watchdog tự restart, thay vì toast chung chung "Đặt thiết bị mặc định thất bại"
  //     khiến user tưởng lỗi thiết bị.
  // WHY: setDefaultDevice cần cổng COM riêng vì pycaw bất đồng bộ; lock ref chống
  // double-click và verify lại sau khi set để toast chính xác.
  const setDefaultDevice = async (id: string) => {
    // WHY: Nếu đang có request set-default khác in-flight → bỏ qua (chống double-click).
    // Check cả state lẫn ref (ref đồng bộ ngay trong tick, không chờ React re-render).
    if (settingDefaultRef.current !== null) return
    const dev = devices.find(d => d.id === id)
    settingDefaultRef.current = id
    setSettingDefaultId(id)
    // WHY: Timeout 15s qua AbortController — set-default backend có thể mất tới ~5s
    // (verify retry). Nếu backend kẹt (worker COM treo), fetch phải tự hủy sau 15s
    // thay vì treo vô hạn → nút thoát khỏi trạng thái 'Đang đặt mặc định...'.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)
    try {
      // WHY: retries=0 — backend /default tự retry verify nội bộ (0.3→2.4s), retry
      // phía frontend chỉ làm chồng request + kéo dài thời gian chờ vô ích.
      const res = await fetchWithRetry(`${API}/api/audio/devices/${encodeURIComponent(id)}/default`, { method: 'POST', signal: controller.signal }, 0)
      if (res.ok) {
        setStatusText('Đã đặt mặc định'); fetchAll()
        addToast({ type: 'success', title: '🔊 Thiết bị âm thanh', message: 'Đã đặt làm mặc định' })
      } else {
        const errData = await res.json().catch(() => ({ error: 'Không thể đặt mặc định' }))
        setStatusText('Thất bại')
        // WHY: Lỗi từ backend — backend đã ghi [audio][ERROR] vào debug.log nên tab
        // Nhật ký sẽ hiển thị chi tiết. Đính kèm gợi ý mở tab Nhật ký.
        addToast({ type: 'error', title: '🔊 Lỗi', message: `${errData.error || 'Đặt thiết bị mặc định thất bại'} — xem tab Nhật ký` })
      }
    } catch (e: any) {
      setStatusText('Thất bại')
      // WHY: Phân biệt timeout (abort) vs network error — nói rõ để user biết xử lý gì.
      if (e?.name === 'AbortError') {
        addToast({ type: 'error', title: '🔊 Lỗi', message: 'Đặt mặc định quá lâu (15s) — backend đang bận/treo. Chờ 20s rồi thử lại' })
      } else {
        // WHY: Network error — backend không phản hồi (đang treo/restart). Không có log
        // mới nào được ghi. Nói rõ để user không nhầm lẫn với lỗi thiết bị.
        addToast({ type: 'error', title: '🔊 Lỗi', message: 'Backend không phản hồi — đang treo/khởi động lại. Chờ 20s rồi thử lại' })
      }
    } finally {
      clearTimeout(timer)
      settingDefaultRef.current = null
      setSettingDefaultId(null)
    }
  }

  // WHY: Save audio settings (sound, widget opacity, colors).
  // POST whole settings object — backend merge.
  const saveSettings = async () => {
    try {
      const res = await fetchWithRetry(`${API}/api/audio/settings`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(audioSettings)
      })
      if (res.ok) {
        setStatusText('Đã lưu cài đặt'); setSettingsOpen(false)
        addToast({ type: 'success', title: '⚙️ Cài đặt âm thanh', message: 'Đã lưu cài đặt' })
      }
    } catch {
      setStatusText('Thất bại')
      addToast({ type: 'error', title: '⚙️ Lưu thất bại', message: 'Không thể lưu cài đặt âm thanh' })
    }
  }

  // WHY: Format seconds -> mm:ss (không có hours vì timer mic thường < 1h).
  // Dùng padStart để đảm bảo 2 chữ số (VD: 5 -> 05).
  const formatDuration = (seconds: number) => {
    const m = Math.floor(seconds / 60)
    const s = seconds % 60
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  // WHY: Chỉ lấy tên file từ đường dẫn (C:\\path\\file.exe → file.exe)
  const getBasename = (path: string | null | undefined): string | null | undefined => {
    if (!path || typeof path !== 'string') return path
    const normalized = path.replace(/[\\/]+$/, '')
    const parts = normalized.replace(/\\/g, '/').split('/')
    return parts[parts.length - 1] || path
  }

  // WHY: Rút gọn tên host API PortAudio cho hiển thị gọn ("Windows WASAPI" → "WASAPI",
  // "MME" → "MME", "Windows DirectSound" → "DirectSound").
  const monitorHostApi = (raw: string): string => {
    if (!raw) return 'Unknown'
    if (raw.includes('WASAPI')) return 'WASAPI'
    if (raw.includes('DirectSound')) return 'DirectSound'
    if (raw.includes('MME')) return 'MME'
    if (raw.includes('WDM-KS')) return 'WDM-KS'
    return raw
  }

  // WHY: Tách 2 nhóm thiết bị — Micro (đầu vào: mic/webcam/thiết bị ghi âm) và
  // Loa/Tai nghe (đầu ra) theo convention is_input (khớp với thống kê ở header).
  const inputDevices = devices.filter(d => d.is_input)
  const outputDevices = devices.filter(d => !d.is_input)

  // WHY: DeviceCard — thẻ thiết bị dùng chung cho cả 2 section (Micro / Loa).
  // Click thẻ → mở rộng điều khiển: mute, slider âm lượng, đặt mặc định.
  const DeviceCard = ({ dev }: { dev: AudioDevice }) => (
    <div
      className="rounded-2xl border backdrop-blur-md transition-all duration-200 overflow-hidden shadow-sm hover:border-slate-600"
      style={{
        backgroundColor: 'var(--bg-card)',
        borderColor: dev.is_default ? 'rgba(52,211,153,0.35)' : 'var(--border)'
      }}>
      <div className="flex items-center justify-between p-3.5 cursor-pointer transition-colors hover:bg-white/[0.02]"
        onClick={() => setSelectedDevice(selectedDevice === dev.id ? null : dev.id)}>
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-xl shrink-0 ${
            dev.is_input ? 'bg-amber-500/15 border border-amber-500/30 text-amber-400' : 'bg-sky-500/15 border border-sky-500/30 text-sky-400'
          }`}>
            {dev.is_input ? '🎤' : '🔊'}
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-bold truncate" style={{ color: 'var(--fg)' }}>{dev.name}</span>
              {dev.is_default && (
                <span className="text-[9px] bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 px-2 py-0.5 rounded-full font-bold">
                  MẶC ĐỊNH
                </span>
              )}
              {dev.muted && (
                <span className="text-[9px] bg-red-500/15 text-red-400 border border-red-500/30 px-2 py-0.5 rounded-full font-bold">
                  🔇 TẮT TIẾNG
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Volume level indicator bar */}
        <div className="flex items-center gap-3 ml-4 shrink-0">
          <div className="w-24 h-2 rounded-full bg-slate-800 overflow-hidden border border-slate-700">
            <div className="h-full rounded-full transition-all duration-300" style={{
              width: `${dev.volume}%`,
              backgroundColor: dev.volume > 70 ? '#34d399' : dev.volume > 30 ? '#fbbf24' : '#f87171'
            }} />
          </div>
          <span className="text-xs font-mono font-bold w-10 text-right text-slate-300">{dev.volume}%</span>
          <span className={`text-xs text-slate-400 transition-transform ${selectedDevice === dev.id ? 'rotate-180' : ''}`}>▼</span>
        </div>
      </div>

{/* Expanded Device Controls */}
      {selectedDevice === dev.id && (
        <div className="border-t px-4 py-3.5 space-y-3.5 bg-slate-950/40 backdrop-blur-sm" style={{ borderColor: 'var(--border)' }}
          onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3">
            <button onClick={() => toggleMute(dev.id)}
              className="px-3.5 py-2 text-xs font-semibold rounded-xl border transition-all active:scale-95 cursor-pointer flex items-center gap-1.5 shadow-sm"
              style={{
                backgroundColor: dev.muted ? 'rgba(239,68,68,0.15)' : 'var(--input-bg)',
                borderColor: dev.muted ? 'rgba(239,68,68,0.3)' : 'var(--border)',
                color: dev.muted ? '#ef4444' : 'var(--fg-secondary)'
              }}>
              {dev.muted ? '🔊 Bật tiếng' : '🔇 Tắt tiếng'}
            </button>

            <div className="flex-1 flex items-center gap-2">
              <span className="text-xs text-slate-400 font-medium">Âm lượng:</span>
              <input id={`volume-${dev.id}`} name="volume" type="range" min={0} max={100} value={dev.volume}
                onChange={e => setVolumeLevel(dev.id, parseInt(e.target.value))}
                className="flex-1 accent-emerald-500 cursor-pointer h-2 bg-slate-800 rounded-lg" />
              <span className="text-xs font-mono font-bold w-9 text-right text-emerald-400">{dev.volume}%</span>
            </div>
          </div>

          {!dev.is_default && (
            <button onClick={() => setDefaultDevice(dev.id)} disabled={settingDefaultId !== null}
              className={`w-full py-2 text-xs font-bold rounded-xl transition-all border ${
                settingDefaultId === dev.id
                  ? 'bg-sky-500/25 text-sky-300 border-sky-500/40 cursor-wait animate-pulse'
                  : 'bg-sky-500/15 hover:bg-sky-500/25 text-sky-400 border-sky-500/30 active:scale-95 cursor-pointer'
              }`}>
              {settingDefaultId === dev.id
                ? '⏳ Đang đặt mặc định...'
                : `🎯 Đặt ${dev.name} làm thiết bị ${dev.is_input ? 'Micro' : 'Loa'} mặc định`}
            </button>
          )}
        </div>
      )}
    </div>
  )

  return (
    <>
      <div className="flex flex-col h-full p-4 gap-4" style={{ display: inactive ? 'none' : 'flex' }}>
      {/* Top Bar Header — Studio Master Control style */}
      <div className="flex items-center justify-between border-b pb-3" style={{ borderColor: 'var(--border)' }}>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-sky-500/20 via-indigo-500/20 to-emerald-500/20 border border-sky-500/35 flex items-center justify-center text-sky-400 font-bold text-xl shadow-lg shadow-sky-500/10">
            🎙️
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-black tracking-tight" style={{ color: 'var(--fg)' }}>Trung tâm Âm thanh Studio</h2>
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                MASTER DECK
              </span>
            </div>
            <p className="text-xs text-slate-400 font-medium mt-0.5">
              {devices.filter(d => d.is_input).length} Micro đầu vào · {devices.filter(d => !d.is_input).length} Loa/Tai nghe đầu ra · {sessionHistory.length} phiên thu âm
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          {/* Backend Status Indicator */}
          <div className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border transition-all"
            style={{
              backgroundColor: backendStatus === 'running' ? 'rgba(34,197,94,0.1)' : backendStatus === 'stopped' ? 'rgba(239,68,68,0.1)' : 'rgba(251,191,36,0.1)',
              borderColor: backendStatus === 'running' ? 'rgba(34,197,94,0.3)' : backendStatus === 'stopped' ? 'rgba(239,68,68,0.3)' : 'rgba(251,191,36,0.3)',
              color: backendStatus === 'running' ? '#22c55e' : backendStatus === 'stopped' ? '#ef4444' : '#fbbf24'
            }}>
            <span className={`w-1.5 h-1.5 rounded-full ${backendStatus === 'running' ? 'bg-emerald-500 animate-pulse' : backendStatus === 'stopped' ? 'bg-red-500' : 'bg-amber-500 animate-pulse'}`} />
            <span>{backendStatus === 'running' ? 'Backend: Đang chạy' : backendStatus === 'stopped' ? 'Backend: Đã dừng' : 'Backend: Đang kiểm tra...'}</span>
          </div>
          {onBackgroundPollingChange && (
            <button onClick={() => onBackgroundPollingChange(!backgroundPolling)}
              className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-bold rounded-xl border transition-all active:scale-95 cursor-pointer shadow-sm"
              style={{ backgroundColor: backgroundPolling ? 'rgba(52,211,153,0.15)' : 'var(--input-bg)', borderColor: backgroundPolling ? 'rgba(52,211,153,0.35)' : 'var(--border)', color: backgroundPolling ? '#34d399' : 'var(--fg-muted)' }}>
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
              </svg>
              <span>Giám sát nền: {backgroundPolling ? 'BẬT' : 'TẮT'}</span>
            </button>
          )}
          <button onClick={toggleWidget}
            className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-bold rounded-xl border transition-all active:scale-95 cursor-pointer shadow-sm hover:bg-white/10"
            style={{ backgroundColor: widgetOpen ? 'rgba(52,211,153,0.12)' : 'var(--input-bg)', borderColor: widgetOpen ? 'rgba(52,211,153,0.35)' : 'var(--border)', color: widgetOpen ? '#34d399' : 'var(--fg-secondary)' }}>
            <span>{widgetOpen ? '🔳' : '🔲'}</span> {widgetOpen ? 'Widget độc lập' : 'Mở Widget độc lập'}
          </button>
          <button onClick={() => setSettingsOpen(true)}
            className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-bold rounded-xl border transition-all active:scale-95 cursor-pointer shadow-sm hover:bg-emerald-500/20 text-emerald-400 border-emerald-500/40"
            style={{ backgroundColor: 'rgba(52,211,153,0.12)' }}>
            <span>⚙️</span> Cấu hình Widget
          </button>
        </div>
      </div>

      {/* Hero Section: Dynamic Equalizer VU Spectrum & Digital Studio Clock */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Card 1: Mic Live Radar & Visualizer Spectrum */}
        <div className="rounded-2xl border backdrop-blur-md p-4 transition-all shadow-sm relative overflow-hidden flex flex-col justify-between"
          style={{ backgroundColor: 'var(--bg-card)', borderColor: micStatus?.active ? 'rgba(52,211,153,0.4)' : 'var(--border)' }}>
          
          {micStatus?.active && (
            <div className="absolute -top-10 -right-10 w-40 h-40 bg-emerald-500/15 rounded-full blur-3xl pointer-events-none" />
          )}

          <div>
            <div className="flex items-center justify-between mb-3 border-b pb-2.5" style={{ borderColor: 'var(--border)' }}>
              <div className="flex items-center gap-2">
                <span className="text-base">🎙️</span>
                <h3 className="text-xs font-bold uppercase tracking-wider text-sky-400">
                  Tín hiệu Micro Real-time
                </h3>
              </div>
              {micStatus && (
                <span className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold shadow-sm ${
                  micStatus.active ? 'bg-emerald-500/20 text-emerald-400 ring-1 ring-emerald-500/40' : 'bg-slate-800 text-slate-400 ring-1 ring-slate-700'
                }`}>
                  <span className={`w-2 h-2 rounded-full ${micStatus.active ? 'bg-emerald-400 animate-ping' : 'bg-slate-500'}`} />
                  {micStatus.active ? 'ĐANG THU ÂM LIVE' : 'SẴN SÀNG'}
                </span>
              )}
            </div>

            {/* Real-time VU Meter — driven by ACTUAL RMS level from /api/audio/mic-level */}
            <div className="px-3 py-3 my-2.5 bg-slate-950/60 rounded-xl border border-slate-800/90 shadow-inner">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[9px] font-mono font-bold uppercase tracking-widest text-slate-500">VU Meter</span>
                <span className={`text-[9px] font-mono font-bold px-1.5 py-0.5 rounded transition-colors ${
                  micLevel > 0.02 ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-800 text-slate-500'
                }`}>
                  {micLevel > 0.02 ? '● LIVE' : '○ IDLE'}
                </span>
              </div>

              {/* 28 LED segments — each lights up when real level crosses its threshold */}
              <div className="flex items-end gap-[2px] h-10">
                {Array.from({ length: 28 }).map((_, i) => {
                  const threshold = (i + 1) / 28
                  const lit = micLevel >= threshold
                  const color = i < 15 ? '#34d399' : i < 23 ? '#fbbf24' : '#ef4444'
                  return (
                    <div key={i} className="flex-1 rounded-[2px] transition-all duration-100"
                      style={{
                        backgroundColor: lit ? color : 'rgba(51,65,85,0.35)',
                        height: '100%',
                        boxShadow: lit ? `0 0 6px ${color}80` : 'none',
                        opacity: lit ? 1 : 0.5,
                      }} />
                  )
                })}
              </div>

              {/* dB-ish scale labels */}
              <div className="flex justify-between text-[8px] font-mono text-slate-600 mt-1">
                <span>-60</span><span>-40</span><span>-20</span><span>-6</span><span>0 dB</span>
              </div>

              {/* Big readout + peak hold */}
              <div className="flex items-end justify-between mt-2 pt-2 border-t border-slate-800/60">
                <div>
                  <div className="text-[9px] font-bold uppercase tracking-wider text-slate-500">Mức tín hiệu</div>
                  <div className="font-mono font-black text-3xl leading-none tabular-nums"
                    style={{ color: micLevel > 0.75 ? '#ef4444' : micLevel > 0.4 ? '#fbbf24' : '#34d399' }}>
                    {Math.round(micLevel * 100)}<span className="text-base">%</span>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[9px] font-bold uppercase tracking-wider text-slate-500">Đỉnh (Peak)</div>
                  <div className="font-mono font-bold text-lg leading-none text-amber-400 tabular-nums">
                    {Math.round(peakLevel * 100)}%
                  </div>
                </div>
              </div>
            </div>

            {micStatus ? (
              <div className="space-y-1.5 text-xs pt-1">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-slate-400 font-medium">Thiết bị thu:</span>                    <span className="font-bold text-slate-200 truncate max-w-[200px] text-right">
                    {getBasename(micStatus.mic_name) || 'Không xác định'}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-slate-400 font-medium">Ứng dụng chiếm dụng:</span>                    <span className="font-semibold text-emerald-400 truncate max-w-[180px] text-right">
                    {getBasename(micStatus.app_using_mic) || 'Chưa nhận diện'}
                  </span>
                </div>
                {/* WHY: Hiển thị host API + sample rate monitor đang dùng — user biết widget
                    VU meter đang đọc tín hiệu từ đâu (WASAPI 48000 / MME 44100...). */}
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-slate-400 font-medium">Kênh đo (VU):</span>
                  {micStatus.monitor_info ? (
                    <span className="font-semibold text-sky-400 truncate max-w-[180px] text-right">
                      {monitorHostApi(micStatus.monitor_info.hostapi)} {micStatus.monitor_info.samplerate} Hz
                    </span>
                  ) : (
                    <span className="text-slate-500 text-right italic">Chưa kích hoạt</span>
                  )}
                </div>
              </div>
            ) : (
              <p className="text-xs italic text-slate-500 py-2">Đang quét tín hiệu âm thanh...</p>
            )}
          </div>
        </div>

        {/* Card 2: Digital Studio Clock & Quick Actions */}
        <div className="rounded-2xl border backdrop-blur-md p-4 transition-all shadow-sm flex flex-col justify-between"
          style={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border)' }}>
          <div className="flex items-center justify-between border-b pb-2.5" style={{ borderColor: 'var(--border)' }}>
            <div className="flex items-center gap-2">
              <span className="text-base">⏱️</span>
              <h3 className="text-xs font-bold uppercase tracking-wider text-emerald-400">
                Đồng hồ Phiên Thu âm
              </h3>
            </div>
            <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 border border-slate-700">
              {sessionHistory.length} phiên đã lưu
            </span>
          </div>

          <div className="flex flex-col items-center justify-center py-2">
            <div className={`text-4xl font-black font-mono tracking-wider transition-all ${
              micStatus?.active ? 'text-emerald-400 drop-shadow-[0_0_18px_rgba(52,211,153,0.5)] scale-105' : 'text-slate-500'
            }`}>
              {micStatus?.active ? formatDuration(sessionTimer) : '00:00'}
            </div>
            <p className="text-[11px] text-slate-400 mt-1 font-medium">
              Thời lượng gần nhất: <strong className="text-sky-400 font-mono">{formatDuration(lastSessionDuration)}</strong>
            </p>
          </div>

          <div className="flex items-center justify-center gap-2 pt-2 border-t" style={{ borderColor: 'var(--border)' }}>
            <button onClick={() => setHistoryOpen(true)}
              className="px-3.5 py-1.5 text-xs font-bold rounded-xl border transition-all active:scale-95 cursor-pointer hover:bg-white/10 shadow-sm"
              style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}>
              📋 Lịch sử thu âm
            </button>
            <button onClick={() => setSettingsOpen(true)}
              className="px-3.5 py-1.5 text-xs font-bold rounded-xl border transition-all active:scale-95 cursor-pointer hover:bg-white/10 shadow-sm"
              style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}>
              ⚙️ Cấu hình chuông báo
            </button>
          </div>
        </div>
      </div>

      {/* Devices List Section — Split into Input & Output Racks */}
      <div className="flex-1 overflow-y-auto space-y-3 pr-1">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-2">
            <span>🎚️ Thiết bị Âm thanh</span>
            <span className="text-[10px] font-normal text-slate-500">({devices.length} kết nối)</span>
          </h3>
          <span className="text-[10px] text-slate-400">Nhấn vào thẻ thiết bị để mở điều khiển âm lượng</span>
        </div>

        {devices.length === 0 && (
          <div className="flex flex-col items-center justify-center h-40 gap-2 text-slate-500">
            <span className="text-3xl opacity-40">🎧</span>
            <p className="text-xs italic">Không tìm thấy thiết bị âm thanh nào kết nối.</p>
          </div>
        )}

        {inputDevices.length > 0 && (
          <section className="space-y-3">
            <div className="flex items-center justify-between px-1">
              <h4 className="text-[11px] font-bold uppercase tracking-wider text-amber-400/90 flex items-center gap-2">
                <span>🎤 Micro & Thiết bị ghi âm</span>
                <span className="text-[10px] font-normal text-slate-500">({inputDevices.length})</span>
              </h4>
            </div>
            {inputDevices.map(dev => <DeviceCard key={dev.id} dev={dev} />)}
          </section>
        )}

        {outputDevices.length > 0 && (
          <section className="space-y-3">
            <div className="flex items-center justify-between px-1">
              <h4 className="text-[11px] font-bold uppercase tracking-wider text-sky-400/90 flex items-center gap-2">
                <span>🔊 Loa & Tai nghe</span>
                <span className="text-[10px] font-normal text-slate-500">({outputDevices.length})</span>
              </h4>
            </div>
            {outputDevices.map(dev => <DeviceCard key={dev.id} dev={dev} />)}
          </section>
        )}
      </div>

      {/* Settings Modal — z-[10000] hiển thị đè lên mọi thứ */}
      {settingsOpen && (
          <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/65 backdrop-blur-md p-4 animate-modal-in"
            onClick={e => { if (e.target === e.currentTarget) setSettingsOpen(false) }}>
            <div className="w-full max-w-md rounded-2xl border shadow-2xl p-6 transition-all bg-slate-900 border-slate-800 text-slate-100 flex flex-col space-y-4">
              <div className="flex items-center justify-between pb-3 border-b border-slate-800">
                <div className="flex items-center gap-2">
                  <span className="text-lg">⚙️</span>
                  <h3 className="text-sm font-bold text-emerald-400">Cấu hình Âm thanh & Báo hiệu Widget</h3>
                </div>
                <button onClick={() => setSettingsOpen(false)} className="text-slate-400 hover:text-white border-0 bg-transparent text-lg cursor-pointer">&times;</button>
              </div>

              <div className="space-y-3 text-xs">
                <label htmlFor="audio-sound-enabled" className="flex items-center gap-2.5 cursor-pointer p-2 rounded-xl bg-slate-800/50 hover:bg-slate-800">
                  <input id="audio-sound-enabled" name="soundEnabled" type="checkbox" checked={audioSettings.sound_enabled}
                    onChange={e => setAudioSettings(prev => ({ ...prev, sound_enabled: e.target.checked }))}
                    className="accent-emerald-500 w-4 h-4 rounded" />
                  <span className="font-semibold">Phát âm thanh báo hiệu khi micro bắt đầu hoạt động</span>
                </label>

                <label htmlFor="audio-show-widget" className="flex items-center gap-2.5 cursor-pointer p-2 rounded-xl bg-slate-800/50 hover:bg-slate-800">
                  <input id="audio-show-widget" name="showWidget" type="checkbox" checked={audioSettings.show_widget_on_mic}
                    onChange={e => setAudioSettings(prev => ({ ...prev, show_widget_on_mic: e.target.checked }))}
                    className="accent-emerald-500 w-4 h-4 rounded" />
                  <span className="font-semibold">Tự động hiện Widget (cửa sổ độc lập) khi mic bật</span>
                </label>

                {/* Widget Dimensions */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="p-3 rounded-xl bg-slate-800/40 border border-slate-800">
                    <label htmlFor="widget-width" className="text-[11px] font-semibold text-slate-300 block mb-1">Chiều rộng Widget (px)</label>
                    <input id="widget-width" type="number" min={150} max={400} value={audioSettings.widget_width || 220}
                      onChange={e => setAudioSettings(prev => ({ ...prev, widget_width: parseInt(e.target.value) || 220 }))}
                      className="w-full px-2.5 py-1.5 text-xs font-mono rounded-lg border border-slate-700 bg-slate-800 text-emerald-400" />
                  </div>
                  <div className="p-3 rounded-xl bg-slate-800/40 border border-slate-800">
                    <label htmlFor="widget-height" className="text-[11px] font-semibold text-slate-300 block mb-1">Chiều cao Widget (px)</label>
                    <input id="widget-height" type="number" min={150} max={400} value={audioSettings.widget_height || 220}
                      onChange={e => setAudioSettings(prev => ({ ...prev, widget_height: parseInt(e.target.value) || 220 }))}
                      className="w-full px-2.5 py-1.5 text-xs font-mono rounded-lg border border-slate-700 bg-slate-800 text-emerald-400" />
                  </div>
                </div>

                {/* Kiểu Icon Theme (Widget) */}
                <div className="p-3 rounded-xl bg-slate-800/40 border border-slate-800 space-y-2">
                  <label className="text-xs font-semibold text-slate-300 block">Kiểu Icon (Widget Theme)</label>
                  <div className="grid grid-cols-4 gap-2">
                    {[
                      { id: '1', label: 'Classic', icon: '🎤' },
                      { id: '2', label: 'Radio', icon: '📻' },
                      { id: '3', label: 'Radar', icon: '📡' },
                      { id: '4', label: 'Wave', icon: '🌊' },
                    ].map(item => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setAudioSettings(prev => ({ ...prev, icon_theme: item.id }))}
                        className={`p-2 rounded-xl border text-center transition-all cursor-pointer ${
                          audioSettings.icon_theme === item.id
                            ? 'bg-emerald-500/20 border-emerald-500 text-emerald-400 font-bold'
                            : 'bg-slate-800/60 border-slate-700 text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        <div className="text-lg">{item.icon}</div>
                        <div className="text-[10px] mt-0.5">{item.label}</div>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="p-3 rounded-xl bg-slate-800/40 border border-slate-800 space-y-2">
                  <label className="text-xs font-semibold text-slate-300 block">
                    Độ mờ Widget nổi: <span className="text-emerald-400 font-mono">{Math.round((audioSettings.widget_opacity ?? 1.0) * 100)}%</span>
                  </label>
                  <input id="audio-opacity" name="widgetOpacity" type="range" min={10} max={100} value={Math.round((audioSettings.widget_opacity ?? 1.0) * 100)}
                    onChange={e => setAudioSettings(prev => ({ ...prev, widget_opacity: parseInt(e.target.value) / 100 }))}
                    className="w-full accent-emerald-500 cursor-pointer" />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="p-3 rounded-xl bg-slate-800/40 border border-slate-800">
                    <label htmlFor="audio-color-on" className="text-[11px] font-semibold text-slate-300 block mb-1.5">Màu khi Mic Bật</label>
                    <div className="flex items-center gap-2">
                      <input id="audio-color-on" name="colorMicOn" type="color" value={audioSettings.color_mic_on}
                        onChange={e => setAudioSettings(prev => ({ ...prev, color_mic_on: e.target.value }))}
                        className="w-7 h-7 rounded-lg cursor-pointer border-0 bg-transparent" />
                      <span className="font-mono text-xs text-emerald-400">{audioSettings.color_mic_on}</span>
                    </div>
                  </div>

                  <div className="p-3 rounded-xl bg-slate-800/40 border border-slate-800">
                    <label htmlFor="audio-color-off" className="text-[11px] font-semibold text-slate-300 block mb-1.5">Màu khi Mic Tắt</label>
                    <div className="flex items-center gap-2">
                      <input id="audio-color-off" name="colorMicOff" type="color" value={audioSettings.color_mic_off}
                        onChange={e => setAudioSettings(prev => ({ ...prev, color_mic_off: e.target.value }))}
                        className="w-7 h-7 rounded-lg cursor-pointer border-0 bg-transparent" />
                      <span className="font-mono text-xs text-red-400">{audioSettings.color_mic_off}</span>
                    </div>
                  </div>
                </div>

                {soundFiles.length > 0 && (
                  <div>
                    <label htmlFor="audio-sound-select" className="text-xs font-semibold text-slate-300 block mb-1">Âm thanh chuông báo</label>
                    <select id="audio-sound-select" name="selectedSound" value={audioSettings.selected_sound || ''}
                      onChange={e => setAudioSettings(prev => ({ ...prev, selected_sound: e.target.value || null }))}
                      className="w-full px-3 py-2 text-xs rounded-xl border border-slate-700 bg-slate-800 text-slate-200">
                      <option value="">Không dùng nhạc chuông</option>
                      {soundFiles.map(f => (
                        <option key={f} value={f}>{f}</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-800">
                <button onClick={() => setSettingsOpen(false)}
                  className="px-4 py-1.5 text-xs font-semibold border border-slate-700 rounded-xl text-slate-300 hover:bg-slate-800 cursor-pointer">Hủy</button>
                <button onClick={saveSettings}
                  className="px-5 py-1.5 text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl cursor-pointer border-0 shadow-sm">Lưu cài đặt</button>
              </div>
            </div>
          </div>
        )}

        {/* Session History Modal */}
        {historyOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 backdrop-blur-md p-4 animate-modal-in"
            onClick={e => { if (e.target === e.currentTarget) setHistoryOpen(false) }}>
            <div className="w-full max-w-lg rounded-2xl border shadow-2xl p-6 transition-all bg-slate-900 border-slate-800 text-slate-100 flex flex-col max-h-[75vh]">
              <div className="flex items-center justify-between pb-3 border-b border-slate-800 shrink-0">
                <div className="flex items-center gap-2">
                  <span className="text-lg">📋</span>
                  <h3 className="text-sm font-bold text-emerald-400">Lịch sử dùng Micro ({sessionHistory.length})</h3>
                </div>
                <button onClick={() => setHistoryOpen(false)} className="text-slate-400 hover:text-white border-0 bg-transparent text-lg cursor-pointer">&times;</button>
              </div>

              <div className="mt-3 flex-1 overflow-y-auto space-y-2 pr-1">
                {sessionHistory.length === 0 ? (
                  <p className="text-xs italic text-center py-12 text-slate-500">Chưa có lịch sử thu âm nào được lưu.</p>
                ) : (
                  sessionHistory.slice(0, 50).map((session, idx) => (
                    <div key={idx} className="p-3 rounded-xl text-xs bg-slate-800/60 border border-slate-700/60 space-y-1 hover:border-slate-600 transition-colors">
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-slate-400">{session.datetime}</span>
                        <span className="font-bold font-mono text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded-full">
                          ⏱️ {Math.floor(session.duration / 60)} phút {session.duration % 60} giây
                        </span>
                      </div>
                      <div className="flex items-center gap-4 text-slate-300 pt-0.5">
                        <span className="truncate">🎯 App: <strong className="text-sky-400">{session.app_using || 'Không xác định'}</strong></span>
                        <span className="truncate">🎤 Device: <strong className="text-amber-400">{session.mic_name || 'Microphone'}</strong></span>
                      </div>
                    </div>
                  ))
                )}
              </div>

              <div className="pt-3 border-t border-slate-800 flex justify-end shrink-0">
                <button onClick={() => setHistoryOpen(false)}
                  className="px-5 py-1.5 text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl cursor-pointer border-0 shadow-sm">Đóng</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  )
}
