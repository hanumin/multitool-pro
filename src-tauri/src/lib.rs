use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};

// WHY: Format timestamp [YYYY-MM-DD HH:MM:SS] cho header debug.log. Dùng chrono
// Local::now() để khớp GIỜ ĐỊA PHƯƠNG với backend debug_log() (datetime.now() local)
// — nếu dùng SystemTime (UTC) header lệch 7h với phần còn lại của log (đã xác nhận:
// Rust 07:45 vs Python local 14:45). chrono đã có sẵn trong dependency tree (transitive
// qua tauri), thêm vào Cargo.toml để dùng trực tiếp.
fn now_log_timestamp() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

#[allow(dead_code)]
struct FlaskProcess(Mutex<Option<Child>>);

// WHY: Cờ trạng thái watchdog backend (thread nền).
// - BACKEND_WATCHDOG_ENABLED: user có thể tắt tạm (khi chủ động gọi /api/shutdown để
//   dừng mọi thứ — nếu không watchdog sẽ tự restart backend ngay sau đó, vô hiệu hóa
//   ý định "dừng hẳn" của user).
// - SHUTTING_DOWN: app đang thoát (tray quit) → watchdog dừng ngay, không restart nữa.
static BACKEND_WATCHDOG_ENABLED: AtomicBool = AtomicBool::new(true);
static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);
// WHY: Đếm số lần watchdog TỰ restart backend (không tính restart thủ công từ UI) —
// gửi kèm event cho frontend để hiển thị "lần thứ N" trong toast.
static BACKEND_RESTART_COUNT: AtomicU32 = AtomicU32::new(0);

// WHY: Serialize spawn_backend() — watchdog thread và nút "Khởi động lại" (UI) có thể
// gọi đồng thời khi backend chết. Nếu không có lock, 2 luồng cùng chạy kill_orphan +
// spawn → 2 pythonw đua nhau bind port 5050 (một đứa thắng, đứa kia crash-loop).
// Lock này đảm bảo chỉ 1 luồng spawn tại 1 thời điểm.
static BACKEND_SPAWN_LOCK: Mutex<()> = Mutex::new(());

// WHY: Tìm thư mục gốc project (nơi chứa backend/app.py) — đi ngược từ vị trí exe.
// Dùng chung cho run(), restart_backend() và watchdog (tránh duplicate logic).
fn find_project_root() -> std::path::PathBuf {
    let has_backend = |d: &std::path::Path| -> bool {
        d.join("backend").join("app.py").is_file()
            || d.join("Resources").join("backend").join("app.py").is_file()
    };

    std::env::current_exe()
        .ok()
        .as_ref()
        .and_then(|p| p.parent())
        .and_then(|p| p.ancestors().find(|d| has_backend(d)))
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| {
            let cwd = std::env::current_dir().unwrap_or_default();
            if has_backend(&cwd) {
                cwd
            } else {
                cwd.ancestors()
                    .find(|d| has_backend(d))
                    .map(|p| p.to_path_buf())
                    .unwrap_or(cwd)
            }
        })
}

// WHY: Nhúng backend (PyInstaller onefile — chứa Python runtime + Flask + mọi dep) vào
// thẳng binary Tauri → portable khép kín 1 file duy nhất (không cần Python cài sẵn).
// Tên file nhúng khác theo OS: Windows = backend.exe, macOS/Linux = backend (không đuôi).
// include_bytes! yêu cầu file tồn tại LÚC COMPILE — build.rs tạo placeholder rỗng cho dev
// build; bản thật được build script/CI (chạy PyInstaller) copy vào src-tauri/backend-embed/
// TRƯỚC khi gọi tauri build. Dev build có placeholder rỗng → len nhỏ → fallback python.
#[cfg(target_os = "windows")]
static EMBEDDED_BACKEND: &[u8] = include_bytes!("../backend-embed/backend.exe");
#[cfg(not(target_os = "windows"))]
static EMBEDDED_BACKEND: &[u8] = include_bytes!("../backend-embed/backend");

// WHY: Tên file backend nhúng theo nền tảng — dùng chung cho ensure_embedded_backend
// (đường dẫn giải nén) để không lệch với include_bytes! ở trên.
fn embedded_backend_name() -> &'static str {
    if cfg!(windows) { "backend.exe" } else { "backend" }
}

// WHY: Kiểm tra file nhúng có phải binary thật không (placeholder dev rỗng → bỏ qua).
// Chấp nhận: PE (Windows "MZ"), Mach-O 64 thin (macOS 0xCFFAEDFE), Mach-O FAT/universal
// (macOS 0xCAFEBABE / 0xBEBAFECA — bản universal2 chứa cả Intel + Silicon), ELF (Linux).
fn is_plausible_backend(bytes: &[u8]) -> bool {
    bytes.len() >= 1_000_000
        && (bytes.starts_with(b"MZ")
            || bytes.starts_with(&[0xCF, 0xFA, 0xED, 0xFE])
            || bytes.starts_with(&[0xCA, 0xFE, 0xBA, 0xBE])
            || bytes.starts_with(&[0xBE, 0xBA, 0xFE, 0xCA])
            || bytes.starts_with(b"\x7fELF"))
}

// WHY: Giải nén backend nhúng ra cache CỐ ĐỊNH (không phải temp) để không ghi lại mỗi
// lần mở app; chỉ ghi khi file thiếu hoặc kích thước khác (bản backend mới). Ghi temp
// rồi rename (atomic) tránh file nửa chừng khi đọc. Thư mục theo OS: %LOCALAPPDATA% trên
// Windows, $HOME trên macOS/Linux.
fn ensure_embedded_backend() -> Option<std::path::PathBuf> {
    // WHY: Placeholder dev = rỗng (0 byte) → bỏ qua. Backend thật ≥ vài MB + magic đúng OS.
    if !is_plausible_backend(EMBEDDED_BACKEND) {
        return None;
    }
    #[cfg(target_os = "windows")]
    let base = std::env::var_os("LOCALAPPDATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    #[cfg(not(target_os = "windows"))]
    let base = std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let dir = base.join("multitool-pro").join("backend");
    std::fs::create_dir_all(&dir).ok()?;
    let target = dir.join(embedded_backend_name());
    let needs_write = !target.exists()
        || std::fs::metadata(&target)
            .map(|m| m.len() as usize != EMBEDDED_BACKEND.len())
            .unwrap_or(true);
    if needs_write {
        let tmp = dir.join(format!("{}.new", embedded_backend_name()));
        if std::fs::write(&tmp, EMBEDDED_BACKEND).is_err() {
            return None;
        }
        let _ = std::fs::remove_file(&target);
        if std::fs::rename(&tmp, &target).is_err() {
            return None;
        }
    }
    Some(target)
}

// WHY: Helper dùng chung — build Command spawn backend. Ưu tiên backend.exe NHÚNG (portable
// khép kín), fallback python backend/app.py (dev build hoặc chưa build backend thật). Dùng
// chung cho run() (spawn lần đầu), spawn_backend() (restart/watchdog) — tránh lệch logic.
fn build_backend_command(
    project_root: &std::path::Path,
    exe_path_str: &str,
) -> Option<std::process::Command> {
    // WHY: DEBUG build ưu tiên python backend/app.py (source LIVE) — sau khi build release
    // bằng build-portable.ps1, backend-embed/backend.exe THẬT (38MB) tồn tại vĩnh viễn;
    // nếu dev build cũng dùng nó thì sửa app.py không ăn (stale embedded). Dev = code mới.
    // RELEASE build ưu tiên backend nhúng (khép kín 1 file, không cần Python).
    if !cfg!(debug_assertions) {
        if let Some(bexe) = ensure_embedded_backend() {
            let mut cmd = Command::new(&bexe);
            cmd.args(["5050"])
                .current_dir(project_root)
                .env("SERVER_DASHBOARD_EXE", exe_path_str)
                .env("MULTITOOL_PRO_EXE", exe_path_str);
            return Some(cmd);
        }
    }
    let python = find_python()?;
    let use_pythonw = python
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .contains("pythonw");
    let mut cmd = Command::new(&python);
    if !use_pythonw {
        cmd.arg("-u");
    }
    cmd.args(["backend/app.py", "5050"])
        .current_dir(project_root)
        .env("SERVER_DASHBOARD_EXE", exe_path_str)
        .env("MULTITOOL_PRO_EXE", exe_path_str);
    Some(cmd)
}

// WHY: Tìm Python interpreter - pythonw ẩn console, python hiện console.
// Thử pythonw → python → py launcher → các đường dẫn phổ biến (gồm 3.13/3.14).
fn find_python() -> Option<std::path::PathBuf> {
    // WHY: Tìm lệnh theo OS — Windows dùng `where`, macOS/Linux dùng `which`; tên binary
    // ưu tiên pythonw (ẩn console) trên Windows, python3 trên unix (không có pythonw).
    let finder = if cfg!(windows) { "where" } else { "which" };
    let names: &[&str] = if cfg!(windows) { &["pythonw", "python", "py"] } else { &["python3", "python"] };
    for name in names {
        if let Ok(path) = std::process::Command::new(finder).arg(name).output() {
            if path.status.success() {
                let p = String::from_utf8_lossy(&path.stdout).trim().to_string();
                if !p.is_empty() {
                    return Some(std::path::PathBuf::from(p.lines().next().unwrap()));
                }
            }
        }
    }
    let common_paths = [
        r"C:\Python314\pythonw.exe",
        r"C:\Python313\pythonw.exe",
        r"C:\Python312\pythonw.exe",
        r"C:\Python311\pythonw.exe",
        r"C:\Python310\pythonw.exe",
        r"C:\Python39\pythonw.exe",
        r"C:\Users\nguyenthanhdat_pc\AppData\Local\Programs\Python\Python314\pythonw.exe",
        r"C:\Users\nguyenthanhdat_pc\AppData\Local\Programs\Python\Python313\pythonw.exe",
        r"C:\Users\nguyenthanhdat_pc\AppData\Local\Programs\Python\Python312\pythonw.exe",
        r"C:\Users\nguyenthanhdat_pc\AppData\Local\Programs\Python\Python311\pythonw.exe",
        r"C:\Users\nguyenthanhdat_pc\AppData\Local\Programs\Python\Python310\pythonw.exe",
    ];
    for p in common_paths {
        if std::path::Path::new(p).exists() {
            return Some(std::path::PathBuf::from(p));
        }
    }
    None
}

// WHY: Spawn backend Flask (backend/app.py 5050) từ project_root — dùng chung cho
// khởi động lần đầu (run), restart thủ công (nút UI) và watchdog tự restart.
// Kill orphan/child cũ trước, spawn mới, lưu Child vào state FlaskProcess.
fn spawn_backend(app: &tauri::AppHandle) -> Result<String, String> {
    // WHY: Nếu app đang thoát, không spawn backend mới — tránh tạo pythonw mồ côi
    // giữ port 5050 ngay trước khi app.exit(0).
    if SHUTTING_DOWN.load(Ordering::Relaxed) {
        return Err("App is shutting down".to_string());
    }
    // WHY: Giữ lock suốt cả quá trình check-health + kill-orphan + spawn + lưu state —
    // luồng thứ 2 (watchdog hoặc nút UI) chờ đến khi xong. unwrap_or_else(poisoned)
    // để phục hồi nếu thread khác panic khi đang giữ lock (nếu dùng unwrap(), mọi
    // lần gọi sau đều panic → watchdog chết âm thầm, auto-recovery bị tắt vĩnh viễn).
    let _spawn_guard = BACKEND_SPAWN_LOCK.lock().unwrap_or_else(|e| e.into_inner());

    // WHY: Re-check health TRONG lock (không phải trước khi lock) — giữa lúc watchdog
    // check health (fail 3 lần) và lúc giành được lock, backend có thể vừa được restart
    // thủ công / tự phục hồi. Nếu giờ đang khỏe thì KHÔNG kill + spawn lại (tránh giết
    // backend vừa mới khỏe một cách thừa thãi).
    if is_backend_healthy() {
        println!("[backend] Backend already healthy on :5050 — skipping respawn");
        return Ok("Backend already running".to_string());
    }

    let project_root = find_project_root();
    let exe_path = std::env::current_exe().unwrap_or_default();
    let exe_path_str = exe_path.to_string_lossy().to_string();

    // WHY: Kill backend cũ (nếu còn sống) trước khi spawn mới — tránh pythonw mồ côi
    // từ lần chạy trước giữ port 5050 làm backend mới bind fail.
    kill_orphan_backend();
    kill_flask_child(app);

    // WHY: Ưu tiên backend.exe NHÚNG (portable khép kín 1 file) — fallback python
    // backend/app.py ở dev build (placeholder rỗng).
    let flask = match build_backend_command(&project_root, &exe_path_str) {
        Some(mut cmd) => cmd.spawn().ok(),
        None => {
            return Err("Python not found. Please install Python and add to PATH.".to_string())
        }
    };

    if let Some(child) = flask {
        if let Some(state) = app.try_state::<FlaskProcess>() {
            let mut guard = state.0.lock().unwrap();
            *guard = Some(child);
        }
        println!("[backend] Flask started from {}", project_root.display());
        Ok(format!("Backend started from {}", project_root.display()))
    } else {
        Err("Failed to start Flask backend".to_string())
    }
}

// WHY: Thread watchdog — mỗi 5s kiểm tra /api/preload. Nếu backend không phản hồi
// 3 lần liên tiếp (~15s) → tự restart (spawn_backend). Cooldown 60s giữa 2 lần
// restart để tránh restart loop khi backend vừa spawn xong chưa kịp boot.
fn start_backend_watchdog(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let mut consecutive_failures: u32 = 0;
        // WHY: Boot grace 20s — backend vừa spawn lần đầu cần vài giây để Python
        // import + Flask boot. Nếu fail đủ 3 lần (15s) trong 20s đầu thì backend đang
        // boot chậm chứ chưa chắc đã chết → không restart vội (tránh restart loop).
        let started_at = Instant::now();
        // WHY: Cooldown 60s giữa 2 lần restart — nếu backend vừa restart xong lại chết
        // ngay (ví dụ Python lỗi, port conflict), tránh restart loop vô hạn.
        let mut last_restart = Instant::now() - Duration::from_secs(60);
        loop {
            std::thread::sleep(Duration::from_secs(5));
            if !BACKEND_WATCHDOG_ENABLED.load(Ordering::Relaxed) || SHUTTING_DOWN.load(Ordering::Relaxed) {
                consecutive_failures = 0;
                continue;
            }
            if is_backend_healthy() {
                consecutive_failures = 0;
                continue;
            }
            consecutive_failures += 1;
            // WHY: Restart chỉ khi fail >=3 lần liên tiếp (backend thực sự chết/treo,
            // không phải boot đang chậm), đã qua boot grace 20s, VÀ đã qua cooldown
            // 60s kể từ lần restart trước.
            if consecutive_failures >= 3
                && started_at.elapsed() >= Duration::from_secs(20)
                && last_restart.elapsed() >= Duration::from_secs(60)
            {
                println!("[backend-watchdog] Backend unhealthy ({} checks) — restarting...", consecutive_failures);
                let restarted = match spawn_backend(&app) {
                    Ok(msg) => {
                        println!("[backend-watchdog] {}", msg);
                        // WHY: Chỉ đếm + thông báo khi watchdog THỰC SỰ spawn backend mới.
                        // CONTRACT: spawn_backend trả "Backend started from ..." khi spawn
                        // thành công, "Backend already running" khi backend vừa tự hồi phục
                        // giữa chừng (không phải watchdog restart → không đếm). Nếu đổi
                        // message ở spawn_backend, phải đổi cả check này.
                        msg.starts_with("Backend started")
                    }
                    Err(e) => {
                        println!("[backend-watchdog] Restart failed: {}", e);
                        false
                    }
                };
                if restarted {
                    let count = BACKEND_RESTART_COUNT.fetch_add(1, Ordering::Relaxed) + 1;
                    // WHY: Emit event sang frontend (main window + tray) — App.tsx lắng
                    // nghe và hiện toast "Backend đã được tự khởi động lại lúc HH:MM (lần
                    // thứ N)". Payload dùng unix_ms để frontend format giờ LOCAL đúng.
                    let payload = serde_json::json!({
                        "unix_ms": std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|d| d.as_millis() as u64)
                            .unwrap_or(0),
                        "count": count,
                    });
                    // WHY: emit_to("main", ...) chỉ gửi tới cửa sổ chính (nơi hiện toast)
                    // — không broadcast tới tray_menu/audio-widget (tránh IPC thừa).
                    let _ = app.emit_to("main", "backend-watchdog-restarted", payload);
                    println!("[backend-watchdog] Emitted backend-watchdog-restarted (count={})", count);
                }
                last_restart = Instant::now();
                consecutive_failures = 0;
            }
        }
    });
}

// WHY: Bật/tắt watchdog từ UI — App.tsx gọi tắt trước khi POST /api/shutdown
// (user muốn dừng hẳn mọi thứ, watchdog không được tự bật backend lại).
#[tauri::command]
fn set_backend_watchdog(enabled: bool) {
    BACKEND_WATCHDOG_ENABLED.store(enabled, Ordering::Relaxed);
    println!("[backend-watchdog] {}", if enabled { "ENABLED" } else { "DISABLED (manual stop)" });
}

#[tauri::command]
fn get_backend_url() -> String {
    "http://127.0.0.1:5050".into()
}

#[tauri::command]
fn update_tray_status(app: tauri::AppHandle, running: u32, total: u32) {
    if let Some(tray) = app.tray_by_id("main_tray") {
        let tooltip = format!("Server Dashboard ({}/{} running)", running, total);
        let _ = tray.set_tooltip(Some(tooltip));
    }
}

// WHY: Thoát ứng dụng hoàn toàn từ tray menu. Tray_menu là webview riêng không có
// plugin-process, nên thay vì @tauri-apps/plugin-process exit() (chưa đăng ký ở Rust),
// ta expose command này để gọi invoke('quit_app').
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    // WHY: Báo watchdog dừng ngay (không tự restart backend khi app đang thoát).
    SHUTTING_DOWN.store(true, Ordering::Relaxed);
    // WHY: Kill backend Flask trước khi thoát — nếu không, pythonw.exe mồ côi giữ
    // port 5050 vĩnh viễn → lần chạy sau backend mới không bind được port → báo
    // "không kết nối backend" (một nguyên nhân user gặp lỗi này).
    kill_flask_child(&app);
    app.exit(0);
}

// WHY: Helper — kill child Flask đang được quản lý (nếu còn sống).
// Dùng chung cho quit_app (dọn port trước khi thoát) và restart_backend
// (kill backend cũ trước khi spawn mới, tránh port 5050 bị chiếm).
fn kill_flask_child(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<FlaskProcess>() {
        // WHY: unwrap_or_else phục hồi lock bị poison (thread khác panic khi đang giữ)
        // — nếu unwrap() trực tiếp, mọi lần kill sau đó panic → backend mồ côi không
        // bao giờ được dọn.
        let mut guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

// WHY: Dọn mọi process đang LISTEN trên port 5050 trước khi spawn backend mới.
// Xử lý trường hợp pythonw mồ côi từ phiên trước (app bị force-kill / crash không
// chạy quit_app) vẫn giữ port 5050 → backend mới bind fail → auto-restart loop 10 lần
// rồi bỏ cuộc → UI báo "không kết nối backend". Dùng netstat -ano để tìm PID đang
// LISTEN trên :5050 rồi taskkill (chỉ giết tiến trình của chính backend cũ — port
// 5050 là port riêng của app, không ai khác dùng).
fn kill_orphan_backend() {
    if cfg!(windows) {
        if let Ok(out) = std::process::Command::new("netstat").args(["-ano"]).output() {
            let text = String::from_utf8_lossy(&out.stdout);
            for line in text.lines() {
                if line.contains(":5050") && (line.contains("LISTENING") || line.contains("LISTEN")) {
                    if let Some(pid_str) = line.split_whitespace().last() {
                        if let Ok(pid) = pid_str.parse::<u32>() {
                            // WHY: Bỏ qua tiến trình của chính mình (không thể xảy ra ở đây
                            // vì chạy trước khi spawn, nhưng giữ để an toàn).
                            if pid == std::process::id() {
                                continue;
                            }
                            let _ = std::process::Command::new("taskkill")
                                .args(["/F", "/PID", &pid_str])
                                .status();
                        }
                    }
                }
            }
        }
    }
}

// WHY: Kiểm tra backend hiện tại (nếu có) có phản hồi khỏe mạnh không.
// Dùng trước khi kill orphan — nếu port 5050 đang có backend KHỎE (ví dụ user mở
// app lần 2 trong khi instance 1 còn chạy, hoặc backend mồ côi vẫn sống khỏe), ta
// KHÔNG nên giết nó. Chỉ kill + spawn lại khi backend trên 5050 treo/không phản hồi
// (deadlock cũ giữ port) hoặc không tồn tại.
fn is_backend_healthy() -> bool {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(3))
        .build();
    let client = match client {
        Ok(c) => c,
        Err(_) => return false,
    };
    match client.get("http://127.0.0.1:5050/api/preload").send() {
        Ok(resp) => resp.status().is_success(),
        Err(_) => false,
    }
}

#[allow(dead_code)]
fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

// WHY: Kiểm tra backend có đang chạy không bằng cách gọi /api/preload
#[tauri::command]
async fn check_backend_health() -> Result<bool, String> {
    let client = reqwest::Client::new();
    match client.get("http://127.0.0.1:5050/api/preload")
        .timeout(Duration::from_secs(3))
        .send()
        .await {
        Ok(resp) => Ok(resp.status().is_success()),
        Err(_) => Ok(false),
    }
}

// WHY: Khởi động lại backend (nút UI hoặc sau khi watchdog nhận thấy backend chết)
// — delegate cho spawn_backend() dùng chung (tránh duplicate logic + đảm bảo kill
// orphan cũ trước khi spawn mới).
#[tauri::command]
async fn restart_backend(app: tauri::AppHandle) -> Result<String, String> {
    spawn_backend(&app)
}

pub fn run() {
    // WHY: Dùng find_project_root() chung (giống restart_backend/watchdog) — tránh
    // duplicate logic dẫn đến lệch nhau giữa các nơi tìm project root.
    let project_root = find_project_root();

    // WHY: Lấy đường dẫn exe hiện tại để truyền cho Flask backend,
    // phục vụ tính năng khởi động cùng Windows (tạo shortcut trực tiếp tới exe)
    let exe_path = std::env::current_exe().unwrap_or_default();
    let exe_path_str = exe_path.to_string_lossy().to_string();

    // WHY: Chỉ dọn + spawn backend mới khi backend hiện tại KHÔNG khỏe mạnh.
    // - Port 5050 trống (bình thường): kill orphan là no-op, spawn mới. ✓
    // - Backend mồ côi treo/deadlock giữ port (bug cũ): không phản hồi → kill + spawn mới. ✓
    // - User mở app lần 2 khi instance 1 đang chạy: backend khỏe → KHÔNG kill,
    //   không spawn (single-instance plugin sẽ focus cửa sổ cũ và thoát instance 2). ✓
    let backend_healthy = is_backend_healthy();
    let flask = if !backend_healthy {
        // WHY: Chỉ dọn orphan khi backend chưa khỏe — backend khỏe nghĩa là có instance
        // khác đang chạy (single-instance) hoặc backend mồ côi vẫn sống khỏe → giữ nguyên.
        kill_orphan_backend();

        // WHY: Ưu tiên backend.exe NHÚNG (portable khép kín) — fallback python dev.
        match build_backend_command(&project_root, &exe_path_str) {
            Some(mut cmd) => cmd.spawn().ok(),
            None => {
                eprintln!("[backend] ERROR: Python not found. Please install Python and add to PATH.");
                None
            }
        }
    } else {
        // WHY: Backend hiện tại đang khỏe — KHÔNG spawn mới (tái sử dụng).
        println!("[backend] Reusing existing healthy backend on :5050");
        None
    };

    if flask.is_some() {
        println!("[backend] Flask started from {}", project_root.display());
    } else if backend_healthy {
        println!("[backend] Using existing healthy backend on :5050 (no new spawn)");
    } else {
        eprintln!("[backend] ERROR: Could not start Flask. Python not found or backend/app.py missing at {}", project_root.display());
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Focus the existing window when a second instance is launched
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_positioner::init())
        .manage(FlaskProcess(Mutex::new(flask)))
        .invoke_handler(tauri::generate_handler![get_backend_url, update_tray_status, quit_app, check_backend_health, restart_backend, set_backend_watchdog])
        .setup(|app| {
            // WHY: Bắt đầu phiên log SẠCH — đổi tên debug.log phiên trước thành
            // debug.log.old (tab Nhật ký chỉ đọc debug.log nên hiện log mới từ đầu).
            // Xóa/rename ở ĐÂY (Rust setup, 1 lần khi user mở exe) thay vì ở backend
            // attempt 1: watchdog restart backend giữa phiên cũng là "attempt 1" → nếu
            // xóa ở backend sẽ mất trace crash ngay khi đang debug. Rename (không xóa
            // hẳn) giữ log cũ trong .old để đối chiếu khi cần. debug_log() mở file theo
            // mode 'a' rồi đóng mỗi lần ghi nên không giữ handle → rename an toàn kể cả
            // khi backend cũ còn chạy.
            if let Some(appdata) = std::env::var_os("APPDATA") {
                let log_dir = std::path::Path::new(&appdata).join("multitool-pro");
                let log_path = log_dir.join("debug.log");
                // WHY: Header phiên mới — ghi SAU khi rename thành công (hoặc khi log chưa
                // tồn tại, tức phiên đầu tiên) để header luôn là DÒNG ĐẦU của debug.log mới.
                // Gồm: thời điểm phiên bắt đầu + version exe + note log cũ ở đâu. Chỉ ghi khi
                // thực sự bắt đầu phiên mới (rename OK) — nếu rename fail, KHÔNG chèn header
                // vào giữa log cũ đang còn. Backend restart giữa phiên (watchdog) KHÔNG tạo
                // header mới vì không rename → kỹ thuật viên phân biệt được phiên app vs lần
                // restart backend qua dòng "[app] started (attempt N)" của backend.
                // WHY: Tên backup log phiên trước (có thể đổi nếu rename .old fail) —
                // ghi chính xác tên thật vào header để kỹ thuật viên tìm đúng file.
                let mut backup_name = "debug.log.old".to_string();
                let mut fresh_session = false;
                if log_path.exists() {
                    let old_path = log_dir.join("debug.log.old");
                    // WHY: Nếu remove .old fail (vd antivirus giữ file) → rename sau đó
                    // cũng fail (Windows rename không ghi đè destination). Dùng tên có
                    // timestamp làm fallback để vẫn giữ được log cũ thay vì mất hẳn.
                    if old_path.exists() && std::fs::remove_file(&old_path).is_err() {
                        let ts = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|d| d.as_secs())
                            .unwrap_or(0);
                        backup_name = format!("debug.log.{}", ts);
                        let _ = std::fs::rename(&log_path, log_dir.join(&backup_name));
                        fresh_session = true;
                    } else {
                        // WHY: Retry rename 3 lần, mỗi lần cách ~100ms — backend cũ của phiên
                        // trước có thể đang ghi debug.log đúng lúc này (Python open() trên
                        // Windows không có FILE_SHARE_DELETE → rename fail sharing violation).
                        // Window rất hẹp nhưng retry làm cleanup chắc chắn hơn.
                        let mut renamed = false;
                        for _ in 0..3 {
                            if std::fs::rename(&log_path, &old_path).is_ok() {
                                renamed = true;
                                break;
                            }
                            std::thread::sleep(std::time::Duration::from_millis(100));
                        }
                        if renamed {
                            fresh_session = true;
                        } else if log_path.exists() {
                            // WHY: Rename fail cả 3 lần (sharing violation kéo dài) → xóa
                            // log cũ để vẫn bắt đầu phiên mới sạch, và coi là fresh session
                            // để header được ghi (nhất quán với các branch khác).
                            if std::fs::remove_file(&log_path).is_ok() {
                                fresh_session = true;
                            }
                        }
                    }
                } else {
                    // Log chưa từng tồn tại — phiên đầu tiên, vẫn ghi header.
                    fresh_session = true;
                }
                if fresh_session {
                    let ts = now_log_timestamp();
                    // WHY: Version lấy từ app.package_info() (đọc tauri.conf.json) — single
                    // source of truth. KHÔNG hardcode const để tránh lệch với Cargo.toml
                    // (đang 1.10.0 trong khi tauri.conf.json 1.11.3 — vấn đề có sẵn).
                    let ver = app.package_info().version.to_string();
                    let header = format!(
                        "[{}] [app] ════════ PHIÊN MỚI BẮT ĐẦU — MultiTool Pro v{} ════════\n\
                         [{}] [app] Log phiên trước lưu tại {} (cùng thư mục %APPDATA%/multitool-pro)\n",
                        ts, ver, ts, backup_name
                    );
                    // WHY: append (không ghi đè) — nếu phiên đầu, file vừa tạo; nếu rename
                    // thành công, debug.log là file trống mới. Header là dòng đầu tiên.
                    if let Ok(mut f) = std::fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(&log_path)
                    {
                        use std::io::Write;
                        let _ = f.write_all(header.as_bytes());
                    }
                }
            }
            // WHY: Start watchdog backend ngay sau khi app khởi tạo xong — thread nền
            // kiểm tra /api/preload mỗi 5s, tự restart backend nếu chết/treo 3 lần liên
            // tiếp (~15s). Giúp app tự phục hồi thay vì chỉ hiển thị nút "Khởi động lại".
            start_backend_watchdog(app.handle().clone());
            let _tray_window = tauri::WebviewWindowBuilder::new(
                app,
                "tray_menu",
                tauri::WebviewUrl::App("tray.html".into()),
            )
            .title("MultiTool Pro Menu")
            .inner_size(320.0, 490.0)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .resizable(false)
            .skip_taskbar(true)
            .visible(false)
            .build()?;

            let mut tray_builder = TrayIconBuilder::with_id("main_tray");
            if let Some(icon) = app.default_window_icon().cloned() {
                tray_builder = tray_builder.icon(icon);
            }

            tray_builder
                .tooltip("MultiTool Pro - Hệ thống Quản trị Nội bộ")
                .on_tray_icon_event(|tray, event| {
                    tauri_plugin_positioner::on_tray_event(tray.app_handle(), &event);
                    if let TrayIconEvent::Click {
                        button: MouseButton::Right | MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        if let Some(window) = tray.app_handle().get_webview_window("tray_menu") {
                            use tauri_plugin_positioner::{Position, WindowExt};
                            let _ = window.move_window(Position::TrayCenter);
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.hide();
                            } else {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    // WHY: Chỉ main window hide xuống tray. Widget window (audio-widget) đóng thật.
                    if window.label() == "main" {
                        let _ = window.hide();
                        api.prevent_close();
                    }
                }
                tauri::WindowEvent::Focused(false) => {
                    // WHY: Tự động ẩn cửa sổ tray_menu khi mất focus (click bên ngoài).
                    if window.label() == "tray_menu" {
                        let _ = window.hide();
                    }
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
