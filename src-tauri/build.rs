fn main() {
    // WHY: lib.rs dùng include_bytes!("../backend-embed/backend.exe") để nhúng backend
    // Python (PyInstaller onefile) vào thẳng binary Tauri → portable exe khép kín 1 file.
    // include_bytes! yêu cầu file TỒN TẠI lúc compile → build.rs này đảm bảo file luôn có:
    // - Bản thật: build-portable.ps1 chạy PyInstaller rồi copy backend.exe vào đây
    //   TRƯỚC khi gọi tauri build → lib.rs nhúng backend thật.
    // - Dev build (tauri dev / cargo build): chưa có file thật → tạo placeholder RỖNG →
    //   lib.rs phát hiện kích thước quá nhỏ → fallback spawn python backend/app.py như cũ.
    let embed_dir = std::path::Path::new("backend-embed");
    std::fs::create_dir_all(embed_dir).expect("failed to create backend-embed dir");
    let exe_path = embed_dir.join("backend.exe");
    if !exe_path.exists() {
        std::fs::write(&exe_path, b"").expect("failed to create placeholder backend-embed/backend.exe");
        // WHY: CẢNH BÁO LỚN khi tạo placeholder rỗng — nếu build RELEASE mà chưa chạy
        // PyInstaller (vd dùng plain `npx tauri build` thay vì build-portable.ps1), exe
        // cuối sẽ nhúng backend RỖNG → trên máy end-user (không có Python) app không
        // chạy được backend. Cảnh báo này xuất hiện trong output cargo build để dev
        // biết ngay (placeholder vẫn cho phép build để dev/test UI trên máy có Python).
        println!("cargo:warning=⚠️  backend-embed/backend.exe KHÔNG tồn tại — đã tạo placeholder RỖNG. Bản release sẽ KHÔNG có backend nhúng! Chạy build-portable.ps1 (PyInstaller) trước khi build release.");
    }
    // WHY: Rebuild Rust khi backend.exe thay đổi — nếu bỏ dòng này, cargo cache cũ sẽ
    // không nhúng bản backend.exe mới sau lần build đầu (include_bytes không tự track).
    println!("cargo:rerun-if-changed=backend-embed/backend.exe");

    tauri_build::build()
}
