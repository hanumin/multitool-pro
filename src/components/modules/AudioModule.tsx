import { useState, useEffect, useCallback, useRef } from 'react'
import { AudioDevice, MicStatus } from '../../types'

const API = 'http://127.0.0.1:5050'

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
}

interface AudioModuleProps {
  theme: 'dark' | 'light'
  setStatusText: (t: string) => void
}

export default function AudioModule({ theme, setStatusText }: AudioModuleProps) {
  const [micStatus, setMicStatus] = useState<MicStatus | null>(null)
  const [devices, setDevices] = useState<AudioDevice[]>([])
  const [selectedDevice, setSelectedDevice] = useState<number | null>(null)
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
    color_mic_on: '#3498DB', color_mic_off: '#E74C3C',
    show_widget_on_mic: false, always_on_top: false, widget_opacity: 1.0
  })
  
  // Settings & customization
  const [audioSettings, setAudioSettings] = useState<AudioSettings>({
    sound_enabled: true, selected_sound: null, icon_theme: '1',
    color_mic_on: '#3498DB', color_mic_off: '#E74C3C',
    show_widget_on_mic: false, always_on_top: false, widget_opacity: 1.0
  })
  const [soundFiles, setSoundFiles] = useState<string[]>([])
  const [sessionHistory, setSessionHistory] = useState<AudioSession[]>([])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  
  // Widget mode
  const [widgetMode, setWidgetMode] = useState(false)
  const widgetModeRef = useRef(false)
  const [widgetPos, setWidgetPos] = useState({ x: 100, y: 100 })
  const dragging = useRef(false)
  const dragOffset = useRef({ x: 0, y: 0 })

  // Fetch devices and settings
  const fetchAll = useCallback(async () => {
    try {
      const [devicesRes, settingsRes, soundRes, historyRes] = await Promise.all([
        fetch(`${API}/api/audio/devices`),
        fetch(`${API}/api/audio/settings`),
        fetch(`${API}/api/audio/sound-files`),
        fetch(`${API}/api/audio/session-history`),
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
    } catch { setStatusText('Đang kết nối lại...') }
  }, [setStatusText])

  // Stable refs to avoid recreating fetchMicStatus every second
  useEffect(() => {
    audioSettingsRef.current = audioSettings
  }, [audioSettings])
  useEffect(() => {
    widgetModeRef.current = widgetMode
  }, [widgetMode])

  const fetchMicStatus = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/audio/mic-status`)
      if (res.ok) {
        const data: MicStatus = await res.json()
        setMicStatus(data)
        const settings = audioSettingsRef.current
        
        // Timer management
        if (data.active && !previousWasActiveRef.current) {
          // Mic just turned on
          setSessionTimer(0)
          previousWasActiveRef.current = true
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
          // Auto-show widget if enabled
          if (settings.show_widget_on_mic && !widgetModeRef.current) {
            setWidgetMode(true)
          }
        } else if (!data.active && previousWasActiveRef.current) {
          // Mic just turned off - save session
          previousWasActiveRef.current = false
          setLastSessionDuration(sessionTimerRef.current)
          // Auto-hide widget if enabled
          if (settings.show_widget_on_mic && widgetModeRef.current) {
            setWidgetMode(false)
          }
          if (sessionTimerRef.current > 2) {
            fetch(`${API}/api/audio/session-log`, {
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
  }, []) // Empty deps - stable callback using refs

  // Timer interval
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

  // Load data
  useEffect(() => {
    fetchAll()
    fetchMicStatus()
    const i1 = setInterval(fetchAll, 5000)
    const i2 = setInterval(fetchMicStatus, 1000)
    return () => { clearInterval(i1); clearInterval(i2) }
  }, [fetchAll, fetchMicStatus])

  // Device selection
  useEffect(() => {
    if (selectedDevice !== null) {
      const dev = devices.find(d => d.id === selectedDevice)
      if (dev) { setVolume(dev.volume); setMuted(dev.muted) }
    }
  }, [selectedDevice, devices])

  const toggleMute = async (id: number) => {
    try {
      const res = await fetch(`${API}/api/audio/devices/${id}/mute`, { method: 'POST' })
      if (res.ok) { setMuted(!muted); fetchAll() }
    } catch {}
  }

  const setVolumeLevel = async (id: number, vol: number) => {
    try {
      await fetch(`${API}/api/audio/devices/${id}/volume`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ volume: vol })
      })
      setVolume(vol)
    } catch {}
  }

  const setDefaultDevice = async (id: number) => {
    try {
      const res = await fetch(`${API}/api/audio/devices/${id}/default`, { method: 'POST' })
      if (res.ok) { setStatusText('Đã đặt mặc định'); fetchAll() }
    } catch { setStatusText('Thất bại') }
  }

  const saveSettings = async () => {
    try {
      const res = await fetch(`${API}/api/audio/settings`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(audioSettings)
      })
      if (res.ok) { setStatusText('Đã lưu cài đặt'); setSettingsOpen(false) }
    } catch { setStatusText('Thất bại') }
  }

  // Widget drag handlers - use window for reliable drag
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return
      setWidgetPos({ x: e.clientX - dragOffset.current.x, y: e.clientY - dragOffset.current.y })
    }
    const handleMouseUp = () => { dragging.current = false }
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])
  const handleMouseDown = (e: React.MouseEvent) => {
    dragging.current = true
    dragOffset.current = { x: e.clientX - widgetPos.x, y: e.clientY - widgetPos.y }
  }

  const formatDuration = (seconds: number) => {
    const m = Math.floor(seconds / 60)
    const s = seconds % 60
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  const activeColor = audioSettings.color_mic_on || '#3498DB'
  const inactiveColor = audioSettings.color_mic_off || '#E74C3C'

  // Widget mode overlay
  if (widgetMode) {
    return (
      <div className="fixed" style={{
        left: widgetPos.x, top: widgetPos.y,
        zIndex: 9999,
      }}>
        <div
          className="select-none rounded-xl border backdrop-blur-lg shadow-2xl transition-colors overflow-hidden"
          style={{
            width: 200, height: 200,
            backgroundColor: micStatus?.active ? activeColor : inactiveColor,
            borderColor: micStatus?.active ? `${activeColor}60` : '#475569',
            opacity: audioSettings.widget_opacity ?? 1.0,
          }}
          onMouseDown={handleMouseDown}
        >
          <div className="h-full flex flex-col items-center justify-center p-3 cursor-grab active:cursor-grabbing">
            {/* Icon */}
            <span className="text-5xl mb-2">{micStatus?.active ? '🎤' : '🔇'}</span>
            {/* Timer */}
            <div className="text-white font-bold text-lg font-mono drop-shadow-lg">
              {micStatus?.active ? formatDuration(sessionTimer) : '--:--'}
            </div>
            {/* App name */}
            <div className="text-white/80 text-[10px] mt-1 truncate max-w-full text-center">
              {micStatus?.app_using_mic || 'Không có ứng dụng'}
            </div>
            {/* Status dot */}
            <div className="flex items-center gap-1 mt-1">
              <span className={`w-1.5 h-1.5 rounded-full ${micStatus?.active ? 'bg-green-300 animate-pulse' : 'bg-gray-400'}`} />
              <span className="text-white/70 text-[9px]">{micStatus?.active ? 'Hoạt động' : 'Không hoạt động'}</span>
            </div>
          </div>
        </div>
        {/* Minimize button */}
        <button onClick={() => setWidgetMode(false)}
          className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-gray-800 border border-gray-600 text-white text-[9px] flex items-center justify-center cursor-pointer hover:bg-gray-700"
          title="Thoát chế độ thu gọn">
          ✕
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full p-4 gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold" style={{ color: 'var(--fg)' }}>🎤 Quản lý Âm thanh & Mic</h2>
          <p className="text-[10px]" style={{ color: 'var(--fg-muted)' }}>{devices.length} thiết bị · {sessionHistory.length} phiên</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setWidgetMode(true)}
            className="px-2.5 py-1.5 text-[10px] font-medium rounded-lg border transition-all active:scale-95 cursor-pointer"
            style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}>
            🔲 Thu nhỏ
          </button>
        </div>
      </div>

      {/* Mic Live Status + Timer Dashboard */}
      <div className="grid grid-cols-2 gap-3">
        {/* Mic Status */}
        <div className="rounded-xl border backdrop-blur p-4 transition-all"
          style={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border)' }}>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--fg-muted)' }}>
              🎙 Micro
            </h3>
            {micStatus && (
              <span className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                micStatus.active ? 'bg-emerald-500/15 text-emerald-500 ring-1 ring-emerald-500/20' : 'bg-gray-500/10 text-gray-400 ring-1 ring-gray-500/15'
              }`}>
                <span className={`w-1.5 h-1.5 rounded-full ${micStatus.active ? 'bg-emerald-400 animate-pulse' : 'bg-gray-400'}`} />
                {micStatus.active ? 'ĐANG DÙNG' : 'KHÔNG DÙNG'}
              </span>
            )}
          </div>
          {micStatus ? (
            <div className="space-y-2 text-[11px]">
              <div>
                <span style={{ color: 'var(--fg-muted)' }}>Ứng dụng:</span>
                <p className="font-medium truncate mt-0.5" style={{ color: 'var(--fg)' }}>{micStatus.app_using_mic || 'Không có'}</p>
              </div>
              <div>
                <span style={{ color: 'var(--fg-muted)' }}>Mic:</span>
                <p className="font-medium truncate mt-0.5" style={{ color: 'var(--fg)' }}>{micStatus.mic_name || 'Không rõ'}</p>
              </div>
              <div>
                <span style={{ color: 'var(--fg-muted)' }}>Trạng thái:</span>
                <p className="font-medium mt-0.5" style={{ color: micStatus.active ? '#22c55e' : '#94a3b8' }}>
                  {micStatus.active ? 'Micro đang dùng' : 'Không hoạt động'}
                </p>
              </div>
            </div>
          ) : (
            <p className="text-[11px] italic" style={{ color: 'var(--fg-dim)' }}>Đang kết nối...</p>
          )}
        </div>

        {/* Timer Dashboard */}
        <div className="rounded-xl border backdrop-blur p-4 transition-all"
          style={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border)' }}>
          <h3 className="text-[10px] font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--fg-muted)' }}>
            ⏱ Bộ đếm
          </h3>
          <div className="flex flex-col items-center">
            <div className="text-4xl font-bold font-mono tracking-wider"
              style={{ color: micStatus?.active ? '#22c55e' : 'var(--fg-secondary)' }}>
              {micStatus?.active ? formatDuration(sessionTimer) : '00:00'}
            </div>
            <div className="text-[10px] mt-2 flex items-center gap-3 flex-wrap justify-center">
              <span style={{ color: 'var(--fg-muted)' }}>
                Gần nhất: <strong style={{ color: 'var(--fg-secondary)' }}>{formatDuration(lastSessionDuration)}</strong>
              </span>
              <span style={{ color: 'var(--fg-muted)' }}>
                Phiên: <strong style={{ color: 'var(--fg-secondary)' }}>{sessionHistory.length}</strong>
              </span>
            </div>
            <div className="mt-2 flex gap-1.5">
              <button onClick={() => setHistoryOpen(true)}
                className="px-2 py-0.5 text-[9px] rounded-lg border transition-colors cursor-pointer"
                style={{ borderColor: 'var(--border)', color: 'var(--fg-muted)' }}>
                📋 Lịch sử
              </button>
              <button onClick={() => setSettingsOpen(true)}
                className="px-2 py-0.5 text-[9px] rounded-lg border transition-colors cursor-pointer"
                style={{ borderColor: 'var(--border)', color: 'var(--fg-muted)' }}>
                ⚙️ Settings
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Devices List */}
      <div className="flex-1 overflow-y-auto space-y-2">
        {devices.length === 0 && (
          <div className="flex items-center justify-center h-32">
            <p className="text-xs italic" style={{ color: 'var(--fg-dim)' }}>Không tìm thấy thiết bị âm thanh.</p>
          </div>
        )}
        {devices.map(dev => (
          <div key={dev.id}
            className="rounded-xl border backdrop-blur transition-all duration-200 overflow-hidden"
            style={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border)' }}>
            <div className="flex items-center justify-between p-3 cursor-pointer"
              onClick={() => setSelectedDevice(selectedDevice === dev.id ? null : dev.id)}>
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <span className="text-lg shrink-0">{dev.is_input ? '🎤' : '🔊'}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium truncate" style={{ color: 'var(--fg)' }}>{dev.name}</span>
                    {dev.is_default && (
                      <span className="text-[9px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-1.5 py-0.5 rounded font-medium">MẶC ĐỊNH</span>
                    )}
                  </div>
                  <span className="text-[10px]" style={{ color: 'var(--fg-dim)' }}>
                    {dev.is_input ? 'Đầu vào' : 'Đầu ra'}
                    {dev.muted && <span className="ml-2 text-red-400">🔇 TẮT TIẾNG</span>}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2 ml-3">
                <div className="w-16 h-1.5 rounded-full bg-gray-700/50 overflow-hidden">
                  <div className="h-full rounded-full transition-all" style={{
                    width: `${dev.volume}%`,
                    backgroundColor: dev.volume > 70 ? '#22c55e' : dev.volume > 30 ? '#eab308' : '#ef4444'
                  }} />
                </div>
                <span className="text-[10px] font-mono w-8 text-right" style={{ color: 'var(--fg-muted)' }}>{dev.volume}%</span>
              </div>
            </div>

            {selectedDevice === dev.id && (
              <div className="border-t px-4 py-3 space-y-3" style={{ borderColor: 'var(--border)' }}>
                <div className="flex items-center gap-3">
                  <button onClick={() => toggleMute(dev.id)}
                    className="px-3 py-1 text-[11px] font-medium rounded-lg border transition-colors cursor-pointer"
                    style={{ backgroundColor: dev.muted ? '#ef444420' : 'var(--input-bg)', borderColor: dev.muted ? '#ef444240' : 'var(--border)', color: dev.muted ? '#ef4444' : 'var(--fg-secondary)' }}>
                    {dev.muted ? '🔇 Bật tiếng' : '🔊 Tắt tiếng'}
                  </button>
                  <input id={`volume-${dev.id}`} name="volume" type="range" min={0} max={100} value={volume}
                    onChange={e => setVolumeLevel(dev.id, parseInt(e.target.value))}
                    className="flex-1 accent-emerald-500" />
                  <span className="text-[10px] font-mono w-8 text-right" style={{ color: 'var(--fg-muted)' }}>{volume}%</span>
                </div>
                {!dev.is_default && (
                  <button onClick={() => setDefaultDevice(dev.id)}
                    className="w-full px-3 py-1.5 text-[11px] font-medium bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 rounded-lg transition-colors cursor-pointer border-0">
                    🎯 Đặt mặc định {dev.is_input ? 'Mic' : 'Loa'}
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Settings Modal */}
      {settingsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={e => { if (e.target === e.currentTarget) setSettingsOpen(false) }}>
          <div className="w-full max-w-sm rounded-2xl border shadow-2xl p-6 transition-colors flex flex-col"
            style={{ backgroundColor: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--fg)' }}>
            <div className="flex items-center justify-between pb-4 border-b" style={{ borderColor: 'var(--border)' }}>
              <h3 className="text-sm font-semibold">⚙️ Cài đặt Âm thanh</h3>
              <button onClick={() => setSettingsOpen(false)}
                className="p-1 rounded-lg hover:bg-black/10 dark:hover:bg-white/10 transition-colors cursor-pointer border-0"
                style={{ color: 'var(--fg-muted)' }}>&times;</button>
            </div>
            <div className="mt-4 space-y-4 text-xs">
              <label htmlFor="audio-sound-enabled" className="flex items-center gap-2 cursor-pointer">
                <input id="audio-sound-enabled" name="soundEnabled" type="checkbox" checked={audioSettings.sound_enabled}
                  onChange={e => setAudioSettings(prev => ({ ...prev, sound_enabled: e.target.checked }))}
                  className="accent-emerald-500" />
                <span style={{ color: 'var(--fg-secondary)' }}>Âm thanh báo khi mic bật</span>
              </label>
              <label htmlFor="audio-show-widget" className="flex items-center gap-2 cursor-pointer">
                <input id="audio-show-widget" name="showWidget" type="checkbox" checked={audioSettings.show_widget_on_mic}
                  onChange={e => setAudioSettings(prev => ({ ...prev, show_widget_on_mic: e.target.checked }))}
                  className="accent-emerald-500" />
                <span style={{ color: 'var(--fg-secondary)' }}>Hiện widget khi mic bật</span>
              </label>
              <div>
                <label className="text-[11px] font-medium mb-1 block" style={{ color: 'var(--fg-muted)' }}>
                  Độ mờ widget: {Math.round((audioSettings.widget_opacity ?? 1.0) * 100)}%
                </label>
                <input type="range" min={10} max={100} value={Math.round((audioSettings.widget_opacity ?? 1.0) * 100)}
                  onChange={e => setAudioSettings(prev => ({ ...prev, widget_opacity: parseInt(e.target.value) / 100 }))}
                  className="w-full accent-emerald-500" />
              </div>
              <div>
                <label htmlFor="audio-color-on" className="text-[11px] font-medium mb-1 block" style={{ color: 'var(--fg-muted)' }}>Màu khi hoạt động</label>
                <div className="flex items-center gap-2">
                  <input id="audio-color-on" name="colorMicOn" type="color" value={audioSettings.color_mic_on}
                    onChange={e => setAudioSettings(prev => ({ ...prev, color_mic_on: e.target.value }))}
                    className="w-8 h-8 rounded cursor-pointer border-0" />
                  <span className="font-mono text-[10px]" style={{ color: 'var(--fg-secondary)' }}>{audioSettings.color_mic_on}</span>
                </div>
              </div>
              <div>
                <label htmlFor="audio-color-off" className="text-[11px] font-medium mb-1 block" style={{ color: 'var(--fg-muted)' }}>Màu khi không hoạt động</label>
                <div className="flex items-center gap-2">
                  <input id="audio-color-off" name="colorMicOff" type="color" value={audioSettings.color_mic_off}
                    onChange={e => setAudioSettings(prev => ({ ...prev, color_mic_off: e.target.value }))}
                    className="w-8 h-8 rounded cursor-pointer border-0" />
                  <span className="font-mono text-[10px]" style={{ color: 'var(--fg-secondary)' }}>{audioSettings.color_mic_off}</span>
                </div>
              </div>
              {soundFiles.length > 0 && (
                <div>
                  <label htmlFor="audio-sound-select" className="text-[11px] font-medium mb-1 block" style={{ color: 'var(--fg-muted)' }}>Âm thanh báo</label>
                  <select id="audio-sound-select" name="selectedSound" value={audioSettings.selected_sound || ''}
                    onChange={e => setAudioSettings(prev => ({ ...prev, selected_sound: e.target.value || null }))}
                    className="w-full px-2 py-1.5 text-xs rounded-lg border"
                    style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg)' }}>
                    <option value="">Không</option>
                    {soundFiles.map(f => (
                      <option key={f} value={f}>{f}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button onClick={() => setSettingsOpen(false)}
                className="px-3 py-1.5 text-[11px] font-medium border rounded-lg transition-colors cursor-pointer"
                style={{ borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}>Hủy</button>
              <button onClick={saveSettings}
                className="px-4 py-1.5 text-[11px] font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-colors cursor-pointer border-0">Lưu</button>
            </div>
          </div>
        </div>
      )}

      {/* Session History Modal */}
      {historyOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={e => { if (e.target === e.currentTarget) setHistoryOpen(false) }}>
          <div className="w-full max-w-md rounded-2xl border shadow-2xl p-6 transition-colors flex flex-col max-h-[70vh]"
            style={{ backgroundColor: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--fg)' }}>
            <div className="flex items-center justify-between pb-4 border-b" style={{ borderColor: 'var(--border)' }}>
              <h3 className="text-sm font-semibold">📋 Lịch sử Mic</h3>
              <button onClick={() => setHistoryOpen(false)}
                className="p-1 rounded-lg hover:bg-black/10 dark:hover:bg-white/10 transition-colors cursor-pointer border-0"
                style={{ color: 'var(--fg-muted)' }}>&times;</button>
            </div>
            <div className="mt-4 flex-1 overflow-y-auto space-y-1.5">
              {sessionHistory.length === 0 ? (
                <p className="text-xs italic text-center py-8" style={{ color: 'var(--fg-dim)' }}>Chưa có phiên nào</p>
              ) : (
                sessionHistory.slice(0, 50).map((session, idx) => (
                  <div key={idx} className="p-2 rounded-lg text-[10px]"
                    style={{ backgroundColor: 'var(--input-bg)' }}>
                    <div className="flex items-center justify-between">
                      <span className="font-mono" style={{ color: 'var(--fg-muted)' }}>{session.datetime}</span>
                      <span className="font-bold font-mono" style={{ color: 'var(--fg-secondary)' }}>
                        {Math.floor(session.duration / 60)}m {session.duration % 60}s
                      </span>
                    </div>
                    <div className="mt-1 flex gap-2">
                      <span className="truncate" style={{ color: 'var(--fg-dim)' }}>
                        🎯 {session.app_using || 'Không rõ'}
                      </span>
                      <span className="truncate" style={{ color: 'var(--fg-dim)' }}>
                        🎤 {session.mic_name || 'Không rõ'}
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
            <div className="mt-4 pt-4 border-t flex justify-end" style={{ borderColor: 'var(--border)' }}>
              <button onClick={() => setHistoryOpen(false)}
                className="px-3 py-1.5 text-[11px] font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-colors cursor-pointer border-0">Đóng</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
