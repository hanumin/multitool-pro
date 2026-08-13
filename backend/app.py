import json, os, subprocess, sys, time, threading, signal, shutil, re, contextlib, queue, gc
import psutil
# WHY: pythoncom (thuộc pywin32) chỉ tồn tại trên Windows — import có điều kiện để
# backend BOOT được trên macOS/Linux (bản Mac đã ẩn tab Máy in nên các hàm dùng
# pythoncom không bao giờ được gọi; nếu lỡ gọi thì None → lỗi trong try, trả về error
# thay vì crash toàn backend lúc khởi động).
try:
    import pythoncom
except ImportError:
    pythoncom = None
from pathlib import Path
from flask import Flask, jsonify, request, Response, send_from_directory
from flask_cors import CORS
from datetime import datetime, timedelta
from detector import detect_project
import printer_mib  # SNMP Printer MIB probe (RFC 3805) — thuần Python, không dependency

# Thư mục gốc của project (chứa backend/, dist/, ...)
# WHY: PyInstaller frozen (sys.frozen=True) → chạy từ backend.exe đóng gói, mọi tài nguyên
# (dist/, auto-start.ps1, printer-monitor/) được --add-data nhúng vào exe và giải nén ra
# thư mục tạm sys._MEIPASS lúc chạy → BASE_DIR phải trỏ tới _MEIPASS (không phải project
# root vì exe có thể nằm bất kỳ đâu). Dev (python backend/app.py) → BASE_DIR = project root.
if getattr(sys, "frozen", False):
    BASE_DIR = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
else:
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

# WHY: Giới hạn mặc định khi đọc log — log file có thể lên tới 100MB, frontend
# chỉ cần ~300 dòng cuối mỗi project. Đọc full file mỗi 5s là nghẽn I/O vô ích.
LOG_TAIL_LIMIT = 2000
LOG_ROTATE_MAX_BYTES = 10 * 1024 * 1024
LOG_ROTATE_KEEP_LINES = 5000

# WHY: Đọc N dòng cuối từ file log — seek ngược từ cuối theo chunk, không load
# toàn bộ file vào memory (log có thể 100MB).
# QUAN TRỌNG: f phải mở BINARY ("rb"). Text mode + Windows CRLF không an toàn
# khi seek ngược: chunk boundary cắt ngang cặp \r\n → universal newline translate
# \r một mình thành \n → sinh dòng rỗng giả → slice(-limit) mất dòng thật.
def _read_tail_lines(f, limit):
    f.seek(0, 2)  # SEEK_END
    size = f.tell()
    if size == 0:
        return []
    pos = size
    buf = b""
    chunk = 65536
    while pos > 0 and buf.count(b"\n") <= limit:
        read_len = min(chunk, pos)
        pos -= read_len
        f.seek(pos)
        buf = f.read(read_len) + buf
    text = buf.decode("utf-8", errors="replace")
    lines = []
    for l in text.split("\n"):
        # Boundary: cặp \r\n bị cắt → "\n" cuối chunk trước + "\r" đầu chunk sau
        # → dòng đầu chunk bị dính \r thừa. Strip 1 leading \r (log thật không
        # bao giờ bắt đầu bằng \r — đó chỉ là control char của spinner/loader).
        if l.startswith("\r"):
            l = l[1:]
        l = l.rstrip("\r")
        if l:
            lines.append(l)
    if pos > 0:
        # Cắt giữa file → bỏ dòng đầu (có thể bị cắt nửa chừng giữa buffer)
        lines = lines[1:]
    return lines[-limit:]

# WHY: Rotation best-effort — log > 10MB → truncate giữ 5000 dòng cuối.
# Windows: child process (node.exe) có thể khóa file (WinError 32) → skip lần này,
# lần sau gọi lại khi process giải phóng handle.
def _rotate_log_if_needed(lf):
    try:
        if not lf.exists():
            return
        size = lf.stat().st_size
        if size <= LOG_ROTATE_MAX_BYTES:
            return
        with open(lf, "rb") as f:
            lines = _read_tail_lines(f, LOG_ROTATE_KEEP_LINES)
        with open(lf, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + ("\n" if lines else ""))
        debug_log(f"Rotated log {lf.name}: {size} -> {lf.stat().st_size} bytes")
    except PermissionError:
        debug_log(f"Log rotate SKIP (file locked): {lf.name}")
    except Exception as e:
        debug_log(f"Log rotate error {lf.name}: {e}")

# WHY: Whitelist tên process dev server — dùng chung cho kill_process_on_port()
# và is_running() fallback (tránh lệch giữa 2 nơi, làm is_running báo sai).
DEV_SERVER_WHITELIST = ['node.exe', 'node', 'npm.exe', 'npm', 'cmd.exe', 'next.exe', 'next', 'python.exe', 'python']

# WHY: Cache kết quả kiểm tra port listening (TTL 2s). is_running() được gọi từ
# /api/projects mỗi 5s + diagnostics mỗi 2s — không thể quét psutil.net_connections
# mỗi lần gọi (tốn CPU, hàng trăm connections).
_port_listen_cache = {}  # port -> (running: bool, timestamp)

# WHY: Tìm PID của process đang LISTEN trên port. Dùng psutil.net_connections
# (1 lần quét tất cả TCP tại PID) thay vì iterate từng process + connections()
# như kill_process_on_port — nhanh hơn nhiều và chính xác hơn.
def _pids_listening_on_port(port):
    pids = set()
    try:
        for conn in psutil.net_connections(kind='tcp'):
            try:
                if conn.status == "LISTEN" and conn.laddr and conn.laddr.port == port and conn.pid:
                    pids.add(conn.pid)
            except Exception:
                continue
    except (psutil.AccessDenied, psutil.Error):
        return set()
    return pids

# WHY: Wrapper names — cmd.exe/npm.exe là cha (chạy script), KHÔNG phải dev-server
# thật. Dùng để chọn canonical PID + xếp thứ tự kill.
_WRAPPER_NAMES = ("cmd.exe", "npm.exe", "npm", "sh", "bash")

def _build_ppid_map():
    """Snapshot (pid → ppid) 1 lần từ process_iter — tránh gọi proc.parent() lặp
    (race condition + chậm)."""
    try:
        return {p.pid: p.ppid for p in psutil.process_iter(["pid", "ppid"])}
    except Exception:
        return {}

# WHY: Độ sâu cây từ pid lên tới root — seen set chống vòng lặp, cap 64.
# Lá sâu nhất trong cây là process dev thật (không phải wrapper cmd.exe).
def _tree_depth(pid, ppid_map, max_depth=64):
    """Độ sâu cây từ pid lên tới root."""
    depth = 0
    seen = set()
    cur = pid
    while cur in ppid_map and ppid_map.get(cur) and cur not in seen and depth < max_depth:
        seen.add(cur)
        cur = ppid_map[cur]
        depth += 1
    return depth

# WHY: Chọn PID "chính" đại diện dev-server trên port (dùng cho diagnostics/uptime).
# Trước đây lấy pids[0] bừa — có thể là cmd.exe wrapper (cha) thay vì node.exe thật.
# Thứ tự ưu tiên: (1) dev thật (node.exe/next.exe/python.exe) > wrapper,
# (2) lá sâu nhất trong cây (process thật nằm ở đáy), (3) RSS lớn nhất,
# (4) create_time cũ nhất (PID có thể bị recycle nhanh).
def _canonical_pid_for_port(port):
    pids = list(_pids_listening_on_port(port))
    if not pids:
        return None
    if len(pids) == 1:
        return pids[0]
    ppid_map = _build_ppid_map()
    best, best_key = None, None
    for pid in pids:
        try:
            proc = psutil.Process(pid)
            name = proc.name().lower()
            rss = proc.memory_info().rss
            create = proc.create_time()
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
        wrapper = 1 if any(w in name for w in _WRAPPER_NAMES) else 0
        key = (wrapper, -_tree_depth(pid, ppid_map), -rss, -create)
        if best_key is None or key < best_key:
            best_key, best = key, pid
    return best or pids[0]

# WHY: Kiểm tra liveness của dev-server bằng PORT-PROBE: port nào có process
# whitelist đang LISTEN thì coi là chạy (KHÔNG tin PID lưu trên đĩa — root cause
# bug "server đang chạy hiển thị không chạy"). Cache 2s tránh quét psutil mỗi call.
def _is_port_running_for_dev(port):
    """Trả về True nếu có process thuộc whitelist dev server đang LISTEN trên port."""
    now = time.time()
    hit = _port_listen_cache.get(port)
    if hit and now - hit[1] < 2.0:
        return hit[0]
    result = False
    for pid in _pids_listening_on_port(port):
        try:
            name = psutil.Process(pid).name().lower()
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
        if any(w in name for w in DEV_SERVER_WHITELIST):
            result = True
            break
    _port_listen_cache[port] = (result, now)
    return result

# WHY: Kiểm tra port của 1 project đang bị chiếm bởi process phù hợp (theo loại).
# - type="node": dùng whitelist dev server cũ (node.exe, npm.exe...).
# - type="custom" + process_name: chỉ công nhận process có tên khớp (vd "node",
#   "python", "buzz-fwd.exe") đang LISTEN — tránh false positive từ app khác.
# - custom không có process_name: fallback về whitelist (buzz-fwd chạy bằng node.exe).
# Cache 2s riêng (chỉ custom) để không đụng cache chung whitelist.
_custom_port_listen_cache = {}  # (port, pname) -> (running: bool, timestamp)

# WHY: Tách riêng kiểm tra port cho từng project — custom type dùng process_name
# (node.exe) còn dev type dùng whitelist process dev server để tránh kill nhầm.
def _is_project_port_busy(proj):
    """Trả về True nếu port của project đang bị process phù hợp với loại project chiếm."""
    port = proj.get("port")
    if not port:
        return False
    pname = None
    if proj.get("type") == "custom" and proj.get("process_name"):
        pname = proj["process_name"].lower()
    if not pname:
        return _is_port_running_for_dev(port)
    now = time.time()
    key = (port, pname)
    hit = _custom_port_listen_cache.get(key)
    if hit and now - hit[1] < 2.0:
        return hit[0]
    result = False
    for pid in _pids_listening_on_port(port):
        try:
            name = psutil.Process(pid).name().lower()
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
        if pname in name:
            result = True
            break
    _custom_port_listen_cache[key] = (result, now)
    return result

# WHY: Kiểm tra process còn sống bằng poll() — không dùng returncode vì process có thể vừa chết.
# Thread-safe: process sẽ chạy trong processes dict.
# FIX: Trước đây chỉ check processes dict → server chạy ngoài app (hoặc backend restart,
# node.exe orphan từ phiên cũ) hiển thị "không chạy" dù server thực sự đang chiếm port.
# Fallback: kiểm tra port thực tế đang được dev-server LISTEN.
def is_running(name):
    with lock:
        p = processes.get(name)
        if p is not None and p.poll() is None:
            return True
    proj = get_project(name)
    if proj is not None:
        try:
            if _is_project_port_busy(proj):
                return True
        except Exception:
            pass
    return False

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
            "type": p.get("type", "node"),
            "process_name": p.get("process_name"),
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
    # Custom command có thể không có port (vd: tool không bind cổng nào) → bỏ qua.
    port = proj.get("port")
    if port:
        kill_process_on_port(port)
    
    # WHY: Với type="custom" (lệnh tùy chỉnh như buzz-fwd), KHÔNG kiểm tra node_modules
    # hay chạy npm install — không phải project Node.js. Node type giữ nguyên hành vi cũ.
    if proj.get("type") != "custom":
        if not Path(proj["path"]).exists():
            return {"name": name, "status": "error", "error": "Không tìm thấy thư mục"}
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
    
    cmd_str = proj.get("command", "npm run dev").replace("{port}", str(proj.get("port") or ""))
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

# WHY: Khi dừng project, tunnel trỏ về localhost:port của project trở nên vô dụng.
# Tự dừng tunnel kèm project để tránh cloudflared sống đối diện origin chết —
# nguồn gốc flood lỗi "Unable to reach the origin service" trong debug.log.
def _stop_tunnel_for_project(name):
    """Dừng tunnel của project (nếu có) khi project bị dừng."""
    try:
        with _tunnel_lock:
            has_tunnel = (name in _tunnel_processes
                          or name in _tunnel_urls
                          or _tunnel_status.get(name) not in (None, "stopped"))
        if has_tunnel:
            debug_log(f"[tunnel] Auto-stopping tunnel for {name} (project stopped)")
            _stop_tunnel_process(name)
    except Exception as e:
        debug_log(f"[tunnel] Auto-stop tunnel error for {name}: {e}")

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
# _stop_tunnel_for_project() để tunnel không sống đối diện origin chết.
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
            _stop_tunnel_for_project(p["name"])
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
# _stop_tunnel_for_project() để tunnel không sống đối diện origin chết.
def api_stop(name):
    proj = get_project(name)
    if not proj:
        return jsonify({"error": "Không tìm thấy"}), 404
    if not is_running(name):
        _stop_tunnel_for_project(name)
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
    _stop_tunnel_for_project(name)

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

    with open(lf, "rb") as f:
        lines = _read_tail_lines(f, 200)

    return jsonify({"lines": lines})

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
                    # WHY: File có thể bị truncate/rotate bên ngoài → pos cũ vượt quá
                    # kích thước mới → stream kẹt (f.read() trả rỗng vĩnh viễn).
                    f.seek(0, 2)
                    if pos > f.tell():
                        pos = 0
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
# Cap theo ?limit= (mặc định 2000) — trước đây đọc FULL file mỗi 5s (nghẽn I/O).
def api_logs_all():
    limit = request.args.get("limit", default=LOG_TAIL_LIMIT, type=int)
    limit = max(100, min(limit, 10000))
    all_lines = {}
    for p in config["projects"]:
        lf = get_log_file(p)
        _rotate_log_if_needed(lf)
        if lf.exists():
            with open(lf, "rb") as f:
                all_lines[p["name"]] = _read_tail_lines(f, limit)
        else:
            all_lines[p["name"]] = []
    return jsonify(all_lines)

AUTOSTART_SCRIPT = str(BASE_DIR / "auto-start.ps1")
REG_RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
APP_NAME = "MultiToolPro"

# WHY: Lấy đường dẫn exe của ứng dụng MultiTool Pro từ env (do Tauri truyền) hoặc fallback.
def get_app_exe_path():
    exe_path = os.environ.get("SERVER_DASHBOARD_EXE") or os.environ.get("MULTITOOL_PRO_EXE")
    if exe_path and os.path.exists(exe_path):
        return exe_path
    
    possible_paths = [
        BASE_DIR / "src-tauri" / "target" / "release" / "multitool-pro.exe",
        BASE_DIR / "multitool-pro.exe",
    ]
    for p in possible_paths:
        if p.exists():
            return str(p)
    return None

# WHY: Kiểm tra autostart trong Windows Registry (HKCU\Software\Microsoft\Windows\CurrentVersion\Run).
def is_registry_autostart_enabled():
    if sys.platform != "win32":
        return False
    try:
        import winreg
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, REG_RUN_KEY, 0, winreg.KEY_READ)
        val, _ = winreg.QueryValueEx(key, APP_NAME)
        winreg.CloseKey(key)
        return bool(val)
    except Exception:
        return False

# WHY: Kiểm tra tự động khởi động bằng cả Windows Registry & Startup folder shortcut (.lnk).
def autostart_shortcut_exists():
    if is_registry_autostart_enabled():
        return True
    startup = os.path.join(os.environ.get("APPDATA", ""), "Microsoft", "Windows", "Start Menu", "Programs", "Startup")
    if startup and os.path.exists(os.path.join(startup, f"{APP_NAME}.lnk")):
        return True
    return False

# WHY: Thiết lập tự động khởi động kép:
#   1. Tạo entry trong Windows Registry (HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run)
#   2. Tạo shortcut (.lnk) trong thư mục Windows Startup làm fallback
def set_autostart(enabled: bool):
    startup = os.path.join(os.environ.get("APPDATA", ""), "Microsoft", "Windows", "Start Menu", "Programs", "Startup")
    lnk = os.path.join(startup, f"{APP_NAME}.lnk")
    exe_path = get_app_exe_path()

    # 1. Cập nhật Windows Registry
    if sys.platform == "win32":
        try:
            import winreg
            key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, REG_RUN_KEY, 0, winreg.KEY_ALL_ACCESS)
            if enabled and exe_path:
                winreg.SetValueEx(key, APP_NAME, 0, winreg.REG_SZ, f'"{exe_path}"')
            else:
                try:
                    winreg.DeleteValue(key, APP_NAME)
                except FileNotFoundError:
                    pass
            winreg.CloseKey(key)
        except Exception as e:
            logger.warning(f"Lỗi cập nhật registry autostart: {e}")

    # 2. Cập nhật Startup Folder .lnk Shortcut
    if enabled:
        if exe_path:
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
        elif os.path.exists(AUTOSTART_SCRIPT):
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
        for fname in [f"{APP_NAME}.lnk", "MultiToolPro.lnk", "ServerDashboard.lnk", "Server Dashboard.lnk"]:
            fpath = os.path.join(startup, fname)
            if os.path.exists(fpath):
                try:
                    os.remove(fpath)
                except Exception:
                    pass

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
# WHY: POST create. Validate name required; path bắt buộc chỉ với type="node".
# type="custom" cho phép lệnh tùy chỉnh (không cần thư mục project/node_modules).
# Check duplicate name trước khi save.
def api_add_project():
    data = request.get_json()
    if not data or not data.get("name"):
        return jsonify({"error": "Yêu cầu tên"}), 400
    name = data["name"]
    if get_project(name):
        return jsonify({"error": "Dự án đã tồn tại"}), 409
    ptype = data.get("type", "node")
    if ptype not in ("node", "custom"):
        ptype = "node"
    if ptype == "node" and not data.get("path"):
        return jsonify({"error": "Yêu cầu tên và đường dẫn"}), 400
    port = data.get("port", 4000 + len(config["projects"]))
    command = data.get("command", "npm run dev" if ptype == "node" else "")
    new_proj = {"name": name, "type": ptype, "path": data.get("path", ""), "command": command, "port": port}
    if data.get("process_name"):
        new_proj["process_name"] = data["process_name"]
    if "start_on_launch" in data:
        new_proj["start_on_launch"] = bool(data["start_on_launch"])
    config["projects"].append(new_proj)
    save_config()
    _bump_config_version()
    return jsonify(new_proj), 201

# WHY: Tránh trùng tên khi auto-detect thêm project ("My App" → "My App (2)").
def _unique_name(name):
    if not get_project(name):
        return name
    i = 2
    while get_project(f"{name} ({i})"):
        i += 1
    return f"{name} ({i})"

# WHY: Trích (path, name, framework) từ cmdline khi không đọc được cwd của process
# khác (Windows). Pattern từ check-dev-services: đường dẫn đứng trước \node_modules.
def _guess_project_from_cmdline(cmdline):
    info = {"name": None, "path": None, "framework": None}
    text = " ".join(cmdline or [])
    m = re.search(r"([A-Za-z]:\\[^\"']*?)(?:\\node_modules|\\package\.json|$)", text)
    if m:
        p = Path(m.group(1))
        if (p / "package.json").exists():
            info["path"] = str(p)
            det = detect_project(str(p))
            if det:
                info["name"] = det["name"]
                info["framework"] = det["framework"]
    return info

@app.route("/api/config/projects/detect", methods=["POST"])
# WHY: Auto-detect framework + command + port cho 1 folder (SettingsModal
# "Browse Folder" → auto-fill form). Trả detected=False nếu không có marker.
def api_detect_project():
    data = request.get_json() or {}
    result = detect_project(data.get("path", ""))
    if result is None:
        return jsonify({"detected": False, "error": "Không phát hiện project dev trong thư mục này"}), 404
    result["name"] = _unique_name(result["name"])
    return jsonify({"detected": True, "project": result})

@app.route("/api/projects/detected")
# WHY: Quét port đang có dev-server LISTEN (1 lần psutil scan, <100ms) trả về
# server CHƯA nằm trong config → UI đề xuất "Thêm vào cấu hình".
# KHÔNG merge vào /api/projects — contract start/stop/tunnel giữ nguyên.
def api_detected_projects():
    configured_ports = {p.get("port") for p in config["projects"]}
    detected = []
    try:
        for conn in psutil.net_connections(kind="tcp"):
            if conn.status != "LISTEN" or not conn.laddr or not conn.pid:
                continue
            port = conn.laddr.port
            if port < 1024 or port in configured_ports or any(d["port"] == port for d in detected):
                continue
            try:
                proc = psutil.Process(conn.pid)
                name = proc.name().lower()
                cmdline = proc.cmdline()
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                # WHY: Process có thể chết giữa name() và cmdline() — bỏ qua thay vì
                # hủy cả scan (trước đây lỗi NoSuchProcess văng ra ngoài try → catch ở
                # hàm cha → log "api_detected_projects error" và KHÔNG trả detected nào).
                continue
            if not any(w in name for w in DEV_SERVER_WHITELIST):
                continue
            guess = _guess_project_from_cmdline(cmdline)
            detected.append({
                "port": port,
                "pid": conn.pid,
                "process": proc.name(),
                "name": guess["name"] or f"Server :{port}",
                "path": guess["path"],
                "framework": guess["framework"],
                "command": "npm run dev",
            })
    except Exception as e:
        debug_log(f"api_detected_projects error: {e}")
    return jsonify({"detected": detected, "count": len(detected)})

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
    for k in ("path", "command", "port", "start_on_launch", "type", "process_name"):
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
    _stop_tunnel_for_project(name)
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
        candidates = []
        seen_pids = set()
        for proc in psutil.process_iter(['pid', 'name']):
            try:
                # WHY: Bỏ ngay PID 0 (System Idle Process) — nó sở hữu socket "orphan"
                # của process đã chết và thường có LISTEN trùng port cần kill → log SKIP
                # spam (hàng chục dòng/lần kill) nhưng không thể kill. Bỏ sớm để tiết kiệm
                # gọi connections() + tránh nhiễu log.
                if proc.pid <= 1 or proc.name().lower() in ("system idle process", "system"):
                    continue
                for conn in proc.connections(kind='inet'):
                    # WHY: Chỉ xử lý connection LISTEN — TIME_WAIT/ESTABLISHED của
                    # process đã chết thường để lại socket "owned" bởi PID 0
                    # (System Idle Process) → log SPAM + risk kill nhầm trước đây.
                    if conn.status != "LISTEN" or conn.laddr.port != port:
                        continue
                    proc_name = proc.name().lower()
                    # WHITELIST: Chỉ kill các process liên quan đến dev servers
                    # WHY: Thêm python.exe để dọn Python dev server/script chiếm port.
                    if any(allowed_name in proc_name for allowed_name in DEV_SERVER_WHITELIST):
                        # WHY: Dedupe theo PID — 1 process có thể có NHIỀU LISTEN socket
                        # trên cùng port (IPv4+IPv6, đa interface) → trước đây bị thêm
                        # lặp, log "Killing" nhiều lần + gọi kill() thừa lần 2 (NoSuchProcess).
                        if proc.pid not in seen_pids:
                            seen_pids.add(proc.pid)
                            candidates.append((proc.pid, proc.name()))
                    else:
                        debug_log(f"SKIP killing on port {port}: PID={proc.pid}, name={proc.name()} (not in whitelist)")
            except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                pass
        if candidates:
            # WHY: Kill lá → gốc (con trước, cha sau). Kill cha trước để con mồ côi
            # tiếp tục chiếm port → is_running vẫn báo "đang chạy" (bug).
            ppid_map = _build_ppid_map()
            order = sorted(candidates, key=lambda c: -_tree_depth(c[0], ppid_map))
            for pid, name in order:
                try:
                    debug_log(f"Killing process on port {port}: PID={pid}, name={name}")
                    psutil.Process(pid).kill()
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    pass
    except Exception as e:
        debug_log(f"kill_process_on_port error: {e}")

# WHY: Cache psutil.Process instances theo pid để cpu_percent() có baseline thật.
# interval=None trả delta so với lần gọi TRƯỚC trên CÙNG instance — code cũ tạo
# instance mới mỗi lần → luôn trả 0.0 → CPU hiển thị 0% mãi (bug).
# Cache bị prune sau 60s (process có thể restart, pid bị tái sử dụng).
_cpu_proc_cache = {}  # pid -> (psutil.Process instance, last_seen_time)

# WHY: _get_cpu_percent — CPU % của 1 pid, tái dùng instance cache để có baseline.
# Lần đầu gặp pid: seed baseline (trả 0.0), lần sau trả delta thật (poll 4s).
def _get_cpu_percent(pid):
    now = time.time()
    entry = _cpu_proc_cache.get(pid)
    if entry and now - entry[1] < 60:
        inst = entry[0]
        try:
            val = inst.cpu_percent(interval=None)
            _cpu_proc_cache[pid] = (inst, now)
            return val if val is not None else 0.0
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            _cpu_proc_cache.pop(pid, None)
            return 0.0
    try:
        inst = psutil.Process(pid)
        inst.cpu_percent(interval=None)  # seed: lần gọi đầu luôn trả 0.0
        _cpu_proc_cache[pid] = (inst, now)
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        return 0.0
    return 0.0

# WHY: Prune cache — xóa mọi entry chưa được truy cập trong 60s.
# Tránh dict phình vô hạn khi process restart liên tục (mỗi restart = pid mới).
def _prune_cpu_cache():
    now = time.time()
    for pid in [p for p, (_, seen) in _cpu_proc_cache.items() if now - seen > 60]:
        _cpu_proc_cache.pop(pid, None)

# WHY: Tính tổng memory + CPU của parent + children (recursive) — Node.js thường spawn child processes.
# CPU dùng _get_cpu_percent() (cache baseline) thay vì tạo instance mới mỗi lần (bug CPU 0%).
def get_process_memory_and_cpu(pid):
    """Lấy thông tin memory và CPU của process bằng psutil"""
    # WHY: Prune cache định kỳ — xóa entry cũ hơn 60s (pid chết/restart) để
    # dict không phình vô hạn trong session dài. Gọi mỗi poll diagnostics (4s).
    _prune_cpu_cache()
    try:
        parent = psutil.Process(pid)
        mem = parent.memory_info().rss
        cpu = _get_cpu_percent(pid)
        try:
            for child in parent.children(recursive=True):
                try:
                    mem += child.memory_info().rss
                    cpu += _get_cpu_percent(child.pid)
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
        if pid is None:
            # WHY: Chọn canonical PID (dev thật, lá sâu nhất, RSS cao) thay vì
            # pids[0] bừa — tránh đo nhầm memory/CPU của wrapper cmd.exe.
            pid = _canonical_pid_for_port(proj.get("port"))
        if pid:
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
        _stop_tunnel_for_project(name)
            
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
# Lưu memory/cpu usage history của từng project — GIỮ TRONG MEMORY (không ghi đĩa).
# WHY: Trước đây ghi perf_history.json xuống đĩa mỗi 4s/project đang expand —
# I/O phí phạm vì frontend KHÔNG hề gọi /api/projects/<name>/perf-history
# (grep toàn src/ = 0 kết quả). Giữ API + test hoạt động nhưng bỏ ghi đĩa.
# Format: {project_name: [{timestamp, memory, cpu}, ...]}
PERF_HISTORY_MAX = 60  # Giữ tối đa 60 entries/project (~2 phút với polling 2s)
perf_lock = threading.Lock()
_perf_history_memory = {}  # in-memory history — không còn file JSON

# WHY: load_perf_history — Thread-safe (perf_lock). Trả về history từ memory.
# Trả bản copy (deep-ish) để caller không mutate dict gốc.
def load_perf_history():
    with perf_lock:
        return {k: list(v) for k, v in _perf_history_memory.items()}

# WHY: record_perf_snapshot — append snapshot vào memory dict, giữ tối đa
# PERF_HISTORY_MAX entries. KHÔNG ghi đĩa (data này frontend không đọc).
# Lock xuyên suốt để tránh race khi 2 diagnostics requests chạy đồng thời.
def record_perf_snapshot(name, memory, cpu):
    with perf_lock:
        if name not in _perf_history_memory:
            _perf_history_memory[name] = []
        _perf_history_memory[name].append({
            "timestamp": datetime.now().isoformat(),
            "memory": memory,
            "cpu": cpu
        })
        _perf_history_memory[name] = _perf_history_memory[name][-PERF_HISTORY_MAX:]

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
_tunnel_endpoint_counts = {}  # {project_name: {endpoint: count}} - thống kê endpoint được gọi nhiều nhất
_tunnel_alert_thresholds = {}  # {project_name: float} - ngưỡng request rate (0 = tắt)
_tunnel_already_alerted = {}   # {project_name: float} - timestamp lần alert gần nhất (cooldown)
_tunnel_metrics_ports = {}     # {project_name: int} - port metrics server của cloudflared (default 20241)
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
# Giữ tối đa 60 snapshots (~10 phút). Mỗi snapshot: {t: timestamp, c: total_count}
# WHY: Sử dụng cloudflared metrics endpoint (port 20241/metrics) thay vì parse stderr
# vì cloudflared 2026+ dùng QUIC protocol, không log HTTP request lines ra stderr.
# Metrics endpoint có cloudflared_tunnel_total_requests counter chính xác.

# WHY: Lấy port metrics server của tunnel. KHÔNG fallback về 20241 mặc định —
# cloudflared chạy nhiều tunnel sẽ tự tăng port (20241, 20242...) nếu bận,
# đoán 20241 bừa sẽ đọc nhầm metrics của tunnel khác (race khi reader thread
# chưa kịp parse dòng 'Starting metrics server on 127.0.0.1:PORT/metrics').
def _get_tunnel_metrics_port(name):
    """Lấy port metrics server của tunnel. Trả None nếu chưa parse được."""
    return _tunnel_metrics_ports.get(name)

# WHY: Worker đọc request count từ cloudflared metrics endpoint (port ĐỘNG đã
# parse từ stderr) — đo số thực thay vì ước lượng; tránh read nhầm tunnel khác.
def _fetch_tunnel_metrics(name):
    """Đọc cloudflared_tunnel_total_requests từ metrics endpoint.
    Dùng port động từ _tunnel_metrics_ports (parse từ stderr) thay vì hardcode 20241.
    Trả về số request hoặc None nếu metrics chưa available."""
    try:
        port = _get_tunnel_metrics_port(name)
        if port is None:
            return None
        req = urllib.request.Request(f"http://127.0.0.1:{port}/metrics")
        with urllib.request.urlopen(req, timeout=3) as resp:
            body = resp.read().decode('utf-8')
            # WHY: Dùng regex tránh parse Prometheus format phức tạp
            m = re.search(r'^cloudflared_tunnel_total_requests\s+(\d+)', body, re.MULTILINE)
            if m:
                return int(m.group(1))
    except Exception:
        pass
    return None

_REQUEST_HISTORY_MAX = 60
_REQUEST_HISTORY_INTERVAL = 10

# WHY: Background thread DUY NHẤT ghi snapshot request count mỗi 10s cho MỌI
# tunnel active. Ghi 1 lần/chu kỳ sau khi fetch xong toàn bộ (bug cũ: vòng ghi
# LỒNG trong vòng fetch + shadow biến `name` → N lần snapshot/tunnel mỗi chu kỳ).
def _request_history_worker():
    """Thread ghi snapshot request count mỗi 10s cho tất cả tunnels đang active.
    Sử dụng cloudflared metrics endpoint (port 20241) thay vì parse stderr."""
    while True:
        try:
            time.sleep(_REQUEST_HISTORY_INTERVAL)
            # WHY: Fetch metrics từ cloudflared — đo request count realtime.
            # Port metrics là port ĐỘNG (parse từ stderr, xem _get_tunnel_metrics_port)
            # vì cloudflared chạy nhiều tunnel sẽ tự tăng port khi 20241 bận.
            with _tunnel_lock:
                active_tunnels = list(_tunnel_processes.keys())
            
            # WHY: Fetch metrics riêng cho từng tunnel (dùng port động)
            for name in active_tunnels:
                metrics_count = _fetch_tunnel_metrics(name)
                if metrics_count is not None:
                    with _tunnel_lock:
                        _tunnel_request_counts[name] = metrics_count

            # WHY: Ghi snapshot 1 lần mỗi chu kỳ cho tất cả tunnels active.
            # (Bug cũ: vòng này LỒNG trong vòng for name bên trên + dùng lại biến `name`
            #  → shadow biến vòng ngoài. Với N tunnel mỗi chu kỳ append N snapshot/tunnel,
            #  history đầy nhanh gấp N lần và count bị lẫn giữa các tunnel.)
            with _tunnel_lock:
                active_now = list(_tunnel_processes.items())
            for pname, proc in active_now:
                if proc.poll() is None:  # Process still alive
                    current_count = _tunnel_request_counts.get(pname, 0)
                    if pname not in _tunnel_request_history:
                        _tunnel_request_history[pname] = []
                    _tunnel_request_history[pname].append({
                        't': time.time(),
                        'c': current_count,
                    })
                    # WHY: Giữ tối đa 60 snapshots (~10 phút)
                    if len(_tunnel_request_history[pname]) > _REQUEST_HISTORY_MAX:
                        _tunnel_request_history[pname] = _tunnel_request_history[pname][-_REQUEST_HISTORY_MAX:]
        except Exception as e:
            debug_log(f"[request-history] Error: {e}")

threading.Thread(target=_request_history_worker, daemon=True).start()

# ─── Tunnel Alert System ────────────────────────────────────────
# WHY: Background thread kiểm tra request rate mỗi 30s cho tunnels có alert threshold.
# Khi request rate > ngưỡng, gửi Windows toast notification.
# Dùng cooldown 5 phút để tránh spam.

ALERT_CHECK_INTERVAL = 30    # Check mỗi 30s
ALERT_COOLDOWN = 300          # Cooldown 5 phút giữa các notification

# WHY: Toast Windows không cần .exe phụ — dùng PowerShell Windows.UI.Notifications
# trực tiếp (BurntToast không luôn có). Escape `''` tránh injection vào chuỗi PS.
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


# WHY: Escape chuỗi cho an toàn trong XML attribute/text (tên máy in có thể chứa & < >) khi nhúng vào toast XML.
def _xml_escape(s):
    """Escape chuỗi cho an toàn trong XML attribute/text (tên máy in có thể chứa & < >)."""
    return (str(s).replace('&', '&amp;').replace('<', '&lt;')
            .replace('>', '&gt;').replace('"', '&quot;').replace("'", '&apos;'))


# WHY: Gửi Windows toast kèm nút hành động '⚡ Gán IP' cho từng máy phát hiện được — toast mở SPA với ?printer=<tên> để App.tsx chuyển tab + mở card máy đó.
def _show_printer_toast(detections):
    """Gửi Windows toast kèm nút hành động '⚡ Gán IP' cho từng máy phát hiện được.
    Bấm nút (activationType=protocol) → mở SPA backend serve tại 127.0.0.1:5050 với
    query ?printer=<tên máy> → App.tsx đọc param, chuyển tab Máy in + tự mở card máy đó.
    Dùng template ToastGeneric (ToastText02 của _show_windows_toast không hỗ trợ action button).
    Viết XML ra temp file rồi load qua XmlDocument để tránh lỗi escape khi truyền inline."""
    try:
        from urllib.parse import quote
        if not detections:
            return False
        pending = detections[:3]
        title = '📡 Phát hiện máy in mạng mới'
        if len(pending) > 1:
            title += f' ({len(pending)} máy)'
        lines = [
            f"<text>{_xml_escape(d.get('printer_name', 'Máy in'))} tại "
            f"{_xml_escape(str(d.get('ip', '?')))} — chưa cấu hình IP</text>"
            for d in pending
        ]
        actions = []
        for d in pending:
            name = d.get('printer_name', 'Máy in')
            url = f'http://127.0.0.1:5050/?printer={quote(name, safe="")}'
            actions.append(
                f'<action activationType="protocol" arguments="{_xml_escape(url)}" '
                f'content="⚡ Gán IP: {_xml_escape(name)}"/>'
            )
        xml = (
            '<?xml version="1.0" encoding="utf-8"?>\n<toast>\n  <visual>\n'
            '    <binding template="ToastGeneric">\n'
            f'      <text>{_xml_escape(title)}</text>\n'
            + ''.join(f'      {ln}\n' for ln in lines)
            + '    </binding>\n  </visual>\n  <actions>\n'
            + ''.join(f'    {a}\n' for a in actions)
            + '  </actions>\n</toast>'
        )
        import tempfile, os
        xml_path = os.path.join(tempfile.gettempdir(), 'multitool_printer_toast.xml')
        with open(xml_path, 'w', encoding='utf-8') as f:
            f.write(xml)
        try:
            ps_code = (
                "$doc = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]\n"
                f"$doc.LoadXml([IO.File]::ReadAllText('{xml_path}'))\n"
                "$toast = [Windows.UI.Notifications.ToastNotification]::new($doc)\n"
                '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("MultiTool Pro").Show($toast)'
            )
            subprocess.run(
                ["powershell", "-NoProfile", "-Command", ps_code],
                capture_output=True, timeout=5,
                startupinfo=get_startupinfo(),
                creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
            )
        finally:
            try:
                os.remove(xml_path)
            except Exception:
                pass
        return True
    except Exception as e:
        debug_log(f"[alert] Printer toast failed: {e}")
        return False


# Lock bọc check→send→mark của retry toast — 2 thread retry cùng key thức dậy cùng
# lúc sẽ không cùng vượt qua re-check notified rồi gửi trùng (race hiếm, tự phục hồi
# ở scan sau, nhưng đóng chặt cho chắc).
_toast_retry_lock = threading.Lock()


# WHY: Retry gửi toast 1 lần sau 10s khi lần đầu THẤT BẠI — chạy thread riêng, tôn trọng lan_scan_notify + re-check notified từ settings mới để tránh toast trùng.
def _retry_printer_toast(pending):
    """Retry gửi toast 1 lần sau 10s khi lần đầu THẤT BẠI — chạy trong THREAD RIÊNG
    nên không block worker quét nền hay Flask. Trước khi gửi lại: (1) tôn trọng
    lan_scan_notify — user có thể TẮT thông báo trong lúc retry đang ngủ; (2) RE-CHECK
    notified từ settings mới — nếu luồng khác đã thông báo thành công cùng key thì bỏ
    qua, tránh toast trùng và tránh log 'vừa thành công vừa thất bại cùng lúc'."""
    try:
        time.sleep(10)
        settings = load_printer_settings()
        if not settings.get('lan_scan_notify', True):
            return
        with _toast_retry_lock:
            notified = set(settings.get('lan_scan_notified') or [])
            pending = [d for d in pending if d.get('key') not in notified]
            if not pending:
                return
            if _show_printer_toast(pending):
                debug_log(f"[printer-scan] Toast retry thành công sau 10s cho: "
                          + ', '.join(f"{d['printer_name']} ({d['ip']})" for d in pending))
                settings['lan_scan_notified'] = list(
                    (notified | {d['key'] for d in pending}))[:200]
                try:
                    save_printer_settings(settings)
                except Exception:
                    pass
            else:
                debug_log(f"[printer-scan] Toast retry THẤT BẠI sau 10s — bỏ: "
                          + ', '.join(f"{d['printer_name']} ({d['ip']})" for d in pending))
    except Exception:
        pass


# WHY: Cảnh báo khi request rate vượt ngưỡng — rate tính từ diff ~60s window
# (không phải count/uptime lifetime bị pha loãng bởi uptime dài) + cooldown 5p.
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
                    
                    # WHY: Rate = diff history window ~60s (không phải count/uptime
                    # lifetime average — bị pha loãng bởi uptime dài, bỏ lỡ spike).
                    rate = _tunnel_recent_rate(name)
                    
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

# WHY: Rate thật = diff count giữa snapshot gần nhất và snapshot cách ~60s,
# chia cho khoảng thời gian. KHÔNG dùng count/uptime (lifetime average —
# bị pha loãng bởi uptime dài, bỏ lỡ spike request).
def _tunnel_recent_rate(name):
    """Request rate hiện tại (req/s) từ request history window ~60s.
    Trả 0 nếu chưa đủ 2 snapshots hoặc window <= 0."""
    # WHY: Copy list TRƯỚC khi đọc — _request_history_worker append + rebind
    # list này NGOÀI _tunnel_lock, còn hàm này được gọi từ Flask thread (không lock).
    # Lặp reversed() trên list đang bị append đồng thời có thể raise
    # RuntimeError "list changed size during iteration" → copy trước là an toàn.
    history = list(_tunnel_request_history.get(name, []))
    if len(history) < 2:
        return 0
    latest = history[-1]
    # WHY: Tìm snapshot cách đây >= 50s (gần nhất với window 1 phút)
    base = None
    for e in reversed(history):
        if latest['t'] - e['t'] >= 50:
            base = e
            break
    if base is None:
        base = history[0]
    dt = latest['t'] - base['t']
    if dt <= 0:
        return 0
    # WHY: Clamp max(0, ...) — sau khi tunnel restart, counter metrics reset về 0
    # trong khi history cũ vẫn còn → diff có thể âm (rate âm vô nghĩa).
    return round(max(0, latest['c'] - base['c']) / dt, 2)

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
                "endpoint_counts": _tunnel_endpoint_counts.get(name, {}),
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
                "endpoint_counts": _tunnel_endpoint_counts.get(name, {}),
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
            "request_rate": _tunnel_recent_rate(name),
            "request_history": history[-40:] if history else [],
            "endpoint_counts": _tunnel_endpoint_counts.get(name, {}),
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
            # WHY: Throttle log — cloudflared lặp lại cùng 1 dòng lỗi hàng trăm lần khi
            # origin down ("Unable to reach the origin service"). Chỉ log dòng đầu tiên,
            # sau đó log lại sau 60s nếu dòng giống hệt vẫn còn — tránh flood debug.log.
            last_log = None  # (line, timestamp)
            try:
                for line in process.stderr:
                    stripped = line.strip()
                    now = time.time()
                    if last_log and stripped == last_log[0] and (now - last_log[1]) < 60:
                        continue
                    last_log = (stripped, now)
                    debug_log(f"[tunnel-{pname}] {stripped[:200]}")
                    match = re.search(r'https://[a-zA-Z0-9_-]+\.trycloudflare\.com', line)
                    if match:
                        url = match.group(0)
                        with _tunnel_lock:
                            _tunnel_urls[pname] = url
                            _tunnel_status[pname] = "active"
                            _tunnel_started_at[pname] = time.time()
                        debug_log(f"Tunnel URL for {pname}: {url}")
                        # WHY: Không break — tiếp tục đọc để debug (dù cloudflared 2026+ không log request ra stderr)
                    # WHY: Parse metrics server port từ stderr để tránh hardcode 20241
                    # Dòng log: "Starting metrics server on 127.0.0.1:PORT/metrics"
                    metrics_port_match = re.search(r'Starting metrics server on 127\.0\.0\.1:(\d+)/metrics', line)
                    if metrics_port_match:
                        mp = int(metrics_port_match.group(1))
                        with _tunnel_lock:
                            _tunnel_metrics_ports[pname] = mp
                        debug_log(f"[tunnel-{pname}] Metrics port: {mp}")
                    # WHY: Request counting dùng metrics endpoint (cloudflared_tunnel_total_requests)
                    # trong _request_history_worker thay vì parse stderr (cloudflared 2026.7 không còn log HTTP request lines)
                    if "error" in line.lower() or "failed" in line.lower():
                        with _tunnel_lock:
                            # WHY: Lỗi "Unable to reach the origin service" = origin (dev server)
                            # đang down — KHÔNG phải lỗi tunnel. Tunnel vẫn kết nối Cloudflare OK,
                            # chỉ origin không phản hồi. KHÔNG hạ status xuống "error" (trước đây
                            # tunnel active bị đánh dấu LỖI đỏ vĩnh viễn + nút "Thử lại" vô nghĩa
                            # vì retry tunnel không cứu được origin đang tắt). Chỉ đánh dấu error
                            # khi tunnel CHƯA có URL (chưa kết nối được Cloudflare).
                            _tunnel_errors[pname] = stripped
                            if pname not in _tunnel_urls:
                                _tunnel_status[pname] = "error"
                process.wait()
                with _tunnel_lock:
                    if _tunnel_processes.get(pname) == process:
                        _tunnel_processes.pop(pname, None)
                        _tunnel_started_at.pop(pname, None)
                        _tunnel_request_counts.pop(pname, None)
                        _tunnel_request_history.pop(pname, None)
                        _tunnel_endpoint_counts.pop(pname, None)
                        _tunnel_metrics_ports.pop(pname, None)
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
            _tunnel_endpoint_counts.pop(project_name, None)
            _tunnel_metrics_ports.pop(project_name, None)
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
        # WHY: Tắt watchdog khi stop thủ công — nếu không, flag dính "enabled" →
        # UI hiển thị watchdog BẬT cho tunnel đã dừng và worker thread loop vô ích.
        # (Sleep-detector cũng sẽ không restart tunnel bị user tắt chủ đích.)
        _tunnel_watchdog_enabled.pop(name, None)
        # WHY: Không clear _tunnel_restart_counts — giữ lifetime stats
        _tunnel_started_at.pop(name, None)
        _tunnel_request_counts.pop(name, None)
        _tunnel_request_history.pop(name, None)
        _tunnel_endpoint_counts.pop(name, None)
        _tunnel_metrics_ports.pop(name, None)
    
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
# WHY: Khóa restart riêng cho từng tunnel — watchdog worker, sleep-detector và
# api_tunnel_watchdog (restart ngay khi bật) đều có thể gọi _auto_restart_tunnel
# đồng thời. Không có lock → 2 luồng cùng launch 2 cloudflared + đếm restart 2 lần.
_tunnel_restart_locks = {}  # {project_name: threading.Lock}

# WHY: Lấy (hoặc tạo) lock restart của tunnel. Gọi dưới _tunnel_lock để tránh
# race tạo dict entry trùng. Lock giữ lại trong dict — 1 Lock/name, rất nhỏ.
def _get_tunnel_restart_lock(name):
    with _tunnel_lock:
        if name not in _tunnel_restart_locks:
            _tunnel_restart_locks[name] = threading.Lock()
        return _tunnel_restart_locks[name]

# WHY: Watchdog restart tunnel khi cloudflare chết — lock non-blocking chống
# double-launch; nếu tunnel vừa được user/API start thủ công thì KHÔNG restart.
def _auto_restart_tunnel(project_name):
    """Watchdog: dừng tunnel cũ + launch tunnel mới"""
    restart_lock = _get_tunnel_restart_lock(project_name)
    # WHY: acquire non-blocking — nếu luồng khác đang restart tunnel này,
    # bỏ qua ngay (tránh double-launch cloudflared + double-count restart_count).
    if not restart_lock.acquire(blocking=False):
        debug_log(f"[watchdog] Restart for {project_name} already in progress, skipping")
        return True
    try:
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
            _tunnel_endpoint_counts.pop(project_name, None)
            _tunnel_metrics_ports.pop(project_name, None)
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
        
        # WHY: Re-check NGAY TRƯỚC khi launch — user có thể manual start (API) xen
        # vào trong cửa sổ sleep(2) ở trên (sau khi old_proc đã bị pop). Lúc đó
        # _tunnel_processes đã có process MỚI đang sống → bỏ launch để tránh
        # 2 cloudflared chạy cùng lúc (double-launch).
        with _tunnel_lock:
            mid_proc = _tunnel_processes.get(project_name)
            if mid_proc is not None and mid_proc.poll() is None:
                debug_log(f"[watchdog] Tunnel {project_name} started manually during restart, aborting our launch")
                return True
        
        success, err = _launch_tunnel_process(project_name, port)
        if success:
            with _tunnel_lock:
                _tunnel_restart_counts[project_name] = _tunnel_restart_counts.get(project_name, 0) + 1
            debug_log(f"[watchdog] Tunnel auto-restarted for {project_name} (#{_tunnel_restart_counts.get(project_name)})")
        else:
            debug_log(f"[watchdog] Auto-restart failed for {project_name}: {err}")
        return success
    finally:
        restart_lock.release()

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

# WHY: Endpoint NHẸ để Dashboard poll 2s — chỉ trả version/config count; UI chỉ
# fetch full data khi version đổi (tiết kiệm bandwidth/CPU so với poll full 4s).
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

# WHY: Ghi toàn bộ dict metrics vào file JSON (file nhỏ <1MB) dưới lock — thread-safe.
def _save_hourly_metrics(data):
    with _hourly_metrics_lock:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        with open(HOURLY_METRICS_FILE, 'w') as f:
            json.dump(data, f, indent=2)

# WHY: Background thread snapshot mỗi giờ — chỉ lưu tunnel đang active, xóa data
# >30 ngày khi ghi để file không phình vô hạn theo thời gian.
def _hourly_metrics_worker():
    """Background thread: snapshot metrics mỗi giờ.
    Chỉ snapshot tunnels đang active (có URL).
    Xóa dữ liệu cũ hơn 30 ngày mỗi lần ghi."""
    while True:
        try:
            time.sleep(3600)  # 1 giờ
            now = time.time()
            cutoff = now - (HOURLY_METRICS_MAX_DAYS * 86400)
            
            existing = _load_hourly_metrics()
            with _tunnel_lock:
                active_names = [
                    name for name, proc in _tunnel_processes.items()
                    if proc.poll() is None and _tunnel_urls.get(name)
                ]
                snapshot = {}
                for name in active_names:
                    count = _tunnel_request_counts.get(name, 0)
                    # WHY: Rate = diff so với snapshot giờ trước (không phải count/uptime
                    # lifetime average — bị pha loãng bởi uptime dài, bỏ lỡ spike).
                    prev = existing.get(name, [])[-1] if existing.get(name) else None
                    if prev and now - prev['t'] > 0:
                        # WHY: Clamp max(0, ...) — counter reset sau restart tunnel →
                        # diff so với snapshot giờ trước có thể âm.
                        rate = round(max(0, count - prev['c']) / (now - prev['t']), 2)
                    else:
                        rate = 0
                    snapshot[name] = {
                        't': now,
                        'c': count,
                        'r': rate,
                        's': _tunnel_status.get(name, 'active'),
                    }
            
            if not snapshot:
                continue
            
            # WHY: Merge snapshot vào file, xóa data cũ hơn 30 ngày
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

# WHY: Trả lịch sử request rate đã lưu theo range (24h/7d/30d) — UI vẽ chart
# request rate theo thời gian, không phải số liệu realtime.
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

# WHY: Export cấu hình tunnels (watchdog/restart_count/cloudflared) ra JSON để
# backup hoặc migrate sang máy khác — kể cả project chưa có tunnel config.
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

# WHY: Export metrics hiện tại của MỌI project (status/rate/uptime/watchdog...) ra
# JSON hoặc CSV (CSV kèm BOM để Excel đọc UTF-8 đúng) — phục vụ phân tích ngoài app.
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

# WHY: Import file export trước đó — chỉ restore WATCHDOG settings, KHÔNG tự động
# start tunnel; project không tồn tại trong config thì skip (đếm vào skipped).
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
    """Lấy thời gian process đã chạy (giây). Hỗ trợ server chạy ngoài app:
    nếu không có trong processes dict, fallback sang PID đang nghe trên port."""
    pid = None
    with lock:
        p = processes.get(name)
        if p and p.pid:
            pid = p.pid
    if pid is None:
        proj = get_project(name)
        if proj:
            pid = _canonical_pid_for_port(proj.get("port"))
    if pid:
        try:
            proc = psutil.Process(pid)
            create_time = proc.create_time()
            return int(time.time() - create_time)
        except Exception:
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

# ─── Notification API ──────────────────────────────────────────
# WHY: Cho frontend bắn Windows toast qua API — dùng chung _show_windows_toast()
# với tunnel alert system để có 1 nguồn toast duy nhất.
@app.route("/api/notify", methods=["POST"])
def api_notify():
    """Gửi Windows toast notification.
    POST JSON: {"title": "...", "message": "..."}
    Dùng chung _show_windows_toast() với tunnel alert system."""
    data = request.get_json() or {}
    title = data.get("title", "MultiTool Pro")
    message = data.get("message", "")
    if not message:
        return jsonify({"error": "Yêu cầu message"}), 400
    ok = _show_windows_toast(title, message)
    return jsonify({"sent": ok})

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

# WHY: Giao diện thống nhất gọi PrinterMonitor — ưu tiên C# exe (nhanh, JSON trực
# tiếp) rồi PowerShell fallback (luôn available trên Windows) cho query/stats/listen.
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
    # ─── NÂNG CẤP: Vật tư & supplies ─────────────────────────────
    # printer_ips: {printer_name: ip} — địa chỉ IP cho máy in MẠNG (SNMP/PJL)
    #   → cho phép đọc tự động page_count + % toner/drum/ink (RFC 3805)
    # manual_supplies: {printer_name: {supply_key: percent}}
    #   → dùng cho máy in USB (không có SNMP): người dùng tự nhập % còn lại
    #   supply_key: "toner" | "drum" | "ink" | ... (tên do người dùng đặt)
    "printer_ips": {},      # {printer_name: "192.168.1.100"}
    # printer_communities: {printer_name: "public"|"admin"|...} — SNMP community string
    #   → mặc định "public"; một số máy in đổi community để bảo mật
    "printer_communities": {},
    "manual_supplies": {},  # {printer_name: {"toner": 80, "drum": 45}}
    # supply_warning_threshold: Ngưỡng % cảnh báo vật tư thấp (mực/drum)
    "supply_warning_threshold": 20,
    # ─── Quét LAN nền — tự phát hiện máy in mạng chưa cấu hình IP ──
    "lan_scan_enabled": True,           # bật/tắt worker quét nền (mặc định 5 phút)
    "lan_scan_interval_minutes": 5,     # chu kỳ quét (phút, clamp 1-120)
    "lan_scan_subnet": "",              # subnet quét (VD "192.168.1.0/24"); trống = tự động /24
    "lan_scan_notify": True,            # gửi Windows toast khi phát hiện máy in mới (cả khi app ẩn)
    "lan_scan_notified": [],            # ["ip|printer_name"] — đã gửi toast (chống báo lại sau restart)
    "dismissed_detections": [],         # ["ip|printer_name"] — gợi ý người dùng đã ẩn
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
# WHY: TTL 2 phút cho cache page count — số trang chỉ đổi khi có job in mới, không cần
# query lại mỗi 10s poll. Trước đây TTL 30s VÀ cache check nằm SAU layer C# (layer C#
# return sớm nên cache không bao giờ được đọc lại) → mỗi poll chạy lại query EventLog
# 30 ngày → timeout 10s với log lớn (xem query_printer_page_count_eventlogs).
EVENTLOG_CACHE_TTL = 120

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

# WHY: Quyết định CÁCH đếm trang theo loại driver: GDI/host-based (Brother,
# Samsung...) KHÔNG sinh Event ID 307 → phải dùng WMI/manual; PCL/PostScript
# đọc được từ EventLog. Brand + model override giúp chọn đúng tracking method.
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
# Được gọi từ 2 nơi: frontend poll /api/printer/auto-detect VÀ background listener
# thread (_printer_job_listener_worker) — snapshot dùng chung nên không double-count.
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
    - Chỉ phát hiện được khi có listener quét liên tục (frontend poll auto-detect
      HOẶC background thread _printer_job_listener_worker — thread đảm bảo detection
      kể cả khi UI đang ở tab khác)
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
            # WHY: Khởi tạo rỗng TRƯỚC try — nếu OpenPrinter/EnumJobs fail (máy in
            # tắt/ngủ/unplugged), carry-forward snapshot cũ để KHÔNG báo false-positive
            # "job hoàn thành" (trước đây printer thiếu trong current_jobs → mọi job cũ
            # bị coi là đã xong → phantom page_count +1 mỗi lần quét khi máy in offline;
            # với background listener chạy 24/7 thì rủi ro này cao hơn nhiều).
            current_jobs[name] = {}
            try:
                handle = win32print.OpenPrinter(name)
                try:
                    jobs = win32print.EnumJobs(handle, 0, 100, 2)  # Level 2 = JOB_INFO_2 (có TotalPages)
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
                # WHY: Giữ nguyên snapshot cũ cho printer lỗi (không đánh dấu job biến
                # mất) — lần sau scan được sẽ so sánh tiếp từ trạng thái cũ.
                with _printer_job_lock:
                    current_jobs[name] = dict(_printer_prev_jobs.get(name, {}))
        
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

# WHY: Cộng dồn page_count khi in xong — 3 lớp ưu tiên: (1) JOB_INFO_2 pages thật,
# (2) WMI JobCountSinceLastReset diff (lần đầu chỉ lưu baseline, không increment),
# (3) fallback +1 trang. Tránh đếm trùng khi nhiều nguồn báo cùng 1 job.
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
        results = _process_completed_jobs(completed)
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

# ═══════════════════════════════════════════════════════════════
# BACKGROUND PRINT JOB LISTENER (listen mode)
# ═══════════════════════════════════════════════════════════════
#
# WHY: Trước đây phát hiện in xong CHỈ chạy khi frontend mở PrintersModule và poll
# /api/printer/auto-detect (fire-and-forget mỗi 5-10s). Khi user ở tab khác hoặc app
# chạy nền → job in xong bị BỎ QUA → page_count không tăng. Thread daemon này chạy
# liên tục trong backend, đóng vai "listen mode": quét spooler mỗi vài giây, job nào
# biến mất khỏi queue = đã in xong → tự động tăng page_count + ghi history/stats.
#
# Vì sao KHÔNG cần Event 307: EPSON EP-804A không ghi Event ID 307 (đã kiểm chứng
# no_data ở phần query) — cơ chế snapshot-diff spooler hoạt động cho MỌI loại driver
# (GDI/inkjet/PCL), không phụ thuộc EventLog.
#
# Không double-count với frontend poll: _printer_prev_jobs là snapshot dùng CHUNG
# (bảo vệ bởi _printer_job_lock) — job được thread tiêu thụ thì API poll trả rỗng
# và ngược lại.
PRINTER_LISTENER_INTERVAL = 4  # giây timeout safety poll — notification (FindFirstPrinterChangeNotification) là cơ chế chính

# WHY: Spooler gửi DELETE_JOB notification 2 lần cho cùng 1 job (test thực tế: 1 job -> 2
# lần increment "snapshot + Fast job fallback"). Cooldown chặn fallback trùng: nếu printer
# này VỪA xử lý completion trong khoảng này thì bỏ qua (job đã được đếm qua snapshot).
_PRINTER_LISTENER_FALLBACK_COOLDOWN = 2.0
_last_completed_at = {}  # printer -> time.monotonic() lần xử lý completion gần nhất

# WHY: Shared helper — xử lý danh sách job hoàn thành (ghi history + stats + auto-
# increment page_count). Dùng chung bởi /api/printer/auto-detect (frontend poll) VÀ
# background listener thread — tránh duplicate logic 2 nơi.
def _process_completed_jobs(completed):
    """Ghi history + stats + tăng page_count cho các job đã hoàn thành."""
    if not completed:
        return []
    # WHY: Bỏ qua máy in ảo bị ẩn (Microsoft Print to PDF, Fax...) — trước đây
    # excluded_printers chỉ là frontend-filter, nhưng background listener ghi history/
    # stats/page_count cho MỌI máy in local → mỗi lần "in ra PDF" tạo entry rác.
    try:
        excluded = set(load_printer_settings().get('excluded_printers', []) or [])
    except Exception:
        excluded = set()
    results = []
    for job in completed:
        # WHY: Cách ly từng job — 1 job fail (file lock, lỗi ghi) không được làm mất
        # các job còn lại trong batch (snapshot đã tiêu thụ nên không thể phát hiện lại).
        try:
            printer_name = job['printer']
            document = job.get('document', '')
            job_pages = job.get('total_pages', 0) or 0
            if printer_name in excluded:
                debug_log(f"[printer] Skip excluded printer {printer_name}")
                continue
            entry = add_print_history_entry(
                f"Tự động: {document} ({job_pages} trang)" if document else "Phát hiện in tự động",
                printer_name
            )
            add_print_stats_entry(printer_name, document)
            # Tự động tăng page_count với số trang thực tế từ job info (JOB_INFO_2),
            # fallback +1 nếu driver không báo số trang (VD: EPSON EP-804A).
            auto_increment_page_count(printer_name, job_pages)
            # WHY: Ghi dấu completion vừa xử lý cho printer này — listener fallback (Fast job)
            # dùng cooldown này để tránh double-count khi spooler gửi DELETE 2 lần/1 job.
            _last_completed_at[printer_name] = time.monotonic()
            if entry:
                results.append(entry)
        except Exception as e:
            debug_log(f"[printer] Process completed job error ({job.get('printer')}): {e}")
    return results

# WHY: Worker loop của background listener — quét spooler mỗi PRINTER_LISTENER_INTERVAL
# giây. Bắt lỗi từng job + cả loop để 1 lỗi không giết thread (thread chết = mất
# detection vĩnh viễn tới khi restart backend).
# WHY: Handle notification của FindFirstPrinterChangeNotification — pywin32 KHÔNG expose API
# này (test thực tế: module 'win32print' no attribute). Gọi thẳng winspool.drv qua ctypes.
# Handle trả về là kernel event — wait được bằng win32event.
_winspool = None

def _get_winspool():
    global _winspool
    if _winspool is None:
        import ctypes
        _winspool = ctypes.WinDLL('winspool.drv')
        _winspool.FindFirstPrinterChangeNotification.restype = ctypes.c_void_p
        _winspool.FindFirstPrinterChangeNotification.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p]
        _winspool.FindNextPrinterChangeNotification.restype = ctypes.c_int
        _winspool.FindNextPrinterChangeNotification.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
        _winspool.FindClosePrinterChangeNotification.argtypes = [ctypes.c_void_p]
    return _winspool

# PRINTER_CHANGE_JOB = 0xF00 (ADD 0x100 | SET 0x200 | DELETE 0x400 | WRITE 0x800) — mọi
# thay đổi liên quan job trong queue. Cần DELETE (0x400) để nhận biết job đã rời queue.
_PRINTER_CHANGE_JOB = 0xF00
_PRINTER_CHANGE_DELETE_JOB = 0x400

# WHY: Duy trì 1 notify handle/máy in. Refresh mỗi vòng: máy in mới (vd cắm lại USB) được
# đăng ký tự động; máy in đã gỡ thì đóng handle. Máy in phantom (EP-804A đang rút USB) —
# OpenPrinter vẫn OK, FindFirst có thể fail → bỏ qua, safety poll bù.
def _refresh_printer_notifications(reg):
    import ctypes
    try:
        import win32print
        names = [p[2] for p in win32print.EnumPrinters(win32print.PRINTER_ENUM_LOCAL)]
    except Exception:
        return
    for name in [n for n in list(reg) if n not in names]:
        ph, nh = reg.pop(name)
        try:
            _get_winspool().FindClosePrinterChangeNotification(nh)
        except Exception:
            pass
        try:
            win32print.ClosePrinter(ph)
        except Exception:
            pass
    for name in names:
        if name in reg:
            continue
        ph = None
        try:
            ph = win32print.OpenPrinter(name)
            nh = _get_winspool().FindFirstPrinterChangeNotification(ctypes.c_void_p(int(ph)), _PRINTER_CHANGE_JOB, 0, None)
            if nh:
                reg[name] = (ph, nh)
            else:
                try:
                    win32print.ClosePrinter(ph)
                except Exception:
                    pass
        except Exception:
            try:
                if ph is not None:
                    win32print.ClosePrinter(ph)
            except Exception:
                pass

# WHY: Event-driven listener: Windows thông báo NGAY khi job vào/ra queue spooler (FindFirstPrinterChangeNotification) — bắt được cả job laser sống <100ms mà poll không thấy.
def _printer_job_listener_worker():
    """Event-driven listener: Windows thông báo NGAY khi job vào/ra khỏi queue spooler
    (FindFirstPrinterChangeNotification) — bắt được cả job in cực nhanh. Trước đây poll
    4s: máy in laser (Brother HL-2240D) có job sống trong queue < 100ms → bỏ lỡ ~2/3 lần
    (đo thực tế: poll 100ms vẫn không thấy job trong queue, listener chỉ bắt được 1/3).
    Kèm safety poll định kỳ cho trường hợp notification không hoạt động."""
    import ctypes
    reg = {}
    while True:
        try:
            _refresh_printer_notifications(reg)
            if not reg:
                # Không đăng ký được notification nào (vd winspool lỗi) → poll thay thế
                completed = detect_completed_print_jobs()
                if completed:
                    _process_completed_jobs(completed)
                    debug_log(f"[printer-listener] {len(completed)} job hoàn thành được xử lý (poll)")
                time.sleep(2)
                continue
            names = list(reg.keys())
            handles = [reg[n][1] for n in names]
            import win32event
            rc = win32event.WaitForMultipleObjects(handles, False, PRINTER_LISTENER_INTERVAL * 1000)
            if rc >= len(handles):
                # Timeout (không có sự kiện) → safety poll
                completed = detect_completed_print_jobs()
                if completed:
                    _process_completed_jobs(completed)
                    debug_log(f"[printer-listener] {len(completed)} job hoàn thành được xử lý (safety)")
                continue
            name = names[rc]
            flags = 0
            try:
                cf = ctypes.c_uint32()
                _get_winspool().FindNextPrinterChangeNotification(ctypes.c_void_p(handles[rc]), ctypes.byref(cf), None, None)
                flags = cf.value
            except Exception:
                pass
            # Snapshot NGAY lúc notification — ADD_JOB: job vẫn còn trong queue (bắt được
            # TotalPages); DELETE_JOB: job đã in xong và rời queue.
            completed = detect_completed_print_jobs()
            handled_this = any(c.get('printer') == name for c in completed)
            if completed:
                _process_completed_jobs(completed)
                debug_log(f"[printer-listener] {len(completed)} job hoàn thành được xử lý")
            # DELETE_JOB nhưng snapshot không thấy job (laser quá nhanh — đã rời queue
            # trước khi ta kịp quét) → fallback +1 để không mất count. Chỉ fallback khi
            # printer này KHÔNG nằm trong completed (tránh double-count với snapshot trên).
            # Cooldown: nếu printer này vừa xử lý completion (snapshot path hoặc fallback
            # trước đó) trong _PRINTER_LISTENER_FALLBACK_COOLDOWN giây → DELETE hiện tại là
            # notification TRÙNG của cùng 1 job → bỏ qua, không đếm thêm.
            last_done = _last_completed_at.get(name, 0.0)
            if (not handled_this and (flags & _PRINTER_CHANGE_DELETE_JOB)
                    and (time.monotonic() - last_done) > _PRINTER_LISTENER_FALLBACK_COOLDOWN):
                _process_completed_jobs([{'printer': name, 'document': '', 'job_id': 0, 'total_pages': 0}])
                debug_log(f"[printer-listener] Fast job fallback on {name} (+1)")
        except Exception as e:
            debug_log(f"[printer-listener] Scan error: {e}")
            # WHY: Clear toàn bộ registration — nếu notify handle stale (spooler restart,
            # USB rút/cắm lại giữ nguyên tên queue) thì WaitForMultipleObjects lỗi vĩnh
            # viễn. Clear → vòng sau đăng ký lại từ đầu (idempotent, an toàn).
            reg.clear()
            time.sleep(2)

# WHY: Daemon thread — tự tắt khi backend exit, không block shutdown.
threading.Thread(target=_printer_job_listener_worker, daemon=True).start()

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
        # ─── Supplies nâng cấp ─────────────────────────────
        if 'printer_ips' in data:
            settings['printer_ips'] = dict(data['printer_ips'] or {})
        if 'manual_supplies' in data:
            settings['manual_supplies'] = dict(data['manual_supplies'] or {})
        if 'printer_communities' in data:
            settings['printer_communities'] = dict(data['printer_communities'] or {})
        if 'delete_printer_ip' in data:
            # Xóa IP config cho printer cụ thể
            pdel = data['delete_printer_ip']
            if 'printer_ips' in settings and pdel in settings['printer_ips']:
                del settings['printer_ips'][pdel]
        if 'delete_printer_community' in data:
            # Xóa community config cho printer cụ thể
            pdel = data['delete_printer_community']
            if 'printer_communities' in settings and pdel in settings['printer_communities']:
                del settings['printer_communities'][pdel]
        if 'delete_manual_supplies' in data:
            # Xóa manual supplies cho printer cụ thể
            pdel = data['delete_manual_supplies']
            if 'manual_supplies' in settings and pdel in settings['manual_supplies']:
                del settings['manual_supplies'][pdel]
        if 'supply_warning_threshold' in data:
            try:
                settings['supply_warning_threshold'] = max(1, min(100, int(data['supply_warning_threshold'])))
            except (TypeError, ValueError):
                pass
        # ─── Quét LAN nền ────────────────────────────────────
        if 'lan_scan_enabled' in data:
            settings['lan_scan_enabled'] = bool(data['lan_scan_enabled'])
        if 'lan_scan_interval_minutes' in data:
            try:
                settings['lan_scan_interval_minutes'] = max(1, min(120, int(data['lan_scan_interval_minutes'])))
            except (TypeError, ValueError):
                pass
        if 'lan_scan_subnet' in data:
            settings['lan_scan_subnet'] = (data['lan_scan_subnet'] or '').strip()
        if 'lan_scan_notify' in data:
            settings['lan_scan_notify'] = bool(data['lan_scan_notify'])
        if 'lan_scan_notified' in data:
            settings['lan_scan_notified'] = list(data['lan_scan_notified'] or [])[:200]
        if 'dismissed_detections' in data:
            settings['dismissed_detections'] = list(data['dismissed_detections'] or [])[:100]
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
        # WHY: Thuộc tính WMI có thể None hoặc sai kiểu — ép int an toàn với default.
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

# WHY: Cache 5 phút kết quả _detect_printer_info — tránh scan driver/name mỗi lần
# poll printer status (UI poll 5s).
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

# WHY: Đếm job đang trong spooler cho real-time detection — thử Get-PrintJob trước
# (Win8+/PS5), fallback Win32_PrintJob (WMI) vì Get-PrintJob không tồn tại mọi nơi.
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

# WHY: Hybrid 4 lớp đọc số trang: cache 2 phút (check TRƯỚC) > C#/PS module > EventLog
# PowerShell (chỉ PCL/PostScript) > WMI (GDI). Mỗi lớp failover sang lớp sau khi không
# có dữ liệu — vì KHÔNG có 1 nguồn duy nhất cho mọi loại driver.
def query_printer_page_count_eventlogs(printer_name, port_name):
    """
    Đọc tổng số trang từ Event Logs Windows (PrintService/Operational).
    
    Cơ chế Hybrid 4 lớp (cache-first):
    1. Cache 2 phút — kiểm tra TRƯỚC, tránh query lại mỗi 10s poll
    2. PrinterMonitor C#/PS module (ưu tiên cao nhất — XPath query nhanh)
    3. PowerShell EventLog (Properties[7]/[5]) — PCL/PostScript printers (EPSON, HP...)
    4. WMI + Get-PrintJob — GDI/host-based printers (Brother HL-2240D...)
    
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
    
    # Lớp 1: Kiểm tra cache TRƯỚC (EVENTLOG_CACHE_TTL = 2 phút).
    # WHY: Trước đây cache check nằm SAU layer C# (layer C# return sớm) → cache gần như
    # không bao giờ được dùng, mỗi 10s poll chạy lại query EventLog 30 ngày → timeout.
    with _eventlog_cache_lock:
        cached = _eventlog_cache.get(printer_name)
        if cached and (time.time() - cached['cached_at']) < EVENTLOG_CACHE_TTL:
            # WHY: Không log khi cached=0 (no_data) — máy in không ghi Event 307
            # sẽ spam "CACHED" mỗi 10s poll (6 dòng/phút).
            if cached['count'] > 0:
                debug_log(f"EventLog count CACHED for {printer_name}: {cached['count']}")
            return cached['count']
    
    # Lớp 2: PrinterMonitor C# module (ưu tiên cao nhất — XPath query nhanh, đã fix
    # bug quét cả log). Timeout 25s: 10s trước đây quá ngắn cho scan 30 ngày.
    try:
        cs_result = query_printer_monitor_cs(printer_name, "query", timeout=25)
        if cs_result and cs_result.get('page_count') is not None:
            count = int(cs_result['page_count'])
            if count > 0:
                with _eventlog_cache_lock:
                    _eventlog_cache[printer_name] = {'count': count, 'cached_at': time.time()}
                debug_log(f"EventLog count for {printer_name}: {count} (C#/PS module)")
                return count
    except Exception as e:
        debug_log(f"C#/PS module query error: {e}")
    
    # Lớp 3: PowerShell EventLog (chỉ cho PCL/PostScript printers, 
    # GDI printers thường không tạo Event ID 307)
    if not is_gdi:
        try:
            # WHY: Gộp 2 query Properties[7] + Properties[5] thành 1 lần scan DUY NHẤT +
            # dùng -FilterXPath (engine lọc EventID=307/30 ngày ngay tại service, không
            # tải toàn bộ log về PowerShell). Trước đây 2 subprocess riêng, mỗi cái tải
            # 30 ngày event về PowerShell rồi lọc → chậm → timeout 10s với log lớn.
            ps_cmd = (
                '$evts = Get-WinEvent -LogName "Microsoft-Windows-PrintService/Operational" '
                '-FilterXPath "*[System[(EventID=307) and TimeCreated[timediff(@SystemTime) <= 2592000000]]]" '
                '-ErrorAction SilentlyContinue | '
                'Where-Object { $_.Properties[4].Value -like "*' + printer_name + '*" }; '
                '$s7 = 0; $s5 = 0; '
                'foreach ($e in $evts) { '
                '$v7 = $e.Properties[7].Value; if ($null -ne $v7) { try { $s7 += [int]$v7 } catch {} }; '
                '$v5 = $e.Properties[5].Value; if ($null -ne $v5) { try { $s5 += [int]$v5 } catch {} } }; '
                'Write-Output "$s7|$s5"'
            )
            result = subprocess.run(
                ['powershell', '-NoProfile', '-Command', ps_cmd],
                capture_output=True, text=True, timeout=25,
                startupinfo=get_startupinfo(),
                creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
            )
            if result.returncode == 0 and result.stdout.strip():
                parts = result.stdout.strip().split('|')
                try:
                    c7 = int(float(parts[0]))
                    c5 = int(float(parts[1]))
                except (ValueError, IndexError):
                    c7 = c5 = 0
                if c7 > 0:
                    with _eventlog_cache_lock:
                        _eventlog_cache[printer_name] = {'count': c7, 'cached_at': time.time()}
                    debug_log(f"EventLog count for {printer_name}: {c7} (Properties[7], 30 days)")
                    return c7
                # WHY: Properties[7] = 0 (máy in không lưu page count ở field này, hoặc
                # chưa in trang nào) → fallback Properties[5] cho Windows cũ hơn. Đây là
                # code path bình thường cho nhiều máy in (VD: EPSON EP-804A).
                if c5 > 0:
                    with _eventlog_cache_lock:
                        _eventlog_cache[printer_name] = {'count': c5, 'cached_at': time.time()}
                    debug_log(f"EventLog count for {printer_name}: {c5} (Properties[5] fallback, 30 days)")
                    return c5
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

    # WHY: Cache kết quả "không có dữ liệu" (count=0) — máy in không ghi Event 307
    # (VD: EPSON EP-804A) trả None mỗi lần query; nếu không cache, mỗi 10s poll lại
    # chạy full chain C# + PS + WMI → chính máy in trong log lỗi bị query liên tục
    # (1-2s/query). Cached 0 được caller xử lý giống None (falls qua manual count).
    with _eventlog_cache_lock:
        _eventlog_cache[printer_name] = {'count': 0, 'cached_at': time.time()}
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
    
    now_str = datetime.now().strftime('%d/%m/%y %H:%M:%S')
    
    # 0. SNMP (RFC 3805) — máy in MẠNG đã cấu hình IP: đọc thẳng từ phần cứng
    #    (prtMarkerLifeCount = tổng số trang lifetime, chính xác nhất).
    #    Chỉ khi có IP trong settings.printer_ips — không làm chậm máy USB.
    settings0 = load_printer_settings()
    saved_ip = (settings0.get('printer_ips') or {}).get(printer_name, '')
    if saved_ip:
        try:
            saved_community = (settings0.get('printer_communities') or {}).get(printer_name, '').strip() or 'public'
            probe = printer_mib.probe_printer_status(saved_ip, community=saved_community, timeout=1.5, retries=0)
            if probe.get('online') and probe.get('page_count') is not None:
                debug_log(f"Page count for {printer_name}: SNMP {probe['page_count']} via {saved_ip}")
                pr_info = _get_cached_printer_info(printer_name)
                return jsonify({'page_count': probe['page_count'], 'source': 'snmp', 'printer': printer_name,
                                'updated_at': now_str,
                                'driver_type': pr_info.get('driver_type'),
                                'tracking_method': pr_info.get('tracking_method')})
        except Exception as e:
            debug_log(f"page-count SNMP error for {printer_name}: {e}")
    
    # 1. EventLogs (PowerShell) — 30 ngày gần nhất, đã cache 30s
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

# WHY: Gửi lệnh PJL qua RAW spooler (win32print) cho USB printers — one-way, không
# đọc được response; GDI printers có thể in ra trang chứa lệnh nên chỉ dùng network.
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

# WHY: PJL qua TCP port 9100 cho network printers — đọc được response (khác RAW
# one-way), dùng cho pagecount/toner/drum query với timeout chống treo.
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

# WHY: Extract PAGECOUNT từ response PJL — format linh hoạt ("PAGECOUNT=6266"
# hoặc khoảng trắng), regex tách số tránh parse nhầm chuỗi khác.
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

# WHY: Parse status variables (toner, drum, total pages) — các hãng dùng format
# khác nhau nên thử nhiều pattern regex, bỏ qua biến không có trong response.
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
# SUPPLIES — Vật tư máy in (NÂNG CẤP: SNMP RFC 3805 + PJL + manual)
# ═══════════════════════════════════════════════════════════════
#
# Đọc vật tư máy in — 3 nguồn, theo thứ tự:
#   1. SNMP (printer_mib.py, RFC 3805) — máy in MẠNG có IP:
#      → Tổng số trang (prtMarkerLifeCount) + % toner/drum/ink
#        (prtMarkerSuppliesLevel/MaxCapacity) + trạng thái thiết bị.
#      Kỹ thuật giống các repo cộng đồng: Cartriage, alfonsrv/printer-monitoring,
#      bieniu/brother (đều walk RFC 3805 supplies table để tính %).
#   2. PJL network (cổng 9100) — bổ sung khi SNMP không trả supplies
#      (một số Brother chỉ báo DRUM/ TONER qua @PJL INFO STATUS).
#   3. Manual (settings.manual_supplies) — máy in USB không có SNMP:
#      người dùng tự nhập % còn lại (không có đường đọc tự động nào khác
#      cho USB — đã kiểm chứng: ESC/P-R write-only, WMI = 0, bidi không export).
#
# ⚠️ Cache 20s (SUPPLIES_CACHE_TTL) để tránh probe SNMP/PJL mỗi poll 10s.
# ═══════════════════════════════════════════════════════════════

# ── LAN scan — tự phát hiện IP máy in (SNMP port 161) ──
_scan_cache = {}
_scan_cache_lock = threading.Lock()
SCAN_CACHE_TTL = 60

@app.route("/api/printer/scan")
# WHY: Người dùng thêm/cấu hình máy in mạng không cần đoán IP — quét cả subnet,
# host nào trả lời SNMP sysDescr (máy in/thiết bị mạng) sẽ xuất hiện kèm tên model.
def api_printer_scan():
    """
    GET /api/printer/scan?subnet=192.168.1.0/24&community=public&refresh=1

    Quét LAN tìm thiết bị SNMP (máy in). Cache kết quả 60s — dùng refresh=1
    để quét lại ngay (tốn vài giây).

    Returns:
        {
            ok, cached, subnet, scanned, duration_ms,
            devices: [{ip, model, printer_name, is_printer}],
            error?
        }
    """
    subnet = request.args.get('subnet', '').strip() or None
    community = request.args.get('community', '').strip() or 'public'
    refresh = request.args.get('refresh', '') == '1'
    cache_key = f'{subnet or "default"}|{community}'

    if not refresh:
        with _scan_cache_lock:
            cached = _scan_cache.get(cache_key)
            if cached and time.time() - cached['ts'] < SCAN_CACHE_TTL:
                data = cached['data']
                return jsonify({'ok': not data.get('error'), 'cached': True, **data})

    try:
        result = printer_mib.scan_lan_printers(subnet=subnet, community=community)
    except Exception as e:
        return jsonify({'ok': False, 'cached': False, 'error': str(e),
                        'devices': [], 'subnet': subnet or '?', 'scanned': 0,
                        'duration_ms': 0})

    # Gợi ý ghép thiết bị quét được với máy in Windows local
    # (VD model "EPSON EP-804A series" ↔ máy in "EPSON EP-804A")
    try:
        import win32print
        local_names = [p[2] for p in win32print.EnumPrinters(win32print.PRINTER_ENUM_LOCAL)]
        if local_names:
            printer_mib.annotate_device_matches(result.get('devices') or [], local_names)
    except Exception:
        pass
    # Cập nhật luôn _scan_detections từ quét tay → banner phát hiện hiện ngay
    # (không phải chờ chu kỳ quét nền tiếp theo)
    try:
        _merge_scan_devices(result.get('devices') or [], load_printer_settings())
    except Exception:
        pass

    with _scan_cache_lock:
        if len(_scan_cache) > 20:
            _scan_cache.clear()
        _scan_cache[cache_key] = {'ts': time.time(), 'data': result}
    return jsonify({'ok': not result.get('error'), 'cached': False, **result})


# ── Quét LAN nền — tự phát hiện máy in mạng chưa cấu hình IP ──
# Worker chạy nền mỗi lan_scan_interval_minutes (mặc định 5 phút):
#   scan subnet → ghép model với máy in Windows → máy nào KHỚP mà chưa
#   có IP trong settings.printer_ips thì đưa vào _scan_detections để UI báo.
_scan_detections = []          # [{key, ip, model, printer_name, confidence, first_seen, last_seen, count}]
_scan_detections_lock = threading.Lock()
_last_background_scan = None   # epoch seconds của lần quét nền cuối
DETECTION_PRUNE_HOURS = 24     # bỏ gợi ý sau 24h không còn thấy thiết bị
DETECTION_MAX = 20             # giới hạn số gợi ý hiển thị


# WHY: Ghép kết quả quét vào _scan_detections (thread-safe): gợi ý máy in khớp chưa cấu hình IP, tự prune khi đã gán IP/dismiss/lâu không thấy (24h) hoặc vượt DETECTION_MAX.
def _merge_scan_devices(devices, settings, now=None):
    """
    Ghép kết quả quét vào _scan_detections (thread-safe): máy in khớp với
    máy Windows mà chưa cấu hình IP → gợi ý. Tự bỏ gợi ý khi: đã gán IP,
    đã dismiss, lâu không còn thấy (24h), hoặc vượt DETECTION_MAX.
    Dùng chung cho quét nền lẫn quét tay (để banner cập nhật ngay).

    Returns: SỐ gợi ý MỚI được thêm trong lần này (0 = không có gì mới).
    """
    if now is None:
        now = time.time()
    ips_configured = set((settings.get('printer_ips') or {}).values())
    dismissed = set(settings.get('dismissed_detections') or [])
    new_count = 0
    refreshed_keys = set()
    with _scan_detections_lock:
        for d in devices:
            mp = d.get('matched_printer')
            if not mp:
                continue
            ip = d.get('ip') or ''
            if not ip:
                continue
            key = f'{ip}|{mp["name"]}'
            if key in dismissed or ip in ips_configured:
                continue
            existing = next((e for e in _scan_detections if e.get('key') == key), None)
            if existing:
                existing['last_seen'] = now
                existing['count'] = existing.get('count', 0) + 1
                existing['missing_logged'] = False  # thấy lại → reset cờ "mất tích"
                refreshed_keys.add(key)
            else:
                # IP DHCP đổi: cùng máy in nhưng ở IP khác (entry cũ vẫn còn)
                # → ghi log + xóa entry cũ (thay bằng entry mới) để tránh lặp log mỗi chu kỳ
                old = next((e for e in _scan_detections
                            if e.get('printer_name') == mp['name'] and e.get('key') != key), None)
                if old:
                    debug_log(f"[printer-scan] IP đổi (DHCP?): {mp['name']} {old['ip']} → {ip}")
                    _scan_detections.remove(old)
                _scan_detections.append({
                    'key': key, 'ip': ip, 'model': d.get('model') or '',
                    'printer_name': mp['name'], 'confidence': mp.get('confidence'),
                    'first_seen': now, 'last_seen': now, 'count': 1,
                    'missing_logged': False,
                })
                refreshed_keys.add(key)
                new_count += 1
                debug_log(f"[printer-scan] Phát hiện mới: {mp['name']} ({d.get('model') or ''}) tại {ip}"
                          f" (độ khớp {mp.get('confidence')})")
        # Dọn với LÝ DO cụ thể (ghi log) thay vì filter vô danh
        kept, removed = [], []
        for e in _scan_detections:
            if e.get('ip') in ips_configured:
                removed.append((e, 'đã cấu hình IP'))
            elif e.get('key') in dismissed:
                removed.append((e, 'user đã ẩn'))
            elif (now - e.get('last_seen', 0)) >= DETECTION_PRUNE_HOURS * 3600:
                removed.append((e, f'biến mất khỏi mạng ({DETECTION_PRUNE_HOURS}h không còn thấy)'))
            else:
                kept.append(e)
        _scan_detections[:] = kept[:DETECTION_MAX]
        if len(kept) > DETECTION_MAX:
            for e in kept[DETECTION_MAX:]:
                removed.append((e, 'vượt giới hạn gợi ý hiển thị'))
        for e, reason in removed:
            debug_log(f"[printer-scan] Gợi ý đóng: {e['printer_name']} tại {e['ip']} — {reason}")
        _scan_detections.sort(key=lambda e: e.get('last_seen', 0), reverse=True)
        # Đánh dấu máy "tạm biến mất" (mất tích > 30 phút, ghi 1 lần duy nhất)
        for e in _scan_detections:
            if e['key'] in refreshed_keys:
                e['missing_logged'] = False
            elif (now - e.get('last_seen', 0)) > 1800 and not e.get('missing_logged'):
                mins = int((now - e.get('last_seen', 0)) / 60)
                debug_log(f"[printer-scan] {e['printer_name']} tại {e['ip']} không thấy trên mạng"
                          f" ({mins} phút) — có thể đã tắt / ngắt mạng")
                e['missing_logged'] = True
    return new_count


# WHY: Quét LAN + ghép model với máy Windows + merge detection + gửi Windows toast cho phát hiện MỚI (lan_scan_notified persist chống báo lại sau restart).
def _run_background_scan(settings):
    """Quét LAN + ghép máy + cập nhật danh sách máy in mạng chưa cấu hình IP."""
    global _last_background_scan
    subnet = (settings.get('lan_scan_subnet') or '').strip() or None
    try:
        result = printer_mib.scan_lan_printers(subnet=subnet, timeout=0.35)
    except Exception as e:
        debug_log(f"[lan-scan] Lỗi quét nền: {e}")
        return
    devices = result.get('devices') or []
    # Ghép model với máy in Windows local
    try:
        import win32print
        local_names = [p[2] for p in win32print.EnumPrinters(win32print.PRINTER_ENUM_LOCAL)]
        if local_names:
            printer_mib.annotate_device_matches(devices, local_names)
    except Exception:
        pass
    new_count = _merge_scan_devices(devices, settings)
    _last_background_scan = time.time()
    with _scan_detections_lock:
        total_detections = len(_scan_detections)
    debug_log(f"[printer-scan] Quét nền xong: {result.get('scanned')} host, "
              f"{len(devices)} thiết bị SNMP, {new_count} phát hiện mới, "
              f"{total_detections} gợi ý đang hiển thị")
    # 🔔 Windows toast cho phát hiện MỚI — backend là process độc lập nên gửi
    # được kể cả khi cửa sổ app đang ẩn/minimized. Chỉ báo khi thêm gợi ý mới
    # (không lặp lại mỗi chu kỳ 5 phút) và khi user bật lan_scan_notify.
    # lan_scan_notified (persist) chống báo LẠI sau khi backend/app restart
    # (detection in-memory bị dựng lại → new_count>0 nhưng key đã thông báo rồi).
    if new_count > 0 and settings.get('lan_scan_notify', True):
        try:
            notified = set(settings.get('lan_scan_notified') or [])
            with _scan_detections_lock:
                pending = [e for e in _scan_detections if e.get('key') not in notified][:3]
            if pending:
                if _show_printer_toast(pending):
                    # 📣 Log sự kiện toast đã GỬI THÀNH CÔNG (kèm máy + IP)
                    debug_log(f"[printer-scan] Đã gửi Windows toast cho: "
                              + ', '.join(f"{d['printer_name']} ({d['ip']})" for d in pending))
                    settings['lan_scan_notified'] = list(
                        (notified | {d['key'] for d in pending}))[:200]
                    try:
                        save_printer_settings(settings)
                    except Exception:
                        pass
                else:
                    debug_log(f"[printer-scan] Gửi Windows toast THẤT BẠI cho: "
                              + ', '.join(f"{d['printer_name']} ({d['ip']})" for d in pending))
                    # 🔄 Retry 1 lần sau 10s (thread riêng — không block worker).
                    # Snapshot các field cần thiết vì detection trong list có thể bị
                    # prune/thay thế sau khi thread ngủ.
                    snap = [{k: d.get(k) for k in ('key', 'printer_name', 'ip')} for d in pending]
                    threading.Thread(target=_retry_printer_toast, args=(snap,), daemon=True).start()
        except Exception:
            pass


# WHY: Worker nền quét LAN định kỳ theo cài đặt (mặc định 5 phút); chờ 60s sau boot cho hệ thống ổn định.
def _lan_scan_worker():
    """Worker nền: quét LAN định kỳ theo cài đặt (mặc định 5 phút).
    Chờ 60s sau boot cho hệ thống ổn định, rồi ngủ interval → quét."""
    time.sleep(60)
    while True:
        try:
            settings = load_printer_settings()
            interval = int(settings.get('lan_scan_interval_minutes', 5) or 5)
            time.sleep(max(1, min(120, interval)) * 60)
            if not settings.get('lan_scan_enabled', True):
                # Tắt quét → bỏ gợi ý cũ (banner không hiện dữ liệu cũ)
                with _scan_detections_lock:
                    if _scan_detections:
                        debug_log(f"[printer-scan] Quét nền bị TẮT — xóa {len(_scan_detections)} gợi ý cũ")
                        _scan_detections.clear()
                continue
            # Reload settings NGAY TRƯỚC khi quét — user có thể đổi IP/subnet/
            # interval trong lúc worker đang ngủ → không dùng snapshot cũ.
            _run_background_scan(load_printer_settings())
        except Exception:
            time.sleep(120)


@app.route("/api/printer/scan-detections")
# WHY: Frontend poll endpoint — danh sách máy in mạng phát hiện được mà CHƯA
# cấu hình IP (do worker nền quét định kỳ). Kèm trạng thái cài đặt quét.
def api_printer_scan_detections():
    settings = load_printer_settings()
    with _scan_detections_lock:
        dets = [dict(e) for e in _scan_detections]
    return jsonify({
        'ok': True,
        'detections': dets,
        'enabled': bool(settings.get('lan_scan_enabled', True)),
        'interval_minutes': int(settings.get('lan_scan_interval_minutes', 5) or 5),
        'subnet': settings.get('lan_scan_subnet') or '',
        'last_scan': _last_background_scan,
    })


@app.route("/api/printer/scan-detections/dismiss", methods=["POST"])
# WHY: Ẩn 1 gợi ý — ghi "ip|printer_name" vào dismissed_detections (persist),
# lần quét sau sẽ bỏ qua. Không ảnh hưởng tới việc cấu hình IP thủ công.
def api_printer_scan_detections_dismiss():
    data = request.get_json() or {}
    ip = (data.get('ip') or '').strip()
    name = (data.get('printer_name') or '').strip()
    if not ip or not name:
        return jsonify({'ok': False, 'error': 'Thiếu ip và printer_name'}), 400
    key = f'{ip}|{name}'
    settings = load_printer_settings()
    dismissed = list(settings.get('dismissed_detections') or [])
    if key not in dismissed:
        dismissed.append(key)
        settings['dismissed_detections'] = dismissed[:100]
        save_printer_settings(settings)
    with _scan_detections_lock:
        _scan_detections[:] = [e for e in _scan_detections if e.get('key') != key]
    return jsonify({'ok': True})


# WHY: Phân loại sự kiện [printer-scan] theo keyword để frontend chọn icon/màu — check keyword cụ thể TRƯỚC keyword chung, 'THẤT BẠI' trước 'Đã gửi' (tránh substring chéo).
def _classify_scan_event(msg):
    """Phân loại sự kiện [printer-scan] theo keyword trong message — frontend dùng
    để chọn icon/màu. Thứ tự quan trọng: check 'THẤT BẠI' TRƯỚC 'Đã gửi' (không trùng
    substring chéo) và các keyword cụ thể trước các keyword chung."""
    if 'Phát hiện mới' in msg:
        return 'discovered'
    if 'IP đổi (DHCP?)' in msg:
        return 'ip_changed'
    if 'không thấy trên mạng' in msg:
        return 'disappeared'
    if 'Gợi ý đóng' in msg:
        return 'closed'
    if 'Gửi Windows toast THẤT BẠI' in msg:
        return 'toast_failed'
    if 'Đã gửi Windows toast' in msg:
        return 'toast_sent'
    if 'Quét nền xong' in msg:
        return 'scan_summary'
    if 'Quét nền bị TẮT' in msg:
        return 'scan_disabled'
    return 'info'


# WHY: Đọc sự kiện [printer-scan] gần nhất từ debug.log — đọc TAIL bằng BINARY mode (log ghi \n→CRLF trên Windows, text-mode seek không an toàn) rồi splitlines() xử lý cả \r\n lẫn \n.
def _read_scan_events(limit=50, type_filter=None):
    """Đọc các sự kiện [printer-scan] gần nhất từ debug.log.
    Đọc TAIL bằng BINARY mode (debug.log ghi \n -> CRLF trên Windows; text-mode seek
    tới byte offset tuỳ ý không an toàn với universal-newline decoder) rồi decode +
    splitlines() — tự xử lý cả \r\n lẫn \n. Dòng lẻ đầu đoạn cắt bị bỏ.
    Trả về list mới nhất trước: [{timestamp, type, message}, ...]."""
    try:
        size = DEBUG_LOG.stat().st_size
        with open(DEBUG_LOG, 'rb') as f:
            if size > 524288:
                f.seek(size - 524288)
                f.readline()  # bỏ nửa dòng lẻ ở đầu đoạn cắt
            raw = f.read().decode('utf-8', errors='replace')
    except Exception:
        return []
    events = []
    for ln in reversed(raw.splitlines()):
        m = re.match(r'\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] \[printer-scan\] (.*)$', ln)
        if not m:
            continue
        ts, msg = m.group(1), m.group(2)
        ev_type = _classify_scan_event(msg)
        if type_filter and ev_type != type_filter:
            continue
        events.append({'timestamp': ts, 'type': ev_type, 'message': msg})
        if len(events) >= limit:
            break
    return events


@app.route("/api/printer/scan-events")
# WHY: Frontend hiển thị lịch sử phát hiện (máy xuất hiện/biến mất, IP DHCP đổi,
# toast gửi) — parse trực tiếp từ debug.log (đã có sẵn logging [printer-scan]).
# ?limit= (1-200, mặc định 50) + ?type= (lọc theo loại sự kiện, tùy chọn).
def api_printer_scan_events():
    try:
        limit = int(request.args.get('limit', 50))
    except (TypeError, ValueError):
        limit = 50
    limit = max(1, min(200, limit))
    type_filter = (request.args.get('type') or '').strip() or None
    return jsonify({'ok': True, 'events': _read_scan_events(limit, type_filter)})


# Lock chống chồng scan khi bấm "Quét ngay" nhiều lần liên tiếp
_scan_now_lock = threading.Lock()


@app.route("/api/printer/scan-now", methods=["POST"])
# WHY: Nút "⚡ Quét ngay" trên banner — chạy ĐÚNG hàm quét nền (_run_background_scan,
# dùng subnet/community đã cấu hình, merge detection + toast Windows) trong THREAD RIÊNG
# → request trả về ngay, kết quả được UI lấy qua GET /api/printer/scan-detections (poll 10s).
def api_printer_scan_now():
    if not _scan_now_lock.acquire(blocking=False):
        return jsonify({'ok': True, 'already_running': True})

# WHY: Chạy _run_background_scan trong THREAD RIÊNG cho nút 'Quét ngay' — request trả về ngay, kết quả UI poll qua /api/printer/scan-detections.
    def _worker():
        try:
            _run_background_scan(load_printer_settings())
        except Exception:
            pass
        finally:
            _scan_now_lock.release()

    threading.Thread(target=_worker, daemon=True).start()
    return jsonify({'ok': True, 'already_running': False})


threading.Thread(target=_lan_scan_worker, daemon=True).start()


_supplies_cache = {}
_supplies_cache_lock = threading.Lock()
SUPPLIES_CACHE_TTL = 20

@app.route("/api/printer/supplies")
# WHY: Endpoint tổng hợp vật tư — SNMP là nguồn chính cho máy mạng, PJL bổ sung,
# manual cho USB. IP lấy từ query param HOẶC settings.printer_ips (đã cấu hình).
def api_printer_supplies():
    """
    GET /api/printer/supplies?printer=NAME&ip=IP

    Đọc vật tư máy in (số trang đã in, % toner/drum/ink còn lại).

    Query params:
        printer: Tên máy in
        ip: Địa chỉ IP (nếu máy in có mạng — SNMP/PJL)

    Returns:
        {
            printer, ip, online, model, status,
            page_count, page_count_source,
            supplies: [{name, kind, percent, level, max, source, ...}],
            sources: ['snmp'|'pjl'|'manual'],
            error?
        }
    """
    printer_name = request.args.get('printer', '').strip()
    ip = request.args.get('ip', '').strip()

    if not printer_name:
        settings = load_printer_settings()
        printer_name = settings.get('selected_printer', '')

    settings = load_printer_settings()
    if not ip:
        ip = (settings.get('printer_ips') or {}).get(printer_name, '')
    # SNMP community string theo từng máy (mặc định "public"; strip chống whitespace)
    community = (settings.get('printer_communities') or {}).get(printer_name, '').strip() or 'public'

    refresh = request.args.get('refresh', '') == '1'
    # Cache key gồm cả community — đổi community với cùng IP phải probe lại
    cache_key = f'{printer_name}|{ip}|{community}'
    if not refresh:
        with _supplies_cache_lock:
            cached = _supplies_cache.get(cache_key)
            if cached:
                ttl = cached.get('ttl', SUPPLIES_CACHE_TTL)
                if (time.time() - cached['cached_at']) < ttl:
                    return jsonify(cached['data'])

    result = {
        'printer': printer_name,
        'ip': ip or None,
        'community': community if ip else None,
        'online': False,
        'model': None,
        'status': None,
        'page_count': None,
        'page_count_source': None,
        'supplies': [],
        'sources': [],
        'error': None,
    }

    # ── 1. SNMP probe (máy in mạng) ──
    snmp_ok = False
    if ip:
        try:
            # retries=0 + timeout ngắn: máy chết không được treo request lâu
            probe = printer_mib.probe_printer_status(ip, community=community, timeout=1.5, retries=0)
            if probe.get('online'):
                snmp_ok = True
                result['online'] = True
                result['model'] = probe.get('model')
                result['status'] = probe.get('status')
                if probe.get('page_count') is not None:
                    result['page_count'] = probe['page_count']
                    result['page_count_source'] = 'snmp'
                for s in probe.get('supplies', []):
                    s['source'] = 'snmp'
                    result['supplies'].append(s)
                result['sources'].append('snmp')
            else:
                result['error'] = probe.get('error')
                debug_log(f"supplies SNMP fail for {printer_name}@{ip}: {probe.get('error')}")
        except Exception as e:
            debug_log(f"supplies SNMP error: {e}")
            result['error'] = str(e)

    # ── 2. PJL network — bổ sung khi SNMP không có supplies / không online ──
    if ip and (not snmp_ok or not result['supplies']):
        try:
            if not snmp_ok:
                # Thử đọc page count qua PJL khi SNMP chết
                pjl_resp = _send_pjl_network(ip, 9100, b"@PJL INFO PAGECOUNT", timeout=2)
                if pjl_resp:
                    pc = _parse_pjl_page_count(pjl_resp)
                    if pc and result['page_count'] is None:
                        result['page_count'] = pc
                        result['page_count_source'] = 'pjl'
                    result['sources'].append('pjl')
            else:
                # SNMP sống nhưng thiếu supplies → thử @PJL INFO STATUS (drum/toner)
                status_resp = _send_pjl_network(ip, 9100, b"@PJL INFO STATUS", timeout=2)
                if status_resp:
                    parsed = _parse_pjl_status(status_resp)
                    for key, pct in (('drum_life', 'drum'), ('drum_remaining', 'drum'), ('toner_level', 'toner')):
                        if key in parsed and parsed[key] is not None:
                            result['supplies'].append({
                                'name': 'Trống (Drum)' if key.startswith('drum') else 'Mực (Toner)',
                                'kind': 'drum' if key.startswith('drum') else 'toner',
                                'percent': max(0, min(100, int(parsed[key]))),
                                'level': None, 'max': None, 'unit': None,
                                'some_remaining': False, 'source': 'pjl',
                            })
                            result['sources'].append('pjl')
        except Exception as e:
            debug_log(f"supplies PJL error: {e}")

    # ── 3. Manual supplies (máy in USB) — merge vào danh sách ──
    # WHY: SNMP/PJL là nguồn tự động → ƯU TIÊN. Manual chỉ dùng khi chưa có
    # nguồn tự động cho kind đó (tránh trùng 2 thanh "Mực (Toner)").
    manual = (settings.get('manual_supplies') or {}).get(printer_name, {})
    auto_kinds = {s['kind'] for s in result['supplies']}
    if manual:
        label_map = {
            'toner': 'Mực (Toner)', 'ink': 'Mực (Ink)', 'drum': 'Trống (Drum)',
            'black': 'Mực Đen (Black)', 'cyan': 'Mực Xanh dương (Cyan)',
            'magenta': 'Mực Đỏ (Magenta)', 'yellow': 'Mực Vàng (Yellow)',
        }
        for key, pct in manual.items():
            try:
                pct = int(pct)
            except (TypeError, ValueError):
                continue
            kl = key.lower()
            if 'toner' in kl:
                kind = 'toner'
            elif 'drum' in kl:
                kind = 'drum'
            else:
                kind = 'ink'  # black/cyan/magenta/yellow/ink
            if kind in auto_kinds:
                continue  # đã có nguồn tự động cho kind này → bỏ manual
            result['supplies'].append({
                'name': label_map.get(kl, key),
                'kind': kind,
                'percent': max(0, min(100, pct)),
                'level': None, 'max': None, 'unit': None,
                'some_remaining': False, 'source': 'manual',
            })
        result['sources'].append('manual')

    # Lưu cache — máy không online (lỗi SNMP) cache lâu hơn (120s) để
    # không probe lại IP chết mỗi poll 10s → không chặn thread.
    # Cap 100 entries tránh phình bộ nhớ khi user thử nhiều IP khác nhau.
    ttl = SUPPLIES_CACHE_TTL if (result.get('online') or result.get('sources')) else 120
    with _supplies_cache_lock:
        if len(_supplies_cache) > 100:
            _supplies_cache.clear()
        _supplies_cache[cache_key] = {'data': result, 'cached_at': time.time(), 'ttl': ttl}
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
    "color_mic_on": "#008000",
    "color_mic_off": "#c3063c",
    "show_widget_on_mic": False,
    "always_on_top": True,
    "widget_opacity": 1.0,
    "widget_width": 220,
    "widget_height": 220,
    "pos_x": 100,
    "pos_y": 100,
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
        for key in ['sound_enabled', 'selected_sound', 'icon_theme', 'color_mic_on', 'color_mic_off', 'show_widget_on_mic', 'always_on_top', 'widget_opacity', 'widget_width', 'widget_height', 'pos_x', 'pos_y']:
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

# WHY: Audio module v2 (REWRITE) — pycaw / Windows Core Audio là nguồn sự thật DUY NHẤT.
# Trước đây dùng sounddevice làm nguồn chính gây loạt bug:
#   - Danh sách đầy device ảo/trùng (Microsoft Sound Mapper, Primary Sound Capture
#     Driver, cùng 1 mic hiện 4 lần) — bấm vào đó set-default trả 404 âm thầm.
#   - index sounddevice ≠ index pycaw → mute/volume/default phải "resolve tên substring"
#     mong manh, sai thiết bị, thất bại không lỗi.
#   - is_default lấy từ sd.default.device (PortAudio cache lúc import) → badge KHÔNG
#     cập nhật sau khi đổi default dù Windows đã đổi.
# v2: liệt kê trực tiếp từ IMMDeviceEnumerator, chỉ endpoint Active, dùng device id
# (chuỗi GUID) làm khóa định danh duy nhất — chính xác tuyệt đối.
# WHY: Helper — lấy default endpoint id (role multimedia) cho 1 data flow.
def _audio_default_endpoint_id(devEnum, flow_code):
    """Trả id của default endpoint cho 1 data flow (eCapture/eRender) role multimedia."""
    try:
        from pycaw.constants import ERole
        dev = devEnum.GetDefaultAudioEndpoint(flow_code, ERole.eMultimedia.value)
        return dev.GetId() if dev is not None else None
    except Exception:
        return None

# WHY: Helper — tìm AudioDevice pycaw theo id chuỗi (GUID), không nhập nhằng tên/index.
# CHỈ GỌI TỪ dedicated COM thread (worker) — trả comtypes object, KHÔNG được đưa xuyên
# thread ra khỏi worker (cross-apartment → crash _ctypes.pyd).
def _find_pycaw_device(dev_id):
    """Tìm thiết bị pycaw theo id chuỗi (GUID) — nhanh, không nhập nhằng tên."""
    from pycaw.pycaw import AudioUtilities
    for py_dev in AudioUtilities.GetAllDevices():
        if py_dev.id == dev_id:
            return py_dev
    return None

# WHY: Helper — chạy trên COM thread, trả về (dev_id, name, is_input, volume, muted) plain data.
# KHÔNG trả comtypes object xuyên thread (object gắn apartment worker thread).
def _list_devices_worker():
    """Liệt kê thiết bị âm thanh trên COM thread — trả list dict plain (an toàn xuyên thread)."""
    from pycaw.pycaw import AudioUtilities, IMMDeviceEnumerator
    from pycaw.constants import AudioDeviceState, EDataFlow
    from pycaw.utils import CLSID_MMDeviceEnumerator
    from comtypes import CoCreateInstance, CLSCTX_INPROC_SERVER

    devEnum = CoCreateInstance(CLSID_MMDeviceEnumerator, IMMDeviceEnumerator, CLSCTX_INPROC_SERVER)
    default_capture_id = _audio_default_endpoint_id(devEnum, EDataFlow.eCapture.value)
    default_render_id = _audio_default_endpoint_id(devEnum, EDataFlow.eRender.value)

    devices = []
    seen = set()
    for py_dev in AudioUtilities.GetAllDevices():
        if py_dev.state != AudioDeviceState.Active:
            continue
        dev_id = py_dev.id
        if dev_id in seen:
            continue
        seen.add(dev_id)
        try:
            flow_code = AudioUtilities.GetEndpointDataFlow(dev_id, outputType=1)
        except Exception:
            flow_code = EDataFlow.eAll.value
        is_input = (flow_code == EDataFlow.eCapture.value)
        volume = 50
        muted = False
        try:
            vol_obj = py_dev.EndpointVolume
            volume = round(vol_obj.GetMasterVolumeLevelScalar() * 100)
            muted = bool(vol_obj.GetMute())
        except Exception:
            pass
        devices.append({
            'id': dev_id,
            'name': str(py_dev.FriendlyName or 'Không tên'),
            'is_input': is_input,
            'is_output': not is_input,
            'is_default': (dev_id == default_capture_id) if is_input else (dev_id == default_render_id),
            'volume': volume,
            'muted': muted,
        })
    devices.sort(key=lambda d: (d['is_input'], d['name'].lower()))
    return devices

@app.route("/api/audio/devices")
# WHY: Route chính audio v2 — xem block WHY lớn phía trên @app.route.
# WHY: Toàn bộ COM chạy trên dedicated COM thread qua _com_call() — KHÔNG gọi pycaw
# trực tiếp từ thread request (cross-apartment → crash _ctypes.pyd, xem block WHY worker).
def api_audio_devices():
    """Liệt kê thiết bị âm thanh thực (pycaw/Core Audio) + volume/mute + default thật."""
    try:
        devices = _com_call(_list_devices_worker)
        debug_log(f"[audio] devices v2: {len(devices)} active endpoints")
        return jsonify({'devices': devices, 'source': 'core-audio', 'count': len(devices)})
    except ImportError:
        return jsonify({'devices': [], 'error': 'pycaw không khả dụng'}), 501
    except Exception as e:
        debug_log(f"[audio] api_audio_devices v2 error: {e}")
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

        # ─── Sounddevice: Lấy danh sách micro + tên mic mặc định ───
        # WHY: v2 — tên mic mặc định lấy từ pycaw GetDefaultAudioEndpoint (thật, cập nhật
        # tức thì sau khi đổi default). KHÔNG dùng sd.default.device (PortAudio cache lúc
        # import — không đổi sau khi set-default → mic_name hiển thị sai thiết bị cũ).
        # WHY: Pycaw chạy trên dedicated COM thread qua _com_call — tránh cross-apartment
        # crash _ctypes.pyd. Worker trả (default_mic_id, mic_name, capture_id_by_name) plain.
        try:
            import sounddevice as sd
            default_mic_id = None
            try:
                # WHY: Read default mic phải chạy trên COM worker thread vì
                # pycaw/comtypes không thread-safe khi gọi từ Flask request thread.
                def _mic_default_worker():
                    from pycaw.pycaw import AudioUtilities
                    dmid = None
                    mname = 'Không rõ'
                    mic_obj = AudioUtilities.GetMicrophone()
                    if mic_obj is not None:
                        dmid = mic_obj.GetId()
                    if dmid:
                        for py_dev in AudioUtilities.GetAllDevices():
                            if py_dev.id == dmid:
                                mname = str(py_dev.FriendlyName or mname)
                                break
                    return (dmid, mname)
                default_mic_id, mic_name = _com_call(_mic_default_worker, timeout=10)
            except Exception:
                pass
            # Fallback: nếu không lấy được từ pycaw, dùng sd.default.device
            if not default_mic_id:
                default_idx = sd.default.device[0]
                if default_idx is not None:
                    try:
                        dev_info = sd.query_devices(default_idx, 'input')
                        mic_name = dev_info['name']
                        if '(' in mic_name:
                            mic_name = mic_name.split('(')[-1].rstrip(')')
                    except Exception:
                        pass
            # Liệt kê tất cả input devices
            # WHY: Map tên sounddevice → các capture device id pycaw để đánh dấu default
            # chính xác theo thiết bị thật (không theo index PortAudio cũ).
            _capture_id_by_name = {}
            try:
                def _capture_map_worker():
                    from pycaw.pycaw import AudioUtilities
                    from pycaw.constants import EDataFlow
                    cmap = {}
                    for py_dev in AudioUtilities.GetAllDevices():
                        try:
                            if AudioUtilities.GetEndpointDataFlow(py_dev.id, outputType=1) != EDataFlow.eCapture.value:
                                continue
                        except Exception:
                            continue
                        n = str(py_dev.FriendlyName or '')
                        if n:
                            cmap.setdefault(n, []).append(py_dev.id)
                    return cmap
                _capture_id_by_name = _com_call(_capture_map_worker, timeout=10)
            except Exception:
                pass
            for i, dev in enumerate(sd.query_devices()):
                if dev['max_input_channels'] > 0:
                    available_mics.append({
                        'id': i,
                        'name': dev['name'],
                        'channels': dev['max_input_channels'],
                        'default': bool(default_mic_id and any(
                            default_mic_id in ids for n, ids in _capture_id_by_name.items()
                            if n in dev['name'] or dev['name'] in n
                        )),
                        'samplerate': int(dev['default_samplerate']) if dev['default_samplerate'] else 0
                    })
        except Exception:
            pass

        # ─── Pycaw: Kiểm tra mic hardware mute status ───
        # Dùng AudioUtilities.GetMicrophone() + IAudioEndpointVolume
        # (hoạt động trên capture devices, Windows 10/11)
        try:
            # WHY: Mute/unmute mic qua COM worker thread để tránh crash pycaw
            # khi gọi IAudioEndpointVolume ngoài thread đã CoInitialize.
            def _mic_mute_worker():
                from pycaw.pycaw import AudioUtilities, IAudioEndpointVolume
                from comtypes import CLSCTX_ALL, POINTER, cast
                mmuted = None
                mlevel = None
                mic = AudioUtilities.GetMicrophone()
                if mic:
                    interface = mic.Activate(
                        IAudioEndpointVolume._iid_, CLSCTX_ALL, None
                    )
                    volume = cast(interface, POINTER(IAudioEndpointVolume))
                    mmuted = bool(volume.GetMute())
                    try:
                        mlevel = volume.GetMasterVolumeLevelScalar()
                    except:
                        mlevel = None
                return (mmuted, mlevel)
            mic_muted, volume_level = _com_call(_mic_mute_worker, timeout=10)
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
                                            # WHY: Loại trừ chính backend (widget monitor mic-level)
                                            # để pythonw.exe không bị báo là app đang dùng mic thật.
                                            if _is_self_mic_app(parse_app(app_name, True)):
                                                continue
                                            is_active = True
                                            app_using = parse_app(app_name, True)
                            elif winreg.QueryValueEx(sub, 'LastUsedTimeStop')[0] == 0:
                                # WHY: Loại trừ chính mình ở nhánh packaged apps tương tự.
                                if _is_self_mic_app(parse_app(sub_name)):
                                    continue
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

        # WHY: Trả thông tin monitor mic-level đang chạy (host API + sample rate) — tab
        # Âm thanh hiển thị cho user biết widget VU meter đang đọc từ đâu. Copy dưới
        # lock (dict nhỏ, atomic). None nếu monitor chưa start/idle.
        with _mic_level_lock:
            monitor_info = dict(_mic_level_monitor_info) if _mic_level_monitor_info else None
        return jsonify({
            'active': is_active,
            'app_using_mic': app_using,
            'mic_name': mic_name,
            'mic_muted': mic_muted,
            'volume_level': volume_level,
            'overall_status': overall_status,
            'available_mics': available_mics,
            'mic_count': len(available_mics),
            'duration': 0,
            'monitor_info': monitor_info
        })
    except Exception as e:
        return jsonify({
            'active': False, 'app_using_mic': 'Lỗi',
            'mic_name': 'Không rõ', 'mic_muted': None,
            'overall_status': 'error', 'available_mics': [],
            'mic_count': 0, 'duration': 0, 'monitor_info': None, 'error': str(e)
        }), 500

# ─── Mic Level Monitor (Background Thread, Idle Auto-Stop) ──────
# WHY: Background thread đọc mức âm thanh RMS từ mic mặc định bằng
# sounddevice.InputStream — không block API requests.
# QUAN TRỌNG: Stream TỰ ĐỘNG DỪNG sau MIC_LEVEL_IDLE_TIMEOUT giây không có poll.
# Trước đây stream mở 1 lần rồi giữ mãi → Windows báo pythonw.exe "đang dùng mic"
# vĩnh viễn dù widget đã đóng. Giờ: widget đóng → widget ngừng poll → stream tự tắt
# → mic được giải phóng. Khi cần lại, lazy start lại.

_mic_level_lock = threading.Lock()
_current_mic_level = 0.0
_mic_level_stream = None
_mic_level_started = False
_mic_level_last_poll = 0.0          # time.monotonic() lúc poll gần nhất
_mic_level_last_error = 0.0         # throttle log lỗi khởi động (tránh spam mỗi 200ms)
# WHY: Đánh dấu lần start ĐẦU TIÊN của monitor trong 1 process backend — CHỈ lần đầu
# này mới retry WASAPI dài để né lỗi transient WdmSyncIoctl GLE=0x490 (xem retry block
# trong _ensure_mic_level_monitor). Sau khi start thành công (hoặc thất bại hoàn toàn)
# → False, các lần start sau (đổi default mic) dùng retry ngắn 0.4s để không kẹt poll.
_mic_level_first_start = True
MIC_LEVEL_IDLE_TIMEOUT = 5.0        # dừng stream sau 5s không có poll
_mic_level_current_device_id = None  # device id đang được monitor
# WHY: Thông tin monitor đang chạy (host API + sample rate + device name) — tab Âm thanh
# hiển thị cho user biết widget VU meter đang đọc tín hiệu từ đâu. Cập nhật dưới
# _mic_level_lock khi monitor start/stop. Plain dict, an toàn đọc xuyên thread.
_mic_level_monitor_info = None
# WHY: Throttle kiểm tra default mic đổi — GetMicrophone() là COM call nặng, poll 200ms
# (widget + AudioModule = 10 req/s) mà check mỗi lần là phí phạm + dễ trục trặc COM.
_mic_level_last_default_check = 0.0  # time.monotonic() lần check gần nhất
MIC_LEVEL_DEFAULT_CHECK_INTERVAL = 2.0  # chỉ check default mic đổi mỗi 2s

# ─── DEDICATED COM THREAD ──────────────────────────────────────
# WHY: MỌI truy cập COM âm thanh (pycaw/Windows Core Audio) chạy trên ĐÚNG 1 thread duy
# nhất (dedicated worker). Lý do bắt buộc:
#   1) Flask threaded=True → mỗi request là 1 thread khác nhau (Werkzeug thread pool).
#      Comtypes COM objects gắn với STA apartment của thread TẠO ra chúng. Nếu dùng từ
#      thread khác → COM marshal tới apartment cũ → ACCESS VIOLATION trong _ctypes.pyd
#      (đã xác nhận qua Windows Event Log: exception 0xc0000005, faulting module
#      _ctypes.pyd — đúng 100% triệu chứng user: backend chết cứng không traceback,
#      "Đặt thiết bị mặc định thất bại" + tab Nhật ký trống vì backend chết trước khi log).
#   2) pycaw AudioUtilities._PolicyConfigClient cache module-level → dùng xuyên thread
#      càng dễ crash (cần nhiều request trên nhiều thread → "mở lâu mới lỗi").
#   3) Chỉ 1 apartment → không bao giờ có 2 COM call chạy song song → hết contention,
#      không cần lock COM riêng.
_com_task_queue = queue.Queue()
# WHY: Cap queue — nếu worker kẹt (COM call treo vì audio service đứng), queue không
# phình vô hạn (mic-level poll 10 req/s → hàng chục nghìn task tích lũy = memory leak).
# _com_call đợi task trong queue; nếu queue đầy, task mới bị drop ngay (bỏ qua check
# lần này, lần sau thử lại) thay vì treo vô hạn.
_COM_QUEUE_MAX = 50
_com_worker_ready = threading.Event()
_com_worker_started = False
_com_worker_start_lock = threading.Lock()


# WHY: COM (pycaw/comtypes) chỉ an toàn khi gọi trên 1 thread duy nhất đã
# CoInitialize. Worker loop nhận task từ queue và chạy tuần tự — mọi audio API
# đều qua thread này để tránh crash _ctypes.pyd.
def _com_worker_loop():
    """Vòng lặp worker: nhận task (fn + args) từ queue, chạy trên thread này."""
    pythoncom.CoInitialize()
    _com_worker_ready.set()
    while True:
        task = _com_task_queue.get()
        if task is None:  # shutdown marker
            break
        fn, args, kwargs, box = task
        try:
            result = fn(*args, **kwargs)
            box["ok"] = True
            box["result"] = result
        except Exception as e:
            box["ok"] = False
            box["error"] = e
        finally:
            # WHY: gc.collect() NGAY trên COM thread SAU MỖI task. Comtypes objects
            # (IMMDevice wrappers từ GetAllDevices/GetMicrophone) thường tạo reference
            # cycles → không release ngay khi hàm return mà chờ GC. Nếu GC chạy trên
            # thread request (Flask) khác → __del__ → Release() cross-apartment →
            # ACCESS VIOLATION trong comtypes (đã xác nhận: faulthandler dump thấy
            # "Garbage-collecting" + unknwn.py Release trong thread worker, exit code
            # 0xC0000005). Collect trên worker thread đảm bảo mọi object được release
            # đúng apartment của chúng.
            try:
                gc.collect()
            except Exception:
                pass
            box["done"].set()


# WHY: Start COM worker thread lazily (chỉ 1 lần) — tránh tốn thread boot,
# nhưng vẫn guarantee mọi audio call chạy đúng 1 thread đã CoInitialize.
def _ensure_com_worker():
    """Lazy start worker thread — chỉ 1 lần (daemon, sống cùng process)."""
    global _com_worker_started
    if _com_worker_started:
        return
    with _com_worker_start_lock:
        if _com_worker_started:
            return
        threading.Thread(target=_com_worker_loop, daemon=True).start()
        ready = _com_worker_ready.wait(timeout=5)
        if not ready:
            # WHY: Worker không khởi động được (hiếm: CoInitialize throw) — không
            # đánh dấu started → các lần sau retry start. Tránh "queue chết âm thầm".
            debug_log("[audio] COM worker failed to start!")
            return
        _com_worker_started = True


# WHY: Gọi 1 hàm trên COM thread và chờ kết quả (blocking, timeout an toàn).
# KHÔNG BAO GIỜ trả comtypes object xuyên thread — chỉ trả dữ liệu nguyên thủy
# (id/name/volume/boolean...) đã chuyển thành kiểu Python an toàn TRONG worker.
def _com_call(fn, *args, timeout=15, **kwargs):
    """Chạy fn trên dedicated COM thread, trả kết quả. Raise lỗi nếu fn throw.
    Queue đầy (worker kẹt) → drop task ngay + raise QueueFull — caller bỏ qua lần này."""
    _ensure_com_worker()
    if not _com_worker_started:
        raise RuntimeError("COM worker not ready")
    if _com_task_queue.qsize() >= _COM_QUEUE_MAX:
        raise RuntimeError("COM queue full (worker stuck) — skip")
    box = {"ok": False, "result": None, "error": None, "done": threading.Event()}
    _com_task_queue.put((fn, args, kwargs, box))
    if not box["done"].wait(timeout):
        raise TimeoutError(f"COM call timeout: {getattr(fn, '__name__', fn)}")
    if not box["ok"]:
        raise box["error"]
    return box["result"]

# WHY: Import numpy ở module level (trong try/except vì numpy là optional dependency).
# sounddevice trả về numpy arrays, nhưng import callback mỗi 200ms là wasteful.
try:
    import numpy as np
except ImportError:
    np = None

# WHY: Callback của InputStream — chạy trên thread âm thanh, tính RMS mỗi khối.
# Smooth (lerp) để VU meter không nhảy giật.
def _mic_level_callback(indata, frames, time_info, status):
    """Callback sounddevice InputStream — tính RMS mỗi khi có audio data."""
    global _current_mic_level
    try:
        if np is None:
            return
        # indata shape: (frames, channels)
        # Tính RMS: sqrt(mean(samples^2))
        rms = float(np.sqrt(np.mean(indata ** 2)))
        # WHY: Amplify nhẹ (x3) để VU meter nhạy hơn, clamp về 1.0
        # Smooth với giá trị cũ (lerp 0.35) để tránh nhảy giật
        with _mic_level_lock:
            _current_mic_level = _current_mic_level * 0.65 + min(rms * 3.0, 1.0) * 0.35
    except Exception:
        pass

# WHY: Watchdog thread — quét mỗi 2s, dừng stream nếu không có poll nào
# trong MIC_LEVEL_IDLE_TIMEOUT giây. Giải phóng microphone tự động khi
# widget đóng (widget ngừng poll /api/audio/mic-level).
def _mic_level_idle_watchdog():
    global _mic_level_stream, _mic_level_started, _current_mic_level, _mic_level_monitor_info
    while True:
        time.sleep(2)
        try:
            stream_to_stop = None
            # WHY: Check + take stream trong cùng 1 khóa lock (atomic) — tránh
            # check-then-act race với _ensure_mic_level_monitor tạo stream mới.
            with _mic_level_lock:
                if (_mic_level_started and _mic_level_stream is not None and
                        (time.monotonic() - _mic_level_last_poll) > MIC_LEVEL_IDLE_TIMEOUT):
                    stream_to_stop = _mic_level_stream
                    _mic_level_stream = None
                    _mic_level_started = False
                    _current_mic_level = 0.0
                    _mic_level_monitor_info = None
            # WHY: Gọi stream.stop() NGOÀI lock — stop() chờ callback trả về mà callback
            # cũng acquire _mic_level_lock → giữ lock khi stop() sẽ deadlock.
            # WHY: Gọi close() SAU stop() — giải phóng PortAudio resources ngay. Trước đây
            # chỉ stop() không close() → mỗi lần restart monitor (đổi default mic) leak 1
            # stream → sau nhiều lần đổi + poll 200ms liên tục → PortAudio DLL crash
            # (exit code 0xC0000005 access violation, không traceback — đúng triệu chứng
            # "mở lâu rồi đổi mic bị lỗi, backend chết im lặng"). close() = stop + release.
            if stream_to_stop is not None:
                try:
                    stream_to_stop.stop()
                except Exception:
                    pass
                try:
                    stream_to_stop.close()
                except Exception:
                    pass
                debug_log("[mic-level] Monitor stopped (idle timeout)")
        except Exception:
            pass

# WHY: Xác định app đang dùng mic có phải chính backend không.
# Backend mở InputStream đo mic-level → Windows registry (CapabilityAccessManager)
# ghi nhận pythonw.exe/python.exe là app đang dùng mic. Đây là chính mình
# (widget monitor), không phải app thật — cần loại trừ khỏi kết quả mic-status.
def _is_self_mic_app(exe_path):
    try:
        if not exe_path:
            return False
        norm = os.path.normcase(os.path.normpath(exe_path))
        self_exe = os.path.normcase(sys.executable)
        if norm == self_exe:
            return True
        # WHY: Backend có thể chạy bằng python.exe còn registry ghi pythonw.exe
        # (hoặc ngược lại) — so sánh thư mục + basename là đủ.
        if os.path.basename(norm) in ('python.exe', 'pythonw.exe'):
            return os.path.dirname(norm) == os.path.dirname(self_exe)
    except Exception:
        pass
    return False

# WHY: Watchdog chỉ cần 1 thread duy nhất cho toàn app (daemon — tự tắt khi exit).
threading.Thread(target=_mic_level_idle_watchdog, daemon=True).start()

def _ensure_mic_level_monitor():
    """Lazy start InputStream. Nếu stream đang chạy → return ngay (không mở lại).
    Nếu default mic đã đổi → stop stream cũ, start stream mới trên device mới."""
    global _mic_level_stream, _mic_level_started, _mic_level_last_error, _mic_level_current_device_id, _mic_level_last_default_check, _mic_level_monitor_info, _mic_level_first_start
    # WHY: Check + start trong cùng 1 khóa lock (atomic) — tránh check-then-act race:
    # widget poll /mic-level mỗi 200ms VÀ AudioModule cũng poll /mic-level mỗi 200ms
    # → 2 request song song cùng thấy _mic_level_started=False → cùng tạo InputStream
    # → mở 2 stream trên cùng device (log "Monitor started on device #1" xuất hiện 2 lần).
    stream_to_stop = None
    current_default_mic_id = None
    # WHY: BƯỚC 1 — đọc trạng thái nhanh dưới _mic_level_lock (KHÔNG COM call trong lock!).
    # Trước đây AudioUtilities.GetMicrophone() chạy TRONG _mic_level_lock — nếu COM call
    # block (Windows Audio bận khi set-default verify, hoặc COM apartment exhaustion sau
    # thời gian dài) → giữ lock vô hạn → MỌI poll /mic-level (10 req/s) block trên lock
    # → Flask threaded chồng thread → backend nghẽn toàn diện → UI báo "mất kết nối
    # backend", tab Log trắng, set-default báo lỗi mà không có log (đúng triệu chứng user).
    now = time.monotonic()
    need_check = False
    with _mic_level_lock:
        # WHY: Throttle — chỉ hỏi Windows default mic mỗi MIC_LEVEL_DEFAULT_CHECK_INTERVAL giây.
        # Trước đây GetMicrophone() (COM enumeration toàn bộ devices) chạy mỗi 200ms poll
        # → phí phạm + COM call đồng thời với set-default (thread khác) gây tranh chấp.
        need_check = (_mic_level_stream is None) or (not _mic_level_started) or (now - _mic_level_last_default_check) >= MIC_LEVEL_DEFAULT_CHECK_INTERVAL
        if need_check:
            _mic_level_last_default_check = now
    
    # WHY: BƯỚC 2 — COM call (GetMicrophone) chạy trên dedicated COM thread qua _com_call,
    # NGOÀI _mic_level_lock. Nếu COM call block thì chỉ 1 request này chậm, KHÔNG kẹt toàn
    # bộ hệ thống poll. Worker trả về id chuỗi (plain data, an toàn xuyên thread).
    # WHY: timeout NGẮN (0.5s) — poll 200ms không được chờ lâu. Khi set-default đang giữ
    # worker (verify loop tới 4.5s), check này timeout ngay → bỏ qua lần này (guard
    # current_default_mic_id is not None ở BƯỚC 3 ngăn restart sai). Lần poll sau thử lại.
    # Nếu để timeout 3s, widget VU meter bị "đóng băng" 3s mỗi lần user đổi mic.
    if need_check:
        try:
            # WHY: Đọc default mic qua COM worker để tránh pycaw gọi sai thread.
            def _get_default_mic_worker():
                from pycaw.pycaw import AudioUtilities
                mic_obj = AudioUtilities.GetMicrophone()
                return mic_obj.GetId() if mic_obj is not None else None
            current_default_mic_id = _com_call(_get_default_mic_worker, timeout=0.5)
        except Exception:
            pass
        
    # WHY: BƯỚC 3 — quyết định restart/start dưới lock (atomic, không COM).
    with _mic_level_lock:
        # Nếu default mic đã đổi so với device đang monitor → reset để start lại
        if _mic_level_started and _mic_level_stream is not None:
            # WHY: Guard current_default_mic_id is not None — nếu GetMicrophone() lỗi
            # (COM transient), không được coi là "default đổi" → tránh restart monitor
            # mỗi 2s (churn) khi COM cứ fail liên tục.
            if need_check and current_default_mic_id is not None and _mic_level_current_device_id != current_default_mic_id:
                debug_log(f"[mic-level] Default mic changed ({_mic_level_current_device_id} -> {current_default_mic_id}), restarting monitor")
                stream_to_stop = _mic_level_stream
                _mic_level_stream = None
                _mic_level_started = False
                _mic_level_current_device_id = None
                _mic_level_monitor_info = None
            else:
                return
        if _mic_level_stream is not None:
            return
        _mic_level_stream = "starting"
    # WHY: Gọi stream.stop() NGOÀI lock — BUG FIX (deadlock khi đổi mic mặc định):
    # trước đây stop() nằm TRONG with _mic_level_lock dù comment ghi "outside".
    # stop() chờ callback âm thanh trả về, mà _mic_level_callback lại cần acquire
    # _mic_level_lock để cập nhật _current_mic_level → giữ lock khi stop() = deadlock:
    # - thread Flask xử lý /mic-level kẹt vĩnh viễn (giữ lock)
    # - MỌI poll /mic-level sau đó (widget + module, mỗi 200ms) block trên lock
    # → thread chồng thread → backend nghẽn → UI báo "không kết nối backend",
    # tab Log trắng, set-default phải bấm nhiều lần mới được (đúng triệu chứng user).
    # WHY: close() sau stop() — giải phóng PortAudio resources (xem WHY ở idle watchdog).
    if stream_to_stop is not None:
        try:
            stream_to_stop.stop()
        except Exception:
            pass
        try:
            stream_to_stop.close()
        except Exception:
            pass
    try:
        import sounddevice as sd
        # WHY: Dùng pycaw GetMicrophone() để lấy default mic THEO WINDOWS (Core Audio),
        # KHÔNG dùng sd.default.device[0] (PortAudio cache lúc import — không đổi sau set-default).
        # Map pycaw device id → sounddevice index để mở InputStream đúng thiết bị.
        default_mic_id = current_default_mic_id
        
        candidate_indices = []
        if default_mic_id:
            # Map pycaw device id → sounddevice index using robust matching
            # Strategy: build name->index map from sounddevice, prefer exact match,
            # then longest match (to avoid truncated entries like "Microphone (PD200X Podcast Micr")
            try:
                # WHY: Map device id -> FriendlyName qua COM worker (pycaw không
                # thread-safe, map này phục vụ lọc tên thiết bị bị truncate).
                def _get_pycaw_name_worker(dev_id):
                    from pycaw.pycaw import AudioUtilities
                    for py_dev in AudioUtilities.GetAllDevices():
                        if py_dev.id == dev_id:
                            return str(py_dev.FriendlyName or '')
                    return ''
                py_name = _com_call(_get_pycaw_name_worker, default_mic_id, timeout=10)
                
                if py_name:
                    # WHY: sounddevice liệt kê CÙNG 1 mic ở NHIỀU host API (MME, DirectSound,
                    # WASAPI, WDM-KS). Lấy index đầu tiên theo tên sẽ trúng MME/DirectSound —
                    # host API dễ kẹt nhất trên Windows (log thực tế: "DirectSound error -9999"
                    # kéo dài từ 11:24, monitor không bao giờ start được).
                    # WASAPI shared mode là host API bền nhất: không exclusive → không bao giờ
                    # bị tranh chấp với app khác, refresh device list tốt sau set-default.
                    # Ưu tiên: WASAPI(0) > MME(1) > DirectSound(2) > WDM-KS/khác(3).
                    hostapi_rank = {}
                    for _ha_i, ha in enumerate(sd.query_hostapis()):
                        hn = ha['name']
                        if 'WASAPI' in hn:
                            hostapi_rank[_ha_i] = 0
                        elif 'MME' in hn:
                            hostapi_rank[_ha_i] = 1
                        elif 'DirectSound' in hn:
                            hostapi_rank[_ha_i] = 2
                        else:
                            hostapi_rank[_ha_i] = 3
                    ranked = []
                    for _i, dev in enumerate(sd.query_devices()):
                        if dev['max_input_channels'] <= 0:
                            continue
                        sd_name = dev['name']
                        # Containment 2 chiều: che cả exact match lẫn tên bị truncate
                        # (MME cắt tên: "Microphone (PD200X Podcast Micr").
                        if py_name == sd_name or sd_name in py_name or py_name in sd_name:
                            # WHY: Sort theo (host_api_rank, -len(tên), index) — trong cùng
                            # tier host API, tên DÀI nhất (đặc hiệu nhất) thắng. Tránh tên
                            # chung chung ngắn (vd "Microphone ()" WDM-KS) match nhầm mic
                            # khác khi nằm ở index thấp hơn.
                            ranked.append((hostapi_rank.get(dev['hostapi'], 9), -len(sd_name), _i))
                    ranked.sort()
                    candidate_indices = [i for _, _, i in ranked][:8]
            except Exception:
                pass
        
        # Fallback: PortAudio default device (thêm CUỐI danh sách — ưu tiên host API bền hơn)
        try:
            if sd.default.device[0] is not None and sd.default.device[0] not in candidate_indices:
                candidate_indices.append(sd.default.device[0])
        except Exception:
            pass
        
        # WHY: Mở stream theo thứ tự candidate (WASAPI trước) + thử nhiều sample rate.
        # Trước đây hardcode samplerate=16000 → WASAPI trả "Invalid sample rate" (-9997)
        # vì WASAPI shared mode chỉ hỗ trợ native rate của device (48000/44100) → monitor
        # không bao giờ start trên WASAPI. Giờ thử native rate trước, rồi 48k/44.1k/32k/16k.
        opened = None
        last_err = None
        for index in candidate_indices:
            if index is None or index == -1:
                continue
            try:
                dev_info = sd.query_devices(index)
                hostapi_name = sd.query_hostapis()[dev_info['hostapi']]['name']
                native = int(dev_info.get('default_samplerate') or 48000)
                rates = []
                for r in (native, 48000, 44100, 32000, 16000):
                    if r not in rates:
                        rates.append(r)
                for rate in rates:
                    try:
                        # WHY: WASAPI shared mode (exclusive=False) — không chiếm device độc
                        # quyền, không bị kẹt khi app khác dùng mic, hỗ trợ đổi default tốt.
                        # WHY: auto_convert=True (PortAudio paWinWasapiAutoConvert) — WASAPI
                        # shared mode CHỈ nhận đúng mix format của device (thường 48k 16-bit
                        # stereo). Không có flag này, mọi rate khác mix format đều fail với
                        # AUDCLNT_E_UNSUPPORTED_FORMAT (log thực tế: "WASAPI open failed on
                        # #29 rate=44100 / #30 rate=48000 ... -9999"). auto_convert cho WASAPI
                        # tự convert format client về mix format → hết lỗi unsupported format.
                        extra = sd.WasapiSettings(exclusive=False, auto_convert=True) if 'WASAPI' in hostapi_name else None
                        stream = sd.InputStream(
                            device=index,
                            channels=1,
                            samplerate=rate,
                            blocksize=1024,
                            callback=_mic_level_callback,
                            extra_settings=extra,
                        )
                        stream.start()
                        opened = (stream, index, hostapi_name, rate)
                        break
                    except Exception as e:
                        last_err = e
                        # WHY: Close stream vừa fail — tránh giữ handle device tới khi GC chạy
                        # (đúng nguyên nhân WdmSyncIoctl GLE=0x490: stream cũ chưa release).
                        try:
                            stream.close()
                        except Exception:
                            pass
                        # WHY: Retry NGẮN cho WASAPI — khi restart monitor NGAY sau set-default,
                        # Windows Audio cần ~0.3-0.6s để WASAPI nhận device default mới. QUAN
                        # TRỌNG: loop này chạy trên thread request poll /mic-level (widget poll
                        # 200ms), nên retry dài (0.7s x2 x 5 rates = ~7s) làm poll bị giữ >5s →
                        # widget VU "đứng" 3-5s mỗi lần đổi mic + request timeout (đã xác nhận
                        # trong stress test 15 phút: 1 poll fail mỗi lần đổi mic).
                        # Retry 1 lần x 0.4s, giới hạn tổng thời gian WASAPI <= ~1.5s — nếu fail
                        # vẫn còn MME fallback (luôn mở được, đúng thiết bị).
                        if 'WASAPI' in hostapi_name and rate in (native, 48000):
                            # WHY: Retry WASAPI NGẮN khi restart monitor (đổi default mic) —
                            # Windows Audio cần ~0.3-0.6s để nhận device default mới. QUAN
                            # TRỌNG: loop chạy trên thread request poll /mic-level (200ms),
                            # retry dài làm widget VU "đứng" + request timeout.
                            # RIÊNG lần start ĐẦU TIÊN sau khi backend vừa khởi động:
                            # WASAPI có thể trả lỗi transient WdmSyncIoctl GLE=0x490
                            # (ERROR_INVALID_DEVICE_STATE — Windows Audio/driver chưa sẵn
                            # sàng, đã ghi nhận trong log 18:22:08). Retry DÀI hơn
                            # (0.4/1.0/2.0s) chỉ trong lần đầu để né lỗi này; nếu vẫn fail
                            # → MME fallback. Tổng ~3.4s block lần đầu — trade-off chấp
                            # nhận được (chỉ xảy ra 1 lần khi monitor khởi động lần đầu).
                            # WHY: Retry dài CHỈ cho native rate — nếu áp cả 48000, device có
                            # native=44100 (VD: PC-LM1E) sẽ chạy retry 3.4s x2 (native + 48000)
                            # = ~6.8s block lần đầu, gấp đôi trade-off đã thống nhất (~3.4s).
                            retry_delays = (0.4, 1.0, 2.0) if (_mic_level_first_start and rate == native) else (0.4,)
                            for _rd in retry_delays:
                                time.sleep(_rd)
                                try:
                                    stream2 = sd.InputStream(
                                        device=index,
                                        channels=1,
                                        samplerate=rate,
                                        blocksize=1024,
                                        callback=_mic_level_callback,
                                        extra_settings=extra,
                                    )
                                    stream2.start()
                                    opened = (stream2, index, hostapi_name, rate)
                                    break
                                except Exception as e2:
                                    last_err = e2
                                    try:
                                        stream2.close()
                                    except Exception:
                                        pass
                            if opened:
                                break
                            # WHY: Log 1 lần cho thấy lý do WASAPI thất bại (không spam —
                            # chỉ khi WASAPI là candidate đầu và fail hết retry).
                            if time.monotonic() - _mic_level_last_error > 30:
                                _mic_level_last_error = time.monotonic()
                                debug_log(f"[mic-level] WASAPI open failed on #{index} rate={rate}: {str(last_err)[:120]}")
                        continue
                if opened:
                    break
            except Exception as e:
                last_err = e
                continue
        
        if opened is not None:
            stream, index, hostapi_name, rate = opened
            # WHY: Gán vào biến local trước, commit vào global CHỈ SAU KHI start() thành công.
            # Nếu start() throw, _mic_level_stream không giữ tham chiếu stream chưa start
            # (tránh leak object + tránh ghi đè stream cũ đang chạy).
            try:
                _dev_name = sd.query_devices(index)['name']
            except Exception:
                _dev_name = '?'
            with _mic_level_lock:
                _mic_level_stream = stream
                _mic_level_started = True
                _mic_level_current_device_id = default_mic_id if default_mic_id else None
                _mic_level_monitor_info = {
                    'hostapi': hostapi_name,
                    'samplerate': rate,
                    'device_index': index,
                    'device_name': _dev_name,
                }
            # WHY: Monitor đã start — không còn là lần đầu. Lần start sau (đổi default
            # mic, widget đóng/mở lại) dùng retry WASAPI ngắn.
            _mic_level_first_start = False
            debug_log(f"[mic-level] Monitor started on device #{index} [{hostapi_name}] '{_dev_name}' rate={rate} (pycaw_id={default_mic_id})")
        else:
            # WHY: Lần đầu thất bại hoàn toàn (vd không có default mic) — tắt chế độ
            # retry dài ngay: nếu giữ True, mỗi poll 200ms lại block ~3.4s retry WASAPI
            # → widget VU meter "đứng" vĩnh viễn tới khi có mic khả dụng.
            _mic_level_first_start = False
            if time.monotonic() - _mic_level_last_error > 30:
                # WHY: Không có mic mặc định — log tối đa 1 lần/30s (poll 200ms sẽ spam)
                _mic_level_last_error = time.monotonic()
                with _mic_level_lock:
                    _mic_level_stream = None
                    _mic_level_monitor_info = None
                debug_log("[mic-level] No default input device found")
    except Exception as e:
        # WHY: Reset flag trong mọi đường lỗi — nếu sót, flag True vô hạn → mỗi poll
        # lại thử retry dài (dù thực tế retry block không chạm tới khi sounddevice thiếu).
        _mic_level_first_start = False
        if time.monotonic() - _mic_level_last_error > 30:
            # WHY: Throttle log lỗi khởi động — tránh spam mỗi 200ms khi thiếu dependency
            _mic_level_last_error = time.monotonic()
            debug_log(f"[mic-level] Failed to start monitor: {e}")
        with _mic_level_lock:
            _mic_level_stream = None
            _mic_level_monitor_info = None

@app.route("/api/audio/mic-level")
# WHY: Endpoint siêu nhẹ — chỉ trả về RMS level (float 0.0-1.0).
# Widget poll mỗi 200ms để vẽ VU meter real-time.
# Background thread tự khởi động ở request đầu tiên.
def api_audio_mic_level():
    """Trả về mức âm thanh micro real-time (RMS 0.0-1.0)
    Dùng background sounddevice InputStream để đọc audio level liên tục.
    """
    global _mic_level_last_poll
    _mic_level_last_poll = time.monotonic()
    _ensure_mic_level_monitor()
    with _mic_level_lock:
        level = _current_mic_level
    return jsonify({'level': round(level, 4)})

@app.route("/api/audio/devices/<dev_id>/mute", methods=["POST"])
# WHY: Audio v2 — dev_id là id chuỗi (GUID) từ pycaw, match chính xác tuyệt đối,
# không còn nhập nhằng index/name. Toggle mute qua IAudioEndpointVolume.
# WHY: Toàn bộ COM chạy trên dedicated COM thread (qua _com_call) — không bao giờ
# gọi pycaw từ thread request (cross-apartment → crash _ctypes.pyd).
def api_audio_mute(dev_id):
    """Bật/tắt mute cho thiết bị audio (theo device id chuỗi)"""
    try:
        def _mute_worker(did):
            py_dev = _find_pycaw_device(did)
            if py_dev is None:
                return None
            name = str(py_dev.FriendlyName or did)
            vol_obj = py_dev.EndpointVolume
            current = bool(vol_obj.GetMute())
            vol_obj.SetMute(not current, None)
            return {'name': name, 'muted': not current}
        result = _com_call(_mute_worker, dev_id, timeout=10)
        if result is None:
            return jsonify({'error': 'Không tìm thấy thiết bị'}), 404
        debug_log(f"[audio] mute '{result['name']}' -> {'muted' if result['muted'] else 'unmuted'}")
        return jsonify({'status': 'toggled', 'muted': result['muted'], 'name': result['name']})
    except Exception as e:
        debug_log(f"[audio] mute {dev_id} error: {e}")
        return jsonify({'error': str(e)}), 500

@app.route("/api/audio/devices/<dev_id>/volume", methods=["PUT"])
# WHY: Audio v2 — SetMasterVolumeLevelScalar 0.0-1.0, clamp 0-100 từ frontend.
def api_audio_volume(dev_id):
    """Điều chỉnh âm lượng thiết bị audio (theo device id chuỗi)"""
    try:
        data = request.get_json() or {}
        vol = max(0, min(100, int(data.get('volume', 50)))) / 100.0
        # WHY: Set volume phải qua COM worker thread (pycaw cần thread đã CoInitialize).
        def _volume_worker(did, v):
            py_dev = _find_pycaw_device(did)
            if py_dev is None:
                return None
            name = str(py_dev.FriendlyName or did)
            py_dev.EndpointVolume.SetMasterVolumeLevelScalar(v, None)
            return {'name': name, 'volume': int(v * 100)}
        result = _com_call(_volume_worker, dev_id, vol, timeout=10)
        if result is None:
            return jsonify({'error': 'Không tìm thấy thiết bị'}), 404
        debug_log(f"[audio] volume '{result['name']}' -> {result['volume']}%")
        return jsonify({'status': 'set', 'volume': result['volume'], 'name': result['name']})
    except Exception as e:
        debug_log(f"[audio] volume {dev_id} error: {e}")
        return jsonify({'error': str(e)}), 500

@app.route("/api/audio/devices/<dev_id>/default", methods=["POST"])
# WHY: Set default qua AudioUtilities.SetDefaultDevice (pycaw helper dùng
# CLSID_CPolicyConfigClient/IPolicyConfig — verify hoạt động, HRESULT 0).
# WHY: Set CẢ 3 role + verify default đổi thật, nếu không đổi trả lỗi rõ ràng.
# WHY: TOÀN BỘ COM (SetDefaultDevice + verify) chạy trên dedicated COM thread qua
# _com_call — không bao giờ gọi pycaw từ thread request (cross-apartment crash).
def api_audio_set_default(dev_id):
    """Đặt thiết bị audio làm mặc định (set 3 role + verify)
    Toàn bộ COM chạy trên dedicated COM thread qua _com_call."""
    try:
        # WHY: Toàn bộ SetDefaultDevice + verify loop chạy trong 1 worker trên COM thread.
        # Worker trả dict plain: {'found': bool, 'name': str, 'is_input': bool, 'changed': bool}.
        # KHÔNG bao giờ trả comtypes object xuyên thread. Verify bên trong worker — retry
        # sleep cũng nằm trong worker (chỉ 1 request set-default tại 1 thời điểm vì queue).
        def _set_default_worker(did):
            from pycaw.pycaw import AudioUtilities
            from pycaw.constants import ERole, EDataFlow
            from comtypes import CoCreateInstance, CLSCTX_INPROC_SERVER
            from pycaw.pycaw import IMMDeviceEnumerator
            from pycaw.utils import CLSID_MMDeviceEnumerator

            py_dev = _find_pycaw_device(did)
            if py_dev is None:
                return {'found': False}
            name = str(py_dev.FriendlyName or did)
            try:
                flow_code = AudioUtilities.GetEndpointDataFlow(did, outputType=1)
            except Exception:
                flow_code = EDataFlow.eAll.value
            is_input = (flow_code == EDataFlow.eCapture.value)

            roles = [ERole.eConsole, ERole.eMultimedia, ERole.eCommunications]
            AudioUtilities.SetDefaultDevice(did, roles=roles)

            # WHY: Verify lại thực tế default device đã đổi (SetDefaultDevice đôi
            # khi "thành công" nhưng hệ thống không áp dụng — check qua IMMDeviceEnumerator).
            def _verify_default():
                try:
                    devEnum = CoCreateInstance(CLSID_MMDeviceEnumerator, IMMDeviceEnumerator, CLSCTX_INPROC_SERVER)
                    flow_to_check = EDataFlow.eCapture.value if is_input else EDataFlow.eRender.value
                    curr = devEnum.GetDefaultAudioEndpoint(flow_to_check, ERole.eMultimedia.value)
                    return curr is not None and curr.GetId() == did
                except Exception:
                    return False

            changed = False
            for _delay in (0.3, 0.6, 1.2, 2.4):
                time.sleep(_delay)
                changed = _verify_default()
                if changed:
                    break
            return {'found': True, 'name': name, 'is_input': is_input, 'changed': changed}

        result = _com_call(_set_default_worker, dev_id, timeout=20)
        if not result.get('found'):
            # WHY: Ghi log cả trường hợp 404 — trước đây bỏ im lặng → user thấy
            # toast "thất bại" nhưng tab Nhật ký không có dòng nào (không biết lý do).
            debug_log(f"[audio][ERROR] set-default '{dev_id}' FAILED: device not found")
            return jsonify({'error': 'Không tìm thấy thiết bị'}), 404

        name = result['name']
        is_input = result['is_input']
        changed = result['changed']
        debug_log(f"[audio] set-default '{name}' verified={changed}")
        if not changed:
            debug_log(f"[audio][ERROR] set-default '{name}' FAILED: verified=False after retries")
            return jsonify({'error': 'API đã gọi nhưng thiết bị mặc định chưa thay đổi'}), 500
        debug_log(f"[audio][SUCCESS] set-default '{name}' OK")
        return jsonify({'status': 'set_default', 'is_input': is_input, 'name': name})
    except Exception as e:
        debug_log(f"[audio][ERROR] set-default '{dev_id}' exception: {e}")
        import traceback
        debug_log(f"[audio][ERROR] set-default traceback: {traceback.format_exc()}")
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
# WHY: Đọc debug.log cho màn hình Debug trong app — file log vòng lặp của backend,
# giúp user gửi log khi gặp lỗi mà không cần mở terminal.
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

# WHY: Log phiên trước — Rust setup rename debug.log → debug.log.old mỗi phiên app.
# Endpoint này cho tab Nhật ký đọc file .old để user so sánh lỗi cũ mà không phải
# mò file thủ công. Trả exists=False khi chưa có (phiên đầu tiên).
@app.route("/api/debug-log/old")
def api_debug_log_old():
    """Lấy nội dung file debug.log.old (log phiên trước)"""
    try:
        old_path = CONFIG_DIR / "debug.log.old"
        if old_path.exists():
            with open(old_path, 'r', encoding='utf-8') as f:
                lines = f.readlines()
            return jsonify({'log': ''.join(lines), 'exists': True})
        return jsonify({'log': '', 'exists': False})
    except Exception as e:
        return jsonify({'error': str(e), 'exists': False}), 500

# WHY: Endpoint ghi log từ widget (webview riêng) vào debug.log — widget không
# gọi được debug_log() trực tiếp vì chạy ngoài backend; mọi thao tác drag/resize/
# close của widget POST qua đây để Log tab trong app chính thấy được, phục vụ
# bắt bug liên quan widget. Fire-and-forget từ phía client, không validate gắt.
@app.route("/api/log", methods=["POST"])
def api_log_append():
    """Nhận log từ widget và ghi vào debug.log"""
    data = request.get_json(silent=True) or {}
    msg = data.get("msg")
    if isinstance(msg, str) and msg.strip():
        debug_log(f"[widget] {msg.strip()[:500]}")
        return jsonify({'ok': True})
    return jsonify({'ok': False, 'error': 'Thiếu msg'}), 400

# WHY: Xóa debug.log khi user bấm Clear — giải phóng dung lượng + bắt đầu log sạch
# để debug vấn đề tiếp theo dễ hơn.
@app.route("/api/debug-log/clear", methods=["POST"])
def api_debug_log_clear():
    """Xóa file debug.log"""
    try:
        if DEBUG_LOG.exists():
            DEBUG_LOG.unlink()
        return jsonify({'status': 'cleared'})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# WHY: Ghi log đã lọc (client) xuống đường dẫn do user chọn qua save dialog Tauri.
# Anchor download bị WebView2 chặn → backend ghi file trực tiếp; thêm BOM để
# Notepad hiển thị UTF-8 (tiếng Việt) đúng. Chỉ nhận absolute path (user tự chọn).
@app.route("/api/debug-log/export", methods=["POST"])
def api_debug_log_export_write():
    """Lưu nội dung log export xuống file (path do user chọn)."""
    data = request.get_json(silent=True) or {}
    path = data.get("path")
    content = data.get("content")
    if not isinstance(path, str) or not path.strip() or not isinstance(content, str):
        return jsonify({"error": "Thiếu path hoặc content"}), 400
    path = path.strip()
    if not os.path.isabs(path):
        return jsonify({"error": "Path phải là đường dẫn tuyệt đối"}), 400
    try:
        # WHY: BOM (\ufeff) đầu file — Notepad mặc định đọc ANSI, không có BOM
        # thì tiếng Việt bị vỡ chữ. Backend app mở file đều dùng utf-8-sig nên an toàn.
        with open(path, "w", encoding="utf-8-sig") as f:
            f.write(content)
        return jsonify({"ok": True, "path": path})
    except OSError as e:
        return jsonify({"error": str(e)}), 500

# ─── AUDIO ERROR LOGS ─────────────────────────────────────────────
# WHY: Endpoint chuyên lấy log lỗi audio gần nhất — Log tab hiển thị
# filter 'error' sẽ lọc được, nhưng thêm endpoint này để UI dễ dàng
# hiển thị danh sách lỗi audio riêng (không bị trộn với tunnel/watchdog).
@app.route("/api/audio/errors")
def api_audio_errors():
    """Lấy các log lỗi audio gần nhất (200 dòng cuối)"""
    try:
        if not DEBUG_LOG.exists():
            return jsonify({'errors': [], 'total_lines': 0})
        with open(DEBUG_LOG, 'r', encoding='utf-8') as f:
            lines = f.readlines()
        # Lọc dòng có [audio] và (ERROR hoặc error hoặc exception)
        audio_errors = []
        for line in lines:
            if '[audio]' in line and ('ERROR' in line.upper() or 'EXCEPTION' in line.upper() or 'FAILED' in line.upper()):
                audio_errors.append(line.strip())
        return jsonify({'errors': audio_errors[-200:], 'total_lines': len(lines)})
    except Exception as e:
        return jsonify({'error': str(e), 'errors': []}), 500

# WHY: Endpoint lấy TẤT CẢ log (không filter) cho debug sâu
@app.route("/api/debug-log/raw")
def api_debug_log_raw():
    """Lấy toàn bộ debug.log raw (giữ nguyên format)"""
    try:
        if DEBUG_LOG.exists():
            with open(DEBUG_LOG, 'r', encoding='utf-8') as f:
                return f.read()
        return 'Chưa có log'
    except Exception as e:
        return str(e), 500

shutdown_server = False

# WHY: Tắt toàn bộ: terminate MỌI project đang quản lý rồi os._exit(0) qua thread
# riêng — không chờ Flask teardown vì app phải chết ngay (kèm theo app Tauri chính).
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

# WHY: Preload endpoint — trả về toàn bộ dữ liệu khởi tạo 1 lần (projects +
# running state) cho LoadingScreen render nhanh khi boot, tránh N request rời rạc.
@app.route('/api/preload', methods=['GET'])
def api_preload():
    """Preload endpoint — trả về tất cả dữ liệu khởi tạo một lần."""
    debug_log("Preload requested")
    try:
        projects = []
        if os.path.exists(CONFIG_PATH):
            with open(CONFIG_PATH, 'r', encoding='utf-8') as f:
                conf = json.load(f)
            for p in conf.get('projects', []):
                name = p.get('name', '')
                projects.append({
                    'name': name,
                    'port': p.get('port', 3000),
                    'path': p.get('path', ''),
                    'command': p.get('command', ''),
                    'running': is_running(name)
                })
        result = {
            'status': 'ready',
            'projects': projects,
        }
        return jsonify(result)
    except Exception as e:
        debug_log(f"Preload error: {e}")
        return jsonify({'status': 'ready', 'projects': []})




# WHY: Route gốc serve SPA index.html từ FRONTEND_DIST (build production của Vite)
# — Flask là web server duy nhất, không cần tách static server riêng.
@app.route("/")
def index():
    return send_from_directory(str(FRONTEND_DIST), "index.html")

# WHY: Catch-all route serve assets/static của SPA (js/css/font...) — path đệ quy,
# 404 nếu file không tồn tại sẽ do Flask trả lỗi mặc định.
@app.route("/<path:path>")
def static_files(path):
    return send_from_directory(str(FRONTEND_DIST), path)

# WHY: Khôi phục project có start_on_launch khi app boot. Port đã có dev-server
# listen (kể cả server ngoài app/user tự chạy) → KHÔNG start lại — đúng nguyên tắc
# "liveness từ port probe, không từ PID lưu" (root cause bug running-state).
# Idempotent: sau crash + auto-restart, server vẫn chiếm port → skip.
def _autostart_servers():
    if not config.get("projects_on_boot", True):
        debug_log("_autostart_servers: disabled (projects_on_boot=false)")
        return
    started, skipped = [], []
    for p in config["projects"]:
        if not p.get("start_on_launch"):
            continue
        if _is_project_port_busy(p):
            skipped.append(f"{p['name']} (port {p.get('port')} busy)")
            continue
        try:
            res = _start_project(p)
            if res.get("status") == "started":
                started.append(p["name"])
            else:
                skipped.append(f"{p['name']} ({res.get('error', 'fail')})")
        except Exception as e:
            skipped.append(f"{p['name']} ({e})")
    if started or skipped:
        debug_log(f"_autostart_servers: started={started} skipped={skipped}")

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
            # WHY: Ghi version vào debug.log mỗi lần boot — Log tab hiển thị được
            # version app đang chạy, tránh nhầm lẫn khi kiểm tra bug trên bản cũ.
            debug_log(f"[app] MultiTool Pro v1.11.4 started (attempt {restart_count + 1})")
            # WHY: Khôi phục projects start_on_launch — chạy TRƯỚC app.run (chặn
            # /api/projects trả running sau khi auto-start). Idempotent: server đã
            # chạy sẵn trên port → skip.
            try:
                _autostart_servers()
            except Exception as e:
                debug_log(f"_autostart_servers error: {e}")
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
