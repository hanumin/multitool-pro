@echo off
cd /d "C:\Users\Nguyen Thanh Dat\Desktop\Multi-App\Server-Dashboard"
echo ==========================================
echo    MultiTool Pro - Restart Backend
echo ==========================================
echo.

echo [*] Killing old Python processes on port 5050...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :5050') do (
    if not "%%a"=="" taskkill /F /PID %%a >nul 2>&1
)
timeout /t 1 /nobreak >nul

echo [*] Starting backend Python...
start "MultiTool Pro Backend" python backend/app.py
timeout /t 3 /nobreak >nul

echo [*] Backend started! Testing API...
curl -s http://127.0.0.1:5050/api/projects 2>&1
echo.
echo.
echo ==========================================
echo    Backend dang chay!
echo    Mo http://localhost:1420 de dung app
echo ==========================================
pause
