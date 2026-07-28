// WHY: Hàm dùng chung cho ServersModule + LogModule — tô màu dòng log dựa trên nội dung + zebra striping.
// Hỗ trợ tùy chỉnh màu sắc qua LogColors (dùng trong SettingsModal).
// Mỗi cấp độ log có màu text, background (chẵn/lẻ), border indicator riêng.

export interface LogLineStyle {
  color: string
  backgroundColor: string
  borderLeft?: string
  paddingLeft?: string
}

// WHY: Cấu hình màu sắc log tùy chỉnh — mỗi key là text color của cấp độ tương ứng.
// Background và border được tự động sinh từ text color với opacity khác nhau.
export interface LogColors {
  error?: string
  warn?: string
  success?: string
  build?: string
  tunnel?: string
  metrics?: string
  cleanup?: string
  debug?: string
  defaultText?: string
}

// WHY: Màu mặc định (fallback khi user chưa tùy chỉnh).
export const DEFAULT_LOG_COLORS: Required<LogColors> = {
  error: '#f87171',
  warn: '#fbbf24',
  success: '#4ade80',
  build: '#60a5fa',
  tunnel: '#60a5fa',
  metrics: '#a78bfa',
  cleanup: '#f472b6',
  debug: '#94a3b8',
  defaultText: 'var(--fg-secondary)',
}

// WHY: Chuyển hex -> rgba. Với CSS variables (không parse được), fallback về white overlay.
export function hexToRgba(color: string, alpha: number): string {
  if (color.startsWith('#')) {
    const r = parseInt(color.slice(1, 3), 16)
    const g = parseInt(color.slice(3, 5), 16)
    const b = parseInt(color.slice(5, 7), 16)
    if (!isNaN(r) && !isNaN(g) && !isNaN(b)) {
      return `rgba(${r},${g},${b},${alpha})`
    }
  }
  // CSS variable fallback — không parse được, dùng white overlay nhẹ
  return `rgba(255,255,255,${alpha * 0.4})`
}

// WHY: Các cấp độ log với opacity cho background (even row), background alt (odd row), và border.
interface LevelDef {
  key: keyof LogColors
  bgAlpha: number      // opacity cho even row
  bgAltAlpha: number   // opacity cho odd row
  borderAlpha: number  // opacity cho border
  borderWidth?: string
}

const LEVELS: LevelDef[] = [
  { key: 'error',    bgAlpha: 0.06, bgAltAlpha: 0.03, borderAlpha: 0.4 },
  { key: 'warn',     bgAlpha: 0.06, bgAltAlpha: 0.03, borderAlpha: 0.4 },
  { key: 'success',  bgAlpha: 0.05, bgAltAlpha: 0,    borderAlpha: 0.3 },
  { key: 'build',    bgAlpha: 0.05, bgAltAlpha: 0,    borderAlpha: 0.3 },
  { key: 'tunnel',   bgAlpha: 0.05, bgAltAlpha: 0,    borderAlpha: 0.3 },
  { key: 'metrics',  bgAlpha: 0.04, bgAltAlpha: 0,    borderAlpha: 0.3 },
  { key: 'cleanup',  bgAlpha: 0.04, bgAltAlpha: 0,    borderAlpha: 0.3 },
  { key: 'debug',    bgAlpha: 0.04, bgAltAlpha: 0,    borderAlpha: 0.2 },
]

// WHY: Kiểm tra dòng log thuộc cấp độ nào — trả về key tương ứng hoặc null cho default.
export function detectLevel(line: string): keyof LogColors | null {
  const lower = line.toLowerCase()

  if (lower.includes('error') || lower.includes('fail') || lower.includes('exception') || lower.includes('traceback') || lower.includes('❌')) return 'error'
  if (lower.includes('warn') || lower.includes('warning') || lower.includes('⚠️')) return 'warn'
  if (lower.includes('success') || lower.includes('done') || lower.includes('✅') || (lower.includes('tunnel') && (lower.includes('url') || lower.includes('active')))) return 'success'
  if (lower.includes('build')) return 'build'
  if (lower.includes('[tunnel') || lower.includes('[watchdog') || lower.includes('[alert') || lower.includes('[sleep')) return 'tunnel'
  if (lower.includes('[request') || lower.includes('[hourly') || lower.includes('metrics')) return 'metrics'
  if (lower.includes('[cleanup') || lower.includes('[migrate') || lower.includes('[health')) return 'cleanup'
  if (lower.includes('debug') || lower.includes('verbose') || lower.includes('trace')) return 'debug'

  return null // default / info
}

// WHY: Phát hiện terminal theme từ DOM — fallback về 'dark' nếu không tìm thấy.
// Dùng cho getLineStyle để chọn background phù hợp (sáng cho dark, tối cho light).
function getTerminalTheme(): 'light' | 'dark' {
  if (typeof document !== 'undefined') {
    const terminal = document.querySelector('.terminal-body')
    if (terminal) {
      const bg = getComputedStyle(terminal).backgroundColor
      // Nếu nền sáng (rgb gần 255), dùng dark overlay cho lines
      return bg && parseInt(bg.split(',')[0].replace(/\D/g, '')) > 200 ? 'light' : 'dark'
    }
  }
  return 'dark'
}

// WHY: Tạo style cho 1 dòng log. customColors cho phép ghi đè màu từ Settings.
// Theme-aware: tự động dùng dark/light background overlay phù hợp.
export function getLineStyle(line: string, index: number, customColors?: LogColors, theme?: 'light' | 'dark'): LogLineStyle {
  const level = detectLevel(line)
  const isOdd = index % 2 === 0
  const colors = { ...DEFAULT_LOG_COLORS, ...customColors }
  const isLight = theme === 'light' || (!theme && getTerminalTheme() === 'light')

  if (level && level !== 'defaultText') {
    const def = LEVELS.find(l => l.key === level)
    if (def) {
      const color = colors[level]!
      return {
        color,
        backgroundColor: hexToRgba(color, isOdd ? def.bgAlpha : def.bgAltAlpha),
        borderLeft: `${def.borderWidth || '2px'} solid ${hexToRgba(color, def.borderAlpha)}`,
        paddingLeft: '4px',
      }
    }
  }

  // Default / Info — theme-aware background
  return {
    color: colors.defaultText!,
    backgroundColor: isOdd
      ? (isLight ? 'rgba(0,0,0,0.02)' : 'rgba(255,255,255,0.02)')
      : 'transparent',
  }
}
