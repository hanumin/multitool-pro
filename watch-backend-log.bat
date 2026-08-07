@echo off
title MultiTool Pro - Backend Log (ALL)
cd /d "C:\Users\nguyenthanhdat_pc\Desktop\Multi-App\Server-Dashboard"

echo ============================================
echo  MultiTool Pro - Log Thoi Gian Thuc
echo ============================================
echo  - Tat ca API request deu duoc ghi log
echo  - Tat ca debug_log deu duoc hien thi
echo  - Bam Ctrl+C de thoat
echo ============================================
echo.

REM Kill old Python processes on port 5050
echo [*] Dang don dep tien trinh cu...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :5050 ^| findstr LISTENING') do (
    taskkill /F /PID %%a >nul 2>&1
)
timeout /t 1 /nobreak >nul

echo [*] Dang khoi dong backend Python...
echo.
echo ============================================
python backend/app.py
echo.
echo ============================================
echo.
echo [*] Backend da dung. Bam phim bat ky de thoat...
pause
