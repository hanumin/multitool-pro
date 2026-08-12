# build-portable.ps1 - Build Tauri va copy .exe portable vao thu muc /release/portable
# WHY: tauri build luon xuat ra src-tauri/target/release/bundle/ (gitignored, s?u chet).
#      Script nay g?i tauri build roi copy binary portable (raw exe, khong phai installer)
#      vao release/portable/ (cung noi voi installer NSIS/MSI trong release/) de ban tim
#      thay va phan phoi de dang hon.
#
#      BACKEND KHEP KIN: Truoc khi build Tauri, script chay PyInstaller de dong goi
#      backend Python (Flask + moi dependency) thanh 1 file backend.exe, roi copy vao
#      src-tauri/backend-embed/backend.exe de build.rs/include_bytes! nhung TRUC TIEP vao
#      binary Tauri -> portable exe la 1 file DUY NHAT, khong can Python cai san.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Definition

# WHY: Version lay tu tauri.conf.json (nguon chinh thuc cua Tauri), khong dung Cargo.toml
#      vi Cargo.toml co the bi treo nhu truong hop 1.10.0 vs thuc te 1.11.3.
$conf = Get-Content "$root\src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json
$product = $conf.productName
$version = $conf.version
$arch = "x64"

$portableDir = "$root\release\portable"
$outExe = Join-Path $portableDir "$product`_$version`_$arch.exe"
$srcExe = "$root\src-tauri\target\release\$($conf.mainBinaryName).exe"

if (-not $conf.mainBinaryName) { $srcExe = "$root\src-tauri\target\release\multitool-pro.exe" }

Write-Host "=== Build Tauri $product v$version ($arch) ===" -ForegroundColor Cyan

Push-Location $root
try {
    # WHY: Build frontend TRUOC (npm run build) de co dist/ — PyInstaller can --add-data dist
    #      de backend.exe phuc vu duoc SPA (frontend). npx tauri build cung chay lai npm run
    #      build nhung ta can dist/ O DAY cho PyInstaller.
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build that bai (exit $LASTEXITCODE)" }

    # WHY: Dong goi backend Python thanh 1 exe tu chu (PyInstaller --onefile).
    # - --windowed: khong hien console (backend chay ngam nhu pythonw).
    # - --add-data: nhung dist/ (SPA), auto-start.ps1, printer-monitor/ (C# tool + ps1)
    #   vao exe. backend/sounds KHONG ton tai (code da guard .exists()) nen khong can.
    # - --collect-all pycaw/comtypes: pycaw import comtypes dong qua CTYPES nong du lieu
    #   runtime (WinMM) — PyInstaller khong tu phat hien, phai collect tu dong.
    # - --hidden-import psycopg2/mysql.connector/win32print/...: import TRONG ham (lazy)
    #   nen PyInstaller khong scan duoc; khai bao truoc de khong sot.
    $pyOut = "$root\backend\py-dist"
    & python -m PyInstaller --noconfirm --clean --onefile --windowed --name backend `
        --distpath $pyOut --workpath "$root\backend\py-build" `
        --add-data "$root\dist;dist" `
        --add-data "$root\auto-start.ps1;." `
        --add-data "$root\printer-monitor;printer-monitor" `
        --collect-all pycaw --collect-all comtypes `
        --hidden-import psycopg2 --hidden-import mysql.connector `
        --hidden-import win32print --hidden-import win32com.client `
        --hidden-import win32event --hidden-import pythoncom `
        "$root\backend\app.py"
    if ($LASTEXITCODE -ne 0) { throw "PyInstaller that bai (exit $LASTEXITCODE)" }

    # WHY: Copy backend.exe vao src-tauri/backend-embed/ — build.rs/include_bytes! can no
    #      TRUOC khi cargo compile de nhung vao binary Tauri. (build.rs tu tao placeholder
    #      neu thieu nhung O DAY ta copy ban THAT.)
    New-Item -ItemType Directory -Path "$root\src-tauri\backend-embed" -Force | Out-Null
    Copy-Item "$pyOut\backend.exe" "$root\src-tauri\backend-embed\backend.exe" -Force
    Write-Host "[pyinstaller] backend.exe: $('{0:N1}' -f ((Get-Item "$pyOut\backend.exe").Length/1MB)) MB" -ForegroundColor Cyan

    # WHY: npx tauri build chay beforeBuildCommand (npm run build) roi cargo build --release.
    #      --no-bundle chi build raw binary (khong tao installer) = portable exe.
    #      Cargo build se nhung src-tauri/backend-embed/backend.exe vao binary.
    & npx tauri build --no-bundle
    if ($LASTEXITCODE -ne 0) { throw "tauri build that bai (exit $LASTEXITCODE)" }
}
finally {
    Pop-Location
}

if (-not (Test-Path $srcExe)) { throw "Khong tim thay binary: $srcExe" }

New-Item -ItemType Directory -Path $portableDir -Force | Out-Null
Copy-Item $srcExe $outExe -Force

Write-Host ""
Write-Host "=== DONE ===" -ForegroundColor Green
Write-Host "Portable exe: $outExe" -ForegroundColor Green
Write-Host "Kich thuoc:    $('{0:N1}' -f ((Get-Item $outExe).Length/1MB)) MB" -ForegroundColor Green
