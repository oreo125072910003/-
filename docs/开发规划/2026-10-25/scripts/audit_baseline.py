"""Read-only baseline checks; runs no project imports, services, models or network calls."""
from __future__ import annotations

import ast
import concurrent.futures
import datetime as dt
import json
from pathlib import Path
import shutil
import subprocess
import time
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[4]
REPORTS = Path(__file__).resolve().parents[1] / "evidence"


def git(*args: str) -> str:
    return subprocess.check_output(["git", "-C", str(ROOT), *args], encoding="utf-8")


def isolated_functions(source: Path, names: set[str], bindings: dict) -> dict:
    tree = ast.parse(source.read_text(encoding="utf-8-sig"))
    selected = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
    assert len(selected) == len(names)
    namespace = dict(bindings)
    exec(compile(ast.Module(body=selected, type_ignores=[]), str(source), "exec"), namespace)
    return namespace


def check_node(file: Path, node: str) -> dict:
    result = subprocess.run([node, "--check", str(file)], capture_output=True, text=True,
                            encoding="utf-8", errors="replace", timeout=30)
    return {"path": file.relative_to(ROOT).as_posix(), "ok": result.returncode == 0,
            **({"diagnostic": result.stderr[:2000]} if result.returncode else {})}


def main() -> None:
    tracked = [ROOT / p for p in git("-c", "core.quotePath=false", "ls-files", "-z").split("\0") if p]
    included = [p for p in tracked if p.relative_to(ROOT).parts[:2] in
                [("代码", "项目"), ("代码", "pcbridge"), ("代码", "合同助手")]]
    node = shutil.which("node")
    js_files = [p for p in included if p.suffix in {".js", ".mjs", ".cjs"}
                and p.name != "jszip.min.js"]
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        js_results = list(pool.map(lambda p: check_node(p, node), js_files)) if node else []
    py_results = []
    for file in [p for p in included if p.suffix == ".py"]:
        try:
            ast.parse(file.read_text(encoding="utf-8-sig"), filename=str(file))
            py_results.append({"path": file.relative_to(ROOT).as_posix(), "ok": True})
        except (SyntaxError, UnicodeError) as exc:
            py_results.append({"path": file.relative_to(ROOT).as_posix(), "ok": False, "diagnostic": str(exc)})

    bridge = ROOT / "代码/pcbridge/mcp_dsh_server.py"
    ns = isolated_functions(bridge, {"call_tool", "handle_rpc", "rpc_error"},
                            {"TOOL_HANDLERS": {"demo_failure": lambda args, cfg: "❌ 执行失败"},
                             "time": time, "SERVER_NAME": "isolated-audit", "SERVER_VERSION": "audit"})
    failed = ns["call_tool"]({"name": "demo_failure", "arguments": {}}, {})
    negotiated = ns["handle_rpc"]({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                                   "params": {"protocolVersion": "2099-01-01"}}, {})
    seen_urls = []

    def mock_fetch(url: str, cfg: dict):
        seen_urls.append(url)
        return url, "mock body"

    web_ns = isolated_functions(bridge, {"read_web_page"},
                                {"urlparse": urlparse, "_fetch_webpage": mock_fetch,
                                 "_browser_dom": mock_fetch,
                                 "_strip_html": lambda body: ("Mock", "A" * 80)})
    fetched = web_ns["read_web_page"]("http://127.0.0.1:9876/private", {})
    reads = []

    class FakeFile:
        def is_file(self):
            return True

        def read_bytes(self):
            reads.append(1024 * 1024)
            return b"A" * (1024 * 1024)

        def stat(self):
            return type("Stat", (), {"st_size": 1024 * 1024})()

        def __str__(self):
            return "FAKE_FILE"

    file_ns = isolated_functions(bridge, {"tool_read_file"},
                                 {"resolve_path": lambda raw, cfg: FakeFile(),
                                  "decode_text": lambda raw: raw.decode(),
                                  "truncate": lambda text, cap: text[:cap]})
    file_ns["tool_read_file"]({"path": "fake", "max_bytes": 16}, {"max_output_chars": 300})
    desktop = ROOT / "代码/合同助手/desktop"
    required = ["build.ps1", "ContractEngine.cs", "TemplateRules.cs", "AiService.cs", "BatchImport.cs",
                "ContractLibrary.cs", "MaterialCatalog.cs", "MaterialImport.cs", "Preferences.cs", "EmbeddedContent.cs"]
    report = {
        "checked_at": dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).isoformat(),
        "commit": git("rev-parse", "HEAD").strip(),
        "scope": "tracked primary project, pcbridge and contract-helper; historical installation copy excluded",
        "mode": "syntax + isolated function reproduction; no project imports/services/network/model calls",
        "node_version": subprocess.check_output([node, "--version"], text=True).strip() if node else None,
        "js_syntax": {"checked": len(js_results), "passed": sum(r["ok"] for r in js_results),
                      "failed": [r for r in js_results if not r["ok"]]},
        "python_ast": {"checked": len(py_results), "passed": sum(r["ok"] for r in py_results),
                       "failed": [r for r in py_results if not r["ok"]]},
        "reproductions": {
            "R01_failure_string_not_error": {"observed_isError": failed["isError"],
                                               "expected_isError_for_failure": True,
                                               "reproduced": failed["isError"] is False},
            "R02_unsupported_protocol_echo": {"requested": "2099-01-01",
                                               "returned": negotiated["result"]["protocolVersion"],
                                               "reproduced": negotiated["result"]["protocolVersion"] == "2099-01-01"},
            "R03_loopback_url_passes_validation": {"network_was_mocked": True, "observed_urls": seen_urls,
                                                     "returned_ok": fetched["ok"],
                                                     "reproduced": bool(seen_urls) and fetched["ok"]},
            "R04_read_limit_applied_after_full_read": {"fake_file_bytes_read": reads[0], "requested_limit": 16,
                                                       "reproduced": reads[0] > 16},
        },
        "contract_build_prerequisites": {"desktop_directory_exists": desktop.exists(),
                                           "missing": [name for name in required if not (desktop / name).is_file()]},
        "not_tested": ["Windows EXE build", "live WeChat send/receive", "live mail accounts",
                       "installed Harness SDK compatibility", "contract build or business accuracy",
                       "MCP interoperability", "end-to-end task recovery", "security penetration test"],
    }
    REPORTS.mkdir(parents=True, exist_ok=True)
    (REPORTS / "baseline.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"commit": report["commit"], "js": report["js_syntax"], "python": report["python_ast"],
                      "reproductions": {k: v["reproduced"] for k, v in report["reproductions"].items()},
                      "contract_missing": report["contract_build_prerequisites"]["missing"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
