<#
.SYNOPSIS
    Bật PrintService log + in thử 1 trang + inspect Properties index
    Chạy file này với PowerShell Administrator

.CÁCH CHẠY:
    1. Right-click Windows Start > Windows Terminal (Admin)
    2. cd đến thư mục này
    3. .\test-properties.ps1
#>

Write-Host "╔══════════════════════════════════════════════════╗"
Write-Host "║   PrintService EventLog Properties Inspector    ║"
Write-Host "╚══════════════════════════════════════════════════╝"
Write-Host ""

# Step 0: Check admin
Write-Host "[0] Checking admin rights..."
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal $identity
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Host "  ❌ NOT running as Administrator!"
    Write-Host "  Please run: Right-click > Run as Administrator"
    exit 1
}
Write-Host "  ✅ Running as Administrator"
Write-Host ""

# Step 1: Enable log
Write-Host "[1] Enabling PrintService/Operational log..."
wevtutil.exe set-log "Microsoft-Windows-PrintService/Operational" /enabled:true /quiet
if ($LASTEXITCODE -eq 0) {
    Write-Host "  ✅ Log enabled!"
} else {
    Write-Host "  ❌ Failed to enable log (exit code: $LASTEXITCODE)"
    exit 1
}

# Verify
$logCheck = Get-WinEvent -ListLog "Microsoft-Windows-PrintService/Operational"
Write-Host "  Log status: IsEnabled=$($logCheck.IsEnabled), RecordCount=$($logCheck.RecordCount)"
Write-Host ""

# Step 2: Check available printers
Write-Host "[2] Available printers..."
$printers = Get-Printer -ErrorAction SilentlyContinue | Select-Object Name, DriverName, PortName
if ($printers) {
    $printers | ForEach-Object { Write-Host "  - $($_.Name) (Driver: $($_.DriverName))" }
} else {
    Write-Host "  No printers found via Get-Printer"
    Write-Host "  Trying win32print..."
    try {
        Add-Type -AssemblyName System.Drawing.Printing
        $printers = [System.Drawing.Printing.PrinterSettings]::InstalledPrinters
        foreach ($p in $printers) { Write-Host "  - $p" }
    } catch {
        Write-Host "  Cannot enumerate printers"
    }
}
Write-Host ""

# Step 3: Print a test page
Write-Host "[3] Printing a test page to default printer..."
try {
    $defaultPrinter = (Get-WmiObject -Class Win32_Printer | Where-Object { $_.Default -eq $true }).Name
    if (-not $defaultPrinter) {
        $defaultPrinter = (Get-WmiObject -Class Win32_Printer | Select-Object -First 1).Name
    }
    Write-Host "  Default printer: $defaultPrinter"
    
    # Print a simple test page using notepad or direct RAW
    $testFile = "$env:TEMP\printer-test-page.txt"
    "MultiTool Pro - Test Page" | Out-File -FilePath $testFile -Encoding UTF8
    
    Write-Host "  Sending test page to $defaultPrinter..."
    Start-Process -FilePath "notepad.exe" -ArgumentList "/P `"$testFile`"" -Wait
    
    Write-Host "  ✅ Test page sent! Wait a few seconds..."
    Start-Sleep -Seconds 5
}
catch {
    Write-Host "  ⚠️ Could not print automatically: $_"
    Write-Host "  Please manually print a test page (Any document > File > Print)"
    Read-Host "  Press Enter after you have printed"
}
Write-Host ""

# Step 4: Inspect EventLog
Write-Host "[4] Inspecting Event ID 307 events..."
try {
    $events = Get-WinEvent -FilterHashtable @{
        LogName = "Microsoft-Windows-PrintService/Operational"
        ID = 307
    } -MaxEvents 3 -ErrorAction Stop
    
    $count = $events.Count
    Write-Host "  Found $count Event ID 307 event(s)!"
    
    $i = 0
    foreach ($evt in $events) {
        Write-Host ""
        Write-Host "  ═══════════ Event #$i ═══════════"
        Write-Host "  Time: $($evt.TimeCreated)"
        Write-Host ""
        
        # Inspect Properties
        Write-Host "  ─── Properties array ($($evt.Properties.Count) items) ───"
        for ($j = 0; $j -lt $evt.Properties.Count; $j++) {
            $val = $evt.Properties[$j].Value
            $typeName = $val.GetType().Name
            $displayVal = if ($val -is [string]) { "'$val'" } else { $val }
            Write-Host "    Properties[$j] = $displayVal (type: $typeName)"
        }
        
        Write-Host ""
        Write-Host "  ─── Full Message (first 300 chars) ───"
        Write-Host "  $($evt.Message.Substring(0, [Math]::Min(300, $evt.Message.Length)))"
        
        $i++
    }
}
catch {
    Write-Host "  ⚠️ No Event ID 307 found yet: $_"
    Write-Host "  The log may need more time or the print job didn't use standard driver."
    Write-Host "  Try printing again and re-run this script."
}

Write-Host ""
Write-Host "╔══════════════════════════════════════════════════╗"
Write-Host "║                   RESULTS                       ║"
Write-Host "╚══════════════════════════════════════════════════╝"
Write-Host ""
Write-Host "Look at the Properties array above."
Write-Host ""
Write-Host "Expected schema for Event ID 307 (Windows 10/11):"
Write-Host "  Properties[0] = Parameter1 (app name?)"
Write-Host "  Properties[1] = Parameter2"
Write-Host "  Properties[2] = Parameter3"
Write-Host "  Properties[3] = Printer Name (string)"
Write-Host "  Properties[4] = Parameter5"
Write-Host "  Properties[5] = Size in bytes (often 0)"
Write-Host "  Properties[6] = Parameter7"
Write-Host "  Properties[7] = TotalPages ← THIS IS WHAT WE NEED"
Write-Host ""
Write-Host "Check which Properties[i] has the page count value!"
