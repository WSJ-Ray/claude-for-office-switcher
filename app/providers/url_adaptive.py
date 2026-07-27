"""URL 路径自适应适配器。

自动处理 base_url 的不同写法，智能拼接请求路径：
- https://api.example.com          → {base}/v1/messages
- https://api.example.com/v1       → {base}/messages
- https://api.example.com/anthropic → {base}/messages
- https://api.example.com/v1/anthropic → {base}/messages

支持流式和非流式请求，完全兼容 Anthropic Messages API。
"""
import json
import time
from typing import AsyncIterator

import httpx

from .base import BaseProvider
from ._utils import model_list_urls


def _empty_usage() -> dict:
    """创建字段完整且初始值为零的 token 用量字典。"""
    return {"input_tokens": 0, "output_tokens": 0, "cache_w": 0, "cache_r": 0}


def _extract_usage(block: bytes, usage: dict) -> None:
    """解析 Anthropic SSE 事件块并原地累计 token 用量。"""
    data: bytes | None = None
    for line in block.split(b"\n"):
        line = line.strip()
        if line.startswith(b"data:"):
            data = line[5:].strip()
            break
    if not data:
        return
    try:
        obj = json.loads(data)
    except Exception:
        return
    etype = obj.get("type")
    if etype == "message_start":
        u = (obj.get("message") or {}).get("usage") or {}
        if u.get("input_tokens"):
            usage["input_tokens"] = u["input_tokens"]
        if u.get("cache_creation_input_tokens"):
            usage["cache_w"] = u["cache_creation_input_tokens"]
        if u.get("cache_read_input_tokens"):
            usage["cache_r"] = u["cache_read_input_tokens"]
        if u.get("output_tokens"):
            usage["output_tokens"] = u["output_tokens"]
    elif etype == "message_delta":
        u = obj.get("usage") or {}
        if u.get("output_tokens") is not None:
            usage["output_tokens"] = u["output_tokens"]


class URLAdaptiveAdapter(BaseProvider):
    format = "url_adaptive"

    def _headers(self) -> dict:
        """构造自适应端点的认证请求头和可配置 User-Agent。"""
        ua = (self.extra.get("user_agent")
              or "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                 "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "User-Agent": ua,
        }

    def _build_endpoint(self, path: str) -> str:
        """识别常见基础路径后拼接指定 API 端点。"""
        normalized = self.base_url.rstrip("/")
        suffixes = ("/v1", "/anthropic", "/v1/anthropic")
        for suffix in suffixes:
            if normalized.endswith(suffix):
                return f"{normalized}/{path.lstrip('/')}"
        return f"{normalized}/v1/{path.lstrip('/')}"

    async def list_models(self) -> list[dict]:
        """尝试候选模型端点并返回 Anthropic 风格模型列表。"""
        last_status: int | None = None
        async with httpx.AsyncClient(timeout=30.0) as client:
            for url in model_list_urls(self.base_url):
                try:
                    resp = await client.get(url, headers=self._headers())
                except Exception:
                    continue
                last_status = resp.status_code
                if resp.status_code >= 400:
                    continue
                try:
                    data = resp.json()
                except Exception:
                    continue
                return [
                    {
                        "id": m.get("id", ""),
                        "type": "model",
                        "display_name": m.get("display_name", m.get("id", "")),
                        "created_at": m.get("created_at", ""),
                    }
                    for m in data.get("data", [])
                ]
        raise RuntimeError(f"模型列表端点不可用 (HTTP {last_status})")

    async def send(self, body: dict) -> tuple[bytes, str, dict, int]:
        """向自适应 Messages 地址发送非流式 Anthropic 请求。"""
        payload = json.dumps(body).encode("utf-8")
        endpoint = self._build_endpoint("messages")
        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(
                endpoint,
                content=payload,
                headers=self._headers(),
            )
        ct = resp.headers.get("content-type", "application/json")
        usage = _empty_usage()
        try:
            rj = resp.json()
            u = rj.get("usage", {}) or {}
            usage = {
                "input_tokens": u.get("input_tokens", 0),
                "output_tokens": u.get("output_tokens", 0),
                "cache_w": u.get("cache_creation_input_tokens", 0),
                "cache_r": u.get("cache_read_input_tokens", 0),
            }
        except Exception:
            pass
        return resp.content, ct, usage, resp.status_code

    async def stream(self, body: dict) -> AsyncIterator[tuple[bytes, dict | None]]:
        """透传自适应 Messages SSE 流并收集最终用量与首字节延迟。"""
        payload = json.dumps(body).encode("utf-8")
        endpoint = self._build_endpoint("messages")
        usage = _empty_usage()
        t0 = time.time()
        first = True
        buf = b""
        async with httpx.AsyncClient(timeout=120.0) as client:
            async with client.stream(
                "POST",
                endpoint,
                content=payload,
                headers=self._headers(),
            ) as resp:
                if resp.status_code >= 400:
                    err = await resp.aread()
                    yield err, {"status": resp.status_code, "error": err[:500].decode("utf-8", "ignore")}
                    return
                async for chunk in resp.aiter_bytes():
                    if first and chunk:
                        first = False
                    buf += chunk
                    while b"\n\n" in buf:
                        event_block, buf = buf.split(b"\n\n", 1)
                        _extract_usage(event_block, usage)
                    yield chunk, None
        if buf:
            _extract_usage(buf, usage)
        yield b"", {**usage, "_eof": True, "ttft_ms": int((time.time() - t0) * 1000) if not first else 0}
