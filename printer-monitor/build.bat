@echo off
REM ===========================================
REM Build PrinterMonitor C# module
REM ===========================================
echo Building PrinterMonitor C# module...

REM Check if dotnet SDK is available
where dotnet >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [WARNING] dotnet SDK not found!
    echo [INFO] Using PowerShell fallback instead (PrinterMonitor.ps1)
    echo [INFO] To compile C# version, install .NET SDK from:
    echo [INFO]   https://dotnet.microsoft.com/download
    exit /b 1
)

cd /d "%~dp0"

dotnet restore
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] dotnet restore failed
    exit /b 1
)

dotnet publish -c Release
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] dotnet publish failed
    exit /b 1
)

echo [SUCCESS] Built! Output:
dir /b "bin\Release\net8.0\win-x64\publish\PrinterMonitor.exe" 2>nul

echo.
echo [INFO] PrinterMonitor.exe is ready to use!
echo [INFO] Run: PrinterMonitor.exe query "Printer Name"
