/**
 * Shared API configuration and fetch with retry.
 *
 * WHY: Backend có thể tạm thời không phản hồi (auto-restart wrapper, network blip).
 * Thay vì mỗi module tự xử lý retry, dùng fetchWithRetry() với exponential backoff.
 *
 * Retry pattern:
 *   - Network errors (fetch throws): retry after 1s → 3s → 7s
 *   - 5xx server errors: retry with same backoff
 *   - 4xx client errors: KHÔNG retry (lỗi do request, không phải server)
 *   - GET requests: retry tối đa 3 lần
 *   - POST/PUT/DELETE: retry tối đa 1 lần (tránh duplicate side effects)
 */

export const API = 'http://127.0.0.1:5050'

const RETRY_DELAYS = [1000, 3000, 7000]

/**
 * Fetch với auto-retry trên transient errors.
 *
 * @param url - URL cần fetch
 * @param options - RequestInit (method, headers, body, etc.)
 * @param retries - Số lần retry (mặc định 2, tổng 3 attempts)
 * @returns Promise<Response>
 * @throws Error nếu tất cả retry đều thất bại
 */
export async function fetchWithRetry(
  url: string,
  options?: RequestInit,
  retries?: number
): Promise<Response> {
  // WHY: Nếu caller không truyền retries, dùng default theo method như docstring đã hứa:
  // GET = 2 retries (tổng 3 attempts), POST/PUT/DELETE = 1 retry (tổng 2 attempts).
  // Trước đây default cứng = 2 cho MỌI method → POST bị retry 2 lần → ví dụ set-default
  // mic (backend tự retry verify tới 4.5s) bị gọi lại 3 lần → user phải bấm nhiều lần
  // + chồng request song song gây COM contention.
  if (retries === undefined) {
    const method = (options?.method || 'GET').toUpperCase()
    retries = method === 'GET' ? 2 : 1
  }
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options)

      // WHY: 4xx là lỗi client (bad request, not found, etc.) — retry cũng vô ích
      if (res.ok || (res.status >= 400 && res.status < 500)) {
        return res
      }

      // WHY: 5xx là lỗi server — có thể hồi phục, retry
      if (attempt < retries) {
        await sleep(RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)])
        continue
      }
      return res // Lần cuối, trả về dù 5xx
    } catch (err) {
      // WHY: Nếu request bị abort (AbortController), throw ngay không retry
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw err
      }
      // WHY: Network error (fetch throw) — retry
      if (attempt < retries) {
        await sleep(RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)])
      } else {
        throw err
      }
    }
  }
  throw new Error('fetchWithRetry: unreachable')
}

// WHY: Promise sleep giữa các lần retry — dùng RETRY_DELAYS lũy tiến (100ms,
// 300ms, 1s...) để không spam backend khi nó vừa mới hồi phục.
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
