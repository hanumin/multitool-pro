export type ModuleId = 'servers' | 'printers' | 'audio' | 'file-copier' | 'database' | 'tunnels' | 'logs'

export interface ModuleDef {
  id: ModuleId
  label: string
  icon: string
  description: string
}

export const MODULES: ModuleDef[] = [
  { id: 'servers', label: 'Máy chủ', icon: '🖥', description: 'Quản lý máy chủ dev' },
  { id: 'printers', label: 'Máy in', icon: '🖨', description: 'Giám sát và quản lý máy in' },
  { id: 'audio', label: 'Âm thanh', icon: '🎤', description: 'Giám sát mic & thiết bị âm thanh' },
  { id: 'file-copier', label: 'Sao chép', icon: '📂', description: 'Sao chép file audio/video theo từ khóa' },
  { id: 'database', label: 'Cơ sở dữ liệu', icon: '🗄️', description: 'Quản lý PostgreSQL/MySQL' },
  { id: 'tunnels', label: 'Tunnel', icon: '🌐', description: 'Quản lý Cloudflare Tunnel' },
  { id: 'logs', label: 'Nhật ký', icon: '📋', description: 'Xem log hệ thống & chẩn đoán' },
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
  id: number
  name: string
  is_input: boolean
  is_default: boolean
  volume: number
  muted: boolean
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
}

export interface AvailableMic {
  id: number
  name: string
  channels: number
  default: boolean
  samplerate: number
}
