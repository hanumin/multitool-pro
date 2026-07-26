#!/usr/bin/env python3
"""
check-why-comments.py -- Quet codebase de tim function/useCallback
thieu // WHY: hoac # WHY: comment.

Usage:
    python scripts/check-why-comments.py                        # Quet tat ca
    python scripts/check-why-comments.py --include backend      # Chi backend
    python scripts/check-why-comments.py --include frontend     # Chi frontend
    python scripts/check-why-comments.py --verbose              # Show chi tiet
    python scripts/check-why-comments.py --exit-error           # Exit code 1 neu co thieu
    python scripts/check-why-comments.py --stats                # Chi show thong ke

Output: Danh sach function chua co WHY comment theo tung file.
"""

import os
import re
import sys
from pathlib import Path
from typing import List, Dict, Tuple

# Fix Windows console encoding
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except AttributeError:
        pass

# ─── CONFIG ─────────────────────────────────────────────────────
PROJECT_ROOT = Path(__file__).resolve().parent.parent

SCAN_CONFIG = {
    "backend": {
        "patterns": ["backend/**/*.py"],
        "comment_prefix": "# WHY:",
        "func_regex": re.compile(r'^\s*def\s+(\w+)\s*\('),
        "skip_funcs": {
            "_reader", "_report_progress", "generate", "safe_delete",
            "parse_app",
        },
        # Chi skip magic methods (__init__, __str__) va test functions.
        # KHONG skip _private functions — user co the da them WHY cho chung.
        "skip_prefixes": {"test_", "__"},
    },
    "frontend": {
        "patterns": ["src/**/*.ts", "src/**/*.tsx"],
        "comment_prefix": "// WHY:",
        "func_regex": re.compile(
            r'^\s*(export\s+default\s+)?function\s+(\w+)\s*\('
            r'|^\s*const\s+(\w+)\s*=\s*(async\s+)?\([^)]*\)\s*=>'
            r'|^\s*const\s+(\w+)\s*=\s*useCallback\s*\('
        ),
        "skip_funcs": {"autoSelectDefault"},
        "skip_prefixes": {"use"},
    },
}


def get_scan_files(config_key: str) -> List[Path]:
    """Lay danh sach file can scan theo glob pattern."""
    config = SCAN_CONFIG[config_key]
    files = []
    for pattern in config["patterns"]:
        matched = list(Path(PROJECT_ROOT).glob(pattern.replace("\\", "/")))
        files.extend(matched)
    exclude_dirs = {"node_modules", ".git", "dist", "__pycache__", ".venv", "venv"}
    return [
        f for f in sorted(set(files))
        if f.is_file() and not any(
            part in f.parts for part in exclude_dirs
        )
    ]


def extract_functions(content: str, config_key: str) -> List[Tuple[int, str, int]]:
    """
    Tim tat ca function definitions trong file content.
    Returns: List of (line_number, func_name, start_line_1indexed)
    """
    config = SCAN_CONFIG[config_key]
    functions = []
    lines = content.split('\n')

    for i, line in enumerate(lines):
        match = config["func_regex"].search(line)
        if not match:
            continue

        func_name = None
        for g in match.groups():
            if g:
                func_name = g
                break

        if not func_name:
            continue

        if func_name in config["skip_funcs"]:
            continue

        if any(func_name.startswith(p) for p in config["skip_prefixes"]):
            continue

        functions.append((i + 1, func_name, i))

    return functions


def has_why_comment(lines: List[str], func_line_idx: int, config_key: str) -> bool:
    """Kiem tra function co WHY comment trong 5 dong truoc no khong."""
    config = SCAN_CONFIG[config_key]
    prefix = config["comment_prefix"]

    start = max(0, func_line_idx - 5)
    preceding = lines[start:func_line_idx]

    for line in preceding:
        stripped = line.strip()
        if prefix in stripped:
            return True
    return False


def format_report(all_missing: Dict[str, List[Dict]], verbose: bool = False) -> str:
    """Format ket qua thanh bao cao."""
    lines_out = []
    total_missing = 0
    total_files_with_issues = 0

    for filepath in sorted(all_missing.keys()):
        funcs = all_missing[filepath]
        if not funcs:
            continue

        total_files_with_issues += 1
        total_missing += len(funcs)

        rel_path = os.path.relpath(filepath, str(PROJECT_ROOT))
        lines_out.append(f"\n{'='*60}")
        lines_out.append(f"  >> {rel_path}  ({len(funcs)} missing)")
        lines_out.append(f"{'='*60}")

        for f in funcs:
            if verbose:
                lines_out.append(f"  L{f['line']:>5}  {f['name']:<35}  {f['context']}")
            else:
                lines_out.append(f"  L{f['line']:>5}  {f['name']}")

    lines_out.append(f"\n{'='*60}")
    lines_out.append(f"  SUMMARY")
    lines_out.append(f"{'='*60}")
    lines_out.append(f"  Files with issues: {total_files_with_issues}")
    lines_out.append(f"  Functions missing: {total_missing}")

    return '\n'.join(lines_out)


def format_stats(all_stats: Dict[str, Dict]) -> str:
    """Format thong ke WHY coverage."""
    lines_out = [
        f"\n{'='*60}",
        f"  WHY COMMENTS COVERAGE",
        f"{'='*60}",
        f"  {'File':<45} {'Total':>6} {'WHY':>6} {'%':>6}",
        f"  {'-'*45} {'-'*6} {'-'*6} {'-'*6}",
    ]

    total_funcs = 0
    total_why = 0

    for filepath in sorted(all_stats.keys()):
        stats = all_stats[filepath]
        total_funcs += stats["total"]
        total_why += stats["with_why"]
        rel_path = os.path.relpath(filepath, str(PROJECT_ROOT))
        pct = f"{stats['pct']:.0f}%" if stats["total"] > 0 else "-"
        lines_out.append(
            f"  {rel_path:<45} {stats['total']:>6} {stats['with_why']:>6} {pct:>6}"
        )

    lines_out.append(f"  {'-'*45} {'-'*6} {'-'*6} {'-'*6}")
    overall_pct = f"{total_why/total_funcs*100:.0f}%" if total_funcs > 0 else "-"
    lines_out.append(f"  {'TOTAL':<45} {total_funcs:>6} {total_why:>6} {overall_pct:>6}")

    return '\n'.join(lines_out)


def main():
    scan_backend = True
    scan_frontend = True
    verbose = False
    exit_error = False
    show_missing = True
    show_stats = False

    for arg in sys.argv[1:]:
        if arg == "--include":
            idx = sys.argv.index(arg) + 1
            if idx < len(sys.argv):
                val = sys.argv[idx]
                if val == "backend":
                    scan_frontend = False
                elif val == "frontend":
                    scan_backend = False
        elif arg == "--verbose":
            verbose = True
        elif arg == "--exit-error":
            exit_error = True
        elif arg == "--stats":
            show_stats = True
            show_missing = False
        elif arg == "--help" or arg == "-h":
            print(__doc__)
            return

    all_missing = {}
    all_stats = {}

    # Cache content de tranh doc file 2 lan (cho missing + stats)
    def scan_and_stats(fp, config_key):
        try:
            content = fp.read_text(encoding='utf-8', errors='replace')
        except Exception as e:
            print(f"  [ERROR] Cannot read {fp}: {e}", file=sys.stderr)
            return [], {}
        lines = content.split('\n')
        
        all_funcs = extract_functions(content, config_key)
        missing = []
        for line_no, func_name, line_idx in all_funcs:
            if not has_why_comment(lines, line_idx, config_key):
                missing.append({
                    "line": line_no,
                    "name": func_name,
                    "context": lines[line_idx].strip()[:100],
                })
        
        with_why = len(all_funcs) - len(missing)
        stats = {}
        if all_funcs:
            stats = {
                "total": len(all_funcs),
                "with_why": with_why,
                "pct": with_why / len(all_funcs) * 100 if all_funcs else 0,
            }
        return missing, stats

    if scan_backend:
        for fp in get_scan_files("backend"):
            missing, stats = scan_and_stats(fp, "backend")
            if missing:
                all_missing[str(fp)] = missing
            if stats:
                all_stats[str(fp)] = stats

    if scan_frontend:
        for fp in get_scan_files("frontend"):
            missing, stats = scan_and_stats(fp, "frontend")
            if missing:
                all_missing[str(fp)] = missing
            if stats:
                all_stats[str(fp)] = stats

    if show_missing:
        report = format_report(all_missing, verbose)
        print(report)

    if show_stats:
        stats = format_stats(all_stats)
        print(stats)

    total_missing = sum(len(v) for v in all_missing.values())

    if exit_error and total_missing > 0:
        sys.exit(1)

    # Summary
    total_funcs_all = sum(v['total'] for v in all_stats.values())
    if total_missing == 0:
        print(f"\n[OK] All {total_funcs_all} functions have WHY comments!")
    else:
        print(f"\n[WARN] {total_missing}/{total_funcs_all} functions missing WHY comments. Use --verbose for details.")


if __name__ == "__main__":
    main()
