#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Circuit2Falstad Local Workbench Server
零第三方依赖的本地可视化服务：
1. 托管前端 Web 工作台与内置示例图片
2. 代理多模态视觉大模型请求（彻底解决浏览器 CORS 跨域限制，兼容 OpenAI / 通义千问 / 豆包 / Gemini / 硅基流动 / Ollama）
3. 支持本地保存 API 配置与导出 .circuitjs.txt 仿真文件到 outputs 目录
"""

from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import re
import socket
import ssl
import struct
import sys
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
import zlib
from datetime import datetime
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
EXAMPLES_DIR = BASE_DIR / "examples"
OUTPUTS_DIR = BASE_DIR / "outputs"
CONFIG_FILE = BASE_DIR / ".local_config.json"

OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)

ACTIVE_TASKS_LOCK = threading.Lock()
ACTIVE_TASKS: dict[str, dict] = {}


def make_vision_probe_data_url(width: int = 48, height: int = 48) -> str:
    """Generate a tiny valid pure-red (#FF0000) PNG image using Python stdlib only."""
    def _chunk(chunk_type: bytes, data: bytes) -> bytes:
        crc = zlib.crc32(chunk_type + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + chunk_type + data + struct.pack(">I", crc)

    raw_row = b"\x00" + (b"\xff\x00\x00" * width)
    raw_img = raw_row * height
    png_bytes = (
        b"\x89PNG\r\n\x1a\n"
        + _chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + _chunk(b"IDAT", zlib.compress(raw_img, 9))
        + _chunk(b"IEND", b"")
    )
    return "data:image/png;base64," + base64.b64encode(png_bytes).decode("ascii")

mimetypes.add_type("application/javascript; charset=utf-8", ".js")
mimetypes.add_type("text/css; charset=utf-8", ".css")
mimetypes.add_type("text/html; charset=utf-8", ".html")
mimetypes.add_type("application/json; charset=utf-8", ".json")


def load_local_config() -> dict:
    if CONFIG_FILE.exists():
        try:
            return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def save_local_config(cfg: dict) -> None:
    existing = load_local_config()
    # If apiKey is masked placeholder, preserve existing stored key
    if cfg.get("apiKey") == "__KEEP_EXISTING__":
        cfg["apiKey"] = existing.get("apiKey", "")
    merged = {
        "provider": cfg.get("provider", existing.get("provider", "custom")),
        "baseUrl": cfg.get("baseUrl", existing.get("baseUrl", "")).strip(),
        "model": cfg.get("model", existing.get("model", "")).strip(),
        "apiKey": cfg.get("apiKey", existing.get("apiKey", "")).strip(),
    }
    CONFIG_FILE.write_text(json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8")


def normalize_chat_completions_url(base_url: str) -> str:
    url = base_url.strip().rstrip("/")
    if not url:
        return "https://api.openai.com/v1/chat/completions"
    # If user pasted a management UI URL like http://127.0.0.1:18081/dashboard, strip /dashboard
    url = re.sub(r"/dashboard(?:/.*)?$", "", url, flags=re.IGNORECASE).rstrip("/")
    if url.endswith("/chat/completions"):
        return url
    # Common provider base URLs that already end with version segment like /v1, /v3, /v4, /openai
    if re.search(r"/(v\d+|v\d+beta/openai|compatible-mode/v1|api/paas/v4|api/v3)$", url):
        return f"{url}/chat/completions"
    return f"{url}/v1/chat/completions"


def build_opener_for_url(target_url: str) -> urllib.request.OpenerDirector:
    parsed = urllib.parse.urlparse(target_url)
    host = (parsed.hostname or "").lower()
    ctx = ssl.create_default_context()
    https_handler = urllib.request.HTTPSHandler(context=ctx)

    # Bypass proxy for localhost / LAN addresses so local Ollama always connects directly
    if host in ("localhost", "127.0.0.1", "::1") or host.startswith("192.168.") or host.startswith("10."):
        return urllib.request.build_opener(urllib.request.ProxyHandler({}), https_handler)

    return urllib.request.build_opener(urllib.request.ProxyHandler(), https_handler)


def call_gemini_native(api_key: str, model: str, system_prompt: str, user_prompt: str, image_data_url: str) -> str:
    """Support native Google Gemini API keys directly via generateContent."""
    m = re.match(r"^data:(image/[a-zA-Z0-9.+-]+);base64,(.+)$", image_data_url, re.DOTALL)
    if not m:
        raise ValueError("无效的图片 Base64 数据格式")
    mime_type, b64_data = m.group(1), m.group(2)
    model_name = model.strip() or "gemini-2.5-flash"
    if model_name.startswith("models/"):
        model_name = model_name[len("models/"):]

    endpoint = (
        f"https://generativelanguage.googleapis.com/v1beta/models/"
        f"{urllib.parse.quote(model_name)}:generateContent?key={urllib.parse.quote(api_key)}"
    )
    payload = {
        "system_instruction": {"parts": [{"text": system_prompt}]},
        "contents": [
            {
                "role": "user",
                "parts": [
                    {"inline_data": {"mime_type": mime_type, "data": b64_data}},
                    {"text": user_prompt},
                ],
            }
        ],
        "generationConfig": {
            "temperature": 0.1,
            "responseMimeType": "application/json",
        },
    }
    req = urllib.request.Request(
        endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    opener = build_opener_for_url(endpoint)
    with opener.open(req, timeout=120) as resp:
        raw = json.loads(resp.read().decode("utf-8"))
    candidates = raw.get("candidates") or []
    if not candidates:
        raise RuntimeError(f"Gemini 未返回有效结果: {json.dumps(raw, ensure_ascii=False)[:400]}")
    parts = candidates[0].get("content", {}).get("parts", [])
    return "".join(p.get("text", "") for p in parts)


def call_openai_compatible(
    base_url: str,
    api_key: str,
    model: str,
    system_prompt: str,
    user_prompt: str,
    image_data_url: str,
) -> str:
    """Call any OpenAI-compatible Vision Chat Completions endpoint."""
    endpoint = normalize_chat_completions_url(base_url)
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "Circuit2Falstad/1.0",
    }
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    payload = {
        "model": model,
        "temperature": 0.1,
        "messages": [
            {"role": "system", "content": system_prompt},
            {
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": image_data_url}},
                    {"type": "text", "text": user_prompt},
                ],
            },
        ],
    }

    req = urllib.request.Request(
        endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    opener = build_opener_for_url(endpoint)
    with opener.open(req, timeout=150) as resp:
        raw = json.loads(resp.read().decode("utf-8"))

    choices = raw.get("choices") or []
    if not choices:
        raise RuntimeError(f"模型未返回 choices: {json.dumps(raw, ensure_ascii=False)[:500]}")
    msg = choices[0].get("message", {})
    content = msg.get("content", "")
    if isinstance(content, list):
        content = "".join(item.get("text", "") for item in content if isinstance(item, dict))
    return str(content)


def sanitize_filename(name: str) -> str:
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", (name or "circuit").strip())
    cleaned = cleaned.strip(". ") or "circuit"
    return cleaned[:80]


class WorkbenchHandler(SimpleHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:
        sys.stdout.write(f"[{datetime.now().strftime('%H:%M:%S')}] {fmt % args}\n")

    def _send_json(self, data: dict, status: int = 200) -> None:
        raw = json.dumps(data, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            pass

    def _read_json_body(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            return {}
        body = self.rfile.read(length)
        return json.loads(body.decode("utf-8"))

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        req_path = urllib.parse.unquote(parsed.path)

        if req_path == "/api/health":
            self._send_json({"ok": True, "outputsDir": str(OUTPUTS_DIR)})
            return

        if req_path == "/api/config":
            cfg = load_local_config()
            has_key = bool(cfg.get("apiKey"))
            self._send_json(
                {
                    "ok": True,
                    "provider": cfg.get("provider", "siliconflow"),
                    "baseUrl": cfg.get("baseUrl", ""),
                    "model": cfg.get("model", ""),
                    "hasApiKey": has_key,
                    "maskedKey": (cfg["apiKey"][:4] + "****" + cfg["apiKey"][-4:])
                    if has_key and len(cfg["apiKey"]) > 8
                    else ("****" if has_key else ""),
                }
            )
            return

        # Serve examples
        if req_path.startswith("/examples/"):
            rel = req_path[len("/examples/"):]
            target = (EXAMPLES_DIR / rel).resolve()
            if str(target).startswith(str(EXAMPLES_DIR.resolve())) and target.is_file():
                self._serve_file(target)
                return
            self.send_error(HTTPStatus.NOT_FOUND, "Example file not found")
            return

        # Serve static frontend
        if req_path in ("/", "/index.html"):
            target = STATIC_DIR / "index.html"
        else:
            rel = req_path.lstrip("/")
            if rel.startswith("static/"):
                rel = rel[len("static/"):]
            target = (STATIC_DIR / rel).resolve()

        if str(target).startswith(str(STATIC_DIR.resolve())) and target.is_file():
            self._serve_file(target)
            return

        self.send_error(HTTPStatus.NOT_FOUND, "File not found")

    def _serve_file(self, file_path: Path) -> None:
        ctype, _ = mimetypes.guess_type(str(file_path))
        ctype = ctype or "application/octet-stream"
        data = file_path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        req_path = parsed.path

        try:
            body = self._read_json_body()
        except Exception as exc:
            self._send_json({"ok": False, "error": f"请求 JSON 解析失败: {exc}"}, 400)
            return

        if req_path == "/api/config":
            save_local_config(body)
            self._send_json({"ok": True})
            return

        if req_path == "/api/save-circuit":
            name = sanitize_filename(body.get("filename", "circuit"))
            if not name.endswith(".txt"):
                name = f"{name}.circuitjs.txt"
            content = str(body.get("content", "")).strip() + "\n"
            out_path = OUTPUTS_DIR / name
            out_path.write_text(content, encoding="utf-8")
            self._send_json({"ok": True, "savedPath": str(out_path), "filename": name})
            return

        if req_path == "/api/analyze":
            self._handle_analyze(body)
            return

        if req_path == "/api/cancel":
            self._handle_cancel(body)
            return

        if req_path == "/api/test-connection":
            self._handle_test_connection(body)
            return

        self._send_json({"ok": False, "error": f"未知接口: {req_path}"}, 404)

    def _handle_cancel(self, body: dict) -> None:
        request_id = str(body.get("requestId") or "").strip()
        cancelled_ids: list[str] = []
        with ACTIVE_TASKS_LOCK:
            targets = [request_id] if request_id and request_id in ACTIVE_TASKS else (
                [] if request_id else list(ACTIVE_TASKS.keys())
            )
            for rid in targets:
                entry = ACTIVE_TASKS.get(rid)
                if entry:
                    entry["cancelled"] = True
                    entry["event"].set()
                    cancelled_ids.append(rid)
        self._send_json({"ok": True, "cancelledIds": cancelled_ids})

    def _handle_test_connection(self, body: dict) -> None:
        saved = load_local_config()
        request_id = str(body.get("requestId") or f"test_{datetime.now().timestamp()}").strip()
        provider = (body.get("provider") or saved.get("provider") or "custom").strip()
        base_url = (body.get("baseUrl") or "").strip()
        model = (body.get("model") or "").strip()
        api_key = (body.get("apiKey") or "").strip()

        if api_key in ("", "__KEEP_EXISTING__"):
            # Only reuse saved key if testing the same provider or base URL
            same_target = (provider == saved.get("provider")) or (
                bool(base_url) and base_url.rstrip("/") == str(saved.get("baseUrl") or "").rstrip("/")
            )
            if same_target:
                api_key = saved.get("apiKey", "").strip()
            else:
                api_key = ""

        if not model:
            self._send_json({"ok": False, "error": "请先填写「视觉模型名称 (Model ID)」再测试"}, 400)
            return
        if provider != "ollama" and not api_key:
            self._send_json({"ok": False, "error": "请先填写当前服务商的 API Key 再进行测试"}, 400)
            return
        if provider != "gemini_native" and not base_url:
            self._send_json({"ok": False, "error": "请先填写 API Base URL 接口地址"}, 400)
            return

        probe_img = make_vision_probe_data_url()
        sys_prompt = "你是连通性与视觉识图测试助手。请直接输出 JSON 对象，不要包含额外解释。"
        usr_prompt = '请识别这张纯色测试方块的颜色，并严格返回 JSON：{"color": "红色"}'

        done_event = threading.Event()
        task_entry: dict = {
            "event": done_event,
            "cancelled": False,
            "payload": None,
            "http_status": 200,
        }
        with ACTIVE_TASKS_LOCK:
            ACTIVE_TASKS[request_id] = task_entry

        def _test_worker() -> None:
            t0 = time.perf_counter()
            try:
                use_gemini_native = (
                    provider == "gemini_native"
                    or ("generativelanguage.googleapis.com" in base_url and "/openai" not in base_url)
                )
                if use_gemini_native:
                    reply = call_gemini_native(api_key, model, sys_prompt, usr_prompt, probe_img)
                else:
                    reply = call_openai_compatible(base_url, api_key, model, sys_prompt, usr_prompt, probe_img)

                elapsed_ms = int((time.perf_counter() - t0) * 1000)
                clean_reply = re.sub(r"\s+", " ", (reply or "").strip())
                low = clean_reply.lower()
                saw_red = any(k in low for k in ("红", "red", "赤", "绯", "朱", "ff0000"))

                if saw_red:
                    task_entry["payload"] = {
                        "ok": True,
                        "visionOk": True,
                        "latencyMs": elapsed_ms,
                        "reply": clean_reply[:80],
                        "message": (
                            f"✅ 测试成功（耗时 {elapsed_ms / 1000:.2f}s）！API 连接与密钥有效，"
                            f"且模型「{model}」支持图片识别（返回：{clean_reply[:40]}）。"
                        ),
                    }
                else:
                    task_entry["payload"] = {
                        "ok": True,
                        "visionOk": False,
                        "latencyMs": elapsed_ms,
                        "reply": clean_reply[:100],
                        "message": (
                            f"⚠️ 接口已连通（{elapsed_ms / 1000:.2f}s），但模型未正确识别测试图颜色"
                            f"（返回：{clean_reply[:50] or '空'}）。该模型可能不支持视觉输入，建议切换带 VL / Vision 的模型！"
                        ),
                    }
            except urllib.error.HTTPError as http_err:
                elapsed_ms = int((time.perf_counter() - t0) * 1000)
                err_body = ""
                try:
                    err_body = http_err.read().decode("utf-8", errors="replace").strip()
                except Exception:
                    pass
                code = http_err.code
                low_err = err_body.lower()
                if code in (401, 403):
                    msg = f"❌ 认证失败 (HTTP {code})：API Key 不正确、已失效或无该模型权限。({err_body[:180]})"
                elif code == 404:
                    msg = f"❌ 地址或模型不存在 (HTTP 404)：请检查 Base URL 或模型名「{model}」是否正确。({err_body[:180]})"
                elif code in (400, 422) and any(
                    w in low_err for w in ("image", "vision", "multimodal", "media", "content", "vl")
                ):
                    msg = (
                        f"❌ 该模型不支持图片识别 (HTTP {code})：API 密钥有效，但「{model}」是纯文本模型，"
                        f"请换用多模态视觉模型（如 Qwen/Qwen2.5-VL-72B-Instruct）。({err_body[:180]})"
                    )
                elif code == 429:
                    msg = f"❌ 请求受限或余额不足 (HTTP 429)：{err_body[:220] or http_err.reason}"
                elif code in (502, 503, 504):
                    msg = (
                        f"❌ 上游网关异常 (HTTP {code}，耗时 {elapsed_ms / 1000:.2f}s)："
                        f"当前模型「{model}」可能暂不可用或不支持传图，建议换一个视觉模型重试。({err_body[:180]})"
                    )
                else:
                    msg = f"❌ 接口返回错误 HTTP {code}：{err_body[:240] or http_err.reason}"
                task_entry["payload"] = {"ok": False, "error": msg}
                task_entry["http_status"] = 200
            except Exception as exc:
                msg = f"❌ 网络连接失败（请检查 Base URL 地址或服务是否启动）：{exc}"
                task_entry["payload"] = {"ok": False, "error": msg}
                task_entry["http_status"] = 200
            finally:
                done_event.set()

        threading.Thread(target=_test_worker, daemon=True).start()
        done_event.wait()

        with ACTIVE_TASKS_LOCK:
            ACTIVE_TASKS.pop(request_id, None)

        if task_entry["cancelled"]:
            self._send_json({"ok": False, "cancelled": True, "error": "⏹ 已停止连接测试"}, 200)
            return

        self._send_json(task_entry["payload"] or {"ok": False, "error": "未知测试异常"}, task_entry["http_status"])

    def _handle_analyze(self, body: dict) -> None:
        saved = load_local_config()
        request_id = str(body.get("requestId") or f"req_{datetime.now().timestamp()}").strip()
        provider = (body.get("provider") or saved.get("provider") or "custom").strip()
        base_url = (body.get("baseUrl") or saved.get("baseUrl") or "").strip()
        model = (body.get("model") or saved.get("model") or "").strip()
        api_key = (body.get("apiKey") or "").strip()
        if api_key in ("", "__KEEP_EXISTING__"):
            api_key = saved.get("apiKey", "").strip()

        image_data_url = (body.get("imageDataUrl") or "").strip()
        system_prompt = (body.get("systemPrompt") or "").strip()
        user_prompt = (body.get("userPrompt") or "").strip()

        if not image_data_url.startswith("data:image/"):
            self._send_json({"ok": False, "error": "请先上传或粘贴一张电路图片"}, 400)
            return
        if not model:
            self._send_json({"ok": False, "error": "请填写视觉模型名称（例如 qwen-vl-max / gpt-4o / gemini-2.5-flash）"}, 400)
            return
        if provider != "ollama" and not api_key:
            self._send_json(
                {
                    "ok": False,
                    "error": "未配置 API Key。请在右上角「API 设置」中填入密钥，或切换到「免 API 提示词模式」。",
                },
                400,
            )
            return

        # Save latest non-empty settings for convenience
        save_local_config(
            {
                "provider": provider,
                "baseUrl": base_url,
                "model": model,
                "apiKey": api_key if api_key else "__KEEP_EXISTING__",
            }
        )

        done_event = threading.Event()
        task_entry: dict = {
            "event": done_event,
            "cancelled": False,
            "raw_text": None,
            "error": None,
            "status": 200,
        }
        with ACTIVE_TASKS_LOCK:
            ACTIVE_TASKS[request_id] = task_entry

        def _worker() -> None:
            try:
                use_gemini_native = (
                    provider == "gemini_native"
                    or ("generativelanguage.googleapis.com" in base_url and "/openai" not in base_url)
                )
                if use_gemini_native:
                    text = call_gemini_native(api_key, model, system_prompt, user_prompt, image_data_url)
                else:
                    text = call_openai_compatible(base_url, api_key, model, system_prompt, user_prompt, image_data_url)
                task_entry["raw_text"] = text
            except urllib.error.HTTPError as http_err:
                err_body = ""
                try:
                    err_body = http_err.read().decode("utf-8", errors="replace")
                except Exception:
                    pass
                task_entry["error"] = f"上游模型接口返回 HTTP {http_err.code}: {err_body[:600] or http_err.reason}"
                task_entry["status"] = 502
            except Exception as exc:
                if not task_entry["cancelled"]:
                    traceback.print_exc()
                task_entry["error"] = f"调用视觉模型失败: {exc}"
                task_entry["status"] = 500
            finally:
                done_event.set()

        threading.Thread(target=_worker, daemon=True).start()
        done_event.wait()

        with ACTIVE_TASKS_LOCK:
            ACTIVE_TASKS.pop(request_id, None)

        if task_entry["cancelled"]:
            self._send_json({"ok": False, "cancelled": True, "error": "识别任务已停止"}, 200)
            return

        if task_entry["error"]:
            self._send_json({"ok": False, "error": task_entry["error"]}, task_entry["status"])
            return

        self._send_json({"ok": True, "rawText": task_entry["raw_text"]})


def find_free_port(preferred: int = 8765) -> int:
    for port in range(preferred, preferred + 30):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if s.connect_ex(("127.0.0.1", port)) != 0:
                return port
    return preferred


def main() -> None:
    parser = argparse.ArgumentParser(description="Circuit2Falstad 本地电路图转仿真工作台")
    parser.add_argument("--port", type=int, default=8765, help="监听端口 (默认: 8765)")
    parser.add_argument("--no-browser", action="store_true", help="启动时不自动打开浏览器")
    args = parser.parse_args()

    port = find_free_port(args.port)
    server = ThreadingHTTPServer(("127.0.0.1", port), WorkbenchHandler)
    url = f"http://127.0.0.1:{port}"

    print("=" * 62)
    print("  Circuit2Falstad - 电路图一键转 Falstad 在线仿真工作台")
    print(f"  本地访问地址: {url}")
    print(f"  仿真文件输出目录: {OUTPUTS_DIR}")
    print("  按 Ctrl+C 停止服务")
    print("=" * 62)

    if not args.no_browser:
        webbrowser.open(url)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n服务已停止。")
        server.server_close()


if __name__ == "__main__":
    main()
