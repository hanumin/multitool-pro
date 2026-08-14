# 🔐 PLAN: Trang Web Quản Lý Tài Khoản Hệ Sinh Thái

> Plan triển khai trang quản lý tài khoản tập trung cho toàn bộ hệ sinh thái
> (MultiTool Pro, english4tumi/english-topics, các phần mềm/website khác)
> Tạo ngày: 14/08/2026 · Trạng thái: **ĐỀ XUẤT — chưa triển khai**

---

## 1. 🎯 Mục tiêu

Xây dựng **một nơi duy nhất** quản lý tài khoản cho toàn bộ hệ sinh thái:

1. **Đăng nhập chung (SSO nội bộ):** 1 tài khoản dùng được cho mọi phần mềm/website
2. **Kiểm soát quyền truy cập:** admin cho phép/từ chối từng user dùng từng app
   (vd cho dùng MultiTool Pro nhưng không cho dùng english4tumi)
3. **Quản lý user:** xem danh sách, kích hoạt/khóa, đặt lại mật khẩu, đổi role
4. **Giao diện user:** user tự xem app mình được dùng, tự đổi mật khẩu, quên mật khẩu

Trang này sẽ đặt tại subdomain quản lý (vd `admin.luongphamhanhnguyen.com` hoặc
`account.luongphamhanhnguyen.com`) — **quyết định tên miền khi triển khai**.

---

## 2. ⚖️ Quyết định chính: Tách project Supabase riêng HAY dùng chung english-topics?

### 2.1 So sánh

| Tiêu chí | ✅ Dùng chung 1 project (english-topics) | Tách project "account-center" riêng |
|----------|------------------------------------------|--------------------------------------|
| Đăng nhập chéo app | Tự nhiên — 1 pool user duy nhất | Phải tự đồng bộ/di trú user giữa các project |
| Cấu hình auth (template email, redirect URL, provider) | 1 nơi duy nhất | Nhân đôi, dễ lệch |
| Bảng phân quyền | 1 bảng `user_profiles` cho tất cả app | Phải tự map `user_id` chéo project (không có FK xuyên project) |
| Quota free plan (DB / MAU / auth) | Dùng chung — dư sức cho hệ sinh thái nội bộ | Mỗi project 1 quota riêng (tiêu tốn 2 project free) |
| Cách ly dữ liệu giữa các app | RLS mỗi app bảng riêng, không lộ | Cách ly cứng tốt hơn |
| Công sức triển khai | Thấp — chỉ thêm cột + 1 trang admin | Cao — phải migrate user (admin API) + quản lý 2 project |

### 2.2 Khuyến nghị

> ✅ **DÙNG CHUNG 1 PROJECT (english-topics) như hiện tại.**

- Hệ sinh thái hiện tại là **cá nhân/nội bộ**, quy mô nhỏ → chung 1 project là đơn giản
  nhất, đúng chuẩn Supabase thiết kế (auth là dịch vụ độc lập với app).
- MultiTool Pro **đã và đang** đăng nhập bằng project này — chuyển sang project mới
  sẽ phá đăng nhập hiện tại.
- Bảng `user_profiles` **đã tồn tại** trong english-topics — chỉ cần thêm cột phân quyền.

### 2.3 Điều kiện kích hoạt TÁCH project (chỉ làm khi xảy ra)

Chỉ tách khi hệ sinh thái đạt ít nhất 1 trong các điều kiện sau:
- Có **khách hàng bên ngoài / nhiều chủ sở hữu dữ liệu** cần cách ly cứng
- 1 app có dữ liệu nhạy cảm cần cô lập khỏi phần còn lại
- Vượt quota free plan của 1 project (DB size, 50k MAU, 500k auth requests)
- Cần báo cáo/quota riêng biệt từng app

Lúc đó: tạo project `account-center` (chỉ chứa auth + `user_profiles`), các app khác
dùng project riêng và chỉ lưu `user_id` tham chiếu (FK logic tự quản lý). Di trú user
qua Supabase Admin API (createUser + copy metadata).

---

## 3. 🏗️ Kiến trúc đề xuất (dùng chung project)

```
┌─────────────────────────────────────────────────────────────┐
│                Supabase project (english-topics)             │
│                                                              │
│  auth.users  (Supabase Auth — đăng nhập/đăng ký/quên MK)     │
│       │ 1:1                                                  │
│  user_profiles  ← THÊM CỘT phân quyền:                      │
│    ├─ allowed_apps  text[]   e.g. {'multitool-pro','english4tumi'} │
│    ├─ is_active     boolean  (khóa/mở tài khoản)             │
│    ├─ role          text     ('user' | 'admin')              │
│    └─ (đã có: full_name, nickname, avatar_url, avatar_emoji) │
│                                                              │
│  RLS policies:                                               │
│  - user chỉ đọc chính mình (đã có)                           │
│  - THÊM: update is_active/allowed_apps chỉ admin (service role)│
└─────────────────────────────────────────────────────────────┘
        ▲              ▲              ▲
        │              │              │
┌───────┴──────┐ ┌─────┴──────┐ ┌─────┴──────────┐
│ MultiTool Pro│ │ english4tumi│ │ Trang quản lý  │
│ (Tauri)      │ │ (Next.js)   │ │ (Next.js admin)│
│ check quyền  │ │ check quyền │ │ service role   │
│ khi mở app   │ │ khi đăng nhập│ │ (CHỈ server)  │
└──────────────┘ └────────────┘ └───────────────┘
```

### 3.1 Bảng & cột cần thêm

```sql
-- Thêm vào bảng user_profiles (đã tồn tại trong english-topics)
ALTER TABLE user_profiles
  ADD COLUMN allowed_apps text[] NOT NULL DEFAULT '{}',
  ADD COLUMN is_active     boolean  NOT NULL DEFAULT true,
  ADD COLUMN role          text     NOT NULL DEFAULT 'user';

-- RLS: user chỉ đọc chính mình (policy đã có) + KHÔNG cho user sửa 2 cột quyền
-- (chỉ service role/admin update — xem mục bảo mật)
```

### 3.2 Luồng kiểm tra quyền ở từng app (ví dụ MultiTool Pro)

1. User đăng nhập thành công → Supabase trả session (token ~1h)
2. App query `user_profiles` lấy `allowed_apps`, `is_active`, `role`
3. Nếu `is_active = false` HOẶC `'multitool-pro' ∉ allowed_apps` → **chặn**
   kèm thông báo: *"Tài khoản chưa được cấp quyền dùng phần mềm này. Liên hệ
   admin tại luongphamhanhnguyen.com"*
4. **Kiểm tra định kỳ** (vd mỗi 5–10 phút) gọi `auth.getUser()` + re-check quyền:
   - User bị khóa giữa phiên → tự đăng xuất
   - (Khi `is_active=false`, refresh token của user cũng bị Supabase chặn trong ~1h
     — check định kỳ giúp chặn nhanh hơn)

### 3.3 Trang admin (trang web quản lý)

| Hạng mục | Đề xuất |
|----------|---------|
| Framework | **Next.js (App Router)** — giống english-topics, tái dùng kinh nghiệm |
| Vị trí | `admin.luongphamhanhnguyen.com` (repo mới hoặc route `/admin` trong english-topics) |
| Supabase key | **Service role key — CHỈ dùng phía server** (Server Actions / API routes), tuyệt đối không đưa vào client |
| Đăng nhập admin | Dùng chung auth pool, check `role = 'admin'` |
| Chức năng | 1) Danh sách user (tìm, lọc) 2) Cấp/thu hồi `allowed_apps` 3) Khóa/mở `is_active` 4) Reset mật khẩu (admin API) 5) Xem lịch sử thay đổi (audit log) |
| UI | Bảng + toggle từng app cho mỗi user; tìm kiếm theo email/tên |

---

## 4. 🔒 Bảo mật — NHỮNG ĐIỀU TUYỆT ĐỐI KHÔNG LÀM

1. ❌ **KHÔNG dùng `user_metadata` để chứa quyền** — user tự sửa được qua
   `auth.updateUser()`. Chỉ dùng để lưu thông tin hiển thị (tên, avatar).
2. ❌ **KHÔNG đưa service role key vào client** (MultiTool Pro, browser) — nó
   bỏ qua RLS, lộ ra là toàn quyền.
3. ❌ **KHÔNG để client tự update `allowed_apps`/`is_active`** — chỉ admin
   (service role hoặc RLS policy role='admin').
4. ✅ Mọi thay đổi quyền phải có **audit log** (bảng `audit_logs`: ai, khi nào, đổi gì).
5. ✅ `allowed_apps` mặc định `'{}'` (không cho app nào) — cấp quyền là chủ động,
   không phải mặc định mở.

---

## 5. 🗺️ Lộ trình triển khai

### Phase 1 — Nền tảng dữ liệu (1–2 ngày)
- [ ] Thêm cột `allowed_apps`, `is_active`, `role` vào `user_profiles`
- [ ] RLS policies cho 2 cột quyền (chỉ admin/service role)
- [ ] Gán role 'admin' cho tài khoản chủ

### Phase 2 — Trang admin (3–5 ngày)
- [ ] Dựng Next.js app (repo mới `account-admin` hoặc route /admin)
- [ ] Trang đăng nhập admin (check role)
- [ ] Bảng quản lý user + toggle app + khóa/mở + reset mật khẩu
- [ ] Audit log

### Phase 3 — App kiểm tra quyền (1–2 ngày/app)
- [ ] **MultiTool Pro:** check `allowed_apps` khi đăng nhập + check định kỳ 5–10 phút
  (đã có sẵn luồng auth — chỉ thêm bước query quyền)
- [ ] **english4tumi:** thêm check tương tự ở middleware/Server Action
- [ ] Trang user tự phục vụ: xem app được dùng, đổi mật khẩu, quên mật khẩu

### Phase 4 — Hoàn thiện (1–2 ngày)
- [ ] Chặn app cũ (MultiTool Pro bản không có check quyền) — cân nhắc: các bản cũ
      sẽ bỏ qua check → chấp nhận rủi ro thấp (nội bộ) hoặc bump version bắt buộc
- [ ] Thông báo lỗi đẹp khi bị từ chối quyền (có link luongphamhanhnguyen.com)
- [ ] Tài liệu cho admin + user

---

## 6. 📝 Ghi chú quyết định

| Ngày | Quyết định | Lý do |
|------|-----------|-------|
| 14/08/2026 | Dùng chung project english-topics | Quy mô nội bộ, đơn giản, MultiTool Pro đã kết nối sẵn |
| 14/08/2026 | Trang quản lý = Next.js + service role server-side | Đồng bộ stack với english-topics, an toàn |
| 14/08/2026 | Quyền = cột `allowed_apps` trong `user_profiles` | Mở rộng được, RLS kiểm soát được, không thể bị user tự sửa |
