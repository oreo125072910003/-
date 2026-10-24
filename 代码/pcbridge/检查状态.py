#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""一条命令检查「微信小助手 → 本机工具」这条链路的每一环。

    python 检查状态.py

检查项:
  1. MCP 执行服务在不在跑(bridge 的 /health)
  2. 本机 dsh 命令能不能用
  3. DSH 的 profile 里有没有挂 MCP 客户端那一行
  4. WeChatAgent 里主人私聊有没有授权这些工具
"""

from __future__ import annotations

import json
import sys
import urllib.request
from pathlib import Path

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

HERE = Path(__file__).resolve().parent
CONFIG = HERE / "config.json"
DSH_PATCH = Path.home() / ".dsh" / "profiles" / "desktop" / "cordis.patch.yml"
WX_CONFIG = Path(r"G:\wechat-deepseek\data\workspace\config\wechatagent.json")
OWNER_CHAT = "wechat:private:1253808542"
EXPECTED = [
    "mcp__pcbridge__run_local_agent",
    "mcp__pcbridge__export_file",
    "mcp__pcbridge__send_image",
]

results: list[tuple[bool, str]] = []


def check(ok: bool, text: str) -> None:
    results.append((ok, text))
    print(("  ✅ " if ok else "  ❌ ") + text)


def main() -> int:
    print("=" * 60)
    print(" 1. MCP 执行服务")
    cfg = json.loads(CONFIG.read_text("utf-8")) if CONFIG.exists() else {}
    token = cfg.get("token", "")
    port = cfg.get("port", 8765)
    base = f"http://127.0.0.1:{port}"
    health = None
    try:
        with urllib.request.urlopen(f"{base}/health?token={token}", timeout=5) as resp:
            health = json.loads(resp.read().decode("utf-8"))
        check(True, f"服务在跑: {base}")
    except Exception as exc:  # noqa: BLE001
        check(False, f"服务没起来({exc}) —— 双击 启动后台服务.bat")
    print("=" * 60)
    print(" 2. 执行内核 dsh")
    if health:
        check(bool(health.get("dsh")), f"dsh = {health.get('dsh')}")
    else:
        check(False, "服务没起来,查不了")

    print("=" * 60)
    print(" 3. DSH 侧 MCP 挂载")
    if DSH_PATCH.exists():
        text = DSH_PATCH.read_text("utf-8", errors="replace")
        check("mcp-pcbridge" in text and "dsh-mcp-client" in text,
              "cordis.patch.yml 里有 mcp-pcbridge 那一行")
        check(f"127.0.0.1:{port}" in text, f"指向的端口是 {port}")
        check("token=" in text, "URL 里带了 token")
    else:
        check(False, f"找不到 {DSH_PATCH}")

    print("=" * 60)
    print(" 4. WeChatAgent 主人私聊授权")
    if WX_CONFIG.exists():
        wx = json.loads(WX_CONFIG.read_text("utf-8-sig"))
        chats = wx.get("wechat", {}).get("dshAccess", {}).get("chats", {})
        grant = chats.get(OWNER_CHAT)
        if not grant:
            check(False, f"没有 {OWNER_CHAT} 的授权")
        else:
            tools = grant.get("tools", [])
            for name in EXPECTED:
                check(name in tools, f"已授权 {name}")
            check(True, f"技能 {len(grant.get('skills', []))} 个,工具 {len(tools)} 个")
    else:
        check(False, f"找不到 {WX_CONFIG}")

    print("=" * 60)
    bad = [text for ok, text in results if not ok]
    if not bad:
        print(" 全部通过。剩下的就是微信里发一条消息试:")
        print('   「帮我在这台电脑上建个 test.txt,内容写 hello」')
        return 0
    print(f" 有 {len(bad)} 项没通过,见上面 ❌。")
    return 1


if __name__ == "__main__":
    sys.exit(main())
