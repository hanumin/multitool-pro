using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Diagnostics.Eventing.Reader;

namespace PrinterMonitor
{
    /// <summary>
    /// PrinterMonitor — Windows Printer Page Count Monitor
    /// 
    /// Dùng EventLogReader (System.Diagnostics.Eventing.Reader) để đọc
    /// PrintService Event ID 307 với Properties[7] = TotalPages.
    /// Không phụ thuộc vào locale (message text) như EventLog class.
    /// 
    /// Usage:
    ///   PrinterMonitor.exe query "EPSON L3210 Series"    # Query page count
    ///   PrinterMonitor.exe listen 30                      # Listen N seconds
    ///   PrinterMonitor.exe stats                          # All printers stats
    ///   PrinterMonitor.exe install                        # Enable PrintService log
    /// </summary>
    class Program
    {
        static int Main(string[] args)
        {
            try
            {
                if (args.Length == 0)
                {
                    ShowHelp();
                    return 0;
                }

                return args[0].ToLower() switch
                {
                    "query" => QueryPrintCount(args.Length > 1 ? args[1] : ""),
                    "listen" => ListenForPrintJobs(args.Length > 1 ? int.Parse(args[1]) : 30),
                    "stats" => PrintAllStats(),
                    "install" => EnablePrintServiceLog(),
                    _ => ShowHelp()
                };
            }
            catch (Exception ex)
            {
                var err = new { error = ex.Message.Replace("\"", "'"), type = ex.GetType().Name };
                Console.Error.WriteLine(JsonSerializer.Serialize(err, JsonOptions));
                return 1;
            }
        }

        static int ShowHelp()
        {
            Console.WriteLine(@"
PrinterMonitor — Windows Printer Page Count Monitor (EventLogReader)
Uses System.Diagnostics.Eventing.Reader for reliable Properties[7] access.

Usage:
  PrinterMonitor.exe query ""Printer Name""    Get total pages printed (30 days)
  PrinterMonitor.exe listen 60               Listen for print jobs (seconds)
  PrinterMonitor.exe stats                   Show all printers stats
  PrinterMonitor.exe install                 Enable PrintService Operational log
");
            return 0;
        }

        /// <summary>
        /// Query total pages printed from EventLog Event ID 307 (30 days)
        /// Uses EventLogReader for direct Properties[7] access (no locale dependency)
        /// </summary>
        static int QueryPrintCount(string printerName)
        {
            string logName = "Microsoft-Windows-PrintService/Operational";
            DateTime startTime = DateTime.Now.AddDays(-30);
            int totalPages = 0;
            int eventCount = 0;
            var printerCounts = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);

            try
            {
                // WHY: XPath filter ngay tại EventLog engine — chỉ trả về Event ID 307
                // trong 30 ngày (timediff <= 30*24*3600*1000 ms). Trước đây quét TOÀN BỘ
                // log rồi lọc trong code → với log lớn (máy in hoạt động liên tục như
                // EPSON EP-804A) query chạy > 10s → Python timeout mỗi lần gọi.
                string xpath = "*[System[(EventID=307) and TimeCreated[timediff(@SystemTime) <= 2592000000]]]";
                var query = new EventLogQuery(logName, PathType.LogName, xpath)
                {
                    ReverseDirection = true
                };

                using var reader = new EventLogReader(query);
                EventLogRecord? record;
                int recordsRead = 0;
                while ((record = (EventLogRecord?)reader.ReadEvent()) != null)
                {
                    // WHY: Safety cap — đề phòng log lỗi/clock lệch làm break không kích hoạt.
                    if (++recordsRead > 5000) break;

                    // WHY: Check time TRƯỚC check Event ID. Trước đây check ngược
                    // (Id != 307 continue; rồi mới break theo time) → khi event mới nhất
                    // không phải 307, code đọc tiếp xuống CẢ LOG cũ hơn 30 ngày, chỉ break
                    // khi gặp 1 event 307 cũ hơn 30 ngày → timeout với log lớn.
                    if (record.TimeCreated.HasValue && record.TimeCreated.Value < startTime) break;
                    if (record.Id != 307) continue;

                    var props = record.Properties;

                    // Properties[4] = Printer Name (UnicodeString)
                    string? nameFromProps = props.Count > 4 ? (props[4]?.Value?.ToString()?.Trim() ?? "") : "";

                    // Properties[7] = TotalPages (int)
                    int pages = 0;
                    if (props.Count > 7 && props[7]?.Value != null)
                    {
                        int.TryParse(props[7].Value.ToString(), out pages);
                    }

                    // Filter by printer name
                    if (!string.IsNullOrEmpty(printerName))
                    {
                        if (!nameFromProps.Contains(printerName, StringComparison.OrdinalIgnoreCase))
                            continue;
                    }

                    if (pages > 0)
                    {
                        totalPages += pages;
                        eventCount++;

                        if (string.IsNullOrEmpty(printerName) && !string.IsNullOrEmpty(nameFromProps))
                        {
                            if (!printerCounts.ContainsKey(nameFromProps))
                                printerCounts[nameFromProps] = 0;
                            printerCounts[nameFromProps] += pages;
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                var err = new { error = $"EventLogReader failed: {ex.Message.Replace("\"", "'")}" };
                Console.Error.WriteLine(JsonSerializer.Serialize(err, JsonOptions));
            }

            var response = new
            {
                page_count = totalPages > 0 ? totalPages : (int?)null,
                source = totalPages > 0 ? "eventlog_cs" : "no_data",
                printer = string.IsNullOrEmpty(printerName) ? "all" : printerName,
                events_found = eventCount,
                days_queried = 30,
                method = "EventLogReader"
            };

            Console.WriteLine(JsonSerializer.Serialize(response, JsonOptions));
            return 0;
        }

        /// <summary>
        /// Listen for real-time print jobs by polling EventLog
        /// </summary>
        static int ListenForPrintJobs(int durationSeconds)
        {
            Console.Error.WriteLine($"Starting print job listener ({durationSeconds}s)...");

            string logName = "Microsoft-Windows-PrintService/Operational";
            DateTime endTime = DateTime.Now.AddSeconds(durationSeconds);
            DateTime lastCheck = DateTime.Now.AddDays(-1);
            int totalJobs = 0;
            int totalPages = 0;

            // First get the last known event time
            try
            {
                var q = new EventLogQuery(logName, PathType.LogName) { ReverseDirection = true };
                using var r = new EventLogReader(q);
                var first = (EventLogRecord?)r.ReadEvent();
                if (first?.TimeCreated.HasValue == true)
                    lastCheck = first.TimeCreated.Value.AddSeconds(-5);
            }
            catch { }

            while (DateTime.Now < endTime)
            {
                try
                {
                    // WHY: XPath giới hạn Event ID 307 trong 24h — trước đây query không
                    // có filter, mỗi 2s poll lại quét CẢ log (cùng root cause timeout như
                    // QueryPrintCount). lastCheck luôn <= 24h so với now nên 86400000ms đủ.
                    var query = new EventLogQuery(logName, PathType.LogName,
                        "*[System[(EventID=307) and TimeCreated[timediff(@SystemTime) <= 86400000]]]")
                    {
                        ReverseDirection = false
                    };

                    using var reader = new EventLogReader(query);
                    EventLogRecord? record;
                    while ((record = (EventLogRecord?)reader.ReadEvent()) != null)
                    {
                        // WHY: Check time TRƯỚC check Event ID (xem QueryPrintCount) —
                        // tránh quét cả log khi event không phải 307.
                        if (record.TimeCreated.HasValue && record.TimeCreated.Value > DateTime.Now) break;
                        if (record.Id != 307) continue;
                        if (record.TimeCreated.HasValue && record.TimeCreated.Value <= lastCheck) continue;

                        var props = record.Properties;
                        string? printer = props.Count > 4 ? props[4]?.Value?.ToString()?.Trim() : "";
                        int pages = 0;
                        if (props.Count > 7 && props[7]?.Value != null)
                            int.TryParse(props[7].Value.ToString(), out pages);

                        if (pages > 0)
                        {
                            totalJobs++;
                            totalPages += pages;

                            var job = new
                            {
                                type = "print_job",
                                timestamp = record.TimeCreated?.ToString("yyyy-MM-dd HH:mm:ss") ?? "",
                                printer = printer ?? "",
                                document = $"Event ID 307",
                                pages = pages
                            };
                            Console.WriteLine(JsonSerializer.Serialize(job, JsonOptions));
                        }

                        if (record.TimeCreated.HasValue && record.TimeCreated.Value > lastCheck)
                            lastCheck = record.TimeCreated.Value;
                    }
                }
                catch { }

                Thread.Sleep(2000); // Poll every 2 seconds
            }

            var summary = new
            {
                type = "summary",
                total_jobs = totalJobs,
                total_pages = totalPages,
                duration_seconds = durationSeconds
            };
            Console.Error.WriteLine(JsonSerializer.Serialize(summary, JsonOptions));
            return 0;
        }

        /// <summary>
        /// Print statistics for all printers (grouped by name)
        /// </summary>
        static int PrintAllStats()
        {
            string logName = "Microsoft-Windows-PrintService/Operational";
            DateTime startTime = DateTime.Now.AddDays(-30);
            var printerStats = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);

            try
            {
                // WHY: XPath filter EventID=307 + 30 ngày ngay tại engine (xem QueryPrintCount
                // để biết lý do — trước đây quét cả log gây timeout > 10s).
                string xpath = "*[System[(EventID=307) and TimeCreated[timediff(@SystemTime) <= 2592000000]]]";
                var query = new EventLogQuery(logName, PathType.LogName, xpath) { ReverseDirection = true };
                using var reader = new EventLogReader(query);
                EventLogRecord? record;
                int recordsRead = 0;
                while ((record = (EventLogRecord?)reader.ReadEvent()) != null)
                {
                    // WHY: Safety cap — đề phòng log lỗi/clock lệch làm break không kích hoạt.
                    if (++recordsRead > 5000) break;
                    // WHY: Check time trước ID — trước đây check ngược khiến code quét cả log.
                    if (record.TimeCreated.HasValue && record.TimeCreated.Value < startTime) break;
                    if (record.Id != 307) continue;

                    var props = record.Properties;
                    string? printer = props.Count > 4 ? (props[4]?.Value?.ToString()?.Trim() ?? "") : "";
                    if (string.IsNullOrEmpty(printer)) continue;

                    int pages = 0;
                    if (props.Count > 7 && props[7]?.Value != null)
                        int.TryParse(props[7].Value.ToString(), out pages);

                    if (!printerStats.ContainsKey(printer))
                        printerStats[printer] = 0;
                    printerStats[printer] += pages;
                }
            }
            catch (Exception ex)
            {
                var err = new { error = ex.Message.Replace("\"", "'") };
                Console.Error.WriteLine(JsonSerializer.Serialize(err, JsonOptions));
            }

            var stats = printerStats.Select(p => new { printer = p.Key, pages_30days = p.Value }).ToList();
            var response = new { printers = stats, total_printers = stats.Count, days_queried = 30 };
            Console.WriteLine(JsonSerializer.Serialize(response, JsonOptions));
            return 0;
        }

        /// <summary>
        /// Enable PrintService Operational log
        /// </summary>
        static int EnablePrintServiceLog()
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo
                {
                    FileName = "powershell.exe",
                    Arguments = "-NoProfile -Command \"wevtutil.exe set-log 'Microsoft-Windows-PrintService/Operational' /enabled:true /quiet\"",
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true
                };

                using Process? proc = Process.Start(psi);
                if (proc == null)
                {
                    Console.WriteLine(JsonSerializer.Serialize(new { status = "error", error = "Failed to start wevtutil" }, JsonOptions));
                    return 1;
                }
                proc.WaitForExit(10000);

                Console.WriteLine(JsonSerializer.Serialize(new { status = "installed", note = "PrintService Operational log enabled." }, JsonOptions));
                return 0;
            }
            catch (Exception ex)
            {
                var err = new { error = ex.Message.Replace("\"", "'") };
                Console.Error.WriteLine(JsonSerializer.Serialize(err, JsonOptions));
                return 1;
            }
        }

        static readonly JsonSerializerOptions JsonOptions = new()
        {
            PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
            WriteIndented = false,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
        };
    }
}
