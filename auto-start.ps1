# auto-start.ps1 - Server Dashboard Launcher
# Script này được gọi từ shortcut trong Startup folder để khởi động ứng dụng cùng Windows.

$scriptPath = Split-Path -Parent $MyInvocation.MyCommand.Definition

# Danh sách các đường dẫn có thể chứa Server Dashboard.exe
$possiblePaths = @(
    # Production install (MSI): script ở Resources/, exe ở thư mục cha
    Join-Path (Resolve-Path "$scriptPath\..") "Server Dashboard.exe"
    # Dev mode: exe trong target/release
    Join-Path $scriptPath "src-tauri\target\release\Server Dashboard.exe"
    Join-Path $scriptPath "src-tauri\target\debug\Server Dashboard.exe"
    # Fallback: script và exe cùng thư mục
    Join-Path $scriptPath "Server Dashboard.exe"
)

$exePath = $null
foreach ($path in $possiblePaths) {
    if (Test-Path $path -PathType Leaf) {
        $exePath = $path
        break
    }
}

if ($exePath) {
    Start-Process -FilePath $exePath -WindowStyle Normal
} else {
    Write-Error "Server Dashboard executable not found. Checked paths:"
    foreach ($path in $possiblePaths) {
        Write-Error "  - $path"
    }
    Start-Sleep -Seconds 10
}
