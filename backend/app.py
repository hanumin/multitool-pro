import json, os, subprocess, sys, time, threading, signal, shutil
import psutil
import pythoncom
from pathlib import Path
from flask import Flask, jsonify, request, Response, send_from_directory
from flask_cors import CORS
from datetime import datetime, timedelta

# Thư mục gốc của project (chứa backend/, dist/, ...)
BASE_DIR = Path(__file__).resolve().parent.parent

# File cấu hình để ở %APPDATA%/server-dashboard/config.json
# (chuẩn Windows, không phụ thuộc vào vị trí đặt exe)
APPDATA = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming"))
CONFIG_DIR = APPDATA / "multitool-pro"
CONFIG_PATH = CONFIG_DIR / "config.json"

# ─── MIGRATION từ server-dashboard sang multitool-pro ────────────
# WHY: 1-time migration khi nâng cấp từ server-dashboard (cũ) lên multitool-pro (mới).
# Copy dữ liệu cũ sang thư mục mới, không xóa dữ liệu cũ.
def migrate_old_config():
    """Di chuyển dữ liệu cũ từ %APPDATA%/server-dashboard/ -> %APPDATA%/multitool-pro/"""
    old_dir = APPDATA / "server-dashboard"
    if old_dir.exists() and not CONFIG_DIR.exists():
        try:
            CONFIG_DIR.mkdir(parents=True, exist_ok=True)
            for item in old_dir.iterdir():
                dest = CONFIG_DIR / item.name
                if item.is_file():
                    shutil.copy2(item, dest)
                elif item.is_dir():
                    shutil.copytree(item, dest, dirs_exist_ok=True)
            print(f"[migrate] Copied config from {old_dir} to {CONFIG_DIR}")
        except Exception as e:
            print(f"[migrate] Error: {e}")

migrate_old_config()
# ──────────────────────────────────────────────────────────────────

FRONTEND_DIST = BASE_DIR / "dist"

# ─── DEBUG LOG ───────────────────────────────────────────────────
DEBUG_LOG = CONFIG_DIR / "debug.log"

# WHY: Ghi log vào file + console (print) đồng thời — không thể thiếu log trên console
# vì backend chạy trong terminal window, debug file dùng để review sau.
def debug_log(msg):
    """Ghi log debug vào %APPDATA%/server-dashboard/debug.log"""
    try:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        with open(DEBUG_LOG, 'a', encoding='utf-8') as f:
            f.write(f'[{timestamp}] {msg}\n')
    except:
        pass
    # Cũng in ra console để xem real-time khi chạy backend
    print(f'[debug] {msg}')

# WHY: Tạo subprocess.STARTUPINFO với SW_HIDE để ẩn cửa sổ terminal của child processes.
# Quan trọng cho npm/node spawn — không tạo cửa sổ CMD mới mỗi lần start.
def get_startupinfo():
    if sys.platform == "win32":
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startupinfo.wShowWindow = 0  # SW_HIDE
        return startupinfo
    return None

app = Flask(__name__, static_folder=str(FRONTEND_DIST))
CORS(app)  # Allow CORS headers; actual security validation is handled dynamically in before_request

@app.before_request
# WHY: @app.before_request — chạy TRƯỚC mọi request. Bảo vệ double-layer:
# 1) remote_addr check: chỉ allow localhost (127.0.0.1, ::1)
# 2) Origin header validation: block request từ web pages lạ (CSRF).
def limit_remote_addr():
    # Only allow connections from localhost
    if request.remote_addr not in ("127.0.0.1", "::1"):
        return jsonify({"error": "Từ chối - Chỉ localhost"}), 403

    # Check Origin header for CSRF protection in local browsers
    origin = request.headers.get("Origin")
    if origin:
        # Allow any localhost or tauri origin dynamically (any ports, schemes, subdomains)
        is_local = (
            origin.startswith("http://localhost") or
            origin.startswith("https://localhost") or
            origin.startswith("http://127.0.0.1") or
            origin.startswith("https://127.0.0.1") or
            origin.startswith("http://tauri.localhost") or
            origin.startswith("https://tauri.localhost") or
            origin.startswith("tauri://")
        )
        if not is_local:
            return jsonify({"error": "Từ chối - Origin không hợp lệ"}), 403

processes = {}           # name -> subprocess.Popen (main server process)
script_processes = {}    # name -> subprocess.Popen (one-off scripts, KHÔNG ảnh hưởng main server)
log_positions = {}       # name -> bytes read
log_data = {}            # name -> list of lines
log_files = {}           # name -> log file path
lock = threading.Lock()

# WHY: Load config từ %APPDATA%/multitool-pro/config.json.
# Nếu chưa có, tạo mới với default values + migrate từ project root config.json (nếu tồn tại).
# Return default (không raise exception) khi JSON corrupt — app vẫn chạy được.
def load_config():
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    if not CONFIG_PATH.exists():
        default = {"portMin": 4000, "portMax": 4999, "projects": []}
        # Di chuyển dữ liệu từ config cũ (nếu có)
        old_config = BASE_DIR / "config.json"
        if old_config.exists():
            try:
                with open(old_config, encoding="utf-8") as f:
                    old = json.load(f)
                if "projects" in old:
                    default["projects"] = old["projects"]
                    print(f"[config] Migrated {len(old['projects'])} projects from {old_config}")
            except Exception:
                pass
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(default, f, indent=2, ensure_ascii=False)
        print(f"[config] Created config at {CONFIG_PATH}")
        return default
    try:
        with open(CONFIG_PATH, encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, PermissionError) as e:
        print(f"[config] ERROR loading {CONFIG_PATH}: {e}")
        return {"portMin": 4000, "portMax": 4999, "projects": []}

config = load_config()

# WHY: Project config version — tăng mỗi khi projects thay đổi (add/update/delete).
# Tunnel Dashboard dùng để phát hiện thay đổi mà không cần poll heavy request.
_project_config_version = 0

def _bump_config_version():
    """Tăng version counter để tunnel dashboard biết projects đã thay đổi."""
    global _project_config_version
    _project_config_version += 1

# WHY: Log file path trong %TEMP% — mỗi project 1 file riêng (sd_{name}.log).
# Dùng TEMP thay vì thư mục project để không ảnh hưởng git status.
def get_log_file(proj):
    return Path(os.environ.get("TEMP", os.environ.get("TMP", "/tmp"))) / f"sd_{proj['name']}.log"

# WHY: Kiểm tra process còn sống bằng poll() — không dùng returncode vì process có thể vừa chết.
# Thread-safe (with lock). p.poll() = None nghĩa là process vẫn đang chạy.
def is_running(name):
    with lock:
        p = processes.get(name)
        return p is not None and p.poll() is None

# WHY: Tìm project trong config.projects theo name. O(n) nhưng n nhỏ (< 20).
# Trả về None nếu không tìm thấy — caller xử lý 404.
def get_project(name):
    for p in config["projects"]:
        if p["name"] == name:
            return p
    return None

@app.route("/api/projects")
# WHY: GET-only. Trả về danh sách project với running status (không phải port/path chi tiết).
# is_running() check từng project — O(n) nhưng n nhỏ.
def api_projects():
    results = []
    for p in config["projects"]:
        results.append({
            "name": p["name"],
            "port": p["port"],
            "path": p["path"],
            "running": is_running(p["name"]),
        })
    return jsonify(results)

# WHY: Core helper — start một dev server project.
# Tự động npm install nếu node_modules chưa có (blocking). Reset log file trước start.
# Gán process vào global dict để is_running() và diagnostics có thể theo dõi.
def _start_project(proj):
    """Helper: start một project, trả về result dict"""
    name = proj["name"]
    if is_running(name):
        return {"name": name, "status": "already_running"}
    
    # WHY: Dọn port trước khi start — tránh lỗi EADDRINUSE nếu có process cũ/chết chiếm port.
    # Chỉ dọn khi project chưa chạy (kill_process_on_port sau is_running) để không
    # vô tình giết project đang chạy (trên Windows, child node.exe bị kill nhưng
    # parent cmd.exe vẫn sống → is_running() trả về True nhưng server thực tế đã chết).
    kill_process_on_port(proj["port"])
    
    # WHY: Nếu node_modules không tồn tại, KHÔNG start luôn mà báo để user chờ
    node_modules = Path(proj["path"]) / "node_modules"
    if not node_modules.exists():
        # WHY: Chạy npm install đồng bộ (blocking) để tránh race condition.
        # Mặc dù block API, nhưng đây là thao tác 1 lần duy nhất.
        # User sẽ thấy loading trên UI và log npm install trong tab log.
        lf = get_log_file(proj)
        if lf.exists():
            _safe_unlink_log(lf)
        debug_log(f"npm install started for {name}...")
        install_proc = subprocess.Popen(
            ["npm", "install"],
            cwd=proj["path"],
            stdout=open(lf, "w", encoding="utf-8"),
            stderr=subprocess.STDOUT,
            shell=True,
            startupinfo=get_startupinfo(),
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
        )
        install_proc.wait()  # CHỜ đến khi npm install xong
        debug_log(f"npm install completed for {name}")
        # Kiểm tra lại sau khi install
        if not node_modules.exists():
            return {"name": name, "status": "error", "error": "npm install failed"}
    
    lf = get_log_file(proj)
    if lf.exists():
        _safe_unlink_log(lf)
    log_files[name] = str(lf)
    log_data[name] = []
    log_positions[name] = 0
    
    cmd_str = proj.get("command", "npm run dev").replace("{port}", str(proj["port"]))
    try:
        p = subprocess.Popen(
            cmd_str, cwd=proj["path"],
            stdout=open(lf, "w", encoding="utf-8"),
            stderr=subprocess.STDOUT, shell=True,
            startupinfo=get_startupinfo(),
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
        )
        with lock:
            processes[name] = p
        return {"name": name, "status": "started"}
    except Exception as e:
        return {"name": name, "status": "error", "error": str(e)}

@app.route("/api/projects/start-all", methods=["POST"])
# WHY: Gọi _start_project() cho từng project — không Promise.all vì dependencies có thể conflict.
# Trả về danh sách kết quả để UI hiển thị chi tiết.
def api_start_all():
    """Start tất cả dự án"""
    results = []
    for p in config["projects"]:
        results.append(_start_project(p))
    return jsonify({"results": results, "count": len(results)})

@app.route("/api/projects/stop-all", methods=["POST"])
# WHY: Dùng terminate() (graceful) trước, nếu timeout 5s mới kill (force).
# kill_process_on_port() sau khi stop để dọn port (tránh conflict khi start lại).
def api_stop_all():
    """Stop tất cả dự án"""
    results = []
    for p in config["projects"]:
        try:
            if is_running(p["name"]):
                name = p["name"]
                with lock:
                    proc = processes.get(name)
                    if proc:
                        proc.terminate()
                        try:
                            proc.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            proc.kill()
                        processes.pop(name, None)
                kill_process_on_port(p["port"])
                results.append({"name": name, "status": "stopped"})
            else:
                results.append({"name": p["name"], "status": "not_running"})
        except Exception as e:
            results.append({"name": p["name"], "status": "error", "error": str(e)})
    return jsonify({"results": results, "count": len(results)})

@app.route("/api/projects/<name>/start", methods=["POST"])
# WHY: Delegate to _start_project() helper. Xử lý các status response khác nhau:
# 500 (error), 409 (already running), 202 (installing deps).
def api_start(name):
    proj = get_project(name)
    if not proj:
        return jsonify({"error": "Không tìm thấy"}), 404
    result = _start_project(proj)
    if result["status"] == "error":
        return jsonify(result), 500
    if result["status"] == "already_running":
        return jsonify({"error": "Đã đang chạy"}), 409
    if result["status"] == "installing":
        return jsonify(result), 202  # 202 Accepted - đang cài dependencies
    return jsonify(result)

@app.route("/api/projects/<name>/stop", methods=["POST"])
# WHY: terminate() + wait(timeout=5) + kill() fallback = 3-step graceful shutdown.
# kill_process_on_port() để dọn port ngay cả khi process không kill được.
def api_stop(name):
    proj = get_project(name)
    if not proj:
        return jsonify({"error": "Không tìm thấy"}), 404
    if not is_running(name):
        return jsonify({"error": "Không đang chạy"}), 409

    with lock:
        p = processes.get(name)
        if p:
            p.terminate()
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                p.kill()
            processes.pop(name, None)

    kill_process_on_port(proj["port"])

    return jsonify({"status": "stopped", "name": name})

@app.route("/api/projects/<name>/logs")
# WHY: Đọc toàn bộ file log, return 200 dòng cuối. Đọc full file (không seek)
# vì file log có thể bị truncate/rotate (Windows file lock).
def api_logs(name):
    proj = get_project(name)
    if not proj:
        return jsonify({"error": "Không tìm thấy"}), 404

    lf = get_log_file(proj)
    if not lf.exists():
        return jsonify({"lines": []})

    with open(lf, encoding="utf-8", errors="replace") as f:
        content = f.read()

    lines = [l for l in content.split("\n") if l]
    return jsonify({"lines": lines[-200:]})

@app.route("/api/projects/<name>/logs/stream")
# WHY: Server-Sent Events (SSE) — không phải WebSocket. Đơn giản hơn, native HTTP.
# Poll file mỗi 1s, chỉ gửi dữ liệu mới (dùng seek(pos)).
# X-Accel-Buffering: no để tắt Nginx buffering cho SSE.
def api_logs_stream(name):
    proj = get_project(name)
    if not proj:
        return jsonify({"error": "Không tìm thấy"}), 404

    def generate():
        lf = get_log_file(proj)
        pos = 0
        while True:
            if lf.exists():
                with open(lf, encoding="utf-8", errors="replace") as f:
                    if pos > 0:
                        f.seek(pos)
                    new_data = f.read()
                    pos = f.tell()
                    if new_data:
                        yield f"data: {json.dumps(new_data)}\n\n"
            time.sleep(1)
        yield "data: {\"done\": true}\n\n"

    return Response(generate(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

@app.route("/api/logs/all")
# WHY: Gộp tất cả log files vào 1 response (key=project name).
# Frontend dùng để render log tabs (All + từng project).
def api_logs_all():
    all_lines = {}
    for p in config["projects"]:
        lf = get_log_file(p)
        if lf.exists():
            with open(lf, encoding="utf-8", errors="replace") as f:
                all_lines[p["name"]] = [l for l in f.read().split("\n") if l]
        else:
            all_lines[p["name"]] = []
    return jsonify(all_lines)

AUTOSTART_SCRIPT = str(BASE_DIR / "auto-start.ps1")

# WHY: Kiểm tra file .lnk trong Windows Startup folder thay vì query Registry.
# File-based check đơn giản hơn, không cần COM permissions.
def autostart_shortcut_exists():
    startup = os.path.join(os.environ.get("APPDATA", ""), "Microsoft", "Windows", "Start Menu", "Programs", "Startup")
    if not startup:
        return False
    return os.path.exists(os.path.join(startup, "MultiToolPro.lnk"))

# WHY: PowerShell WScript.Shell COM object để tạo .lnk (WScript.CreateShortcut).
# Không dùng mklink vì Windows shortcut (.lnk) không phải symlink.
# Tạo trực tiếp tới exe (nếu có MULTITOOL_PRO_EXE env) hoặc fallback PS1.
def set_autostart(enabled: bool):
    startup = os.path.join(os.environ.get("APPDATA", ""), "Microsoft", "Windows", "Start Menu", "Programs", "Startup")
    lnk = os.path.join(startup, "MultiToolPro.lnk")
    if enabled:
        # WHY: Ưu tiên dùng đường dẫn exe từ biến môi trường do Tauri truyền xuống
        exe_path = os.environ.get("MULTITOOL_PRO_EXE")
        if not exe_path or not os.path.exists(exe_path):
            # Fallback: dùng auto-start.ps1 nếu không tìm thấy exe
            if os.path.exists(AUTOSTART_SCRIPT):
                esc_script = AUTOSTART_SCRIPT.replace("\\", "\\\\")
                esc_dir = str(BASE_DIR).replace("\\", "\\\\")
                ps_code = f'''
$wsh = New-Object -ComObject WScript.Shell
$lnk = $wsh.CreateShortcut("{lnk}")
$lnk.TargetPath = "powershell.exe"
$lnk.Arguments = "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"{esc_script}`""
$lnk.WorkingDirectory = "{esc_dir}"
$lnk.Description = "MultiTool Pro"
$lnk.Save()
'''
                subprocess.run(["powershell", "-NoProfile", "-Command", ps_code], capture_output=True,
                               startupinfo=get_startupinfo(),
                               creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0)
            else:
                raise Exception("Cannot find MultiTool Pro executable or auto-start.ps1")
        else:
            # WHY: Tạo shortcut trực tiếp tới exe (không qua PS1 script) để khởi động app trực tiếp
            esc_exe = exe_path.replace("\\", "\\\\")
            esc_dir = str(os.path.dirname(exe_path)).replace("\\", "\\\\")
            ps_code = f'''
$wsh = New-Object -ComObject WScript.Shell
$lnk = $wsh.CreateShortcut("{lnk}")
$lnk.TargetPath = "{esc_exe}"
$lnk.WorkingDirectory = "{esc_dir}"
$lnk.Description = "MultiTool Pro"
$lnk.Save()
'''
            subprocess.run(["powershell", "-NoProfile", "-Command", ps_code], capture_output=True,
                           startupinfo=get_startupinfo(),
                           creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0)
    else:
        if os.path.exists(lnk):
            os.remove(lnk)

@app.route("/api/settings")
# WHY: GET-only. Trả về autostart status. Dùng để frontend hiển thị checkbox.
# Có thể mở rộng thêm settings fields sau này.
def api_settings():
    return jsonify({
        "autostart": autostart_shortcut_exists(),
    })

@app.route("/api/settings/autostart", methods=["POST"])
# WHY: POST vì có side effect (tạo/xóa .lnk file).
# Frontend đọc autostart từ response (có thể khác với request do PermissionError).
def api_set_autostart():
    data = request.get_json() or {}
    try:
        set_autostart(data.get("enabled", False))
        return jsonify({"autostart": autostart_shortcut_exists()})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# WHY: Ghi config vào file JSON atomic — không dùng temp file vì config nhỏ (< 50KB).
# CONFIG_DIR.mkdir mỗi lần để an toàn (directory có thể bị xóa khi update app).
def save_config():
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2, ensure_ascii=False)

@app.route("/api/config", methods=["GET", "PUT"])
# WHY: GET = đọc config (portMin/Max + projects). PUT = chỉ cập nhật port range.
# Projects CRUD có endpoints riêng (/api/config/projects).
def api_get_config():
    global config
    if request.method == "PUT":
        data = request.get_json() or {}
        if "portMin" in data:
            config["portMin"] = int(data["portMin"])
        if "portMax" in data:
            config["portMax"] = int(data["portMax"])
        save_config()
    return jsonify(config)

@app.route("/api/config/projects", methods=["POST"])
# WHY: POST create. Validate name + path required. Check duplicate name trước khi save.
# Port auto-assign nếu không được cung cấp (4000 + len(projects)).
def api_add_project():
    data = request.get_json()
    if not data or not data.get("name") or not data.get("path"):
        return jsonify({"error": "Yêu cầu tên và đường dẫn"}), 400
    name = data["name"]
    if get_project(name):
        return jsonify({"error": "Dự án đã tồn tại"}), 409
    port = data.get("port", 4000 + len(config["projects"]))
    command = data.get("command", "npm run dev")
    new_proj = {"name": name, "path": data["path"], "command": command, "port": port}
    config["projects"].append(new_proj)
    save_config()
    _bump_config_version()
    return jsonify(new_proj), 201

@app.route("/api/config/projects/<name>", methods=["PUT"])
# WHY: Full update — không phải PATCH. User gửi toàn bộ fields muốn thay đổi.
# Nếu đổi port, kiểm tra project không đang chạy (tránh kill/restart không mong muốn).
def api_update_project(name):
    proj = get_project(name)
    if not proj:
        return jsonify({"error": "Không tìm thấy"}), 404
    data = request.get_json() or {}
    if "port" in data and data["port"] != proj["port"]:
        if is_running(name):
            return jsonify({"error": "Dừng dự án trước khi đổi cổng"}), 409
    old_name = name
    if "name" in data and data["name"] != name:
        if get_project(data["name"]):
            return jsonify({"error": "Tên đã được sử dụng"}), 409
        proj["name"] = data["name"]
        if old_name in processes:
            processes[data["name"]] = processes.pop(old_name)
    for k in ("path", "command", "port"):
        if k in data:
            proj[k] = data[k]
    save_config()
    _bump_config_version()
    return jsonify(proj)

@app.route("/api/config/projects/<name>", methods=["DELETE"])
# WHY: Nếu project đang chạy, stop + kill port trước khi xóa.
# Xóa khỏi config.projects list — không xóa source code trên disk.
def api_delete_project(name):
    proj = get_project(name)
    if not proj:
        return jsonify({"error": "Không tìm thấy"}), 404
    if is_running(name):
        with lock:
            p = processes.get(name)
            if p:
                p.terminate()
                try:
                    p.wait(timeout=3)
                except:
                    p.kill()
                processes.pop(name, None)
        # WHY: Dùng psutil để kill process an toàn trên port
        kill_process_on_port(proj["port"])
    config["projects"] = [p for p in config["projects"] if p["name"] != name]
    save_config()
    _bump_config_version()
    return jsonify({"status": "deleted", "name": name})

# WHY: Log file có thể bị process con (node.exe) khóa → PermissionError.
# Fallback: truncate nội dung (mode "w") thay vì xóa file → log không bị mất file handle.
def _safe_unlink_log(lf):
    """Xóa file log an toàn. Nếu file đang được dùng bởi process khác (WinError 32),
    truncate nội dung thay vì xóa file."""
    try:
        lf.unlink()
    except PermissionError:
        # File đang được process khác mở → truncate nội dung (mode "w" auto-truncates)
        try:
            with open(lf, "w", encoding="utf-8") as f:
                pass
        except Exception:
            pass
    except Exception:
        pass

# WHY: Dùng psutil.process_iter thay vì netstat (cross-platform, không parse text).
# WHITELIST approach: chỉ kill process liên quan Node.js (tránh kill system services).
def kill_process_on_port(port):
    """
    Dùng psutil tìm và kill process đang chiếm port.
    An toàn hơn netstat parse vì:
    - Chỉ kill process có tên liên quan (node.exe, npm.exe, cmd.exe, next.exe, python.exe)
    - Kiểm tra PID có tồn tại trước khi kill
    - Tránh kill nhầm system process
    
    WHY: Windows không support 'connections' attr trong process_iter →
    gọi .connections() riêng cho từng process (pattern giống api_port_scan).
    """
    try:
        for proc in psutil.process_iter(['pid', 'name']):
            try:
                for conn in proc.connections(kind='inet'):
                    if conn.laddr.port == port:
                        proc_name = proc.name().lower()
                        # WHITELIST: Chỉ kill các process liên quan đến dev servers
                        # WHY: Thêm python.exe để dọn Python dev server/script chiếm port.
                        allowed = ['node.exe', 'node', 'npm.exe', 'npm', 'cmd.exe', 'next.exe', 'next', 'python.exe', 'python']
                        if any(allowed_name in proc_name for allowed_name in allowed):
                            debug_log(f"Killing process on port {port}: PID={proc.pid}, name={proc.name()}")
                            proc.kill()
                        else:
                            debug_log(f"SKIP killing on port {port}: PID={proc.pid}, name={proc.name()} (not in whitelist)")
            except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                pass
    except Exception as e:
        debug_log(f"kill_process_on_port error: {e}")

# WHY: Tính tổng memory + CPU của parent + children (recursive) — Node.js thường spawn child processes.
# interval=None trong cpu_percent() để đọc giá trị tức thời, không chờ 0.1s.
def get_process_memory_and_cpu(pid):
    """Lấy thông tin memory và CPU của process bằng psutil"""
    try:
        parent = psutil.Process(pid)
        mem = parent.memory_info().rss
        cpu = parent.cpu_percent(interval=None)
        try:
            for child in parent.children(recursive=True):
                try:
                    mem += child.memory_info().rss
                    cpu += child.cpu_percent(interval=None)
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    pass
        except Exception:
            pass
        return mem, cpu
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        return 0, 0

@app.route("/api/projects/<name>/diagnostics")
# WHY: Heavy endpoint — gọi git, node, npm, psutil sync. Có thể mất ~2s.
# Frontend gọi mỗi 2s khi project đang expanded — không gây DDoS vì localhost.
# Record perf history mỗi lần gọi để vẽ chart.
def api_project_diagnostics(name):
    proj = get_project(name)
    if not proj:
        return jsonify({"error": "Không tìm thấy"}), 404
        
    running = is_running(name)
    pid = None
    mem_bytes = 0
    cpu_percent = 0.0
    
    if running:
        with lock:
            p = processes.get(name)
            if p:
                pid = p.pid
                mem_bytes, cpu_percent = get_process_memory_and_cpu(pid)
                
    # Git Info
    git_info = None
    proj_path = Path(proj["path"])
    if (proj_path / ".git").exists():
        try:
            branch_res = subprocess.run(
                ["git", "rev-parse", "--abbrev-ref", "HEAD"],
                cwd=proj["path"],
                capture_output=True,
                text=True,
                shell=True,
                timeout=2,
                startupinfo=get_startupinfo(),
                creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
            )
            branch = branch_res.stdout.strip() if branch_res.returncode == 0 else "unknown"
            
            status_res = subprocess.run(
                ["git", "status", "--porcelain"],
                cwd=proj["path"],
                capture_output=True,
                text=True,
                shell=True,
                timeout=2,
                startupinfo=get_startupinfo(),
                creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
            )
            dirty_lines = [l for l in status_res.stdout.split("\n") if l.strip()]
            dirty_count = len(dirty_lines)
            git_info = {
                "branch": branch,
                "is_dirty": dirty_count > 0,
                "dirty_count": dirty_count
            }
        except Exception:
            pass
            
    # Node and NPM version checks
    node_version = "unknown"
    npm_version = "unknown"
    try:
        node_res = subprocess.run(
            ["node", "-v"],
            capture_output=True,
            text=True,
            shell=True,
            timeout=2,
            startupinfo=get_startupinfo(),
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
        )
        if node_res.returncode == 0:
            node_version = node_res.stdout.strip()
    except Exception:
        pass
        
    try:
        npm_res = subprocess.run(
            ["npm", "-v"],
            capture_output=True,
            text=True,
            shell=True,
            timeout=2,
            startupinfo=get_startupinfo(),
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
        )
        if npm_res.returncode == 0:
            npm_version = npm_res.stdout.strip()
    except Exception:
        pass
        
    # Record performance history
    if running and pid:
        record_perf_snapshot(name, mem_bytes, cpu_percent)
    
    # Uptime
    uptime_seconds = get_process_uptime(name) if running else 0
    
    return jsonify({
        "name": name,
        "running": running,
        "pid": pid,
        "memory": mem_bytes,
        "cpu": round(cpu_percent, 1),
        "uptime_seconds": uptime_seconds,
        "uptime": format_uptime(uptime_seconds) if running else "Không hoạt động",
        "git": git_info,
        "env": {
            "node": node_version,
            "npm": npm_version
        }
    })

@app.route("/api/projects/<name>/env", methods=["GET", "PUT"])
# WHY: Ưu tiên .env.local > .env (local override). PUT validate fileName tránh path traversal
# (chỉ cho phép fileName bắt đầu bằng ".env"). Đọc/ghi file sync — đơn giản, không cần async.
def api_project_env(name):
    proj = get_project(name)
    if not proj:
        return jsonify({"error": "Không tìm thấy"}), 404
        
    proj_path = Path(proj["path"])
    env_local_path = proj_path / ".env.local"
    env_path = proj_path / ".env"
    
    if request.method == "GET":
        target_path = env_local_path if env_local_path.exists() else env_path
        file_name = target_path.name if target_path.exists() else ".env.local"
        content = ""
        if target_path.exists():
            try:
                with open(target_path, "r", encoding="utf-8", errors="replace") as f:
                    content = f.read()
            except Exception as e:
                return jsonify({"error": f"Không thể đọc file env: {str(e)}"}), 500
        return jsonify({"fileName": file_name, "content": content})
        
    elif request.method == "PUT":
        data = request.get_json() or {}
        file_name = data.get("fileName", ".env.local")
        content = data.get("content", "")
        
        # Prevent traversal
        if "/" in file_name or "\\" in file_name or not file_name.startswith(".env"):
            return jsonify({"error": "Tên file env không hợp lệ"}), 400
            
        target_path = proj_path / file_name
        try:
            with open(target_path, "w", encoding="utf-8") as f:
                f.write(content)
            return jsonify({"status": "saved", "fileName": file_name})
        except Exception as e:
            return jsonify({"error": f"Không thể ghi file env: {str(e)}"}), 500

@app.route("/api/projects/<name>/clean", methods=["POST"])
# WHY: 3 levels — basic (cache), deep (build), nuke (node_modules + reinstall).
# safe_delete() kiểm tra path resolve để tránh path traversal (rmtree /).
# Nuke chạy npm install background, assign process vào processes để frontend theo dõi.
def api_project_clean(name):
    proj = get_project(name)
    if not proj:
        return jsonify({"error": "Không tìm thấy"}), 404
        
    data = request.get_json() or {}
    clean_type = data.get("type", "basic") # "basic", "deep", "nuke"
    
    # If deep or nuke and project is running, stop it first
    if clean_type in ["deep", "nuke"] and is_running(name):
        with lock:
            p = processes.get(name)
            if p:
                p.terminate()
                try:
                    p.wait(timeout=3)
                except Exception:
                    p.kill()
                processes.pop(name, None)
        # WHY: Dùng psutil để kill process an toàn trên port
        kill_process_on_port(proj["port"])
            
    proj_path = Path(proj["path"])
    removed = []
    errors = []
    
    def safe_delete(p_name):
        target = (proj_path / p_name).resolve()
        if str(target).startswith(str(proj_path.resolve())):
            if target.exists():
                try:
                    if target.is_dir():
                        import shutil
                        shutil.rmtree(target)
                        removed.append(p_name)
                    elif target.is_file():
                        target.unlink()
                        removed.append(p_name)
                except Exception as e:
                    errors.append(f"{p_name}: {str(e)}")
                    
    if clean_type == "basic":
        # Clear next cache & ts build info & webpack/babel caches
        safe_delete(".next/cache")
        safe_delete("tsconfig.tsbuildinfo")
        safe_delete(".cache")
        safe_delete("node_modules/.cache")
        
    elif clean_type == "deep":
        # Clear entire build folder
        safe_delete(".next")
        safe_delete(".turbo")
        safe_delete("tsconfig.tsbuildinfo")
        safe_delete("dist")
        safe_delete("out")
        
    elif clean_type == "nuke":
        # Clear builds & package dependencies entirely
        safe_delete(".next")
        safe_delete(".turbo")
        safe_delete("node_modules")
        safe_delete("package-lock.json")
        safe_delete("yarn.lock")
        safe_delete("pnpm-lock.yaml")
        
        # Trigger background npm install and write output to project logs
        lf = get_log_file(proj)
        if lf.exists():
            try:
                lf.unlink()
            except Exception:
                pass
        log_files[name] = str(lf)
        log_data[name] = []
        log_positions[name] = 0
        
        try:
            p = subprocess.Popen(
                ["npm", "install"],
                cwd=proj["path"],
                stdout=open(lf, "w", encoding="utf-8"),
                stderr=subprocess.STDOUT,
                shell=True,
                startupinfo=get_startupinfo(),
                creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
            )
            with lock:
                processes[name] = p
            return jsonify({
                "removed": removed,
                "errors": errors,
                "status": "nuked_reinstalling",
                "message": "Nuked folders and triggered npm install"
            })
        except Exception as e:
            errors.append(f"npm install spawn failed: {str(e)}")
            
    return jsonify({"removed": removed, "errors": errors, "status": "completed"})

@app.route("/api/system/port-scan", methods=["POST"])
# WHY: POST vì có thể scan nhiều project ports 1 lần.
# Windows không support connections attr trong process_iter → gọi .connections() riêng từng process.
def api_port_scan():
    """Quét các port để phát hiện conflict.
    Dùng psutil.Process(pid).connections() thay vì process_iter(attrs=['connections'])
    vì Windows không hỗ trợ attr 'connections' trong process_iter."""
    data = request.get_json() or {}
    ports = data.get("ports", [])
    results = {}
    port_set = set(ports)
    try:
        for proc in psutil.process_iter(['pid', 'name']):
            try:
                # WHY: connections() riêng cho từng process do Windows limit
                for conn in proc.connections(kind='inet'):
                    if conn.laddr.port in port_set:
                        p = conn.laddr.port
                        if p not in results:
                            results[p] = []
                        results[p].append({
                            "pid": proc.pid,
                            "name": proc.name(),
                            "status": conn.status,
                        })
            except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                pass
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    return jsonify({"ports": results})

@app.route("/api/system/open-explorer", methods=["POST"])
# WHY: POST vì có side effect (mở explorer). Dùng subprocess.run(["explorer", path], shell=True).
def api_open_explorer():
    """Mở Windows Explorer tại đường dẫn"""
    data = request.get_json() or {}
    path = data.get("path")
    if not path:
        return jsonify({"error": "Yêu cầu đường dẫn"}), 400
    try:
        subprocess.run(["explorer", path], shell=True)
        return jsonify({"status": "opened", "path": path})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/projects/<name>/scripts")
# WHY: Đọc package.json → trả về scripts object. Frontend dùng để hiển thị quick actions.
# Không validate JSON — file corrupt thì trả về error.
def api_project_scripts(name):
    """Đọc scripts từ package.json của project"""
    proj = get_project(name)
    if not proj:
        return jsonify({"error": "Không tìm thấy"}), 404
    try:
        pkg_path = Path(proj["path"]) / "package.json"
        if not pkg_path.exists():
            return jsonify({"scripts": {}})
        with open(pkg_path, "r", encoding="utf-8") as f:
            pkg = json.load(f)
        return jsonify({"scripts": pkg.get("scripts", {})})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/projects/<name>/run-script", methods=["POST"])
# WHY: Dùng script_processes riêng (KHÔNG ảnh hưởng main server process).
# Kill script cũ nếu còn + log file riêng (ghi đè log file cũ).
def api_project_run_script(name):
    """Chạy một npm script cụ thể.
    KHÔNG kill main server process. Log được ghi vào file riêng."""
    proj = get_project(name)
    if not proj:
        return jsonify({"error": "Không tìm thấy"}), 404
    data = request.get_json() or {}
    script = data.get("script", "")
    if not script:
        return jsonify({"error": "Yêu cầu tên script"}), 400
    try:
        # Log file riêng cho script (không ảnh hưởng main server log)
        lf = get_log_file(proj)
        if lf.exists():
            lf.unlink()
        log_files[name] = str(lf)
        log_data[name] = []
        log_positions[name] = 0
        
        p = subprocess.Popen(
            f"npm run {script}",
            cwd=proj["path"],
            stdout=open(lf, "w", encoding="utf-8"),
            stderr=subprocess.STDOUT,
            shell=True,
            startupinfo=get_startupinfo(),
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
        )
        
        # WHY: Dùng script_processes riêng, KHÔNG chạm vào processes (main server)
        with lock:
            # Kill script cũ nếu còn (không ảnh hưởng main server)
            old_script = script_processes.get(name)
            if old_script and old_script.poll() is None:
                old_script.terminate()
            script_processes[name] = p
        
        return jsonify({"status": "started", "script": script, "note": "Main server process unchanged"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# Disk usage cache: tránh rglob trên node_modules mỗi request
# Format: {project_name: {sizes: {...}, cached_at: timestamp}}
_disk_usage_cache = {}
_disk_usage_cache_lock = threading.Lock()
DISK_CACHE_TTL = 60  # Cache trong 60 giây

# WHY: os.walk nhanh hơn Path.rglob (C implementation vs Python iterator).
# Không follow symlinks để tránh infinite loop.
def get_folder_size_mb(path):
    """Tính dung lượng folder (MB) nhanh hơn rglob bằng os.walk"""
    total = 0
    try:
        for dirpath, dirnames, filenames in os.walk(path):
            for f in filenames:
                try:
                    fp = os.path.join(dirpath, f)
                    if os.path.isfile(fp):
                        total += os.path.getsize(fp)
                except (OSError, PermissionError):
                    pass
        return round(total / (1024 * 1024), 1)
    except Exception:
        return 0

@app.route("/api/projects/<name>/disk-usage")
# WHY: Cache 60s — tránh tính disk usage mỗi 2s (polling frontend).
# Chỉ tính node_modules, .next, dist, out, .turbo (các folder lớn, không bao gồm source).
def api_project_disk_usage(name):
    """Lấy dung lượng các thư mục trong project (có cache 60s)"""
    proj = get_project(name)
    if not proj:
        return jsonify({"error": "Không tìm thấy"}), 404
    
    # Kiểm tra cache
    with _disk_usage_cache_lock:
        cached = _disk_usage_cache.get(name)
        if cached and (time.time() - cached["cached_at"]) < DISK_CACHE_TTL:
            return jsonify({"sizes": cached["sizes"], "cached": True})
    
    proj_path = Path(proj["path"])
    sizes = {}
    try:
        for folder in ["node_modules", ".next", "dist", "out", ".turbo"]:
            target = proj_path / folder
            if target.exists():
                sizes[folder] = get_folder_size_mb(str(target))
    except Exception:
        pass
    
    # Lưu cache
    with _disk_usage_cache_lock:
        _disk_usage_cache[name] = {"sizes": sizes, "cached_at": time.time()}
    
    return jsonify({"sizes": sizes, "cached": False})

@app.route("/api/config/reload", methods=["POST"])
# WHY: Đọc lại config từ disk — không restart backend. Dùng khi user sửa config file thủ công.
# global config được replace atomic (Python reference assignment).
def api_reload_config():
    global config
    config = load_config()
    return jsonify({"status": "reloaded", "count": len(config["projects"])})

# ─── Performance History ────────────────────────────────────────
# Lưu memory/cpu usage history của từng project
# Format: {project_name: [{timestamp, memory, cpu}, ...]}
PERF_HISTORY_FILE = str(CONFIG_DIR / "perf_history.json")
PERF_HISTORY_MAX = 60  # Giữ tối đa 60 entries/project (~2 phút với polling 2s)
perf_lock = threading.Lock()

# WHY: Thread-safe (perf_lock). Return {} nếu file không tồn tại — không raise exception.
def load_perf_history():
    with perf_lock:
        try:
            if os.path.exists(PERF_HISTORY_FILE):
                with open(PERF_HISTORY_FILE, 'r') as f:
                    return json.load(f)
        except Exception:
            pass
    return {}

# WHY: Save perf history ra file JSON — mỗi snapshot ghi lại toàn bộ file (file nhỏ, < 1MB).
# Con: không scale cho nhiều projects. Pro: đơn giản, không cần database.
def save_perf_history(data):
    with perf_lock:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        with open(PERF_HISTORY_FILE, 'w') as f:
            json.dump(data, f, indent=2)

# WHY: Lock xuyên suốt read-modify-write để tránh race condition khi 2 diagnostics requests chạy đồng thời.
def record_perf_snapshot(name, memory, cpu):
    with perf_lock:
        try:
            if os.path.exists(PERF_HISTORY_FILE):
                with open(PERF_HISTORY_FILE, 'r') as f:
                    history = json.load(f)
            else:
                history = {}
        except Exception:
            history = {}
        if name not in history:
            history[name] = []
        history[name].append({
            "timestamp": datetime.now().isoformat(),
            "memory": memory,
            "cpu": cpu
        })
        history[name] = history[name][-PERF_HISTORY_MAX:]
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        with open(PERF_HISTORY_FILE, 'w') as f:
            json.dump(history, f, indent=2)

@app.route("/api/projects/<name>/perf-history")
# WHY: GET-only — trả về history của 1 project. Frontend vẽ chart từ data này.
# History tối đa 60 entries/project (~2 phút).
def api_perf_history(name):
    history = load_perf_history()
    return jsonify({"history": history.get(name, [])})

# ─── Quick SSL (mkcert) ──────────────────────────────────────────
@app.route("/api/projects/<name>/ssl", methods=["POST"])
# WHY: 1-click SSL cert với mkcert. Kiểm tra mkcert installed trước, hướng dẫn cài nếu chưa.
# Cert file được tạo trong project directory (localhost.pem + localhost-key.pem).
def api_project_ssl(name):
    """Tạo SSL cert 1 click cho project dùng mkcert"""
    proj = get_project(name)
    if not proj:
        return jsonify({"error": "Không tìm thấy"}), 404
    try:
        # Kiểm tra mkcert đã được cài chưa
        check = subprocess.run(["mkcert", "-version"], capture_output=True, shell=True,
                               startupinfo=get_startupinfo(),
                               creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0)
        if check.returncode != 0:
            return jsonify({
                "error": "mkcert chưa được cài đặt",
                "instructions": "Cài đặt: choco install mkcert hoặc scoop install mkcert hoặc download từ https://github.com/FiloSottile/mkcert"
            }), 400
        
        # Cài local CA nếu chưa
        subprocess.run(["mkcert", "-install"], capture_output=True, shell=True,
                       startupinfo=get_startupinfo(),
                       creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0)
        
        proj_path = Path(proj["path"])
        cert_name = "localhost"
        # Tạo cert
        result = subprocess.run(
            ["mkcert", "-cert-file", f"{cert_name}.pem", "-key-file", f"{cert_name}-key.pem", "localhost", "127.0.0.1"],
            cwd=proj_path, capture_output=True, text=True, shell=True,
            startupinfo=get_startupinfo(),
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
        )
        if result.returncode == 0:
            return jsonify({
                "status": "created",
                "cert": f"{cert_name}.pem",
                "key": f"{cert_name}-key.pem",
                "path": str(proj_path)
            })
        else:
            return jsonify({"error": result.stderr}), 500
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ═══════════════════════════════════════════════════════════════
# CLOUDFLARE TUNNEL — Expose localhost dev servers to internet
# Dùng cloudflared quick tunnel (trycloudflare.com)
# Bao gồm: auto-download, watchdog auto-restart, sleep detection
# ═══════════════════════════════════════════════════════════════

import urllib.request
import re

CLOUDFLARED_DIR = CONFIG_DIR / "cloudflared"
CLOUDFLARED_EXE = CLOUDFLARED_DIR / "cloudflared.exe"
CLOUDFLARED_DOWNLOAD_URL = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"

# Mỗi project có thể có 1 tunnel riêng
_tunnel_processes = {}      # {project_name: subprocess.Popen}
_tunnel_urls = {}           # {project_name: str (URL)}
_tunnel_status = {}         # {project_name: 'connecting' | 'active' | 'error' | 'stopped'}
_tunnel_errors = {}         # {project_name: str (error message)}
_tunnel_watchdog_enabled = {}  # {project_name: bool}
_tunnel_watchdog_threads = {}  # {project_name: Thread}
_tunnel_restart_counts = {}    # {project_name: int} - số lần watchdog đã restart
_tunnel_started_at = {}       # {project_name: float} - timestamp khi tunnel active (time.time())
_tunnel_request_counts = {}   # {project_name: int} - số request đã qua tunnel
_tunnel_request_history = {}  # {project_name: [{t: timestamp, c: count}, ...]} - lịch sử request rate
_tunnel_alert_thresholds = {}  # {project_name: float} - ngưỡng request rate (0 = tắt)
_tunnel_already_alerted = {}   # {project_name: float} - timestamp lần alert gần nhất (cooldown)
_tunnel_lock = threading.Lock()

# ─── Sleep/Resume Detection ────────────────────────────────────
_last_boot_time = psutil.boot_time()
_last_check_time = time.time()

# WHY: Daemon thread chạy nền, kiểm tra sleep/reboot mỗi 10s.
# Dùng gap > 25s để phát hiện sleep (tránh false positive từ network lag).
# reboot detection dùng psutil.boot_time() thay đổi.
def _sleep_detector():
    """Thread phát hiện máy tính thức dậy từ sleep/reboot.
    Khi phát hiện, tự động restart tất cả tunnels đang bật watchdog."""
    global _last_boot_time, _last_check_time
    while True:
        try:
            now = time.time()
            # Phát hiện sleep: nếu thời gian giữa 2 lần check > 25s
            # (bình thường check mỗi 10s, nếu > 25s là có sleep/treo)
            elapsed = now - _last_check_time
            if elapsed > 25:
                debug_log(f"[sleep-detector] Possible wake from sleep ({elapsed:.0f}s gap)")
                # Restart tất cả watched tunnels
                with _tunnel_lock:
                    watched = list(_tunnel_watchdog_enabled.keys())
                for proj_name in watched:
                    if _tunnel_watchdog_enabled.get(proj_name):
                        debug_log(f"[sleep-detector] Restarting tunnel for {proj_name} after sleep")
                        _auto_restart_tunnel(proj_name)
            
            # Phát hiện reboot: boot time thay đổi
            current_boot = psutil.boot_time()
            if current_boot != _last_boot_time:
                debug_log(f"[sleep-detector] System reboot detected!")
                _last_boot_time = current_boot
                with _tunnel_lock:
                    watched = list(_tunnel_watchdog_enabled.keys())
                for proj_name in watched:
                    if _tunnel_watchdog_enabled.get(proj_name):
                        debug_log(f"[sleep-detector] Restarting tunnel for {proj_name} after reboot")
                        _auto_restart_tunnel(proj_name)
            
            _last_check_time = time.time()
            time.sleep(10)
        except Exception as e:
            debug_log(f"[sleep-detector] Error: {e}")
            time.sleep(30)

# Start sleep detector thread
threading.Thread(target=_sleep_detector, daemon=True).start()

# ─── Request History Snapshots ──────────────────────────────────
# WHY: Ghi snapshot request count mỗi 10s để vẽ chart request rate.
# Giữ tối đa 30 snapshots (~5 phút). Mỗi snapshot: {t: timestamp, c: total_count}
_REQUEST_HISTORY_MAX = 30
_REQUEST_HISTORY_INTERVAL = 10

def _request_history_worker():
    """Thread ghi snapshot request count mỗi 10s cho tất cả tunnels đang active."""
    while True:
        try:
            time.sleep(_REQUEST_HISTORY_INTERVAL)
            with _tunnel_lock:
                # WHY: Chỉ snapshot tunnels đang active (có process alive)
                for name, proc in list(_tunnel_processes.items()):
                    if proc.poll() is None:  # Process still alive
                        current_count = _tunnel_request_counts.get(name, 0)
                        if name not in _tunnel_request_history:
                            _tunnel_request_history[name] = []
                        _tunnel_request_history[name].append({
                            't': time.time(),
                            'c': current_count,
                        })
                        # WHY: Giữ tối đa 30 snapshots (~5 phút)
                        if len(_tunnel_request_history[name]) > _REQUEST_HISTORY_MAX:
                            _tunnel_request_history[name] = _tunnel_request_history[name][-_REQUEST_HISTORY_MAX:]
        except Exception as e:
            debug_log(f"[request-history] Error: {e}")

threading.Thread(target=_request_history_worker, daemon=True).start()

# ─── Tunnel Alert System ────────────────────────────────────────
# WHY: Background thread kiểm tra request rate mỗi 30s cho tunnels có alert threshold.
# Khi request rate > ngưỡng, gửi Windows toast notification.
# Dùng cooldown 5 phút để tránh spam.

ALERT_CHECK_INTERVAL = 30    # Check mỗi 30s
ALERT_COOLDOWN = 300          # Cooldown 5 phút giữa các notification

def _show_windows_toast(title, message):
    """Gửi Windows toast notification bằng PowerShell.
    Sử dụng BurntToast module nếu có, fallback về Windows.UI.Notifications."""
    try:
        esc_title = title.replace("'", "''")
        esc_msg = message.replace("'", "''")
        ps_code = f'''
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$textNodes = $template.GetElementsByTagName("text")
$textNodes.Item(0).AppendChild($template.CreateTextNode('{esc_title}')) > $null
$textNodes.Item(1).AppendChild($template.CreateTextNode('{esc_msg}')) > $null
$toast = [Windows.UI.Notifications.ToastNotification]::new($template)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("MultiTool Pro").Show($toast)
'''
        subprocess.run(
            ["powershell", "-NoProfile", "-Command", ps_code],
            capture_output=True, timeout=5,
            startupinfo=get_startupinfo(),
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
        )
        return True
    except Exception as e:
        debug_log(f"[alert] Toast notification failed: {e}")
        return False

def _tunnel_alert_worker():
    """Background thread: check request rate mỗi 30s, gửi notification nếu vượt ngưỡng.
    Alert threshold = 0 có nghĩa là tắt alert cho project đó."""
    while True:
        try:
            time.sleep(ALERT_CHECK_INTERVAL)
            
            with _tunnel_lock:
                # WHY: Lấy danh sách projects có alert threshold > 0 và tunnel đang active
                for name, threshold in list(_tunnel_alert_thresholds.items()):
                    if threshold <= 0:
                        continue
                    
                    proc = _tunnel_processes.get(name)
                    if proc is None or proc.poll() is not None:
                        continue  # Tunnel không active
                    
                    started = _tunnel_started_at.get(name)
                    if not started:
                        continue
                    
                    uptime = int(time.time() - started)
                    count = _tunnel_request_counts.get(name, 0)
                    rate = round(count / uptime, 2) if uptime > 0 else 0
                    
                    # WHY: Kiểm tra rate vượt ngưỡng và cooldown
                    if rate > threshold:
                        last_alerted = _tunnel_already_alerted.get(name)
                        now = time.time()
                        if not last_alerted or (now - last_alerted) > ALERT_COOLDOWN:
                            # Gửi toast notification
                            _show_windows_toast(
                                f"🔔 Tunnel Alert: {name}",
                                f"Request rate {rate}/giây vượt ngưỡng {threshold}/giây"
                            )
                            _tunnel_already_alerted[name] = now
                            debug_log(f"[alert] {name}: rate={rate}/s > threshold={threshold}/s - toast sent")
                    else:
                        # WHY: Reset alerted flag khi rate trở về dưới ngưỡng
                        if name in _tunnel_already_alerted:
                            del _tunnel_already_alerted[name]
        except Exception as e:
            debug_log(f"[alert] Worker error: {e}")

threading.Thread(target=_tunnel_alert_worker, daemon=True).start()

# ─── Helper Functions ───────────────────────────────────────────

# WHY: Ưu tiên PATH (user tự cài cloudflared) trước, sau đó fallback về app data.
# Cho phép user dùng version cloudflared riêng nếu đã cài sẵn.
def _get_cloudflared_path():
    """Lấy đường dẫn cloudflared - ưu tiên PATH, fallback về app data"""
    system_path = shutil.which("cloudflared")
    if system_path:
        return system_path
    if CLOUDFLARED_EXE.exists():
        return str(CLOUDFLARED_EXE)
    return None

# WHY: Kiểm tra cloudflared có sẵn không — ưu tiên PATH, fallback app data.
# Verify file size > 1MB để phát hiện download corrupt (cloudflared.exe thực tế ~10-15MB).
def _is_cloudflared_installed():
    """Kiểm tra cloudflared có trong PATH hoặc app data không.
    WHY: Kiểm tra file size > 1MB để phát hiện download corrupt (bị gián đoạn giữa chừng).
    File .exe thường ~10-15MB, nếu < 1MB chắc chắn là corrupt."""
    path = _get_cloudflared_path()
    if path is None:
        return False
    # WHY: Nếu file tồn tại nhưng < 1MB → download bị gián đoạn → xóa và báo chưa cài
    # (cloudflared.exe thực tế ~10-15MB, threshold 1MB là an toàn)
    try:
        if Path(path).stat().st_size < 1_000_000:
            debug_log(f"cloudflared file too small ({Path(path).stat().st_size} bytes), likely corrupt. Removing...")
            try:
                Path(path).unlink()
            except Exception:
                pass
            return False
    except Exception:
        pass
    return True

# WHY: Tải silent từ GitHub releases — không cần user can thiệp.
# Chỉ tải 1 lần, các lần sau _is_cloudflared_installed() return True.
def _auto_install_cloudflared_if_needed():
    """Tự động tải cloudflared nếu chưa có. Trả về True nếu thành công."""
    if _is_cloudflared_installed():
        return True
    try:
        CLOUDFLARED_DIR.mkdir(parents=True, exist_ok=True)
        debug_log("Auto-installing cloudflared...")
        urllib.request.urlretrieve(CLOUDFLARED_DOWNLOAD_URL, str(CLOUDFLARED_EXE))
        if sys.platform != "win32":
            CLOUDFLARED_EXE.chmod(0o755)
        debug_log(f"cloudflared installed to {CLOUDFLARED_EXE}")
        return True
    except Exception as e:
        debug_log(f"Auto-install cloudflared failed: {e}")
        return False

# WHY: Cache version 60s — tránh spawn subprocess mỗi 4s (frontend poll) gây flash terminal window.
_cloudflared_version_cache = {'version': None, 'cached_at': 0}

def _get_cloudflared_version():
    """Lấy version cloudflared nếu có (cache 60s)"""
    now = time.time()
    if now - _cloudflared_version_cache['cached_at'] < 60:
        return _cloudflared_version_cache['version']
    try:
        cf_path = _get_cloudflared_path()
        if not cf_path:
            return None
        result = subprocess.run([cf_path, "--version"], capture_output=True, text=True, timeout=5,
                                startupinfo=get_startupinfo(),
                                creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0)
        if result.returncode == 0:
            _cloudflared_version_cache['version'] = result.stdout.strip()
            _cloudflared_version_cache['cached_at'] = now
            return _cloudflared_version_cache['version']
    except Exception:
        pass
    return None

# WHY: Auto-cleanup process đã chết (pop khi poll != None) để tránh zombie.
# Trả về watchdog_enabled + restart_count để UI hiển thị mà không cần API riêng.
def _get_tunnel_status(name):
    """Lấy trạng thái tunnel cho project"""
    with _tunnel_lock:
        proc = _tunnel_processes.get(name)
        # WHY: Tính uptime từ started_at timestamp
        started = _tunnel_started_at.get(name)
        uptime = int(time.time() - started) if started else 0
        if proc is None:
            return {
                "status": "stopped",
                "url": None,
                "error": _tunnel_errors.get(name),
                "watchdog_enabled": _tunnel_watchdog_enabled.get(name, False),
                "watchdog_restart_count": _tunnel_restart_counts.get(name, 0),
                "uptime_seconds": uptime if uptime > 0 else None,
                "request_count": _tunnel_request_counts.get(name, 0),
                "request_rate": None,
                "request_history": [],
                "alert_threshold": _tunnel_alert_thresholds.get(name, 0),
            }
        poll = proc.poll()
        if poll is not None:
            _tunnel_processes.pop(name, None)
            _tunnel_urls.pop(name, None)
            _tunnel_status.pop(name, None)
            _tunnel_started_at.pop(name, None)
            return {
                "status": "stopped",
                "url": None,
                "error": f"Process exited with code {poll}",
                "watchdog_enabled": _tunnel_watchdog_enabled.get(name, False),
                "watchdog_restart_count": _tunnel_restart_counts.get(name, 0),
                "uptime_seconds": None,
                "request_count": _tunnel_request_counts.get(name, 0),
                "request_rate": None,
                "request_history": [],
                "alert_threshold": _tunnel_alert_thresholds.get(name, 0),
            }
        # WHY: Tính rate từ history (diff giữa snapshot gần nhất với snapshot cách đây 60s)
        history = _tunnel_request_history.get(name, [])
        return {
            "status": _tunnel_status.get(name, "connecting"),
            "url": _tunnel_urls.get(name),
            "error": _tunnel_errors.get(name),
            "watchdog_enabled": _tunnel_watchdog_enabled.get(name, False),
            "watchdog_restart_count": _tunnel_restart_counts.get(name, 0),
            "uptime_seconds": uptime if uptime > 0 else None,
            "request_count": _tunnel_request_counts.get(name, 0),
            "request_rate": round(_tunnel_request_counts.get(name, 0) / uptime, 2) if uptime > 0 else 0,
            "request_history": history[-20:] if history else [],
            "alert_threshold": _tunnel_alert_thresholds.get(name, 0),
        }

# WHY: Dùng daemon reader thread để parse stderr (cloudflared log ra stderr, không phải stdout).
# Dùng regex để phát hiện URL trycloudflare.com ngay khi có.
# Trim log 200 chars để tránh DOS debug log.
def _launch_tunnel_process(project_name, port):
    """Shared helper: spawn cloudflared, start reader thread, update state.
    Returns (success_bool, status_dict_or_error_string)."""
    cf_path = _get_cloudflared_path()
    if not cf_path:
        return False, "cloudflared not found"
    
    try:
        proc = subprocess.Popen(
            [cf_path, "tunnel", "--url", f"http://localhost:{port}"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
            startupinfo=get_startupinfo(),
        )
        
        # WHY: Verify !!! — debug_log flag để kiểm tra process đã launch đúng cách
        debug_log(f"[tunnel] Launched cloudflared for {project_name} (PID={proc.pid}) with window hidden")
        
        with _tunnel_lock:
            _tunnel_processes[project_name] = proc
        
        def _reader(process, pname):
            try:
                for line in process.stderr:
                    debug_log(f"[tunnel-{pname}] {line.strip()[:200]}")
                    match = re.search(r'https://[a-zA-Z0-9_-]+\.trycloudflare\.com', line)
                    if match:
                        url = match.group(0)
                        with _tunnel_lock:
                            _tunnel_urls[pname] = url
                            _tunnel_status[pname] = "active"
                            _tunnel_started_at[pname] = time.time()
                        debug_log(f"Tunnel URL for {pname}: {url}")
                        # WHY: Không break — tiếp tục đọc để đếm request
                    # WHY: Đếm request từ log cloudflared (HTTP request/response lines)
                    if 'http' in line.lower() and ('request' in line.lower() or 'response' in line.lower()):
                        with _tunnel_lock:
                            _tunnel_request_counts[pname] = _tunnel_request_counts.get(pname, 0) + 1
                    if "error" in line.lower() or "failed" in line.lower():
                        with _tunnel_lock:
                            _tunnel_errors[pname] = line.strip()
                            _tunnel_status[pname] = "error"
                process.wait()
                with _tunnel_lock:
                    if _tunnel_processes.get(pname) == process:
                        _tunnel_processes.pop(pname, None)
                        _tunnel_started_at.pop(pname, None)
                        _tunnel_request_counts.pop(pname, None)
                        _tunnel_request_history.pop(pname, None)
                        if pname not in _tunnel_urls:
                            _tunnel_status[pname] = "stopped"
            except Exception as e:
                debug_log(f"[tunnel-{pname}] Reader error: {e}")
        
        threading.Thread(target=_reader, args=(proc, project_name), daemon=True).start()
        return True, None
    except Exception as e:
        debug_log(f"Launch tunnel error for {project_name}: {e}")
        with _tunnel_lock:
            _tunnel_processes.pop(project_name, None)
            _tunnel_errors[project_name] = str(e)
            _tunnel_status[project_name] = "error"
        return False, str(e)

# WHY: Shared stop helper — terminate + wait + kill (3-step graceful).
# Clear url/errors/threads nhưng KHÔNG clear restart_counts (giữ lifetime stats).
# Dùng pop() atomic cho _tunnel_processes để tránh race.
def _stop_tunnel_process(name):
    """Shared helper: stop tunnel process and clear state.
    WHY: Không clear _tunnel_restart_counts để giữ thống kê lifetime.
    WHY: Clear _tunnel_watchdog_threads để tránh zombie references."""
    with _tunnel_lock:
        proc = _tunnel_processes.pop(name, None)
        _tunnel_urls.pop(name, None)
        _tunnel_errors.pop(name, None)
        _tunnel_status[name] = "stopped"
        _tunnel_watchdog_threads.pop(name, None)  # Clean zombie thread ref
        # WHY: Không clear _tunnel_restart_counts — giữ lifetime stats
        _tunnel_started_at.pop(name, None)
        _tunnel_request_counts.pop(name, None)
        _tunnel_request_history.pop(name, None)
    
    if proc:
        try:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
        except Exception as e:
            debug_log(f"Stop tunnel error for {name}: {e}")
            return False
        debug_log(f"Tunnel stopped for {name}")
    return True

# WHY: Watchdog restart — dùng get() trước, không pop() ngay,
# tránh race condition với manual start từ UI.
# Sleep 2s trước launch để chờ process cleanup hoàn tất.
def _auto_restart_tunnel(project_name):
    """Watchdog: dừng tunnel cũ + launch tunnel mới"""
    proj = get_project(project_name)
    if not proj or not is_running(project_name) or not _is_cloudflared_installed():
        debug_log(f"[watchdog] Cannot restart {project_name}: preconditions not met")
        return False
    
    port = proj["port"]
    debug_log(f"[watchdog] Auto-restarting tunnel for {project_name}...")
    
    # Clean old state
    with _tunnel_lock:
        # WHY: Dùng get() trước, không pop() ngay — tránh race condition với manual start.
        # Nếu process vẫn đang chạy (alive), tức là user vừa start thủ công → không pop.
        old_proc = _tunnel_processes.get(project_name)
        if old_proc is not None and old_proc.poll() is None:
            # WHY: Tunnel vừa được start bởi ai đó (user manual / API), không restart!
            debug_log(f"[watchdog] Tunnel {project_name} was just started by another request, skipping restart")
            return True
        if old_proc is None:
            # WHY: Không có process cũ → chỉ cần launch mới
            pass
        else:
            _tunnel_processes.pop(project_name, None)
        _tunnel_urls.pop(project_name, None)
        _tunnel_errors.pop(project_name, None)
        _tunnel_started_at.pop(project_name, None)
        _tunnel_request_counts.pop(project_name, None)
        _tunnel_request_history.pop(project_name, None)
        _tunnel_status[project_name] = "connecting"
    
    if old_proc:
        try:
            old_proc.terminate()
            old_proc.wait(timeout=3)
        except:
            try:
                old_proc.kill()
            except:
                pass
    
    time.sleep(2)
    
    success, err = _launch_tunnel_process(project_name, port)
    if success:
        with _tunnel_lock:
            _tunnel_restart_counts[project_name] = _tunnel_restart_counts.get(project_name, 0) + 1
        debug_log(f"[watchdog] Tunnel auto-restarted for {project_name} (#{_tunnel_restart_counts.get(project_name)})")
    else:
        debug_log(f"[watchdog] Auto-restart failed for {project_name}: {err}")
    return success

# WHY: Check mỗi 15s — đủ nhanh để phát hiện die, đủ chậm để không spam restart.
# Chỉ restart khi status không phải 'stopped' (tránh restart tunnel đã bị tắt chủ đích).
def _tunnel_watchdog_worker(project_name):
    """Watchdog thread - kiểm tra tunnel mỗi 15s, auto-restart nếu chết"""
    while True:
        with _tunnel_lock:
            if not _tunnel_watchdog_enabled.get(project_name, False):
                break
            proc = _tunnel_processes.get(project_name)
            is_alive = proc is not None and proc.poll() is None
            current_status = _tunnel_status.get(project_name)
        
        if not is_alive and current_status not in ("stopped", None):
            debug_log(f"[watchdog] Tunnel {project_name} died (status={current_status}), auto-restarting...")
            _auto_restart_tunnel(project_name)
        
        time.sleep(15)

# ─── Cleanup Handler ──────────────────────────────────────────
# WHY: Khi app tắt, cloudflared processes vẫn sống (orphan).
# Dùng atexit để kill tất cả tunnels khi Python backend shutdown.
import atexit

def _cleanup_all_tunnels():
    """Kill tất cả tunnel processes khi app tắt. Tránh orphan cloudflared.exe."""
    with _tunnel_lock:
        names = list(_tunnel_processes.keys())
    for name in names:
        debug_log(f"[cleanup] Killing tunnel for {name}...")
        _stop_tunnel_process(name)
    debug_log(f"[cleanup] All tunnels cleaned up ({len(names)} processes)")

atexit.register(_cleanup_all_tunnels)

# ─── API Auto-download cloudflared ────────────────────────────

# WHY: Single endpoint cho frontend check — trả về installed, version, path 1 lần.
# Dùng _is_cloudflared_installed() (có verify file size) thay vì only PATH check.
@app.route("/api/cloudflared/check")
def api_cloudflared_check():
    """Kiểm tra cloudflared có được cài đặt không"""
    installed = _is_cloudflared_installed()
    version = _get_cloudflared_version() if installed else None
    return jsonify({
        "installed": installed,
        "version": version,
        "path": _get_cloudflared_path(),
    })

# WHY: Download về %APPDATA%/multitool-pro/cloudflared/ — không cần admin.
# Progress tracking log mỗi 25% để user thấy tiến trình.
# Xác thực file tồn tại sau download (tránh 0-byte file).
@app.route("/api/cloudflared/install", methods=["POST"])
def api_cloudflared_install():
    """Tự động tải cloudflared từ GitHub về thư mục app data"""
    try:
        debug_log("Downloading cloudflared from GitHub...")
        CLOUDFLARED_DIR.mkdir(parents=True, exist_ok=True)
        
        # Tải về với progress tracking
        def _report_progress(block_num, block_size, total_size):
            if total_size > 0:
                downloaded = block_num * block_size
                percent = min(100, int(downloaded * 100 / total_size))
                if percent % 25 == 0:  # Log mỗi 25%
                    debug_log(f"Downloading cloudflared... {percent}%")
        
        urllib.request.urlretrieve(
            CLOUDFLARED_DOWNLOAD_URL,
            str(CLOUDFLARED_EXE),
            reporthook=_report_progress
        )
        
        if sys.platform != "win32":
            CLOUDFLARED_EXE.chmod(0o755)
        
        # Verify
        if not CLOUDFLARED_EXE.exists():
            raise Exception("Download failed: file not found after download")
        
        file_size = CLOUDFLARED_EXE.stat().st_size
        debug_log(f"cloudflared downloaded successfully ({file_size} bytes)")
        # WHY: Invalidate version cache để UI cập nhật ngay, không phải chờ 60s
        _cloudflared_version_cache['cached_at'] = 0
        
        return jsonify({
            "status": "installed",
            "path": str(CLOUDFLARED_EXE),
            "size": file_size,
        })
    except Exception as e:
        debug_log(f"cloudflared download error: {e}")
        return jsonify({"error": str(e)}), 500

# ─── API Tunnel Status ──────────────────────────────────────────

# WHY: GET-only endpoint. Thêm cloudflared_installed vào response để frontend
# biết có cần hiển thị nút "Cài & Mở tunnel" hay không.
@app.route("/api/projects/<name>/tunnel")
def api_project_tunnel_status(name):
    """Lấy trạng thái tunnel của project"""
    proj = get_project(name)
    if not proj:
        return jsonify({"error": "Không tìm thấy"}), 404
    
    status = _get_tunnel_status(name)
    status["project"] = name
    status["port"] = proj["port"]
    status["cloudflared_installed"] = _is_cloudflared_installed()
    return jsonify(status)

# ─── API Tunnel Start ───────────────────────────────────────────

# WHY: Reset state (url, status, errors) trước launch để tránh hiển thị state cũ.
# Auto-install cloudflared nếu chưa có — seamless user experience.
@app.route("/api/projects/<name>/tunnel/start", methods=["POST"])
def api_project_tunnel_start(name):
    """Bắt đầu Cloudflare Tunnel cho project"""
    proj = get_project(name)
    if not proj:
        return jsonify({"error": "Không tìm thấy"}), 404
    
    # Auto-install nếu chưa có
    if not _auto_install_cloudflared_if_needed():
        return jsonify({"error": "Không thể tải cloudflared. Kiểm tra kết nối internet."}), 500
    
    if not is_running(name):
        return jsonify({"error": "Project chưa được khởi động. Hãy start project trước."}), 400
    
    with _tunnel_lock:
        existing = _tunnel_processes.get(name)
        if existing and existing.poll() is None:
            return jsonify({"error": "Tunnel đã đang chạy"}), 409
        _tunnel_urls.pop(name, None)
        _tunnel_status[name] = "connecting"
        _tunnel_errors.pop(name, None)
    
    port = proj["port"]
    debug_log(f"Starting Cloudflare Tunnel for {name} on port {port}...")
    
    success, err = _launch_tunnel_process(name, port)
    if not success:
        return jsonify({"error": err}), 500
    
    status = _get_tunnel_status(name)
    status["project"] = name
    status["port"] = port
    status["cloudflared_installed"] = _is_cloudflared_installed()
    return jsonify(status)

# ─── API Tunnel Stop ────────────────────────────────────────────

# WHY: Delegate to _stop_tunnel_process (shared helper) để đảm bảo
# consistent cleanup: terminate + wait + kill nếu timeout.
@app.route("/api/projects/<name>/tunnel/stop", methods=["POST"])
def api_project_tunnel_stop(name):
    """Dừng Cloudflare Tunnel"""
    proj = get_project(name)
    if not proj:
        return jsonify({"error": "Không tìm thấy"}), 404
    
    if not _stop_tunnel_process(name):
        return jsonify({"error": "Failed to stop tunnel"}), 500
    
    return jsonify({"status": "stopped", "project": name})

# ─── API Tunnel Watchdog ────────────────────────────────────────

# WHY: GET để đọc trạng thái, POST để thay đổi — cùng endpoint cho đơn giản.
# Khi bật watchdog: nếu tunnel đang chết (không phải stopped), restart ngay lập tức.
# Khi tắt watchdog: worker thread tự động break sau lần check tiếp theo.
@app.route("/api/projects/<name>/tunnel/watchdog", methods=["GET", "POST"])
def api_tunnel_watchdog(name):
    """Bật/tắt watchdog cho tunnel. Khi bật, tunnel sẽ tự restart nếu bị chết."""
    proj = get_project(name)
    if not proj:
        return jsonify({"error": "Không tìm thấy"}), 404
    
    if request.method == "POST":
        data = request.get_json() or {}
        enabled = data.get("enabled", False)
        
        with _tunnel_lock:
            _tunnel_watchdog_enabled[name] = enabled
        
        if enabled:
            # Start watchdog thread nếu chưa chạy
            if name not in _tunnel_watchdog_threads or not _tunnel_watchdog_threads[name].is_alive():
                t = threading.Thread(target=_tunnel_watchdog_worker, args=(name,), daemon=True)
                _tunnel_watchdog_threads[name] = t
                t.start()
                debug_log(f"[watchdog] Started for {name}")
            
            # Nếu tunnel đang chết, restart ngay
            with _tunnel_lock:
                proc = _tunnel_processes.get(name)
                is_alive = proc is not None and proc.poll() is None
                cur_status = _tunnel_status.get(name)
            if not is_alive and cur_status not in ("stopped", None):
                debug_log(f"[watchdog] Tunnel {name} is dead, restarting immediately...")
                _auto_restart_tunnel(name)
        else:
            debug_log(f"[watchdog] Disabled for {name}")
        
        return jsonify({"watchdog_enabled": enabled})
    
    return jsonify({"watchdog_enabled": _tunnel_watchdog_enabled.get(name, False)})

# ─── API Auto-Install & Start ───────────────────────────────────

# WHY: Atomic 3-step operation — nếu step 2 fail, step 3 (watchdog) không chạy.
# Tránh race condition bằng 1 API thay vì 3 API riêng lẻ từ frontend.
@app.route("/api/projects/<name>/tunnel/install-and-start", methods=["POST"])
def api_tunnel_install_and_start(name):
    """1-click: Tải cloudflared + start tunnel + bật watchdog"""
    proj = get_project(name)
    if not proj:
        return jsonify({"error": "Không tìm thấy"}), 404
    
    # Step 1: Auto-install cloudflared
    if not _auto_install_cloudflared_if_needed():
        return jsonify({"error": "Không thể tải cloudflared. Kiểm tra kết nối internet."}), 500
    
    # Step 2: Start tunnel
    if not is_running(name):
        return jsonify({"error": "Project chưa được khởi động"}), 400
    
    with _tunnel_lock:
        existing = _tunnel_processes.get(name)
        if existing and existing.poll() is None:
            return jsonify({"error": "Tunnel đã đang chạy"}), 409
        _tunnel_urls.pop(name, None)
        _tunnel_status[name] = "connecting"
        _tunnel_errors.pop(name, None)
    
    port = proj["port"]
    success, err = _launch_tunnel_process(name, port)
    if not success:
        return jsonify({"error": err}), 500
    
    # Step 3: Bật watchdog
    with _tunnel_lock:
        _tunnel_watchdog_enabled[name] = True
    
    if name not in _tunnel_watchdog_threads or not _tunnel_watchdog_threads[name].is_alive():
        t = threading.Thread(target=_tunnel_watchdog_worker, args=(name,), daemon=True)
        _tunnel_watchdog_threads[name] = t
        t.start()
    
    debug_log(f"1-click tunnel setup complete for {name}")
    
    status = _get_tunnel_status(name)
    status["project"] = name
    status["port"] = port
    status["cloudflared_installed"] = True
    return jsonify(status)

# ─── Alert Settings ────────────────────────────────────────────
@app.route("/api/projects/<name>/tunnel/alert", methods=["GET", "POST"])
# WHY: GET = đọc threshold hiện tại. POST = set threshold (0 = tắt).
# Dùng _tunnel_lock để thread-safe với alert checker.
def api_tunnel_alert(name):
    """Đọc/cài đặt ngưỡng alert request rate cho tunnel.
    Khi request rate vượt quá threshold, gửi Windows toast notification.
    threshold = 0 (hoặc không set) = tắt alert."""
    proj = get_project(name)
    if not proj:
        return jsonify({"error": "Không tìm thấy"}), 404
    
    if request.method == "POST":
        data = request.get_json() or {}
        threshold = float(data.get("threshold", 0))
        with _tunnel_lock:
            if threshold > 0:
                _tunnel_alert_thresholds[name] = threshold
                _tunnel_already_alerted.pop(name, None)
            else:
                _tunnel_alert_thresholds.pop(name, None)
                _tunnel_already_alerted.pop(name, None)
        debug_log(f"[alert] {name} threshold set to {threshold}")
        return jsonify({"name": name, "threshold": threshold, "status": "updated"})
    
    with _tunnel_lock:
        threshold = _tunnel_alert_thresholds.get(name, 0)
    return jsonify({"name": name, "threshold": threshold})

# ─── Tunnel Changes Detection ────────────────────────────────────

@app.route("/api/tunnels/changes")
def api_tunnels_changes():
    """Lightweight endpoint — trả về version + project count.
    Tunnel Dashboard poll endpoint này mỗi 2s thay vì fetch full data mỗi 4s.
    Chỉ khi version thay đổi, Dashboard mới gọi fetchAll() để lấy data mới."""
    return jsonify({
        "version": _project_config_version,
        "project_count": len(config["projects"]),
        "active_tunnels": sum(1 for s in _tunnel_status.values() if s == "active"),
    })

# ─── Hourly Metrics History ────────────────────────────────────
# WHY: Lưu snapshot metrics mỗi giờ vào file JSON persistent.
# Cho phép xem lịch sử request rate theo ngày/tuần/tháng.
# Format: {project_name: [{t: timestamp, c: count, r: rate, s: status}, ...]}
HOURLY_METRICS_FILE = str(CONFIG_DIR / "tunnel_hourly_metrics.json")
_hourly_metrics_lock = threading.Lock()
HOURLY_METRICS_MAX_DAYS = 30  # Giữ tối đa 30 ngày

# WHY: Load/save persistent metrics file (thread-safe).
# File nhỏ (< 1MB) nên ghi toàn bộ mỗi lần.
def _load_hourly_metrics():
    with _hourly_metrics_lock:
        try:
            if os.path.exists(HOURLY_METRICS_FILE):
                with open(HOURLY_METRICS_FILE, 'r') as f:
                    return json.load(f)
        except Exception:
            pass
    return {}

def _save_hourly_metrics(data):
    with _hourly_metrics_lock:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        with open(HOURLY_METRICS_FILE, 'w') as f:
            json.dump(data, f, indent=2)

def _hourly_metrics_worker():
    """Background thread: snapshot metrics mỗi giờ.
    Chỉ snapshot tunnels đang active (có URL).
    Xóa dữ liệu cũ hơn 30 ngày mỗi lần ghi."""
    while True:
        try:
            time.sleep(3600)  # 1 giờ
            now = time.time()
            cutoff = now - (HOURLY_METRICS_MAX_DAYS * 86400)
            
            with _tunnel_lock:
                active_names = [
                    name for name, proc in _tunnel_processes.items()
                    if proc.poll() is None and _tunnel_urls.get(name)
                ]
                snapshot = {}
                for name in active_names:
                    started = _tunnel_started_at.get(name)
                    uptime = int(now - started) if started else 0
                    count = _tunnel_request_counts.get(name, 0)
                    rate = round(count / uptime, 2) if uptime > 0 else 0
                    snapshot[name] = {
                        't': now,
                        'c': count,
                        'r': rate,
                        's': _tunnel_status.get(name, 'active'),
                    }
            
            if not snapshot:
                continue
            
            # WHY: Merge snapshot vào file, xóa data cũ hơn 30 ngày
            existing = _load_hourly_metrics()
            for name, entry in snapshot.items():
                if name not in existing:
                    existing[name] = []
                existing[name].append(entry)
                # WHY: Xóa entries cũ hơn 30 ngày
                existing[name] = [
                    e for e in existing[name]
                    if e['t'] > cutoff
                ]
            
            _save_hourly_metrics(existing)
            debug_log(f"[hourly-metrics] Saved {len(snapshot)} tunnel snapshots")
        except Exception as e:
            debug_log(f"[hourly-metrics] Error: {e}")

threading.Thread(target=_hourly_metrics_worker, daemon=True).start()

@app.route("/api/tunnels/history")
def api_tunnels_history():
    """GET /api/tunnels/history?project=NAME&range=24h|7d|30d
    Trả về lịch sử request rate của tunnel.
    
    Query params:
        project: Tên project (required)
        range: 24h (default) | 7d | 30d
    """
    project = request.args.get('project', '')
    range_str = request.args.get('range', '24h')
    
    if not project:
        return jsonify({'error': 'Missing project name', 'history': []})
    
    # WHY: Tính cutoff timestamp dựa trên range
    now = time.time()
    if range_str == '7d':
        cutoff = now - (7 * 86400)
    elif range_str == '30d':
        cutoff = now - (30 * 86400)
    else:
        cutoff = now - 86400  # 24h
    
    existing = _load_hourly_metrics()
    raw = existing.get(project, [])
    
    # WHY: Filter theo cutoff và trả về dạng [{timestamp, request_count, request_rate, status}]
    filtered = [
        {
            'timestamp': e['t'],
            'request_count': e['c'],
            'request_rate': e['r'],
            'status': e['s'],
        }
        for e in raw if e['t'] > cutoff
    ]
    
    return jsonify({
        'project': project,
        'range': range_str,
        'count': len(filtered),
        'history': filtered,
    })

# ─── Export / Import Tunnel Config ────────────────────────────────

@app.route("/api/tunnels/export")
def api_tunnels_export():
    """Export tất cả cấu hình tunnels (watchdog settings, cloudflared info) ra JSON.
    Dùng để backup hoặc migrate sang máy khác."""
    with _tunnel_lock:
        config_data = {
            "exported_at": datetime.now().isoformat(),
            "app_version": "1.9.10",
            "cloudflared": {
                "installed": _is_cloudflared_installed(),
                "version": _get_cloudflared_version(),
            },
            "tunnels": {
                name: {
                    "watchdog_enabled": _tunnel_watchdog_enabled.get(name, False),
                    "restart_count": _tunnel_restart_counts.get(name, 0),
                }
                for name in list(_tunnel_watchdog_enabled.keys())
            }
        }
    
    # Add all projects even if no tunnel config yet
    for p in config["projects"]:
        if p["name"] not in config_data["tunnels"]:
            config_data["tunnels"][p["name"]] = {
                "watchdog_enabled": False,
                "restart_count": 0,
            }
    
    return jsonify(config_data)

@app.route("/api/tunnels/metrics/export")
def api_tunnels_metrics_export():
    """Export tunnel metrics (request count, rate, uptime, status, etc.) ra JSON hoặc CSV.
    Dùng để phân tích hiệu suất tunnel hoặc import vào Excel/Google Sheets.
    
    Query params:
        format: 'json' (default) | 'csv'
    """
    fmt = request.args.get('format', 'json')
    safe_name = datetime.now().strftime('%Y%m%d_%H%M%S')
    
    # WHY: Collect metrics for all projects
    metrics = []
    for p in config["projects"]:
        status = _get_tunnel_status(p["name"])
        running = is_running(p["name"])
        metrics.append({
            "project": p["name"],
            "port": p["port"],
            "server_running": running,
            "tunnel_status": status.get("status", "stopped"),
            "tunnel_url": status.get("url", ""),
            "uptime_seconds": status.get("uptime_seconds"),
            "request_count": status.get("request_count", 0),
            "request_rate": status.get("request_rate", 0),
            "watchdog_enabled": status.get("watchdog_enabled", False),
            "watchdog_restart_count": status.get("watchdog_restart_count", 0),
            "error": status.get("error", ""),
        })
    
    if fmt == "csv":
        # WHY: Generate CSV — include BOM for Excel UTF-8 compatibility
        import io
        import csv
        output = io.StringIO()
        output.write('\ufeff')  # BOM for Excel
        
        fieldnames = ["project", "port", "server_running", "tunnel_status", "tunnel_url",
                       "uptime_seconds", "request_count", "request_rate",
                       "watchdog_enabled", "watchdog_restart_count", "error"]
        writer = csv.DictWriter(output, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(metrics)
        
        content = output.getvalue()
        filename = f"tunnel-metrics_{safe_name}.csv"
        return Response(
            content,
            mimetype="text/csv",
            headers={
                "Content-Disposition": f'attachment; filename="{filename}"',
                "Content-Type": "text/csv; charset=utf-8"
            }
        )
    
    # Default: JSON
    content = json.dumps({
        "exported_at": datetime.now().isoformat(),
        "app_version": "1.9.10",
        "total_projects": len(metrics),
        "active_tunnels": sum(1 for m in metrics if m["tunnel_status"] == "active"),
        "metrics": metrics
    }, indent=2, ensure_ascii=False)
    filename = f"tunnel-metrics_{safe_name}.json"
    return Response(
        content,
        mimetype="application/json",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Content-Type": "application/json; charset=utf-8"
        }
    )

@app.route("/api/tunnels/import", methods=["POST"])
def api_tunnels_import():
    """Import cấu hình tunnels từ file JSON (export trước đó).
    Chỉ restore watchdog settings — KHÔNG tự động start tunnels."""
    data = request.get_json()
    if not data or "tunnels" not in data:
        return jsonify({"error": "File import không hợp lệ: thiếu 'tunnels'"}), 400
    
    imported = data["tunnels"]
    applied = 0
    skipped = 0
    
    with _tunnel_lock:
        for name, cfg in imported.items():
            proj = get_project(name)
            if not proj:
                skipped += 1
                continue
            watchdog = cfg.get("watchdog_enabled", False)
            _tunnel_watchdog_enabled[name] = watchdog
            # Start watchdog thread nếu bật
            if watchdog:
                if name not in _tunnel_watchdog_threads or not _tunnel_watchdog_threads[name].is_alive():
                    t = threading.Thread(target=_tunnel_watchdog_worker, args=(name,), daemon=True)
                    _tunnel_watchdog_threads[name] = t
                    t.start()
            applied += 1
    
    debug_log(f"[tunnel-import] Applied {applied}, skipped {skipped} projects")
    return jsonify({
        "status": "imported",
        "applied": applied,
        "skipped": skipped,
        "total": len(imported),
    })

# ─── Uptime Tracker ──────────────────────────────────────────────
project_start_times = {}

# WHY: Dùng psutil.Process.create_time() thay vì lưu start_time riêng — chính xác hơn,
# không bị sai lệch nếu process được restart bên ngoài (không qua API).
def get_process_uptime(name):
    """Lấy thời gian process đã chạy (giây)"""
    with lock:
        p = processes.get(name)
        if p and p.pid:
            try:
                proc = psutil.Process(p.pid)
                create_time = proc.create_time()
                return int(time.time() - create_time)
            except:
                pass
    return 0

# WHY: Format giây sang readable string (bỏ qua days vì server thường chạy < 24h).
# Frontend không cần parse lại — backend đã format sẵn.
def format_uptime(seconds):
    """Format giây -> chuỗi (VD: 2h 30m 15s)"""
    hours = seconds // 3600
    minutes = (seconds % 3600) // 60
    secs = seconds % 60
    if hours > 0:
        return f"{hours}h {minutes}m {secs}s"
    elif minutes > 0:
        return f"{minutes}m {secs}s"
    return f"{secs}s"

@app.route("/api/logs/export")
# WHY: GET endpoint — frontend dùng window.open() hoặc <a href> để download.
# Hỗ trợ filter: project, format (txt/md/json), limit, search.
# Trả về file response (Content-Disposition: attachment) thay vì JSON.
def api_logs_export():
    """Export logs dưới dạng file download (cho browser use không Tauri)"""
    project = request.args.get("project", "All")
    fmt = request.args.get("format", "txt")  # txt, md, json
    limit_str = request.args.get("limit", "0")
    search = request.args.get("search", "")
    
    try:
        limit = int(limit_str)
    except ValueError:
        limit = 0
    
    if project == "All":
        all_lines = []
        for p in config["projects"]:
            lf = get_log_file(p)
            if lf.exists():
                with open(lf, encoding="utf-8", errors="replace") as f:
                    lines = [l for l in f.read().split("\n") if l]
                    all_lines.extend(lines)
        lines = all_lines
    else:
        proj = get_project(project)
        if not proj:
            return jsonify({"error": "Project not found"}), 404
        lf = get_log_file(proj)
        if not lf.exists():
            lines = []
        else:
            with open(lf, encoding="utf-8", errors="replace") as f:
                lines = [l for l in f.read().split("\n") if l]
    
    # Apply search filter
    if search:
        search_lower = search.lower()
        lines = [l for l in lines if search_lower in l.lower()]
    
    # Apply limit
    if limit > 0 and limit < len(lines):
        lines = lines[-limit:]
    
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    safe_name = project.lower().replace(' ', '_')
    
    if fmt == "json":
        content = json.dumps({
            "project": project,
            "exported_at": datetime.now().isoformat(),
            "line_count": len(lines),
            "search_filter": search if search else None,
            "lines": lines
        }, indent=2, ensure_ascii=False)
        filename = f"logs_{safe_name}_{timestamp}.json"
        return Response(
            content,
            mimetype="application/json",
            headers={"Content-Disposition": f'attachment; filename="{filename}"', "Content-Type": "application/json; charset=utf-8"}
        )
    elif fmt == "md":
        content = f"# Logs: {project}\nDate: {datetime.now().isoformat()}\nLines: {len(lines)}\n\n```text\n" + "\n".join(lines) + "\n```\n"
        filename = f"logs_{safe_name}_{timestamp}.md"
        return Response(
            content,
            mimetype="text/markdown",
            headers={"Content-Disposition": f'attachment; filename="{filename}"', "Content-Type": "text/markdown; charset=utf-8"}
        )
    else:
        # TXT
        content = "\n".join(lines)
        filename = f"logs_{safe_name}_{timestamp}.log"
        return Response(
            content,
            mimetype="text/plain",
            headers={"Content-Disposition": f'attachment; filename="{filename}"', "Content-Type": "text/plain; charset=utf-8"}
        )

@app.route("/api/logs/save-to-file", methods=["POST"])
# WHY: Dùng cho Tauri save dialog — backend write file tại path user chọn.
# Frontend gửi path + content, backend ghi file.
def api_save_logs_to_file():
    data = request.get_json() or {}
    path = data.get("path")
    content = data.get("content")
    if not path or content is None:
        return jsonify({"error": "Yêu cầu đường dẫn và nội dung"}), 400
    try:
        target_path = Path(path)
        with open(target_path, "w", encoding="utf-8") as f:
            f.write(content)
        return jsonify({"status": "saved", "path": path})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/system/ips")
# WHY: GET-only. Lấy tất cả IP addresses local (không phải localhost).
# Dùng socket.gethostbyname_ex — cross-platform, không cần psutil.
# Frontend dùng để hiển thị URLs trong bottom bar.
def api_system_ips():
    import socket
    ips = ["localhost", "127.0.0.1"]
    
    # Try primary interface connection technique
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        local_ip = s.getsockname()[0]
        if local_ip not in ips:
            ips.append(local_ip)
        s.close()
    except Exception:
        pass

    try:
        hostname = socket.gethostname()
        addr_infos = socket.getaddrinfo(hostname, None)
        for info in addr_infos:
            ip = info[4][0]
            if ip not in ips and not ip.startswith("fe80") and not ip.startswith("::") and ":" not in ip:
                ips.append(ip)
    except Exception:
        pass
        
    return jsonify({"ips": ips})

@app.route("/api/system/open-browser", methods=["POST"])
# WHY: Dùng webbrowser.open để mở URL trong default browser.
# Fallback cho frontend Tauri shell.open (nếu Tauri plugin không available).
def api_open_browser():
    import webbrowser
    data = request.get_json() or {}
    url = data.get("url")
    if not url:
        return jsonify({"error": "Yêu cầu URL"}), 400
    try:
        # Standard webbrowser open will call default browser (Chrome, Edge, Firefox, etc.)
        webbrowser.open(url)
        return jsonify({"status": "opened", "url": url})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ═══════════════════════════════════════════════════════════════
# DATABASE APIs — Quản lý PostgreSQL/MySQL (giống phpMyAdmin)
# ═══════════════════════════════════════════════════════════════
#
# Hỗ trợ: PostgreSQL (psycopg2), MySQL (mysql-connector)
# Các thao tác:
#   - Kết nối / Lưu kết nối
#   - Liệt kê database, schema, table
#   - Duyệt dữ liệu table (phân trang)
#   - Chạy SQL query tùy chỉnh
#   - Export dữ liệu (CSV, JSON)
# ═══════════════════════════════════════════════════════════════

# Lưu kết nối database
DB_CONNECTIONS_FILE = str(CONFIG_DIR / "db_connections.json")
db_connections_lock = threading.Lock()

# WHY: Load danh sach connection da luu tu file JSON (thread-safe).
# Khong tra ve password — xu ly o API layer (api_db_connections).
def load_db_connections():
    with db_connections_lock:
        try:
            if os.path.exists(DB_CONNECTIONS_FILE):
                with open(DB_CONNECTIONS_FILE, 'r') as f:
                    return json.load(f)
        except Exception:
            pass
    return []

# WHY: Ghi danh sach connections vao file (thread-safe).
# Luu ca password de co the reconnect tu dong.
def save_db_connections(connections):
    with db_connections_lock:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        with open(DB_CONNECTIONS_FILE, 'w') as f:
            json.dump(connections, f, indent=2)

# WHY: Thu ket noi voi timeout 5s — dung psycopg2 (PostgreSQL) hoac pymysql (MySQL/MariaDB).
# Tra ve {success: bool, error?: string} — frontend hien thi ket qua truc tiep.
def test_db_connection(conn_info):
    """Kiểm tra kết nối database"""
    db_type = conn_info.get("type", "postgresql").lower()
    host = conn_info.get("host", "localhost")
    port = conn_info.get("port", 5432 if db_type == "postgresql" else 3306)
    database = conn_info.get("database", "")
    user = conn_info.get("user", "postgres")
    password = conn_info.get("password", "")
    
    try:
        if db_type == "postgresql":
            import psycopg2
            conn = psycopg2.connect(
                host=host, port=port, dbname=database,
                user=user, password=password, connect_timeout=5
            )
            version = conn.server_version
            conn.close()
            return {"success": True, "version": version, "message": f"PostgreSQL {version}"}
        elif db_type == "mysql":
            import mysql.connector
            conn = mysql.connector.connect(
                host=host, port=port, database=database,
                user=user, password=password, connect_timeout=5
            )
            version = conn.get_server_info()
            conn.close()
            return {"success": True, "version": version, "message": f"MySQL {version}"}
        else:
            return {"success": False, "error": f"Unsupported DB type: {db_type}"}
    except ImportError as e:
        pkg = "psycopg2-binary" if db_type == "postgresql" else "mysql-connector-python"
        return {"success": False, "error": f"Missing package: {pkg}. Run: pip install {pkg}"}
    except Exception as e:
        return {"success": False, "error": str(e)}

# WHY: Whitelist approach — chi cho phep alphanumeric + underscore + dash.
# Nem exception thay vi return None de caller biet chinh xac ly do.
# KHONG dung parameterized query cho identifier (table name, schema name).
def sanitize_identifier(name, db_type="postgresql"):
    """Sanitize database/table/schema names để chống SQL injection.
    Chỉ cho phép chữ, số, underscore. Ném exception nếu không hợp lệ."""
    if not name or not isinstance(name, str):
        raise ValueError("Invalid identifier")
    # Only allow alphanumeric + underscore
    if not all(c.isalnum() or c == '_' or c == '-' for c in name):
        raise ValueError(f"Identifier '{name}' contains invalid characters")
    return name

# WHY: Factory method — tao connection object theo db_type.
# PostgreSQL dung psycopg2.connect, MySQL/MariaDB dung pymysql.connect.
# Nem exception neu fail de caller xu ly (khong swallow error o day).
def get_db_connection(conn_info):
    """Tạo connection object"""
    db_type = conn_info.get("type", "postgresql").lower()
    host = conn_info.get("host", "localhost")
    port = conn_info.get("port", 5432 if db_type == "postgresql" else 3306)
    database = conn_info.get("database", "")
    user = conn_info.get("user", "postgres")
    password = conn_info.get("password", "")
    
    try:
        if db_type == "postgresql":
            import psycopg2
            return psycopg2.connect(
                host=host, port=port, dbname=database,
                user=user, password=password, connect_timeout=10
            )
        elif db_type == "mysql":
            import mysql.connector
            return mysql.connector.connect(
                host=host, port=port, database=database,
                user=user, password=password, connect_timeout=10
            )
    except Exception as e:
        raise Exception(f"Database connection failed: {e}")

@app.route("/api/database/test", methods=["POST"])
# WHY: POST vi co side effect (test connection thuc te, khong read-only).
# Delegate to test_db_connection — khong co logic them o day.
def api_db_test():
    """Kiểm tra kết nối database"""
    data = request.get_json() or {}
    result = test_db_connection(data)
    return jsonify(result)

@app.route("/api/database/connections", methods=["GET", "POST", "DELETE"])
# WHY: 3 methods cung endpoint — GET (doc), POST (them/save), DELETE (xoa).
# GET khong tra ve password (security).
# POST test connection truoc khi save.
def api_db_connections():
    """Quản lý danh sách kết nối database đã lưu"""
    if request.method == "GET":
        # Không trả về password vì lý do bảo mật
        conns = load_db_connections()
        safe = [{k: v for k, v in c.items() if k != "password"} for c in conns]
        return jsonify({"connections": safe})
    
    elif request.method == "POST":
        data = request.get_json() or {}
        # Test kết nối trước khi lưu
        test = test_db_connection(data)
        if not test.get("success"):
            return jsonify({"error": test.get("error", "Connection failed")}), 400
        
        conns = load_db_connections()
        new_conn = {
            "id": str(int(time.time() * 1000)),
            "name": data.get("name", f"DB-{len(conns)+1}"),
            "type": data.get("type", "postgresql"),
            "host": data.get("host", "localhost"),
            "port": data.get("port", 5432),
            "database": data.get("database", ""),
            "user": data.get("user", "postgres"),
            "password": data.get("password", ""),
        }
        conns.append(new_conn)
        save_db_connections(conns)
        return jsonify({"status": "saved", "connection": {k: v for k, v in new_conn.items() if k != "password"}})
    
    elif request.method == "DELETE":
        conn_id = request.args.get("id")
        if not conn_id:
            return jsonify({"error": "Missing id"}), 400
        conns = load_db_connections()
        conns = [c for c in conns if c.get("id") != conn_id]
        save_db_connections(conns)
        return jsonify({"status": "deleted"})

@app.route("/api/database/connect", methods=["POST"])
# WHY: Ket noi tam thoi — co the dung connectionId (da luu) hoac thong tin truc tiep.
# Luu connection vao session de cac API sau (schemas, tables) co the dung lai.
def api_db_connect():
    """Kết nối tạm thời đến database (không lưu)"""
    data = request.get_json() or {}
    conn_id = data.get("connectionId", "")
    
    # Nếu có connectionId, load từ danh sách đã lưu
    if conn_id:
        conns = load_db_connections()
        found = next((c for c in conns if c.get("id") == conn_id), None)
        if not found:
            return jsonify({"error": "Connection not found"}), 404
        data = found
    
    test = test_db_connection(data)
    if not test.get("success"):
        return jsonify({"error": test.get("error")}), 400
    
    # Mở kết nối để dùng cho các request sau
    try:
        conn = get_db_connection(data)
        cursor = conn.cursor()
        
        # Lấy danh sách databases
        db_type = data.get("type", "postgresql").lower()
        if db_type == "postgresql":
            cursor.execute("SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname")
            databases = [row[0] for row in cursor.fetchall()]
        else:
            cursor.execute("SHOW DATABASES")
            databases = [row[0] for row in cursor.fetchall()]
        
        cursor.close()
        conn.close()
        
        return jsonify({
            "success": True,
            "version": test.get("version", ""),
            "databases": databases,
            "connection": {k: v for k, v in data.items() if k != "password"},
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/database/schemas", methods=["POST"])
# WHY: Query INFORMATION_SCHEMA.SCHEMATA de lay danh sach schemas.
# PostgreSQL: SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA.
# MySQL: SHOW DATABASES (tuong duong).
def api_db_schemas():
    """Lấy danh sách schemas trong database"""
    data = request.get_json() or {}
    conn_id = data.get("connectionId")
    database = data.get("database", "")
    
    if not conn_id or not database:
        return jsonify({"error": "Missing connectionId or database"}), 400
    
    conns = load_db_connections()
    found = next((c for c in conns if c.get("id") == conn_id), None)
    if not found:
        return jsonify({"error": "Connection not found"}), 404
    
    found["database"] = database
    
    try:
        conn = get_db_connection(found)
        cursor = conn.cursor()
        
        db_type = found.get("type", "postgresql").lower()
        if db_type == "postgresql":
            cursor.execute("""
                SELECT schema_name FROM information_schema.schemata
                WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
                ORDER BY schema_name
            """)
        else:
            cursor.execute("SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA ORDER BY SCHEMA_NAME")
        
        schemas = [row[0] for row in cursor.fetchall()]
        cursor.close()
        conn.close()
        return jsonify({"schemas": schemas})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/database/tables", methods=["POST"])
# WHY: Query INFORMATION_SCHEMA.TABLES — loc theo table_schema + table_type = 'BASE TABLE'.
# PostgreSQL: schema mac dinh la 'public'. MySQL: schema = database.
def api_db_tables():
    """Lấy danh sách tables trong schema"""
    data = request.get_json() or {}
    conn_id = data.get("connectionId")
    database = data.get("database", "")
    schema = data.get("schema", "public")
    
    if not conn_id:
        return jsonify({"error": "Missing connectionId"}), 400
    
    conns = load_db_connections()
    found = next((c for c in conns if c.get("id") == conn_id), None)
    if not found:
        return jsonify({"error": "Connection not found"}), 404
    
    found["database"] = database
    
    try:
        conn = get_db_connection(found)
        cursor = conn.cursor()
        
        db_type = found.get("type", "postgresql").lower()
        if db_type == "postgresql":
            safe_schema = sanitize_identifier(schema, "postgresql")
            cursor.execute("""
                SELECT tablename FROM pg_catalog.pg_tables
                WHERE schemaname = %s ORDER BY tablename
            """, (schema,))
        else:
            safe_db = sanitize_identifier(database, "mysql")
            cursor.execute(f"SHOW TABLES FROM `{safe_db}`")
        
        tables = [row[0] for row in cursor.fetchall()]
        
        # Đếm số dòng mỗi table
        table_info = []
        for t in tables:
            try:
                safe_table = sanitize_identifier(t, db_type)
                if db_type == "postgresql":
                    cursor.execute(f'SELECT COUNT(*) FROM "{safe_schema}"."{safe_table}"')
                else:
                    cursor.execute(f"SELECT COUNT(*) FROM `{safe_db}`.`{safe_table}`")
                row_count = cursor.fetchone()[0]
            except:
                row_count = -1
            table_info.append({"name": t, "rows": row_count})
        
        cursor.close()
        conn.close()
        return jsonify({"tables": table_info})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/database/table-data", methods=["POST"])
# WHY: SELECT * + LIMIT/OFFSET cho phan trang. Dem truoc total rows bang COUNT(*).
# Tra ve {columns, rows, total, page, page_size, elapsed_ms}.
# Gioi han page_size = 1000 de tranh overload network.
def api_db_table_data():
    """Duyệt dữ liệu table với phân trang"""
    data = request.get_json() or {}
    conn_id = data.get("connectionId")
    database = data.get("database", "")
    schema = data.get("schema", "public")
    table = data.get("table", "")
    page = data.get("page", 1)
    page_size = data.get("pageSize", 100)
    
    if not conn_id or not table:
        return jsonify({"error": "Missing connectionId or table"}), 400
    
    conns = load_db_connections()
    found = next((c for c in conns if c.get("id") == conn_id), None)
    if not found:
        return jsonify({"error": "Connection not found"}), 404
    
    found["database"] = database
    
    try:
        conn = get_db_connection(found)
        cursor = conn.cursor()
        db_type = found.get("type", "postgresql").lower()
        
        # Lấy column info
        safe_schema = sanitize_identifier(schema, db_type)
        safe_table = sanitize_identifier(table, db_type)
        safe_db = sanitize_identifier(database, db_type)
        
        if db_type == "postgresql":
            cursor.execute("""
                SELECT column_name, data_type, is_nullable
                FROM information_schema.columns
                WHERE table_schema = %s AND table_name = %s
                ORDER BY ordinal_position
            """, (schema, table))
        else:
            cursor.execute(f"""
                SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
                FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_SCHEMA = '{safe_db}' AND TABLE_NAME = '{safe_table}'
                ORDER BY ORDINAL_POSITION
            """)
        columns = [{"name": r[0], "type": r[1], "nullable": r[2]} for r in cursor.fetchall()]
        
        # Đếm tổng số dòng
        if db_type == "postgresql":
            cursor.execute(f'SELECT COUNT(*) FROM "{safe_schema}"."{safe_table}"')
        else:
            cursor.execute(f"SELECT COUNT(*) FROM `{safe_db}`.`{safe_table}`")
        total_rows = cursor.fetchone()[0]
        total_pages = max(1, (total_rows + page_size - 1) // page_size)
        
        # Lấy dữ liệu phân trang
        offset = (page - 1) * page_size
        if db_type == "postgresql":
            col_names = ", ".join([f'"{c["name"]}"' for c in columns])
            cursor.execute(f'SELECT {col_names} FROM "{safe_schema}"."{safe_table}" LIMIT %s OFFSET %s', (page_size, offset))
        else:
            col_names = ", ".join([f"`{c['name']}`" for c in columns])
            cursor.execute(f"SELECT {col_names} FROM `{safe_db}`.`{safe_table}` LIMIT {page_size} OFFSET {offset}")
        
        rows = []
        for row in cursor.fetchall():
            row_dict = {}
            for i, col in enumerate(columns):
                val = row[i]
                # Convert datetime/date to string for JSON serialization
                if hasattr(val, 'isoformat'):
                    val = val.isoformat()
                row_dict[col["name"]] = str(val) if val is not None else None
            rows.append(row_dict)
        
        cursor.close()
        conn.close()
        
        return jsonify({
            "columns": columns,
            "rows": rows,
            "total_rows": total_rows,
            "page": page,
            "total_pages": total_pages,
            "page_size": page_size,
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/database/query", methods=["POST"])
# WHY: Raw SQL query — canh bao security: chi nen dung cho debugging.
# Dung cursor.description de lay column names + types tu result set.
# LIMIT 1000 rows de tranh overload (giong table-data).
def api_db_query():
    """Chạy SQL query tùy chỉnh"""
    data = request.get_json() or {}
    conn_id = data.get("connectionId")
    database = data.get("database", "")
    query = data.get("query", "")
    
    if not conn_id or not query:
        return jsonify({"error": "Missing connectionId or query"}), 400
    
    conns = load_db_connections()
    found = next((c for c in conns if c.get("id") == conn_id), None)
    if not found:
        return jsonify({"error": "Connection not found"}), 404
    
    found["database"] = database
    
    try:
        conn = get_db_connection(found)
        cursor = conn.cursor()
        cursor.execute(query)
        
        results = []
        columns = []
        affected = 0
        
        if cursor.description:
            columns = [{"name": d[0], "type": d[1].name if hasattr(d[1], 'name') else str(d[1])} for d in cursor.description]
            for row in cursor.fetchall():
                row_dict = {}
                for i, col in enumerate(columns):
                    val = row[i]
                    if hasattr(val, 'isoformat'):
                        val = val.isoformat()
                    row_dict[col["name"]] = str(val) if val is not None else None
                results.append(row_dict)
        else:
            affected = cursor.rowcount
        
        conn.commit()
        cursor.close()
        conn.close()
        
        return jsonify({
            "success": True,
            "columns": columns,
            "rows": results,
            "affected_rows": affected,
            "row_count": len(results),
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/database/export", methods=["POST"])
# WHY: Export JSON (json.dumps) hoac CSV (csv.writer + StringIO).
# Stream ve response (khong save file tam) de don gian.
def api_db_export():
    """Export dữ liệu table ra JSON hoặc CSV (file download)"""
    data = request.get_json() or {}
    conn_id = data.get("connectionId")
    database = data.get("database", "")
    schema = data.get("schema", "public")
    table = data.get("table", "")
    export_format = data.get("format", "json")  # "json" or "csv"
    query_text = data.get("query", "")  # Nếu có, export kết quả query thay vì table
    
    if not conn_id:
        return jsonify({"error": "Missing connectionId"}), 400
    if not query_text and not table:
        return jsonify({"error": "Missing table or query"}), 400
    
    conns = load_db_connections()
    found = next((c for c in conns if c.get("id") == conn_id), None)
    if not found:
        return jsonify({"error": "Connection not found"}), 404
    
    found["database"] = database
    
    try:
        conn = get_db_connection(found)
        cursor = conn.cursor()
        db_type = found.get("type", "postgresql").lower()
        
        columns = []
        rows = []
        
        if query_text:
            # Export từ custom query
            cursor.execute(query_text)
            if cursor.description:
                columns = [{"name": d[0]} for d in cursor.description]
                for row in cursor.fetchall():
                    row_dict = {}
                    for i, col in enumerate(columns):
                        val = row[i]
                        if hasattr(val, 'isoformat'):
                            val = val.isoformat()
                        row_dict[col["name"]] = str(val) if val is not None else None
                    rows.append(row_dict)
        else:
            # Export từ table (lấy tất cả dữ liệu, không phân trang)
            safe_schema = sanitize_identifier(schema, db_type)
            safe_table = sanitize_identifier(table, db_type)
            safe_db = sanitize_identifier(database, db_type)
            
            if db_type == "postgresql":
                cursor.execute("""
                    SELECT column_name, data_type, is_nullable
                    FROM information_schema.columns
                    WHERE table_schema = %s AND table_name = %s
                    ORDER BY ordinal_position
                """, (schema, table))
                columns = [{"name": r[0], "type": r[1]} for r in cursor.fetchall()]
                col_names = ", ".join([f'"{c["name"]}"' for c in columns])
                cursor.execute(f'SELECT {col_names} FROM "{safe_schema}"."{safe_table}"')
            else:
                cursor.execute(f"""
                    SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
                    FROM INFORMATION_SCHEMA.COLUMNS
                    WHERE TABLE_SCHEMA = '{safe_db}' AND TABLE_NAME = '{safe_table}'
                    ORDER BY ORDINAL_POSITION
                """)
                columns = [{"name": r[0], "type": r[1]} for r in cursor.fetchall()]
                col_names = ", ".join([f"`{c['name']}`" for c in columns])
                cursor.execute(f"SELECT {col_names} FROM `{safe_db}`.`{safe_table}`")
            
            for row in cursor.fetchall():
                row_dict = {}
                for i, col in enumerate(columns):
                    val = row[i]
                    if hasattr(val, 'isoformat'):
                        val = val.isoformat()
                    row_dict[col["name"]] = str(val) if val is not None else None
                rows.append(row_dict)
        
        cursor.close()
        conn.close()
        
        if export_format == "csv":
            # Tạo CSV
            import io
            import csv
            output = io.StringIO()
            if columns:
                writer = csv.DictWriter(output, fieldnames=[c["name"] for c in columns])
                writer.writeheader()
                writer.writerows(rows)
            csv_content = output.getvalue()
            filename = f"{table or 'query'}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
            return Response(
                csv_content,
                mimetype="text/csv",
                headers={
                    "Content-Disposition": f'attachment; filename="{filename}"',
                    "Content-Type": "text/csv; charset=utf-8"
                }
            )
        else:
            # Mặc định: JSON
            filename = f"{table or 'query'}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
            json_content = json.dumps({
                "table": table or "query",
                "columns": columns,
                "rows": rows,
                "total_rows": len(rows),
                "exported_at": datetime.now().isoformat()
            }, indent=2, ensure_ascii=False)
            return Response(
                json_content,
                mimetype="application/json",
                headers={
                    "Content-Disposition": f'attachment; filename="{filename}"',
                    "Content-Type": "application/json; charset=utf-8"
                }
            )
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ═══════════════════════════════════════════════════════════════
# PRINTER APIs — Quản lý máy in, lịch sử in, thống kê
# ═══════════════════════════════════════════════════════════════
#
# Kiến trúc:
#   - win32print: Lấy trạng thái cơ bản (status, driver, port)
#   - WMI (win32com): Lấy thông tin mở rộng (capabilities, paper sizes)
#   - PowerShell: Lấy độ phân giải in, EventLog page count
#   - File JSON: Lưu settings, history, statistics
#
# Lưu ý cho AI agents:
#   - Flask threaded=True → mỗi request là thread riêng
#   - pythoncom.CoInitializeEx() cần gọi mỗi request khi dùng COM
#   - Các máy in USB (EPSON) không hỗ trợ PJL, chỉ đọc được status
#   - Máy in ảo (PDF, Fax, OneNote) cần lọc bằng excluded_printers
#
# File dữ liệu (lưu trong %APPDATA%/multitool-pro/):
#   - printer_settings.json: Cấu hình người dùng
#   - printer_history.json: Lịch sử in ấn (tối đa 200 entry)
#   - printer_statistics.json: Thống kê in ấn (số lần, gần đây)
# ═══════════════════════════════════════════════════════════════

# ─── C# / PowerShell Printer Monitor Module ─────────────────
# PrinterMonitor.exe is a .NET 8 console app that reads Windows
# PrintService EventLog (Event ID 307) and returns JSON.
# If not compiled, falls back to PrinterMonitor.ps1 (PowerShell).
PRINTER_MONITOR_DIR = str(BASE_DIR / "printer-monitor")
PRINTER_MONITOR_EXE = str(BASE_DIR / "printer-monitor" / "bin" / "Release" / "net8.0" / "win-x64" / "publish" / "PrinterMonitor.exe")
PRINTER_MONITOR_PS1 = str(BASE_DIR / "printer-monitor" / "PrinterMonitor.ps1")

def query_printer_monitor_cs(printer_name, action="query", timeout=15):
    """
    Gọi PrinterMonitor C# module hoặc PowerShell fallback.
    
    Args:
        printer_name: Tên máy in (hoặc "" cho tất cả)
        action: "query" | "stats" | "listen" | "install"
        timeout: Timeout giây
    Returns:
        dict kết quả, hoặc None nếu cả 2 đều thất bại
    """
    import json as json_mod
    
    # Ưu tiên 1: C# exe (nếu đã compile)
    if os.path.exists(PRINTER_MONITOR_EXE):
        try:
            cmd = [PRINTER_MONITOR_EXE, action]
            if printer_name and action in ("query", "listen"):
                cmd.append(printer_name)
            if action == "listen":
                cmd.append("30")
            
            result = subprocess.run(
                cmd, capture_output=True, text=True, timeout=timeout,
                startupinfo=get_startupinfo(),
                creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
            )
            if result.returncode == 0 and result.stdout.strip():
                data = json_mod.loads(result.stdout.strip())
                debug_log(f"PrinterMonitor C# [{action}] for {printer_name}: OK")
                return data
            else:
                debug_log(f"PrinterMonitor C# [{action}] failed: {result.stderr[:100]}")
        except Exception as e:
            debug_log(f"PrinterMonitor C# [{action}] error: {e}")
    
    # Ưu tiên 2: PowerShell script (luôn available trên Windows)
    if os.path.exists(PRINTER_MONITOR_PS1):
        try:
            ps_args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PRINTER_MONITOR_PS1,
                       "-Command", action]
            if printer_name:
                ps_args += ["-PrinterName", printer_name]
            if action == "listen":
                ps_args += ["-Duration", "30"]
            
            result = subprocess.run(
                ["powershell"] + ps_args,
                capture_output=True, text=True, timeout=timeout,
                startupinfo=get_startupinfo(),
                creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
            )
            if result.stdout.strip():
                # PowerShell may output multiple JSON lines; take the last one
                lines = [l.strip() for l in result.stdout.split('\n') if l.strip()]
                for line in reversed(lines):
                    try:
                        data = json_mod.loads(line)
                        debug_log(f"PrinterMonitor PS1 [{action}] for {printer_name}: OK")
                        return data
                    except json_mod.JSONDecodeError:
                        continue
            else:
                debug_log(f"PrinterMonitor PS1 [{action}] no output")
        except Exception as e:
            debug_log(f"PrinterMonitor PS1 [{action}] error: {e}")
    
    return None

# Đường dẫn file dữ liệu — tất cả đều trong %APPDATA%/multitool-pro/
PRINTER_LOG_FILE = str(CONFIG_DIR / "print_log.json")           # Log in cuối (ít dùng)
PRINTER_HISTORY_FILE = str(CONFIG_DIR / "print_history.json")   # Lịch sử in (dùng chính)
PRINTER_SETTINGS_FILE = str(CONFIG_DIR / "printer_settings.json") # Cài đặt người dùng

# ─── Cài đặt mặc định ────────────────────────────────────────────
# days_between_prints: Số ngày giữa các lần in (mặc định 5 ngày)
#   → Dùng cho reminder chống khô mực inkjet
# selected_printer: Tên máy in đang được theo dõi
# remind_minutes: Tần suất nhắc nhở (phút)
# reminder_enabled: Bật/tắt tính năng nhắc nhở
# last_print_date: Thời gian in lần cuối (format: dd/mm/yy HH:MM:SS)
# excluded_printers: Danh sách máy in ảo bị ẩn (PDF, Fax...)
#   → Filter trong frontend, không ảnh hưởng đến lưu dữ liệu
# page_count: Dict lưu tổng số trang đã in cho từng máy (nhập thủ công)
#   → Key: tên máy in, Value: số trang

DEFAULT_PRINTER_SETTINGS = {
    "days_between_prints": 5,
    "selected_printer": "",
    "remind_minutes": 15,
    "reminder_enabled": True,
    "last_print_date": None,
    "excluded_printers": [],            "page_count": {},  # {printer_name: total_pages} — nhập thủ công hoặc auto-increment
            "page_count_timestamp": {},  # {printer_name: "dd/mm/yy HH:MM:SS"} — thời gian cập nhật cuối
}

# WHY: Merge với DEFAULT_PRINTER_SETTINGS để đảm bảo không thiếu field kể cả khi user xóa key khỏi file.
# _printer_file_lock: thread-safe cho read-modify-write patterns trong polling API.
def load_printer_settings():
    """
    Đọc cài đặt máy in từ file JSON.
    Merge với DEFAULT_PRINTER_SETTINGS để đảm bảo không thiếu field.
    Returns: dict chứa toàn bộ settings.
    
    ⚠️ Thread-safe: dùng _printer_file_lock
    """
    with _printer_file_lock:
        try:
            if os.path.exists(PRINTER_SETTINGS_FILE):
                with open(PRINTER_SETTINGS_FILE, 'r') as f:
                    return {**DEFAULT_PRINTER_SETTINGS, **json.load(f)}
        except Exception:
            pass
    return dict(DEFAULT_PRINTER_SETTINGS)

# WHY: Ghi TOÀN BỘ settings object (không partial).
# File lock đảm bảo không conflict với load/save từ polling loop.
def save_printer_settings(settings):
    """Ghi cài đặt máy in vào file JSON trong %APPDATA%/multitool-pro/"""
    with _printer_file_lock:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        with open(PRINTER_SETTINGS_FILE, 'w') as f:
            json.dump(settings, f, indent=2)

# WHY: Alias để giữ backward compatibility — các module khác có thể import get_printer_settings.
# Delegate to load_printer_settings() để tránh duplicate code.
def get_printer_settings():
    """Alias cho load_printer_settings() — giữ tương thích"""
    return load_printer_settings()

# ─── get_printer_info ────────────────────────────────────────────
# Lấy thông tin cơ bản của một máy in qua win32print API.
# Dùng GetPrinter(handle, 2) để lấy level 2 (PRINTER_INFO_2).
# Trạng thái: sử dụng bitmask status flags của Windows.
#
# ⚠️ Lưu ý: win32print.OpenPrinter có thể THẤT BẠI nếu:
#   - Máy in đang offline
#   - Driver bị lỗi
#   - Tên máy in sai
#   → Luôn có except fallback về 'Không rõ'

# WHY: Dùng win32print.GetPrinter level 2 (PRINTER_INFO_2). Status bitmask decode thành text.
# OpenPrinter có thể fail nếu máy in offline → luôn có except fallback.
def get_printer_info(name):
    """
    Lấy thông tin cơ bản của máy in qua win32print.
    Args:
        name: Tên máy in (VD: "EPSON L3210 Series")
    Returns:
        dict: {status, driver, port, location, comment, jobs}
        Nếu lỗi: status='Không rõ', các field còn lại rỗng
    """
    try:
        import win32print
        handle = win32print.OpenPrinter(name)
        info = win32print.GetPrinter(handle, 2)  # Level 2 = PRINTER_INFO_2
        
        # ---- Xử lý status (Windows Printer Status bitmask) ----
        # Các flag quan trọng:
        #   0x00000000 = Sẵn sàng
        #   0x00000002 = Lỗi (ERROR)
        #   0x00000010 = Hết giấy (OUT_OF_PAPER)
        #   0x00000020 = Đang in (PRINTING)
        #   0x00000040 = Ngoại tuyến (OFFLINE)
        #   0x00000080 = Kẹt giấy (PAPER_JAM)
        # Dùng bitwise AND để kiểm tra nhiều flag cùng lúc
        status = info.get('Status', 0) or 0
        if status == 0: status_str = 'Sẵn sàng'
        elif status & 0x00000002: status_str = 'Lỗi'
        elif status & 0x00000010: status_str = 'Hết giấy'
        elif status & 0x00000020: status_str = 'Đang in'
        elif status & 0x00000040: status_str = 'Ngoại tuyến'
        elif status & 0x00000080: status_str = 'Kẹt giấy'
        else: status_str = f'Trạng thái: {status}'
        
        win32print.ClosePrinter(handle)
        return {
            'status': status_str,
            'driver': info.get('pDriverName', ''),
            'port': info.get('pPortName', ''),      # VD: "USB002", "LPT1:"
            'location': info.get('pLocation', ''),
            'comment': info.get('pComment', ''),
            'jobs': info.get('cJobs', 0),            # Số job đang đợi
        }
    except Exception: 
        return {'status': 'Không rõ', 'driver': '', 'port': '', 'location': '', 'comment': '', 'jobs': 0}

# ─── GET /api/printers ───────────────────────────────────────────
# Trả về danh sách tất cả máy in LOCAL (không bao gồm network printers).
# Dùng PRINTER_ENUM_LOCAL để chỉ lấy máy in USB/LPT.
# Mỗi máy in được gắn thêm:
#   - is_default: Máy in mặc định của Windows
#   - is_laser: Tự động phát hiện qua tên (chứa "laser"?)
#
# ⚠️ Frontend filter: excluded_printers do FRONTEND xử lý,
#    backend trả về TẤT CẢ máy in để frontend quyết định.

@app.route("/api/printers")
# WHY: Quét tất cả máy in local — dùng PRINTER_ENUM_LOCAL flag (không network printers).
# Status text được decode từ bitmask Windows status flags.
# is_laser = True dùng heuristic name-based để frontend bỏ qua reminder.
def api_printers():
    """
    GET /api/printers
    Trả về danh sách máy in LOCAL (USB/LPT).
    Returns: {printers: [{name, status, is_default, is_laser, jobs, driver, port, ...}]}
    
    ⚠️ Frontend filter: excluded_printers do FRONTEND xử lý,
       backend trả về TẤT CẢ máy in để frontend quyết định.
    """
    try:
        import win32print
        printers = []
        # PRINTER_ENUM_LOCAL = chỉ lấy máy in local, bỏ qua network
        flags = win32print.PRINTER_ENUM_LOCAL
        for p in win32print.EnumPrinters(flags):
            name = p[2]
            pr_info = get_printer_info(name)
            printer_info_driver = _get_cached_printer_info(name, pr_info.get('driver', ''))
            printers.append({
                'name': name,
                'status': pr_info['status'],
                'is_default': False,  # sẽ gán sau
                'is_laser': is_laser_printer(name),
                'driver_type': printer_info_driver.get('driver_type', 'unknown'),
                'driver_brand': printer_info_driver.get('brand', ''),
                'tracking_method': printer_info_driver.get('tracking_method', 'eventlog'),
                'supports_eventlog': printer_info_driver.get('supports_eventlog', True),
                'jobs': pr_info['jobs'],
                'driver': pr_info['driver'],
                'port': pr_info['port'],
                'location': pr_info['location'],
                'comment': pr_info['comment'],
            })

        # Xác định máy in mặc định của Windows
        try:
            default_name = win32print.GetDefaultPrinter()
            for pr in printers:
                if pr['name'] == default_name:
                    pr['is_default'] = True
        except Exception: pass

        # Cleanup _last_job_count: xóa printer không còn tồn tại (đã rút USB, đổi tên...)
        active_names = {pr['name'] for pr in printers}
        with _last_job_count_lock:
            stale = [k for k in _last_job_count if k not in active_names]
            for k in stale:
                del _last_job_count[k]
            if stale:
                debug_log(f"Cleaned up {len(stale)} stale printers from _last_job_count")
        
        return jsonify({'printers': printers})
    except ImportError:
        return jsonify({'printers': [], 'error': 'win32print không khả dụng'}), 501
    except Exception as e:
        debug_log(f"LỖI api_printers: {e}")
        return jsonify({'printers': [], 'error': str(e)}), 500

@app.route("/api/printers/<name>/jobs")
# WHY: EnumJobs level 1 (JOB_INFO_1) — đủ thông tin (JobId, Document, Status) mà không quá nặng.
# Giới hạn 100 jobs để tránh timeout với hàng đợi lớn.
def api_printer_jobs(name):
    """
    GET /api/printers/<name>/jobs
    Lấy danh sách job đang đợi trong hàng đợi in.
    Dùng EnumJobs(handle, 0, 100, 1) để lấy tối đa 100 job.
    Returns: {jobs: [string, ...]}
    """
    try:
        import win32print
        handle = win32print.OpenPrinter(name)
        jobs = win32print.EnumJobs(handle, 0, 100, 1)  # Level 1 = JOB_INFO_1
        win32print.ClosePrinter(handle)
        job_list = []
        for j in jobs:
            job_list.append(f"#{j.get('JobId', 0)} {j.get('pDocument', 'Không rõ')} - {j.get('Status', 0)}")
        return jsonify({'jobs': job_list})
    except Exception as e:
        return jsonify({'jobs': [], 'error': str(e)}), 500

@app.route("/api/printers/<name>/jobs", methods=["DELETE"])
# WHY: JOB_CONTROL_DELETE = 5 — xóa job khỏi spooler. Dùng SetJob level 0 (không cần job info).
# Xóa từng job 1 → continue qua lỗi (không block nếu job đang được in).
def api_printer_clear_jobs(name):
    """
    DELETE /api/printers/<name>/jobs
    Xóa tất cả job trong hàng đợi in.
    Dùng SetJob với JOB_CONTROL_DELETE cho từng job.
    """
    try:
        import win32print
        handle = win32print.OpenPrinter(name)
        jobs = win32print.EnumJobs(handle, 0, 100, 1)
        for j in jobs:
            try:
                # JOB_CONTROL_DELETE = 5 = xóa job khỏi hàng đợi
                win32print.SetJob(handle, j['JobId'], 0, None, win32print.JOB_CONTROL_DELETE)
            except Exception: pass
        win32print.ClosePrinter(handle)
        return jsonify({'status': 'cleared'})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route("/api/printers/<name>/default", methods=["POST"])
# WHY: win32print.SetDefaultPrinter — Windows API chuẩn, không cần admin.
# Không có undo — frontend cần confirm trước khi gọi.
def api_printer_set_default(name):
    """
    POST /api/printers/<name>/default
    Đặt máy in làm mặc định cho Windows.
    """
    try:
        import win32print
        win32print.SetDefaultPrinter(name)
        return jsonify({'status': 'set_default', 'name': name})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route("/api/printers/<name>/test", methods=["POST"])
# WHY: Gửi RAW PCL data trực tiếp (không qua driver) — hoạt động với hầu hết máy in.
# EPSON ESC/P-R có thể in ra ký tự lạ vì không hỗ trợ PCL.
# StartDocPrinter với level 1 (không cần doc info chi tiết).
def api_printer_test(name):
    """
    POST /api/printers/<name>/test
    Gửi trang thử đến máy in dạng RAW (PJL).
    Dùng StartDocPrinter + StartPagePrinter + WritePrinter + EndDocPrinter.
    
    ⚠️ RAW data: Gửi trực tiếp mã PCL xuống máy in,
       không qua driver → có thể không hoạt động với mọi máy.
       Một số máy in (EPSON) có thể bỏ qua hoặc in ra ký tự lạ.
    """
    try:
        import win32print
        handle = win32print.OpenPrinter(name)
        try:
            # PJL/PCL command để in trang thử đơn giản
            test_data = b"\x1b%-12345X@PJL\r\n@PJL ENTER LANGUAGE=PCL\r\n\x1bE\r\n\x1b&l0H\x1b&l0P"
            job_id = win32print.StartDocPrinter(handle, 1, ('Test Page - MultiTool Pro', None, 'RAW'))
            win32print.StartPagePrinter(handle)
            win32print.WritePrinter(handle, test_data)
            win32print.EndPagePrinter(handle)
            win32print.EndDocPrinter(handle)
        finally:
            win32print.ClosePrinter(handle)
        # Auto-update print log + page count after test
        add_print_history_entry("Đã in trang thử", name)
        auto_increment_page_count(name)
        return jsonify({'status': 'test_page_sent', 'name': name})
    except Exception as e:
        debug_log(f"LỖI api_printer_test: {e}")
        return jsonify({'error': str(e)}), 500

# ═══════════════════════════════════════════════════════════════
# PRINTER MONITORING & STATISTICS
# Phát hiện in tự động, thống kê số lần in
# ═══════════════════════════════════════════════════════════════
#
# Cơ chế phát hiện in:
#   1. detect_completed_print_jobs() được gọi mỗi 5 giây (từ frontend)
#   2. So sánh danh sách job hiện tại với danh sách trước đó
#   3. Job nào biến mất → đã hoàn thành → lưu vào history + stats
#
# Lưu ý:
#   - Chỉ hoạt động với PRINTER_ENUM_LOCAL (USB, không bao gồm network)
#   - _printer_prev_jobs là global, dùng lock tránh race condition
#   - Chỉ lưu được SỐ LẦN in, không phải SỐ TRANG (không đọc được từ USB)
# ═══════════════════════════════════════════════════════════════

# Cache cho EventLog page count — tránh query PowerShell mỗi 5 giây
# Format: {printer_name: {count: int, cached_at: float}}
_eventlog_cache = {}
_eventlog_cache_lock = threading.Lock()

# ─── Printer driver type cache (sống 5 phút) ─────────────────────
_printer_info_cache = {}
_printer_info_cache_lock = threading.Lock()
PRINTER_INFO_CACHE_TTL = 300  # 5 phút

PRINTER_STATS_FILE = str(CONFIG_DIR / "printer_statistics.json")
# Global state: lưu danh sách job của lần quét trước
# Dùng để so sánh phát hiện job mới hoàn thành
# Format: {printer_name: {job_id: {status: int, doc: string, total_pages: int}}}
_printer_prev_jobs = {}

# Global state: track last known JobCountSinceLastReset per printer
# Dùng để phát hiện thay đổi → auto-increment page_count
# Format: {printer_name: int}
_last_job_count = {}
_last_job_count_lock = threading.Lock()

# Mutex cho tất cả file I/O printer (settings, history, stats)
# Flask threaded=True → nhiều request có thể đọc/ghi đồng thời
_printer_file_lock = threading.Lock()



# WHY: Heuristic name-based — không có API Windows nào cho biết máy in có phải laser không.
# Keyword list được mở rộng dần dựa trên máy in thực tế (Brother HL, HP LaserJet, Canon LBP).
def is_laser_printer(name):
    """
    Kiểm tra máy in có phải laser không dựa trên tên.
    Heuristic:
    - Tên chứa 'laser' (không phân biệt hoa thường)
    - 'hl-' (Brother High-grade Laser series, VD: HL-2240D, HL-L2350DW)
    - 'laserjet' (HP LaserJet)
    - 'lbp' (Canon Laser Beam Printer)
    Dùng để bỏ qua reminder chống khô mực cho máy laser.
    """
    name_lower = name.lower()
    return any(kw in name_lower for kw in ['laser', 'hl-', 'laserjet', 'lbp'])

# ─── Printer Driver Type Detection ──────────────────────────────
# GDI (host-based) printers like Brother HL-2240D often don't
# generate Event ID 307 events. We need to detect this and use
# alternative tracking methods (WMI, Get-PrintJob).
_GDI_DRIVER_KEYWORDS = [
    'gdi', 'host based', 'universal printing', 'class driver',
    'brother hl-', 'brother dcp-', 'brother mfc-',  # Common Brother GDI laser
    'samsung ml-', 'samsung scx-',  # Samsung GDI
]

def _detect_printer_info(printer_name=None, driver_name=None):
    """
    Phát hiện loại driver máy in và brand.
    
    Returns:
        dict: {
            "driver_type": "gdi" | "pcl" | "postscript" | "standard" | "unknown",
            "brand": str (tên hãng nếu nhận dạng được),
            "supports_eventlog": bool (True nếu máy in có thể tạo Event ID 307),
            "tracking_method": "eventlog" | "wmi" | "manual" (phương pháp lý tưởng)
        }
    """
    result = {
        "driver_type": "unknown",
        "brand": "",
        "supports_eventlog": True,
        "tracking_method": "eventlog"
    }
    
    name_lower = (printer_name or "").lower()
    driver_lower = (driver_name or "").lower()
    combined = name_lower + " " + driver_lower
    
    # === Detect brand ===
    brand_map = {
        'brother': 'Brother', 'epson': 'EPSON', 'hp ': 'HP', 'hewlett-packard': 'HP',
        'canon': 'Canon', 'samsung': 'Samsung', 'kyocera': 'Kyocera',
        'ricoh': 'Ricoh', 'xerox': 'Xerox', 'lexmark': 'Lexmark',
        'dell': 'Dell', 'fujitsu': 'Fujitsu', 'panasonic': 'Panasonic',
        'oki': 'OKI', 'sharp': 'Sharp', 'toshiba': 'Toshiba',
    }
    for kw, brand in brand_map.items():
        if kw in combined:
            result["brand"] = brand
            break
    
    # === Detect driver type ===
    # GDI / host-based: cheap printers, rasterizes on host
    is_gdi = any(kw in combined for kw in _GDI_DRIVER_KEYWORDS)
    
    if is_gdi:
        result["driver_type"] = "gdi"
        # GDI printers rarely generate Event ID 307
        result["supports_eventlog"] = False
        result["tracking_method"] = "wmi"
    elif 'pcl' in combined or 'pcl6' in combined or 'pcl-6' in combined:
        result["driver_type"] = "pcl"
    elif 'postscript' in combined or 'ps ' in combined or '_ps' in combined:
        result["driver_type"] = "postscript"
    else:
        result["driver_type"] = "standard"
    
    # Specific overrides based on known models
    # Brother HL-2240D is GDI laser, does NOT generate Event ID 307
    if 'hl-2240' in combined:
        result["driver_type"] = "gdi"
        result["supports_eventlog"] = False
        result["tracking_method"] = "wmi"
        result["brand"] = "Brother"
    
    return result

# WHY: Quét EnumJobs mỗi 5s để phát hiện hoạt động in real-time (phục vụ UI dashboard).
# Không phát hiện được qua WMI vì WMI job count không phân biệt đang in vs chờ.
# Flag 0x01=JOB_STATUS_PRINTING, 0x10=JOB_STATUS_SPOOLING.
def get_printing_activity():
    """
    Quét tất cả máy in local để phát hiện hoạt động in đang diễn ra.
    Kiểm tra status flag PRINTING (0x01) và TotalPages > 0.
    Returns: list [{printer, document, job_id, is_printing, pages}]
    """
    try:
        import win32print
        active = []
        flags = win32print.PRINTER_ENUM_LOCAL
        for p in win32print.EnumPrinters(flags):
            name = p[2]
            try:
                handle = win32print.OpenPrinter(name)
                try:
                    jobs = win32print.EnumJobs(handle, 0, 100, 1)
                    for j in jobs:
                        status = j.get('Status', 0)
                        # Flag 0x01 = JOB_STATUS_PRINTING, 0x10 = JOB_STATUS_SPOOLING
                        is_printing = bool(status & 0x00000001) or bool(status & 0x00000010)
                        if is_printing or j.get('TotalPages', 0) > 0:
                            active.append({
                                'printer': name,
                                'document': j.get('pDocument', 'Không rõ'),
                                'job_id': j.get('JobId', 0),
                                'is_printing': is_printing,
                                'pages': j.get('TotalPages', 0),
                                'submitted': j.get('pDatatype', 'Không rõ'),
                            })
                finally:
                    win32print.ClosePrinter(handle)
            except Exception:
                pass
        return active
    except Exception:
        return []

_printer_lock = threading.Lock()
_printer_job_lock = threading.Lock()

# WHY: Snapshot diff mechanism — so sánh job list hiện tại với lần quét trước.
# Job biến mất = completed (không phân biệt success/cancel/error).
# Không xài EventLogs vì GDI printers không tạo Event ID 307.
# Cần frontend poll auto-detect mỗi 5s để không miss job.
def detect_completed_print_jobs():
    """
    Phát hiện các lệnh in mới hoàn thành.
    
    Cơ chế:
    1. Quét tất cả job hiện tại của mỗi máy in
    2. So sánh với snapshot trước đó (_printer_prev_jobs)
    3. Job nào từng tồn tại mà nay biến mất → đã hoàn thành
    4. Cập nhật snapshot mới
    
    ⚠️ Hạn chế:
    - Không phân biệt được in thành công vs bị hủy
    - Chỉ phát hiện được nếu frontend gọi auto-detect liên tục
    - Job biến mất có thể do hủy, lỗi, hoặc hoàn thành
    
    Returns: list [{printer, document, job_id}]
    """
    global _printer_prev_jobs
    try:
        import win32print
        results = []
        flags = win32print.PRINTER_ENUM_LOCAL
        current_jobs = {}
        
        # Quét tất cả local printers
        for p in win32print.EnumPrinters(flags):
            name = p[2]
            try:
                handle = win32print.OpenPrinter(name)
                try:
                    jobs = win32print.EnumJobs(handle, 0, 100, 2)  # Level 2 = JOB_INFO_2 (có TotalPages)
                    current_jobs[name] = {}
                    for j in jobs:
                        jid = j.get('JobId', 0)
                        status = j.get('Status', 0)
                        doc = j.get('pDocument', '')
                        # Lấy TotalPages từ JOB_INFO_2
                        pages = j.get('TotalPages', 0) or 0
                        current_jobs[name][jid] = {'status': status, 'doc': doc, 'total_pages': pages}
                finally:
                    win32print.ClosePrinter(handle)
            except Exception:
                pass
        
        # So sánh: job cũ biến mất = đã hoàn thành
        with _printer_job_lock:
            for name, old_jobs in _printer_prev_jobs.items():
                new_jobs = current_jobs.get(name, {})
                for jid, old_data in old_jobs.items():
                    if jid not in new_jobs:
                        # Ghi nhận TotalPages từ job đã hoàn thành
                        old_pages = old_data.get('total_pages', 0) or 0
                        results.append({
                            'printer': name,
                            'document': old_data.get('doc', ''),
                            'job_id': jid,
                            'total_pages': old_pages,
                        })
            _printer_prev_jobs = current_jobs  # Cập nhật snapshot
        
        return results
    except Exception:
        return []

# WHY: Thread-safe read với _printer_file_lock (dùng chung với settings).
# Stats có thể được ghi đồng thời từ auto-detect và manual print API.
def load_printer_stats():
    """Đọc thống kê in ấn từ file JSON (thread-safe)"""
    with _printer_file_lock:
        try:
            if os.path.exists(PRINTER_STATS_FILE):
                with open(PRINTER_STATS_FILE, 'r') as f:
                    return json.load(f)
        except Exception:
            pass
    return {'total_prints': 0, 'printers': {}}

# WHY: Thread-safe write — stats là cumulative data, mất data do race condition là nghiêm trọng.
def save_printer_stats(stats):
    """Ghi thống kê in ấn vào file JSON (thread-safe)"""
    with _printer_file_lock:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        with open(PRINTER_STATS_FILE, 'w') as f:
            json.dump(stats, f, indent=2)

# WHY: Gọi từ auto-detect + manual log. Recent_docs giữ 20 documents gần nhất để UI hiển thị.
# Cập nhật cumulative total_prints — không bao giờ giảm (append-only).
def add_print_stats_entry(printer_name, document=''):
    """
    Cập nhật thống kê khi phát hiện in xong.
    - Tăng total_prints toàn cục
    - Cập nhật last_print, first_print cho từng máy
    - Lưu recent_docs (tối đa 20 documents gần nhất)
    """
    stats = load_printer_stats()
    stats['total_prints'] = stats.get('total_prints', 0) + 1
    now = datetime.now().strftime('%d/%m/%y %H:%M:%S')
    
    if printer_name not in stats['printers']:
        stats['printers'][printer_name] = {
            'total': 0,
            'last_print': None,
            'first_print': None,
            'is_laser': is_laser_printer(printer_name),
        }
    
    p = stats['printers'][printer_name]
    p['total'] = p.get('total', 0) + 1
    p['last_print'] = now
    if not p.get('first_print'):
        p['first_print'] = now
    if document and document != 'Không rõ':
        recent_docs = p.get('recent_docs', [])
        recent_docs.insert(0, document[:50])
        p['recent_docs'] = recent_docs[:20]
    
    save_printer_stats(stats)
    return stats

def auto_increment_page_count(printer_name, known_pages=0):
    """
    Tự động tăng page_count khi phát hiện in xong.
    
    Cơ chế 3 lớp:
    1. Nếu known_pages > 0 (từ detect_completed_print_jobs JOB_INFO_2):
       - Dùng số trang thực tế (ưu tiên cao nhất)
    2. Đọc JobCountSinceLastReset từ WMI, so sánh với _last_job_count
       - Chỉ tính diff khi printer_name ĐÃ CÓ trong _last_job_count
       - Lần đầu: lưu giá trị WMI làm baseline, KHÔNG increment từ WMI
    3. Fallback: nếu WMI = 0 hoặc lỗi → dùng known_pages nếu có, nếu không tăng 1
    
    Args:
        printer_name: Tên máy in
        known_pages: Số trang thực tế từ JOB_INFO_2 (0 = không biết)
    Returns:
        int: page_count mới, hoặc None nếu lỗi
    """
    global _last_job_count
    
    # Ưu tiên 1: known_pages từ JOB_INFO_2 (chính xác nhất)
    if known_pages > 0:
        increment = known_pages
        debug_log(f"Using JOB_INFO_2 pages for {printer_name}: +{increment}")
    else:
        increment = 1  # Fallback mặc định
        # Ưu tiên 2: WMI JobCountSinceLastReset
        try:
            # Khởi tạo COM với Multithreaded Apartment cho Flask threaded mode
            try:
                pythoncom.CoInitializeEx(pythoncom.COINIT_MULTITHREADED)
            except Exception:
                try:
                    pythoncom.CoInitialize()
                except Exception:
                    pass
            
            try:
                import win32com.client
                wmi = win32com.client.Dispatch("WbemScripting.SWbemLocator").ConnectServer(".", "root\\CIMV2")
                query = f'SELECT * FROM Win32_Printer WHERE Name LIKE "%{printer_name}%"'
                printers = wmi.ExecQuery(query)
                if printers:
                    p = printers[0]
                    current_count = getattr(p, 'JobCountSinceLastReset', None)
                    if current_count is not None:
                        try:
                            cnt = int(current_count)
                            with _last_job_count_lock:
                                # Chỉ tính diff khi đã có baseline (tránh spike lần đầu)
                                if printer_name in _last_job_count:
                                    last = _last_job_count[printer_name]
                                    if cnt > last:
                                        increment = cnt - last
                                        debug_log(f"WMI JobCount auto-inc for {printer_name}: {last} -> {cnt} (diff={increment})")
                                # Lưu baseline (lần đầu hoặc cập nhật)
                                _last_job_count[printer_name] = cnt
                        except (ValueError, TypeError):
                            pass
            finally:
                try:
                    pythoncom.CoUninitialize()
                except Exception:
                    pass
        except Exception:
            pass
    
    # Cập nhật page_count trong settings
    try:
        settings = load_printer_settings()
        page_count = settings.get('page_count', {})
        current_pc = page_count.get(printer_name, 0)
        new_pc = current_pc + increment
        page_count[printer_name] = new_pc
        settings['page_count'] = page_count
        save_printer_settings(settings)
        
        debug_log(f"Auto-increment page_count for {printer_name}: {current_pc} -> {new_pc} (+{increment})")
        return new_pc
    except Exception as e:
        debug_log(f"Auto-increment page_count error: {e}")
        return None

@app.route("/api/printer/stats")
# WHY: Inject is_laser vào stats response — frontend cần để quyết định hiển thị reminder/countdown.
# Laser printers không cần nhắc chống khô mực.
def api_printer_stats():
    """GET /api/printer/stats — Lấy thống kê in ấn"""
    stats = load_printer_stats()
    for name, data in stats.get('printers', {}).items():
        if 'is_laser' not in data:
            data['is_laser'] = is_laser_printer(name)
    return jsonify({'stats': stats})

@app.route("/api/printer/activity")
# WHY: GET-only (không POST) vì là read-only query. Frontend poll mỗi 5s.
# Delegate to get_printing_activity() — shared helper dùng bởi auto-detect.
def api_printer_activity():
    """GET /api/printer/activity — Kiểm tra máy in nào đang hoạt động"""
    active_jobs = get_printing_activity()
    return jsonify({'active_jobs': active_jobs})

@app.route("/api/printer/auto-detect", methods=["POST"])
# WHY: POST vì có side effect (ghi history + stats). Dùng detect_completed_print_jobs() snapshot diff.
# GDI printers không có EventLog → đây là cơ chế duy nhất để auto-detect.
def api_printer_auto_detect():
    """
    POST /api/printer/auto-detect
    Phát hiện tự động các lệnh in mới hoàn thành.
    Gọi từ frontend mỗi 5 giây → lưu vào history + stats.
    """
    try:
        completed = detect_completed_print_jobs()
        results = []
        for job in completed:
            printer_name = job['printer']
            document = job.get('document', '')
            job_pages = job.get('total_pages', 0) or 0
            entry = add_print_history_entry(
                f"Tự động: {document} ({job_pages} trang)" if document else "Phát hiện in tự động",
                printer_name
            )
            add_print_stats_entry(printer_name, document)
            # Tự động tăng page_count với số trang thực tế từ job info
            auto_increment_page_count(printer_name, job_pages)
            if entry:
                results.append(entry)
        return jsonify({'detected': results, 'count': len(results)})
    except Exception as e:
        return jsonify({'error': str(e), 'detected': [], 'count': 0})

# ═══════════════════════════════════════════════════════════════
# PRINTER REMINDER APIs
# Lịch sử in, nhắc nhở chống khô mực cho máy inkjet
# ═══════════════════════════════════════════════════════════════
#
# Cơ chế reminder:
#   - Chỉ áp dụng cho máy INKJET (bỏ qua laser vì không sợ khô mực)
#   - Dùng days_between_prints (mặc định 5 ngày) làm chu kỳ
#   - So sánh last_print_date + days_between_prints vs datetime.now()
#   - Frontend gọi reminder-check mỗi 5 giây để cập nhật UI
#
# Lịch sử in:
#   - Lưu trong printer_history.json (tối đa 200 entries gần nhất)
#   - Mỗi entry: {datetime, action, printer}
#   - Tự động thêm khi: in thử, auto-detect, ghi nhận thủ công
#   - Có thể xóa từng entry hoặc xóa tất cả
# ═══════════════════════════════════════════════════════════════

# WHY: Shared helper gọi từ auto-detect, manual log, và import.
# Tự động cập nhật last_print_date trong settings khi thêm entry.
def add_print_history_entry(action, printer_name):
    """
    Thêm entry vào lịch sử in.
    Tự động cập nhật last_print_date trong settings.
    
    Args:
        action: Mô tả hành động (VD: "Đã in trang thử", "In thủ công")
        printer_name: Tên máy in
    Returns:
        entry dict hoặc None nếu lỗi
    """
    now = datetime.now().strftime('%d/%m/%y %H:%M:%S')
    entry = {
        'datetime': now,
        'action': action,
        'printer': printer_name,
    }
    with _printer_file_lock:
        try:
            CONFIG_DIR.mkdir(parents=True, exist_ok=True)
            history = []
            if os.path.exists(PRINTER_HISTORY_FILE):
                with open(PRINTER_HISTORY_FILE, 'r') as f:
                    history = json.load(f)
            history.insert(0, entry)  # Thêm vào đầu danh sách
            history = history[:200]    # Giới hạn 200 entries
            with open(PRINTER_HISTORY_FILE, 'w') as f:
                json.dump(history, f, indent=2)
        except Exception as e:
            print(f"[printer] Failed to save history: {e}")
            return None
    
    # Đồng thời cập nhật last_print_date trong settings
    settings = load_printer_settings()
    settings['last_print_date'] = now
    save_printer_settings(settings)
    
    return entry

@app.route("/api/printer/log", methods=["GET", "POST"])
# WHY: GET/POST cùng endpoint — POST ghi log, GET đọc last_print_date + settings.
# Dùng chung add_print_history_entry để consistent format với auto-detect.
def api_printer_log():
    """
    GET/POST /api/printer/log
    POST: Ghi nhận lịch sử in thủ công
    GET: Lấy thông tin lần in cuối + chu kỳ
    """
    if request.method == "POST":
        data = request.get_json() or {}
        action = data.get('action', 'Cập nhật thủ công')
        printer_name = data.get('printer_name', 'Không rõ')
        entry = add_print_history_entry(action, printer_name)
        return jsonify({'status': 'saved', 'entry': entry})
    
    settings = load_printer_settings()
    return jsonify({
        'last_print_date': settings.get('last_print_date'),
        'days_between_prints': settings.get('days_between_prints', 5),
    })

@app.route("/api/printer/history")
# WHY: GET-only — đọc toàn bộ history file. Frontend filter/search phía client.
# History file được ghi bởi auto-detect + manual log + import.
def api_printer_history():
    """GET /api/printer/history — Lấy toàn bộ lịch sử in"""
    try:
        if os.path.exists(PRINTER_HISTORY_FILE):
            with open(PRINTER_HISTORY_FILE, 'r') as f:
                history = json.load(f)
            return jsonify({'history': history})
        return jsonify({'history': []})
    except Exception as e:
        return jsonify({'history': [], 'error': str(e)}), 500

@app.route("/api/printer/history", methods=["POST"])
# WHY: POST riêng — cho phép thêm entry với datetime cụ thể (VD: nhập lại lịch sử cũ).
# Tách biệt với auto-detect để frontend có kiểm soát khi nào gọi.
def api_printer_add_history():
    """
    POST /api/printer/history
    Thêm entry thủ công vào lịch sử (có thể chỉ định datetime).
    """
    data = request.get_json() or {}
    dt = data.get('datetime')
    action = data.get('action', 'Nhập thủ công')
    printer = data.get('printer', 'Không rõ')
    
    try:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        history = []
        if os.path.exists(PRINTER_HISTORY_FILE):
            with open(PRINTER_HISTORY_FILE, 'r') as f:
                history = json.load(f)
        
        entry = {'datetime': dt or datetime.now().strftime('%d/%m/%y %H:%M:%S'), 'action': action, 'printer': printer}
        history.insert(0, entry)
        history = history[:200]
        with open(PRINTER_HISTORY_FILE, 'w') as f:
            json.dump(history, f, indent=2)
        return jsonify({'status': 'added', 'entry': entry})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route("/api/printer/history", methods=["DELETE"])
# WHY: DELETE với optional index — nếu không có index, xóa TOÀN BỘ history.
# Frontend confirm trước khi gọi (undo không khả dụng).
def api_printer_delete_history():
    """
    DELETE /api/printer/history?index=N
    Xóa entry khỏi lịch sử (theo index).
    Nếu không có index → xóa tất cả.
    """
    idx = request.args.get('index', type=int)
    try:
        if not os.path.exists(PRINTER_HISTORY_FILE):
            return jsonify({'error': 'Không có lịch sử'}), 404
        with open(PRINTER_HISTORY_FILE, 'r') as f:
            history = json.load(f)
        if idx is not None and 0 <= idx < len(history):
            removed = history.pop(idx)
            with open(PRINTER_HISTORY_FILE, 'w') as f:
                json.dump(history, f, indent=2)
            return jsonify({'status': 'deleted', 'removed': removed})
        else:
            # Clear all if no index specified
            with open(PRINTER_HISTORY_FILE, 'w') as f:
                json.dump([], f)
            return jsonify({'status': 'cleared'})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route("/api/printer/reminder-check")
# WHY: Pure GET (read-only) — frontend poll mỗi 5s để cập nhật countdown trên UI.
# Days_between_prints + minutes_left tính đến từng phút chính xác.
# Laser bypass để tránh reminder vô ích (mực laser không khô như inkjet).
def api_printer_reminder_check():
    """
    GET /api/printer/reminder-check
    Kiểm tra xem đã đến lúc nhắc nhở in chưa.
    
    Logic:
    1. Nếu máy in là LASER → bỏ qua (is_laser = True)
    2. Nếu chưa từng in → should_remind = True
    3. Tính days_left = days_between_prints - (now - last_print)
    4. Nếu days_left <= 0 → should_remind = True
    
    Returns:
        {should_remind, last_print, days_left, message, is_laser?}
    """
    settings = load_printer_settings()
    selected = settings.get('selected_printer', '')
    
    # Bỏ qua nhắc nhở nếu máy in là laser (không sợ khô mực)
    if selected and is_laser_printer(selected):
        return jsonify({
            'should_remind': False,
            'last_print': settings.get('last_print_date'),
            'days_left': 999,
            'message': 'Máy in laser - bỏ qua nhắc nhở',
            'is_laser': True,
        })
    
    last_print = settings.get('last_print_date')
    days_between = settings.get('days_between_prints', 5)
    
    if not last_print:
        return jsonify({
            'should_remind': True,
            'last_print': None,
            'days_left': 0,
            'message': 'Chưa có lịch sử in',
        })
    
    try:
        from datetime import datetime, timedelta
        last = datetime.strptime(last_print, '%d/%m/%y %H:%M:%S')
        next_due = last + timedelta(days=days_between)
        now = datetime.now()
        
        if now >= next_due:
            time_overdue = now - next_due
            days_overdue = time_overdue.days
            hours_overdue = time_overdue.seconds // 3600
            return jsonify({
                'should_remind': True,
                'last_print': last_print,
                'days_left': 0,
                'message': f'Quá hạn {days_overdue} ngày {hours_overdue} giờ',
            })
        else:
            time_left = next_due - now
            return jsonify({
                'should_remind': False,
                'last_print': last_print,
                'days_left': time_left.days,
                'hours_left': time_left.seconds // 3600,
                'minutes_left': (time_left.seconds % 3600) // 60,
                'message': f'Còn {time_left.days} ngày {time_left.seconds // 3600} giờ',
            })
    except Exception as e:
        debug_log(f"LỖI api_printer_reminder_check: {e}")
        return jsonify({'should_remind': False, 'error': str(e)}), 500

@app.route("/api/printer/settings", methods=["GET", "POST"])
# WHY: GET/POST cùng endpoint — load/save settings.
# Frontend gửi TOÀN BỘ object thay vì partial update để đơn giản hóa logic phía client.
def api_printer_settings():
    """Lấy hoặc cập nhật cài đặt máy in"""
    if request.method == "POST":
        data = request.get_json() or {}
        settings = load_printer_settings()
        if 'days_between_prints' in data:
            settings['days_between_prints'] = int(data['days_between_prints'])
        if 'selected_printer' in data:
            settings['selected_printer'] = data['selected_printer']
        if 'remind_minutes' in data:
            settings['remind_minutes'] = int(data['remind_minutes'])
        if 'reminder_enabled' in data:
            settings['reminder_enabled'] = bool(data['reminder_enabled'])
        if 'excluded_printers' in data:
            settings['excluded_printers'] = list(data['excluded_printers'])
        if 'page_count' in data:
            settings['page_count'] = data['page_count']
        if 'delete_page_count' in data:
            # Xóa page_count entry cho printer cụ thể
            printer_to_delete = data['delete_page_count']
            if 'page_count' in settings and printer_to_delete in settings['page_count']:
                del settings['page_count'][printer_to_delete]
        save_printer_settings(settings)
        return jsonify({'status': 'saved', 'settings': settings})
    
    settings = load_printer_settings()
    return jsonify({'settings': settings})

# ═══════════════════════════════════════════════════════════════
# WMI STATUS — Endpoint quan trọng nhất cho Printer module
# ═══════════════════════════════════════════════════════════════
#
# Kiến trúc Hybrid 3 lớp:
#   1. win32print.GetPrinter() — LUÔN chạy trước, cho status cơ bản
#      - Hoạt động với MỌI máy in (USB, Network, Virtual)
#      - Trả về: status, driver_name, port_name, jobs
#
#   2. WMI (Win32_Printer) — Thông tin mở rộng
#      - ExtendedPrinterStatus, DetectedErrorState
#      - Capabilities, PrinterPaperNames
#      - JobCountSinceLastReset, HorizontalResolution...
#      ⚠️ USB inkjets (EPSON) thường trả về 0 hoặc null
#
#   3. PowerShell Get-PrintConfiguration — Độ phân giải in
#      - Chỉ hoạt động nếu printer driver hỗ trợ
#
# ⚠️ Lưu ý COM:
#   - Flask threaded=True → mỗi request là thread riêng
#   - Dùng CoInitializeEx(COINIT_MULTITHREADED) thay vì CoInitialize()
#   - try/except quanh CoInitialize/CoUninitialize để tránh crash
#
# ⚠️ Xử lý lỗi:
#   - Nếu WMI lỗi → vẫn trả về data từ win32print (không mất)
#   - Nếu win32print lỗi → status = 'Không rõ'
#   - Luôn có fallback về giá trị mặc định
# ═══════════════════════════════════════════════════════════════

@app.route("/api/printer/wmi-status")
# WHY: Hybrid approach — win32print cho status nhanh, WMI cho chi tiết (resolution, color, capabilities),
# PowerShell cho error_state + extended_status (WMI có thể thiếu thông tin).
# Cached 5s để tránh query WMI liên tục (WMI query có thể chậm ~200-500ms).
def api_printer_wmi_status():
    """
    GET /api/printer/wmi-status?printer=NAME
    
    Kiểm tra trạng thái chi tiết của máy in.
    Hybrid: win32print + WMI + PowerShell
    
    Query params:
        printer: Tên máy in (optional, fallback về selected_printer)
    
    Returns:
        online, status, printer, driver_name, port_name, jobs,
        page_resolution, extended_status, wmi_status, error_state,
        error_code, job_count_since_reset, average_pages_per_minute,
        horizontal_resolution, vertical_resolution, supports_color,
        capabilities, print_processor, paper_sizes
    """
    # Khởi tạo COM với Multithreaded Apartment cho Flask threaded mode
    try:
        pythoncom.CoInitializeEx(pythoncom.COINIT_MULTITHREADED)
    except Exception:
        try:
            pythoncom.CoInitialize()
        except Exception:
            pass
    
    try:
        # Ưu tiên query param, fallback về settings
        printer_name = request.args.get('printer', '')
        if not printer_name:
            settings = load_printer_settings()
            printer_name = settings.get('selected_printer', '')
        if not printer_name:
            try:
                import win32print
                printer_name = win32print.GetDefaultPrinter()
            except Exception:
                return jsonify({'online': False, 'status': 'Chưa chọn máy in'})
        
        # === 1. LUÔN lấy status từ win32print (luôn hoạt động cho USB inkjet) ===
        win32_status = 'Không rõ'
        win32_driver = ''
        win32_port = ''
        win32_jobs = 0
        try:
            import win32print
            handle = win32print.OpenPrinter(printer_name)
            info = win32print.GetPrinter(handle, 2)
            status = info.get('Status', 0) or 0
            if status == 0: win32_status = 'Sẵn sàng'
            elif status & 0x00000002: win32_status = 'Lỗi'
            elif status & 0x00000010: win32_status = 'Hết giấy'
            elif status & 0x00000020: win32_status = 'Đang in'
            elif status & 0x00000040: win32_status = 'Ngoại tuyến'
            elif status & 0x00000080: win32_status = 'Kẹt giấy'
            else: win32_status = f'Trạng thái: {status}'
            win32_driver = info.get('pDriverName', '')
            win32_port = info.get('pPortName', '')
            win32_jobs = info.get('cJobs', 0)
            win32print.ClosePrinter(handle)
        except Exception:
            pass
        
        # === 2. WMI cho thông tin mở rộng ===
        def safe_get(obj, attr, default=0):
            val = getattr(obj, attr, None)
            if val is None:
                return default
            try:
                return int(val) if val is not None else default
            except (ValueError, TypeError):
                return default
        
        wmi_details = {
            'extended_status': 0, 'wmi_status': '',
            'error_state': '', 'error_code': 0,
            'job_count_since_reset': 0, 'average_pages_per_minute': 0,
            'horizontal_resolution': 0, 'vertical_resolution': 0,
            'supports_color': False, 'capabilities': [], 'print_processor': '',
        }
        try:
            import win32com.client
            wmi = win32com.client.Dispatch("WbemScripting.SWbemLocator").ConnectServer(".", "root\\CIMV2")
            query = f'SELECT * FROM Win32_Printer WHERE Name LIKE "%{printer_name}%"'
            printers = wmi.ExecQuery(query)
            
            if printers:
                p = printers[0]
                
                # Trạng thái WMI (ExtendedPrinterStatus)
                status_map = {
                    1: 'Khác', 2: 'Không rõ', 3: 'Sẵn sàng', 4: 'Đang in',
                    5: 'Đang khởi động', 6: 'Đã dừng', 7: 'Ngoại tuyến',
                    8: 'Đã tạm dừng', 9: 'Lỗi', 10: 'Đang bận'
                }
                ext_status = getattr(p, 'ExtendedPrinterStatus', 2)
                wmi_status = status_map.get(ext_status, 'Sẵn sàng')
                
                # Trạng thái lỗi chi tiết
                error_map = {
                    0: 'Không rõ', 1: 'Khác', 2: 'Không lỗi',
                    3: 'Mực in yếu', 4: 'Hết mực',
                    5: 'Máy in yếu', 6: 'Hết mực',
                    7: 'Kẹt giấy', 8: 'Hết giấy',
                    9: 'Cần nạp giấy thủ công', 10: 'Lỗi giấy',
                    11: 'Ngoại tuyến', 12: 'Cần can thiệp',
                    13: 'Cần thêm vật tư'
                }
                detected_error = getattr(p, 'DetectedErrorState', 0)
                if detected_error is None:
                    detected_error = 0
                error_str = error_map.get(detected_error, 'Không rõ')
                
                # Capabilities
                caps = getattr(p, 'CapabilityDescriptions', None)
                capabilities = []
                if caps:
                    try: capabilities = list(caps)
                    except Exception: pass
                
                # Hỗ trợ màu
                supports_color = False
                color_caps = getattr(p, 'Capabilities', None)
                if color_caps:
                    try:
                        for c in color_caps:
                            if c == 4 or c == 64:
                                supports_color = True
                                break
                    except Exception: pass
                
                # Paper sizes (from PrinterPaperNames)
                paper_names = getattr(p, 'PrinterPaperNames', None)
                paper_sizes = []
                if paper_names:
                    try:
                        paper_sizes = list(paper_names)
                    except Exception:
                        pass
                
                wmi_details = {
                    'extended_status': ext_status,
                    'wmi_status': wmi_status,
                    'error_state': error_str if detected_error > 2 else '',
                    'error_code': detected_error,
                    'job_count_since_reset': safe_get(p, 'JobCountSinceLastReset', 0),
                    'average_pages_per_minute': safe_get(p, 'AveragePagesPerMinute', 0),
                    'horizontal_resolution': safe_get(p, 'HorizontalResolution', 0),
                    'vertical_resolution': safe_get(p, 'VerticalResolution', 0),
                    'supports_color': supports_color,
                    'capabilities': capabilities[:10] if capabilities else [],
                    'print_processor': getattr(p, 'PrintProcessor', ''),
                    'paper_sizes': paper_sizes[:15] if paper_sizes else [],
                }
        except ImportError:
            pass
        except Exception as e:
            debug_log(f"WMI query error: {e}")
        
        # === 3. PowerShell cho độ phân giải in (Get-PrintConfiguration) ===
        page_resolution = ''
        try:
            escaped_name = printer_name.replace("'", "''")
            ps_cmd = f'Get-PrintConfiguration -PrinterName \"{escaped_name}\" | Select-Object -ExpandProperty PageResolution'
            result = subprocess.run(
                ['powershell', '-NoProfile', '-Command', ps_cmd],
                capture_output=True, text=True, timeout=5,
                startupinfo=get_startupinfo(),
                creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
            )
            if result.returncode == 0:
                res = result.stdout.strip()
                if res and 'PageResolution' not in res:
                    page_resolution = res
        except Exception:
            pass
        
        # === 4. QUYẾT ĐỊNH status: ưu tiên win32print, fallback WMI ===
        final_status = win32_status
        if win32_status == 'Không rõ':
            wmi_ext = wmi_details.get('extended_status', 0)
            if wmi_ext not in (0, 2):
                final_status = wmi_details.get('wmi_status', 'Không rõ')
        
        # === 5. Kết hợp ===
        result = {
            'online': win32_status != 'Ngoại tuyến',
            'status': final_status,
            'printer': printer_name,
            'driver_name': win32_driver,
            'port_name': win32_port,
            'jobs': win32_jobs,
            'page_resolution': page_resolution or '',
            **wmi_details,
        }
        
        return jsonify(result)
    except Exception as e:
        debug_log(f"LỖI api_printer_wmi_status: {e}")
        return jsonify({'online': False, 'status': str(e), 'printer': printer_name}), 500
    finally:
        try:
            pythoncom.CoUninitialize()
        except Exception:
            pass

# ═══════════════════════════════════════════════════════════════
# PRINTER PAGE COUNT
# Đọc tổng số trang đã in (khả năng hạn chế với USB printers)
# ═══════════════════════════════════════════════════════════════
#
# ⚠️ GIỚI HẠN KỸ THUẬT (quan trọng) — Đã được kiểm chứng thực tế:
#   - WMI Win32_Printer.JobCountSinceLastReset = 0 cho USB inkjets
#   - PJL (@PJL INFO PAGECOUNT) chỉ hoạt động với Brother/HP/network
#   - Không thể CreateFile trên \\.\USB002 (không phải DOS device path)
#   - WritePrinter là write-only (không đọc được response)
#   - EventLogs (Event ID 307) KHÔNG ghi nhận RAW print jobs
#
# 📖 NGHIÊN CỨU ESC/P-R (EPSON):
#   - ESC/P-R là giao thức in raster MỘT CHIỀU (write-only)
#   - Hoàn toàn KHÔNG có lệnh để đọc thông tin từ máy in
#   - Các lệnh D4/D5/D6/D7 chỉ dùng cho máy POS/nhãn, không phải EcoTank
#   - EPSON Status Monitor dùng driver proprietary RIÊNG (không qua USB Printing Class)
#   - Giao tiếp qua Bulk endpoint với payload mã hóa, không tài liệu công khai
#   - Repo duy nhất: epson_print_conf (Ircama, GitHub) — chỉ hoạt động qua SNMP (network)
#   - Các máy L-series mới (L3250, L3260...) đã bị khóa SNMP
#   - Để reverse engineer cần: Wireshark + USBPcap + phân tích binary (ước tính 2-4 tuần)
#
# 🧪 KẾT QUẢ TEST THỰC TẾ (đã kiểm chứng):
#   - EPSON L3210: in thử RAW (PCL) → máy bỏ qua (dùng ESC/P-R, không hiểu PCL) → EventLog null
#   - Brother HL-2240D: in thử RAW (PCL) → máy nhận nhưng RAW job không qua driver → EventLog null
#   - Cả 2 máy đều trả về page_count = null, source = null
#
# ✅ KẾT LUẬN CUỐI CÙNG:
#   - KHÔNG THỂ đọc lifetime page count từ USB printer tự động
#   - Manual entry là GIẢI PHÁP DUY NHẤT khả thi
#   - Nếu cần đọc lifetime page count qua USB, phải:
#     * Reverse engineer driver EPSON (Wireshark + USBPcap), 2-4 tuần
#     * Hoặc dùng LibUSB/WinUSB với custom protocol (cần RE trước)
#
# Giải pháp hiện tại:
#   1. EventLogs (PrintService/Operational, Event ID 307)
#      - Đếm số trang từ các job đã hoàn thành GẦN ĐÂY
#      - Chỉ ghi nhận job qua driver chuẩn (EMF/XPS), KHÔNG ghi RAW
#      - Không cho lifetime total (log rotate)
#   2. WMI JobCountSinceLastReset (luôn = 0 cho USB)
#   3. Manual entry (người dùng nhập thủ công trong settings) ← KHUYẾN NGHỊ
# ═══════════════════════════════════════════════════════════════

def _get_cached_printer_info(printer_name, driver_name=""):
    """Lấy thông tin driver máy in (có cache 5 phút)"""
    with _printer_info_cache_lock:
        cached = _printer_info_cache.get(printer_name)
        if cached and (time.time() - cached['cached_at']) < PRINTER_INFO_CACHE_TTL:
            return cached['info']
    
    info = _detect_printer_info(printer_name, driver_name)
    with _printer_info_cache_lock:
        _printer_info_cache[printer_name] = {'info': info, 'cached_at': time.time()}
    return info

def _query_active_print_jobs(printer_name):
    """
    Đếm số job đang active trong spooler queue.
    Dùng cho real-time detection (auto_increment), KHÔNG phải lịch sử.
    
    Lưu ý: Chỉ đếm jobs hiện tại, không trả về lịch sử trang đã in.
    Dữ liệu lịch sử chỉ có từ EventLog (cho PCL/PostScript) hoặc manual count.
    
    Returns:
        int (số jobs trong queue) hoặc None nếu lỗi
    """
    try:
        ps_cmd = (
            f'Get-PrintJob -PrinterName "{printer_name}" -ErrorAction SilentlyContinue | '
            'Measure-Object | Select-Object -ExpandProperty Count'
        )
        result = subprocess.run(
            ['powershell', '-NoProfile', '-Command', ps_cmd],
            capture_output=True, text=True, timeout=10,
            startupinfo=get_startupinfo(),
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
        )
        if result.returncode == 0 and result.stdout.strip():
            count = int(result.stdout.strip())
            if count > 0:
                debug_log(f"Active jobs for {printer_name}: {count} (Get-PrintJob)")
            return count
    except Exception as e:
        debug_log(f"Get-PrintJob error for {printer_name}: {e}")
    
    try:
        try:
            pythoncom.CoInitializeEx(pythoncom.COINIT_MULTITHREADED)
        except Exception:
            try:
                pythoncom.CoInitialize()
            except Exception:
                pass
        
        import win32com.client
        wmi = win32com.client.Dispatch("WbemScripting.SWbemLocator").ConnectServer(".", "root\\CIMV2")
        safe_name = printer_name.replace("'", "''")
        query = f"SELECT * FROM Win32_PrintJob WHERE Name LIKE '%{safe_name}%'"
        jobs = wmi.ExecQuery(query)
        count = len(jobs)
        if count > 0:
            debug_log(f"Active jobs for {printer_name}: {count} (Win32_PrintJob)")
        return count
    except Exception as e:
        debug_log(f"Win32_PrintJob error for {printer_name}: {e}")
    
    return None

def query_printer_page_count_eventlogs(printer_name, port_name):
    """
    Đọc tổng số trang từ Event Logs Windows (PrintService/Operational).
    
    Cơ chế Hybrid 4 lớp:
    1. PrinterMonitor C#/PS module (ưu tiên cao nhất)
    2. PowerShell EventLog (Properties[7]) — dành cho PCL/PostScript printers (EPSON, HP...)
    3. WMI + Get-PrintJob — dành cho GDI/host-based printers (Brother HL-2240D...)
    4. Cache 30s TTL
    
    Args:
        printer_name: Tên máy in (VD: "EPSON L3210 Series")
        port_name: Cổng (VD: "USB002") — không dùng, giữ cho tương thích
    Returns:
        int (số trang) hoặc None nếu không đọc được
    """
    # Lớp 0: Phát hiện loại driver printer
    # GDI printers (Brother HL-2240D) often don't generate Event ID 307
    printer_info = _get_cached_printer_info(printer_name)
    is_gdi = (printer_info.get('driver_type') == 'gdi')
    
    # Lớp 1: PrinterMonitor C# module (ưu tiên cao nhất, nhanh nhất)
    try:
        cs_result = query_printer_monitor_cs(printer_name, "query", timeout=10)
        if cs_result and cs_result.get('page_count') is not None:
            count = int(cs_result['page_count'])
            if count > 0:
                with _eventlog_cache_lock:
                    _eventlog_cache[printer_name] = {'count': count, 'cached_at': time.time()}
                debug_log(f"EventLog count for {printer_name}: {count} (C#/PS module)")
                return count
    except Exception as e:
        debug_log(f"C#/PS module query error: {e}")
    
    # Lớp 2: Kiểm tra cache (30s TTL)
    with _eventlog_cache_lock:
        cached = _eventlog_cache.get(printer_name)
        if cached and (time.time() - cached['cached_at']) < 30:
            debug_log(f"EventLog count CACHED for {printer_name}: {cached['count']}")
            return cached['count']
    
    # Lớp 3: PowerShell EventLog (chỉ cho PCL/PostScript printers, 
    # GDI printers thường không tạo Event ID 307)
    if not is_gdi:
        try:
            ps_cmd = (
                'Get-WinEvent -FilterHashtable @{LogName="Microsoft-Windows-PrintService/Operational";'
                'ID=307;StartTime=(Get-Date).AddDays(-30)} -ErrorAction SilentlyContinue | '
                f'Where-Object {{ $_.Properties[4].Value -like "*{printer_name}*" }} | '
                'Select-Object @{N="Pages";E={$_.Properties[7].Value}} | '
                'Measure-Object -Property Pages -Sum | Select-Object -ExpandProperty Sum'
            )
            result = subprocess.run(
                ['powershell', '-NoProfile', '-Command', ps_cmd],
                capture_output=True, text=True, timeout=10,
                startupinfo=get_startupinfo(),
                creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
            )
            if result.returncode == 0 and result.stdout.strip():
                count = int(float(result.stdout.strip()))
                if count > 0:
                    with _eventlog_cache_lock:
                        _eventlog_cache[printer_name] = {'count': count, 'cached_at': time.time()}
                    debug_log(f"EventLog count for {printer_name}: {count} (Properties[7], 30 days)")
                    return count
            
            # WHY: Properties[7] = 0 (máy in không lưu page count ở field này, hoặc chưa in trang nào)
            # Fallback: Properties[5] cho Windows cũ hơn. Không log ở đây vì Properties[7]=0
            # là code path bình thường cho nhiều máy in (VD: EPSON EP-804A).
            # Nếu cần debug, xem log phía dưới cho kết quả của Properties[5].
            ps_cmd_fb = (
                'Get-WinEvent -FilterHashtable @{LogName="Microsoft-Windows-PrintService/Operational";'
                'ID=307;StartTime=(Get-Date).AddDays(-30)} -ErrorAction SilentlyContinue | '
                f'Where-Object {{ $_.Properties[4].Value -like "*{printer_name}*" }} | '
                'Select-Object @{N="Pages";E={$_.Properties[5].Value}} | '
                'Measure-Object -Property Pages -Sum | Select-Object -ExpandProperty Sum'
            )
            result2 = subprocess.run(
                ['powershell', '-NoProfile', '-Command', ps_cmd_fb],
                capture_output=True, text=True, timeout=10,
                startupinfo=get_startupinfo(),
                creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
            )
            if result2.returncode == 0 and result2.stdout.strip():
                count = int(float(result2.stdout.strip()))
                if count > 0:
                    with _eventlog_cache_lock:
                        _eventlog_cache[printer_name] = {'count': count, 'cached_at': time.time()}
                    debug_log(f"EventLog count for {printer_name}: {count} (Properties[5] fallback, 30 days)")
                    return count
        except Exception as e:
            debug_log(f"PowerShell EventLog query error: {e}")
    else:
        debug_log(f"Printer {printer_name} is GDI (host-based) — EventLog typically empty, using WMI fallback...")
    
    # Lớp 4: WMI Get-PrintJob (chỉ cho real-time detection, không cho lịch sử)
    # GHI CHÚ QUAN TRỌNG: Get-PrintJob chỉ trả về jobs ĐANG trong queue,
    # không trả về lịch sử trang đã in. Với GDI printers (Brother HL-2240D),
    # không có cách nào để đọc lịch sử hardware page counter từ Windows API.
    # Giải pháp: dùng manual count (user nhập) + auto_increment (khi phát hiện in xong).
    if is_gdi:
        # GDI printers: không có cách đọc lịch sử → trả về None
        # App sẽ fallback về manual count trong api_printer_page_count()
        debug_log(f"GDI printer {printer_name}: EventLog không hoạt động, dùng manual count + auto_increment")
    else:
        # Non-GDI printers: EventLog đã query, nếu vẫn không có → thử WMI
        pass
    return None

@app.route("/api/printer/page-count")
# WHY: 3-layer fallback — PowerShell EventLog là chính xác nhất (có thể fail nếu log bị xóa),
# WMI JobCountSinceLastReset là fallback (luôn = 0 với USB printers),
# Manual entry từ UI là cuối cùng (user tự nhập).
# GDI printers like Brother HL-2240D không hỗ trợ bất kỳ method đọc tự động nào.
def api_printer_page_count():
    """
    GET /api/printer/page-count?printer=NAME&port=PORT
    
    Đọc tổng số trang đã in — 3 lớp fallback:
    1. EventLogs (PowerShell)
    2. WMI JobCountSinceLastReset
    3. Settings (người dùng nhập thủ công)
    
    Returns:
        {page_count: int|null, source: "pjl"|"wmi"|"manual"|null, printer: string}
    """
    printer_name = request.args.get('printer', '')
    port_name = request.args.get('port', '')
    
    if not printer_name:
        settings = load_printer_settings()
        printer_name = settings.get('selected_printer', '')
    
    if not printer_name:
        return jsonify({'page_count': None, 'source': None, 'error': 'Chưa chọn máy in', 'driver_type': None, 'tracking_method': None})
    
    # 1. EventLogs (PowerShell) — 30 ngày gần nhất, đã cache 30s
    now_str = datetime.now().strftime('%d/%m/%y %H:%M:%S')
    eventlog_count = query_printer_page_count_eventlogs(printer_name, port_name)
    
    # 2. Lấy settings
    settings = load_printer_settings()
    manual_count = settings.get('page_count', {}).get(printer_name, 0) or 0
    page_count_timestamps = settings.get('page_count_timestamp', {}) or {}
    
    # 2b. Lấy driver type info
    printer_info = _get_cached_printer_info(printer_name)
    driver_type = printer_info.get('driver_type', 'unknown')
    tracking_method = printer_info.get('tracking_method', 'eventlog')
    
    # 3. Kết hợp: EventLog (30 ngày gần nhất, persistent) + manual (lifetime baseline)
    #    - Nếu EventLog có data: dùng max(EventLog, manual) — ưu tiên số cao hơn
    #      (manual là lifetime trước khi bật log, EventLog là dữ liệu thực tế)
    #    - Khi app tắt, máy in vẫn ghi EventLog → khi mở lại app query được ngay
    #    - Ví dụ: manual=1004, EventLog=2 → hiện 1004 (giữ manual vì cao hơn)
    #             in thêm 10 trang → EventLog=12, manual=1004 → hiện 1004
    #             in thêm 2000 trang → EventLog=2002, manual=1004 → hiện 2002
    if eventlog_count is not None and eventlog_count > 0:
        # Cập nhật timestamp
        page_count_timestamps[printer_name] = now_str
        settings['page_count_timestamp'] = page_count_timestamps
        save_printer_settings(settings)
        
        # Lấy số cao nhất: EventLog (thực tế) hoặc manual (lifetime)
        if manual_count > eventlog_count:
            total = manual_count
            source = 'manual'
        else:
            total = eventlog_count
            source = 'eventlog'
        
        debug_log(f"Page count for {printer_name}: {total} ({source}, EventLog={eventlog_count}, manual={manual_count}, updated {now_str})")
        return jsonify({'page_count': total, 'source': source, 'printer': printer_name,
                        'updated_at': now_str, 'eventlog_count': eventlog_count, 'manual_count': manual_count})
    
    # 2. WMI JobCountSinceLastReset (per-session counter)
    wmi_count = 0
    try:
        import win32com.client
        try:
            pythoncom.CoInitializeEx(pythoncom.COINIT_MULTITHREADED)
        except Exception:
            try:
                pythoncom.CoInitialize()
            except Exception:
                pass
        try:
            wmi = win32com.client.Dispatch("WbemScripting.SWbemLocator").ConnectServer(".", "root\\CIMV2")
            query = f'SELECT * FROM Win32_Printer WHERE Name LIKE "%{printer_name}%"'
            printers = wmi.ExecQuery(query)
            if printers:
                p = printers[0]
                job_count = getattr(p, 'JobCountSinceLastReset', None)
                if job_count is not None:
                    cnt = int(job_count)
                    if cnt > 0:
                        wmi_count = cnt
        finally:
            try:
                pythoncom.CoUninitialize()
            except Exception:
                pass
    except Exception:
        pass
    
    # Kết hợp: manual (lifetime) + WMI (per-session additional)
    if wmi_count > 0 or manual_count > 0:
        total = manual_count + wmi_count
        source = 'combined' if (wmi_count > 0 and manual_count > 0) else ('wmi' if wmi_count > 0 else 'manual')
        return jsonify({
            'page_count': total,
            'source': source,
            'printer': printer_name,
            'driver_type': driver_type,
            'tracking_method': tracking_method,
            'updated_at': now_str
        })
    
    return jsonify({'page_count': None, 'source': None, 'printer': printer_name, 'driver_type': driver_type, 'tracking_method': tracking_method})

# ═══════════════════════════════════════════════════════════════
# PJL (Printer Job Language) — Đọc hardware diagnostics
# ═══════════════════════════════════════════════════════════════
#
# Gửi lệnh PJL qua RAW spooler để đọc:
#   - Tổng số trang hardware (@PJL INFO PAGECOUNT)
#   - Drum life remaining
#   - Toner level
#   - Trạng thái máy in
#
# Lưu ý:
#   - GDI printers (Brother HL-2240D) có PJL hạn chế qua USB
#   - Network printers hỗ trợ đầy đủ PJL qua TCP port 9100
#   - Raw spooler method: Gửi lệnh nhưng KHÓ đọc response
#     (Windows Spooler thiết kế one-way)
# ═══════════════════════════════════════════════════════════════

# Cache PJL kết quả (30 giây, tránh gửi lệnh liên tục)
_pjl_cache = {}
_pjl_cache_lock = threading.Lock()
PJL_CACHE_TTL = 30

def _send_pjl_raw(printer_name, command):
    """
    Gửi lệnh PJL qua win32print RAW spooler.
    
    Args:
        printer_name: Tên máy in
        command: Lệnh PJL (VD: b"@PJL INFO PAGECOUNT")
    
    Returns:
        bool (True nếu gửi thành công, False nếu lỗi)
    
    Lưu ý:
        GDI printers (Brother HL-2240D) có thể in ra trang chứa lệnh PJL
        thay vì xử lý lệnh. Chỉ dùng cho network printers.
    """
    try:
        import win32print
        handle = win32print.OpenPrinter(printer_name)
        try:
            # UEL sequence: bắt đầu/kết thúc phiên PJL
            uel = b"\x1b%-12345X"
            pjl_cmd = uel + command + b"\r\n" + uel
            
            job = win32print.StartDocPrinter(
                handle, 1, ("PJL Query", None, "RAW")
            )
            win32print.StartPagePrinter(handle)
            win32print.WritePrinter(handle, pjl_cmd)
            win32print.EndPagePrinter(handle)
            win32print.EndDocPrinter(handle)
            debug_log(f"PJL command sent to {printer_name}: {command.decode('utf-8', errors='replace')[:50]}")
            return True
        finally:
            win32print.ClosePrinter(handle)
    except Exception as e:
        debug_log(f"PJL send error for {printer_name}: {e}")
    return None

def _send_pjl_network(printer_ip, port, command, timeout=5):
    """
    Gửi lệnh PJL qua TCP socket (cho network printers).
    Có thể đọc response.
    
    Args:
        printer_ip: Địa chỉ IP máy in
        port: Cổng (thường 9100)
        command: Lệnh PJL (bytes)
        timeout: Timeout giây
    
    Returns:
        str (response từ máy in) hoặc None
    """
    try:
        import socket
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        sock.connect((printer_ip, port))
        
        uel = b"\x1b%-12345X"
        pjl_cmd = uel + command + b"\r\n" + uel
        sock.send(pjl_cmd)
        
        # Đọc response
        response = b""
        try:
            while True:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                response += chunk
        except socket.timeout:
            pass
        
        sock.close()
        return response.decode('utf-8', errors='replace')
    except Exception as e:
        debug_log(f"PJL network error: {e}")
    return None

def _parse_pjl_page_count(response):
    """Parse response từ @PJL INFO PAGECOUNT"""
    if not response:
        return None
    # Format: "PAGECOUNT=6266" or similar
    import re
    m = re.search(r'PAGECOUNT[=\s]+(\d+)', response, re.IGNORECASE)
    if m:
        return int(m.group(1))
    return None

def _parse_pjl_status(response):
    """Parse response từ @PJL INFO STATUS để lấy toner, drum..."""
    result = {}
    if not response:
        return result
    
    import re
    # Brother-specific status variables
    patterns = {
        'page_count': r'PAGECOUNT[=\s]+(\d+)',
        'toner_level': r'TONER[=\s]+(\d+)',
        'drum_life': r'DRUM[=\s]+(\d+)',
        'drum_remaining': r'DRUM_REMAINING[=\s]+(\d+)',
        'total_pages': r'TOTAL[=_]+PAGES?[=\s]+(\d+)',
    }
    for key, pattern in patterns.items():
        m = re.search(pattern, response, re.IGNORECASE)
        if m:
            result[key] = int(m.group(1))
    
    return result

@app.route("/api/printer/pjl-status")
# WHY: PJL query — gửi lệnh @PJL INFO PAGECOUNT qua RAW spooler hoặc TCP socket.
# Network printers (port 9100) đọc được response → page_count, toner, drum.
# USB printers chỉ gửi lệnh, không đọc được response (RAW one-way).
# Cached 30s để tránh gửi lệnh liên tục.
def api_printer_pjl_status():
    """
    GET /api/printer/pjl-status?printer=NAME
    Đọc hardware diagnostics từ máy in qua PJL.
    
    Query params:
        printer: Tên máy in
        ip: Địa chỉ IP (nếu là network printer)
        port: Cổng PJL (mặc định 9100)
    
    Returns:
        {page_count, toner_level, drum_life, ...}
    """
    printer_name = request.args.get('printer', '')
    printer_ip = request.args.get('ip', '')
    pjl_port = int(request.args.get('port', '9100'))
    
    if not printer_name and not printer_ip:
        return jsonify({'error': 'Missing printer name or IP', 'source': None})
    
    # Kiểm tra cache
    cache_key = printer_name or printer_ip
    with _pjl_cache_lock:
        cached = _pjl_cache.get(cache_key)
        if cached and (time.time() - cached['cached_at']) < PJL_CACHE_TTL:
            return jsonify(cached['data'])
    
    result = {'source': 'pjl', 'printer': printer_name}
    
    if printer_ip:
        # Network printer: có thể đọc response
        response = _send_pjl_network(printer_ip, pjl_port, b"@PJL INFO PAGECOUNT")
        if response:
            parsed = _parse_pjl_page_count(response)
            if parsed:
                result['page_count'] = parsed
            
            # Đọc thêm status
            status_resp = _send_pjl_network(printer_ip, pjl_port, b"@PJL INFO STATUS", timeout=3)
            if status_resp:
                status = _parse_pjl_status(status_resp)
                result.update(status)
                result['source'] = 'pjl_network'
    else:
        # USB printer: gửi lệnh (không đọc được response)
        _send_pjl_raw(printer_name, b"@PJL INFO PAGECOUNT")
        result['source'] = 'pjl_raw_sent'
        result['note'] = 'PJL command sent via RAW spooler. USB printers may not return response.'
    
    # Lưu cache
    with _pjl_cache_lock:
        _pjl_cache[cache_key] = {'data': result, 'cached_at': time.time()}
    
    return jsonify(result)

# ═══════════════════════════════════════════════════════════════
# IMPORT / EXPORT — Sao lưu và khôi phục dữ liệu
# ═══════════════════════════════════════════════════════════════
#
# Export: Gom tất cả dữ liệu (settings, history, stats, audio settings)
#   thành file JSON/ZIP để người dùng tải về.
# Import: Đọc file backup, kiểm tra version, merge/overwrite.
#
# Quy trình Import:
#   1. Validate file JSON (version, format)
#   2. Cảnh báo nếu có dữ liệu cũ sẽ bị ghi đè
#   3. Ghi đè từng file dữ liệu (settings, history, stats)
#   4. Trả về kết quả: những gì đã import
#
# ⚠️ Lưu ý:
#   - Import KHÔNG xóa dữ liệu hiện tại, chỉ merge/overwrite
#   - Version mismatch → cảnh báo nhưng vẫn cho import
#   - Dữ liệu audio settings cũng được backup
# ═══════════════════════════════════════════════════════════════

BACKUP_DIR = CONFIG_DIR / "backups"

@app.route("/api/printer/export", methods=["GET"])
# WHY: GET vì read-only — collect all data (printer + audio) vào 1 JSON.
# Version field để validate khi import lại — tránh import data sai format.
def api_printer_export():
    """
    GET /api/printer/export
    Export tất cả dữ liệu máy in thành JSON.
    
    Returns:
        JSON object chứa toàn bộ dữ liệu kèm version và exportDate.
        Bao gồm: settings, history, stats, audio_settings, audio_sessions.
    """
    try:
        # Thu thập tất cả dữ liệu
        settings = load_printer_settings()
        history = []
        if os.path.exists(PRINTER_HISTORY_FILE):
            with open(PRINTER_HISTORY_FILE, 'r') as f:
                history = json.load(f)
        
        stats = load_printer_stats()
        
        audio_settings = {}
        if os.path.exists(AUDIO_SETTINGS_FILE):
            with open(AUDIO_SETTINGS_FILE, 'r') as f:
                audio_settings = json.load(f)
        
        audio_sessions = []
        if os.path.exists(AUDIO_SESSION_FILE):
            with open(AUDIO_SESSION_FILE, 'r') as f:
                audio_sessions = json.load(f)
        
        # Đóng gói
        export_data = {
            'version': '1.0',
            'exportDate': datetime.now().isoformat(),
            'app': 'MultiTool Pro',
            'data': {
                'printer_settings': settings,
                'printer_history': history[:500] if history else [],  # Export nhiều hơn 200
                'printer_stats': stats,
                'audio_settings': audio_settings,
                'audio_sessions': audio_sessions[:500] if audio_sessions else [],
            }
        }
        
        return jsonify(export_data)
    except Exception as e:
        debug_log(f"Export error: {e}")
        return jsonify({'error': str(e)}), 500

@app.route("/api/printer/import", methods=["POST"])
# WHY: POST vì có side effect (ghi file). Mode overwrite vs merge cho phép user chọn behavior.
# Validation: kiểm tra version + structure để tránh import file sai format.
def api_printer_import():
    """
    POST /api/printer/import
    Import dữ liệu từ file backup JSON.
    
    Body:
        {data: export_data_object, mode: "overwrite"|"merge"}
    
    Mode:
        overwrite: Ghi đè toàn bộ dữ liệu hiện tại
        merge: Chỉ thêm mới, không xóa dữ liệu cũ
    
    Validation:
        - Kiểm tra version field
        - Kiểm tra cấu trúc (data.printer_settings, data.printer_history...)
        - Cảnh báo version mismatch
    
    Returns:
        {status, imported: {settings, history, stats, audio}, warnings: [string]}
    """
    body = request.get_json() or {}
    import_data = body.get('data', {})
    mode = body.get('mode', 'overwrite')
    
    if not import_data:
        return jsonify({'error': 'Không có dữ liệu để import'}), 400
    
    warnings = []
    imported = {'settings': False, 'history': False, 'stats': False, 'audio': False}
    
    # Version check
    version = import_data.get('version', '0.0')
    if version != '1.0':
        warnings.append(f'Phiên bản dữ liệu ({version}) khác với hiện tại (1.0), vẫn tiếp tục...')
    
    raw_data = import_data.get('data', {})
    
    try:
        # Import printer settings
        if 'printer_settings' in raw_data:
            ps = raw_data['printer_settings']
            if mode == 'overwrite':
                save_printer_settings(ps)
            else:
                existing = load_printer_settings()
                existing.update(ps)
                save_printer_settings(existing)
            imported['settings'] = True
        
        # Import history
        if 'printer_history' in raw_data:
            new_history = raw_data['printer_history']
            if isinstance(new_history, list) and len(new_history) > 0:
                if mode == 'overwrite':
                    with open(PRINTER_HISTORY_FILE, 'w') as f:
                        json.dump(new_history[:200], f, indent=2)
                else:
                    existing = []
                    if os.path.exists(PRINTER_HISTORY_FILE):
                        with open(PRINTER_HISTORY_FILE, 'r') as f:
                            existing = json.load(f)
                    combined = new_history + existing
                    with open(PRINTER_HISTORY_FILE, 'w') as f:
                        json.dump(combined[:200], f, indent=2)
                    warnings.append(f'Đã merge {len(new_history)} entries mới với {len(existing)} entries cũ')
                imported['history'] = True
        
        # Import stats
        if 'printer_stats' in raw_data:
            ns = raw_data['printer_stats']
            if mode == 'overwrite':
                save_printer_stats(ns)
            else:
                existing = load_printer_stats()
                # Merge: gộp dữ liệu, giữ max để tránh double-count
                existing['total_prints'] = max(
                    existing.get('total_prints', 0),
                    ns.get('total_prints', 0),
                )
                for pname, pdata in ns.get('printers', {}).items():
                    if pname in existing.get('printers', {}):
                        existing['printers'][pname]['total'] = max(
                            existing['printers'][pname].get('total', 0),
                            pdata.get('total', 0),
                        )
                        existing['printers'][pname]['last_print'] = pdata.get('last_print') or existing['printers'][pname].get('last_print')
                    else:
                        existing['printers'][pname] = pdata
                save_printer_stats(existing)
                warnings.append('Đã merge stats (lấy max để tránh double-count)')
            imported['stats'] = True
        
        # Import audio settings
        if 'audio_settings' in raw_data:
            audio_s = raw_data['audio_settings']
            if mode == 'overwrite':
                save_audio_settings(audio_s)
            else:
                existing_audio = load_audio_settings()
                existing_audio.update(audio_s)
                save_audio_settings(existing_audio)
            imported['audio'] = True
        
        return jsonify({
            'status': 'imported',
            'imported': imported,
            'warnings': warnings,
        })
    except Exception as e:
        debug_log(f"Import error: {e}")
        return jsonify({'error': str(e), 'imported': imported, 'warnings': warnings}), 500

@app.route("/api/printer/backup", methods=["POST"])
# WHY: POST (side effect — ghi file). Backup tự động + manual đều dùng endpoint này.
# 30-backup retention để tránh đầy disk. Tên file timestamped để dễ tìm kiếm.
def api_printer_backup():
    """
    POST /api/printer/backup
    Tạo bản sao lưu định kỳ vào thư mục %APPDATA%/multitool-pro/backups/
    
    Mỗi backup là một file JSON với tên:
        backup-printer-YYYY-MM-DD_HHMMSS.json
    Giữ tối đa 30 bản backup gần nhất.
    
    Returns:
        {status, path, size}
    """
    try:
        BACKUP_DIR.mkdir(parents=True, exist_ok=True)
        
        # Export dữ liệu trước
        settings = load_printer_settings()
        history = []
        if os.path.exists(PRINTER_HISTORY_FILE):
            with open(PRINTER_HISTORY_FILE, 'r') as f:
                history = json.load(f)
        stats = load_printer_stats()
        
        # Tạo file backup
        timestamp = datetime.now().strftime('%Y-%m-%d_%H%M%S')
        backup_path = BACKUP_DIR / f'backup-printer-{timestamp}.json'
        
        backup_data = {
            'version': '1.0',
            'exportDate': datetime.now().isoformat(),
            'type': 'auto_backup',
            'data': {
                'printer_settings': settings,
                'printer_history': history,
                'printer_stats': stats,
            }
        }
        
        with open(backup_path, 'w', encoding='utf-8') as f:
            json.dump(backup_data, f, indent=2, ensure_ascii=False)
        
        size = backup_path.stat().st_size
        
        # Xóa backup cũ (giữ 30 cái gần nhất)
        backups = sorted(BACKUP_DIR.glob('backup-printer-*.json'), reverse=True)
        for old_backup in backups[30:]:
            try:
                old_backup.unlink()
            except Exception:
                pass
        
        debug_log(f"Auto backup created: {backup_path.name} ({size} bytes)")
        return jsonify({'status': 'backed_up', 'path': str(backup_path), 'size': size})
    except Exception as e:
        debug_log(f"Backup error: {e}")
        return jsonify({'error': str(e)}), 500


# ─── AUDIO APIs ───────────────────────────────────────────────────

# Audio session tracking
AUDIO_SESSION_FILE = str(CONFIG_DIR / "audio_sessions.json")
AUDIO_SETTINGS_FILE = str(CONFIG_DIR / "audio_settings.json")

DEFAULT_AUDIO_SETTINGS = {
    "sound_enabled": True,
    "selected_sound": None,
    "icon_theme": "1",
    "color_mic_on": "#3498DB",
    "color_mic_off": "#E74C3C",
    "show_widget_on_mic": False,
    "always_on_top": False,
    "widget_opacity": 1.0,
}

# WHY: Merge với DEFAULT_AUDIO_SETTINGS để đảm bảo không thiếu field.
# Không có lock (audio settings ít bị concurrent access hơn printer settings).
def load_audio_settings():
    try:
        if os.path.exists(AUDIO_SETTINGS_FILE):
            with open(AUDIO_SETTINGS_FILE, 'r') as f:
                return {**DEFAULT_AUDIO_SETTINGS, **json.load(f)}
    except Exception: pass
    return dict(DEFAULT_AUDIO_SETTINGS)

# WHY: Ghi toàn bộ settings object. Audio settings nhỏ (chưa đến 1KB) nên không cần partial update.
def save_audio_settings(settings):
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    with open(AUDIO_SETTINGS_FILE, 'w') as f:
        json.dump(settings, f, indent=2)

@app.route("/api/audio/settings", methods=["GET", "POST"])
# WHY: GET/POST cùng endpoint — GET load, POST save. Chỉ update field có trong request body.
def api_audio_settings():
    """Lấy hoặc cập nhật cài đặt audio"""
    if request.method == "POST":
        data = request.get_json() or {}
        settings = load_audio_settings()
        for key in ['sound_enabled', 'selected_sound', 'icon_theme', 'color_mic_on', 'color_mic_off', 'show_widget_on_mic', 'always_on_top', 'widget_opacity']:
            if key in data:
                settings[key] = data[key]
        save_audio_settings(settings)
        return jsonify({'status': 'saved', 'settings': settings})
    return jsonify({'settings': load_audio_settings()})

@app.route("/api/audio/session-history")
# WHY: Trả về 100 sessions gần nhất — đủ cho UI hiển thị mà không quá nặng.
# Sessions được append-only, cũ hơn tự động bị truncate.
def api_audio_session_history():
    """Lấy lịch sử session mic"""
    try:
        if os.path.exists(AUDIO_SESSION_FILE):
            with open(AUDIO_SESSION_FILE, 'r') as f:
                sessions = json.load(f)
            return jsonify({'sessions': sessions[-100:]})  # Last 100 sessions
        return jsonify({'sessions': []})
    except Exception as e:
        return jsonify({'sessions': [], 'error': str(e)}), 500

@app.route("/api/audio/session-log", methods=["POST"])
# WHY: Ghi session khi mic ngừng active (frontend gọi khi timer kết thúc).
# Append JSON file — không overwrite.
def api_audio_session_log():
    """Ghi nhận session mic khi kết thúc"""
    data = request.get_json() or {}
    duration = data.get('duration', 0)
    app_using = data.get('app_using', 'Không rõ')
    mic_name = data.get('mic_name', 'Không rõ')
    
    try:
        sessions = []
        if os.path.exists(AUDIO_SESSION_FILE):
            with open(AUDIO_SESSION_FILE, 'r') as f:
                sessions = json.load(f)
        
        entry = {
            'datetime': datetime.now().strftime('%d/%m/%y %H:%M:%S'),
            'duration': duration,
            'app_using': app_using,
            'mic_name': mic_name,
        }
        sessions.insert(0, entry)
        sessions = sessions[:500]  # Keep max 500 entries
        with open(AUDIO_SESSION_FILE, 'w') as f:
            json.dump(sessions, f, indent=2)
        return jsonify({'status': 'logged', 'entry': entry})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route("/api/audio/sound-files")
# WHY: Quét 2 thư mục — %APPDATA%/sounds (user upload) + backend/sounds (default).
# Hỗ trợ .wav và .mp3 — frontend dùng HTMLAudioElement để phát.
def api_audio_sound_files():
    """Liệt kê các file âm thanh cảnh báo"""
    sound_dir = CONFIG_DIR / "sounds"
    sound_dir.mkdir(parents=True, exist_ok=True)
    
    files = []
    for fname in sorted(os.listdir(sound_dir)):
        if fname.lower().endswith(('.wav', '.mp3')):
            files.append(fname)
    
    # Also check backend/sounds directory
    backend_sounds = BASE_DIR / "backend" / "sounds"
    if backend_sounds.exists():
        for fname in sorted(os.listdir(backend_sounds)):
            if fname.lower().endswith(('.wav', '.mp3')) and fname not in files:
                files.append(fname)
    
    return jsonify({'sound_files': files})

@app.route("/api/audio/devices")
# WHY: Hybrid approach:
# 1) Dùng sounddevice (PortAudio) để lấy danh sách device names — reliable, cross-platform.
# 2) Dùng pycaw (Windows Core Audio API) để lấy volume/mute — nếu khả dụng.
# WHY sounddevice: Pycaw.GetAllDevices() thường trả về 0 devices trên nhiều Windows config.
# Mic-status dùng sounddevice.query_devices() thành công (18 devices), nên dùng lại pattern này.
def api_audio_devices():
    """Lấy danh sách thiết bị audio (sounddevice + pycaw)"""
    try:
        pythoncom.CoInitialize()
        
        # ─── Bước 1: Lấy danh sách devices từ sounddevice ───────────
        import sounddevice as sd
        devices = []
        sd_devices = sd.query_devices()
        
        # WHY: Lấy default device indices từ sounddevice
        default_input_idx = sd.default.device[0]
        default_output_idx = sd.default.device[1]
        
        for i, dev in enumerate(sd_devices):
            if dev['name']:
                is_input = dev['max_input_channels'] > 0
                is_output = dev['max_output_channels'] > 0
                devices.append({
                    'id': i,
                    'name': dev['name'],
                    'is_input': is_input,
                    'is_output': is_output,
                    'is_default': (i == default_input_idx or i == default_output_idx),
                    'channels': dev['max_input_channels'] if is_input else dev['max_output_channels'],
                    'samplerate': int(dev['default_samplerate']) if dev['default_samplerate'] else 0,
                    'volume': 50,
                    'muted': False,
                })
        
        # ─── Bước 2: Bổ sung volume/mute từ pycaw (nếu khả dụng) ───
        try:
            from pycaw.pycaw import AudioUtilities, IAudioEndpointVolume
            from ctypes import cast, POINTER
            from comtypes import CLSCTX_ALL
            
            all_devs = AudioUtilities.GetAllDevices()
            if all_devs:
                debug_log(f"[audio] pycaw found {len(all_devs)} devices, enriching volume data")
                for py_dev in all_devs:
                    try:
                        py_name = str(py_dev.FriendlyName or '')
                        # Match với device trong list (theo tên)
                        for dev in devices:
                            if py_name and (py_name in dev['name'] or dev['name'] in py_name):
                                # Lấy volume
                                interface = py_dev.Activate(
                                    IAudioEndpointVolume._iid_, CLSCTX_ALL, None
                                )
                                vol = cast(interface, POINTER(IAudioEndpointVolume))
                                dev['volume'] = round(vol.GetMasterVolumeLevelScalar() * 100)
                                dev['muted'] = bool(vol.GetMute())
                                break
                    except Exception:
                        pass
        except ImportError:
            pass  # pycaw không available — vẫn trả về devices từ sounddevice
        except Exception as e:
            debug_log(f"[audio] pycaw enrichment error: {e}")
        
        debug_log(f"[audio] Returned {len(devices)} devices")
        return jsonify({'devices': devices, 'source': 'sounddevice', 'count': len(devices)})
    except ImportError:
        return jsonify({'devices': [], 'error': 'sounddevice không khả dụng'}), 501
    except Exception as e:
        debug_log(f"[audio] api_audio_devices error: {e}")
        return jsonify({'devices': [], 'error': str(e)}), 500

@app.route("/api/audio/mic-status")
# WHY: Hybrid approach — Registry (CapabilityAccessManager) cho biết app nào đang dùng mic,
# Pycaw IAudioEndpointVolume cho hardware mute status,
# Sounddevice cho danh sách input devices + thông số kỹ thuật.
# Frontend poll mỗi 1s để hiển thị real-time indicator.
def api_audio_mic_status():
    """Kiểm tra trạng thái microphone chi tiết:
    - Registry: Ứng dụng nào đang dùng mic?
    - Pycaw: Mic hardware có bị mute không?
    - Sounddevice: Danh sách micro có sẵn
    """
    try:
        import winreg
        MIC_PATH = r"SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone"
        is_active = False
        app_using = 'Không có'
        mic_name = 'Không rõ'
        mic_muted = None  # None = không xác định
        volume_level = None  # None = không xác định
        available_mics = []

        # ─── Sounddevice: Lấy tên mic mặc định + danh sách micro ───
        try:
            import sounddevice as sd
            # Lấy tên mic mặc định
            default_idx = sd.default.device[0]
            if default_idx is not None:
                dev_info = sd.query_devices(default_idx, 'input')
                mic_name = dev_info['name']
                if '(' in mic_name:
                    mic_name = mic_name.split('(')[-1].rstrip(')')
            # Liệt kê tất cả input devices
            for i, dev in enumerate(sd.query_devices()):
                if dev['max_input_channels'] > 0:
                    available_mics.append({
                        'id': i,
                        'name': dev['name'],
                        'channels': dev['max_input_channels'],
                        'default': (i == default_idx),
                        'samplerate': int(dev['default_samplerate']) if dev['default_samplerate'] else 0
                    })
        except Exception:
            pass

        # ─── Pycaw: Kiểm tra mic hardware mute status ───
        # Dùng AudioUtilities.GetMicrophone() + IAudioEndpointVolume
        # (hoạt động trên capture devices, Windows 10/11)
        try:
            pythoncom.CoInitialize()
            from pycaw.pycaw import AudioUtilities, IAudioEndpointVolume
            from comtypes import CLSCTX_ALL, POINTER, cast
            
            mic = AudioUtilities.GetMicrophone()
            if mic:
                interface = mic.Activate(
                    IAudioEndpointVolume._iid_, CLSCTX_ALL, None
                )
                volume = cast(interface, POINTER(IAudioEndpointVolume))
                mute_val = volume.GetMute()
                mic_muted = bool(mute_val)
                try:
                    volume_level = volume.GetMasterVolumeLevelScalar()
                except:
                    volume_level = None
        except Exception:
            pass

        # ─── Windows Registry: App nào đang dùng mic? ───
        def parse_app(raw, non_pkg=False):
            if non_pkg:
                return raw.replace('#', '\\').split('.exe')[0] + '.exe' if '.exe' in raw else raw
            return raw.split('!')[0] if '!' in raw else raw

        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, MIC_PATH) as main:
                for i in range(winreg.QueryInfoKey(main)[0]):
                    sub_name = winreg.EnumKey(main, i)
                    try:
                        with winreg.OpenKey(main, sub_name) as sub:
                            if 'nonpackaged' in sub_name.lower():
                                for j in range(winreg.QueryInfoKey(sub)[0]):
                                    app_name = winreg.EnumKey(sub, j)
                                    with winreg.OpenKey(sub, app_name) as app:
                                        if winreg.QueryValueEx(app, 'LastUsedTimeStop')[0] == 0:
                                            is_active = True
                                            app_using = parse_app(app_name, True)
                            elif winreg.QueryValueEx(sub, 'LastUsedTimeStop')[0] == 0:
                                is_active = True
                                app_using = parse_app(sub_name)
                    except Exception:
                        continue
        except Exception:
            pass

        # Xác định trạng thái tổng thể
        if mic_muted is True:
            overall_status = 'muted'
        elif is_active:
            overall_status = 'active'
        elif len(available_mics) > 0:
            overall_status = 'idle'
        else:
            overall_status = 'no_mic'

        return jsonify({
            'active': is_active,
            'app_using_mic': app_using,
            'mic_name': mic_name,
            'mic_muted': mic_muted,
            'volume_level': volume_level,
            'overall_status': overall_status,
            'available_mics': available_mics,
            'mic_count': len(available_mics),
            'duration': 0
        })
    except Exception as e:
        return jsonify({
            'active': False, 'app_using_mic': 'Lỗi',
            'mic_name': 'Không rõ', 'mic_muted': None,
            'overall_status': 'error', 'available_mics': [],
            'mic_count': 0, 'duration': 0, 'error': str(e)
        }), 500

@app.route("/api/audio/devices/<int:dev_id>/mute", methods=["POST"])
# WHY: Toggle mute — đọc current mute state → set opposite.
# Dùng IAudioEndpointVolume (core audio API), không qua mixer.
def api_audio_mute(dev_id):
    """Bật/tắt mute cho thiết bị audio"""
    try:
        from pycaw.pycaw import AudioUtilities, IAudioEndpointVolume
        from ctypes import cast, POINTER
        from comtypes import CLSCTX_ALL
        
        all_devs = AudioUtilities.GetAllDevices()
        if 0 <= dev_id < len(all_devs):
            endpoint = AudioUtilities.GetEndpoint(all_devs[dev_id].Id)
            volume = endpoint.Activate(IAudioEndpointVolume._iid_, CLSCTX_ALL, None)
            vol_obj = cast(volume, POINTER(IAudioEndpointVolume))
            current = vol_obj.GetMute()
            vol_obj.SetMute(not current, None)
        return jsonify({'status': 'toggled'})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route("/api/audio/devices/<int:dev_id>/volume", methods=["PUT"])
# WHY: SetMasterVolumeLevelScalar với giá trị 0.0-1.0.
# Clamp 0-100 từ frontend để tránh giá trị âm hoặc > 100%.
def api_audio_volume(dev_id):
    """Điều chỉnh âm lượng thiết bị audio"""
    try:
        from pycaw.pycaw import AudioUtilities, IAudioEndpointVolume
        from ctypes import cast, POINTER
        from comtypes import CLSCTX_ALL
        
        data = request.get_json() or {}
        vol = max(0, min(100, int(data.get('volume', 50)))) / 100.0
        
        all_devs = AudioUtilities.GetAllDevices()
        if 0 <= dev_id < len(all_devs):
            endpoint = AudioUtilities.GetEndpoint(all_devs[dev_id].Id)
            volume = endpoint.Activate(IAudioEndpointVolume._iid_, CLSCTX_ALL, None)
            vol_obj = cast(volume, POINTER(IAudioEndpointVolume))
            vol_obj.SetMasterVolumeLevelScalar(vol, None)
        return jsonify({'status': 'set', 'volume': int(vol * 100)})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route("/api/audio/devices/<int:dev_id>/default", methods=["POST"])
# WHY: Dùng PolicyConfigClient (COM interface) — cách duy nhất để set default device programmatically.
# Không dùng được win32 API SetDefaultEndpoint (chỉ có trong Windows 10+ SDK).
def api_audio_set_default(dev_id):
    """Đặt thiết bị audio làm mặc định dùng PolicyConfigClient"""
    try:
        from pycaw.pycaw import AudioUtilities
        from pycaw.constants import CLSID_MMDeviceEnumerator, DEVICE_STATE_ACTIVE, ERole, EDataFlow
        
        all_devs = AudioUtilities.GetAllDevices()
        if 0 <= dev_id < len(all_devs):
            dev = all_devs[dev_id]
            dev_id_str = dev.Id
            
            # Use PolicyConfigClient to set default endpoint
            try:
                from pycaw.policyconfig import PolicyConfigClient
                policy = PolicyConfigClient()
                data_flow = dev.DataFlow  # 0=render(output), 1=capture(input)
                if data_flow == 0:
                    policy.SetDefaultEndpoint(dev_id_str, ERole.ERole.console)
                else:
                    policy.SetDefaultEndpoint(dev_id_str, ERole.ERole.console)
            except Exception:
                # Fallback: use comtypes directly
                try:
                    import comtypes
                    from ctypes import OleDLL, POINTER, c_int
                    POLARITY_CONFIG_CLSID = "{870af99c-171d-4f9e-af0d-e63df40c2bc9}"
                    IPolicyConfig_IID = "{F8679F50-850A-41CF-9C72-430F290290C8}"
                    policy = comtypes.CoCreateInstance(
                        comtypes.GUID(POLARITY_CONFIG_CLSID),
                        comtypes.IPolicyConfig,
                        comtypes.CLSCTX_ALL
                    )
                    # If we got here without AttributeError, try to call SetDefaultEndpoint
                    from ctypes import c_wchar_p, HRESULT
                    policy.SetDefaultEndpoint(dev_id_str, 0)
                except Exception: pass
        return jsonify({'status': 'set_default'})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ─── FILE COPIER APIs ────────────────────────────────────────────

@app.route("/api/file-copier/count", methods=["POST"])
# WHY: Dùng os.walk — nhanh hơn rglob cho directory với nhiều file.
# Filter theo extension list (case-insensitive). Validate path trước khi walk.
def api_file_copier_count():
    """Đếm số file trong thư mục theo extensions"""
    data = request.get_json() or {}
    path = data.get('path', '')
    extensions = data.get('extensions', ['.mp3', '.mp4', '.wav', '.flac'])
    if not path or not os.path.isdir(path):
        return jsonify({'error': 'Đường dẫn không hợp lệ'}), 400
    try:
        count = 0
        for root, _, files in os.walk(path):
            for f in files:
                if any(f.lower().endswith(ext.lower()) for ext in extensions):
                    count += 1
        return jsonify({'count': count})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route("/api/file-copier/read-keywords", methods=["POST"])
# WHY: Đọc file .txt, mỗi dòng = 1 keyword. Validate path + file tồn tại trước khi đọc.
# Trả về keywords array + count để frontend hiển thị.
def api_file_copier_read_keywords():
    """Đọc file keyword và trả về danh sách từ khóa"""
    data = request.get_json() or {}
    path = data.get('path', '')
    if not path or not os.path.isfile(path):
        return jsonify({'error': 'Đường dẫn file không hợp lệ'}), 400
    try:
        with open(path, 'r', encoding='utf-8') as f:
            keywords = [line.strip() for line in f if line.strip()]
        return jsonify({'keywords': keywords, 'count': len(keywords)})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# WHY: 64KB block size — cân bằng giữa speed (lớn hơn = ít I/O calls) và memory usage.
# Return None nếu lỗi (file không tồn tại, permission deny).
def calculate_md5(filepath, block_size=65536):
    """Tính MD5 của file"""
    import hashlib
    md5 = hashlib.md5()
    try:
        with open(filepath, 'rb') as f:
            while True:
                data = f.read(block_size)
                if not data:
                    break
                md5.update(data)
        return md5.hexdigest()
    except Exception:
        return None

# WHY: Resolve conflict mode = rename. Format: file (N).ext.
# Loop tăng counter đến khi tìm được tên không trùng.
def get_new_filename(dest_path):
    """Tạo tên file mới khi xung đột (file.txt -> file (1).txt)"""
    directory, filename = os.path.split(dest_path)
    name_part, ext_part = os.path.splitext(filename)
    counter = 1
    while True:
        new_name = f"{name_part} ({counter}){ext_part}"
        new_path = os.path.join(directory, new_name)
        if not os.path.exists(new_path):
            return new_path
        counter += 1

DEST_SUBFOLDERS = {
    'src1': 'audio tach ghep am',
    'src2': 'video tach ghep am',
    'src3': 'audio doc mot lan LK',
    'src4': 'audio doc mot lan HC',
    'src5': 'tu dien 1',
    'src6': 'tu dien 2',
}

@app.route("/api/file-copier/run", methods=["POST"])
# WHY: Hàm chính — duyệt source dirs, tìm file match keyword + extension,
# copy/skip/rename theo conflict_mode. Dry-run nếu dry_run=True (chỉ tìm, không copy).
# MD5 verify nếu verify_md5=True (kiểm tra file đã tồn tại trùng nội dung).
def api_file_copier_run():
    """Thực hiện copy file theo keyword, hỗ trợ dry-run"""
    data = request.get_json() or {}
    sources = data.get('sources', [])
    dest_dir = data.get('dest_dir', '')
    keywords = data.get('keywords', [])
    extensions = data.get('extensions', ['.mp3', '.mp4', '.wav', '.flac'])
    conflict_mode = data.get('conflict_mode', 'overwrite')
    verify_md5 = data.get('verify_md5', True)
    dry_run = data.get('dry_run', False)

    if not sources or not dest_dir or not keywords:
        return jsonify({'error': 'Thiếu trường bắt buộc'}), 400

    try:
        logs = []

        # Tạo thư mục đích (nếu không phải dry-run)
        if not dry_run:
            for folder in DEST_SUBFOLDERS.values():
                full_path = os.path.join(dest_dir, folder)
                os.makedirs(full_path, exist_ok=True)
            logs.append('✅ Đã tạo thư mục đích')

        # Index tất cả file nguồn
        logs.append('📂 Đang quét thư mục nguồn...')
        source_files_map = {}  # filename_lower -> [(full_path, key)]
        total_scanned = 0
        for src in sources:
            key = src['key']
            src_path = src['path']
            if not os.path.isdir(src_path):
                continue
            for root, _, files in os.walk(src_path):
                for f in files:
                    if any(f.lower().endswith(ext.lower()) for ext in extensions):
                        total_scanned += 1
                        name_no_ext, _ = os.path.splitext(f)
                        key_lower = name_no_ext.lower()
                        if key_lower not in source_files_map:
                            source_files_map[key_lower] = []
                        source_files_map[key_lower].append((os.path.join(root, f), key))

        logs.append(f'✅ Đã đánh chỉ mục {len(source_files_map)} file từ {total_scanned} tổng cộng')

        # Xử lý từng keyword
        found_count = 0
        not_found = []
        total_kw = len(keywords)
        processed_logs = []

        for i, keyword in enumerate(keywords):
            kw_lower = keyword.lower()
            if kw_lower in source_files_map:
                matches = source_files_map[kw_lower]
                for src_path, dest_key in matches:
                    filename = os.path.basename(src_path)
                    folder_name = DEST_SUBFOLDERS.get(dest_key, dest_key)
                    final_dest = os.path.join(dest_dir, folder_name, filename)

                    if os.path.exists(final_dest) and not dry_run:
                        if conflict_mode == 'skip':
                            processed_logs.append(f"⚠️ Đã bỏ qua (đã tồn tại): {filename}")
                            continue
                        elif conflict_mode == 'rename':
                            final_dest = get_new_filename(final_dest)
                            new_name = os.path.basename(final_dest)
                            processed_logs.append(f"ℹ️ Đã đổi tên thành: {new_name}")

                    if dry_run:
                        found_count += 1
                        if found_count <= 50:
                            processed_logs.append(f"📋 [THỬ] Sẽ sao chép: {filename} → {folder_name}")
                    else:
                        try:
                            shutil.copy2(src_path, final_dest)
                            if verify_md5:
                                src_md5 = calculate_md5(src_path)
                                dst_md5 = calculate_md5(final_dest)
                                if src_md5 and dst_md5 and src_md5 == dst_md5:
                                    found_count += 1
                                else:
                                    os.remove(final_dest)
                                    processed_logs.append(f"❌ MD5 không khớp, đã xóa: {filename}")
                            else:
                                found_count += 1
                        except Exception as e:
                            processed_logs.append(f"❌ Không thể sao chép {filename}: {str(e)}")
            else:
                not_found.append(keyword)

        # Save not-found keywords
        if not_found and not dry_run:
            nf_path = os.path.join(dest_dir, 'cac_tu_khoa_khong_tim_thay.txt')
            try:
                with open(nf_path, 'w', encoding='utf-8') as f:
                    f.write('\n'.join(sorted(not_found)))
                logs.append(f'📝 Đã lưu {len(not_found)} từ khóa không tìm thấy vào file')
            except:
                pass

        return jsonify({
            'found_count': found_count,
            'not_found_count': len(not_found),
            'total_keywords': total_kw,
            'total_files_indexed': len(source_files_map),
            'logs': logs + processed_logs,
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ─── DEBUG LOG API ────────────────────────────────────────────────
@app.route("/api/debug-log")
def api_debug_log():
    """Lấy nội dung file debug.log"""
    try:
        if DEBUG_LOG.exists():
            with open(DEBUG_LOG, 'r', encoding='utf-8') as f:
                lines = f.readlines()
            return jsonify({'log': ''.join(lines)})
        return jsonify({'log': 'Chưa có log'})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route("/api/debug-log/clear", methods=["POST"])
def api_debug_log_clear():
    """Xóa file debug.log"""
    try:
        if DEBUG_LOG.exists():
            DEBUG_LOG.unlink()
        return jsonify({'status': 'cleared'})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

shutdown_server = False

@app.route("/api/shutdown", methods=["POST"])
def api_shutdown():
    global shutdown_server
    shutdown_server = True
    # Stop all managed projects first
    for p in config["projects"]:
        name = p["name"]
        with lock:
            proc = processes.get(name)
            if proc:
                try:
                    proc.terminate()
                    proc.wait(timeout=3)
                except:
                    proc.kill()
                processes.pop(name, None)
    # Schedule shutdown
    threading.Thread(target=lambda: os._exit(0), daemon=True).start()
    return jsonify({"status": "shutting down"})

@app.route("/")
def index():
    return send_from_directory(str(FRONTEND_DIST), "index.html")

@app.route("/<path:path>")
def static_files(path):
    return send_from_directory(str(FRONTEND_DIST), path)

if __name__ == "__main__":
    import sys, time
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5050
    
    # WHY: Auto-restart wrapper - nếu Flask crash (unhandled exception), tự động restart.
    # Không dùng debug reloader vì:
    #   1) Reloader spawns child process → khó kill đúng process
    #   2) Reloader gây port conflict khi restart nhanh
    # Dùng while loop + time.sleep(2) để tránh restart spam khi có lỗi liên tục.
    # Threaded=True cho phép Flask xử lý concurrent requests.
    max_restarts = 10  # Giới hạn số lần restart để tránh infinite loop khi có lỗi nghiêm trọng
    restart_count = 0
    
    while restart_count < max_restarts:
        try:
            print(f"Dashboard API running on http://127.0.0.1:{port} (attempt {restart_count + 1}/{max_restarts})")
            app.run(host="127.0.0.1", port=port, debug=False, threaded=True)
            # Nếu app.run() return không exception (hiếm), vẫn tính là 1 lần crash
            restart_count += 1
        except SystemExit:
            # Graceful shutdown (Ctrl+C hoặc /api/shutdown) — không restart
            print("Flask server stopped gracefully.")
            break
        except Exception as e:
            restart_count += 1
            error_msg = f"Flask server crashed (attempt {restart_count}/{max_restarts}): {e}"
            print(f"[auto-restart] {error_msg}")
            # Ghi vào debug log nếu có thể
            try:
                debug_log(f"[auto-restart] {error_msg}")
            except:
                pass
            if restart_count < max_restarts:
                print(f"[auto-restart] Restarting in 2 seconds...")
                time.sleep(2)
            else:
                print(f"[auto-restart] Max restarts ({max_restarts}) reached. Giving up.")
                break
    
    print("Flask server terminated.")
