#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
dsh-pc-bridge —— 供 DSH 调用的受限业务查询 MCP。

设计要点
--------
* 只依赖 Python 标准库,不需要 pip install 任何东西。
* 同时提供两种 MCP HTTP 传输,模块支持哪种都能连:
    - 旧式 HTTP+SSE :  GET  /sse?token=...      (先下发 endpoint 事件,再 POST /messages?sessionId=...)
    - Streamable HTTP:  POST /mcp?token=...
* 旧共享令牌不能证明当前账号/会话的电脑授权，因此控制入口关闭。
  仅公开查询和同步生成的业务结果，不运行通用 agent，不独立发送微信。
* 默认只绑 127.0.0.1;要让手机连,显式 --host 0.0.0.0,此时必须带 token。

自检(不联网、不需要手机):
    python mcp_dsh_server.py --selftest
"""

from __future__ import annotations

import argparse
import base64
import gzip
import hashlib
import html
import hmac
import json
import os
import queue
import re
import secrets
import shutil
import socket
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.request
import uuid
import zlib
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import NamedTuple
from urllib.parse import parse_qs, quote, unquote, urlparse

SERVER_NAME = "dsh-pc-bridge"
SERVER_VERSION = "0.2.1"
# Only advertise the protocol revision implemented by this compatibility server.
# Full connection lifecycle and SDK migration remain a separate task.
SUPPORTED_PROTOCOL_VERSIONS = ("2025-03-26",)
MAX_READ_FILE_BYTES = 1024 * 1024
DEFAULT_PORT = 8765
SCRIPT_DIR = Path(__file__).resolve().parent
CONFIG_PATH = SCRIPT_DIR / "config.json"
SOURCE_SHA256 = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()

# 控制台是 CP936 时,中文输出在管道里会变乱码;统一按 UTF-8 写。
# 用 pythonw(后台无窗口)启动时 sys.stdout 是 None,这里改写成日志文件,
# 否则服务器悄悄崩了都不知道为什么。
if sys.stdout is None or sys.stderr is None:
    _log_handle = open(SCRIPT_DIR / "bridge.log", "a", encoding="utf-8", buffering=1)
    sys.stdout = sys.stdout or _log_handle
    sys.stderr = sys.stderr or _log_handle
    print(f"\n===== {time.strftime('%Y-%m-%d %H:%M:%S')} 后台启动 =====")
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    except (AttributeError, ValueError):
        pass

CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0

DEFAULT_CONFIG = {
    "host": "127.0.0.1",
    "port": DEFAULT_PORT,
    "token": "",
    # 查询产物根目录；留空 = 脚本的上一级目录
    "workspace_root": "",
    # 兼容旧配置字段；不能重新启用控制入口
    "allow_shell": False,
    # 兼容旧字段；查询产物始终不能越出 workspace_root
    "allow_outside_workspace": False,
    # 单次 dsh 任务的最长执行秒数
    "agent_timeout_sec": 600,
    # 返回给手机端的最大字符数(微信侧太长会很难看)
    "max_output_chars": 6000,
    # 提前返回给客户端的等待秒数,超时后转 job 轮询
    "sync_wait_sec": 8,
    "push_max_chars": 1500,
    # 嵌套 agent 跑任务时的权限模式。这台机器的受限沙箱起不了子进程(0xC0000142),
    # The local compatibility runner supports normal workspace confinement.
    "nested_permission_mode": "workspace-write",
    "async_push": True,
    # export_file 允许的最大文件体积(MB)
    "max_export_mb": 50,
}


# ----------------------------------------------------------------------------- 配置

def load_config() -> dict:
    cfg = dict(DEFAULT_CONFIG)
    if CONFIG_PATH.exists():
        try:
            loaded = json.loads(CONFIG_PATH.read_text("utf-8"))
            if isinstance(loaded, dict):
                cfg.update(loaded)
        except Exception as exc:  # 配置坏了不要静默吞掉
            print(f"[!] config.json 解析失败,使用默认值: {exc}", file=sys.stderr)
    if not cfg.get("workspace_root"):
        cfg["workspace_root"] = str(SCRIPT_DIR.parent)
    if not cfg.get("token"):
        cfg["token"] = secrets.token_urlsafe(18)
        save_config(cfg)
    return cfg


def save_config(cfg: dict) -> None:
    CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", "utf-8")


def lan_ip() -> str:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))
        return sock.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        sock.close()


_LAN_IP: str | None = None
SHARED_DIR = SCRIPT_DIR / "shared"


def cached_lan_ip() -> str:
    global _LAN_IP
    if _LAN_IP is None:
        _LAN_IP = lan_ip()
    return _LAN_IP


def public_base(cfg: dict) -> str:
    """手机能访问到的根地址。绑 0.0.0.0 时用局域网 IP,否则用 loopback。"""
    host = "127.0.0.1" if cfg.get("host") in ("127.0.0.1", "localhost", None) else cached_lan_ip()
    return f"http://{host}:{cfg['port']}"


MIME_BY_SUFFIX = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
}


def share_file(src: Path, cfg: dict) -> str:
    """Copy a file and issue a short-lived, single-file download capability.

    The signing key is independent of the MCP control credential and is never
    returned. Old links containing the control token are intentionally invalid.
    """
    SHARED_DIR.mkdir(parents=True, exist_ok=True)
    # 顺手清理 24 小时前的旧文件
    cutoff = time.time() - 24 * 3600
    for old in SHARED_DIR.iterdir():
        try:
            if old.is_file() and old.stat().st_mtime < cutoff:
                old.unlink()
        except OSError:
            pass
    safe_name = re.sub(r"[^\w.\-\u4e00-\u9fff]", "_", src.name)[:80] or "file"
    dest = SHARED_DIR / f"{uuid.uuid4().hex[:8]}_{safe_name}"
    shutil.copy2(src, dest)
    expires = int(time.time()) + 3600
    signature = hmac.new(_download_key(), f"{dest.name}\n{expires}".encode(), hashlib.sha256).hexdigest()
    return f"{public_base(cfg)}/files/{quote(dest.name)}?expires={expires}&download={signature}"


def _download_key() -> bytes:
    file = SCRIPT_DIR / "state" / "download-signing.key"
    file.parent.mkdir(parents=True, exist_ok=True)
    try:
        with file.open("xb") as stream:
            stream.write(secrets.token_bytes(32))
            stream.flush()
            os.fsync(stream.fileno())
        try:
            file.chmod(0o600)
        except OSError:
            pass
    except FileExistsError:
        pass
    key = file.read_bytes()
    if len(key) != 32:
        raise ValueError("DOWNLOAD_KEY_INVALID")
    return key


def _download_allowed(raw_name: str, query: dict) -> bool:
    name = unquote(raw_name)
    if not name or name != Path(name).name or "/" in name or "\\" in name:
        return False
    try:
        expires = int(query.get("expires", [""])[0])
        signature = query.get("download", [""])[0]
        if not 0 < expires - time.time() <= 3600:
            return False
        expected = hmac.new(_download_key(), f"{name}\n{expires}".encode(), hashlib.sha256).hexdigest()
        return hmac.compare_digest(signature, expected)
    except (ValueError, TypeError, OSError):
        return False


# ----------------------------------------------------------------------------- 文本工具

def decode_text(raw: bytes) -> str:
    for marker, encoding in ((b"\xff\xfe\x00\x00", "utf-32"), (b"\x00\x00\xfe\xff", "utf-32"),
                             (b"\xff\xfe", "utf-16"), (b"\xfe\xff", "utf-16")):
        if raw.startswith(marker):
            return raw.decode(encoding, "replace")
    for enc in ("utf-8-sig", "utf-8", "gbk"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", "replace")


def truncate(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    keep_head = int(limit * 0.7)
    keep_tail = limit - keep_head
    return (
        text[:keep_head]
        + f"\n\n…[已截断 {len(text) - limit} 字,完整内容太多,让 agent 把结果写进文件再读取]…\n\n"
        + text[-keep_tail:]
    )


def proxy_env(cfg: dict | None = None) -> dict:
    """把本机梯子(NICE / mihomo, 127.0.0.1:7890)注入子进程环境变量。
    这样 curl / git / dsh 子任务 / 浏览器都能走代理;本机回环地址一律直连。"""
    try:
        conf = cfg if isinstance(cfg, dict) else load_config()
        proxy = str(conf.get("proxy") or conf.get("gpt_proxy") or "").strip()
    except Exception:  # noqa: BLE001
        return {}
    if not proxy:
        return {}
    # 梯子没开时不要硬塞代理(否则本来能直连的站点也被带坏)
    try:
        import socket as _socket
        from urllib.parse import urlparse as _urlparse
        u = _urlparse(proxy)
        host = u.hostname or "127.0.0.1"
        port = u.port or 7890
        with _socket.create_connection((host, port), timeout=0.4):
            pass
    except Exception:  # noqa: BLE001
        return {}
    no_proxy = "127.0.0.1,localhost,::1,.local,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"
    return {
        "HTTP_PROXY": proxy, "HTTPS_PROXY": proxy, "ALL_PROXY": proxy,
        "http_proxy": proxy, "https_proxy": proxy, "all_proxy": proxy,
        "NO_PROXY": no_proxy, "no_proxy": no_proxy,
    }


def run_capture(argv: list[str], cwd: str | None, timeout: int, env: dict | None = None) -> dict:
    """跑一个子进程,统一返回 {ok, code, stdout, stderr, elapsed}。"""
    started = time.time()
    merged_env = os.environ.copy()
    merged_env.update(proxy_env())
    if env:
        merged_env.update(env)
    try:
        proc = subprocess.run(
            argv,
            cwd=cwd,
            env=merged_env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            creationflags=CREATE_NO_WINDOW,
        )
        return {
            "ok": proc.returncode == 0,
            "code": proc.returncode,
            "stdout": decode_text(proc.stdout),
            "stderr": decode_text(proc.stderr),
            "elapsed": round(time.time() - started, 1),
        }
    except subprocess.TimeoutExpired as exc:
        return {
            "ok": False,
            "code": None,
            "stdout": decode_text(exc.stdout or b""),
            "stderr": f"超过 {timeout} 秒仍未结束；任务未确认完成，请核对已生成文件和子进程状态。",
            "elapsed": round(time.time() - started, 1),
        }
    except FileNotFoundError:
        return {"ok": False, "code": None, "stdout": "", "stderr": f"找不到可执行文件: {argv[0]}", "elapsed": 0.0}
    except OSError as exc:
        return {"ok": False, "code": None, "stdout": "", "stderr": f"启动失败: {exc}", "elapsed": 0.0}


# ----------------------------------------------------------------------------- DSH 定位

def find_dsh_command() -> tuple[list[str] | None, str]:
    """返回 (命令行前缀, 说明)。按 环境变量 -> PATH -> 常见安装位置 -> 桌面版 Electron 兜底 的顺序找。"""
    explicit = os.environ.get("DSH_CMD", "").strip()
    if explicit:
        if Path(explicit).exists() or shutil.which(explicit):
            return [explicit], f"来自 DSH_CMD={explicit}"
        return None, f"DSH_CMD={explicit} 指向的东西不存在"

    for name in ("dsh.cmd", "dsh.exe", "dsh"):
        found = shutil.which(name)
        if found:
            return [found], f"PATH 里的 {found}"

    home = Path.home()
    candidates = [
        home / ".dsh" / "bin" / "dsh.cmd",
        home / ".dsh" / "bin" / "dsh",
        home / "AppData" / "Local" / "Programs" / "dsh" / "dsh.cmd",
        home / "AppData" / "Roaming" / "npm" / "dsh.cmd",
    ]
    for candidate in candidates:
        if candidate.exists():
            return [str(candidate)], f"已安装的命令 {candidate}"

    # 兜底:直接用桌面版的 Electron 当 Node 跑 app.asar 里的 CLI
    # (ELECTRON_RUN_AS_NODE=1 时 Electron 仍然带 asar 支持,实测可用)
    for app_root in (Path(r"F:\deepseek harness"), Path(r"C:\Program Files\DeepSeek Harness")):
        exe = app_root / "DeepSeek Harness.exe"
        if not exe.exists():
            continue
        script = (app_root / "resources" / "app.asar" / "dsh" / "node_modules"
                  / "@deepseek-ai" / "dsh" / "lib" / "bin.js")
        # Electron's ASAR ESM entry can have import.meta.main=False. Explicitly
        # invoke the public CLI export rather than silently exiting with code 0.
        bootstrap = (
            "process.argv=[process.argv[0]," + json.dumps(str(script)) + ",...process.argv.slice(1)];"
            "const cli=await import(" + json.dumps(script.as_uri()) + ");await cli.runCli();"
        )
        return [str(exe), "--input-type=module", "-e", bootstrap, "--"], f"桌面版 Electron CLI 兼容入口 ({exe.name})"
    return None, "没找到 dsh 命令。请在桌面版里启用命令行 dsh,或设置环境变量 DSH_CMD。"


DSH_CMD, DSH_HINT = find_dsh_command()
DSH_EXTRA_ENV = {"ELECTRON_RUN_AS_NODE": "1"} if DSH_CMD and "DeepSeek Harness.exe" in DSH_CMD[0] else {}
if DSH_CMD is None:
    print(f"[!] {DSH_HINT}", file=sys.stderr)


def dsh_args(task: str, session_id: str | None = None) -> list[str]:
    assert DSH_CMD is not None
    args = list(DSH_CMD) + ["--profile", "headless"]
    if session_id:
        args += ["--session-id", session_id]
    guidance = (
        "【执行提示】只执行用户本次授权的任务，遵守当前工作区和权限。"
        "不发送微信消息、不改变收件目标，不安装依赖或修改运行配置，除非任务明确授权。"
        "网页截图使用本机 pcbridge 的 screenshot_url 入口；结果只报告实际文件与校验状态。"
        "最终给出真实结果，失败时明确说明，不能把空输出当完成。\n【任务】\n"
    )
    args.append(guidance + task)
    return args


# ----------------------------------------------------------------------------- 路径守卫

def resolve_path(raw: str, cfg: dict) -> Path:
    root = Path(cfg["workspace_root"]).expanduser().resolve()
    target = Path(os.path.expandvars(os.path.expanduser(raw.strip())))
    if not target.is_absolute():
        target = root / target
    target = target.resolve()
    # A process configuration boolean is not per-call/session authority.
    # Canonicalize first so junctions/symlinks cannot escape the fixed root.
    if target != root and root not in target.parents:
        raise ValueError("WORKSPACE_PATH_DENIED：路径不在服务工作区内。")
    return target


# ----------------------------------------------------------------------------- 后台任务

class Job:
    def __init__(self, task: str, timeout: int, cfg: dict, runner=None):
        self.id = "job_" + uuid.uuid4().hex[:10]
        self.task = task
        self.timeout = timeout
        self.cfg = dict(cfg)
        self.runner = runner
        self.started = time.time()
        self.done = threading.Event()
        self.result: dict | None = None
        self.answered_inline = False   # 结果已经通过工具返回值给了模型
        self.pushed = False            # 结果已经由服务端直接推进微信
        self.target = None             # immutable account/conversation binding
        self.target_key = ""           # 结果要推到的会话键(给插件汇报用)
        self.label = ""                # 任务简短描述(给状态查询用)
        self.finished = 0.0            # 结束时间
        self.delivery = {"state": "not_requested", "attempted": False, "code": ""}
        self.output_image = None
        self.thread = threading.Thread(target=self._run, daemon=True)

    def start(self) -> "Job":
        self.persist()
        self.thread.start()
        return self

    def persist(self):
        with _outbox(self.cfg) as db:
            db.execute("CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, snapshot TEXT NOT NULL)")
            snapshot = {"task": self.task, "timeout": self.timeout, "started": self.started,
                        "result": self.result, "finished": self.finished, "label": self.label,
                        "target": self.target._asdict() if self.target else None,
                        "delivery": self.delivery, "output_image": str(self.output_image) if self.output_image else None}
            db.execute("INSERT OR REPLACE INTO jobs VALUES (?,?)", (self.id, json.dumps(snapshot, ensure_ascii=False)))

    def _run(self) -> None:
        try:
            if self.runner:
                self.result = self.runner(self)
                return
            _deny_legacy_control("run_local_agent")
        except Exception as exc:  # noqa: BLE001 - 任何异常都要变成可读结果
            self.result = {"ok": False, "code": None, "stdout": "", "stderr": f"执行异常: {exc}", "elapsed": 0.0}
        finally:
            self.finished = time.time()
            try:
                self.persist()
            finally:
                self.done.set()

    def render(self, cfg: dict) -> str:
        assert self.result is not None
        body = self.result["stdout"].strip() or self.result["stderr"].strip() or "(没有输出)"
        flag = "✅ 完成" if self.result["ok"] else "❌ 失败"
        text = f"{flag} · 用时 {self.result['elapsed']}s · job={self.id}\n\n{body}"
        if not self.result["ok"] and self.result["stdout"].strip():
            text += f"\n\n--- stderr ---\n{self.result['stderr'].strip()}"
        return truncate(text, cfg["max_output_chars"])


JOBS: dict[str, Job] = {}
JOBS_LOCK = threading.Lock()


# ----------------------------------------------------------------------------- 工具实现

class ToolExecutionError(Exception):
    """A known business failure; the MCP boundary must mark it as isError."""


# This legacy transport has one shared service credential and cannot verify
# a trusted host's account/conversation-scoped computer grant. Consequently it
# does NOT expose a control channel. JSON fields, global config and possession
# of the MCP token cannot substitute for that absent authority.
DISABLED_CONTROL_TOOLS = frozenset({
    "run_local_agent", "local_agent_status", "run_local_shell", "list_local_dir",
    "read_local_file", "write_local_file", "export_file", "send_image",
})
DISABLED_AUXILIARY_TOOLS = frozenset({"ask_gpt"})
BUSINESS_QUERY_TOOLS = frozenset({
    "fetch_paper", "gpt_draw", "fetch_player_stats", "fetch_scores",
    "pc_status", "screenshot_url", "read_web_page",
})


def _deny_legacy_control(name: str):
    raise ToolExecutionError("LEGACY_CONTROL_CONTEXT_UNAVAILABLE：" + name + " 已拒绝；此传输不能验证可信宿主的会话控制授权，配置开关或请求自称授权均不能启用。")


def _deny_legacy_worker():
    raise ToolExecutionError("LEGACY_TEXT_WORKER_POLICY_UNAVAILABLE：未验证工具隔离的通用 CLI 不开放给业务查询。")


def job_tool_result(job: Job, cfg: dict) -> str:
    text = job.render(cfg)
    if not job.result or not job.result.get("ok"):
        raise ToolExecutionError(text)
    return text

def tool_pc_status(cfg: dict) -> str:
    root = Path(cfg["workspace_root"])
    lines = [
        f"主机: {socket.gethostname()}",
        f"系统: {sys.platform} / Python {sys.version.split()[0]}",
        f"时间: {time.strftime('%Y-%m-%d %H:%M:%S')}",
        f"工作区: {root} ({'存在' if root.exists() else '不存在!'})",
        f"局域网地址: {lan_ip()}",
        f"dsh 命令: {' '.join(DSH_CMD) if DSH_CMD else '未找到'} —— {DSH_HINT}",
        "电脑控制: 关闭（旧传输没有可信会话授权通道）",
        "越界访问: 禁止（配置开关不能扩大查询范围）",
    ]
    if DSH_CMD:
        probe = run_capture(list(DSH_CMD) + ["--version"], str(root), 25, DSH_EXTRA_ENV)
        version = (probe["stdout"] + probe["stderr"]).strip().splitlines()
        lines.append(f"dsh 版本探测: {version[0] if version else '(无输出)'}")
    return "\n".join(lines)


def wechat_push_text(text: str, cfg: dict, target=None):
    # The legacy UI script can only compare title pixels, not account/wxid.
    # Keep it available for diagnostics; never submit a message through it.
    return {"state": "rejected", "attempted": False, "code": "LEGACY_UI_IDENTITY_UNVERIFIED"}


def _notify_mode(cfg: dict) -> str:
    """job_notify: all=都通知 / fail=只通知失败 / off=完全不发(兼容 true/false)。
    每次重新读 config.json,所以改配置后不用重启服务。"""
    value = cfg.get("job_notify")
    try:
        if CONFIG_PATH.exists():
            fresh = json.loads(CONFIG_PATH.read_text("utf-8"))
            if "job_notify" in fresh:
                value = fresh.get("job_notify")
    except Exception:  # noqa: BLE001
        pass
    if value is True:
        return "all"
    if value is False:
        return "off"
    mode = str(value or "all").strip().lower()
    return mode if mode in ("all", "fail", "off", "natural") else "all"


def _notify_hint(cfg: dict) -> str:
    mode = _notify_mode(cfg)
    if mode == "off":
        return "自动通知已关闭,做完不会主动发消息;要结果就用 local_agent_status 查"
    if mode == "fail":
        return "只有任务失败时才会自动发通知;要结果就用 local_agent_status 查"
    return "仅尝试向已绑定目标交付一次；状态以 local_agent_status 的回执为准，不明时不会自动重发"


def _chat_key_for_target(cfg: dict, target) -> str:
    return target.conversation_key if isinstance(target, Recipient) else ""


def _strip_reply_text(text: str) -> str:
    """去掉 RESPOND: 前缀和表情标签,留下能直接发的话。"""
    text = (text or "").strip()
    if not text:
        return ""
    match = re.match(r"^\s*RESPOND\s*[:：]\s*", text, flags=re.I)
    if match:
        text = text[match.end():].strip()
    kept = [line for line in text.splitlines() if "[STICKER:" not in line]
    text = "\n".join(kept).strip()
    if not text or text.upper().startswith("SILENT"):
        return ""
    if len(text) > 1200:
        text = text[:1200].rstrip() + "…"
    return text


def _notify_instruction(cfg: dict, job: "Job") -> str:
    ok = bool(job.result and job.result.get("ok"))
    body = (job.result or {})
    output = (body.get("stdout") or "").strip() or (body.get("stderr") or "").strip() or "(没有输出)"
    status = "成功" if ok else "失败"
    return (
        "（系统自动通知，不是主人发的消息）你之前让这台电脑在后台跑的任务已经结束，"
        f"状态：{status}。\n任务输出如下：\n{output[:4000]}\n\n"
        "请用你自己的口吻，像聊天一样用一两句话把结果告诉主人：成功就讲结果和要点，"
        "失败就说卡在哪、下一步建议怎么办。不要念模板标题，不要提 job_id，不要罗列全部输出，"
        "不要调用任何工具（不要发图、不要派新任务），只输出要发给主人的那几句话。"
    )


def _ask_assistant_report(cfg: dict, job: "Job") -> str:
    """把任务结果交给微信小助手，让它用自然语言汇报。失败返回空串。"""
    key = str(getattr(job, "target_key", "") or "") or _chat_key_for_target(cfg, getattr(job, "target", ""))
    if not key:
        print("[notify] 找不到任务对应的聊天键,改用简单播报")
        return ""
    base = str(cfg.get("social_plugin_url") or "http://127.0.0.1:11230").rstrip("/")
    token_file = Path(cfg.get("social_plugin_token_file")
                     or r"G:\wechat-deepseek\data\workspace\state\social-dsh-token.txt")
    try:
        token = token_file.read_text(encoding="utf-8").strip()
    except Exception as exc:  # noqa: BLE001
        print("[notify] 读不到插件 token:", str(exc)[:120])
        return ""
    payload = json.dumps({"conversationKey": key, "message": _notify_instruction(cfg, job)},
                         ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        base + "/followup", data=payload, method="POST",
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + token})
    try:
        with urllib.request.urlopen(request, timeout=float(cfg.get("notify_turn_timeout") or 150)) as resp:
            raw = resp.read().decode("utf-8", "replace")
        data = json.loads(raw)
    except Exception as exc:  # noqa: BLE001
        print("[notify] 小助手汇报失败:", str(exc)[:200])
        return ""
    if isinstance(data, dict) and data.get("error"):
        print("[notify] 小助手汇报失败:", str(data.get("error"))[:120])
        return ""
    text = _strip_reply_text(data.get("text") if isinstance(data, dict) else "")
    print("[notify] 小助手汇报:", text[:120].replace("\n", " "))
    return text


def _natural_fallback_text(cfg: dict, job: "Job") -> str:
    ok = bool(job.result and job.result.get("ok"))
    res = job.result or {}
    body = (res.get("stdout") or "").strip() or (res.get("stderr") or "").strip() or "(没有输出)"
    body = body[:600]
    if ok:
        return "主人，电脑上那件事跑完了：\n" + body
    return "主人，电脑上那件事没跑成：\n" + body


def _describe_jobs(cfg: dict) -> str:
    now = time.time()
    with _outbox(cfg) as db:
        db.execute("CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, snapshot TEXT NOT NULL)")
        saved = [row[0] for row in db.execute("SELECT id FROM jobs ORDER BY rowid DESC LIMIT 20")]
    for job_id in saved:
        if job_id not in JOBS:
            _restore_job(job_id, cfg)
    with JOBS_LOCK:
        items = sorted(JOBS.items(), key=lambda item: -item[1].started)
    running = [item for item in items if not item[1].done.is_set()]
    finished = [item for item in items if item[1].done.is_set()]
    lines = []
    if running:
        lines.append("后台正在跑的任务:")
        for job_id, job in running:
            lines.append("  - %s 已跑 %.0f 秒 · 目标:%s · %s" % (
                job_id, now - job.started, job.target.title if job.target else "仅本地结果",
                getattr(job, "label", "") or "(无描述)"))
    else:
        lines.append("后台现在没有在跑的任务。")
    if finished:
        lines.append("最近结束的:")
        for job_id, job in finished[:5]:
            ok = bool(job.result and job.result.get("ok"))
            elapsed = (getattr(job, "finished", 0.0) or now) - job.started
            lines.append("  - %s %s · 用时 %.0f 秒 · 交付:%s · %s" % (
                job_id, "成功" if ok else "失败", elapsed, job.delivery.get("state", "unknown"), getattr(job, "label", "") or "(无描述)"))
    return "\n".join(lines)


def _watch_job(job: "Job", cfg: dict) -> None:
    """One bound result delivery. Never change channel after a submission."""
    job.done.wait()
    time.sleep(1.5)
    if job.answered_inline or not job.target:
        return
    mode = _notify_mode(cfg)
    ok = bool(job.result and job.result.get("ok"))
    if mode == "off" or (mode == "fail" and ok):
        return
    if getattr(job, "output_image", None):
        delivery = wechat_hook_send_image(job.output_image, cfg, job.target, stage="result")
    else:
        text = (_ask_assistant_report(cfg, job) if mode == "natural" else "")
        text = text or (job.render(cfg)[:int(cfg.get("push_max_chars") or 1500)])
        delivery = wechat_hook_send_text(text, cfg, job.target, stage="result")
    job.delivery = delivery
    job.pushed = delivery.get("state") == "delivered"
    job.persist()


def tool_run_agent(args: dict, cfg: dict) -> str:
    _deny_legacy_control("run_local_agent")


def tool_job_status(args: dict, cfg: dict) -> str:
    _deny_legacy_control("local_agent_status")


def _legacy_job_status(args: dict, cfg: dict) -> str:
    # Internal migration diagnostic only; never registered as an MCP handler.
    job_id = (args.get("job_id") or "").strip()
    if not job_id:
        return _describe_jobs(cfg)
    with JOBS_LOCK:
        job = JOBS.get(job_id)
    if job is None:
        job = _restore_job(job_id, cfg)
    if job is None:
        raise ToolExecutionError(f"没有这个任务: {job_id}\n{_describe_jobs(cfg)}")
    if job.done.is_set():
        if not job.result or not job.result.get("ok"):
            return job_tool_result(job, cfg)
        if job.pushed:
            return "任务完成，已取得绑定目标的送达回执。"
        return _job_status_result(job, cfg)
    # 默认就在这一次调用里再等一会儿,避免模型用密集轮询把工具调用次数烧光
    wait = int(args.get("wait_seconds") or 75)
    wait = max(5, min(wait, 110))
    if job.done.wait(wait):
        if not job.result or not job.result.get("ok"):
            return job_tool_result(job, cfg)
        if job.pushed:
            return "任务完成，已取得绑定目标的送达回执。"
        return _job_status_result(job, cfg)
    return (
        f"⏳ 仍在运行,已 {round(time.time() - job.started)}s。\n"
        f"job_id={job_id}\n"
        f"可以再调一次 local_agent_status(job_id=\"{job_id}\") 继续等。"
    )


def _restore_job(job_id: str, cfg: dict):
    with _outbox(cfg) as db:
        db.execute("CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, snapshot TEXT NOT NULL)")
        row = db.execute("SELECT snapshot FROM jobs WHERE id=?", (job_id,)).fetchone()
        if not row:
            return None
        snap = json.loads(row[0])
        job = Job(snap["task"], snap["timeout"], cfg)
        job.id = job_id
        for key in ("started", "result", "finished", "label", "delivery"):
            setattr(job, key, snap[key])
        job.target = Recipient(**snap["target"]) if snap.get("target") else None
        job.output_image = Path(snap["output_image"]) if snap.get("output_image") else None
        if not job.result:
            job.result = {"ok": False, "code": None, "stdout": "", "stderr": "JOB_INTERRUPTED：服务曾重启，任务状态待核对；未自动重跑或改收件人。", "elapsed": 0}
        if job.target:
            delivery = db.execute("SELECT * FROM deliveries WHERE id=?", (job.target.request_id + ":result",)).fetchone()
            if delivery:
                job.delivery = _delivery_state(delivery)
            elif job.delivery.get("state") == "not_requested":
                job.delivery = {"state": "needs_review", "attempted": False, "code": "RESTART_REQUIRES_REVIEW"}
        job.pushed = job.delivery.get("state") == "delivered"
        job.done.set()
    # No worker/watcher is started for restored jobs.
    with JOBS_LOCK:
        return JOBS.setdefault(job_id, job)


def _job_status_result(job: Job, cfg: dict) -> str:
    text = job_tool_result(job, cfg)
    delivery = job.delivery
    return text + "\n交付状态：" + delivery.get("state", "unknown") + " / " + delivery.get("code", "") + "；未确认送达时勿自动重发。"


def tool_list_dir(args: dict, cfg: dict) -> str:
    _deny_legacy_control("list_local_dir")


def tool_read_file(args: dict, cfg: dict) -> str:
    _deny_legacy_control("read_local_file")


def _read_workspace_file(args: dict, cfg: dict) -> str:
    # Bounded workspace reader for internal artifact processing/tests only.
    # It is intentionally absent from TOOL_HANDLERS and tools/list.
    limit = args.get("max_bytes", 400_000)
    if type(limit) is not int or not 1 <= limit <= MAX_READ_FILE_BYTES:
        raise ValueError(f"max_bytes 须为 1 至 {MAX_READ_FILE_BYTES} 之间的整数")
    target = resolve_path(args.get("path") or "", cfg)
    if not target.is_file():
        raise ToolExecutionError(f"文件不存在: {target}")
    with target.open("rb") as stream:
        raw = stream.read(limit)
        size = os.fstat(stream.fileno()).st_size
    # NUL without a UTF-16/32 BOM usually signals a binary file. Do not dump it
    # into model context as text; export/preview tools handle binary artifacts.
    if b"\x00" in raw and not raw.startswith((b"\xff\xfe", b"\xfe\xff", b"\x00\x00\xfe\xff")):
        raise ToolExecutionError("该文件看起来是二进制文件，请使用对应预览或导出工具。")
    note = f"；只读取前 {limit:,} B" if size > limit else ""
    return truncate(f"{target}（{size:,} B{note}）\n\n{decode_text(raw)}", cfg["max_output_chars"])


def tool_write_file(args: dict, cfg: dict) -> str:
    _deny_legacy_control("write_local_file")


def tool_shell(args: dict, cfg: dict) -> str:
    _deny_legacy_control("run_local_shell")


def _reader_recent(talker: str, cfg: dict, limit: int = 6):
    try:
        import urllib.parse
        base = str(cfg.get("reader_base_url") or "http://127.0.0.1:5031").rstrip("/")
        token = str(cfg.get("reader_token") or "")
        req = urllib.request.Request(
            base + "/api/v1/messages?talker=" + urllib.parse.quote(talker) + "&limit=" + str(limit),
            headers={"Authorization": "Bearer " + token})
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode("utf-8", "replace"))
        return data.get("messages") or []
    except Exception as exc:  # noqa: BLE001
        print("[probe] reader 查询失败:", str(exc)[:120])
        return []


def _reader_message_text(msg: dict) -> str:
    for key in ("fullText", "content", "text", "message"):
        value = msg.get(key)
        if isinstance(value, str):
            return value
    return ""


def _title_diff_for(name: str, cfg: dict):
    """跑一次标题指纹比对(不发任何消息),返回差异值;失败返回 None。"""
    try:
        argv = ["powershell.exe", "-STA", "-NoProfile", "-ExecutionPolicy", "Bypass",
                "-File", str(WECHAT_UI_SENDER), "-NormalizeWindow", "-NoSwitch",
                "-TargetTitle", name]
        result = run_capture(argv, str(SCRIPT_DIR), 90)
        out = ((result.get("stdout") or "") + "\n" + (result.get("stderr") or ""))
        for line in out.splitlines():
            if "TITLE_DIFF" in line:
                parts = line.replace("TITLE_DIFF", "").strip().split()
                if parts:
                    return float(parts[0])
    except Exception as exc:  # noqa: BLE001
        print("[title] 比对失败:", name, str(exc)[:100])
    return None


def _verify_open_chat(cfg: dict, timeout: float = 0) -> str:
    """用标题区域像素比对判断当前微信停在哪个聊天,不发任何消息。"""
    private = cfg.get("wechat_target_wxid") or "wxid_h0t6y5w6yke022"
    targets = [
        ("奥利奥偷工减料", private),
        ("命就是好", "47398178577@chatroom"),
        ("群里只有一个好人", "56274399421@chatroom"),
    ]
    scored = []
    for name, wxid in targets:
        diff = _title_diff_for(name, cfg)
        print("[title] %s -> %s" % (name, diff))
        if diff is not None:
            scored.append((diff, wxid, name))
    scored.sort()
    if not scored:
        return ""
    best = scored[0]
    second = scored[1][0] if len(scored) > 1 else 999.0
    margin = second - best[0]
    ok = best[0] <= 15 and margin >= 6
    print("[title] best=%s diff=%.1f 次优差=%.1f -> %s" % (best[2], best[0], margin, "确认" if ok else "不确定"))
    return best[1] if ok else ""


def _wechat_rect_live():
    """实时找到微信主窗口并恢复它,返回 (left, top, width, height);找不到返回 None。"""
    import ctypes
    import ctypes.wintypes as wt
    from ctypes import WINFUNCTYPE
    user32 = ctypes.windll.user32
    found = []

    def cb(hwnd, lparam):
        if not user32.IsWindowVisible(hwnd):
            return True
        buf = ctypes.create_unicode_buffer(256)
        user32.GetWindowTextW(hwnd, buf, 256)
        if buf.value == "微信":
            r = wt.RECT()
            user32.GetWindowRect(hwnd, ctypes.byref(r))
            if (r.right - r.left) > 200:
                found.append((hwnd, r.left, r.top, r.right - r.left, r.bottom - r.top))
        return True

    proc = WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)(cb)
    user32.EnumWindows(proc, 0)
    if not found:
        return None
    hwnd, left, top, width, height = found[0]
    if width < 900 or height < 700:
        user32.ShowWindow(hwnd, 9)
        user32.SetWindowPos(hwnd, 0, left, top, 1000, 760, 0x0040)
        time.sleep(0.8)
        r = wt.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(r))
        left, top, width, height = r.left, r.top, r.right - r.left, r.bottom - r.top
    return (int(left), int(top), int(width), int(height))


def _click_at(x: int, y: int) -> None:
    import ctypes
    user32 = ctypes.windll.user32
    user32.SetCursorPos(int(x), int(y))
    time.sleep(0.12)
    user32.mouse_event(0x0002, 0, 0, 0, 0)
    user32.mouse_event(0x0004, 0, 0, 0, 0)


def _find_private_row(cfg: dict, target_name: str = "奥利奥偷工减料", rows: int = 8) -> int:
    """逐行点选会话并用标题像素校验,返回私聊所在行号;找不到返回 -1。"""
    for i in range(rows):
        try:
            argv = ["powershell.exe", "-STA", "-NoProfile", "-ExecutionPolicy", "Bypass",
                    "-File", str(WECHAT_UI_SENDER), "-NormalizeWindow", "-SelectRow", str(i),
                    "-NoSwitch", "-TargetTitle", target_name]
            result = run_capture(argv, str(SCRIPT_DIR), 90)
            out = ((result.get("stdout") or "") + "\n" + (result.get("stderr") or ""))
            diff = None
            for line in out.splitlines():
                if "TITLE_DIFF" in line:
                    parts = line.replace("TITLE_DIFF", "").strip().split()
                    if parts:
                        diff = float(parts[0])
            print("[find] row %d diff=%s" % (i, diff))
            if diff is not None and diff <= 15:
                return i
        except Exception as exc:  # noqa: BLE001
            print("[find] row %d 失败:" % i, str(exc)[:80])
    return -1


def _switch_open_chat(cfg: dict, target_name: str = "奥利奥偷工减料", rows: int = 8) -> bool:
    """逐行点击会话列表并用标题像素校验,直到当前聊天变成目标。不发任何消息。"""
    live = _wechat_rect_live()
    if not live:
        print("[switch] 找不到微信窗口")
        return False
    left, top, width, height = live

    diff = _title_diff_for(target_name, cfg)
    if diff is not None and diff <= 20:
        return True
    if diff is None:
        return False

    row_start = int(height * 0.145)
    row_pitch = int(height * 0.089)
    x = left + int(width * 0.13)
    for i in range(rows):
        y = top + row_start + row_pitch * i
        _click_at(x, y)
        time.sleep(0.8)
        diff = _title_diff_for(target_name, cfg)
        print("[switch] row %d diff=%s" % (i, diff))
        if diff is not None and diff <= 20:
            print("[switch] 已切换到:", target_name)
            return True
    return False


def _pdf_to_page_images(src: Path, cfg: dict, max_pages: int = 3) -> list:
    """用 pdftoppm 把 PDF 首页转成图片(图片通道兜底用)。"""
    import tempfile
    pdftoppm = cfg.get("pdftoppm_path") or r"F:\\texlive\\texlive\\2026\\bin\\windows\\pdftoppm.exe"
    if not Path(pdftoppm).exists():
        return []
    out_dir = Path(tempfile.mkdtemp(prefix="pdfpages_"))
    prefix = out_dir / "page"
    dpi = str(int(cfg.get("pdf_image_dpi") or 110))
    try:
        run_capture([pdftoppm, "-png", "-r", dpi, "-f", "1", "-l", str(max_pages), str(src), str(prefix)],
                    str(out_dir), 90)
    except Exception as exc:  # noqa: BLE001
        print("[pdf2img] 转换失败:", str(exc)[:150])
        return []
    return sorted(out_dir.glob("page*.png"))


_FILE_SEND_LOCK = threading.Lock()


def _title_ref_path(name: str) -> Path:
    """会话标题像素指纹文件路径(脚本 Get-RefPath 同一算法: sha1(utf8 utf8)[:10])。"""
    import hashlib
    digest = hashlib.sha1((name or "").encode("utf-8")).hexdigest()[:10]
    return SCRIPT_DIR / ("_wx_title_" + digest + ".png")


def _send_file_verified(src: Path, cfg: dict, target_title: str = "", talker: str = "") -> tuple:
    return ("rejected", "LEGACY_UI_IDENTITY_UNVERIFIED：旧标题指纹不能证明账号与收件身份，请使用产品受控附件发送。未提交。")


def tool_export_file(args: dict, cfg: dict) -> str:
    _deny_legacy_control("export_file")


WECHAT_PROJECT = Path(r"G:\wechat-deepseek\data\workspace")
WECHAT_IO = WECHAT_PROJECT / "state" / "wechat-io-config.json"
WECHAT_HOOK_TOKEN = WECHAT_PROJECT / "state" / "hook" / "native-token.txt"
STICKER_COLLECTED = WECHAT_PROJECT / "state" / "stickers" / "collected"


def wx_http(base: str, route: str, token: str, body: dict | None = None,
            headers: dict | None = None, timeout: int = 30) -> dict:
    data = None
    hdrs = {"Authorization": "Bearer " + token}
    if headers:
        hdrs.update(headers)
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        hdrs["Content-Type"] = "application/json"
    request = urllib.request.Request(base + route, data=data, headers=hdrs,
                                     method="POST" if body is not None else "GET")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        raw = response.read().decode("utf-8", "replace")
        return json.loads(raw) if raw.strip() else {}


WECHAT_UI_SENDER = SCRIPT_DIR / "send_wechat_native.ps1"


WECHAT_HOOK_BASE = "http://127.0.0.1:30001"


def _hook_post(route: str, body: dict, cfg: dict) -> dict:
    base = cfg.get("wechat_hook_base") or WECHAT_HOOK_BASE
    token_file = Path(cfg.get("wechat_hook_token_file")
                      or r"G:\wechat-deepseek\data\workspace\state\hook\native-token.txt")
    token = token_file.read_text(encoding="utf-8").strip()
    account = cfg.get("wechat_hook_account") or ""
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(base + route, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", "Bearer " + token)
    if account:
        req.add_header("X-WeChatAgent-Account", account)
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read().decode("utf-8", "replace")
    try:
        return json.loads(raw)
    except Exception:
        return {"raw": raw}


class Recipient(NamedTuple):
    account: str
    kind: str
    wxid: str
    title: str
    conversation_key: str
    request_id: str


def _reader_get(route: str, cfg: dict):
    base = str(cfg.get("reader_base_url") or "http://127.0.0.1:5031").rstrip("/")
    token = str(cfg.get("reader_token") or "")
    return wx_http(base, route, token)


def _active_account(cfg: dict) -> str:
    reader = _reader_get("/api/v1/reader/status", cfg)
    expected = str(reader.get("accountDirectory") or "").lower()
    if reader.get("backend") != "weflow-cli-nt" or not reader.get("ownWxid") or not expected:
        raise ToolExecutionError("READER_ACCOUNT_METADATA_REQUIRED")
    token_file = Path(cfg.get("wechat_hook_token_file") or WECHAT_HOOK_TOKEN)
    token = token_file.read_text(encoding="utf-8").strip()
    health = wx_http(str(cfg.get("wechat_hook_base") or WECHAT_HOOK_BASE), "/WeChatAgent/health", token)
    accounts = health.get("databaseAccounts")
    if (health.get("integration") != "WeChatAgent-1" or health.get("backend") != "wechat-hook"
            or health.get("version") != "4.1.10.27" or health.get("startupState", "ready") != "ready"
            or not isinstance(accounts, list) or len(accounts) != 1
            or str(accounts[0]).lower() != expected):
        raise ToolExecutionError("DELIVERY_ACCOUNT_MISMATCH")
    return expected


def _read_contacts(cfg: dict) -> list:
    # Do not retain contacts across accounts or even across calls. Incomplete
    # catalogs cannot establish uniqueness and must fail closed.
    data = _reader_get("/api/v1/contacts?limit=10000", cfg)
    contacts = data.get("contacts")
    # The current reader caps this endpoint at 500 even when asked for more.
    if data.get("success") is not True or not isinstance(contacts, list) or len(contacts) >= 500:
        raise ToolExecutionError("CONTACT_CATALOG_INCOMPLETE")
    return contacts


def resolve_target_chat(target, cfg: dict) -> tuple:
    if isinstance(target, Recipient):
        return target.wxid, target.title
    raw = str(target or "").strip()
    if not raw or raw.lower() in ("private", "owner", "私聊", "主人", "主人私聊"):
        raise ToolExecutionError("EXPLICIT_RECIPIENT_REQUIRED：请提供稳定 wxid，不使用主人别名。")
    matches = {}
    for item in _read_contacts(cfg):
        wxid = str(item.get("username") or "")
        name = str(item.get("displayName") or "")
        # Exact, case-sensitive identifiers; never substring/first match.
        aliases = {wxid, str(item.get("conversationId") or ""), name,
                   str(item.get("remark") or ""), str(item.get("nickname") or "")}
        if wxid and raw in aliases:
            matches[wxid] = name or wxid
    if len(matches) != 1:
        raise ToolExecutionError("RECIPIENT_AMBIGUOUS" if matches else "RECIPIENT_NOT_FOUND")
    return next(iter(matches.items()))


def _assert_recipient(target, cfg: dict) -> None:
    if not isinstance(target, Recipient):
        raise ToolExecutionError("BOUND_RECIPIENT_REQUIRED")
    if _active_account(cfg) != target.account:
        raise ToolExecutionError("DELIVERY_ACCOUNT_CHANGED")
    if ("group" if target.wxid.endswith("@chatroom") else "private") != target.kind:
        raise ToolExecutionError("RECIPIENT_KIND_MISMATCH")


def _hook_target(cfg: dict, target=None) -> str:
    _assert_recipient(target, cfg)
    return target.wxid


@contextmanager
def _outbox(cfg: dict):
    file = Path(cfg.get("delivery_outbox") or SCRIPT_DIR / "state" / "delivery-outbox.sqlite3")
    file.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(file, timeout=10)
    db.row_factory = sqlite3.Row
    try:
        db.execute("CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, account TEXT NOT NULL, kind TEXT NOT NULL, wxid TEXT NOT NULL, digest TEXT NOT NULL, state TEXT NOT NULL, attempted INTEGER NOT NULL, code TEXT NOT NULL, receipt TEXT NOT NULL)")
        with db:
            yield db
    finally:
        db.close()


def _delivery_state(row):
    # A persisted 'submitted' record can be from a lost response/crashed process.
    return {"state": "unconfirmed" if row["state"] == "submitted" else row["state"],
            "attempted": bool(row["attempted"]), "code": row["code"], "receipt": row["receipt"]}


def _receipt_id(row: dict) -> str:
    return str(row.get("serverId") or row.get("server_id") or "")


def _deliver_once(cfg: dict, target, stage: str, kind: str, payload: str, submit, verify=None, prepare=None):
    if not isinstance(target, Recipient):
        return {"state": "rejected", "attempted": False, "code": "BOUND_RECIPIENT_REQUIRED"}
    operation = target.request_id + ":" + stage
    digest = hashlib.sha256((kind + "\n" + payload).encode()).hexdigest()
    with _outbox(cfg) as db:
        db.execute("BEGIN IMMEDIATE")
        previous = db.execute("SELECT * FROM deliveries WHERE id=?", (operation,)).fetchone()
        if previous:
            if (previous["account"], previous["kind"], previous["wxid"], previous["digest"]) != (target.account, kind, target.wxid, digest):
                return {"state": "rejected", "attempted": False, "code": "DELIVERY_ID_CONFLICT"}
            return _delivery_state(previous)
        try:
            _assert_recipient(target, cfg)
            if prepare:
                prepare()
        except Exception:
            return {"state": "rejected", "attempted": False, "code": "DELIVERY_PRECHECK_FAILED"}
        db.execute("INSERT INTO deliveries VALUES (?,?,?,?,?,?,?,?,?)",
                   (operation, target.account, kind, target.wxid, digest, "submitted", 1, "AWAITING_RECEIPT", ""))
    state = {"state": "unconfirmed", "attempted": True, "code": "DELIVERY_UNCONFIRMED", "receipt": ""}
    try:
        # Account may have changed while waiting for the durable ledger lock.
        _assert_recipient(target, cfg)
    except Exception:
        state = {"state": "rejected", "attempted": False, "code": "DELIVERY_ACCOUNT_CHANGED", "receipt": ""}
    else:
        try:
            submit()  # ret=0 / SENT are submission hints, never delivery evidence.
            receipt = verify() if verify else ""
            _assert_recipient(target, cfg)
            if receipt:
                state.update(state="delivered", code="DELIVERY_CONFIRMED", receipt=receipt)
        except Exception:
            pass  # Submitted or unknown; no alternate channel and no automatic replay.
    with _outbox(cfg) as db:
        db.execute("UPDATE deliveries SET state=?,attempted=?,code=?,receipt=? WHERE id=?",
                   (state["state"], int(state["attempted"]), state["code"], state["receipt"], operation))
    return state


def wechat_hook_send_text(text: str, cfg: dict, target=None, stage="result"):
    if not cfg.get("wechat_hook_text", True):
        return {"state": "rejected", "attempted": False, "code": "TEXT_CHANNEL_DISABLED"}
    baseline = set()
    started = int(time.time())
    def history():
        data = _reader_get("/api/v1/messages?talker=" + quote(target.wxid) + "&limit=100", cfg)
        if data.get("success") is not True or not isinstance(data.get("messages"), list):
            raise ToolExecutionError("DELIVERY_HISTORY_INCOMPLETE")
        return data["messages"]
    def prepare():
        baseline.update(_receipt_id(row) for row in history())
    def verify():
        for _ in range(3):
            _assert_recipient(target, cfg)
            rows = history()
            _assert_recipient(target, cfg)
            matches = [_receipt_id(row) for row in rows
                       if _receipt_id(row).isdigit() and int(_receipt_id(row)) > 0
                       and _receipt_id(row) not in baseline and row.get("isSend") in (True, 1)
                       and int(row.get("createTime") or 0) >= started
                       and _reader_message_text(row) == text]
            if len(matches) == 1:
                return matches[0]
            time.sleep(0.4)
        return ""
    return _deliver_once(cfg, target, stage, "text", text,
                         lambda: _hook_post("/SendTextMsg", {"wxidorgid": target.wxid, "msg": text}, {**cfg, "wechat_hook_account": target.account}), verify, prepare)


def wechat_hook_send_image(src: Path, cfg: dict, target=None, stage="result"):
    if not cfg.get("wechat_hook_image", True):
        return {"state": "rejected", "attempted": False, "code": "IMAGE_CHANNEL_DISABLED"}
    if not cfg.get("wechat_hook_image_abi_verified", False):
        return {"state": "rejected", "attempted": False, "code": "NATIVE_IMAGE_ABI_NOT_VERIFIED"}
    try:
        _assert_recipient(target, cfg)
        raw = src.read_bytes()
        if not raw or len(raw) > 8 * 1024 * 1024:
            raise ValueError("IMAGE_SIZE_INVALID")
        outgoing = Path(cfg.get("wechat_hook_outgoing") or WECHAT_PROJECT / "state/stickers/outgoing")
        outgoing.mkdir(parents=True, exist_ok=True)
        staged = outgoing / (hashlib.sha256(raw).hexdigest() + src.suffix.lower())
        staged.write_bytes(raw)
    except Exception:
        return {"state": "rejected", "attempted": False, "code": "IMAGE_PRECHECK_FAILED"}
    # The old native API has no trustworthy image receipt contract. A successful
    # POST therefore remains unconfirmed, even when the native return is zero.
    return _deliver_once(cfg, target, stage, "image", hashlib.sha256(raw).hexdigest(),
                         lambda: _hook_post("/SendImgMsg", {"wxidorgid": target.wxid, "path": str(staged)}, {**cfg, "wechat_hook_account": target.account}))


def wechat_ui_target_args(cfg: dict) -> list:
    """目标会话 + 自动切换:窗口不在目标聊天时,脚本自己切过去再发。"""
    title = (cfg.get("wechat_ui_chat_title") or "").strip()
    if not title:
        return []
    argv = ["-TargetTitle", title, "-NormalizeWindow"]
    if cfg.get("wechat_ui_switch_chat", True):
        argv.append("-SwitchChat")
    return argv


def wechat_send_native(src: Path, cfg: dict, mode: str, **kwargs):
    # Title screenshots are diagnostic data, not a stable delivery identity.
    raise ToolExecutionError("LEGACY_UI_IDENTITY_UNVERIFIED：旧 UI 通道未提交。")


def tool_send_image(args: dict, cfg: dict) -> list:
    _deny_legacy_control("send_image")


ESPN_PATHS = {
    "nba": "basketball/nba", "wnba": "basketball/wnba",
    "ncaab": "basketball/mens-college-basketball",
    "nfl": "football/nfl", "ncaaf": "football/college-football",
    "mlb": "baseball/mlb", "nhl": "hockey/nhl",
    "soccer": "soccer/eng.1", "epl": "soccer/eng.1",
    "laliga": "soccer/esp.1", "ucl": "soccer/uefa.champions",
    "csl": "soccer/chn.1", "tennis": "tennis/atp", "f1": "racing/f1",
}


def _hupu_player_rank(section: str) -> list:
    """抓虎扑某个榜单(pts/reb/asts/stl/blk),返回 [(排名, 球员, 球队, 数值)]。"""
    import re
    url = "https://nba.hupu.com/stats/players/" + section
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        html = resp.read().decode("utf-8", "replace")
    rows = re.findall(r"<tr[^>]*>(.*?)</tr>", html, re.S)
    clean = lambda s: re.sub(r"<[^>]+>", "", s).strip()
    header = None
    out = []
    for r in rows:
        cells = [clean(c) for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", r, re.S)]
        cells = [c for c in cells if c != ""]
        if not cells:
            continue
        if header is None and "球员" in cells:
            header = cells
            continue
        if header is None or len(cells) < 4:
            continue
        row = dict(zip(header, cells))
        name = row.get("球员", "")
        team = row.get("球队", "")
        if not name:
            continue
        value = ""
        value_key = {"pts": "得分", "reb": "篮板数", "asts": "助攻数",
                     "stl": "抢断数", "blk": "盖帽数"}.get(section, "")
        if value_key:
            value = row.get(value_key, "")
        if not value:
            continue
        try:
            val = float(value)
        except Exception:
            continue
        out.append((int(float(row.get("排名") or 0)), name, team, val))
    return out


def _hupu_nba_scores() -> str | None:
    """虎扑中文比分(今日/最新赛程)。失败返回 None,由调用方回退到 ESPN。"""
    import re
    try:
        req = urllib.request.Request("https://nba.hupu.com/games", headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                          "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"})
        with urllib.request.urlopen(req, timeout=20) as resp:
            html = resp.read().decode("utf-8", "replace")
    except Exception as exc:  # noqa: BLE001
        print("[hupu] 拉取失败:", exc)
        return None
    clean = lambda s: re.sub(r"<[^>]+>", "", s).strip()
    blocks = re.split(r'<div class="team_vs"', html)
    lines = []
    for blk in blocks[1:]:
        teams = [t.strip() for t in re.findall(r'/teams/[a-z0-9\-]+"[^>]*>\s*([^<]{1,12})\s*</a>', blk)]
        nums = re.findall(r'<span class="num[^"]*">\s*(\d+)\s*</span>', blk)
        status = re.search(r'<span class="b">\s*([^<]{1,8})\s*</span>', blk)
        if len(teams) >= 2 and len(nums) >= 2:
            st = status.group(1).strip() if status else ""
            lines.append("%s %s - %s %s%s" % (teams[0], nums[0], nums[1], teams[1],
                                              (" · " + st) if st else ""))
    if not lines:
        return None
    return "【NBA 今日战报】虎扑中文数据\n" + "\n".join(lines[:20])


def _codex_cmd(cfg: dict) -> list | None:
    node = cfg.get("codex_node") or r"C:\Users\ADMIN\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
    js = cfg.get("codex_js") or r"C:\Users\ADMIN\AppData\Roaming\npm\node_modules\@openai\codex\bin\codex.js"
    if not Path(node).exists() or not Path(js).exists():
        return None
    return [node, js, "exec", "--skip-git-repo-check", "-c", "model_reasoning_effort=low"]


def _codex_env(cfg: dict) -> dict:
    env = dict(os.environ)
    proxy = cfg.get("gpt_proxy") or "http://127.0.0.1:7890"
    for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"):
        env[key] = proxy
    return env


def _codex_run(prompt: str, cfg: dict, timeout: int) -> dict:
    # Never let a query alias invoke a general agent with ambient tools/config.
    _deny_legacy_worker()


def _codex_images(cfg: dict) -> set:
    root = Path(cfg.get("gpt_images_dir") or (Path.home() / ".codex" / "generated_images"))
    if not root.exists():
        return set()
    try:
        return {str(p) for p in root.rglob("*.png")}
    except Exception:  # noqa: BLE001
        return set()


def _gpt_draw_worker(prompt: str, cfg: dict, job) -> dict:
    _deny_legacy_worker()


def _store_generated(raw: bytes, suffix: str, cfg: dict, prefix: str) -> Path:
    if not raw or len(raw) > 8 * 1024 * 1024:
        raise ValueError("GENERATED_IMAGE_SIZE_INVALID")
    out = resolve_path(str(cfg.get("gpt_output_dir") or Path(cfg["workspace_root"]) / "generated"), cfg)
    out.mkdir(parents=True, exist_ok=True)
    dst = out / (prefix + "_" + uuid.uuid4().hex[:12] + suffix)
    dst.write_bytes(raw)
    return dst


def _free_draw_worker(prompt: str, cfg: dict) -> Path:
    # Fixed image endpoint and bounded bytes; no local worker/model tools.
    width, height = int(cfg.get("free_image_width") or 1024), int(cfg.get("free_image_height") or 1024)
    if not 64 <= width <= 2048 or not 64 <= height <= 2048:
        raise ValueError("IMAGE_DIMENSIONS_INVALID")
    url = "https://image.pollinations.ai/prompt/" + quote(prompt, safe="") + "?width=%d&height=%d&nologo=true&seed=%d" % (width, height, int(time.time()) % 100000)
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=120) as response:
        ctype = response.headers.get("Content-Type", "")
        if not ctype.startswith("image/"):
            raise ValueError("GENERATED_CONTENT_NOT_IMAGE")
        raw = response.read(8 * 1024 * 1024 + 1)
    return _store_generated(raw, ".jpg" if "jpeg" in ctype else ".png", cfg, "free")


def tool_gpt_draw(args: dict, cfg: dict) -> list:
    prompt = (args.get("prompt") or "").strip()
    if not prompt or len(prompt) > 4000:
        raise ValueError("IMAGE_PROMPT_INVALID")
    # Do not route this query into a generic Codex/DSH worker even if config
    # previously selected it; do not create a detached job or send a notification.
    engine = str(args.get("engine") or "free").lower()
    if engine != "free":
        _deny_legacy_worker()
    if any(args.get(key) for key in ("target", "account", "target_kind", "request_id")):
        _deny_legacy_control("gpt_draw.direct_delivery")
    # Reject outside output configuration before any network request.
    resolve_path(str(cfg.get("gpt_output_dir") or Path(cfg["workspace_root"]) / "generated"), cfg)
    image = _free_draw_worker(prompt, cfg)
    raw = image.read_bytes()
    if len(raw) > 3 * 1024 * 1024:
        return [{"type": "text", "text": "已生成图片；仅本次工具结果的下载链接：" + share_file(image, cfg)}]
    mime = MIME_BY_SUFFIX[image.suffix.lower()]
    return [{"type": "image", "data": base64.b64encode(raw).decode("ascii"), "mimeType": mime},
            {"type": "text", "text": "图片已生成并作为本次工具结果返回；未独立发送微信。"}]


def tool_fetch_paper(args: dict, cfg: dict) -> str:
    """下载文献 PDF:先用本机校园网 IP 直接找出版商,再退开放获取(Unpaywall / S2 / arXiv)。"""
    import re as _re
    import urllib.parse

    query = (args.get("query") or args.get("doi") or args.get("title") or "").strip()
    if not query:
        raise ValueError("请给出 DOI、标题或 arXiv 编号")
    out_dir = resolve_path(str(cfg.get("papers_dir") or Path(cfg["workspace_root"]) / "papers"), cfg)
    out_dir.mkdir(parents=True, exist_ok=True)

    proxy = cfg.get("gpt_proxy") or "http://127.0.0.1:7890"
    direct = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    via_proxy = urllib.request.build_opener(urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
    UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
          "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")

    def get(url, timeout=45, raw=False, use_proxy=False, referer=None):
        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            raise ValueError("PAPER_URL_SCHEME_DENIED")
        headers = {"User-Agent": UA, "Accept": "application/pdf,text/html;q=0.9,*/*;q=0.8"}
        if referer:
            headers["Referer"] = referer
        opener = via_proxy if use_proxy else direct
        last = None
        for attempt in range(3):
            try:
                req = urllib.request.Request(url, headers=headers)
                with opener.open(req, timeout=timeout) as resp:
                    data = resp.read()
                    final = resp.geturl()
                    ctype = resp.headers.get("Content-Type", "")
                if raw:
                    return data, final, ctype
                return data.decode("utf-8", "replace"), final, ctype
            except urllib.error.HTTPError as exc:
                last = exc
                if exc.code in (429, 500, 502, 503, 504) and attempt < 2:
                    time.sleep(3 * (attempt + 1))
                    continue
                raise
            except Exception as exc:  # noqa: BLE001
                last = exc
                if attempt < 2:
                    time.sleep(2)
                    continue
                raise
        raise last if last else RuntimeError("request failed")

    doi = ""
    m = _re.search(r"10\.\d{4,9}/[^\s\"']+", query)
    if m:
        doi = m.group(0).rstrip(".,;)")
    arxiv = _re.search(r"(\d{4}\.\d{4,5})(v\d+)?", query)

    meta = {"title": "", "doi": doi, "status": ""}
    candidates = []
    notes = []

    # ---------- 1) arXiv 直链 ----------
    if arxiv and (not doi or "arxiv" in query.lower()):
        aid = arxiv.group(1)
        candidates.append(("arXiv", "https://arxiv.org/pdf/%s" % aid, False, ""))
        candidates.append(("arXiv镜像", "https://export.arxiv.org/pdf/%s" % aid, False, ""))

    # ---------- 2) 出版商(用本机校园网 IP) ----------
    if doi:
        try:
            html, final, _ = get("https://doi.org/" + doi, timeout=40)
            if "citation_title" in html:
                tm = _re.search(r'<meta[^>]+name="citation_title"[^>]+content="([^"]+)"', html)
                if tm:
                    meta["title"] = tm.group(1)
            if "/accepted/" in final or "Accepted" in html[:20000]:
                meta["status"] = "accepted"
                notes.append("出版商页面显示这是 Accepted Paper(已接收未排版),通常还没有可下载的 PDF")
            pdfm = _re.search(r'<meta[^>]+name="citation_pdf_url"[^>]+content="([^"]+)"', html)
            if pdfm:
                candidates.append(("出版商(校园网)", pdfm.group(1), False, final))
        except Exception as exc:  # noqa: BLE001
            notes.append("DOI 解析失败:%s" % str(exc)[:80])

    # ---------- 3) Unpaywall ----------
    if doi:
        try:
            data, _, _ = get("https://api.unpaywall.org/v2/%s?email=%s"
                             % (urllib.parse.quote(doi),
                                cfg.get("unpaywall_email") or "openaccess@example.com"), use_proxy=True)
            info = json.loads(data)
            meta["title"] = meta["title"] or (info.get("title") or "")
            for loc in (info.get("oa_locations") or []):
                url = loc.get("url_for_pdf") or loc.get("url")
                if url:
                    candidates.append(("Unpaywall", url, True, ""))
        except Exception as exc:  # noqa: BLE001
            notes.append("Unpaywall 查询失败:%s" % str(exc)[:80])

    # ---------- 4) Semantic Scholar ----------
    try:
        api = ("https://api.semanticscholar.org/graph/v1/paper/DOI:%s?fields=title,openAccessPdf,externalIds"
               % urllib.parse.quote(doi)) if doi else (
               "https://api.semanticscholar.org/graph/v1/paper/search?query=%s&limit=1"
               "&fields=title,openAccessPdf,externalIds" % urllib.parse.quote(query))
        data, _, _ = get(api, use_proxy=True)
        info = json.loads(data)
        if isinstance(info, dict) and info.get("data"):
            info = info["data"][0]
        if isinstance(info, dict):
            meta["title"] = meta["title"] or (info.get("title") or "")
            oa = (info.get("openAccessPdf") or {}).get("url")
            if oa:
                candidates.append(("SemanticScholar", oa, True, ""))
            ext = info.get("externalIds") or {}
            if ext.get("ArXiv"):
                candidates.append(("arXiv(元数据)", "https://arxiv.org/pdf/%s" % ext["ArXiv"], False, ""))
    except Exception as exc:  # noqa: BLE001
        notes.append("Semantic Scholar 查询失败:%s" % str(exc)[:80])

    seen = set()
    for label, url, use_proxy, referer in candidates:
        if url in seen:
            continue
        seen.add(url)
        try:
            data, final, ctype = get(url, timeout=90, raw=True, use_proxy=use_proxy, referer=referer or None)
        except Exception as exc:  # noqa: BLE001
            notes.append("%s 下载失败:%s" % (label, str(exc)[:70]))
            continue
        if data[:4] != b"%PDF":
            notes.append("%s 返回的不是 PDF(%s)" % (label, ctype[:40]))
            continue
        safe = _re.sub(r"[^0-9A-Za-z._-]+", "_", (meta["title"] or doi or "paper"))[:60].strip("_") or "paper"
        dst = resolve_path(str(out_dir / (safe + "_" + uuid.uuid4().hex[:12] + ".pdf")), cfg)
        dst.write_bytes(data)
        lines = ["已下载 PDF:%s(%.2f MB,来源 %s)" % (dst.name, len(data) / 1024 / 1024, label)]
        if meta["title"]:
            lines.append("标题:" + meta["title"])
        if meta["doi"]:
            lines.append("DOI:" + meta["doi"])
        lines.append("文件路径:%s" % dst)
        lines.append("仅本次工具结果的下载链接:" + share_file(dst, cfg))
        return "\n".join(lines)

    msg = ["没拿到 PDF。"]
    if meta["title"]:
        msg.append("标题:%s" % meta["title"])
    if meta["doi"]:
        msg.append("DOI:%s" % meta["doi"])
    if meta["status"] == "accepted":
        msg.append("状态:出版商页面是 Accepted Paper,还没有正式 PDF;等正式发表或找 arXiv 预印本。")
    elif meta["doi"]:
        msg.append("这台电脑的校园网 IP 也没拿到(可能未订阅该刊,或出版商要求网页登录)。")
    if notes:
        msg.append("细节:" + ";".join(notes[:4]))
    raise ToolExecutionError("\n".join(msg))


def tool_ask_gpt(args: dict, cfg: dict) -> str:
    _deny_legacy_worker()


def tool_fetch_player_stats(args: dict, cfg: dict) -> str:
    """球员数据榜(虎扑中文源):得分/篮板/助攻/抢断/盖帽。"""
    sections = {
        "pts": "得分", "reb": "篮板", "asts": "助攻", "stl": "抢断", "blk": "盖帽",
    }
    want = (args.get("category") or "all").strip().lower()
    keys = list(sections) if want in ("all", "") else [want] if want in sections else []
    if not keys:
        raise ValueError("不支持的分类: %s(可选 pts/reb/asts/stl/blk/all)" % want)
    lines = ["【NBA 球员数据榜】虎扑中文数据"]
    ok = False
    for key in keys:
        try:
            rows = _hupu_player_rank(key)[:5]
        except Exception as exc:  # noqa: BLE001
            lines.append("%s榜: 拉取失败(%s)" % (sections[key], str(exc)[:60]))
            continue
        if not rows:
            continue
        ok = True
        lines.append("")
        lines.append("%s榜:" % sections[key])
        for rank, name, team, val in rows:
            lines.append("%d. %s(%s) %g" % (rank, name, team, val))
    if not ok:
        raise ToolExecutionError("球员数据没拉到,稍后再试。")
    return "\n".join(lines)


def tool_fetch_scores(args: dict, cfg: dict) -> str:
    """比分 / 赛程:直接查公开数据接口(JSON),不截图、不怕反爬。"""
    import urllib.parse

    sport = (args.get("sport") or "nba").strip().lower()
    date = "".join(ch for ch in (args.get("date") or "") if ch.isdigit())[:8]
    if sport == "nba" and not date:
        zh = _hupu_nba_scores()
        if zh:
            return zh + "\n(数据源: 虎扑)"
    path = ESPN_PATHS.get(sport)
    if not path:
        raise ValueError("不支持的赛事: %s\n可选: %s" % (sport, ", ".join(sorted(ESPN_PATHS))))
    url = "https://site.api.espn.com/apis/site/v2/sports/%s/scoreboard" % path
    if date:
        url += "?dates=" + date
    payload = None
    last_err = None
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                              "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
                "Accept": "application/json",
            })
            with urllib.request.urlopen(req, timeout=20) as resp:
                chunks = []
                while True:
                    part = resp.read(65536)
                    if not part:
                        break
                    chunks.append(part)
                payload = json.loads(b"".join(chunks).decode("utf-8", "replace"))
            break
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            payload = None
            if attempt < 2:
                time.sleep(0.8)
    if payload is None:
        raise ToolExecutionError("查询失败(%s): %s\n(网络抖动,已重试 3 次)换个日期或换个赛事再试。" % (sport, last_err))

    events = payload.get("events") or []
    if not events:
        return "没有查到比赛: 赛事=%s 日期=%s(可能当天没有比赛,或该赛事不在数据源里)" % (
            sport, date or "今天")

    lines = []
    for ev in events[:20]:
        comp = ((ev.get("competitions") or [{}])[0]) or {}
        status = ((comp.get("status") or {}).get("type") or {})
        state = status.get("description") or status.get("detail") or ""
        when = (comp.get("date") or ev.get("date") or "")[:16].replace("T", " ")
        pairs = []
        for team in comp.get("competitors") or []:
            name = ((team.get("team") or {}).get("displayName")
                    or (team.get("team") or {}).get("shortDisplayName") or "?")
            score = team.get("score")
            home = team.get("homeAway")
            pairs.append({"home": home == "home", "text": "%s %s" % (name, score if score not in (None, "") else "-")})
        pairs.sort(key=lambda x: 0 if x["home"] else 1)
        body = " vs ".join(item["text"] for item in pairs)
        venue = ((comp.get("venue") or {}).get("fullName") or "")
        extra = (" @ " + venue) if venue else ""
        lines.append("%s | %s | %s%s" % (when, state, body, extra))

    head = "【%s 比分/赛程】%s" % (sport.upper(), ("日期 " + date) if date else "今天")
    if payload.get("leagues"):
        try:
            head += " · " + payload["leagues"][0].get("name", "")
        except Exception:
            pass
    return head + "\n" + "\n".join(lines) + "\n(数据源: ESPN 公开接口)"


# ---------------------------------------------------------------- Explicit delivery identity
# Recent messages are deliberately not consulted by this server.
def _auto_target(cfg: dict) -> str:
    raise ToolExecutionError("EXPLICIT_RECIPIENT_REQUIRED：禁止根据最近聊天推断收件人。")


def _pick_target(args: dict, cfg: dict, required=False):
    explicit = args.get("target")
    if not explicit:
        if required:
            raise ToolExecutionError("EXPLICIT_RECIPIENT_REQUIRED")
        return None
    request_id = args.get("request_id")
    account = args.get("account")
    if not isinstance(request_id, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{8,120}", request_id):
        raise ToolExecutionError("DELIVERY_REQUEST_ID_REQUIRED")
    if not isinstance(account, str) or not account.strip() or account.lower() != _active_account(cfg):
        raise ToolExecutionError("DELIVERY_ACCOUNT_MISMATCH")
    wxid, name = resolve_target_chat(explicit, cfg)
    kind = "group" if wxid.endswith("@chatroom") else "private"
    requested_kind = args.get("target_kind")
    if requested_kind != kind:
        raise ToolExecutionError("RECIPIENT_KIND_REQUIRED_OR_MISMATCH")
    contacts = [x for x in _read_contacts(cfg) if x.get("username") == wxid]
    if any(x.get("ambiguous") for x in contacts):
        raise ToolExecutionError("RECIPIENT_AMBIGUOUS")
    keys = {str(x.get("conversationId") or "") for x in contacts}
    if len(keys) != 1 or not next(iter(keys)):
        raise ToolExecutionError("RECIPIENT_CONVERSATION_UNAVAILABLE")
    if _active_account(cfg) != account.lower():
        raise ToolExecutionError("DELIVERY_ACCOUNT_CHANGED")
    return Recipient(account.lower(), kind, wxid, name, "wechat:" + kind + ":" + next(iter(keys)), request_id)




# ---------------------------------------------------------------- 嵌套 agent 执行提示
def _cli_python() -> str:
    exe = Path(sys.executable)
    if exe.name.lower() == "pythonw.exe":
        alt = exe.with_name("python.exe")
        if alt.is_file():
            return str(alt)
    return str(exe)


def _agent_hint(cfg: dict) -> str:
    script = SCRIPT_DIR / "mcp_dsh_server.py"
    py = _cli_python()
    return "\n".join([
        "【本机执行提示】(环境说明,不是用户的要求)",
        ("- 要截网页图:运行 `& \"%s\" \"%s\" --screenshot-url \"<网址>\" --out \"<输出png完整路径>\"`;"
         "输出 SHOT_OK 表示已生成且校验过非空白,SHOT_BLANK 表示所有尝试都是空白页(换数据源或改渲染方案),不要把空白图当结果。" % (py, script)),
        "- 不要自己用 msedge --headless --screenshot 硬截:本机系统代理会让 ESPN 等站点返回 AWS 反爬挑战页,截出来是纯白图。",
        "- 比分/赛程优先查公开数据接口(如 site.api.espn.com)，生成文件限于当前授权工作区。",
        "- 生成图片/文件后,把完整路径写进最终答复,方便上层发送到微信。",
    ])


# ---------------------------------------------------------------- 可靠网页截图
SHOT_WIDTH, SHOT_HEIGHT = 1440, 1600
BROWSER_PATHS = (
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
)


def _find_browser() -> str:
    for raw in BROWSER_PATHS:
        if Path(raw).is_file():
            return raw
    return ""


def _image_blank_ratio(path: Path) -> float:
    """近白像素占比:1=全白。-1 表示没法判断(没装 PIL)。"""
    try:
        from PIL import Image
        im = Image.open(path).convert("L")
        hist = im.histogram()
        total = sum(hist)
        if not total:
            return 1.0
        return round(sum(hist[245:]) / total, 4)
    except Exception as exc:  # noqa: BLE001
        print(f"[shot] 空白检测不可用: {exc}")
        return -1.0


def _screenshot_once(browser: str, url: str, out: Path, width: int, height: int,
                     direct: bool, budget_ms: int = 12000) -> dict:
    import tempfile
    profile = Path(tempfile.mkdtemp(prefix="shot_profile_"))
    try:
        out.parent.mkdir(parents=True, exist_ok=True)
        if out.exists():
            out.unlink()
        argv = [browser, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                "--no-sandbox", "--no-first-run", "--no-default-browser-check",
                "--disable-extensions", "--force-device-scale-factor=1",
                "--virtual-time-budget=%d" % int(budget_ms),
                "--window-size=%d,%d" % (int(width), int(height)),
                "--user-data-dir=" + str(profile),
                "--screenshot=" + str(out)]
        if direct:
            argv.append("--no-proxy-server")
        argv.append(url)
        res = run_capture(argv, str(SCRIPT_DIR), 75)
        if not out.is_file() or out.stat().st_size < 400:
            detail = (res["stderr"] or res["stdout"] or "").strip()[:200] or ("exit=%s" % res["code"])
            return {"ok": False, "err": "没有生成图片: " + detail}
        ratio = _image_blank_ratio(out)
        if ratio < 0 or ratio < 0.985:
            return {"ok": True, "ratio": ratio, "bytes": out.stat().st_size}
        return {"ok": False, "blank": True, "ratio": ratio, "bytes": out.stat().st_size}
    finally:
        shutil.rmtree(str(profile), ignore_errors=True)


def screenshot_url(url: str, out, cfg: dict, width=None, height=None) -> dict:
    """网页截图:先直连(绕过系统代理/反爬挑战),空白或失败再换策略;返回前用像素比例校验空白。"""
    raw = str(url or "").strip()
    parsed = urlparse(raw)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return {"ok": False, "error": "SCREENSHOT_URL_DENIED：只允许 http/https 网页，不能读取本地文件。"}
    out = resolve_path(str(out), cfg)
    artifact_root = resolve_path("screenshots", cfg)
    if artifact_root not in out.parents or out.suffix.lower() != ".png" or out.exists():
        return {"ok": False, "error": "SCREENSHOT_OUTPUT_DENIED：只允许 screenshots 目录中的新 PNG 文件。"}
    browser = _find_browser()
    if not browser:
        return {"ok": False, "error": "找不到 Edge/Chrome,没法截图"}
    width = max(320, min(int(width or cfg.get("screenshot_width") or SHOT_WIDTH), 2560))
    height = max(240, min(int(height or cfg.get("screenshot_height") or SHOT_HEIGHT), 8000))
    out = Path(out)
    attempts = [
        {"direct": True, "w": width, "h": height, "budget": 22000, "label": "直连"},
        {"direct": True, "w": width, "h": height, "budget": 30000, "label": "直连-加长等待"},
        {"direct": False, "w": width, "h": height, "budget": 22000, "label": "系统代理"},
        {"direct": True, "w": min(width, 1280), "h": min(height, 900), "budget": 22000, "label": "直连-小画布"},
    ]
    last = {"ok": False, "error": "截图失败"}
    for i, at in enumerate(attempts, 1):
        res = _screenshot_once(browser, raw, out, at["w"], at["h"], at["direct"], at["budget"])
        if res.get("ok"):
            res.update(path=str(out), url=raw, strategy=at["label"], tries=i,
                       width=at["w"], height=at["h"])
            print(f"[shot] ok {out.name} {res['width']}x{res['height']} {res['bytes']}B "
                  f"ratio={res['ratio']} 第{i}次({at['label']})")
            return res
        reason = res.get("err") or ("纯空白图 ratio=%s" % res.get("ratio"))
        last = {"ok": False, "error": "%s 不行(第%d次: %s)" % (at["label"], i, reason)}
        print(f"[shot] 第{i}次失败: {last['error']}")
        if out.exists():
            try:
                out.unlink()
            except OSError:
                pass
    return last


def tool_screenshot_url(args: dict, cfg: dict) -> list:
    url = (args.get("url") or "").strip()
    if not url:
        raise ValueError("url 不能为空")
    raw_out = str(args.get("path") or "").strip()
    if raw_out:
        out = resolve_path(raw_out, cfg)
    else:
        out = resolve_path(str(Path(cfg["workspace_root"]) / "screenshots" / (
            "shot_%s_%s.png" % (time.strftime("%Y%m%d_%H%M%S"), uuid.uuid4().hex[:4]))), cfg)
    res = screenshot_url(url, out, cfg, args.get("width"), args.get("height"))
    if not res.get("ok"):
        raise ToolExecutionError("【截图失败】%s\n所有尝试都没拿到非空白截图(常见原因:网站要登录/要过人机验证/"
                "强依赖交互,或被本机代理拦成反爬挑战页)。建议改用公开数据接口(如 fetch_scores)"
                "或换数据源,不要交空白图。" % res.get("error", ""))
    raw = out.read_bytes()
    content = [{"type": "text", "text": "截图已生成并返回本次工具请求；未独立发送微信。"}]
    if len(raw) <= 3 * 1024 * 1024:
        content.append({"type": "image", "data": base64.b64encode(raw).decode("ascii"), "mimeType": "image/png"})
    else:
        content[0]["text"] += "下载链接：" + share_file(out, cfg)
    return content


# ----------------------------------------------------------------------------- 网页正文

def _looks_challenge(page: str) -> bool:
    sample = (page or "")[:20000]
    if len(sample) < 200:
        return True
    lowered = sample.lower()
    return ("awswaf" in lowered or "challenge-container" in lowered or
            ("gokuprops" in lowered and len(sample) < 5000))


def _decompress_body(raw: bytes, encoding: str = "") -> bytes:
    """按 Content-Encoding / magic 解压响应体。br 没装库时抛错让上层换浏览器方式。"""
    if not raw:
        return raw
    if "gzip" in encoding or raw[:2] == b"\x1f\x8b":
        try:
            return gzip.decompress(raw)
        except OSError:
            return raw
    if "deflate" in encoding:
        for wbits in (zlib.MAX_WBITS, -zlib.MAX_WBITS):
            try:
                return zlib.decompress(raw, wbits)
            except zlib.error:
                continue
        return raw
    if "br" in encoding:
        try:
            import brotli  # type: ignore
        except ImportError as exc:
            raise RuntimeError("服务器要求 brotli 压缩,本机没有解压库") from exc
        return brotli.decompress(raw)
    return raw


def _garbled_text(page: str) -> bool:
    """启发式判断解码后的正文是不是压缩二进制/乱码。"""
    sample = (page or "")[:4000]
    if not sample:
        return False
    bad = sum(1 for ch in sample if ch == "\ufffd" or (ord(ch) < 32 and ch not in "\r\n\t"))
    return bad / float(len(sample)) > 0.02


def _strip_html(page: str) -> tuple[str, str]:
    """HTML -> (标题, 正文纯文本)。去脚本/样式/注释,块级标签换行。"""
    raw = page or ""
    title_match = re.search(r"<title[^>]*>(.*?)</title>", raw, re.I | re.S)
    title = html.unescape(re.sub(r"\s+", " ", title_match.group(1))).strip() if title_match else ""
    text = re.sub(r"<!--.*?-->", " ", raw, flags=re.S)
    text = re.sub(r"<(script|style|noscript|template|svg|canvas|iframe)\b.*?</\1>", " ", text, flags=re.I | re.S)
    text = re.sub(r"<(br|/p|/div|/li|/h[1-6]|/tr|/section|/article|/blockquote)[^>]*>", "\n", text, flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    text = html.unescape(text)
    text = re.sub(r"[ \t\u00a0]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n\n", text)
    return title, text.strip()


def _fetch_webpage(url: str, cfg: dict, timeout: int = 25) -> tuple[str, str]:
    """返回 (最终 URL, HTML)。先直连,失败或像反爬挑战页再走本机代理。"""
    proxy = str(cfg.get("proxy") or "").strip()
    attempts = [None]
    if proxy:
        attempts.append(proxy)
    errors = []
    for proxy_url in attempts:
        try:
            handlers = [urllib.request.ProxyHandler({"http": proxy_url, "https": proxy_url} if proxy_url else {})]
            opener = urllib.request.build_opener(*handlers)
            request = urllib.request.Request(url, headers={
                "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                               "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"),
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
                "Accept-Encoding": "identity",
                "Connection": "close",
            })
            with opener.open(request, timeout=timeout) as response:
                final = response.geturl()
                charset = response.headers.get_content_charset() or "utf-8"
                encoding = (response.headers.get("Content-Encoding") or "").lower()
                raw = response.read(900_000)
            raw = _decompress_body(raw, encoding)
            try:
                page = raw.decode(charset, "replace")
            except LookupError:
                page = raw.decode("utf-8", "replace")
            if _garbled_text(page):
                errors.append("%s: 正文是乱码(压缩/编码没解对)" % (proxy_url or "直连"))
                continue
            if _looks_challenge(page):
                errors.append("%s: 反爬挑战页" % (proxy_url or "直连"))
                continue
            return final, page
        except Exception as exc:  # noqa: BLE001 - 逐个策略尝试
            errors.append("%s: %s" % (proxy_url or "直连", exc))
    raise RuntimeError("; ".join(errors))


def _browser_dom(url: str, cfg: dict, timeout: int = 80) -> tuple[str, str]:
    """用 Edge/Chrome headless 的 --dump-dom 兜底取渲染后的 DOM。"""
    browser = _find_browser()
    if not browser:
        raise RuntimeError("找不到 Edge/Chrome")
    profile = resolve_path(str(Path(cfg["workspace_root"]) / ".browser_tmp" / ("dom_" + uuid.uuid4().hex[:8])), cfg)
    profile.mkdir(parents=True, exist_ok=True)
    direct_env = {"HTTP_PROXY": "", "HTTPS_PROXY": "", "ALL_PROXY": "",
                  "http_proxy": "", "https_proxy": "", "all_proxy": ""}
    attempts = [(direct_env, "直连"), (None, "系统代理")]
    errors = []
    try:
        for env, label in attempts:
            argv = [browser, "--headless=new", "--no-sandbox", "--hide-scrollbars",
                    "--disable-gpu", "--disable-extensions", "--virtual-time-budget=22000",
                    "--user-data-dir=%s" % profile, "--dump-dom", url]
            if env:
                argv.insert(2, "--no-proxy-server")
            result = run_capture(argv, None, timeout, env)
            page = result.get("stdout") or ""
            if result.get("ok") and page.strip() and not _looks_challenge(page):
                return url, page
            errors.append("%s: %s" % (label, str(result.get("stderr") or "空页面")[:160]))
    finally:
        shutil.rmtree(profile, ignore_errors=True)
    raise RuntimeError("; ".join(errors))


def read_web_page(url: str, cfg: dict, max_chars: int = 6000) -> dict:
    """取网页正文: 直连 -> 代理 -> headless 浏览器 DOM。"""
    url = (url or "").strip()
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        return {"ok": False, "error": "只支持 http/https 网址"}
    errors = []
    for method, fetch in (("http", _fetch_webpage), ("browser", _browser_dom)):
        try:
            final, page = fetch(url, cfg)
            title, text = _strip_html(page)
            if len(text) < 40:
                errors.append("%s: 正文为空" % method)
                continue
            limit = max(500, min(int(max_chars or 6000), 12000))
            return {"ok": True, "url": final, "title": title, "text": text[:limit],
                    "chars": len(text), "truncated": len(text) > limit, "method": method}
        except Exception as exc:  # noqa: BLE001 - 换下一种方式
            errors.append("%s: %s" % (method, exc))
    return {"ok": False, "error": "; ".join(errors)}


def tool_read_web_page(args: dict, cfg: dict) -> str:
    url = (args.get("url") or "").strip()
    if not url:
        raise ValueError("url 不能为空")
    result = read_web_page(url, cfg, args.get("max_chars"))
    if not result.get("ok"):
        raise ToolExecutionError("【读取失败】%s\n原因: %s\n不要编造正文;可以请对方把正文复制发来,"
                "或换一个公开数据接口。" % (url, result.get("error", "")))
    return ("【网页正文·已读取】%s\n标题: %s\n方式: %s,共 %s 字%s\n---\n%s" % (
        result["url"], result["title"] or "(无标题)", result["method"],
        f"{result['chars']:,}", "(已截断)" if result["truncated"] else "", result["text"]))


TOOLS = [
    {
        "name": "fetch_paper",
        "description": (
            "下载学术论文 PDF 到电脑(优先开放获取:Unpaywall / Semantic Scholar / arXiv)。"
            "传 DOI(如 10.1038/xxx)或论文标题或 arXiv 编号。"
            "下载成功返回工作区内文件路径与单文件限时下载链接；不独立发送微信。"
            "如果是订阅刊且没有开放版本,会明确说明需要机构权限。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "DOI、论文标题或 arXiv 编号。"},
            },
            "required": ["query"],
            "additionalProperties": False,
        },
    },
    {
        "name": "gpt_draw",
        "description": (
            "通过固定免费图片接口同步生成，作为本次工具结果返回，不独立发送微信。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "prompt": {"type": "string", "description": "画什么,尽量具体(主体、风格、画面元素)。"},
                "engine": {"type": "string", "description": "free=免费通道(默认,几秒,不吃额度);gpt=用用户 GPT 账号(1-2 分钟,消耗额度,质量更好)。"},
                "target": {"type": "string", "description": "发到哪个聊天:群名(如「命就是好」「群里只有一个好人」)、群号或「私聊」。不传则不独立外发；禁止按最近聊天推断。外发还须提供 account、target_kind、request_id。"},
            },
            "required": ["prompt"],
            "additionalProperties": False,
        },
    },
    {
        "name": "ask_gpt",
        "description": (
            "让这台电脑上的 ChatGPT(用户本人的 GPT 账号,Codex CLI)回答一个问题。"
            "适合需要 GPT 的观点/写作/代码建议、或用户明确说“问 GPT”的时候。"
            "注意:一次约 25-40 秒,所以简单事实查询优先用 fetch_scores / fetch_player_stats / web_search。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "prompt": {"type": "string", "description": "要问 GPT 的完整问题。"},
                "timeout_seconds": {"type": "integer", "description": "最多等多久,默认 240 秒。"},
            },
            "required": ["prompt"],
            "additionalProperties": False,
        },
    },
    {
        "name": "fetch_player_stats",
        "description": (
            "查 NBA 球员数据榜(虎扑中文源,球员名和球队都是中文)。"
            "支持 category=pts/reb/asts/stl/blk/all,默认 all 返回得分/篮板/助攻/抢断/盖帽 5 个榜。"
            "用户问球员数据、谁得分最高、篮板王之类的问题时用它。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "category": {"type": "string", "description": "pts/reb/asts/stl/blk/all,默认 all。"},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "fetch_scores",
        "description": (
            "查赛事比分和赛程(直接读公开数据接口,不截图、不怕网站反爬)。"
            "支持 nba / nfl / mlb / nhl / soccer / epl / laliga / ucl / csl / tennis / f1 等。"
            "用户要看今天的比分、赛程、结果时优先用它,不要用截图或 run_local_agent。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "sport": {"type": "string", "description": "赛事代号,默认 nba;可选 nba/nfl/mlb/nhl/soccer/epl/laliga/ucl/csl/tennis/f1。"},
                "date": {"type": "string", "description": "比赛日期,格式 YYYYMMDD;不填就是今天。"},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "pc_status",
        "description": "查看这台电脑的状态:主机名、系统、工作区、局域网 IP、dsh 命令是否可用。排查连不上时先调它。",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "run_local_agent",
        "description": (
            "在这台电脑上执行一个任务(异步)。调用会立刻返回「已开始」,任务在电脑上跑,"
            "做完后结果由电脑**直接发到微信**——你不用再轮询,也不要答应主人稍后再说。"
            "适合:查资料、翻多个网页、整理文档、跑脚本、生成图表。立即回主人一句「在查了」即可。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "task": {"type": "string", "description": "要在这台电脑上完成的任务,用自然语言描述,可以带上具体路径。"},
                "wait_seconds": {"type": "integer", "description": "最多同步等多久(默认 45)。"},
                "timeout_seconds": {"type": "integer", "description": "任务总超时(默认 600)。"},
                "target": {"type": "string", "description": "发到哪个聊天:群名(如「命就是好」「群里只有一个好人」)、群号或「私聊」。不传则不独立外发；禁止按最近聊天推断。外发还须提供 account、target_kind、request_id。"},
            },
            "required": ["task"],
            "additionalProperties": False,
        },
    },
    {
        "name": "local_agent_status",
        "description": (
            "查后台任务。两种用法:①传 job_id=查询/等待某个任务的结果(默认最多等 75 秒);"
            "②不传 job_id=列出后台正在跑的任务和最近结束的任务(主人问『后台还在跑吗』时用这个)。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "job_id": {"type": "string", "description": "任务 id;不传=列出正在跑和最近完成的任务。"},
                "wait_seconds": {"type": "integer", "description": "最多等多少秒(默认 75,上限 110)。"},
            },
            "required": [],
            "additionalProperties": False,
        },
    },
    {
        "name": "list_local_dir",
        "description": "列出这台电脑上的目录内容(默认在工作区内)。",
        "inputSchema": {
            "type": "object",
            "properties": {"path": {"type": "string", "description": "相对工作区的路径,或绝对路径(需开启越界访问)。"}},
            "required": ["path"],
            "additionalProperties": False,
        },
    },
    {
        "name": "read_local_file",
        "description": "读取这台电脑上的文本文件。",
        "inputSchema": {
            "type": "object",
            "properties": {"path": {"type": "string"}, "max_bytes": {"type": "integer", "minimum": 1, "maximum": MAX_READ_FILE_BYTES}},
            "required": ["path"],
            "additionalProperties": False,
        },
    },
    {
        "name": "write_local_file",
        "description": "把文本内容写进这台电脑上的文件(会创建目录)。",
        "inputSchema": {
            "type": "object",
            "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
            "required": ["path", "content"],
            "additionalProperties": False,
        },
    },
    {
        "name": "run_local_shell",
        "description": "直接在这台电脑上执行一条命令(默认关闭,需在 config.json 打开 allow_shell)。优先用 run_local_agent。",
        "inputSchema": {
            "type": "object",
            "properties": {"command": {"type": "string"}, "timeout_seconds": {"type": "integer"}},
            "required": ["command"],
            "additionalProperties": False,
        },
    },
    {
        "name": "export_file",
        "description": (
            "把一个文件作为真实微信文件消息发出去(Word/PDF/Excel/压缩包等)。支持发到主人私聊、群聊和已校准的联系人;群里发文件必须显式传 target=当前群名。目标聊天如果还没校准过标题指纹会拒发并说明原因。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "文件路径,相对工作区或绝对路径。"},
                "target": {"type": "string", "description": "发到哪个聊天:群名(如「命就是好」「群里只有一个好人」)、群号或「私聊」。不传则不独立外发；禁止按最近聊天推断。外发还须提供 account、target_kind、request_id。"},
            },
            "required": ["path"],
            "additionalProperties": False,
        },
    },
    {
        "name": "send_image",
        "description": (
            "把一张图片直接发给用户(以 image 内容返回,微信里应该能直接看到)。"
            "图表、截图、仿真结果图都走它;同时会带一个备用下载链接。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "图片路径(png/jpg/gif/webp/bmp)。"},
                "caption": {"type": "string", "description": "可选的一句话说明。"},
                "target": {"type": "string", "description": "发到哪个聊天:群名(如「命就是好」「群里只有一个好人」)、群号或「私聊」。不传则不独立外发；禁止按最近聊天推断。外发还须提供 account、target_kind、request_id。"},
            },
            "required": ["path"],
            "additionalProperties": False,
        },
    },
    {
        "name": "screenshot_url",
        "description": (
            "网页截图(可靠版):自动先直连后走系统代理,截图后用像素检测空白,空白自动换策略重试;"
            "成功向本次工具请求返回图片或单文件下载链接，不独立发送微信。"
            "网页截图一律用它,不要自己用 headless 浏览器命令截(本机代理会让 ESPN 等站点返回反爬挑战页、截出纯白图)。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "要截图的 http/https 网页，不接受本地文件。"},
                "path": {"type": "string", "description": "可选:工作区 screenshots/ 内尚不存在的 PNG 路径。"},
                "width": {"type": "integer", "description": "可选:视口宽度,默认 1440。"},
                "height": {"type": "integer", "description": "可选:视口高度,默认 1600(长页面可调大)。"},
            },
            "required": ["url"],
            "additionalProperties": False,
        },
    },
    {
        "name": "read_web_page",
        "description": (
            "读取网页正文。传 http(s) 网址,返回标题和正文纯文本;可用来读微信里分享的链接、"
            "B站/公众号/新闻/博客正文。先直连,不行自动走本机代理,再不行用 headless 浏览器"
            "渲染后取 DOM;仍失败会明确报错(不要凭标题编造正文)。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "要读的网页地址(http/https)。"},
                "max_chars": {"type": "integer", "description": "可选:最多返回多少字,默认 6000,上限 12000。"},
            },
            "required": ["url"],
            "additionalProperties": False,
        },
    },
]

# Expose only this transport's verifiable business capabilities. Metadata for
# withheld legacy names is reported by health, never as executable schemas.
TOOLS = [tool for tool in TOOLS if tool["name"] in BUSINESS_QUERY_TOOLS]
for _tool in TOOLS:
    if _tool["name"] == "gpt_draw":
        _tool["description"] = "通过固定免费图片接口生成并返回本次请求的图片结果；不运行通用 CLI、不启动后台任务、不独立发微信。"
        _tool["inputSchema"]["properties"] = {
            "prompt": {"type": "string", "maxLength": 4000},
            "engine": {"type": "string", "enum": ["free"], "default": "free"},
        }


TOOL_HANDLERS = {
    "pc_status": tool_pc_status,
    "run_local_agent": tool_run_agent,
    "local_agent_status": tool_job_status,
    "list_local_dir": tool_list_dir,
    "read_local_file": tool_read_file,
    "write_local_file": tool_write_file,
    "run_local_shell": tool_shell,
    "export_file": tool_export_file,
    "screenshot_url": tool_screenshot_url,
    "read_web_page": tool_read_web_page,
    "send_image": tool_send_image,
    "fetch_scores": tool_fetch_scores,
    "fetch_player_stats": tool_fetch_player_stats,
    "ask_gpt": tool_ask_gpt,
    "gpt_draw": tool_gpt_draw,
    "fetch_paper": tool_fetch_paper,
}


def call_tool(params: dict, cfg: dict) -> dict:
    if not isinstance(params, dict) or not isinstance(params.get("name"), str):
        return {"content": [{"type": "text", "text": "工具请求须包含字符串名称"}], "isError": True}
    name = params["name"]
    arguments = params.get("arguments", {})
    if not isinstance(arguments, dict):
        return {"content": [{"type": "text", "text": "工具参数须为对象"}], "isError": True}
    if name in DISABLED_CONTROL_TOOLS:
        return {"content": [{"type": "text", "text": "LEGACY_CONTROL_CONTEXT_UNAVAILABLE：控制关闭，不能用配置、请求字段或服务令牌扩大权限。"}], "isError": True}
    if name in DISABLED_AUXILIARY_TOOLS:
        return {"content": [{"type": "text", "text": "LEGACY_TEXT_WORKER_POLICY_UNAVAILABLE：查询别名不能启动未隔离的通用 worker。"}], "isError": True}
    if name not in BUSINESS_QUERY_TOOLS:
        return {"content": [{"type": "text", "text": f"没有这个工具: {name}"}], "isError": True}
    handler = TOOL_HANDLERS.get(name)
    if handler is None:
        return {"content": [{"type": "text", "text": f"没有这个工具: {name}"}], "isError": True}
    try:
        if name == "pc_status":
            result = handler(cfg)
        else:
            result = handler(arguments, cfg)
    except Exception as exc:  # noqa: BLE001 - 工具错误要回给模型,不能炸掉服务
        return {"content": [{"type": "text", "text": f"{name} 出错: {exc}"}], "isError": True}
    content = result if isinstance(result, list) else [{"type": "text", "text": result}]
    return {"content": content, "isError": False}


# ----------------------------------------------------------------------------- JSON-RPC

def rpc_error(msg_id, code: int, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": code, "message": message}}


def handle_rpc(message: dict, cfg: dict) -> dict | None:
    if not isinstance(message, dict):
        return rpc_error(None, -32600, "不是合法的 JSON-RPC 消息")
    method = message.get("method")
    msg_id = message.get("id")
    params = message.get("params") or {}

    if method is None:
        return None  # 客户端发来的 response,忽略
    if not isinstance(method, str) or not isinstance(params, dict):
        return rpc_error(msg_id, -32600, "方法须为字符串，参数须为对象")
    if method.startswith("notifications/"):
        return None

    # 记一行日志:排障时能看出 DSH/微信那边到底连没连上、调了什么
    detail = ""
    if method == "tools/call":
        detail = " " + str(params.get("name"))
    elif method == "initialize":
        client_info = params.get("clientInfo")
        detail = " from " + str(client_info.get("name") if isinstance(client_info, dict) else "unknown")
    print(f"[{time.strftime('%H:%M:%S')}] {method}{detail}")

    try:
        if method == "initialize":
            requested = params.get("protocolVersion")
            result = {
                "protocolVersion": (requested if requested in SUPPORTED_PROTOCOL_VERSIONS
                                    else SUPPORTED_PROTOCOL_VERSIONS[0]),
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
                "instructions": (
                    "这是受限的本机业务查询服务。电脑控制关闭，服务令牌不是当前会话的控制授权。"
                    "仅公开 tools/list 内的查询能力：比分、球员、论文、网页、截图、状态和免费图片生成。"
                    "不公开任意文件读取/写入、命令、agent、旧消息发送或通用 Codex worker。"
                    "旧名称调用会明确拒绝；配置布尔值、account、scope、executionPolicy 等请求字段不能解锁。"
                    "工具结果不代表已独立发送微信；失败时如实说明，不要猜测收件人或重复外发。"
                ),
            }
        elif method == "ping":
            result = {}
        elif method == "tools/list":
            result = {"tools": TOOLS}
        elif method == "tools/call":
            result = call_tool(params, cfg)
        elif method == "resources/list":
            result = {"resources": []}
        elif method == "resources/templates/list":
            result = {"resourceTemplates": []}
        elif method == "prompts/list":
            result = {"prompts": []}
        elif method in ("logging/setLevel", "completion/complete"):
            result = {}
        else:
            return rpc_error(msg_id, -32601, f"不支持的方法: {method}")
    except Exception as exc:  # noqa: BLE001
        return rpc_error(msg_id, -32603, f"{type(exc).__name__}: {exc}")

    if msg_id is None:
        return None
    return {"jsonrpc": "2.0", "id": msg_id, "result": result}


# ----------------------------------------------------------------------------- HTTP 层

SSE_SESSIONS: dict[str, "queue.Queue[dict]"] = {}
SSE_LOCK = threading.Lock()


def token_equal(given: str, expected: str) -> bool:
    try:
        return secrets.compare_digest(given, expected)
    except TypeError:  # 非 ASCII 令牌(有人会手改成中文)退回普通比较
        return given == expected


class BridgeHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    cfg: dict = {}

    # 静音默认的访问日志(SSE 长连接会刷屏)
    def log_message(self, fmt: str, *args) -> None:  # noqa: N802
        return

    # ----- 公共 -----
    def _query(self) -> dict:
        return parse_qs(urlparse(self.path).query)

    def _token_ok(self) -> bool:
        token = self.cfg.get("token") or ""
        if not token:
            return True
        candidates = []
        given = self._query().get("token")
        if given:
            candidates.append(given[0])
        auth = self.headers.get("Authorization") or ""
        if auth.lower().startswith("bearer "):
            candidates.append(auth[7:].strip())
        header_token = self.headers.get("X-MCP-Token")
        if header_token:
            candidates.append(header_token)
        return any(token_equal(c, token) for c in candidates)

    def _send_json(self, payload, status: int = 200, extra_headers: dict | None = None) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def _send_empty(self, status: int) -> None:
        self.send_response(status)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _read_body(self) -> bytes:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        return self.rfile.read(length) if length > 0 else b""

    def _deny(self) -> None:
        # An unauthorized POST body has not been consumed. Never treat it as
        # the start of the next request on a persistent connection.
        self.close_connection = True
        self._send_json({"error": "unauthorized"}, 403, {"Connection": "close"})

    # ----- GET -----
    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path.rstrip("/") or "/"
        if path == "/health":
            if not self._token_ok():
                return self._deny()
            return self._send_json({
                "ok": True,
                "server": SERVER_NAME,
                "version": SERVER_VERSION,
                "pid": os.getpid(),
                "sourceSha256": SOURCE_SHA256,
                "protocolVersions": list(SUPPORTED_PROTOCOL_VERSIONS),
                "deliveryPolicy": "legacy-control-disabled-v1",
                "controlPolicy": "no-trusted-session-control-transport-v1",
                "disabledTools": sorted(DISABLED_CONTROL_TOOLS | DISABLED_AUXILIARY_TOOLS),
                "toolCount": len(TOOLS),
                "dsh": " ".join(DSH_CMD) if DSH_CMD else None,
                "dsh_hint": DSH_HINT,
                "workspace": self.cfg["workspace_root"],
            })
        if path == "/sse":
            if not self._token_ok():
                return self._deny()
            return self._serve_sse()
        if path == "/mcp":
            return self._send_json({"error": "use POST for MCP messages"}, 405)
        if path.startswith("/files/"):
            if not _download_allowed(path[len("/files/" ):], self._query()):
                return self._deny()
            return self._serve_file(path[len("/files/"):])
        if path == "/":
            return self._send_json({
                "name": SERVER_NAME,
                "endpoints": {"sse": "/sse?token=…", "streamable": "/mcp?token=…", "health": "/health?token=…"},
                "hint": "手机上填 http://<电脑IP>:端口/sse?token=… 或 /mcp?token=…",
            })
        return self._send_json({"error": "not found"}, 404)

    # ----- POST -----
    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path.rstrip("/") or "/"
        if not self._token_ok():
            return self._deny()
        raw = self._read_body()
        try:
            payload = json.loads(raw.decode("utf-8")) if raw else None
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            return self._send_json(rpc_error(None, -32700, f"JSON 解析失败: {exc}"), 400)

        if path == "/messages":
            # 旧式 SSE 回传通道:响应走已经打开的 /sse 流
            session_id = (self._query().get("sessionId") or [""])[0]
            with SSE_LOCK:
                sink = SSE_SESSIONS.get(session_id)
            if sink is None:
                return self._send_json({"error": "unknown sessionId"}, 404)
            for message in (payload if isinstance(payload, list) else [payload]):
                response = handle_rpc(message, self.cfg)
                if response is not None:
                    sink.put(response)
            return self._send_empty(202)

        if path == "/mcp":
            messages = payload if isinstance(payload, list) else [payload]
            responses = [r for r in (handle_rpc(m, self.cfg) for m in messages) if r is not None]
            session_id = self.headers.get("Mcp-Session-Id") or ("sess_" + uuid.uuid4().hex[:12])
            headers = {"Mcp-Session-Id": session_id}
            if not responses:
                return self._send_empty(202)
            body = responses if isinstance(payload, list) else responses[0]
            return self._send_json(body, 200, headers)

        return self._send_json({"error": "not found"}, 404)

    def do_DELETE(self) -> None:  # noqa: N802
        self._send_empty(204)

    # ----- 文件下载 -----
    def _serve_file(self, raw_name: str) -> None:
        name = Path(unquote(raw_name)).name
        target = (SHARED_DIR / name).resolve()
        try:
            inside = target.parent == SHARED_DIR.resolve()
        except OSError:
            inside = False
        if not inside or not target.is_file():
            return self._send_json({"error": "not found"}, 404)
        data = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Content-Disposition", "attachment; filename*=UTF-8''" + quote(name))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        self.end_headers()
        self.wfile.write(data)

    # ----- SSE -----
    def _serve_sse(self) -> None:
        session_id = "sse_" + uuid.uuid4().hex[:12]
        sink: queue.Queue[dict] = queue.Queue()
        with SSE_LOCK:
            SSE_SESSIONS[session_id] = sink

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("Connection", "keep-alive")
        self.send_header("Transfer-Encoding", "chunked")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()

        def chunk(payload: bytes) -> None:
            self.wfile.write(f"{len(payload):X}\r\n".encode("ascii") + payload + b"\r\n")
            self.wfile.flush()

        token = self.cfg.get("token") or ""
        endpoint = f"/messages?sessionId={session_id}"
        if token:
            endpoint += f"&token={token}"
        try:
            chunk(f"event: endpoint\ndata: {endpoint}\n\n".encode("utf-8"))
            while True:
                try:
                    message = sink.get(timeout=20)
                    chunk(("event: message\ndata: " + json.dumps(message, ensure_ascii=False) + "\n\n").encode("utf-8"))
                except queue.Empty:
                    chunk(b": ping\n\n")
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            with SSE_LOCK:
                SSE_SESSIONS.pop(session_id, None)
            self.close_connection = True


# ----------------------------------------------------------------------------- 入口

def selftest(cfg: dict) -> int:
    # Static contract only: never run a real agent as a diagnostic side effect.
    names = {tool["name"] for tool in TOOLS}
    denied = all(call_tool({"name": name, "arguments": {}}, cfg)["isError"]
                 for name in DISABLED_CONTROL_TOOLS | DISABLED_AUXILIARY_TOOLS)
    passed = names == BUSINESS_QUERY_TOOLS and denied
    print(json.dumps({"ok": passed, "version": SERVER_VERSION, "toolCount": len(names),
                      "controlDisabled": denied, "scope": "static-contract-only"}, ensure_ascii=False))
    return 0 if passed else 1


def main() -> int:
    global DSH_CMD, DSH_HINT

    parser = argparse.ArgumentParser(description="把本机工具通过 MCP 暴露给手机上的微信 Agent")
    parser.add_argument("--host", help="监听地址;要让手机连用 0.0.0.0")
    parser.add_argument("--port", type=int, help="端口,默认 8765")
    parser.add_argument("--token", help="访问令牌,默认读 config.json")
    parser.add_argument("--regenerate-token", action="store_true", help="重新生成并保存 token")
    parser.add_argument("--selftest", action="store_true", help="只做本机自检,不开服务器")
    parser.add_argument("--show-config", action="store_true", help="打印当前配置后退出")
    parser.add_argument("--screenshot-url", help="只截图:把网页保存成 PNG 后退出")
    parser.add_argument("--out", help="截图输出路径(配合 --screenshot-url)")
    parser.add_argument("--width", type=int, help="截图视口宽度,默认 1440")
    parser.add_argument("--height", type=int, help="截图视口高度,默认 1600")
    args = parser.parse_args()

    cfg = load_config()
    if args.host:
        cfg["host"] = args.host
    if args.port:
        cfg["port"] = args.port
    if args.regenerate_token:
        cfg["token"] = secrets.token_urlsafe(18)
        save_config(cfg)
    if args.token:
        cfg["token"] = args.token

    if os.environ.get("DSH_CMD"):
        DSH_CMD, DSH_HINT = find_dsh_command()

    if args.show_config:
        print(json.dumps(cfg, ensure_ascii=False, indent=2))
        return 0
    if args.screenshot_url:
        root = Path(cfg.get("workspace_root") or str(SCRIPT_DIR.parent))
        out_raw = (args.out or "").strip()
        out = Path(out_raw) if out_raw else (root / "screenshots" /
                                            ("shot_%s.png" % time.strftime("%Y%m%d_%H%M%S")))
        shot = screenshot_url(args.screenshot_url, out, cfg, args.width, args.height)
        if shot.get("ok"):
            print("SHOT_OK %s %dx%d %sB 非空白(ratio=%.4f) 策略=%s 第%d次" % (
                shot["path"], shot["width"], shot["height"], f"{shot['bytes']:,}",
                shot["ratio"], shot["strategy"], shot["tries"]))
            return 0
        print("SHOT_BLANK %s" % shot.get("error", "截图失败"))
        return 9
    if args.selftest:
        return selftest(cfg)

    cfg["workspace_root"] = str(Path(cfg["workspace_root"]).resolve())
    Path(cfg["workspace_root"]).mkdir(parents=True, exist_ok=True)

    if cfg["host"] in ("0.0.0.0", "::") and not cfg["token"]:
        print("[!] 监听 0.0.0.0 却没设 token,拒绝启动。先跑一次让程序生成 token,或用 --token 指定。", file=sys.stderr)
        return 2

    server_cls = type("BridgeServer", (ThreadingHTTPServer,), {"daemon_threads": True})
    try:
        httpd = server_cls((cfg["host"], cfg["port"]), BridgeHandler)
    except OSError as exc:
        print(f"[!] 端口 {cfg['port']} 起不来({exc})。", file=sys.stderr)
        print("    多半是已经有一个在跑了。看看 /health 有没有响应,"
              "或者用 stop_server.bat 停掉旧的再启动。", file=sys.stderr)
        return 3
    BridgeHandler.cfg = cfg

    ip = lan_ip()
    base = f"http://{ip}:{cfg['port']}" if cfg["host"] in ("0.0.0.0", "::") else f"http://{cfg['host']}:{cfg['port']}"
    token = cfg["token"]

    print("=" * 66)
    print(f" {SERVER_NAME} v{SERVER_VERSION} 已启动")
    print("=" * 66)
    print(f" 监听      : {cfg['host']}:{cfg['port']}")
    print(f" 工作区    : {cfg['workspace_root']}")
    print(f" dsh 命令  : {' '.join(DSH_CMD) if DSH_CMD else '未找到 —— run_local_agent 会失败'}")
    print(f"             ({DSH_HINT})")
    print(" token     : 已配置（不写入日志；由本机配置管理）")
    print("-" * 66)
    print(" 手机上(MCP 配置)填这两个之一:")
    print(f"   SSE / HTTP+SSE : {base}/sse （需控制凭据）")
    print(f"   Streamable HTTP: {base}/mcp （需控制凭据）")
    print(f" 先在手机浏览器打开这个验证连通性:")
    print(f"   {base}/health （需控制凭据）")
    print("=" * 66)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
