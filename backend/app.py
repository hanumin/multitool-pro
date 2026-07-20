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

def get_log_file(proj):
    return Path(os.environ.get("TEMP", os.environ.get("TMP", "/tmp"))) / f"sd_{proj['name']}.log"

def is_running(name):
    with lock:
        p = processes.get(name)
        return p is not None and p.poll() is None

def get_project(name):
    for p in config["projects"]:
        if p["name"] == name:
            return p
    return None

@app.route("/api/projects")
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

def _start_project(proj):
    """Helper: start một project, trả về result dict"""
    name = proj["name"]
    if is_running(name):
        return {"name": name, "status": "already_running"}
    
    # WHY: Nếu node_modules không tồn tại, KHÔNG start luôn mà báo để user chờ
    node_modules = Path(proj["path"]) / "node_modules"
    if not node_modules.exists():
        # WHY: Chạy npm install đồng bộ (blocking) để tránh race condition.
        # Mặc dù block API, nhưng đây là thao tác 1 lần duy nhất.
        # User sẽ thấy loading trên UI và log npm install trong tab log.
        lf = get_log_file(proj)
        if lf.exists():
            lf.unlink()
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
        lf.unlink()
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
def api_start_all():
    """Start tất cả dự án"""
    results = []
    for p in config["projects"]:
        results.append(_start_project(p))
    return jsonify({"results": results, "count": len(results)})

@app.route("/api/projects/stop-all", methods=["POST"])
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

def autostart_shortcut_exists():
    startup = os.path.join(os.environ.get("APPDATA", ""), "Microsoft", "Windows", "Start Menu", "Programs", "Startup")
    if not startup:
        return False
    return os.path.exists(os.path.join(startup, "MultiToolPro.lnk"))

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
                subprocess.run(["powershell", "-NoProfile", "-Command", ps_code], capture_output=True)
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
            subprocess.run(["powershell", "-NoProfile", "-Command", ps_code], capture_output=True)
    else:
        if os.path.exists(lnk):
            os.remove(lnk)

@app.route("/api/settings")
def api_settings():
    return jsonify({
        "autostart": autostart_shortcut_exists(),
    })

@app.route("/api/settings/autostart", methods=["POST"])
def api_set_autostart():
    data = request.get_json() or {}
    try:
        set_autostart(data.get("enabled", False))
        return jsonify({"autostart": autostart_shortcut_exists()})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

def save_config():
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2, ensure_ascii=False)

@app.route("/api/config", methods=["GET", "PUT"])
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
    return jsonify(new_proj), 201

@app.route("/api/config/projects/<name>", methods=["PUT"])
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
    return jsonify(proj)

@app.route("/api/config/projects/<name>", methods=["DELETE"])
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
    return jsonify({"status": "deleted", "name": name})

def kill_process_on_port(port):
    """
    Dùng psutil tìm và kill process đang chiếm port.
    An toàn hơn netstat parse vì:
    - Chỉ kill process có tên liên quan (node.exe, npm.exe, cmd.exe, next.exe)
    - Kiểm tra PID có tồn tại trước khi kill
    - Tránh kill nhầm system process
    """
    try:
        for proc in psutil.process_iter(['pid', 'name', 'connections']):
            try:
                for conn in proc.connections(kind='inet'):
                    if conn.laddr.port == port:
                        proc_name = proc.name().lower()
                        # WHITELIST: Chỉ kill các process liên quan đến Node.js/Next.js
                        allowed = ['node.exe', 'node', 'npm.exe', 'npm', 'cmd.exe', 'next.exe', 'next']
                        if any(allowed_name in proc_name for allowed_name in allowed):
                            debug_log(f"Killing process on port {port}: PID={proc.pid}, name={proc.name()}")
                            proc.kill()
                        else:
                            debug_log(f"SKIP killing on port {port}: PID={proc.pid}, name={proc.name()} (not in whitelist)")
            except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                pass
    except Exception as e:
        debug_log(f"kill_process_on_port error: {e}")

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
                timeout=2
            )
            branch = branch_res.stdout.strip() if branch_res.returncode == 0 else "unknown"
            
            status_res = subprocess.run(
                ["git", "status", "--porcelain"],
                cwd=proj["path"],
                capture_output=True,
                text=True,
                shell=True,
                timeout=2
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
            timeout=2
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
            timeout=2
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

def load_perf_history():
    with perf_lock:
        try:
            if os.path.exists(PERF_HISTORY_FILE):
                with open(PERF_HISTORY_FILE, 'r') as f:
                    return json.load(f)
        except Exception:
            pass
    return {}

def save_perf_history(data):
    with perf_lock:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        with open(PERF_HISTORY_FILE, 'w') as f:
            json.dump(data, f, indent=2)

def record_perf_snapshot(name, memory, cpu):
    # WHY: Lock xuyên suốt read-modify-write để tránh race condition
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
def api_perf_history(name):
    """Lấy lịch sử performance của project"""
    history = load_perf_history()
    return jsonify({"history": history.get(name, [])})

# ─── Quick SSL (mkcert) ──────────────────────────────────────────
@app.route("/api/projects/<name>/ssl", methods=["POST"])
def api_project_ssl(name):
    """Tạo SSL cert 1 click cho project dùng mkcert"""
    proj = get_project(name)
    if not proj:
        return jsonify({"error": "Không tìm thấy"}), 404
    try:
        # Kiểm tra mkcert đã được cài chưa
        check = subprocess.run(["mkcert", "-version"], capture_output=True, shell=True)
        if check.returncode != 0:
            return jsonify({
                "error": "mkcert chưa được cài đặt",
                "instructions": "Cài đặt: choco install mkcert hoặc scoop install mkcert hoặc download từ https://github.com/FiloSottile/mkcert"
            }), 400
        
        # Cài local CA nếu chưa
        subprocess.run(["mkcert", "-install"], capture_output=True, shell=True)
        
        proj_path = Path(proj["path"])
        cert_name = "localhost"
        # Tạo cert
        result = subprocess.run(
            ["mkcert", "-cert-file", f"{cert_name}.pem", "-key-file", f"{cert_name}-key.pem", "localhost", "127.0.0.1"],
            cwd=proj_path, capture_output=True, text=True, shell=True
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

# ─── Uptime Tracker ──────────────────────────────────────────────
project_start_times = {}

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

def load_db_connections():
    with db_connections_lock:
        try:
            if os.path.exists(DB_CONNECTIONS_FILE):
                with open(DB_CONNECTIONS_FILE, 'r') as f:
                    return json.load(f)
        except Exception:
            pass
    return []

def save_db_connections(connections):
    with db_connections_lock:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        with open(DB_CONNECTIONS_FILE, 'w') as f:
            json.dump(connections, f, indent=2)

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

def sanitize_identifier(name, db_type="postgresql"):
    """Sanitize database/table/schema names để chống SQL injection.
    Chỉ cho phép chữ, số, underscore. Ném exception nếu không hợp lệ."""
    if not name or not isinstance(name, str):
        raise ValueError("Invalid identifier")
    # Only allow alphanumeric + underscore
    if not all(c.isalnum() or c == '_' or c == '-' for c in name):
        raise ValueError(f"Identifier '{name}' contains invalid characters")
    return name

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
def api_db_test():
    """Kiểm tra kết nối database"""
    data = request.get_json() or {}
    result = test_db_connection(data)
    return jsonify(result)

@app.route("/api/database/connections", methods=["GET", "POST", "DELETE"])
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
    "excluded_printers": [],
}

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

def save_printer_settings(settings):
    """Ghi cài đặt máy in vào file JSON trong %APPDATA%/multitool-pro/"""
    with _printer_file_lock:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        with open(PRINTER_SETTINGS_FILE, 'w') as f:
            json.dump(settings, f, indent=2)

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
            printers.append({
                'name': name,
                'status': pr_info['status'],
                'is_default': False,  # sẽ gán sau
                'is_laser': is_laser_printer(name),
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

PRINTER_STATS_FILE = str(CONFIG_DIR / "printer_statistics.json")
# Global state: lưu danh sách job của lần quét trước
# Dùng để so sánh phát hiện job mới hoàn thành
# Format: {printer_name: {job_id: {status: int, doc: string}}}
_printer_prev_jobs = {}

# Global state: track last known JobCountSinceLastReset per printer
# Dùng để phát hiện thay đổi → auto-increment page_count
# Format: {printer_name: int}
_last_job_count = {}
_last_job_count_lock = threading.Lock()

# Mutex cho tất cả file I/O printer (settings, history, stats)
# Flask threaded=True → nhiều request có thể đọc/ghi đồng thời
_printer_file_lock = threading.Lock()



def is_laser_printer(name):
    """
    Kiểm tra máy in có phải laser không dựa trên tên.
    Heuristic đơn giản: tên chứa 'laser' (không phân biệt hoa thường).
    Dùng để bỏ qua reminder chống khô mực cho máy laser.
    """
    return 'laser' in name.lower()

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
                    jobs = win32print.EnumJobs(handle, 0, 100, 1)
                    current_jobs[name] = {}
                    for j in jobs:
                        jid = j.get('JobId', 0)
                        status = j.get('Status', 0)
                        doc = j.get('pDocument', '')
                        current_jobs[name][jid] = {'status': status, 'doc': doc}
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
                        results.append({
                            'printer': name,
                            'document': old_data.get('doc', ''),
                            'job_id': jid,
                        })
            _printer_prev_jobs = current_jobs  # Cập nhật snapshot
        
        return results
    except Exception:
        return []

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

def save_printer_stats(stats):
    """Ghi thống kê in ấn vào file JSON (thread-safe)"""
    with _printer_file_lock:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        with open(PRINTER_STATS_FILE, 'w') as f:
            json.dump(stats, f, indent=2)

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

def auto_increment_page_count(printer_name):
    """
    Tự động tăng page_count khi phát hiện in xong.
    
    Cơ chế 2 lớp:
    1. Đọc JobCountSinceLastReset từ WMI, so sánh với _last_job_count
       - Chỉ tính diff khi printer_name ĐÃ CÓ trong _last_job_count
       - Lần đầu: lưu giá trị WMI làm baseline, KHÔNG increment từ WMI
    2. Fallback: nếu WMI = 0 hoặc lỗi → tăng 1 mỗi lần phát hiện
    
    Args:
        printer_name: Tên máy in
    Returns:
        int: page_count mới, hoặc None nếu lỗi
    """
    global _last_job_count
    increment = 1  # Fallback: tăng 1 mỗi job
    
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
        
        # Cập nhật page_count trong settings
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
def api_printer_stats():
    """GET /api/printer/stats — Lấy thống kê in ấn"""
    stats = load_printer_stats()
    for name, data in stats.get('printers', {}).items():
        if 'is_laser' not in data:
            data['is_laser'] = is_laser_printer(name)
    return jsonify({'stats': stats})

@app.route("/api/printer/activity")
def api_printer_activity():
    """GET /api/printer/activity — Kiểm tra máy in nào đang hoạt động"""
    active_jobs = get_printing_activity()
    return jsonify({'active_jobs': active_jobs})

@app.route("/api/printer/auto-detect", methods=["POST"])
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
            entry = add_print_history_entry(
                f"Tự động: {document}" if document else "Phát hiện in tự động",
                printer_name
            )
            add_print_stats_entry(printer_name, document)
            # Tự động tăng page_count khi phát hiện in xong
            auto_increment_page_count(printer_name)
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
                capture_output=True, text=True, timeout=5
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

def query_printer_page_count_eventlogs(printer_name, port_name):
    """
    Đọc tổng số trang từ Event Logs Windows (PrintService/Operational).
    
    Chỉ dùng PowerShell EventLogs vì:
    - WritePrinter là write-only, không đọc được response
    - CreateFile trên USB port không khả dụng (driver chiếm dụng)
    - Gửi PJL dạng RAW job sẽ in ra giấy thật (tốn mực)
    - PJL (@PJL INFO PAGECOUNT) chỉ hoạt động với Brother/HP/network
    
    Args:
        printer_name: Tên máy in (VD: "EPSON L3210 Series")
        port_name: Cổng (VD: "USB002") — không dùng, giữ cho tương thích
    Returns:
        int (số trang) hoặc None nếu không đọc được
    """
    # Event ID 307 = Print job completed (có TotalPages trong Properties[5])
    try:
        ps_cmd = (
            'Get-WinEvent -FilterHashtable @{LogName="Microsoft-Windows-PrintService/Operational";ID=307} '
            f'-MaxEvents 200 | Where-Object {{ $_.Properties[3].Value -like "*{printer_name}*" }} | '
            'Select-Object @{N="Pages";E={$_.Properties[5].Value}} | '
            'Measure-Object -Property Pages -Sum | Select-Object -ExpandProperty Sum'
        )
        result = subprocess.run(
            ['powershell', '-NoProfile', '-Command', ps_cmd],
            capture_output=True, text=True, timeout=10
        )
        if result.returncode == 0 and result.stdout.strip():
            count = int(float(result.stdout.strip()))
            if count > 0:
                debug_log(f"EventLog page count for {printer_name}: {count}")
                return count
    except Exception as e:
        debug_log(f"EventLog query error: {e}")
    
    return None

@app.route("/api/printer/page-count")
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
        return jsonify({'page_count': None, 'source': None, 'error': 'Chưa chọn máy in'})
    
    # 1. EventLogs (PowerShell)
    pjl_count = query_printer_page_count_eventlogs(printer_name, port_name)
    if pjl_count is not None:
        return jsonify({'page_count': pjl_count, 'source': 'eventlog', 'printer': printer_name})
    
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
    
    # 3. Settings (người dùng nhập thủ công - lifetime total)
    settings = load_printer_settings()
    manual_count = settings.get('page_count', {}).get(printer_name, 0) or 0
    
    # Kết hợp: manual (lifetime) + WMI (per-session additional)
    if wmi_count > 0 or manual_count > 0:
        total = manual_count + wmi_count
        source = 'combined' if (wmi_count > 0 and manual_count > 0) else ('wmi' if wmi_count > 0 else 'manual')
        return jsonify({'page_count': total, 'source': source, 'printer': printer_name})
    
    return jsonify({'page_count': None, 'source': None, 'printer': printer_name})

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

def load_audio_settings():
    try:
        if os.path.exists(AUDIO_SETTINGS_FILE):
            with open(AUDIO_SETTINGS_FILE, 'r') as f:
                return {**DEFAULT_AUDIO_SETTINGS, **json.load(f)}
    except Exception: pass
    return dict(DEFAULT_AUDIO_SETTINGS)

def save_audio_settings(settings):
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    with open(AUDIO_SETTINGS_FILE, 'w') as f:
        json.dump(settings, f, indent=2)

@app.route("/api/audio/settings", methods=["GET", "POST"])
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
def api_audio_devices():
    """Lấy danh sách thiết bị audio"""
    try:
        from pycaw.pycaw import AudioUtilities
        devices = []
        all_devices = AudioUtilities.GetAllDevices()
        for i, dev in enumerate(all_devices):
            try:
                name = str(dev.FriendlyName or 'Không rõ')
                flow = str(dev.DataFlow)
                is_input = 'in' in flow.lower() or 'capture' in flow.lower() or 'mic' in name.lower()
                devices.append({
                    'id': i,
                    'name': name,
                    'is_input': is_input,
                    'is_default': False,
                    'volume': 50,
                    'muted': False
                })
            except Exception: pass
        # Get default devices
        try:
            default_input = AudioUtilities.GetDefaultInputDevice()
            default_output = AudioUtilities.GetDefaultOutputDevice()
            for dev in devices:
                if default_input and dev['name'] == str(default_input.FriendlyName):
                    dev['is_default'] = True
                if default_output and dev['name'] == str(default_output.FriendlyName):
                    dev['is_default'] = True
        except Exception: pass
        return jsonify({'devices': devices})
    except ImportError:
        return jsonify({'devices': [], 'error': 'pycaw không khả dụng'}), 501
    except Exception as e:
        return jsonify({'devices': [], 'error': str(e)}), 500

@app.route("/api/audio/mic-status")
def api_audio_mic_status():
    """Kiểm tra trạng thái microphone qua Windows Registry"""
    try:
        import winreg
        MIC_PATH = r"SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone"
        is_active = False
        app_using = 'Không có'
        mic_name = 'Không rõ'
        
        try:
            import sounddevice as sd
            mic_name = sd.query_devices(sd.default.device[0], 'input')['name']
            if '(' in mic_name:
                mic_name = mic_name.split('(')[-1].rstrip(')')
        except Exception: pass

        def parse_app(raw, non_pkg=False):
            if non_pkg:
                return raw.replace('#', '\\').split('.exe')[0] + '.exe' if '.exe' in raw else raw
            return raw.split('!')[0] if '!' in raw else raw

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
                except Exception: continue

        return jsonify({
            'active': is_active,
            'app_using_mic': app_using,
            'mic_name': mic_name,
            'duration': 0
        })
    except Exception as e:
        return jsonify({'active': False, 'app_using_mic': 'Lỗi', 'mic_name': 'Không rõ', 'duration': 0, 'error': str(e)}), 500

@app.route("/api/audio/devices/<int:dev_id>/mute", methods=["POST"])
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
            return jsonify({'log': ''.join(lines[-200:])})
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
    import sys
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5050
    print(f"Dashboard API running on http://127.0.0.1:{port}")
    app.run(host="127.0.0.1", port=port, debug=False, threaded=True)
