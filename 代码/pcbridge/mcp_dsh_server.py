#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
dsh-pc-bridge —— 把本机工具(经由 DSH headless)通过 MCP 暴露给手机端的微信 Agent。

设计要点
--------
* 只依赖 Python 标准库,不需要 pip install 任何东西。
* 同时提供两种 MCP HTTP 传输,模块支持哪种都能连:
    - 旧式 HTTP+SSE :  GET  /sse?token=...      (先下发 endpoint 事件,再 POST /messages?sessionId=...)
    - Streamable HTTP:  POST /mcp?token=...
* 真正干活的是本机的 `dsh --profile headless "<任务>"`,它自带文件 / 命令 / Office / 网页等全套工具,
  所以主工具只有一个 run_local_agent,其余几个是给模型快速试探、排障用的轻量工具。
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
import json
import os
import queue
import re
import secrets
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import uuid
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse

SERVER_NAME = "dsh-pc-bridge"
SERVER_VERSION = "0.1.0"
# Only advertise the protocol revision implemented by this compatibility server.
# Full connection lifecycle and SDK migration remain a separate task.
SUPPORTED_PROTOCOL_VERSIONS = ("2025-03-26",)
MAX_READ_FILE_BYTES = 1024 * 1024
DEFAULT_PORT = 8765
SCRIPT_DIR = Path(__file__).resolve().parent
CONFIG_PATH = SCRIPT_DIR / "config.json"

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
    # 允许 agent / 文件工具触碰的根目录;留空 = 脚本的上一级目录
    "workspace_root": "",
    # 是否允许 run_local_shell 直接执行命令(默认关,走 dsh 更安全)
    "allow_shell": False,
    # 文件工具是否允许越出 workspace_root
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
    """把文件复制到 shared/,返回手机可下载的 URL(带 token)。"""
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
    return f"{public_base(cfg)}/files/{quote(dest.name)}?token={cfg.get('token', '')}"


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
            "stderr": f"超过 {timeout} 秒仍未结束,已终止。",
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
        "【执行提示(优先于任务里的做法)】\n"
        "1. 一条命令能解决就别写脚本,不要装依赖、不要反复调试。\n"
        "2. 给网页截图直接用这条(换 URL 和输出路径),不要用 CDP / Selenium / Playwright:\n"
        "   & 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' --headless=new --disable-gpu "
        "--hide-scrollbars --no-sandbox --user-data-dir='F:\\deepseek工作区\\.edge_tmp' "
        "--screenshot='F:\\deepseek工作区\\shot.png' --window-size=1440,900 'URL'\n"
        "   命令返回后等 1~2 秒再检查文件是否存在,不要反复重试同一命令。\n"
        "3. 整个任务控制在 6 步以内;同一条路试两次不成就换最简单的办法。\n"
        "4. 最后只回复结果本身(文件路径 / 查到的数据),不要罗列过程。\n\n"
        "【任务】\n"
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
    if not cfg.get("allow_outside_workspace"):
        if target != root and root not in target.parents:
            raise ValueError(
                f"路径越界: {target} 不在工作区 {root} 之内。"
                f"(要放开就改 config.json 的 allow_outside_workspace)"
            )
    return target


# ----------------------------------------------------------------------------- 后台任务

class Job:
    def __init__(self, task: str, timeout: int, cfg: dict):
        self.id = "job_" + uuid.uuid4().hex[:10]
        self.task = task
        self.timeout = timeout
        self.cfg = cfg
        self.started = time.time()
        self.done = threading.Event()
        self.result: dict | None = None
        self.answered_inline = False   # 结果已经通过工具返回值给了模型
        self.pushed = False            # 结果已经由服务端直接推进微信
        self.target = ""               # 结果要推到哪个聊天
        self.target_key = ""           # 结果要推到的会话键(给插件汇报用)
        self.label = ""                # 任务简短描述(给状态查询用)
        self.finished = 0.0            # 结束时间
        self.thread = threading.Thread(target=self._run, daemon=True)

    def start(self) -> "Job":
        self.thread.start()
        return self

    def _run(self) -> None:
        try:
            env = dict(os.environ)
            env.update(proxy_env(self.cfg))
            env.update(dict(DSH_EXTRA_ENV))
            mode = self.cfg.get("nested_permission_mode")
            if mode:
                env["DSH_PERMISSION_MODE"] = str(mode)
            self.result = run_capture(
                dsh_args(self.task),
                str(Path(self.cfg["workspace_root"])),
                self.timeout,
                env,
            )
            if self.result['ok'] and not (self.result['stdout'].strip() or self.result['stderr'].strip()):
                self.result.update(ok=False, stderr='执行进程没有返回任何内容；任务未确认完成，请查看执行日志。')
        except Exception as exc:  # noqa: BLE001 - 任何异常都要变成可读结果
            self.result = {"ok": False, "code": None, "stdout": "", "stderr": f"执行异常: {exc}", "elapsed": 0.0}
        finally:
            self.finished = time.time()
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
        f"shell 工具: {'开启' if cfg.get('allow_shell') else '关闭'}",
        f"越界访问: {'允许' if cfg.get('allow_outside_workspace') else '禁止'}",
    ]
    if DSH_CMD:
        probe = run_capture(list(DSH_CMD) + ["--version"], str(root), 25, DSH_EXTRA_ENV)
        version = (probe["stdout"] + probe["stderr"]).strip().splitlines()
        lines.append(f"dsh 版本探测: {version[0] if version else '(无输出)'}")
    return "\n".join(lines)


def wechat_push_text(text: str, cfg: dict) -> bool:
    """任务完成后由服务端直接把结果文本发进微信(不经过模型,所以够快)。"""
    script = SCRIPT_DIR / "send_wechat_native.ps1"
    if not script.exists():
        print("[push] 缺少 send_wechat_native.ps1")
        return False
    try:
        push_dir = SCRIPT_DIR / "shared"
        push_dir.mkdir(parents=True, exist_ok=True)
        payload = push_dir / f"push_{uuid.uuid4().hex[:8]}.txt"
        payload.write_text(text, "utf-8")
        argv = ["powershell.exe", "-STA", "-NoProfile", "-ExecutionPolicy", "Bypass",
                "-File", str(script), "-TextFile", str(payload), "-Mode", "text"]
        argv += wechat_ui_target_args(cfg)
        result = run_capture(argv, str(SCRIPT_DIR), 150)
        out = ((result["stdout"] or "") + "\n" + (result["stderr"] or ""))
        if "SENT" in out:
            print("[push] 结果已推送到微信")
            return True
        print("[push] 推送失败: " + out.strip().replace("\n", " ")[:250])
        return False
    except Exception as exc:  # noqa: BLE001
        print(f"[push] 推送异常: {exc}")
        return False


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
    if mode == "natural":
        return "做完我会用一两句话把结果告诉你,不用再问"
    return "做完之后结果会**自动直接发到微信**,你不用再问"


def _chat_key_map(cfg: dict) -> dict:
    """聊天显示名 -> 会话键(如 wechat:private:1253808542)。"""
    try:
        path = Path(cfg.get("wechat_social_messages") or SOCIAL_MESSAGES)
        data = json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except Exception as exc:  # noqa: BLE001
        print("[notify] 读不到社交消息缓存:", str(exc)[:120])
        return {}
    names = {}
    for key, msgs in (data.get("chats") or {}).items():
        if not isinstance(msgs, list):
            continue
        for msg in reversed(msgs[-20:]):
            if isinstance(msg, dict) and str(msg.get("conversation_name") or "").strip():
                names[str(msg["conversation_name"]).strip()] = str(key)
                break
    return names


def _owner_chat_key(cfg: dict) -> str:
    """主人私聊的会话键:优先用 reader 联系人里的 conversationId 反查。"""
    names = _chat_key_map(cfg)
    fallback = str(cfg.get("wechat_owner_chat_key") or "").strip()
    try:
        owner_wxid = str(cfg.get("wechat_target_wxid") or "wxid_h0t6y5w6yke022")
        for item in _read_contacts(cfg):
            if str(item.get("username") or "") != owner_wxid:
                continue
            conversation = str(item.get("conversationId") or "").strip()
            if conversation:
                return "wechat:private:" + conversation
            display = str(item.get("displayName") or "")
            if display and display in names:
                return names[display]
    except Exception as exc:  # noqa: BLE001
        print("[notify] 查主人私聊会话键失败:", str(exc)[:120])
    if fallback:
        return fallback
    return ""


def _chat_key_for_target(cfg: dict, target: str) -> str:
    """把任务结果目标(聊天显示名)换成插件用的会话键。"""
    target = (target or "").strip()
    if target in ("私聊", "主人"):
        return _owner_chat_key(cfg)
    names = _chat_key_map(cfg)
    if target and target in names:
        return names[target]
    if not target:
        recent = _recent_chat(cfg)
        if recent and recent[0] and recent[0] in names:
            return names[recent[0]]
        return _owner_chat_key(cfg)
    return ""


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
    with JOBS_LOCK:
        items = sorted(JOBS.items(), key=lambda item: -item[1].started)
    running = [item for item in items if not item[1].done.is_set()]
    finished = [item for item in items if item[1].done.is_set()]
    lines = []
    if running:
        lines.append("后台正在跑的任务:")
        for job_id, job in running:
            lines.append("  - %s 已跑 %.0f 秒 · 目标:%s · %s" % (
                job_id, now - job.started, getattr(job, "target", "") or "主人私聊",
                getattr(job, "label", "") or "(无描述)"))
    else:
        lines.append("后台现在没有在跑的任务。")
    if finished:
        lines.append("最近结束的:")
        for job_id, job in finished[:5]:
            ok = bool(job.result and job.result.get("ok"))
            elapsed = (getattr(job, "finished", 0.0) or now) - job.started
            lines.append("  - %s %s · 用时 %.0f 秒 · %s" % (
                job_id, "成功" if ok else "失败", elapsed, getattr(job, "label", "") or "(无描述)"))
    return "\n".join(lines)


def _watch_job(job: "Job", cfg: dict) -> None:
    """等任务结束,把结果直接推进微信;中途给进度,免得对方以为任务停了。"""
    mode = _notify_mode(cfg)
    for mark, span in ((60, 60), (150, 90)):
        if job.done.wait(span):
            break
        if job.pushed or job.answered_inline:
            return
        if mode not in ("all", "natural"):
            continue
        if mode == "natural":
            note = f"主人，那件事还在电脑上跑着，已经 {mark} 秒了，跑完我第一时间说。"
        else:
            note = f"【电脑任务】还在跑,已经 {mark} 秒了,做完我直接把结果发过来。"
        if not (cfg.get("wechat_hook_text", True) and wechat_hook_send_text(note, cfg, getattr(job, "target", None))):
            wechat_push_text(note, cfg)
    job.done.wait()
    time.sleep(1.5)
    if job.answered_inline or job.pushed:
        return
    ok = bool(job.result and job.result.get("ok"))
    if mode == "off":
        return
    if mode == "fail" and ok:
        return
    job.pushed = True
    if mode == "natural":
        text = _ask_assistant_report(cfg, job)
        if not text:
            text = _natural_fallback_text(cfg, job)
        if cfg.get("wechat_hook_text", True) and wechat_hook_send_text(text, cfg, getattr(job, "target", None)):
            return
        wechat_push_text(text, cfg)
        return
    body = job.render(cfg)
    head = "【电脑任务完成】" if ok else "【电脑任务失败】"
    limit = int(cfg.get("push_max_chars") or 1500)
    payload_text = head + "\n" + body[:limit]
    if cfg.get("wechat_hook_text", True):
        if wechat_hook_send_text(payload_text, cfg, getattr(job, "target", None)):
            return
    wechat_push_text(payload_text, cfg)


def tool_run_agent(args: dict, cfg: dict) -> str:
    task = (args.get("task") or "").strip()
    if not task:
        raise ValueError("task 不能为空")
    raw_task = task
    hint = _agent_hint(cfg)
    if hint:
        task = hint + "\n\n" + task
    wait = int(args.get("wait_seconds") or cfg.get("sync_wait_sec") or 8)
    wait = max(3, min(wait, 30))
    timeout = int(args.get("timeout_seconds") or cfg["agent_timeout_sec"])
    timeout = max(10, min(timeout, 3600))

    if DSH_CMD is None:
        raise ToolExecutionError(
            "❌ 这台电脑上没找到 dsh 命令,任务没法执行。\n"
            f"{DSH_HINT}\n"
            "解决:在 DeepSeek Harness 桌面版里启用命令行工具,或设置环境变量 DSH_CMD 指向它。"
        )

    job = Job(task, timeout, cfg)
    job.target = _pick_target(args, cfg)
    job.target_key = _chat_key_for_target(cfg, job.target)
    job.label = raw_task[:120]
    with JOBS_LOCK:
        JOBS[job.id] = job
        # 顺手清理一天前的旧任务
        for old in [k for k, v in JOBS.items() if time.time() - v.started > 86400]:
            JOBS.pop(old, None)
    job.start()
    threading.Thread(target=_watch_job, args=(job, cfg), daemon=True).start()

    if job.done.wait(wait):
        job.answered_inline = True
        return job_tool_result(job, cfg)
    return (
        f"⏳ 已经开始在电脑上跑了,大约需要几十秒到几分钟。\n"
        f"job_id = {job.id}\n"
        f"{_notify_hint(cfg)};现在先简短回主人一句「在查了」就行。\n"
        f"任务: {raw_task}"
    )


def tool_job_status(args: dict, cfg: dict) -> str:
    job_id = (args.get("job_id") or "").strip()
    if not job_id:
        return _describe_jobs(cfg)
    with JOBS_LOCK:
        job = JOBS.get(job_id)
    if job is None:
        raise ToolExecutionError(f"没有这个任务: {job_id}\n{_describe_jobs(cfg)}")
    if job.done.is_set():
        if not job.result or not job.result.get("ok"):
            return job_tool_result(job, cfg)
        if job.pushed:
            return "这个任务已经完成,结果已由电脑直接发到微信了,不用再重复一遍。"
        return job_tool_result(job, cfg)
    # 默认就在这一次调用里再等一会儿,避免模型用密集轮询把工具调用次数烧光
    wait = int(args.get("wait_seconds") or 75)
    wait = max(5, min(wait, 110))
    if job.done.wait(wait):
        if not job.result or not job.result.get("ok"):
            return job_tool_result(job, cfg)
        if job.pushed:
            return "这个任务已经完成,结果已由电脑直接发到微信了,不用再重复一遍。"
        return job_tool_result(job, cfg)
    return (
        f"⏳ 仍在运行,已 {round(time.time() - job.started)}s。\n"
        f"job_id={job_id}\n"
        f"可以再调一次 local_agent_status(job_id=\"{job_id}\") 继续等。"
    )


def tool_list_dir(args: dict, cfg: dict) -> str:
    target = resolve_path(args.get("path") or ".", cfg)
    if not target.exists():
        raise ToolExecutionError(f"路径不存在: {target}")
    if not target.is_dir():
        raise ToolExecutionError(f"不是目录: {target}")
    entries = sorted(target.iterdir(), key=lambda p: (p.is_file(), p.name.lower()))
    lines = [f"{target}  ({len(entries)} 项)"]
    for entry in entries[:300]:
        if entry.is_dir():
            lines.append(f"  [目录] {entry.name}/")
        else:
            try:
                size = entry.stat().st_size
            except OSError:
                size = -1
            lines.append(f"  [文件] {entry.name}  ({size:,} B)" if size >= 0 else f"  [文件] {entry.name}")
    if len(entries) > 300:
        lines.append(f"  …其余 {len(entries) - 300} 项省略")
    return truncate("\n".join(lines), cfg["max_output_chars"])


def tool_read_file(args: dict, cfg: dict) -> str:
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
    target = resolve_path(args.get("path") or "", cfg)
    content = args.get("content") or ""
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, "utf-8")
    return f"已写入 {target}（{len(content)} 字符）"


def tool_shell(args: dict, cfg: dict) -> str:
    if not cfg.get("allow_shell"):
        raise ToolExecutionError(
            "shell 工具未启用(默认关闭)。\n"
            "确实需要就改 config.json 的 allow_shell = true;"
            "更推荐用 run_local_agent,让 dsh 在沙箱里执行,安全和可追溯性都更好。"
        )
    command = (args.get("command") or "").strip()
    if not command:
        raise ValueError("command 不能为空")
    timeout = max(5, min(int(args.get("timeout_seconds") or 120), 900))
    result = run_capture(["cmd", "/c", command] if os.name == "nt" else ["sh", "-c", command],
                         str(Path(cfg["workspace_root"])), timeout)
    out = (result["stdout"] or "") + (("\n--- stderr ---\n" + result["stderr"]) if result["stderr"].strip() else "")
    flag = "✅" if result["ok"] else f"❌ exit={result['code']}"
    text = truncate(f"{flag} {result['elapsed']}s\n\n{out.strip() or '(无输出)'}", cfg["max_output_chars"])
    if not result["ok"]:
        raise ToolExecutionError(text)
    return text


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
    for key in ("content", "text", "message"):
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


def _send_pages_to_chat(src: Path, cfg: dict, target=None) -> tuple:
    """把 PDF 页面当图片,用 hook 按 wxid 定向发到聊天(不依赖窗口)。"""
    images = _pdf_to_page_images(src, cfg)
    if not images:
        return (0, "PDF 转图片失败")
    ok = 0
    for img in images:
        if wechat_hook_send_image(img, cfg, target):
            ok += 1
    return (ok, "")


_FILE_SEND_LOCK = threading.Lock()


def _title_ref_path(name: str) -> Path:
    """会话标题像素指纹文件路径(脚本 Get-RefPath 同一算法: sha1(utf8 utf8)[:10])。"""
    import hashlib
    digest = hashlib.sha1((name or "").encode("utf-8")).hexdigest()[:10]
    return SCRIPT_DIR / ("_wx_title_" + digest + ".png")


def _send_file_verified(src: Path, cfg: dict, target_title: str = "", talker: str = "") -> tuple:
    """扫描会话列表并用标题指纹校验命中目标聊天后发文件;失败重试,主人私聊失败时转图片兜底。"""
    with _FILE_SEND_LOCK:
        private = cfg.get("wechat_target_wxid") or "wxid_h0t6y5w6yke022"
        verify_talker = talker or private
        owner_title = (cfg.get("wechat_ui_chat_title") or "").strip()
        last_err = ""
        window_blank = False
        for attempt in range(1, 4):
            started = time.time() - 1
            if target_title:
                sent = wechat_send_native(src, cfg, "file", skip_title=True, scan_rows=True,
                                          target_title=target_title, scan_other=owner_title)
            else:
                sent = wechat_send_native(src, cfg, "file", skip_title=True, scan_rows=True,
                                          scan_other="群里只有一个好人")
            if sent == "__WINDOW_BLANK__":
                window_blank = True
                last_err = "微信窗口白屏"
                print("[file] %s 微信窗口白屏(第 %d 次),脚本已尝试无损恢复,稍后重试" % (src.name, attempt))
                time.sleep(3.0)
                continue
            if sent and sent != "__TITLE_MISMATCH__":
                deadline = time.time() + 20
                while time.time() < deadline:
                    for m in _reader_recent(verify_talker, cfg, 8):
                        ct = int(m.get("createTime") or 0)
                        if int(m.get("localType") or 0) == 25769803825 and ct >= started:
                            where = ("「%s」" % target_title) if target_title else "主人私聊"
                            return ("ok", "已确认发到%s,文件已经作为微信文件消息送达。" % where)
                    time.sleep(2.0)
                last_err = "发送后没查到新文件记录"
            else:
                last_err = "窗口校验未通过"
            print("[file] %s 第 %d 次失败: %s" % (src.name, attempt, last_err))
            time.sleep(1.5)

        if target_title:
            # 群/其他联系人失败时不要偷偷转图片发到私聊
            if window_blank:
                return ("failed", "微信窗口白屏(渲染卡死),文件没能发到「%s」;请重启微信客户端后重试。" % target_title)
            return ("failed", "发到「%s」失败:%s(没有改发到别处)。" % (target_title, last_err))
        pages, note = _send_pages_to_chat(src, cfg, private)
        if pages:
            if window_blank:
                return ("pages_ok",
                        "微信窗口处于白屏状态(渲染卡死),文件没能作为文件消息发出;"
                        "已把 %s 的前 %d 页转成图片发到私聊。要恢复发文件,需要重启微信客户端"
                        "(重启后可能需要在手机上确认一次登录)。" % (src.name, pages))
            return ("pages_ok", "文件通道连续失败(%s),已把 %s 的前 %d 页转成图片发到私聊。" % (last_err, src.name, pages))
        if window_blank:
            return ("failed", "微信窗口白屏(渲染卡死),发不出文件;请重启微信客户端后重试。")
        return ("failed", "文件发送失败:%s" % last_err)


def tool_export_file(args: dict, cfg: dict) -> str:
    src = resolve_path(args.get("path") or "", cfg)
    if not src.is_file():
        raise ToolExecutionError("【发送失败】文件不存在: %s" % src)
    size = src.stat().st_size
    limit_mb = int(cfg.get("max_export_mb") or 50)
    if size > limit_mb * 1024 * 1024:
        raise ToolExecutionError("【发送失败】文件太大(%s B),超过 %d MB 上限。" % (f"{size:,}", limit_mb))

    private_wxid = cfg.get("wechat_target_wxid") or "wxid_h0t6y5w6yke022"
    explicit = str(args.get("target") or "").strip()
    target = _pick_target(args, cfg)
    wxid, name = "", ""
    if target:
        wxid, name = resolve_target_chat(target, cfg)

    if explicit and not wxid:
        raise ToolExecutionError("【发送失败】找不到聊天: %s" % explicit)

    if not cfg.get("wechat_native_file", True):
        raise ToolExecutionError("【没有发送】文件发送通道被配置关闭(wechat_native_file=false)。")

    # 群/其他联系人:用已校准(标题指纹存在)的会话发,没校准就拒发,绝不静默改发私聊
    if wxid and wxid != private_wxid:
        ref = _title_ref_path(name or "")
        if not ref.is_file():
            raise ToolExecutionError("【没有发送】「%s」还没校准会话标题指纹,为防发错聊天,文件没有发出去。"
                    "先在电脑上把这个聊天打开一次,再用 export_file 重试(或先用 send_image/文字)。"
                    % (name or target))
        status, detail = _send_file_verified(src, cfg, target_title=name, talker=wxid)
        if status == "ok":
            return "【真实文件消息已送达】" + detail
        if status == "unverified":
            raise ToolExecutionError("【已尝试发送但未确认，请勿自动重发】" + detail)
        raise ToolExecutionError("【发送失败,文件没有发出去】" + detail)

    if not target and not explicit:
        raise ToolExecutionError("【没有发送】当前聊天不明确(多个聊天同时活跃),文件很容易发错地方,所以没有发。"
                "请显式传 target(群名或「私聊」)后再发一次。")

    status, detail = _send_file_verified(src, cfg)
    if status == "ok":
        return "【真实文件消息已送达】" + detail
    if status == "unverified":
        raise ToolExecutionError("【已尝试发送但未确认，请勿自动重发】" + detail)
    if status == "pages_ok":
        raise ToolExecutionError("【文件发送失败,已改发图片，请勿自动重发】" + detail)
    raise ToolExecutionError("【发送失败,文件没有发出去】" + detail)


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


_CHAT_CACHE = {}


def _read_contacts(cfg: dict) -> list:
    """读 reader 联系人列表(带进程内缓存,失败返回空列表)。"""
    cache = _CHAT_CACHE.get("contacts")
    if cache is not None:
        return cache
    cache = []
    try:
        cfg_path = Path(r"G:\wechat-deepseek\data\workspace\state\wechat-io-config.json")
        io_cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
        base = str(io_cfg.get("reader_base_url") or io_cfg.get("readerBaseUrl") or "http://127.0.0.1:5031").rstrip("/")
        token = str(io_cfg.get("reader_token") or io_cfg.get("readerToken") or io_cfg.get("token") or "")
        if not token:
            token = str(cfg.get("reader_token") or "")
        request = urllib.request.Request(base + "/api/v1/contacts",
                                         headers={"Authorization": "Bearer " + token})
        with urllib.request.urlopen(request, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8", "replace"))
        cache = data.get("contacts") or []
        _CHAT_CACHE["contacts"] = cache
    except Exception as exc:  # noqa: BLE001
        print(f"[target] 拉联系人失败: {exc}")
    return cache


def resolve_target_chat(target, cfg: dict) -> tuple:
    """把「群名 / 群号 / 私聊」解析成微信 wxid。返回 (wxid, 显示名)。"""
    raw = str(target or "").strip()
    default_wxid = cfg.get("wechat_target_wxid") or "wxid_h0t6y5w6yke022"
    if not raw or raw.lower() in ("private", "owner", "私聊", "主人", "主人私聊"):
        return default_wxid, "主人私聊"

    cache = _read_contacts(cfg)

    want = raw.lower().replace("@chatroom", "").replace("wechat:group:", "").replace("wechat:private:", "")
    for item in cache:
        username = str(item.get("username") or "")
        conv = str(item.get("conversationId") or "")
        name = str(item.get("displayName") or "")
        if want and (want == conv.lower() or want == username.lower().replace("@chatroom", "")
                     or want == name.lower()):
            return username, name
    for item in cache:
        name = str(item.get("displayName") or "")
        if want and want in name.lower():
            return str(item.get("username") or ""), name
    # 兜底:群里只有两个,按关键字猜
    for item in cache:
        name = str(item.get("displayName") or "")
        if "命就是好" in raw and "命就是好" in name:
            return str(item.get("username") or ""), name
        if "好人" in raw and "好人" in name:
            return str(item.get("username") or ""), name
    return "", ""


def _hook_target(cfg: dict, target=None) -> str:
    if target:
        wxid, name = resolve_target_chat(target, cfg)
        if wxid:
            print(f"[target] {target} -> {name}({wxid})")
            return wxid
        print(f"[target] 找不到聊天: {target},回退到主人私聊")
    return cfg.get("wechat_target_wxid") or "wxid_h0t6y5w6yke022"


def wechat_hook_send_text(text: str, cfg: dict, target=None) -> bool:
    """走 hook 的 /SendTextMsg,按 wxid 定向发文本,不抢焦点。"""
    try:
        res = _hook_post("/SendTextMsg", {"wxidorgid": _hook_target(cfg, target), "msg": text}, cfg)
        if res.get("ret") == 0:
            print("[hook] 文本已发送")
            return True
        print("[hook] 文本发送失败: " + json.dumps(res, ensure_ascii=False)[:200])
        return False
    except Exception as exc:  # noqa: BLE001
        print(f"[hook] 文本发送异常: {exc}")
        return False


def wechat_hook_send_image(src: Path, cfg: dict, target=None) -> bool:
    """走 hook 的 /SendImgMsg 原生发图(标准图片消息,按 wxid 定向)。"""
    try:
        import hashlib
        import shutil
        outgoing = Path(cfg.get("wechat_hook_outgoing")
                        or r"G:\wechat-deepseek\data\workspace\state\stickers\outgoing")
        outgoing.mkdir(parents=True, exist_ok=True)
        raw = src.read_bytes()
        if not raw or len(raw) > 8 * 1024 * 1024:
            return False
        staged = outgoing / (hashlib.md5(raw).hexdigest() + src.suffix.lower())
        if not staged.exists() or staged.stat().st_size != len(raw):
            shutil.copyfile(src, staged)
        res = _hook_post("/SendImgMsg", {"wxidorgid": _hook_target(cfg, target), "path": str(staged)}, cfg)
        if res.get("ret") == 0:
            print(f"[hook] 图片已原生发送: {src.name}")
            return True
        print("[hook] 发图失败: " + json.dumps(res, ensure_ascii=False)[:200])
        return False
    except Exception as exc:  # noqa: BLE001
        print(f"[hook] 发图异常: {exc}")
        return False


def wechat_ui_target_args(cfg: dict) -> list:
    """目标会话 + 自动切换:窗口不在目标聊天时,脚本自己切过去再发。"""
    title = (cfg.get("wechat_ui_chat_title") or "").strip()
    if not title:
        return []
    argv = ["-TargetTitle", title, "-NormalizeWindow"]
    if cfg.get("wechat_ui_switch_chat", True):
        argv.append("-SwitchChat")
    return argv


def wechat_send_native(src: Path, cfg: dict, mode: str, skip_title: bool = False, select_row: int = -1, scan_rows: bool = False, target_title: str = "", scan_other: str = "") -> str | None:
    """把文件/图片作为**真正的微信消息**发出去(不是链接、不是需要下载的附件)。

    mode=image → 标准图片消息(localType=3,能看到能点开能保存)
    mode=file  → 文件消息(可打开/另存)
    做法:剪贴板 + UI 自动化粘贴。脚本里带标题像素指纹校验,会话不对就拒发。
    """
    if not WECHAT_UI_SENDER.exists():
        print("[wx] 缺少 send_wechat_native.ps1")
        return None
    try:
        argv = ["powershell.exe", "-STA", "-NoProfile", "-ExecutionPolicy", "Bypass",
                "-File", str(WECHAT_UI_SENDER), "-Path", str(src), "-Mode", mode]
        if mode == "text":
            argv += ["-TextFile", str(src)]
        if target_title:
            argv += ["-TargetTitle", target_title, "-NormalizeWindow"]
            if cfg.get("wechat_ui_switch_chat", True):
                argv.append("-SwitchChat")
        else:
            argv += wechat_ui_target_args(cfg)
        if skip_title:
            argv.append("-SkipTitleCheck")
        if select_row >= 0:
            argv += ["-SelectRow", str(select_row)]
        if scan_rows:
            argv += ["-ScanRows"]
            if scan_other:
                argv += ["-ScanOtherTitle", scan_other]
        result = run_capture(argv, str(SCRIPT_DIR), 180)
        out = ((result["stdout"] or "") + "\n" + (result["stderr"] or "")).strip()
        if "SENT" in out:
            print(f"[wx] 已发送({mode}): {src.name}")
            if mode == "image":
                return f"已经把图直接发到微信了({src.name}),聊天里能看到,点开还能保存。"
            return f"已经把文件直接发到微信了({src.name}),在聊天里点开就能保存。"
        if "WINDOW_BLANK" in out:
            print("[wx] 微信窗口白屏,无法校验标题")
            return "__WINDOW_BLANK__"
        if "TITLE_MISMATCH" in out:
            print("[wx] 标题校验不通过,已取消发送")
            return "__TITLE_MISMATCH__"
        print("[wx] UI 发送失败: " + out.replace("\n", " ")[:300])
        return None
    except Exception as exc:  # noqa: BLE001
        print(f"[wx] UI 发送异常: {exc}")
        return None


def tool_send_image(args: dict, cfg: dict) -> list:
    src = resolve_path(args.get("path") or "", cfg)
    if not src.is_file():
        raise ToolExecutionError(f"图片不存在: {src}")
    suffix = src.suffix.lower()
    mime = MIME_BY_SUFFIX.get(suffix)
    if mime is None:
        raise ToolExecutionError(f"不是图片文件: {src.name}(支持 png/jpg/jpeg/gif/webp/bmp)")
    caption = (args.get("caption") or "").strip()
    private_wxid = cfg.get("wechat_target_wxid") or "wxid_h0t6y5w6yke022"
    explicit = str(args.get("target") or "").strip()
    target = _pick_target(args, cfg)
    target_wxid, target_name = resolve_target_chat(target, cfg) if target else ("", "")
    if explicit and not target_wxid:
        raise ToolExecutionError(f"找不到聊天「{explicit}」,图片没有发出去。")

    # 优先:hook 原生图片消息(按 wxid 定向,不抢焦点、不会发错会话)
    if cfg.get("wechat_hook_image", True) and src.suffix.lower() in (".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"):
        if wechat_hook_send_image(src, cfg, target):
            where = (target_name + " ") if target_name else ""
            text = f"已经把图发到{where}微信了({src.name}),那边能看到,点开还能保存。"
            if caption:
                text = caption + "\n" + text
            return [{"type": "text", "text": text + "\n回复里不用再贴链接或路径。"}]

    # 退一步:UI 自动化(需要窗口停在目标会话;只有目标是主人私聊时才用)
    if cfg.get("wechat_native_image", True) and (not target or target_wxid == private_wxid):
        sent = wechat_send_native(src, cfg, "image")
        if sent and sent not in ("__TITLE_MISMATCH__", "__WINDOW_BLANK__"):
            text = sent + ("\n" + caption if caption else "")
            return [{"type": "text", "text": text + "\n图片已经在微信里了,回复里不用再贴链接。"}]
        if sent == "__TITLE_MISMATCH__":
            raise ToolExecutionError("微信当前不在主人私聊,为了不发错地方,图片没有发出去。让主人把微信切回私聊再试。")
        if sent == "__WINDOW_BLANK__":
            raise ToolExecutionError("微信窗口白屏，图片没有确认发送，请恢复客户端后检查聊天记录，勿自动重发。")

    # 退路:图片内容 + 备用链接
    size = src.stat().st_size
    url = share_file(src, cfg)
    if size > 3 * 1024 * 1024:
        return [{"type": "text", "text": f"图片太大({size:,} B),用链接发:{url}" + (f"\n{caption}" if caption else "")}]
    encoded = base64.b64encode(src.read_bytes()).decode("ascii")
    contents = [{"type": "image", "data": encoded, "mimeType": mime}]
    text = f"图已附上({src.name})。如果聊天里看不到图,可用备用链接:{url}"
    if caption:
        text = f"{caption}\n{text}"
    contents.append({"type": "text", "text": text})
    return contents


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
    base = _codex_cmd(cfg)
    if base is None:
        return {"ok": False, "stdout": "", "stderr": "codex CLI 不存在"}
    scratch = Path(cfg.get("gpt_scratch_dir") or r"F:\deepseek工作区\_gpt_scratch")
    scratch.mkdir(parents=True, exist_ok=True)
    try:
        return run_capture(base + [prompt], str(scratch), timeout, _codex_env(cfg))
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "stdout": "", "stderr": str(exc)}


def _codex_images(cfg: dict) -> set:
    root = Path(cfg.get("gpt_images_dir") or (Path.home() / ".codex" / "generated_images"))
    if not root.exists():
        return set()
    try:
        return {str(p) for p in root.rglob("*.png")}
    except Exception:  # noqa: BLE001
        return set()


def _gpt_draw_worker(prompt: str, cfg: dict, target=None) -> None:
    """后台画图:生成 -> 找到新图 -> 通过 hook 直接发进微信。"""
    before = _codex_images(cfg)
    ask = ("用你的图片生成工具画一张图,主题:%s。只生成图片,不要修改任何文件,不要解释过程。" % prompt)
    result = _codex_run(ask, cfg, int(cfg.get("gpt_draw_timeout_sec") or 360))
    after = _codex_images(cfg)
    new = sorted(after - before)
    if not new:
        msg = "【画图失败】没能生成图片"
        detail = ((result.get("stderr") or "") + (result.get("stdout") or "")).strip()
        if detail:
            msg += "\n" + detail[-300:]
        if cfg.get("wechat_hook_text", True):
            wechat_hook_send_text(msg, cfg)
        return
    src = Path(sorted(new, key=lambda x: Path(x).stat().st_mtime)[-1])
    out_dir = Path(cfg.get("gpt_output_dir") or r"F:\deepseek工作区\generated")
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d_%H%M%S")
    dst = out_dir / ("gpt_%s%s" % (stamp, src.suffix or ".png"))
    try:
        shutil.copyfile(src, dst)
    except Exception:  # noqa: BLE001
        dst = src
    if cfg.get("wechat_hook_image", True):
        if wechat_hook_send_image(dst, cfg, target):
            print(f"[gpt] 画好的图已发送: {dst.name}")
        else:
            wechat_push_text("【画图完成】图在 %s" % dst, cfg)
    else:
        wechat_push_text("【画图完成】图在 %s" % dst, cfg)


def _free_draw_worker(prompt: str, cfg: dict, target=None) -> None:
    """免费生图(不需要账号、不吃额度):Pollinations 公共接口。"""
    import urllib.parse
    width = int(cfg.get("free_image_width") or 1024)
    height = int(cfg.get("free_image_height") or 1024)
    url = ("https://image.pollinations.ai/prompt/" + urllib.parse.quote(prompt)
           + "?width=%d&height=%d&nologo=true&seed=%d" % (width, height, int(time.time()) % 100000))
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = resp.read()
            ctype = resp.headers.get("Content-Type", "")
    except Exception as exc:  # noqa: BLE001
        body = "【画图失败】免费通道报错: %s" % str(exc)[:200]
        if cfg.get("wechat_hook_text", True):
            wechat_hook_send_text(body, cfg)
        return
    out_dir = Path(cfg.get("gpt_output_dir") or r"F:\deepseek工作区\generated")
    out_dir.mkdir(parents=True, exist_ok=True)
    suffix = ".jpg" if "jpeg" in ctype else ".png"
    dst = out_dir / ("free_%s%s" % (time.strftime("%Y%m%d_%H%M%S"), suffix))
    dst.write_bytes(data)
    if cfg.get("wechat_hook_image", True):
        if wechat_hook_send_image(dst, cfg, target):
            print(f"[free] 免费图已发送: {dst.name}")
            return
    if cfg.get("wechat_hook_text", True):
        wechat_hook_send_text("【画图完成】图片在: %s" % dst, cfg)


def tool_gpt_draw(args: dict, cfg: dict) -> str:
    """用本机 ChatGPT 账号画图(异步):先返回,画好后自动把图片发进微信。"""
    prompt = (args.get("prompt") or args.get("description") or "").strip()
    if not prompt:
        raise ValueError("prompt 不能为空")
    engine = (args.get("engine") or cfg.get("gpt_draw_engine") or "free").strip().lower()
    target = _pick_target(args, cfg)
    where = "微信"
    if target:
        wxid, name = resolve_target_chat(target, cfg)
        if not wxid:
            raise ToolExecutionError("找不到聊天: " + target)
        where = name
    if engine in ("gpt", "chatgpt", "codex"):
        if _codex_cmd(cfg) is None:
            raise ToolExecutionError("这台电脑上没找到 codex CLI,GPT 画图通道不可用。")
        threading.Thread(target=_gpt_draw_worker, args=(prompt, cfg, target), daemon=True).start()
        return ("🎨 用 GPT 画了(大约 1-2 分钟,会消耗你的 GPT 额度),画好直接发到%s。\n主题: " % where + prompt)
    threading.Thread(target=_free_draw_worker, args=(prompt, cfg, target), daemon=True).start()
    return ("🎨 已经开始画了(免费通道,几秒钟,不吃 GPT 额度),画好直接把图片发到%s。\n主题: " % where + prompt)


def tool_fetch_paper(args: dict, cfg: dict) -> str:
    """下载文献 PDF:先用本机校园网 IP 直接找出版商,再退开放获取(Unpaywall / S2 / arXiv)。"""
    import re as _re
    import urllib.parse

    query = (args.get("query") or args.get("doi") or args.get("title") or "").strip()
    if not query:
        raise ValueError("请给出 DOI、标题或 arXiv 编号")
    out_dir = Path(cfg.get("papers_dir") or r"F:\\deepseek工作区\\papers")
    out_dir.mkdir(parents=True, exist_ok=True)

    proxy = cfg.get("gpt_proxy") or "http://127.0.0.1:7890"
    direct = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    via_proxy = urllib.request.build_opener(urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
    UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
          "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")

    def get(url, timeout=45, raw=False, use_proxy=False, referer=None):
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
        dst = out_dir / (safe + ".pdf")
        dst.write_bytes(data)
        lines = ["已下载 PDF:%s(%.2f MB,来源 %s)" % (dst.name, len(data) / 1024 / 1024, label)]
        if meta["title"]:
            lines.append("标题:" + meta["title"])
        if meta["doi"]:
            lines.append("DOI:" + meta["doi"])
        lines.append("文件路径:%s" % dst)
        lines.append("下一步:用 export_file 把这个文件发到微信。")
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
    """通过用户电脑上的 ChatGPT(Codex CLI) 提问,返回它的回答。"""
    prompt = (args.get("prompt") or args.get("question") or "").strip()
    if not prompt:
        raise ValueError("prompt 不能为空")
    timeout = int(args.get("timeout_seconds") or cfg.get("gpt_timeout_sec") or 240)
    timeout = max(30, min(timeout, 600))
    if _codex_cmd(cfg) is None:
        raise ToolExecutionError("这台电脑上没找到 codex CLI,GPT 通道不可用。")
    result = _codex_run(prompt, cfg, timeout)

    raw = (result.get("stdout") or "") + "\n" + (result.get("stderr") or "")
    if not result.get("ok") and not raw.strip():
        raise ToolExecutionError("GPT 没有返回内容(CLI 退出异常)。")
    if not result.get("ok"):
        raise ToolExecutionError("GPT 执行失败: " + truncate(raw.strip(), cfg["max_output_chars"]))

    lines = raw.splitlines()
    answer = ""
    start = None
    for i, line in enumerate(lines):
        if line.strip() == "--------":
            start = i + 1
    if start is not None:
        # 格式: user / 提问原文 / codex / 回答... / tokens used
        body = lines[start:]
        codex_at = None
        for i, line in enumerate(body):
            if line.strip() == "codex":
                codex_at = i
        if codex_at is not None:
            collected = []
            for line in body[codex_at + 1:]:
                if line.strip().lower().startswith("tokens used"):
                    break
                collected.append(line)
            answer = "\n".join(collected).strip()
        else:
            answer = "\n".join(body).strip()
    if not answer:
        answer = raw.strip()
    if not answer:
        raise ToolExecutionError("GPT 返回了空内容。")
    return answer


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


# ---------------------------------------------------------------- 当前聊天自动定位
SOCIAL_MESSAGES = Path(r"G:\wechat-deepseek\data\workspace\state\social-messages.json")


def _recent_chats(cfg: dict) -> list:
    """近期有用户来信的聊天,按最后来信时间倒序:[(ts, 显示名, 聊天键)]。"""
    try:
        path = Path(cfg.get("wechat_social_messages") or SOCIAL_MESSAGES)
        data = json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except Exception as exc:  # noqa: BLE001
        print("[target] 读不到社交消息文件:", str(exc)[:120])
        return []
    window = float(cfg.get("wechat_current_chat_sec") or 600)
    now = time.time()
    latest = {}
    for key, msgs in (data.get("chats") or {}).items():
        if not isinstance(msgs, list):
            continue
        for msg in msgs[-10:]:
            if not isinstance(msg, dict) or msg.get("outgoing"):
                continue
            try:
                ts = float(msg.get("timestamp") or 0)
            except (TypeError, ValueError):
                continue
            if ts <= 0 or ts > now + 30 or now - ts > window:
                continue
            name = str(msg.get("conversation_name") or "").strip()
            if not name:
                continue
            if (key not in latest) or ts > latest[key][0]:
                latest[key] = (ts, name, str(key))
    return sorted(latest.values(), key=lambda item: -item[0])


def _recent_chat(cfg: dict) -> tuple:
    """最近一条用户来信属于哪个聊天。返回 (显示名, 聊天键, 距今秒数);识别不到返回 ('', '', 0)。"""
    chats = _recent_chats(cfg)
    if not chats:
        return "", "", 0.0
    ts, name, key = chats[0]
    return name, key, round(time.time() - ts, 1)


def _auto_target(cfg: dict) -> str:
    """判断"现在在哪个聊天里说话";识别不到返回空(调用方回退主人私聊)。

    串台保护:群聊只有在最近 180 秒内没有其他聊天也来过消息时才自动定位,
    多个聊天交叉时退回主人私聊,并要求模型显式传 target。
    """
    chats = _recent_chats(cfg)
    if not chats:
        return ""
    ts, name, key = chats[0]
    age = round(time.time() - ts, 1)
    if ":group:" in key:
        others = [item for item in chats[1:] if time.time() - item[0] < 180]
        if others:
            print("[target] 多聊天交叉,跳过群聊自动定位: %s(%s),最近来信 %ss 前;180s 内还有 %d 个聊天来过消息,"
                  "改用主人私聊,请显式传 target" % (name, key, age, len(others)))
            return ""
    print("[target] 自动定位当前聊天: %s(%s),最近来信 %ss 前" % (name, key, age))
    return name


def _pick_target(args: dict, cfg: dict) -> str:
    """显式 target 优先;没给就自动定位当前聊天,避免群里提问却把图发到主人私聊。"""
    explicit = str(args.get("target") or "").strip()
    if explicit:
        return explicit
    return _auto_target(cfg)


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
        "- 比分/赛程优先查公开数据接口(如 site.api.espn.com);需要出图优先用 F:\\deepseek工作区\\sched 下已有的 PIL 渲染脚本(如 nba_schedule.py)。",
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
    if not raw.lower().startswith(("http://", "https://", "file://")):
        return {"ok": False, "error": "网址必须以 http:// https:// 或 file:// 开头"}
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


def tool_screenshot_url(args: dict, cfg: dict) -> str:
    url = (args.get("url") or "").strip()
    if not url:
        raise ValueError("url 不能为空")
    raw_out = str(args.get("path") or "").strip()
    if raw_out:
        out = resolve_path(raw_out, cfg)
    else:
        out = Path(cfg["workspace_root"]) / "screenshots" / (
            "shot_%s_%s.png" % (time.strftime("%Y%m%d_%H%M%S"), uuid.uuid4().hex[:4]))
    res = screenshot_url(url, out, cfg, args.get("width"), args.get("height"))
    if not res.get("ok"):
        raise ToolExecutionError("【截图失败】%s\n所有尝试都没拿到非空白截图(常见原因:网站要登录/要过人机验证/"
                "强依赖交互,或被本机代理拦成反爬挑战页)。建议改用公开数据接口(如 fetch_scores)"
                "或换数据源,不要交空白图。" % res.get("error", ""))
    return ("【截图成功·已校验非空白】%s\n尺寸 %d x %d,大小 %s B,近白像素占比 %.4f,"
            "策略:%s(第 %d 次尝试)。\n下一步:用 send_image 把这个路径发出去"
            "(不传 target 会自动发到当前聊天)。" % (
                res["path"], res["width"], res["height"], f"{res['bytes']:,}",
                res["ratio"], res["strategy"], res["tries"]))


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
    profile = Path(cfg["workspace_root"]) / ".browser_tmp" / ("dom_" + uuid.uuid4().hex[:8])
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
            "下载成功返回文件路径,再用 export_file 把文件发到微信。"
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
            "生成图片(异步)。调用立刻返回「在画了」,画好后图片由电脑直接发到微信,不用轮询。"
            "默认走 free 免费通道(几秒、不吃额度);用户明确要求高质量或用 GPT 画时传 engine=gpt。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "prompt": {"type": "string", "description": "画什么,尽量具体(主体、风格、画面元素)。"},
                "engine": {"type": "string", "description": "free=免费通道(默认,几秒,不吃额度);gpt=用用户 GPT 账号(1-2 分钟,消耗额度,质量更好)。"},
                "target": {"type": "string", "description": "发到哪个聊天:群名(如「命就是好」「群里只有一个好人」)、群号或「私聊」。不传=自动发到刚刚跟你说话的那个聊天(服务端按最近来信判断;识别不到才发主人私聊)。"},
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
                "target": {"type": "string", "description": "发到哪个聊天:群名(如「命就是好」「群里只有一个好人」)、群号或「私聊」。不传=自动发到刚刚跟你说话的那个聊天(服务端按最近来信判断;识别不到才发主人私聊)。"},
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
                "target": {"type": "string", "description": "发到哪个聊天:群名(如「命就是好」「群里只有一个好人」)、群号或「私聊」。不传=自动发到刚刚跟你说话的那个聊天(服务端按最近来信判断;识别不到才发主人私聊)。"},
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
                "target": {"type": "string", "description": "发到哪个聊天:群名(如「命就是好」「群里只有一个好人」)、群号或「私聊」。不传=自动发到刚刚跟你说话的那个聊天(服务端按最近来信判断;识别不到才发主人私聊)。"},
            },
            "required": ["path"],
            "additionalProperties": False,
        },
    },
    {
        "name": "screenshot_url",
        "description": (
            "网页截图(可靠版):自动先直连后走系统代理,截图后用像素检测空白,空白自动换策略重试;"
            "成功返回 PNG 路径和校验结果,再把这个路径交给 send_image 发送。"
            "网页截图一律用它,不要自己用 headless 浏览器命令截(本机代理会让 ESPN 等站点返回反爬挑战页、截出纯白图)。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "要截图的网址(http/https/file)。"},
                "path": {"type": "string", "description": "可选:输出 png 路径,默认存到工作区 screenshots/ 下。"},
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
    name = params.get("name") or ""
    arguments = params.get("arguments") or {}
    if not isinstance(arguments, dict):
        return {"content": [{"type": "text", "text": "工具参数须为对象"}], "isError": True}
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
    if method.startswith("notifications/"):
        return None

    # 记一行日志:排障时能看出 DSH/微信那边到底连没连上、调了什么
    detail = ""
    if method == "tools/call":
        detail = " " + str(params.get("name"))
    elif method == "initialize":
        detail = " from " + str((params.get("clientInfo") or {}).get("name"))
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
                    "这是用户自己的 Windows 电脑,用户在微信里跟你说话。"
                    "要操作电脑时用 run_local_agent:它在本机调起 DSH agent 完成任务(文件、命令行、Office、网页)。"
                    "它是异步的:调用立刻返回「已开始」,结果做完会由电脑**直接发到微信**,不用轮询。"
                    "比分/赛程优先用 fetch_scores 查接口(快、准、不怕反爬),不要截图;"
                    "交付规则:图片用 send_image,文件(Word/PDF/Excel/压缩包等)用 export_file,"
                    "这两个工具都会把东西**直接发进微信**(图片是图片消息、文件是文件消息,对方能直接看/直接保存),"
                    "所以回复里不要再贴任何链接或路径,只写一句说明。"
                    "只有工具明确返回失败时才提链接;工具没明确返回成功,就不要说已经发了、已经发到群里。"
                    "发图/发文件不传 target 时,服务端会自动发到「刚刚跟你说话的那个聊天」,不用自己猜群名,也别乱传「私聊」。"
                    "网页截图一律用 screenshot_url(自动处理代理/反爬白屏并校验非空白),不要自己用 headless 浏览器截图;"
                    "读网页正文(比如微信里分享的链接、B站/公众号文章)用 read_web_page:它会自动直连/走代理/用浏览器渲染,读不到会明确报错,不要凭标题编;"
                    "回复要像聊天,别把链接和路径堆成技术报告。"
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
        self._send_json({"error": "unauthorized", "hint": "在 URL 后面加 ?token=config.json 里的 token"}, 403)

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
            if not self._token_ok():
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
    print("=" * 66)
    print("自检开始(不会联网,也不会开端口)")
    print("=" * 66)
    print(tool_pc_status(cfg))
    print("-" * 66)

    if DSH_CMD is None:
        print("[FAIL] 没找到 dsh 命令,run_local_agent 无法工作。")
        return 2

    print("[1/3] 跑一个最小任务(可能要十几秒)…")
    probe = run_capture(dsh_args("只回复两个字:能行"), str(Path(cfg["workspace_root"])), 180, DSH_EXTRA_ENV)
    out = (probe["stdout"] + probe["stderr"]).strip()
    print(f"      exit={probe['code']} 用时={probe['elapsed']}s")
    print("      " + ("\n      ".join(out.splitlines()[:12]) if out else "(无输出)"))
    if not probe["ok"]:
        print("[WARN] 任务没成功 —— 大概率是 headless 没有模型凭据,见 README「凭据」一节。")

    print("[2/3] 目录列表 …")
    print("      " + tool_list_dir({"path": "."}, cfg).splitlines()[0])

    print("[3/3] 读文件 …")
    readme = SCRIPT_DIR / "README.md"
    print("      " + (f"OK {readme}" if readme.exists() else "(README.md 还没生成)"))
    print("=" * 66)
    print("自检结束。若 [1/3] 正常,启动服务后手机就能用了。")
    return 0 if probe["ok"] else 1


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
    print(f" token     : {token}")
    print("-" * 66)
    print(" 手机上(MCP 配置)填这两个之一:")
    print(f"   SSE / HTTP+SSE : {base}/sse?token={token}")
    print(f"   Streamable HTTP: {base}/mcp?token={token}")
    print(f" 先在手机浏览器打开这个验证连通性:")
    print(f"   {base}/health?token={token}")
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
