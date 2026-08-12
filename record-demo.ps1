# ─── MultiTool Pro — Demo Recording Script ───────────────────────
# Yêu cầu: ffmpeg (https://ffmpeg.org/) có trong PATH
# Cách chạy: powershell -ExecutionPolicy Bypass -File record-demo.ps1

$outputFile = "MultiToolPro_Demo_$(Get-Date -Format 'yyyy-MM-dd_HH-mm').mp4"
$url = "http://localhost:1420"
$duration = 30  # giây

Write-Host "=== MultiTool Pro Animation Demo ===" -ForegroundColor Cyan
Write-Host "Output: $outputFile" -ForegroundColor Yellow
Write-Host "Duration: ${duration}s" -ForegroundColor Yellow
Write-Host ""
Write-Host "Dam bao Chrome da mo o localhost:1420 roi bam phim bat ky de bat dau..." -ForegroundColor Green
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")

Write-Host "Dang quay video..." -ForegroundColor Red

# Quay man hinh bang ffmpeg (lay toan bo man hinh)
$process = Start-Process -NoNewWindow -FilePath "ffmpeg" -ArgumentList @(
    "-f", "gdigrab",
    "-framerate", "30",
    "-offset_x", "0",
    "-offset_y", "0",
    "-video_size", "1920x1080",
    "-i", "desktop",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-crf", "28",
    "-t", $duration.ToString(),
    "-y",
    $outputFile
) -PassThru

# Dem nguoc
for ($i = $duration; $i -gt 0; $i--) {
    Write-Progress -Activity "Recording..." -Status "${i}s remaining" -PercentComplete (($duration - $i) / $duration * 100)
    Start-Sleep -Seconds 1
}

Write-Host "Da luu video tai: $outputFile" -ForegroundColor Green
Write-Progress -Activity "Done" -Completed
