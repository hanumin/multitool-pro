use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::{
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};

#[allow(dead_code)]
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

#[allow(dead_code)]
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
        .env("MULTITOOL_PRO_EXE", &exe_path_str)
        .spawn()
        .ok();

    if flask.is_some() {
        println!("[backend] Flask started from {}", project_root.display());
    } else {
        eprintln!("[backend] WARNING: Could not start Flask. Make sure pythonw is on PATH and backend/app.py exists at {}", project_root.display());
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
        .invoke_handler(tauri::generate_handler![get_backend_url, update_tray_status])
        .setup(|app| {
            let _tray_window = tauri::WebviewWindowBuilder::new(
                app,
                "tray_menu",
                tauri::WebviewUrl::App("tray.html".into()),
            )
            .title("MultiTool Pro Menu")
            .inner_size(300.0, 420.0)
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
