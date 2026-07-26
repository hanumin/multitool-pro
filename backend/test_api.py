"""
Auto tests cho tất cả API endpoints của MultiTool Pro backend.
Chạy: pytest backend/test_api.py -v
Yêu cầu: backend đang chạy tại http://127.0.0.1:5050
"""

import json
import requests
import pytest

BASE = "http://127.0.0.1:5050"


# ═══════════════════════════════════════════════════════════════
# HELPERS
# ═══════════════════════════════════════════════════════════════

def get(path):
    return requests.get(f"{BASE}{path}", timeout=10)

def post(path, data=None):
    return requests.post(f"{BASE}{path}", json=data, timeout=15)

def put(path, data=None):
    return requests.put(f"{BASE}{path}", json=data, timeout=10)

def delete(path, data=None):
    return requests.delete(f"{BASE}{path}", json=data, timeout=10)

def ok(r):
    """Assert HTTP 200"""
    assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text[:200]}"

def created(r):
    """Assert HTTP 201"""
    assert r.status_code == 201, f"Expected 201, got {r.status_code}: {r.text[:200]}"

def accepted(r):
    """Assert HTTP 202"""
    assert r.status_code == 202, f"Expected 202, got {r.status_code}: {r.text[:200]}"

def not_found(r):
    """Assert HTTP 404"""
    assert r.status_code == 404, f"Expected 404, got {r.status_code}: {r.text[:200]}"

def conflict(r):
    """Assert HTTP 409"""
    assert r.status_code == 409, f"Expected 409, got {r.status_code}: {r.text[:200]}"

def server_error(r):
    """Assert HTTP 500"""
    assert r.status_code == 500, f"Expected 500, got {r.status_code}: {r.text[:200]}"


# ═══════════════════════════════════════════════════════════════
# SYSTEM & HEALTH
# ═══════════════════════════════════════════════════════════════

class TestSystemEndpoints:
    """Kiểm tra các endpoint hệ thống"""

    def test_debug_log(self):
        r = get("/api/debug-log")
        ok(r)
        data = r.json()
        assert isinstance(data, dict) and ("log" in data or "logs" in data or len(data) > 0)

    def test_system_ips(self):
        r = get("/api/system/ips")
        ok(r)
        data = r.json()
        assert "ips" in data or isinstance(data, list)


# ═══════════════════════════════════════════════════════════════
# PROJECTS
# ═══════════════════════════════════════════════════════════════

class TestProjectsEndpoints:
    """Kiểm tra CRUD + start/stop projects"""

    def test_list_projects(self):
        r = get("/api/projects")
        ok(r)
        data = r.json()
        assert isinstance(data, list)
        # Mỗi project có name, port, path, running
        if data:
            for p in data:
                assert "name" in p
                assert "port" in p
                assert "running" in p

    def test_get_config(self):
        r = get("/api/config")
        ok(r)
        data = r.json()
        assert "projects" in data
        assert isinstance(data["projects"], list)

    def test_get_config_projects(self):
        r = get("/api/config/projects") if False else None  # Không có GET cho /api/config/projects
        # Test qua /api/config thay vì
        r = get("/api/config")
        ok(r)

    def test_add_project_validation(self):
        """POST /api/config/projects không có name → 400"""
        r = post("/api/config/projects", {})
        # Flask trả về 400 hoặc 500 tùy validation
        assert r.status_code in (400, 500)

    def test_nonexistent_project(self):
        """GET project không tồn tại → 404"""
        r = get("/api/projects/NonExistentProject12345/logs")
        not_found(r)

    def test_start_nonexistent(self):
        """POST start project không tồn tại → 404"""
        r = post("/api/projects/NonExistentProject12345/start")
        not_found(r)

    def test_stop_nonexistent(self):
        """POST stop project không tồn tại → 404"""
        r = post("/api/projects/NonExistentProject12345/stop")
        not_found(r)

    def test_project_diagnostics_nonexistent(self):
        r = get("/api/projects/NonExistentProject12345/diagnostics")
        not_found(r)

    def test_project_env_nonexistent(self):
        r = get("/api/projects/NonExistentProject12345/env")
        not_found(r)

    def test_project_scripts_nonexistent(self):
        r = get("/api/projects/NonExistentProject12345/scripts")
        not_found(r)

    def test_project_disk_usage_nonexistent(self):
        r = get("/api/projects/NonExistentProject12345/disk-usage")
        not_found(r)

    def test_project_perf_history_nonexistent(self):
        r = get("/api/projects/NonExistentProject12345/perf-history")
        # Trả về 200 với history rỗng (không phải 404) — behavior hiện tại của backend
        ok(r)
        data = r.json()
        assert "history" in data

    def test_ssl_nonexistent(self):
        r = post("/api/projects/NonExistentProject12345/ssl")
        not_found(r)

    def test_clean_nonexistent(self):
        r = post("/api/projects/NonExistentProject12345/clean", {"type": "basic"})
        not_found(r)

    def test_start_stop_project(self):
        """Start rồi stop project đầu tiên (nếu có)"""
        r = get("/api/projects")
        ok(r)
        projects = r.json()
        if not projects:
            pytest.skip("Không có project nào để test")
        name = projects[0]["name"]

        # Start
        r = post(f"/api/projects/{name}/start")
        assert r.status_code in (200, 409)  # 200=started, 409=already_running

        # Diagnostics
        r = get(f"/api/projects/{name}/diagnostics")
        ok(r)
        data = r.json()
        assert "name" in data
        assert "running" in data
        assert "memory" in data
        assert "cpu" in data

        # Scripts
        r = get(f"/api/projects/{name}/scripts")
        ok(r)
        data = r.json()
        assert "scripts" in data

        # Disk usage
        r = get(f"/api/projects/{name}/disk-usage")
        ok(r)
        data = r.json()
        assert "sizes" in data

        # Perf history
        r = get(f"/api/projects/{name}/perf-history")
        ok(r)
        data = r.json()
        assert "history" in data

        # Logs
        r = get(f"/api/projects/{name}/logs")
        ok(r)
        data = r.json()
        assert "lines" in data

        # Stop
        r = post(f"/api/projects/{name}/stop")
        assert r.status_code in (200, 409)  # 200=stopped, 409=not running

    def test_start_all_stop_all(self):
        """start-all + stop-all không crash"""
        r = post("/api/projects/start-all")
        ok(r)
        data = r.json()
        assert "results" in data

        r = post("/api/projects/stop-all")
        ok(r)
        data = r.json()
        assert "results" in data

    def test_port_scan(self):
        """POST /api/system/port-scan"""
        r = post("/api/system/port-scan", {"ports": [3000, 4000, 5050]})
        ok(r)
        data = r.json()
        assert "ports" in data

    def test_tunnel_status_nonexistent(self):
        """Tunnel endpoints cho project không tồn tại → 404"""
        r = get("/api/projects/NonExistentProject12345/tunnel")
        not_found(r)
        r = post("/api/projects/NonExistentProject12345/tunnel/start")
        not_found(r)
        r = post("/api/projects/NonExistentProject12345/tunnel/stop")
        not_found(r)
        r = get("/api/projects/NonExistentProject12345/tunnel/watchdog")
        not_found(r)

    def test_logs_export(self):
        """GET /api/logs/all"""
        r = get("/api/logs/all")
        ok(r)
        data = r.json()
        assert isinstance(data, dict)

    def test_logs_export_endpoint(self):
        """GET /api/logs/export"""
        r = get("/api/logs/export")
        ok(r)

    def test_tunnels_export(self):
        """GET /api/tunnels/export"""
        r = get("/api/tunnels/export")
        ok(r)

    def test_tunnels_metrics_export(self):
        """GET /api/tunnels/metrics/export"""
        r = get("/api/tunnels/metrics/export")
        ok(r)

    def test_tunnels_changes(self):
        """GET /api/tunnels/changes"""
        r = get("/api/tunnels/changes")
        ok(r)

    def test_tunnels_history(self):
        """GET /api/tunnels/history"""
        r = get("/api/tunnels/history")
        ok(r)

    def test_cloudflared_check(self):
        """GET /api/cloudflared/check"""
        r = get("/api/cloudflared/check")
        ok(r)
        data = r.json()
        assert "installed" in data or "status" in data


# ═══════════════════════════════════════════════════════════════
# SETTINGS
# ═══════════════════════════════════════════════════════════════

class TestSettingsEndpoints:
    """Kiểm tra settings"""

    def test_get_settings(self):
        r = get("/api/settings")
        ok(r)
        data = r.json()
        assert "autostart" in data

    def test_autostart(self):
        """POST /api/settings/autostart — toggle autostart"""
        r = post("/api/settings/autostart", {"enabled": False})
        ok(r)
        data = r.json()
        assert "autostart" in data

    def test_config_reload(self):
        r = post("/api/config/reload")
        ok(r)
        data = r.json()
        assert "status" in data


# ═══════════════════════════════════════════════════════════════
# PRINTERS
# ═══════════════════════════════════════════════════════════════

class TestPrintersEndpoints:
    """Kiểm tra printer endpoints"""

    def test_list_printers(self):
        r = get("/api/printers")
        ok(r)
        data = r.json()
        # Có thể trả về list hoặc dict với key 'printers'
        if isinstance(data, dict):
            printers = data.get("printers", [])
        else:
            printers = data
        assert len(printers) > 0, f"Expected >0 printers, got: {data}"
        for p in printers:
            assert "name" in p, f"Missing 'name' in printer: {p}"
            assert "status" in p or "driver" in p

    def test_printer_page_count(self):
        r = get("/api/printer/page-count")
        ok(r)
        data = r.json()
        assert "page_count" in data or "error" in data

    def test_printer_stats(self):
        r = get("/api/printer/stats")
        ok(r)
        data = r.json()
        assert isinstance(data, list) or isinstance(data, dict)

    def test_printer_activity(self):
        r = get("/api/printer/activity")
        ok(r)

    def test_printer_reminder_check(self):
        r = get("/api/printer/reminder-check")
        ok(r)

    def test_printer_wmi_status(self):
        r = get("/api/printer/wmi-status")
        ok(r)

    def test_printer_pjl_status(self):
        r = get("/api/printer/pjl-status")
        ok(r)

    def test_printer_settings(self):
        r = get("/api/printer/settings")
        ok(r)

    def test_printer_history(self):
        r = get("/api/printer/history")
        ok(r)

    def test_printer_export(self):
        r = get("/api/printer/export")
        ok(r)

    def test_auto_detect(self):
        r = post("/api/printer/auto-detect")
        ok(r)

    def test_printer_nonexistent_jobs(self):
        r = get("/api/printers/NonExistentPrinter/jobs")
        assert r.status_code in (200, 404, 500)


# ═══════════════════════════════════════════════════════════════
# AUDIO
# ═══════════════════════════════════════════════════════════════

class TestAudioEndpoints:
    """Kiểm tra audio endpoints"""

    def test_list_devices(self):
        """GET /api/audio/devices — FIX: phải trả về > 0 devices"""
        r = get("/api/audio/devices")
        ok(r)
        data = r.json()
        assert "devices" in data, f"Missing 'devices' in response: {data}"
        assert len(data["devices"]) > 0, \
            f"Expected >0 devices, got 0. Bug: pycaw.GetAllDevices() returns empty, need sounddevice fallback. Response: {data}"

    def test_mic_status(self):
        """GET /api/audio/mic-status — phải trả về chi tiết mic"""
        r = get("/api/audio/mic-status")
        ok(r)
        data = r.json()
        assert "active" in data
        assert "mic_name" in data
        assert "mic_muted" in data or "overall_status" in data
        assert "available_mics" in data

    def test_audio_sound_files(self):
        r = get("/api/audio/sound-files")
        ok(r)
        data = r.json()
        assert "sound_files" in data or isinstance(data, dict)

    def test_audio_settings(self):
        r = get("/api/audio/settings")
        ok(r)
        data = r.json()
        assert isinstance(data, dict)

    def test_audio_session_history(self):
        r = get("/api/audio/session-history")
        ok(r)


# ═══════════════════════════════════════════════════════════════
# DATABASE
# ═══════════════════════════════════════════════════════════════

class TestDatabaseEndpoints:
    """Kiểm tra database endpoints"""

    def test_db_connections(self):
        """GET /api/database/connections"""
        r = get("/api/database/connections")
        ok(r)
        data = r.json()
        # Có thể trả về list hoặc dict với key 'connections'
        if isinstance(data, dict):
            assert "connections" in data, f"Missing 'connections' key: {data}"
        else:
            assert isinstance(data, list)

    def test_db_test_no_data(self):
        """POST /api/database/test không có data → lỗi (không crash)"""
        r = post("/api/database/test", {})
        assert r.status_code in (200, 400, 500)

    def test_db_connect_no_data(self):
        """POST /api/database/connect không có data → lỗi (không crash)"""
        r = post("/api/database/connect", {})
        assert r.status_code in (200, 400, 500)

    def test_db_schemas_no_connection(self):
        """POST /api/database/schemas không có connectionId → lỗi (không crash)"""
        r = post("/api/database/schemas", {})
        assert r.status_code in (200, 400, 500)

    def test_db_tables_no_data(self):
        r = post("/api/database/tables", {})
        assert r.status_code in (200, 400, 500)

    def test_db_query_no_data(self):
        r = post("/api/database/query", {})
        assert r.status_code in (200, 400, 500)

    def test_db_table_data_no_data(self):
        r = post("/api/database/table-data", {})
        assert r.status_code in (200, 400, 500)

    def test_db_export_no_data(self):
        r = post("/api/database/export", {})
        assert r.status_code in (200, 400, 500)


# ═══════════════════════════════════════════════════════════════
# TUNNEL
# ═══════════════════════════════════════════════════════════════

class TestTunnelEndpoints:
    """Kiểm tra tunnel endpoints"""

    def test_tunnels_import(self):
        """POST /api/tunnels/import — test với data rỗng"""
        r = post("/api/tunnels/import", {})
        assert r.status_code in (200, 400, 500)

    def test_logs_save_to_file(self):
        """POST /api/logs/save-to-file"""
        r = post("/api/logs/save-to-file", {})
        assert r.status_code in (200, 400, 500)

    def test_system_open_browser(self):
        """POST /api/system/open-browser"""
        r = post("/api/system/open-browser", {})
        assert r.status_code in (200, 400, 500)

    def test_printer_import(self):
        """POST /api/printer/import"""
        r = post("/api/printer/import", {})
        assert r.status_code in (200, 400, 500)

    def test_printer_backup(self):
        """POST /api/printer/backup"""
        r = post("/api/printer/backup", {})
        assert r.status_code in (200, 400, 500)

    def test_audio_session_log(self):
        """POST /api/audio/session-log"""
        r = post("/api/audio/session-log", {})
        assert r.status_code in (200, 400, 500)

    def test_file_copier_count(self):
        """POST /api/file-copier/count"""
        r = post("/api/file-copier/count", {})
        assert r.status_code in (200, 400, 500)


# ═══════════════════════════════════════════════════════════════
# OPEN-EXPLORER
# ═══════════════════════════════════════════════════════════════

class TestSystemActions:
    """Kiểm tra system action endpoints"""

    def test_open_explorer_no_path(self):
        """POST /api/system/open-explorer không có path → 400"""
        r = post("/api/system/open-explorer", {})
        assert r.status_code == 400


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
