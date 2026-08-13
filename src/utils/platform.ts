// WHY: Phát hiện hệ điều hành đang chạy app — dùng để ẩn tính năng Windows-only
// (Âm thanh pycaw, Máy in win32print/EventLog, Tunnel cloudflared.exe) trên bản
// build Mac/Linux. Trong WebView (WebView2/WKWebView) userAgent + userAgentData
// phản ánh OS thật của máy, không cần plugin riêng.
type OSType = 'windows' | 'mac' | 'linux' | 'other'

const detectOS = (): OSType => {
  const ua = navigator.userAgent.toLowerCase()
  const uad = ((navigator as any).userAgentData?.platform || '').toLowerCase()
  if (ua.includes('win') || uad.includes('win')) return 'windows'
  if (ua.includes('mac') || ua.includes('darwin') || uad.includes('mac')) return 'mac'
  if (ua.includes('linux') || uad.includes('linux')) return 'linux'
  return 'other'
}

// WHY: Export hằng số 1 lần (module scope) — tránh gọi detectOS() lặp lại; nền tảng
// không đổi trong suốt vòng đời app nên không cần reactive.
export const OS: OSType = detectOS()
export const isMac = OS === 'mac'
export const isWindows = OS === 'windows'
export const isLinux = OS === 'linux'
