use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};

struct FlaskProcess(Mutex<Option<Child>>);

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

fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn run() {
    // Tìm thư mục gốc của project (nơi chứa backend/app.py).
    // Bắt đầu từ vị trí của exe, đi ngược cha cho đến khi thấy backend/app.py.
    // Khi cài MSI, Tauri bundle resources vào thư mục Resources/,
    // nên kiểm tra cả Resources/backend/app.py
    let has_backend = |d: &std::path::Path| -> bool {
        d.join("backend").join("app.py").is_file()
            || d.join("Resources").join("backend").join("app.py").is_file()
    };

    let project_root = std::env::current_exe()
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
        });

    // WHY: Lấy đường dẫn exe hiện tại để truyền cho Flask backend,
    // phục vụ tính năng khởi động cùng Windows (tạo shortcut trực tiếp tới exe)
    let exe_path = std::env::current_exe().unwrap_or_default();
    let exe_path_str = exe_path.to_string_lossy().to_string();

    let flask = Command::new("pythonw")
        .args(["backend/app.py", "5050"])
        .current_dir(&project_root)
        .env("SERVER_DASHBOARD_EXE", &exe_path_str)
        .spawn()
        .ok();

    if flask.is_some() {
        println!("[backend] Flask started from {}", project_root.display());
    } else {
        eprintln!("[backend] WARNING: Could not start Flask. Make sure pythonw is on PATH and backend/app.py exists at {}", project_root.display());
    }

    // --- SINGLE INSTANCE LOCK ---
    // WHY: Prevent multiple instances of the app. Khi user mở exe lần 2,
    // thay vì tạo instance mới + icon tray thứ 2, plugin này sẽ:
    //   1. Dùng Windows named mutex để phát hiện instance đã tồn tại
    //   2. Gửi WM_COPYDATA message đến instance cũ
    //   3. Instance cũ focus cửa sổ lên
    //   4. Instance mới tự động thoát (std::process::exit(0))
    //
    // Phải đặt plugin này TRƯỚC tất cả các plugin khác để nó intercept
    // instance thứ 2 trước khi chúng kịp khởi tạo.
    // --- CẬP NHẬT TỰ ĐỘNG (Auto Update) ---
    // Đăng ký plugin updater. Khi người dùng nhấn "Check updates" ở frontend,
    // nó sẽ gọi API của Tauri Updater, plugin này sẽ:
    //   1. Kiểm tra file latest.json trên GitHub Releases
    //   2. So sánh version với app hiện tại
    //   3. Nếu có bản mới, tải về .msi/.exe + xác thực chữ ký .sig
    //   4. Tự động cài đặt và khởi động lại app
    //
    // Yêu cầu deploy:
    //   - File latest.json phải được upload kèm mỗi release lên GitHub
    //   - latest.json chứa version, URL download, và chữ ký của file cài đặt
    //   - Public key trong tauri.conf.json phải khớp với private key đã sign
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
        .manage(FlaskProcess(Mutex::new(flask)))
        .invoke_handler(tauri::generate_handler![get_backend_url, update_tray_status])
        .setup(|app| {
            let open = MenuItemBuilder::with_id("open", "Open Dashboard").build(app)?;
            let start_all = MenuItemBuilder::with_id("start_all", "Start All").build(app)?;
            let stop_all = MenuItemBuilder::with_id("stop_all", "Stop All").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;

            let menu = MenuBuilder::new(app)
                .item(&open)
                .separator()
                .item(&start_all)
                .item(&stop_all)
                .separator()
                .item(&quit)
                .build()?;

            let mut tray_builder = TrayIconBuilder::with_id("main_tray");
            if let Some(icon) = app.default_window_icon().cloned() {
                tray_builder = tray_builder.icon(icon);
            }

            tray_builder
                .tooltip("Server Dashboard")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_window(app),
                    "start_all" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.eval("window.__startAll?.()");
                        }
                    }
                    "stop_all" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.eval("window.__stopAll?.()");
                        }
                    }
                    "quit" => {
                        // Kill flask before exiting
                        if let Some(state) = app.try_state::<FlaskProcess>() {
                            if let Ok(mut guard) = state.0.lock() {
                                if let Some(ref mut child) = *guard {
                                    let _ = child.kill();
                                    let _ = child.wait();
                                }
                            }
                        }
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_window(tray.app_handle());
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Hide to tray instead of closing
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
