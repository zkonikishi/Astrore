"""
Astrore QQ Bot MCP Extension
通过 MCP 协议暴露 QQ 机器人管理 Minecraft 服务器的工具。
使用 OneBot v11 标准协议连接 QQ（兼容 Lagrange、LLOneBot、NapCat 等）。
"""

import json
import sys
import os
import asyncio
import aiohttp

BOT_TOKEN = os.environ.get("QQ_BOT_TOKEN", "")
BOT_ADMIN = os.environ.get("QQ_BOT_ADMIN", "")
WS_URL = "ws://127.0.0.1:3001"


async def send_jsonrpc(method: str, params: dict | None = None) -> dict:
    """向主程序发送 JSON-RPC 请求并等待响应"""
    request = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}
    print(json.dumps(request), flush=True)
    try:
        line = await asyncio.get_event_loop().run_in_executor(None, sys.stdin.readline)
        if line:
            return json.loads(line.strip())
    except Exception:
        pass
    return {"error": "no_response"}


async def get_server_status() -> str:
    result = await send_jsonrpc("tools/call", {"name": "server_status", "arguments": {}})
    if "error" in result:
        return "无法获取服务器状态"
    data = result.get("result", {})
    running = data.get("running", False)
    if not running:
        return "服务器未运行"
    metrics = data.get("metrics", {})
    return (
        f"服务器运行中\n"
        f"TPS: {metrics.get('tps', 'N/A')} | MSPT: {metrics.get('mspt', 'N/A')}\n"
        f"玩家: {metrics.get('onlinePlayers', 0)}/{metrics.get('maxPlayers', 20)}\n"
        f"CPU: {metrics.get('cpuPercent', 0):.1f}% | 内存: {metrics.get('memoryMb', 0):.0f}MB"
    )


async def send_mc_command(command: str) -> str:
    result = await send_jsonrpc("tools/call", {"name": "send_server_command", "arguments": {"command": command}})
    if "error" in result:
        return f"发送命令失败: {result.get('error')}"
    return f"命令已发送: {command}"


async def get_player_list() -> str:
    result = await send_jsonrpc("tools/call", {"name": "get_player_list", "arguments": {}})
    if "error" in result:
        return "无法获取玩家列表"
    data = result.get("result", {})
    players = data.get("playerList", [])
    online = data.get("onlinePlayers", 0)
    max_p = data.get("maxPlayers", 20)
    if not players:
        return f"当前无在线玩家 ({online}/{max_p})"
    return f"在线玩家 ({online}/{max_p}): " + ", ".join(players)


async def handle_qq_message(session: aiohttp.ClientSession, message: str, user_id: str):
    if BOT_ADMIN and str(user_id) != BOT_ADMIN:
        await send_qq_message(session, user_id, "你没有权限使用此机器人")
        return

    msg = message.strip().lower()
    if msg in ("状态", "status", "服务器状态"):
        reply = await get_server_status()
    elif msg in ("玩家", "players", "在线", "在线玩家"):
        reply = await get_player_list()
    elif msg.startswith("cmd ") or msg.startswith("命令 "):
        cmd = msg.split(" ", 1)[1] if " " in msg else ""
        reply = await send_mc_command(cmd) if cmd else "用法: cmd <命令>"
    elif msg in ("帮助", "help", "菜单"):
        reply = "Astrore QQ 机器人命令:\n状态 - 查看服务器状态\n玩家 - 查看在线玩家\ncmd <命令> - 发送控制台命令\n帮助 - 显示此菜单"
    else:
        reply = "未知命令，发送「帮助」查看可用命令"

    await send_qq_message(session, user_id, reply)


async def send_qq_message(session: aiohttp.ClientSession, user_id: str, message: str):
    try:
        async with session.post(
            f"{WS_URL.replace('ws://', 'http://')}/send_private_msg",
            json={"user_id": int(user_id), "message": message},
            timeout=aiohttp.ClientTimeout(total=5),
        ) as resp:
            await resp.json()
    except Exception as e:
        print(f"[QQBot] 发送消息失败: {e}", file=sys.stderr)


async def qq_websocket():
    async with aiohttp.ClientSession() as session:
        while True:
            try:
                async with session.ws_connect(WS_URL) as ws:
                    print(f"[QQBot] 已连接 QQ WebSocket: {WS_URL}", file=sys.stderr)
                    async for msg in ws:
                        if msg.type == aiohttp.WSMsgType.TEXT:
                            data = json.loads(msg.data)
                            if data.get("post_type") == "message" and data.get("message_type") == "private":
                                await handle_qq_message(session, data.get("raw_message", ""), str(data.get("user_id", "")))
            except Exception as e:
                print(f"[QQBot] WebSocket 断开: {e}, 5秒后重连...", file=sys.stderr)
                await asyncio.sleep(5)


async def mcp_loop():
    while True:
        try:
            line = await asyncio.get_event_loop().run_in_executor(None, sys.stdin.readline)
            if not line:
                break
            line = line.strip()
            if not line:
                continue
            request = json.loads(line)
            rid = request.get("id")
            method = request.get("method", "")
            params = request.get("params", {})

            if method == "tools/list":
                response = {
                    "jsonrpc": "2.0", "id": rid,
                    "result": {
                        "tools": [
                            {"name": "server_status", "description": "查询 Minecraft 服务器运行状态，包括 TPS、在线玩家、CPU/内存使用", "inputSchema": {"type": "object", "properties": {}}},
                            {"name": "send_server_command", "description": "向 Minecraft 服务器发送控制台命令", "inputSchema": {"type": "object", "properties": {"command": {"type": "string", "description": "Minecraft 控制台命令"}}, "required": ["command"]}},
                            {"name": "get_player_list", "description": "获取当前在线玩家列表", "inputSchema": {"type": "object", "properties": {}}},
                        ]
                    },
                }
                print(json.dumps(response, ensure_ascii=False), flush=True)

            elif method == "tools/call":
                tool_name = params.get("name", "")
                arguments = params.get("arguments", {})
                if tool_name == "server_status":
                    result = await get_server_status()
                elif tool_name == "send_server_command":
                    result = await send_mc_command(arguments.get("command", ""))
                elif tool_name == "get_player_list":
                    result = await get_player_list()
                else:
                    result = f"未知工具: {tool_name}"
                response = {"jsonrpc": "2.0", "id": rid, "result": {"content": [{"type": "text", "text": result}]}}
                print(json.dumps(response, ensure_ascii=False), flush=True)

            elif method == "initialize":
                response = {"jsonrpc": "2.0", "id": rid, "result": {"protocolVersion": "2024-11-05", "serverInfo": {"name": "QQBot-MCP", "version": "1.0.0"}, "capabilities": {"tools": {}}}}
                print(json.dumps(response), flush=True)

            else:
                response = {"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": f"未知方法: {method}"}}
                print(json.dumps(response), flush=True)

        except json.JSONDecodeError:
            continue
        except Exception as e:
            print(f"[MCP] 错误: {e}", file=sys.stderr)


async def main():
    print("[QQBot] Astrore QQ Bot MCP Extension 启动", file=sys.stderr)
    await asyncio.gather(mcp_loop(), qq_websocket())


if __name__ == "__main__":
    asyncio.run(main())
