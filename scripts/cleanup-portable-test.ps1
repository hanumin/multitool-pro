# Cleanup test instances of MultiTool Pro + its backend, verify none remain
Get-Process -Name 'MultiTool*','multitool*','backend*' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2
$left = Get-Process -Name 'MultiTool*','multitool*','backend*' -ErrorAction SilentlyContinue
if ($left) {
    Write-Host "STILL RUNNING: $($left.ProcessName -join ', ')" -ForegroundColor Red
    exit 1
} else {
    Write-Host 'ALL CLEAN' -ForegroundColor Green
}
