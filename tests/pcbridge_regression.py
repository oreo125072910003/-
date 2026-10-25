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
import time
import json
import http.client
from http.server import ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
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
        self.cfg = {**bridge.DEFAULT_CONFIG, "workspace_root": str(self.root), "max_output_chars": 10000,
                    "delivery_outbox": str(self.root / "outbox.sqlite3")}
        # Fail closed if an unintended code path attempts a real action.
        for name in ("run_capture", "wechat_hook_send_text", "wechat_hook_send_image", "wechat_push_text"):
            blocker = patch.object(bridge, name, side_effect=AssertionError("unexpected external action"))
            blocker.start()
            self.addCleanup(blocker.stop)

    def call(self, name, **arguments):
        return bridge.call_tool({"name": name, "arguments": arguments}, self.cfg)

    def test_control_denied_before_runtime_detection(self):
        with patch.object(bridge, "DSH_CMD", None):
            result = self.call("run_local_agent", task="offline fixture")
        self.assertTrue(result["isError"])
        self.assertIn("LEGACY_CONTROL_CONTEXT_UNAVAILABLE", result["content"][0]["text"])

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
        self.assertIn("LEGACY_CONTROL_CONTEXT_UNAVAILABLE", result["content"][0]["text"])
        with self.assertRaisesRegex(bridge.ToolExecutionError, "fixture failure"):
            bridge.job_tool_result(job, self.cfg)

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
            result = bridge._read_workspace_file({"path": "large.txt", "max_bytes": 16}, self.cfg)
        self.assertEqual(calls, [16])
        self.assertIn("4,194,305 B", result)

    def test_invalid_read_limits_rejected_before_open(self):
        for value in (-1, 0, 1024 * 1024 + 1, True, "16", 1.5, None):
            with self.subTest(value=value), patch.object(Path, "open", side_effect=AssertionError("must not read")):
                with self.assertRaises(ValueError):
                    bridge._read_workspace_file({"path": "absent", "max_bytes": value}, self.cfg)

    def test_binary_rejected_and_bom_text_supported(self):
        (self.root / "binary.dat").write_bytes(b"binary\x00fixture")
        with self.assertRaises(bridge.ToolExecutionError):
            bridge._read_workspace_file({"path": "binary.dat"}, self.cfg)
        (self.root / "utf16.txt").write_bytes("测试内容".encode("utf-16"))
        result = bridge._read_workspace_file({"path": "utf16.txt"}, self.cfg)
        self.assertIn("测试内容", result)

    def test_read_write_control_has_no_file_effect(self):
        target = self.root / "hello.txt"
        target.write_text("private sentinel", encoding="utf-8")
        self.assertTrue(self.call("write_local_file", path="hello.txt", content="overwrite")["isError"])
        result = self.call("read_local_file", path="hello.txt")
        self.assertTrue(result["isError"])
        self.assertNotIn("private sentinel", str(result))
        self.assertEqual(target.read_text(encoding="utf-8"), "private sentinel")

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

    def test_legacy_title_only_ui_cannot_submit_or_fallback(self):
        (self.root / "fixture.txt").write_text("offline fixture", encoding="utf-8")
        with patch.object(bridge, "_pick_target", return_value="私聊"), \
             patch.object(bridge, "resolve_target_chat", return_value=("fixture-owner", "主人私聊")), \
             patch.object(bridge, "_send_file_verified", return_value=("unverified", "no receipt")) as sender:
            self.cfg["wechat_target_wxid"] = "fixture-owner"
            result = self.call("export_file", path="fixture.txt")
        self.assertTrue(result["isError"])
        self.assertEqual(sender.call_count, 0)
        self.assertIn("LEGACY_CONTROL_CONTEXT_UNAVAILABLE", result["content"][0]["text"])


class LegacyControlBoundary(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="pcbridge-boundary-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.workspace = self.root / "workspace"
        self.workspace.mkdir()
        self.sentinel = self.root / "outside.txt"
        self.sentinel.write_text("OUTSIDE_SECRET_SENTINEL", encoding="utf-8")
        self.cfg = {**bridge.DEFAULT_CONFIG, "workspace_root": str(self.workspace),
                    "token": "fixture-service-token", "allow_shell": True,
                    "allow_outside_workspace": True, "control_enabled": True,
                    "gpt_draw_engine": "gpt", "delivery_outbox": str(self.root / "outbox.sqlite3")}
        self.arguments = {"path": str(self.sentinel), "content": "must-not-write",
                          "command": "must-not-run", "task": "must-not-start",
                          "account": "forged", "target": "forged", "target_kind": "private",
                          "request_id": "forged", "scope": {"computerControl": True},
                          "executionPolicy": {"computerControl": True}, "control_enabled": True}
        for name, value in (("SCRIPT_DIR", self.root), ("SHARED_DIR", self.root / "shared"), ("JOBS", {})):
            mock = patch.object(bridge, name, value); mock.start(); self.addCleanup(mock.stop)
        for name in ("run_capture", "wechat_hook_send_text", "wechat_hook_send_image",
                     "wechat_push_text", "_watch_job", "_codex_cmd", "_find_browser"):
            mock = patch.object(bridge, name, side_effect=AssertionError("unexpected control action"))
            mock.start(); self.addCleanup(mock.stop)
        for name in ("subprocess.run", "subprocess.Popen", "urllib.request.urlopen"):
            mock = patch(name, side_effect=AssertionError("unexpected process/network"))
            mock.start(); self.addCleanup(mock.stop)

    def call(self, name, arguments=None):
        return bridge.call_tool({"name": name, "arguments": arguments or {}}, self.cfg)

    def test_permissive_config_and_forged_claims_cannot_unlock_raw_calls(self):
        with patch.object(bridge, "resolve_path", side_effect=AssertionError("must not even inspect path")), \
             patch.object(bridge.Job, "start", side_effect=AssertionError("must not start job")):
            for name in bridge.DISABLED_CONTROL_TOOLS:
                with self.subTest(name=name):
                    result = self.call(name, self.arguments)
                    self.assertTrue(result["isError"])
                    self.assertIn("LEGACY_CONTROL_CONTEXT_UNAVAILABLE", str(result))
                    self.assertNotIn("OUTSIDE_SECRET_SENTINEL", str(result))
        self.assertEqual(self.sentinel.read_text(encoding="utf-8"), "OUTSIDE_SECRET_SENTINEL")
        self.assertEqual(bridge.JOBS, {})

    def test_direct_control_handlers_cannot_bypass_dispatch(self):
        with patch.object(bridge, "resolve_path", side_effect=AssertionError("must not inspect path")), \
             patch.object(bridge.Job, "start", side_effect=AssertionError("must not start job")):
            for name in bridge.DISABLED_CONTROL_TOOLS:
                with self.subTest(name=name), self.assertRaisesRegex(bridge.ToolExecutionError, "LEGACY_CONTROL_CONTEXT_UNAVAILABLE"):
                    bridge.TOOL_HANDLERS[name](self.arguments, self.cfg)

    def test_general_cli_query_aliases_are_denied(self):
        for name, arguments in (("ask_gpt", {"prompt": "read outside"}),
                                ("gpt_draw", {"prompt": "draw", "engine": "gpt"})):
            with self.subTest(name=name):
                result = self.call(name, arguments)
                self.assertTrue(result["isError"])
                self.assertIn("LEGACY_TEXT_WORKER_POLICY_UNAVAILABLE", str(result))
        for invoke in (lambda: bridge.tool_ask_gpt({"prompt": "read"}, self.cfg),
                       lambda: bridge._codex_run("read", self.cfg, 1),
                       lambda: bridge._gpt_draw_worker("draw", self.cfg, None)):
            with self.assertRaisesRegex(bridge.ToolExecutionError, "LEGACY_TEXT_WORKER_POLICY_UNAVAILABLE"):
                invoke()

    def test_legacy_job_cannot_spawn_a_general_agent(self):
        with patch.object(bridge, "DSH_CMD", ["fixture-dsh"]):
            job = bridge.Job("must not run", 10, self.cfg)
            job._run()
        self.assertTrue(job.done.is_set())
        self.assertFalse(job.result["ok"])
        self.assertIn("LEGACY_CONTROL_CONTEXT_UNAVAILABLE", job.result["stderr"])

    def test_path_boundary_cannot_be_disabled_by_config(self):
        for path in (str(self.sentinel), "../outside.txt"):
            with self.subTest(path=path), self.assertRaisesRegex(ValueError, "WORKSPACE_PATH_DENIED"):
                bridge.resolve_path(path, self.cfg)

    def test_canonical_path_blocks_directory_links(self):
        link = self.workspace / "linked"
        try:
            link.symlink_to(self.root, target_is_directory=True)
        except OSError as exc:
            self.skipTest("host cannot create synthetic directory link: " + str(exc.winerror))
        with self.assertRaisesRegex(ValueError, "WORKSPACE_PATH_DENIED"):
            bridge.resolve_path("linked/outside.txt", self.cfg)

    def test_only_seven_business_schemas_are_exposed(self):
        listed = bridge.handle_rpc({"id": 1, "method": "tools/list"}, self.cfg)["result"]["tools"]
        self.assertEqual({tool["name"] for tool in listed}, {
            "fetch_paper", "gpt_draw", "fetch_player_stats", "fetch_scores",
            "pc_status", "screenshot_url", "read_web_page"})
        schema = next(tool for tool in listed if tool["name"] == "gpt_draw")["inputSchema"]
        self.assertEqual(schema["properties"]["engine"]["enum"], ["free"])
        self.assertFalse(schema["additionalProperties"])

    def test_malformed_raw_calls_and_rpc_do_not_crash(self):
        for params in (None, [], {"name": []}, {"name": {"x": 1}},
                       {"name": "fetch_scores", "arguments": []},
                       {"name": "fetch_scores", "arguments": None}):
            with self.subTest(params=params):
                self.assertTrue(bridge.call_tool(params, self.cfg)["isError"])
        for message in ({"id": 1, "method": ["tools/call"]},
                        {"id": 1, "method": "tools/call", "params": [1]}):
            self.assertIn("error", bridge.handle_rpc(message, self.cfg))

    def test_raw_http_controls_denied_even_with_service_credential(self):
        handler = type("FixtureBoundaryHandler", (bridge.BridgeHandler,), {"cfg": self.cfg})
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close); self.addCleanup(server.shutdown)
        connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=3)
        self.addCleanup(connection.close)
        headers = {"Authorization": "Bearer " + self.cfg["token"], "Content-Type": "application/json"}
        for name in sorted(bridge.DISABLED_CONTROL_TOOLS):
            body = json.dumps({"jsonrpc": "2.0", "id": name, "method": "tools/call",
                               "params": {"name": name, "arguments": self.arguments}})
            connection.request("POST", "/mcp", body=body, headers=headers)
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            result = json.loads(response.read())["result"]
            self.assertTrue(result["isError"])
            self.assertIn("LEGACY_CONTROL_CONTEXT_UNAVAILABLE", str(result))
            self.assertNotIn("OUTSIDE_SECRET_SENTINEL", str(result))
        connection.request("GET", "/health", headers=headers)
        health = json.loads(connection.getresponse().read())
        self.assertEqual(health["version"], "0.2.1")
        self.assertEqual(health["toolCount"], 7)
        self.assertEqual(health["deliveryPolicy"], "legacy-control-disabled-v1")
        self.assertEqual(set(health["disabledTools"]), bridge.DISABLED_CONTROL_TOOLS | {"ask_gpt"})
        self.assertEqual(self.sentinel.read_text(encoding="utf-8"), "OUTSIDE_SECRET_SENTINEL")

    def test_free_image_returns_synchronously_without_jobs_cli_or_delivery(self):
        reads = []; urls = []
        class ImageResponse(io.BytesIO):
            headers = {"Content-Type": "image/png"}
            def read(self, count=-1):
                reads.append(count)
                return super().read(count)
        def fetch(request, **kwargs):
            urls.append(request.full_url)
            return ImageResponse(b"synthetic image bytes")
        with patch("urllib.request.urlopen", side_effect=fetch), \
             patch.object(bridge.Job, "start", side_effect=AssertionError("no jobs")):
            result = self.call("gpt_draw", {"prompt": "a/b?x=y"})
        self.assertFalse(result["isError"], result)
        self.assertEqual(result["content"][0]["type"], "image")
        self.assertTrue(urls[0].startswith("https://image.pollinations.ai/prompt/a%2Fb%3Fx%3Dy?"))
        self.assertEqual(reads, [8 * 1024 * 1024 + 1])
        self.assertEqual(bridge.JOBS, {})
        self.assertEqual(len(list((self.workspace / "generated").glob("*.png"))), 1)

    def test_free_image_rejects_oversize_response(self):
        response = io.BytesIO(b"x" * (8 * 1024 * 1024 + 1))
        response.headers = {"Content-Type": "image/png"}
        with patch("urllib.request.urlopen", return_value=response):
            result = self.call("gpt_draw", {"prompt": "draw"})
        self.assertTrue(result["isError"])
        self.assertFalse((self.workspace / "generated").exists())

    def test_free_image_cannot_accept_independent_recipient(self):
        result = self.call("gpt_draw", {"prompt": "draw", **self.arguments})
        self.assertTrue(result["isError"])
        self.assertIn("LEGACY_CONTROL_CONTEXT_UNAVAILABLE", str(result))

    def test_query_output_configuration_cannot_escape_workspace(self):
        self.cfg["gpt_output_dir"] = str(self.root / "outside-generated")
        self.cfg["papers_dir"] = str(self.root / "outside-papers")
        with patch("urllib.request.build_opener", side_effect=AssertionError("no network setup")):
            for name, args in (("gpt_draw", {"prompt": "draw"}),
                               ("fetch_paper", {"query": "10.0000/fixture"})):
                result = self.call(name, args)
                self.assertTrue(result["isError"])
                self.assertIn("WORKSPACE_PATH_DENIED", str(result))
        self.assertFalse((self.root / "outside-generated").exists())
        self.assertFalse((self.root / "outside-papers").exists())

    def test_screenshot_cannot_read_local_file_or_write_arbitrary_artifact(self):
        for url in (self.sentinel.as_uri(), "file://server/share/secret", "data:text/html,secret"):
            result = self.call("screenshot_url", {"url": url})
            self.assertTrue(result["isError"])
            self.assertIn("SCREENSHOT_URL_DENIED", str(result))
        for path in (str(self.sentinel), "arbitrary.py", "screenshots/arbitrary.py"):
            result = self.call("screenshot_url", {"url": "https://example.test", "path": path})
            self.assertTrue(result["isError"])
        artifact = self.workspace / "screenshots" / "old.png"
        artifact.parent.mkdir(); artifact.write_bytes(b"do not overwrite")
        result = self.call("screenshot_url", {"url": "https://example.test", "path": "screenshots/old.png"})
        self.assertTrue(result["isError"])
        self.assertEqual(artifact.read_bytes(), b"do not overwrite")
        self.assertEqual(self.sentinel.read_text(encoding="utf-8"), "OUTSIDE_SECRET_SENTINEL")

    def test_screenshot_success_returns_result_without_legacy_sender(self):
        image = self.workspace / "screenshots" / "new.png"
        def render(url, out, cfg, *args):
            self.assertEqual(Path(out), image)
            image.parent.mkdir(); image.write_bytes(b"synthetic png")
            return {"ok": True}
        with patch.object(bridge, "screenshot_url", side_effect=render):
            result = self.call("screenshot_url", {"url": "https://example.test", "path": "screenshots/new.png"})
        self.assertFalse(result["isError"])
        self.assertEqual(result["content"][1]["type"], "image")
        self.assertIn("未独立发送微信", result["content"][0]["text"])

    def test_paper_download_uses_new_scoped_artifact_and_download_link(self):
        class Response(io.BytesIO):
            headers = {"Content-Type": "application/pdf"}
            def geturl(self): return "https://arxiv.org/pdf/0000.00000"
        class Opener:
            def open(self, request, **kwargs):
                if "semanticscholar.org" in request.full_url:
                    return Response(b"{}")
                return Response(b"%PDF-1.4 synthetic fixture")
        with patch("urllib.request.build_opener", return_value=Opener()):
            result = self.call("fetch_paper", {"query": "arxiv:0000.00000"})
        self.assertFalse(result["isError"], result)
        artifacts = list((self.workspace / "papers").glob("*.pdf"))
        self.assertEqual(len(artifacts), 1)
        self.assertEqual(artifacts[0].read_bytes(), b"%PDF-1.4 synthetic fixture")
        self.assertIn("download=", result["content"][0]["text"])
        self.assertNotIn(self.cfg["token"], str(result))
        self.assertNotIn("export_file", str(result))

    def test_static_selftest_cannot_launch_agent(self):
        self.assertEqual(bridge.selftest(self.cfg), 0)

    def test_release_manifest_matches_query_only_candidate_without_mutating_runtime(self):
        release_spec = importlib.util.spec_from_file_location("pcbridge_release_tested", SOURCE.with_name("prepare_release.py"))
        release = importlib.util.module_from_spec(release_spec); release_spec.loader.exec_module(release)
        runtime = self.root / "runtime"; runtime.mkdir()
        (runtime / SOURCE.name).write_bytes(b"old server fixture")
        (runtime / "config.json").write_text("private config fixture", encoding="utf-8")
        manifest = release.prepare(runtime, self.root / "prepared")
        self.assertEqual(manifest["state"], "prepared_not_deployed")
        self.assertEqual(manifest["candidateContract"]["version"], bridge.SERVER_VERSION)
        self.assertEqual(manifest["candidateContract"]["toolCount"], len(bridge.TOOLS))
        self.assertEqual(set(manifest["candidateContract"]["businessTools"]), bridge.BUSINESS_QUERY_TOOLS)
        self.assertEqual((runtime / SOURCE.name).read_bytes(), b"old server fixture")
        self.assertEqual((runtime / "config.json").read_text(encoding="utf-8"), "private config fixture")
        self.assertEqual({p.name for p in (self.root / "prepared" / "rollback").iterdir()}, {SOURCE.name})
        self.assertEqual({p.name for p in (self.root / "prepared" / "candidate").iterdir()}, {SOURCE.name})


class DeliverySafety(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="pcbridge-safety-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.cfg = {**bridge.DEFAULT_CONFIG, "workspace_root": str(self.root), "token": "synthetic-control-secret",
                    "delivery_outbox": str(self.root / "outbox.sqlite3")}
        self.recipient = bridge.Recipient("account-a", "group", "group-a@chatroom", "Lab", "wechat:group:11", "fixture-request-01")
        self.contacts = [{"username": "group-a@chatroom", "conversationId": "11", "displayName": "Lab"}]
        for target, value in [("SCRIPT_DIR", self.root), ("SHARED_DIR", self.root / "shared"), ("JOBS", {})]:
            mock = patch.object(bridge, target, value); mock.start(); self.addCleanup(mock.stop)
        for target in ("run_capture", "wechat_push_text", "wechat_send_native", "_hook_post"):
            mock = patch.object(bridge, target, side_effect=AssertionError("unexpected external submit"))
            mock.start(); self.addCleanup(mock.stop)

    def arguments(self, **overrides):
        return {"target": "group-a@chatroom", "target_kind": "group", "account": "account-a",
                "request_id": "fixture-request-01", **overrides}

    def bind(self, **overrides):
        with patch.object(bridge, "_active_account", return_value="account-a"), \
             patch.object(bridge, "_read_contacts", return_value=self.contacts):
            return bridge._pick_target(self.arguments(**overrides), self.cfg)

    def test_no_recent_inference_or_owner_alias(self):
        self.assertIsNone(bridge._pick_target({}, self.cfg))
        for alias in ("", "private", "owner", "主人", "私聊"):
            with self.subTest(alias=alias), self.assertRaises(bridge.ToolExecutionError):
                bridge.resolve_target_chat(alias, self.cfg)

    def test_exact_identity_binding_survives_other_chat_activity(self):
        bound = self.bind()
        self.contacts = [{"username": "group-b@chatroom", "conversationId": "22", "displayName": "Other"}]
        with patch.object(bridge, "_active_account", return_value="account-a"):
            self.assertEqual(bridge._hook_target(self.cfg, bound), "group-a@chatroom")

    def test_duplicate_names_across_kinds_and_fuzzy_targets_rejected(self):
        self.contacts.append({"username": "private-b", "conversationId": "22", "displayName": "Lab"})
        for target in ("Lab", "La", "主人"):
            with self.subTest(target=target), self.assertRaises(bridge.ToolExecutionError):
                self.bind(target=target)

    def test_missing_account_kind_request_and_ambiguous_mapping_rejected(self):
        for override in ({"account": "account-b"}, {"account": ""}, {"request_id": ""}, {"target_kind": "private"}):
            with self.subTest(override=override), self.assertRaises(bridge.ToolExecutionError):
                self.bind(**override)
        self.contacts[0]["ambiguous"] = True
        with self.assertRaises(bridge.ToolExecutionError):
            self.bind()

    def test_account_switch_during_resolution_rejected(self):
        with patch.object(bridge, "_active_account", side_effect=["account-a", "account-b"]), \
             patch.object(bridge, "_read_contacts", return_value=self.contacts), self.assertRaises(bridge.ToolExecutionError):
            bridge._pick_target(self.arguments(), self.cfg)

    def test_incomplete_catalog_does_not_establish_uniqueness(self):
        for data in ({"contacts": []}, {"success": True, "contacts": [{}] * 500}):
            with patch.object(bridge, "_reader_get", return_value=data), self.assertRaises(bridge.ToolExecutionError):
                bridge._read_contacts(self.cfg)

    def test_contacts_are_not_reused_after_account_switch(self):
        with patch.object(bridge, "_reader_get", side_effect=[{"success": True, "contacts": self.contacts}, {"success": True, "contacts": []}]) as reader:
            self.assertEqual(len(bridge._read_contacts(self.cfg)), 1)
            self.assertEqual(bridge._read_contacts(self.cfg), [])
        self.assertEqual(reader.call_count, 2)

    def deliver(self, submit, verify=None, target=None, payload="fixture", prepare=None):
        return bridge._deliver_once(self.cfg, target or self.recipient, "result", "text", payload, submit, verify, prepare)

    def test_lost_response_is_durable_unconfirmed_and_never_replayed(self):
        submissions = []
        def lost():
            submissions.append(self.recipient.wxid)
            raise TimeoutError("response lost after native commit")
        with patch.object(bridge, "_active_account", return_value="account-a"):
            first = self.deliver(lost)
        # Reopen the DB under changed live account (simulating a restart).
        with patch.object(bridge, "_active_account", return_value="account-b"):
            second = self.deliver(lost)
        self.assertEqual(first["state"], "unconfirmed")
        self.assertEqual(second["state"], "unconfirmed")
        self.assertTrue(second["attempted"])
        self.assertEqual(submissions, ["group-a@chatroom"])

    def test_crash_after_ledger_commit_is_not_replayed(self):
        def abrupt(): raise SystemExit("synthetic crash")
        with patch.object(bridge, "_active_account", return_value="account-a"), self.assertRaises(SystemExit):
            self.deliver(abrupt)
        sender = lambda: self.fail("must not replay")
        with patch.object(bridge, "_active_account", return_value="account-a"):
            restored = self.deliver(sender)
        self.assertEqual(restored["state"], "unconfirmed")

    def test_ret_zero_alone_is_not_delivery(self):
        with patch.object(bridge, "_active_account", return_value="account-a"):
            result = self.deliver(lambda: {"ret": 0})
        self.assertEqual(result["state"], "unconfirmed")

    def test_confirmed_receipt_is_required_and_payload_target_conflicts_reject(self):
        with patch.object(bridge, "_active_account", return_value="account-a"):
            result = self.deliver(lambda: {"ret": 0}, lambda: "123456")
            conflict = self.deliver(lambda: self.fail("duplicate submission"), payload="different")
            other = self.recipient._replace(wxid="private-b", kind="private")
            conflict2 = self.deliver(lambda: self.fail("target changed"), target=other)
        self.assertEqual(result["state"], "delivered")
        self.assertEqual(conflict["code"], "DELIVERY_ID_CONFLICT")
        self.assertEqual(conflict2["code"], "DELIVERY_ID_CONFLICT")

    def test_change_at_final_account_barrier_prevents_submit(self):
        with patch.object(bridge, "_active_account", side_effect=["account-a", "account-b"]):
            result = self.deliver(lambda: self.fail("account changed before submit"))
        self.assertEqual(result["state"], "rejected")
        self.assertFalse(result["attempted"])

    def test_after_submit_account_change_cannot_confirm(self):
        with patch.object(bridge, "_active_account", side_effect=["account-a", "account-a", "account-b"]):
            result = self.deliver(lambda: {"ret": 0}, lambda: "123456")
        self.assertEqual(result["state"], "unconfirmed")

    def test_two_concurrent_attempts_only_submit_once(self):
        called = []; barrier = threading.Event()
        def submit(): called.append(1); barrier.wait(2)
        results = []
        with patch.object(bridge, "_active_account", return_value="account-a"):
            first = threading.Thread(target=lambda: results.append(self.deliver(submit)))
            first.start()
            for _ in range(100):
                if called: break
                time.sleep(0.005)
            results.append(self.deliver(submit))
            barrier.set(); first.join(3)
        self.assertEqual(called, [1])
        self.assertEqual([x["state"] for x in results], ["unconfirmed", "unconfirmed"])

    def test_matching_old_or_incoming_text_never_confirms(self):
        row = {"serverId": "12345", "createTime": int(time.time()), "isSend": 0, "fullText": "fixture"}
        for rows in ([row], [{**row, "isSend": 1, "createTime": 1}]):
            self.cfg["delivery_outbox"] = str(self.root / (str(len(list(self.root.iterdir()))) + ".sqlite3"))
            with patch.object(bridge, "_active_account", return_value="account-a"), \
                 patch.object(bridge, "_reader_get", side_effect=[{"success": True, "messages": []}] + [{"success": True, "messages": rows}] * 3), \
                 patch.object(bridge, "_hook_post", return_value={"ret": 0}), patch.object(bridge.time, "sleep"):
                result = bridge.wechat_hook_send_text("fixture", self.cfg, self.recipient)
            self.assertEqual(result["state"], "unconfirmed")

    def test_failed_history_prevents_native_submission(self):
        with patch.object(bridge, "_active_account", return_value="account-a"), \
             patch.object(bridge, "_reader_get", return_value={"messages": []}):
            result = bridge.wechat_hook_send_text("fixture", self.cfg, self.recipient)
        self.assertEqual(result["state"], "rejected")
        self.assertFalse(result["attempted"])

    def test_watcher_does_not_switch_channel_or_claim_pushed(self):
        job = bridge.Job("fixture", 10, self.cfg)
        job.target = self.recipient
        job.result = {"ok": True, "stdout": "fixture", "stderr": "", "elapsed": 0}
        job.done.set()
        with patch.object(bridge, "_notify_mode", return_value="all"), patch.object(bridge.time, "sleep"), \
             patch.object(bridge, "wechat_hook_send_text", return_value={"state": "unconfirmed", "attempted": True, "code": "LOST"}) as send:
            bridge._watch_job(job, self.cfg)
        self.assertEqual(send.call_count, 1)
        self.assertFalse(job.pushed)
        with patch.dict(bridge.JOBS, {job.id: job}, clear=True):
            text = bridge._legacy_job_status({"job_id": job.id}, self.cfg)
        self.assertIn("unconfirmed", text)
        self.assertNotIn("结果已由电脑直接发到微信", text)

    def test_job_restores_without_restarting_or_retargeting(self):
        job = bridge.Job("fixture", 10, self.cfg)
        job.target = self.recipient
        job.persist()  # crash before a result was saved
        restored = bridge._restore_job(job.id, self.cfg)
        self.assertTrue(restored.done.is_set())
        self.assertEqual(restored.target, self.recipient)
        self.assertFalse(restored.pushed)
        self.assertEqual(restored.delivery["state"], "needs_review")
        self.assertIn("JOB_INTERRUPTED", restored.result["stderr"])
        self.assertFalse(restored.thread.is_alive())

    def test_image_hook_failure_never_falls_back_ui(self):
        file = self.root / "fixture.png"; file.write_bytes(b"synthetic-image")
        with patch.object(bridge, "_pick_target", return_value=self.recipient), \
             patch.object(bridge, "wechat_hook_send_image", return_value={"state": "unconfirmed", "code": "LOST"}):
            result = bridge.call_tool({"name": "send_image", "arguments": {"path": str(file)}}, self.cfg)
        self.assertTrue(result["isError"])
        self.assertIn("LEGACY_CONTROL_CONTEXT_UNAVAILABLE", result["content"][0]["text"])

    def test_no_target_image_read_is_also_denied(self):
        file = self.root / "fixture.png"; file.write_bytes(b"synthetic-image")
        with patch.object(bridge, "wechat_hook_send_image", side_effect=AssertionError("not a direct send")):
            result = bridge.call_tool({"name": "send_image", "arguments": {"path": str(file)}}, self.cfg)
        self.assertTrue(result["isError"])
        self.assertIn("LEGACY_CONTROL_CONTEXT_UNAVAILABLE", result["content"][0]["text"])

    def test_download_capability_is_file_scoped_expires_and_cannot_control(self):
        file = self.root / "fixture.txt"; file.write_text("download fixture", encoding="utf-8")
        link = urlparse(bridge.share_file(file, self.cfg)); query = parse_qs(link.query)
        self.assertNotIn(self.cfg["token"], link.geturl())
        name = link.path.removeprefix("/files/")
        self.assertTrue(bridge._download_allowed(name, query))
        self.assertFalse(bridge._download_allowed("other.txt", query))
        self.assertFalse(bridge._download_allowed("../" + name, query))
        self.assertFalse(bridge._download_allowed(name, {"token": [self.cfg["token"]]}))
        with patch.object(bridge.time, "time", return_value=int(query["expires"][0]) + 1):
            self.assertFalse(bridge._download_allowed(name, query))
        server = ThreadingHTTPServer(("127.0.0.1", 0), type("FixtureHandler", (bridge.BridgeHandler,), {"cfg": self.cfg}))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close); self.addCleanup(server.shutdown)
        connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=3)
        self.addCleanup(connection.close)
        connection.request("GET", link.path + "?" + link.query)
        response = connection.getresponse(); self.assertEqual(response.status, 200)
        self.assertEqual(response.read(), b"download fixture")
        for route in ("/health?token=" + query["download"][0], "/sse?token=" + query["download"][0]):
            connection.request("GET", route)
            response = connection.getresponse(); self.assertEqual(response.status, 403); response.read()
        connection.request("POST", "/mcp", body=b'{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
                           headers={"Authorization": "Bearer " + query["download"][0], "Content-Type": "application/json"})
        response = connection.getresponse(); self.assertEqual(response.status, 403); response.read()
        connection.request("GET", link.path + "?token=" + self.cfg["token"])
        response = connection.getresponse(); self.assertEqual(response.status, 403); response.read()


if __name__ == "__main__":
    unittest.main(verbosity=2)
