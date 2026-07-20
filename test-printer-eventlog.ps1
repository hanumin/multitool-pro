<#
.SYNOPSIS
    Kiểm tra PrintService EventLog (Event ID 307) trên máy này
    để xác định Properties index chính xác cho TotalPages.

    Chạy: powershell -ExecutionPolicy Bypass -File test-printer-eventlog.ps1
#>

Write-Host "============================================"
Write-Host "PrintService EventLog Event ID 307 Checker"
Write-Host "============================================"
Write-Host ""

# Step 1: Check log status
Write-Host "[1] Checking PrintService/Operational log status..."
try {
    $log = Get-WinEvent -ListLog "Microsoft-Windows-PrintService/Operational" -ErrorAction Stop
    Write-Host "  LogName:     $($log.LogName)"
    Write-Host "  IsEnabled:   $($log.IsEnabled)"
    Write-Host "  RecordCount: $($log.RecordCount)"
    Write-Host "  LogMode:     $($log.LogMode)"
    
    if (-not $log.IsEnabled) {
        Write-Host ""
        Write-Host "  [!] Log is DISABLED! Page count will return 0."
        Write-Host "  [!] Need admin rights to enable:"
        Write-Host "      wevtutil.exe set-log 'Microsoft-Windows-PrintService/Operational' /enabled:true"
        Write-Host ""
        Write-Host "  [*] Trying past events anyway (some may exist from before disable)..."
    }
}
catch {
    Write-Host "  [ERROR] Cannot access PrintService/Operational log: $_"
    Write-Host "  Log may not exist on this system."
    exit 1
}

Write-Host ""

# Step 2: Try to get any Event ID 307
Write-Host "[2] Searching for Event ID 307 events..."
try {
    $events = Get-WinEvent -FilterHashtable @{
        LogName = "Microsoft-Windows-PrintService/Operational"
        ID = 307
    } -MaxEvents 5 -ErrorAction Stop
    
    Write-Host "  Found $($events.Count) event(s):"
    
    $index = 0
    foreach ($evt in $events) {
        Write-Host ""
        Write-Host "  --- Event #$index ---"
        Write-Host "  TimeCreated: $($evt.TimeCreated)"
        Write-Host "  Message (first 200 chars):"
        Write-Host "  $($evt.Message.Substring(0, [Math]::Min(200, $evt.Message.Length)))"
        Write-Host ""
        
        # Inspect all Properties
        Write-Host "  Properties array ($($evt.Properties.Count) items):"
        for ($i = 0; $i - [Math]::Min(12, $evt.Properties.Count); $i++) {
            $val = $evt.Properties[$i].Value
            Write-Host "    Properties[$i] = '$val' (type: $($val.GetType().Name))"
        }
        
        $index++
    }
    
    if ($events.Count -eq 0) {
        Write-Host "  No Event ID 307 found."
    }
}
catch {
    Write-Host "  [ERROR] Cannot query events: $_"
    Write-Host ""
    
    # Check other print-related logs
    Write-Host "  Available print-related logs:"
    Get-WinEvent -ListLog "*Print*" -ErrorAction SilentlyContinue | ForEach-Object {
        Write-Host "    $($_.LogName) (Enabled=$($_.IsEnabled), Count=$($_.RecordCount))"
    }
}

Write-Host ""
Write-Host "============================================"
Write-Host "Done."
Write-Host ""
Write-Host "Summary:"
Write-Host "  If Properties[7] is a number > 0 -> that's TotalPages (Windows 10/11)"
Write-Host "  If Properties[5] is a number > 0 -> that's TotalPages (older Windows)"
Write-Host "  If both are 0 or null -> query failed or log has no data"
