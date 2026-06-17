"""
Astrore i18n Translator MCP Extension
提供多语言翻译工具，支持中/英/日/韩等语言。
通过 MCP 协议暴露翻译 API，主程序可调用这些工具进行界面本地化。
"""

import json
import sys
import os
import asyncio
import aiohttp

# 内置翻译字典 — 中文 → 英文/日文/韩文
TRANSLATIONS: dict[str, dict[str, dict[str, str]]] = {
    "zh": {
        "en": {
            "控制台": "Console",
            "服务器状态": "Server Status",
            "启动服务器": "Start Server",
            "停止服务器": "Stop Server",
            "强制停止": "Force Stop",
            "发送命令": "Send Command",
            "下载中心": "Download Center",
            "文件管理": "File Manager",
            "备份管理": "Backup Manager",
            "插件与模组": "Plugins & Mods",
            "插件配置": "Plugin Config",
            "扩展商店": "Extension Store",
            "服务端配置": "Server Config",
            "玩家与权限": "Players & Perms",
            "实例设置": "Instance Settings",
            "软件设置": "Software Settings",
            "关于": "About",
            "AI 助手": "AI Assistant",
            "运行中": "Running",
            "已停止": "Stopped",
            "在线玩家": "Online Players",
            "内存使用": "Memory Usage",
            "CPU 使用": "CPU Usage",
            "磁盘剩余": "Disk Free",
            "TPS": "TPS",
            "MSPT": "MSPT",
            "服务端核心下载": "Server Core Download",
            "插件市场": "Plugin Market",
            "Java 下载": "Java Download",
            "保存": "Save",
            "取消": "Cancel",
            "删除": "Delete",
            "重命名": "Rename",
            "下载": "Download",
            "搜索": "Search",
            "刷新": "Refresh",
            "备份": "Backup",
            "恢复": "Restore",
            "启用": "Enable",
            "禁用": "Disable",
            "确定": "Confirm",
            "错误": "Error",
            "成功": "Success",
            "请先配置实例目录": "Please configure instance directory first",
            "已有服务端正在运行": "A server is already running",
            "服务端未运行": "Server is not running",
            "下载完成": "Download complete",
            "下载已取消": "Download cancelled",
            "暂无数据": "No data",
        },
        "ja": {
            "控制台": "コンソール",
            "服务器状态": "サーバー状態",
            "启动服务器": "サーバー起動",
            "停止服务器": "サーバー停止",
            "强制停止": "強制停止",
            "发送命令": "コマンド送信",
            "下载中心": "ダウンロード",
            "文件管理": "ファイル管理",
            "备份管理": "バックアップ",
            "插件与模组": "プラグイン",
            "扩展商店": "拡張ストア",
            "服务端配置": "サーバー設定",
            "玩家与权限": "プレイヤー権限",
            "实例设置": "インスタンス設定",
            "软件设置": "ソフト設定",
            "关于": "について",
            "AI 助手": "AI アシスタント",
            "运行中": "実行中",
            "已停止": "停止済み",
            "在线玩家": "オンライン",
            "保存": "保存",
            "取消": "キャンセル",
            "删除": "削除",
            "下载": "ダウンロード",
            "搜索": "検索",
            "刷新": "更新",
        },
        "ko": {
            "控制台": "콘솔",
            "服务器状态": "서버 상태",
            "启动服务器": "서버 시작",
            "停止服务器": "서버 중지",
            "强制停止": "강제 중지",
            "发送命令": "명령 전송",
            "下载中心": "다운로드",
            "文件管理": "파일 관리",
            "备份管理": "백업 관리",
            "插件与模组": "플러그인",
            "扩展商店": "확장 스토어",
            "服务端配置": "서버 설정",
            "玩家与权限": "플레이어 권한",
            "实例设置": "인스턴스 설정",
            "软件设置": "소프트웨어 설정",
            "关于": "정보",
            "AI 助手": "AI 어시스턴트",
            "运行中": "실행 중",
            "已停止": "중지됨",
            "保存": "저장",
            "取消": "취소",
            "删除": "삭제",
            "下载": "다운로드",
            "搜索": "검색",
            "刷新": "새로고침",
        },
    }
}

# 内置翻译字典 — 英文 → 中文
TRANSLATIONS["en"] = {
    "zh": {v: k for k, v in TRANSLATIONS["zh"]["en"].items()},
    "ja": {},
    "ko": {},
}


async def translate_text(text: str, target_lang: str, source_lang: str = "zh") -> str:
    """使用内置字典翻译文本"""
    source_dict = TRANSLATIONS.get(source_lang, {}).get(target_lang, {})
    if text in source_dict:
        return source_dict[text]

    # 尝试在线翻译（Google Translate 免费 API）
    try:
        async with aiohttp.ClientSession() as session:
            url = "https://translate.googleapis.com/translate_a/single"
            params = {
                "client": "gtx",
                "sl": source_lang,
                "tl": target_lang,
                "dt": "t",
                "q": text,
            }
            async with session.get(url, params=params, timeout=aiohttp.ClientTimeout(total=5)) as resp:
                data = await resp.json()
                if data and data[0]:
                    return "".join(part[0] for part in data[0] if part[0])
    except Exception:
        pass

    return text


async def translate_batch(texts: list[str], target_lang: str, source_lang: str = "zh") -> dict[str, str]:
    """批量翻译"""
    results = {}
    for text in texts:
        results[text] = await translate_text(text, target_lang, source_lang)
    return results


async def list_supported_languages() -> list[dict]:
    """列出支持的语言"""
    return [
        {"code": "zh", "name": "中文 (简体)", "native": "中文"},
        {"code": "en", "name": "English", "native": "English"},
        {"code": "ja", "name": "日本語", "native": "日本語"},
        {"code": "ko", "name": "한국어", "native": "한국어"},
    ]


async def get_translation_map(target_lang: str) -> dict[str, str]:
    """获取完整的翻译映射表"""
    source_dict = TRANSLATIONS.get("zh", {}).get(target_lang, {})
    return source_dict


async def mcp_loop():
    """处理来自主程序的 MCP 请求"""
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
                    "jsonrpc": "2.0",
                    "id": rid,
                    "result": {
                        "tools": [
                            {
                                "name": "translate",
                                "description": "翻译单条文本到目标语言",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "text": {"type": "string", "description": "要翻译的文本"},
                                        "targetLang": {"type": "string", "description": "目标语言代码 (en/ja/ko)", "default": "en"},
                                        "sourceLang": {"type": "string", "description": "源语言代码", "default": "zh"},
                                    },
                                    "required": ["text", "targetLang"],
                                },
                            },
                            {
                                "name": "translate_batch",
                                "description": "批量翻译多条文本",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "texts": {"type": "array", "items": {"type": "string"}, "description": "要翻译的文本列表"},
                                        "targetLang": {"type": "string", "description": "目标语言代码"},
                                        "sourceLang": {"type": "string", "description": "源语言代码", "default": "zh"},
                                    },
                                    "required": ["texts", "targetLang"],
                                },
                            },
                            {
                                "name": "get_languages",
                                "description": "获取支持的语言列表",
                                "inputSchema": {"type": "object", "properties": {}},
                            },
                            {
                                "name": "get_translation_map",
                                "description": "获取完整的翻译映射表（用于前端 i18n）",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "targetLang": {"type": "string", "description": "目标语言代码"},
                                    },
                                    "required": ["targetLang"],
                                },
                            },
                        ]
                    },
                }
                print(json.dumps(response, ensure_ascii=False), flush=True)

            elif method == "tools/call":
                tool_name = params.get("name", "")
                arguments = params.get("arguments", {})

                if tool_name == "translate":
                    result = await translate_text(
                        arguments.get("text", ""),
                        arguments.get("targetLang", "en"),
                        arguments.get("sourceLang", "zh"),
                    )
                elif tool_name == "translate_batch":
                    result = await translate_batch(
                        arguments.get("texts", []),
                        arguments.get("targetLang", "en"),
                        arguments.get("sourceLang", "zh"),
                    )
                elif tool_name == "get_languages":
                    result = await list_supported_languages()
                elif tool_name == "get_translation_map":
                    result = await get_translation_map(arguments.get("targetLang", "en"))
                else:
                    result = f"未知工具: {tool_name}"

                response = {
                    "jsonrpc": "2.0",
                    "id": rid,
                    "result": {"content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}]},
                }
                print(json.dumps(response, ensure_ascii=False), flush=True)

            elif method == "initialize":
                response = {
                    "jsonrpc": "2.0",
                    "id": rid,
                    "result": {
                        "protocolVersion": "2024-11-05",
                        "serverInfo": {"name": "i18n-translator", "version": "1.0.0"},
                        "capabilities": {"tools": {}},
                    },
                }
                print(json.dumps(response), flush=True)

            else:
                response = {
                    "jsonrpc": "2.0",
                    "id": rid,
                    "error": {"code": -32601, "message": f"未知方法: {method}"},
                }
                print(json.dumps(response), flush=True)

        except json.JSONDecodeError:
            continue
        except Exception as e:
            print(f"[i18n] 错误: {e}", file=sys.stderr)


async def main():
    print("[i18n] Astrore i18n Translator MCP Extension 启动", file=sys.stderr)
    await mcp_loop()


if __name__ == "__main__":
    asyncio.run(main())
