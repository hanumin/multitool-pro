import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// WHY: Supabase Auth dùng CHUNG với project english-topics (xjfttrbucggqieykjqxu).
// Bất kỳ app nào có URL + anon key đều gọi được API auth (signInWithPassword,
// signUp, resetPasswordForEmail...) — đây là thiết kế chính thức của Supabase:
// auth là dịch vụ độc lập với app, 1 pool tài khoản dùng cho nhiều app.
//
// URL + anon key là PUBLIC keys (thiết kế để nhúng trong client/browser) — an toàn
// khi đưa vào bundle. Service role key TUYỆT ĐỐI không được đưa vào đây (chỉ dùng
// server-side).
const SUPABASE_URL = 'https://xjfttrbucggqieykjqxu.supabase.co'
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhqZnR0cmJ1Y2dncWlleWtqcXh1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg0NjMzNTUsImV4cCI6MjA5NDAzOTM1NX0.acGyzt5xqfJMif0cbTY2OkjZtxFvu_YAp1FIzXhJO44'

// WHY: Singleton client — tạo 1 lần, dùng chung cho cả app (auth persistence mặc
// định localStorage — hoạt động tốt trong Tauri webview, session giữ được giữa
// các lần mở app).
let _client: SupabaseClient | null = null

// WHY: Lazy singleton — tránh khởi tạo client khi chưa cần (import side-effect
// sạch, test friendly). createClient có thể throw nếu config sai → chỉ chạy khi
// thực sự gọi.
export function getSupabase(): SupabaseClient {
  if (!_client) {
    _client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false, // Tauri không dùng URL query redirect như web
      },
    })
  }
  return _client
}
