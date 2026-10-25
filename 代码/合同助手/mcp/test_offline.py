"""Exercise the actual compiled stdio MCP using only synthetic local data.

python test_offline.py --exe ../desktop/out/development/合同助手MCP.exe
The process always receives an isolated data/output directory; no user settings,
model, mail account or WeChat service is used.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import queue
import subprocess
import threading
from xml.etree import ElementTree as ET
from zipfile import ZipFile


class Client:
    def __init__(self, exe: Path, folder: Path, desktop_exe: Path | None = None, data_dir: str | None = None):
        self.responses = queue.Queue()
        self.counter = 0
        self.process = subprocess.Popen(
            [str(exe), "--data-dir", data_dir or str(folder / "data"), "--output-dir", str(folder / "generated"), *(["--desktop-exe", str(desktop_exe)] if desktop_exe else [])],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            encoding="utf-8", creationflags=subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0,
        )
        def collect():
            for line in self.process.stdout:
                self.responses.put(json.loads(line.lstrip("\ufeff")))
        self.reader = threading.Thread(target=collect, daemon=True)
        self.reader.start()

    def call(self, method: str, params: dict | None = None, notification: bool = False):
        message = {"jsonrpc": "2.0", "method": method, "params": params or {}}
        if not notification:
            self.counter += 1
            message["id"] = self.counter
        self.process.stdin.write(json.dumps(message, ensure_ascii=False) + "\n")
        self.process.stdin.flush()
        if notification:
            return None
        result = self.responses.get(timeout=10)
        assert result["id"] == self.counter, result
        return result

    def tool(self, name: str, arguments: dict):
        response = self.call("tools/call", {"name": name, "arguments": arguments})
        assert "error" not in response, response
        result = response["result"]
        data = result.get("structuredContent")
        if data is None:
            data = json.loads(result["content"][0]["text"])
        return result.get("isError", False), data

    def close(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=5)
            raise
        assert self.process.returncode == 0, self.process.stderr.read()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--exe", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    exe = args.exe.resolve(strict=True)
    folder = (args.output or exe.parent / "offline-mcp-qa").resolve()
    folder.mkdir(parents=True, exist_ok=True)
    client = Client(exe, folder)
    checks = []
    try:
        init = client.call("initialize", {"protocolVersion": "2099-01-01", "capabilities": {}, "clientInfo": {"name": "assistant-offline-test", "version": "1"}})
        assert init["result"]["protocolVersion"] != "2099-01-01"
        client.call("notifications/initialized", notification=True)
        checks.append("MCP handshake negotiates a supported revision")
        tool_list = client.call("tools/list")["result"]["tools"]
        assert {"preview_contract", "generate_contract", "get_contract_schema"} <= {t["name"] for t in tool_list}
        failed, schema = client.tool("get_contract_schema", {})
        assert not failed and "甲方名称" in schema["required_fields"] and schema["locked_fields"] == {}
        checks.append("tool discovery and generic-template schema")
        assets = Path(__file__).resolve().parents[1] / "desktop" / "assets"
        sample = json.loads((assets / "sample.json").read_text(encoding="utf-8"))
        failed, preview = client.tool("preview_contract", {"contract": sample, "use_common_info": False})
        assert not failed and preview["ready"] and not preview["errors"] and preview["total"] == "50.01", preview
        assert [p["amount"] for p in preview["payment_amounts"]] == ["15.00", "35.01"]
        assert preview["contract"]["template_id"]
        checks.append("actual preview: decimal quantities, line rounding, total, payment remainder, template identity")
        payload = {"contract": preview["contract"], "use_common_info": False, "output_name": "synthetic-contract"}
        failed, generated = client.tool("generate_contract", payload)
        assert not failed, generated
        document = Path(generated["docx_path"])
        assert document.is_file() and Path(generated["progress_path"]).is_file(), generated
        assert document.is_relative_to(folder)
        with ZipFile(document) as package:
            xml = ET.fromstring(package.read("word/document.xml"))
        text = "".join(xml.itertext())
        assert "{{" not in text and "50.01" in text and "DEMO-A" in text and "DEMO-B" in text
        checks.append("real Word and progress files generated with filled XML")
        failed, again = client.tool("generate_contract", payload)
        assert not failed and again["docx_path"] != str(document) and document.is_file()
        checks.append("repeated generation never overwrites prior output")
        invalid = json.loads(json.dumps(sample))
        invalid["payments"][1]["ratio"] = "60"
        failed, invalid_preview = client.tool("preview_contract", {"contract": invalid, "use_common_info": False})
        assert not failed and not invalid_preview["ready"] and invalid_preview["errors"]
        failed, invalid_generate = client.tool("generate_contract", {"contract": invalid, "use_common_info": False})
        assert failed, invalid_generate
        checks.append("invalid payment preview is not ready; generation returns isError")
        data_root = folder / "data"
        assert (data_root / "Library").is_dir()
        checks.append("library and generated data stay in explicit test directories")
    finally:
        client.close()
    report = {"passed": True, "mode": "actual-exe-offline-synthetic", "checks": checks, "liveAiTested": False, "realTemplateTested": False, "wordLayoutVisuallyTested": False}
    (folder / "offline-mcp-results.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
