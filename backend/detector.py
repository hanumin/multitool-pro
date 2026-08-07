# WHY: Auto-detect framework + dev command + port cho 1 project path.
# Tham khảo: PortPilot (src/main/projectScanner.js — script priority, regex port,
# confidence hằng số theo nhánh), dev-dashboard (lib.rs — dependency table +
# file markers + Python detection), check-dev-services (regex extract path).
import json
import re
from pathlib import Path

# Bảng dependency ưu tiên (key → framework, confidence) — framework đầu khớp thắng.
NODE_FRAMEWORKS = [
    ("next", "Next.js", 0.95),
    ("remix", "Remix", 0.90),
    ("nuxt", "Nuxt", 0.90),
    ("sveltekit", "SvelteKit", 0.90),
    ("astro", "Astro", 0.90),
    ("gatsby", "Gatsby", 0.85),
    ("angular", "Angular", 0.85),
    ("vue", "Vue", 0.80),
    ("react-scripts", "Create React App", 0.85),
    ("react", "React (Vite)", 0.75),
    ("vite", "Vite", 0.70),
    ("nest", "NestJS", 0.90),
    ("express", "Express", 0.90),
    ("fastify", "Fastify", 0.90),
    ("hono", "Hono", 0.85),
    ("koa", "Koa", 0.85),
]

# Script priority (PortPilot): dev → start → serve → web → app.
SCRIPT_PRIORITY = ["dev", "start", "serve", "web", "app"]

# Suggested port per framework — chỉ dùng khi KHÔNG tìm thấy port explicit
# (script --port / PORT= / config file). Triết lý PortPilot: explicit trước,
# default sau (tránh mọi thứ thành 3000).
SUGGESTED_PORTS = {
    "Next.js": 3000, "Remix": 3000, "Nuxt": 3000, "SvelteKit": 5173,
    "Astro": 4321, "Gatsby": 8000, "Angular": 4200, "Vue": 5173,
    "Create React App": 3000, "React (Vite)": 5173, "Vite": 5173,
    "NestJS": 3000, "Express": 3000, "Fastify": 3000, "Hono": 3000,
    "Koa": 3000, "Django": 8000, "FastAPI": 8000, "Flask": 5000,
}

# Monorepo: thư mục con quen thuộc chứa package.json khi root không có.
MONOREPO_SUBDIRS = ("web", "frontend", "app", "client")


# WHY: Xác định package manager theo lockfile (pnpm > yarn > bun > npm).
def _get_package_manager(path: Path):
    if (path / "pnpm-lock.yaml").exists() or (path / "pnpm-workspace.yaml").exists():
        return "pnpm"
    if (path / "yarn.lock").exists():
        return "yarn"
    if (path / "bun.lockb").exists() or (path / "bun.lock").exists():
        return "bun"
    return "npm"


# WHY: Trích port explicit từ script qua regex (--port / PORT= / -p) —
# explicit port trong script thắng mọi default khác.
def _extract_port_from_script(script: str):
    m = re.search(r"(?:--port|PORT)[\s=]*(\d{2,5})", script)
    if m:
        return int(m.group(1))
    m = re.search(r"-p[\s=]*(\d{2,5})", script)
    if m:
        return int(m.group(1))
    return None


# WHY: Trích port từ vite config (.ts/.js/.mjs) + .env PORT — regex, không
# parse JS (pattern PortPilot). Explicit port ưu tiên trước default framework.
def _extract_port_from_config(path: Path):
    # vite config: port: 3000 (regex, không parse JS — pattern PortPilot)
    for cfg in ("vite.config.ts", "vite.config.js", "vite.config.mjs"):
        p = path / cfg
        if p.exists():
            m = re.search(r"port:\s*(\d{2,5})", p.read_text(encoding="utf-8", errors="replace"))
            if m:
                return int(m.group(1))
    # .env: PORT=3000
    for env in (".env", ".env.local", ".env.development"):
        p = path / env
        if p.exists():
            m = re.search(r"^PORT\s*=\s*(\d{2,5})", p.read_text(encoding="utf-8", errors="replace"), re.MULTILINE)
            if m:
                return int(m.group(1))
    return None


# WHY: Chọn script dev theo priority: dev > start > serve > web > app,
# fallback script có tên chứa dev/start/serve.
def _pick_script(scripts):
    for key in SCRIPT_PRIORITY:
        if key in scripts:
            return key, scripts[key]
    for key, val in scripts.items():
        if "dev" in key or "start" in key or "serve" in key:
            return key, val
    return None, None


# WHY: Detect Node project — dependency table (framework đầu trúng thắng) +
# script priority + chain port (script → config → suggested default).
def _detect_node(path: Path):
    pkg = path / "package.json"
    if not pkg.exists():
        return None
    try:
        data = json.loads(pkg.read_text(encoding="utf-8", errors="replace"))
    except Exception:
        data = {}
    scripts = data.get("scripts") or {}
    deps = {**data.get("dependencies", {}), **data.get("devDependencies", {})}

    framework, confidence = None, 0.0
    for key, fw, conf in NODE_FRAMEWORKS:
        if key in deps:
            framework, confidence = fw, conf
            break

    script_key, script = _pick_script(scripts)
    pm = _get_package_manager(path)
    command = f"{pm} run {script_key}" if script_key else "npm run dev"

    port = _extract_port_from_script(script) if script else None
    if port is None:
        port = _extract_port_from_config(path)
    if port is None and framework:
        port = SUGGESTED_PORTS.get(framework)

    return {
        "name": data.get("name") or path.name,
        "path": str(path),
        "framework": framework or "Node.js",
        "command": command,
        "port": port,
        "suggested_port": port,
        "package_manager": pm,
        "confidence": confidence if confidence > 0 else 0.5,
        "language": "node",
    }


# WHY: Detect Python project — marker manage.py → Django, requirements.txt /
# pyproject.toml → FastAPI/Flask, cuối cùng fallback app.py.
def _detect_python(path: Path):
    # Django marker (dev-dashboard): manage.py
    if (path / "manage.py").exists():
        return {"name": path.name, "path": str(path), "framework": "Django",
                "command": "python manage.py runserver", "port": 8000, "suggested_port": 8000,
                "package_manager": None, "confidence": 0.90, "language": "python"}
    # requirements.txt / pyproject.toml
    req = path / "requirements.txt"
    text = ""
    if req.exists():
        text = req.read_text(encoding="utf-8", errors="replace").lower()
    else:
        pyproj = path / "pyproject.toml"
        if pyproj.exists():
            text = pyproj.read_text(encoding="utf-8", errors="replace").lower()
    if text:
        if "django" in text:
            fw, cmd, port, conf = "Django", "python manage.py runserver", 8000, 0.90
        elif "fastapi" in text or "uvicorn" in text:
            fw, cmd, port, conf = "FastAPI", "uvicorn main:app --reload", 8000, 0.85
        elif "flask" in text:
            fw, cmd, port, conf = "Flask", "python app.py", 5000, 0.85
        else:
            fw, cmd, port, conf = "Python", "python app.py", 8000, 0.60
        return {"name": path.name, "path": str(path), "framework": fw,
                "command": cmd, "port": port, "suggested_port": port,
                "package_manager": None, "confidence": conf, "language": "python"}
    if (path / "app.py").exists():
        return {"name": path.name, "path": str(path), "framework": "Python",
                "command": "python app.py", "port": 5000, "suggested_port": 5000,
                "package_manager": None, "confidence": 0.50, "language": "python"}
    return None


# WHY: Entry point — detect folder (Node → Python); fallback monorepo subdir
# (web/frontend/app/client) khi root không có marker.
def detect_project(path_str):
    """Detect framework + command + port cho 1 folder.
    Trả về dict hoặc None nếu không phải project dev (không có marker nào)."""
    path = Path(path_str)
    if not path.is_dir():
        return None

    result = _detect_node(path)
    if result:
        return result
    result = _detect_python(path)
    if result:
        return result

    # Monorepo: root không có package.json → quét subfolder quen thuộc
    for sub in MONOREPO_SUBDIRS:
        sub_path = path / sub
        if sub_path.is_dir() and (sub_path / "package.json").exists():
            result = detect_project(str(sub_path))
            if result:
                result["name"] = f"{path.name} ({sub})"
                return result
    return None
