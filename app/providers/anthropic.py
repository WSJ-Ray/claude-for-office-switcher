"""Anthropic 原生适配器。

作为 Anthropic 兼容端点（如 DeepSeek /anthropic、Moonshot /anthropic 等）的
透明代理。仅做最小预处理（去除 tools.type=custom），透传请求与响应。
"""
import json
import time
from typing import AsyncIterator

import httpx

from .base import BaseProvider
from ._utils import model_list_urls


def _strip_tool_type(body: dict) -> None:
    """移除部分 Anthropic 兼容上游不接受的自定义工具类型字段。"""
    tools = body.get("tools")
    if tools:
        for t in tools:
            t.pop("type", None)
    tc = body.get("tool_choice")
    if isinstance(tc, dict) and tc.get("type") == "custom":
        tc.pop("type", None)


def _empty_usage() -> dict:
    """创建字段完整且初始值为零的 token 用量字典。"""
    return {"input_tokens": 0, "output_tokens": 0, "cache_w": 0, "cache_r": 0}


def _extract_cache_w(u: dict) -> int:
    """从 Anthropic 兼容 usage dict 中提取缓存写入 tokens。

    优先级：
    1. cache_creation_input_tokens（标准 Anthropic）
    2. claude_cache_creation_5_m_tokens + claude_cache_creation_1_h_tokens（NewAPI 平铺）
    3. cache_creation.ephemeral_5m_input_tokens + ephemeral_1h_input_tokens（NewAPI 嵌套）

    各字段用 `or 0` 防御 JSON null 值。
    """
    cache_w = u.get("cache_creation_input_tokens", 0)
    if cache_w:
        return cache_w
    v5 = u.get("claude_cache_creation_5_m_tokens") or 0
    v1h = u.get("claude_cache_creation_1_h_tokens") or 0
    cache_w = v5 + v1h
    if cache_w:
        return cache_w
    cc = u.get("cache_creation") or {}
    v5 = cc.get("ephemeral_5m_input_tokens") or 0
    v1h = cc.get("ephemeral_1h_input_tokens") or 0
    return v5 + v1h


def _extract_usage(block: bytes, usage: dict) -> None:
    """从一段 SSE 事件块中提取 usage，原地更新 usage。

    Anthropic 流式 SSE 在 message_start 携带 input/cache 字段，
    在 message_delta 携带最终 output_tokens。解析失败或非相关事件时静默跳过。

    兼容 NewAPI（QuantumNous/new-api）的额外字段：
    - cache_creation.ephemeral_5m_input_tokens
    - cache_creation.ephemeral_1h_input_tokens
    - claude_cache_creation_5_m_tokens / claude_cache_creation_1_h_tokens

    注意：即使字段值为 0 也要覆盖，避免前一次请求的缓存值被错误保留。
    """
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
        # 只在新值非零时覆盖，避免第二个 message_start 事件清零首次捕获值
        new_input = u.get("input_tokens", 0) or 0
        if new_input:
            usage["input_tokens"] = new_input
        usage["cache_w"] = _extract_cache_w(u)
        new_cr = u.get("cache_read_input_tokens", 0) or 0
        if new_cr:
            usage["cache_r"] = new_cr
        new_out = u.get("output_tokens", 0) or 0
        if new_out:
            usage["output_tokens"] = new_out
    elif etype == "message_delta":
        u = obj.get("usage") or {}
        if u.get("output_tokens") is not None:
            usage["output_tokens"] = u["output_tokens"]
        # 某些 NewAPI 变体将 cache 字段放在 delta 事件中
        delta_cw = _extract_cache_w(u)
        if delta_cw:
            usage["cache_w"] = delta_cw
        delta_cr = u.get("cache_read_input_tokens") or 0
        if delta_cr:
            usage["cache_r"] = delta_cr


class AnthropicAdapter(BaseProvider):
    format = "anthropic"

    def _headers(self) -> dict:
        """构造 Anthropic 兼容请求头和可配置的浏览器 User-Agent。"""
        # 自定义 User-Agent，避免 Cloudflare WAF 把 httpx 默认 UA 当作 bot 拦截（403）
        ua = (self.extra.get("user_agent")
              or "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                 "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "User-Agent": ua,
        }

    async def list_models(self) -> list[dict]:
        """尝试候选端点拉取模型列表。

        任一候选返回 2xx 即解析返回；全部失败时抛 RuntimeError，
        以便 preview/test 端点如实反映"端点不可用"而非伪报成功。
        """
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
        """非流式发送请求到上游。"""
        _strip_tool_type(body)
        payload = json.dumps(body).encode("utf-8")
        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(
                f"{self.base_url}/v1/messages",
                content=payload,
                headers=self._headers(),
            )
        ct = resp.headers.get("content-type", "application/json")
        usage = _empty_usage()
        try:
            rj = resp.json()
            u = rj.get("usage") or {}
            cache_w = _extract_cache_w(u)
            usage = {
                "input_tokens": u.get("input_tokens") or 0,
                "output_tokens": u.get("output_tokens") or 0,
                "cache_w": cache_w,
                "cache_r": u.get("cache_read_input_tokens") or 0,
            }
        except Exception:
            pass
        return resp.content, ct, usage, resp.status_code

    async def stream(self, body: dict) -> AsyncIterator[tuple[bytes, dict | None]]:
        """流式发送请求到上游，产出 Anthropic 格式的 SSE 事件。"""
        _strip_tool_type(body)
        payload = json.dumps(body).encode("utf-8")
        usage = _empty_usage()
        t0 = time.time()
        first = True
        buf = b""
        async with httpx.AsyncClient(timeout=120.0) as client:
            async with client.stream(
                "POST",
                f"{self.base_url}/v1/messages",
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
                # 流正常结束后，解析残余缓冲（可能有最后一个事件但没有尾部 \n\n）
                if buf:
                    _extract_usage(buf, usage)
        yield b"", {**usage, "_eof": True, "ttft_ms": int((time.time() - t0) * 1000) if not first else 0}
