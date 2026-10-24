"""Offline regression for bridge failures, negotiation and bounded file reads.

Run: python tests/pcbridge_regression.py
No bridge config, service, real account, network or model is used.
"""
from __future__ import annotations

import importlib.util
import io
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "代码" / "pcbridge" / "mcp_dsh_server.py"
spec = importlib.util.spec_from_file_location("pcbridge_tested", SOURCE)
bridge = importlib.util.module_from_spec(spec)
with patch("subprocess.run", side_effect=AssertionError("unexpected process")), \
     patch("urllib.request.urlopen", side_effect=AssertionError("unexpected network")):
    spec.loader.exec_module(bridge)


class BridgeRegression(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="assistant-pcbridge-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.cfg = {**bridge.DEFAULT_CONFIG, "workspace_root": str(self.root), "max_output_chars": 10000}
        # Fail closed if an unintended code path attempts a real action.
        for name in ("run_capture", "wechat_hook_send_text", "wechat_hook_send_image", "wechat_push_text"):
            blocker = patch.object(bridge, name, side_effect=AssertionError("unexpected external action"))
            blocker.start()
            self.addCleanup(blocker.stop)

    def call(self, name, **arguments):
        return bridge.call_tool({"name": name, "arguments": arguments}, self.cfg)

    def test_missing_runtime_is_tool_error(self):
        with patch.object(bridge, "DSH_CMD", None):
            result = self.call("run_local_agent", task="offline fixture")
        self.assertTrue(result["isError"])
        self.assertIn("没找到 dsh", result["content"][0]["text"])

    def test_disabled_shell_is_tool_error(self):
        self.assertTrue(self.call("run_local_shell", command="must not run")["isError"])

    def test_known_input_failures_are_not_success(self):
        for name, arguments in [
            ("list_local_dir", {"path": "absent"}),
            ("read_local_file", {"path": "absent"}),
            ("export_file", {"path": "absent"}),
            ("send_image", {"path": "absent"}),
            ("ask_gpt", {"prompt": ""}),
            ("gpt_draw", {"prompt": ""}),
            ("fetch_paper", {"query": ""}),
            ("fetch_player_stats", {"category": "unsupported"}),
            ("fetch_scores", {"sport": "unsupported"}),
            ("screenshot_url", {"url": ""}),
            ("read_web_page", {"url": ""}),
            ("local_agent_status", {"job_id": "absent"}),
        ]:
            with self.subTest(name=name):
                self.assertTrue(self.call(name, **arguments)["isError"])

    def test_invalid_arguments_and_unknown_tool(self):
        self.assertTrue(bridge.call_tool({"name": "read_local_file", "arguments": [1]}, self.cfg)["isError"])
        self.assertTrue(self.call("missing")["isError"])

    def test_failed_job_is_error_even_if_already_pushed(self):
        job = bridge.Job("offline", 10, self.cfg)
        job.result = {"ok": False, "stdout": "", "stderr": "fixture failure", "elapsed": 0, "code": 1}
        job.done.set()
        job.pushed = True
        with patch.dict(bridge.JOBS, {job.id: job}, clear=True):
            result = self.call("local_agent_status", job_id=job.id)
        self.assertTrue(result["isError"])
        self.assertIn("fixture failure", result["content"][0]["text"])

    def test_protocol_does_not_echo_unknown_version(self):
        for wanted in ("2099-01-01", "2025-03-26", None):
            response = bridge.handle_rpc({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": wanted}}, self.cfg)
            self.assertEqual(response["result"]["protocolVersion"], "2025-03-26")

    def test_bounded_read_uses_requested_stream_limit(self):
        target = self.root / "large.txt"
        with target.open("wb") as stream:
            stream.write(b"bounded fixture\n")
            stream.seek(4 * 1024 * 1024)
            stream.write(b"x")
        calls = []
        real_open = Path.open

        class TrackedStream:
            def __init__(self, stream): self.stream = stream
            def __enter__(self): self.stream.__enter__(); return self
            def __exit__(self, *args): return self.stream.__exit__(*args)
            def read(self, size): calls.append(size); return self.stream.read(size)
            def fileno(self): return self.stream.fileno()

        def tracked_open(path, *args, **kwargs):
            return TrackedStream(real_open(path, *args, **kwargs))

        with patch.object(Path, "open", tracked_open), \
             patch.object(Path, "read_bytes", side_effect=AssertionError("unbounded read")):
            result = self.call("read_local_file", path="large.txt", max_bytes=16)
        self.assertFalse(result["isError"])
        self.assertEqual(calls, [16])
        self.assertIn("4,194,305 B", result["content"][0]["text"])

    def test_invalid_read_limits_rejected_before_open(self):
        for value in (-1, 0, 1024 * 1024 + 1, True, "16", 1.5, None):
            with self.subTest(value=value), patch.object(Path, "open", side_effect=AssertionError("must not read")):
                self.assertTrue(self.call("read_local_file", path="absent", max_bytes=value)["isError"])

    def test_binary_rejected_and_bom_text_supported(self):
        (self.root / "binary.dat").write_bytes(b"binary\x00fixture")
        self.assertTrue(self.call("read_local_file", path="binary.dat")["isError"])
        (self.root / "utf16.txt").write_bytes("测试内容".encode("utf-16"))
        result = self.call("read_local_file", path="utf16.txt")
        self.assertFalse(result["isError"])
        self.assertIn("测试内容", result["content"][0]["text"])

    def test_normal_read_and_write_remain_success(self):
        self.assertFalse(self.call("write_local_file", path="hello.txt", content="你好")["isError"])
        self.assertIn("你好", self.call("read_local_file", path="hello.txt")["content"][0]["text"])

    def test_web_and_screenshot_business_failures(self):
        with patch.object(bridge, "read_web_page", return_value={"ok": False, "error": "offline failure"}):
            self.assertTrue(self.call("read_web_page", url="https://example.test")["isError"])
        with patch.object(bridge, "screenshot_url", return_value={"ok": False, "error": "offline failure"}):
            self.assertTrue(self.call("screenshot_url", url="https://example.test")["isError"])

    def test_window_blank_does_not_claim_image_sent(self):
        (self.root / "synthetic.png").write_bytes(b"not an actual image; no sender invoked")
        self.cfg.update(wechat_hook_image=False, wechat_native_image=True)
        with patch.object(bridge, "_pick_target", return_value="私聊"), \
             patch.object(bridge, "resolve_target_chat", return_value=("fixture-owner", "主人私聊")), \
             patch.object(bridge, "wechat_send_native", return_value="__WINDOW_BLANK__"):
            self.cfg["wechat_target_wxid"] = "fixture-owner"
            result = self.call("send_image", path="synthetic.png")
        self.assertTrue(result["isError"])
        self.assertNotIn("图片已经在微信里了", result["content"][0]["text"])

    def test_unverified_send_is_error_without_automatic_retry(self):
        (self.root / "fixture.txt").write_text("offline fixture", encoding="utf-8")
        with patch.object(bridge, "_pick_target", return_value="私聊"), \
             patch.object(bridge, "resolve_target_chat", return_value=("fixture-owner", "主人私聊")), \
             patch.object(bridge, "_send_file_verified", return_value=("unverified", "no receipt")) as sender:
            self.cfg["wechat_target_wxid"] = "fixture-owner"
            result = self.call("export_file", path="fixture.txt")
        self.assertTrue(result["isError"])
        self.assertEqual(sender.call_count, 1)
        self.assertIn("请勿自动重发", result["content"][0]["text"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
