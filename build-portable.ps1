# build-portable.ps1 - Build Tauri va copy .exe portable vao thu muc /portable (root)
# WHY: tauri build luon xuat ra src-tauri/target/release/bundle/ (gitignored, s?u chet).
#      Script nay g?i tauri build roi copy binary portable (raw exe, khong phai installer)
#      vao portable/ o root de ban tim thay va phan phoi de dang hon.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Definition

# WHY: Version lay tu tauri.conf.json (nguon chinh thuc cua Tauri), khong dung Cargo.toml
#      vi Cargo.toml co the bi treo nhu truong hop 1.10.0 vs thuc te 1.11.3.
$conf = Get-Content "$root\src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json
$product = $conf.productName
$version = $conf.version
$arch = "x64"

$portableDir = "$root\portable"
$outExe = Join-Path $portableDir "$product`_$version`_$arch.exe"
$srcExe = "$root\src-tauri\target\release\$($conf.mainBinaryName).exe"

if (-not $conf.mainBinaryName) { $srcExe = "$root\src-tauri\target\release\multitool-pro.exe" }

Write-Host "=== Build Tauri $product v$version ($arch) ===" -ForegroundColor Cyan

Push-Location $root
try {
    # WHY: npx tauri build chay beforeBuildCommand (npm run build) roi cargo build --release.
    #      --no-bundle chi build raw binary (khong tao installer) = portable exe.
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
