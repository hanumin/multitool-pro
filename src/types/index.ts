export type ModuleId = 'servers' | 'printers' | 'audio' | 'file-copier' | 'database' | 'tunnels' | 'logs'

export interface ModuleDef {
  id: ModuleId
  label: string
  icon: string
  description: string
  polls?: boolean // Module có polling nền không?
}

export const MODULES: ModuleDef[] = [
  { id: 'servers', label: 'Máy chủ', icon: '🖥', description: 'Quản lý máy chủ dev', polls: true },
  { id: 'printers', label: 'Máy in', icon: '🖨', description: 'Giám sát và quản lý máy in', polls: true },
  { id: 'audio', label: 'Âm thanh', icon: '🎤', description: 'Giám sát mic & thiết bị âm thanh', polls: true },
  { id: 'file-copier', label: 'Sao chép', icon: '📂', description: 'Sao chép file audio/video theo từ khóa' },
  { id: 'database', label: 'Cơ sở dữ liệu', icon: '🗄️', description: 'Quản lý PostgreSQL/MySQL' },
  { id: 'tunnels', label: 'Tunnel', icon: '🌐', description: 'Quản lý Cloudflare Tunnel', polls: true },
  { id: 'logs', label: 'Nhật ký', icon: '📋', description: 'Xem log hệ thống & chẩn đoán', polls: true },
]

export interface Printer {
  name: string
  status: string
  is_default: boolean
  is_laser?: boolean
  driver_type?: string      // "gdi" | "pcl" | "postscript" | "standard" | "unknown"
  driver_brand?: string    // "Brother" | "EPSON" | "HP" | ...
  tracking_method?: string // "eventlog" | "wmi" | "manual"
  supports_eventlog?: boolean
  jobs: number
  driver: string
  port: string
  location: string
  comment: string
}

export interface AudioDevice {
  id: string
  name: string
  is_input: boolean
  is_default: boolean
  volume: number
  muted: boolean
}

export interface MicMonitorInfo {
  hostapi: string
  samplerate: number
  device_index: number
  device_name: string
}

export interface MicStatus {
  active: boolean
  app_using_mic: string
  mic_name: string
  mic_muted: boolean | null
  overall_status: 'active' | 'muted' | 'idle' | 'no_mic' | 'error'
  available_mics: AvailableMic[]
  mic_count: number
  duration: number
  monitor_info?: MicMonitorInfo | null
}

export interface AvailableMic {
  id: number
  name: string
  channels: number
  default: boolean
  samplerate: number
}

// ─── Preloaded Data Types ─────────────────────────────────────
// WHY: Các type này match chính xác response shape của từng API backend.
// Được dùng trong PreloadedData để thay thế 'any', đảm bảo type safety.

export interface PreloadedProject {
  name: string
  port: number
  path: string
  command?: string
  type?: 'node' | 'custom'
  process_name?: string
  running: boolean
}

export interface PreloadedPrinterSettings {
  days_between_prints: number
  selected_printer: string
  remind_minutes: number
  reminder_enabled: boolean
  last_print_date: string | null
  excluded_printers?: string[]
  page_count?: Record<string, number>
}

export interface PreloadedAudioSettings {
  sound_enabled: boolean
  selected_sound: string | null
  icon_theme: string
}

export interface PreloadedCloudflaredInfo {
  installed: boolean
  version: string | null
  path: string | null
}

export interface PreloadedDebugLog {
  lines: string[]
}

export interface PreloadedDbConnection {
  id?: string
  name: string
  type: 'postgresql' | 'mysql'
  host: string
  port: number
  database: string
  user: string
  password: string
}

// WHY: Dữ liệu preload từ LoadingScreen → truyền xuống từng module.
// Mỗi module dùng preloaded data làm initial state, loại bỏ loading flash hoàn toàn.
// Các field đều optional vì API có thể fail trong quá trình preload.
// KHÔNG dùng 'any' — mỗi field có type cụ thể match API response.
export interface PreloadedData {
  projects?: PreloadedProject[]
  printers?: { printers: Printer[] }
  printerSettings?: { settings: PreloadedPrinterSettings }
  audioDevices?: { devices: AudioDevice[] }
  audioSettings?: PreloadedAudioSettings
  debugLog?: PreloadedDebugLog
  databaseConnections?: PreloadedDbConnection[]
  cloudflared?: PreloadedCloudflaredInfo
}
