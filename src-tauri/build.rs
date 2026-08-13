fn main() {
    // WHY: lib.rs dùng include_bytes! để nhúng backend Python (PyInstaller onefile) vào
    // thẳng binary Tauri → portable khép kín 1 file. Tên file nhúng khác nhau theo OS:
    // - Windows: backend.exe (PyInstaller --onefile ra .exe, nhận diện bằng magic "MZ")
    // - macOS/Linux: backend (không đuôi, magic Mach-O 0xCFFAEDFE / ELF 0x7F454C46)
    // include_bytes! yêu cầu file TỒN TẠI lúc compile → build.rs này đảm bảo file luôn có:
    // - Bản thật: build script (build-portable.ps1 trên Windows / workflow CI trên Mac)
    //   chạy PyInstaller rồi copy backend vào đây TRƯỚC khi gọi tauri build.
    // - Dev build: chưa có file thật → tạo placeholder RỖNG → lib.rs phát hiện kích
    //   thước quá nhỏ → fallback spawn python backend/app.py như cũ.
    let embed_dir = std::path::Path::new("backend-embed");
    std::fs::create_dir_all(embed_dir).expect("failed to create backend-embed dir");
    #[cfg(target_os = "windows")]
    let exe_path = embed_dir.join("backend.exe");
    #[cfg(not(target_os = "windows"))]
    let exe_path = embed_dir.join("backend");
    if !exe_path.exists() {
        std::fs::write(&exe_path, b"").expect("failed to create placeholder backend-embed/backend");
        // WHY: CẢNH BÁO LỚN khi tạo placeholder rỗng — nếu build RELEASE mà chưa chạy
        // PyInstaller (vd dùng plain `npx tauri build` thay vì build script/CI), binary
        // cuối sẽ nhúng backend RỖNG → trên máy end-user (không có Python) app không
        // chạy được backend. Cảnh báo này xuất hiện trong output cargo build để dev biết.
        println!("cargo:warning=⚠️  backend-embed/backend KHÔNG tồn tại — đã tạo placeholder RỖNG. Bản release sẽ KHÔNG có backend nhúng! Chạy build script (PyInstaller) trước khi build release.");
    }
    // WHY: Rebuild Rust khi file backend thay đổi — nếu bỏ dòng này, cargo cache cũ sẽ
    // không nhúng bản backend mới sau lần build đầu (include_bytes không tự track).
    println!("cargo:rerun-if-changed=backend-embed/backend.exe");
    println!("cargo:rerun-if-changed=backend-embed/backend");

    tauri_build::build()
}
