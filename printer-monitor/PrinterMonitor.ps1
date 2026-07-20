<#
.SYNOPSIS
    PrinterMonitor.ps1 — PowerShell Printer Page Count Monitor
    Works immediately without compilation (PowerShell 5.0+)
    Used as fallback when C# exe is not compiled.

.DESCRIPTION
    Queries Windows PrintService EventLog (Event ID 307) for page counts.
    Supports:
      - query <PrinterName>  : Get total pages printed (30 days)
      - listen <Name> <Secs> : Listen for real-time print jobs
      - stats                : Show all printers stats
      - install              : Enable PrintService log

.EXAMPLE
    .\PrinterMonitor.ps1 query "EPSON L3210 Series"
    .\PrinterMonitor.ps1 listen "EPSON L3210 Series" 60
    .\PrinterMonitor.ps1 stats
#>

param(
    [string]$Command = "query",
    [string]$PrinterName = "",
    [int]$Duration = 30
)

$LogName = "Microsoft-Windows-PrintService/Operational"
$EventId = 307

# ─── Helper: Extract TotalPages from Event ID 307 ──────────
function Get-TotalPages($message) {
    $patterns = @(
        'Pages printed: (\d+)',
        'Total pages: (\d+)',
        '(\d+)\s+pages?',
        'TotalPages: (\d+)'
    )
    foreach ($pattern in $patterns) {
        $m = [regex]::Match($message, $pattern)
        if ($m.Success) {
            return [int]$m.Groups[1].Value
        }
    }
    return 0
}

# ─── Helper: Extract printer name ─────────────────────────
function Get-PrinterName($message) {
    # Try different patterns in the event message
    $patterns = @(
        'Printer:\s*(.+?)[\r\n]',
        ' on (.+?)[\r\n]',
        '(.+?)\s+was printing'
    )
    foreach ($pattern in $patterns) {
        $m = [regex]::Match($message, $pattern)
        if ($m.Success) {
            return $m.Groups[1].Value.Trim()
        }
    }
    return ""
}

# ─── Query page count ─────────────────────────────────────
function Query-PageCount {
    param([string]$printerFilter = "")

    try {
        $events = Get-WinEvent -FilterHashtable @{
            LogName   = $LogName
            ID        = $EventId
            StartTime = (Get-Date).AddDays(-30)
        } -ErrorAction SilentlyContinue

        $totalPages = 0
        $eventCount = 0

        foreach ($evt in $events) {
            $msg = $evt.Message

            if ($printerFilter -and $msg -notlike "*$printerFilter*") {
                continue
            }

            $pages = Get-TotalPages $msg
            if ($pages -gt 0) {
                $totalPages += $pages
                $eventCount++
            }
        }

        $result = @{
            page_count   = if ($totalPages -gt 0) { $totalPages } else { $null }
            source       = if ($totalPages -gt 0) { "eventlog_ps" } else { "no_data" }
            printer      = if ($printerFilter) { $printerFilter } else { "all" }
            events_found = $eventCount
            days_queried = 30
        }

        return $result
    }
    catch {
        return @{ error = $_.Exception.Message; source = "error" }
    }
}

# ─── Listen for real-time print jobs ──────────────────────
function Listen-PrintJobs {
    param([string]$printerFilter = "", [int]$seconds = 30)

    $endTime = (Get-Date).AddSeconds($seconds)
    $jobsDetected = @()
    $jobCount = 0

    Write-Error "Listening for print jobs on '$printerFilter' ($seconds seconds)..."

    # Query starting point - get the last event time
    $lastEvent = Get-WinEvent -FilterHashtable @{
        LogName = $LogName; ID = $EventId
    } -MaxEvents 1 -ErrorAction SilentlyContinue
    $lastTime = if ($lastEvent) { $lastEvent.TimeCreated } else { (Get-Date).AddMinutes(-1) }

    while ((Get-Date) -lt $endTime) {
        $newEvents = Get-WinEvent -FilterHashtable @{
            LogName = $LogName; ID = $EventId
            StartTime = $lastTime
        } -ErrorAction SilentlyContinue

        foreach ($evt in $newEvents) {
            if ($evt.TimeCreated -le $lastTime) { continue }
            $msg = $evt.Message

            if ($printerFilter -and $msg -notlike "*$printerFilter*") { continue }

            $pages = Get-TotalPages $msg
            $printer = Get-PrinterName $msg

            $job = @{
                type      = "print_job"
                timestamp = $evt.TimeCreated.ToString("yyyy-MM-dd HH:mm:ss")
                printer   = $printer
                document  = "Event ID 307"
                pages     = $pages
            }

            # Output as JSON line for Python to parse
            $job | ConvertTo-Json -Compress

            $jobsDetected += $job
            $jobCount++
        }

        if ($newEvents.Count -gt 0) {
            $lastTime = $newEvents[0].TimeCreated
        }
        Start-Sleep -Seconds 2
    }

    $summary = @{
        type             = "summary"
        total_jobs       = $jobsDetected.Count
        total_pages      = ($jobsDetected | Measure-Object -Property pages -Sum).Sum
        duration_seconds = $seconds
    }
    Write-Error ($summary | ConvertTo-Json -Compress)

    return $jobsDetected
}

# ─── Stats for all printers ───────────────────────────────
function Get-AllStats {
    $events = Get-WinEvent -FilterHashtable @{
        LogName = $LogName; ID = $EventId
        StartTime = (Get-Date).AddDays(-30)
    } -ErrorAction SilentlyContinue

    $printerStats = @{}

    foreach ($evt in $events) {
        $msg = $evt.Message
        $printer = Get-PrinterName $msg
        if ([string]::IsNullOrEmpty($printer)) { continue }

        $pages = Get-TotalPages $msg
        if (-not $printerStats.ContainsKey($printer)) {
            $printerStats[$printer] = 0
        }
        $printerStats[$printer] += $pages
    }

    $result = @{
        printers       = ($printerStats.GetEnumerator() | ForEach-Object { @{ printer = $_.Key; pages_30days = $_.Value } })
        total_printers = $printerStats.Count
        days_queried   = 30
    }
    return $result
}

# ─── Enable PrintService log ──────────────────────────────
function Enable-PrintServiceLog {
    try {
        # Check if already enabled
        $currentLog = Get-WinEvent -ListLog $LogName -ErrorAction SilentlyContinue
        if ($currentLog -and $currentLog.IsEnabled) {
            return @{ status = "already_enabled"; note = "PrintService Operational log is already enabled." }
        }
        
        # Check admin rights
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = New-Object Security.Principal.WindowsPrincipal $identity
        $isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
        
        if (-not $isAdmin) {
            return @{ status = "error"; error = "Need Administrator privileges. Run PowerShell as Administrator then try again." }
        }
        
        $result = wevtutil.exe set-log "$LogName" /enabled:true /quiet 2>&1
        $exitCode = $LASTEXITCODE
        
        if ($exitCode -eq 0) {
            return @{ status = "installed"; note = "PrintService Operational log enabled." }
        } else {
            return @{ status = "error"; error = "wevtutil failed (exit $exitCode): $result" }
        }
    }
    catch {
        return @{ status = "error"; error = $_.Exception.Message }
    }
}

# ══════════ MAIN ══════════
try {
    switch ($Command.ToLower()) {
        "query" {
            $result = Query-PageCount -printerFilter $PrinterName
            $result | ConvertTo-Json -Compress
        }
        "listen" {
            Listen-PrintJobs -printerFilter $PrinterName -seconds $Duration
        }
        "stats" {
            $result = Get-AllStats
            $result | ConvertTo-Json -Compress
        }
        "install" {
            $result = Enable-PrintServiceLog
            $result | ConvertTo-Json -Compress
        }
        default {
            Write-Error "Unknown command: $Command"
            Write-Error "Usage: query | listen | stats | install"
        }
    }
}
catch {
    $err = @{ error = $_.Exception.Message }
    $err | ConvertTo-Json -Compress
}
