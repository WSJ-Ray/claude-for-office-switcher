"""OpenAI Chat Completions 适配器。

将 Anthropic 格式的请求/响应转换为 OpenAI Chat Completions 格式，
包括流式 SSE 和工具调用。
"""
import json
import time
from typing import AsyncIterator

import httpx

from .base import BaseProvider
from ..translation import anthropic_to_openai_request
from ..translation.o2a import (
    openai_to_anthropic_response,
    openai_stream_to_anthropic_sse,
    _extract_openai_cache_r,
    _sse,
    _new_id,
    _block_id,
    _finish_to_stop,
)
from ._utils import model_list_urls


class OpenAIChatAdapter(BaseProvider):
    format = "openai_chat"

    def _headers(self) -> dict:
        """构造 Chat Completions 请求所需的认证和流式响应头。"""
        # 自定义 User-Agent，避免 Cloudflare WAF 把 httpx 默认 UA 当作 bot 拦截（403）
        ua = (self.extra.get("user_agent")
              or "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                 "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "User-Agent": ua,
            "Accept": "text/event-stream",
            "Accept-Language": "en-US,en;q=0.9",
        }

    async def list_models(self) -> list[dict]:
        """从上游候选端点拉取模型列表（兼容多种 base_url 写法）。"""
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
                out = []
                for m in data.get("data", []):
                    mid = m.get("id", "")
                    out.append(
                        {
                            "id": mid,
                            "type": "model",
                            "display_name": mid,
                            "created_at": "",
                        }
                    )
                return out
        return []

    async def send(self, body: dict) -> tuple[bytes, str, dict, int]:
        """非流式发送请求到上游，并将响应翻译为 Anthropic 格式。"""
        oa_body = anthropic_to_openai_request({**body, "stream": False})
        payload = json.dumps(oa_body).encode("utf-8")
        model = body.get("model", "")
        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(
                f"{self.base_url}/chat/completions",
                content=payload,
                headers=self._headers(),
            )
        ct = resp.headers.get("content-type", "application/json")
        if resp.status_code >= 400:
            return resp.content, ct, {
                "input_tokens": 0, "output_tokens": 0, "cache_w": 0, "cache_r": 0,
            }, resp.status_code
        try:
            oa = resp.json()
        except Exception:
            return resp.content, ct, {"input_tokens": 0, "output_tokens": 0, "cache_w": 0, "cache_r": 0}, resp.status_code
        anth = openai_to_anthropic_response(oa, model)
        usage = anth.get("usage") or {}
        oa_usage = oa.get("usage") or {}
        cached = _extract_openai_cache_r(oa_usage)
        return json.dumps(anth).encode("utf-8"), "application/json", {
            "input_tokens": usage.get("input_tokens", 0),
            "output_tokens": usage.get("output_tokens", 0),
            "cache_w": 0,
            "cache_r": cached,
        }, resp.status_code

    async def stream(self, body: dict) -> AsyncIterator[tuple[bytes, dict | None]]:
        """流式发送请求到上游，将 OpenAI SSE 翻译为 Anthropic SSE 格式。

        某些上游端点即使收到 stream=true 也返回非 SSE 响应（完整 JSON 或错误），
        此时需要兜底将完整响应翻译为 Anthropic 格式后再以 SSE 形式产出。
        """
        oa_body = anthropic_to_openai_request({**body, "stream": True})
        payload = json.dumps(oa_body).encode("utf-8")
        model = body.get("model", "")
        t0 = time.time()
        first_byte = False
        final_usage: dict | None = None
        try:
            async with httpx.AsyncClient(timeout=120.0) as client:
                async with client.stream(
                    "POST",
                    f"{self.base_url}/chat/completions",
                    content=payload,
                    headers=self._headers(),
                ) as resp:
                    # ── HTTP 错误 ──────────────────────────────────────
                    if resp.status_code >= 400:
                        err = await resp.aread()
                        err_text = err[:500].decode("utf-8", "ignore")
                        # 控制台打印上游真实错误，便于诊断
                        print(
                            f"[{time.strftime('%H:%M:%S')}] [UPSTREAM-ERR] "
                            f"{self.base_url}/chat/completions HTTP {resp.status_code} {err_text}",
                            flush=True,
                        )
                        # 产出标准 Anthropic error SSE 事件（携带 status meta 触发故障转移）
                        yield _sse("error", {
                            "type": "error",
                            "error": {
                                "type": "upstream_error",
                                "message": f"HTTP {resp.status_code}: {err_text}",
                            },
                        }), {"status": resp.status_code, "error": err_text}
                        return

                    # ── 收集所有原始字节（用于两种路径） ───────────────
                    raw = b""
                    async for c in resp.aiter_bytes():
                        if c:
                            first_byte = True
                        raw += c

                    ct = resp.headers.get("content-type", "")

                    # ── 判断是否为 SSE 响应 ───────────────────────────
                    is_sse = "text/event-stream" in ct or b"data:" in raw

                    if not is_sse:
                        # 非 SSE 响应：当作完整非流式响应翻译
                        try:
                            oa = resp.json()
                        except Exception:
                            # 无法解析 → 上游返回了非预期的非 JSON 响应
                            err_text = raw[:500].decode("utf-8", "ignore")
                            print(
                                f"[{time.strftime('%H:%M:%S')}] [UPSTREAM-ERR] "
                                f"{self.base_url}/chat/completions 非 SSE 且无法解析 JSON: {err_text}",
                                flush=True,
                            )
                            yield _sse("error", {
                                "type": "error",
                                "error": {
                                    "type": "upstream_error",
                                    "message": f"non-SSE non-JSON response: {err_text}",
                                },
                            }), {"status": 502, "error": err_text}
                            return

                        anth = openai_to_anthropic_response(oa, model)
                        usage = anth.get("usage") or {}
                        oa_usage = oa.get("usage") or {}
                        cached = _extract_openai_cache_r(oa_usage)

                        # 将翻译后的 Anthropic 响应拆成 SSE 事件产出
                        msg_id = anth.get("id", _new_id())
                        yield _sse("message_start", {
                            "type": "message_start",
                            "message": {
                                "id": msg_id,
                                "type": "message",
                                "role": "assistant",
                                "model": model,
                                "content": [],
                                "stop_reason": None,
                                "stop_sequence": None,
                                "usage": {
                                    "input_tokens": usage.get("input_tokens", 0),
                                    "output_tokens": usage.get("output_tokens", 0),
                                },
                            },
                        }), None

                        for block in anth.get("content", []):
                            if block.get("type") == "text":
                                yield _sse("content_block_start", {
                                    "type": "content_block_start",
                                    "index": 0,
                                    "content_block": {"type": "text", "text": ""},
                                }), None
                                yield _sse("content_block_delta", {
                                    "type": "content_block_delta",
                                    "index": 0,
                                    "delta": {"type": "text_delta", "text": block.get("text", "")},
                                }), None
                                yield _sse("content_block_stop", {
                                    "type": "content_block_stop",
                                    "index": 0,
                                }), None
                            elif block.get("type") == "tool_use":
                                yield _sse("content_block_start", {
                                    "type": "content_block_start",
                                    "index": 1,
                                    "content_block": {
                                        "type": "tool_use",
                                        "id": block.get("id", _block_id()),
                                        "name": block.get("name", ""),
                                        "input": {},
                                    },
                                }), None
                                yield _sse("content_block_delta", {
                                    "type": "content_block_delta",
                                    "index": 1,
                                    "delta": {"type": "input_json_delta", "partial_json": json.dumps(block.get("input", {}))},
                                }), None
                                yield _sse("content_block_stop", {
                                    "type": "content_block_stop",
                                    "index": 1,
                                }), None

                        yield _sse("message_delta", {
                            "type": "message_delta",
                            "delta": {"stop_reason": _finish_to_stop(anth.get("stop_reason")), "stop_sequence": None},
                            "usage": {"output_tokens": usage.get("output_tokens", 0)},
                        }), None
                        yield _sse("message_stop", {"type": "message_stop"}), {
                            "input_tokens": usage.get("input_tokens", 0),
                            "output_tokens": usage.get("output_tokens", 0),
                            "cache_w": 0,
                            "cache_r": cached,
                        }
                        final_usage = {
                            "input_tokens": usage.get("input_tokens", 0),
                            "output_tokens": usage.get("output_tokens", 0),
                            "cache_w": 0, "cache_r": cached,
                        }
                        ttft_ms = int((time.time() - t0) * 1000)
                        yield b"", {**final_usage, "_eof": True, "ttft_ms": ttft_ms}
                        return

                    # ── 标准 SSE 路径 ─────────────────────────────────
                    async def _iter():
                        """将已收集的响应字节重新分块为异步迭代器。"""
                        for i in range(0, len(raw), 8192):
                            yield raw[i:i+8192]

                    async for sse_chunk, u in openai_stream_to_anthropic_sse(_iter(), model):
                        if u is not None and "input_tokens" in u and "status" not in u:
                            final_usage = u  # cache_r 由 translator 在 final_usage 中传递
                        yield sse_chunk, None
        except (httpx.ReadError, httpx.RemoteProtocolError,
                httpx.ConnectError, httpx.ReadTimeout, httpx.WriteError) as e:
            # 上游连接中断 / 读超时 / 网络错误：转为 Anthropic error 事件
            print(
                f"[{time.strftime('%H:%M:%S')}] [UPSTREAM-ERR] "
                f"{self.base_url}/chat/completions 网络错误 {type(e).__name__}: {e}",
                flush=True,
            )
            yield _sse("error", {
                "type": "error",
                "error": {
                    "type": "upstream_error",
                    "message": f"upstream network error: {type(e).__name__}: {e}",
                },
            }), {"status": 502, "error": f"{type(e).__name__}: {e}"}
            return
        except Exception as e:
            print(
                f"[{time.strftime('%H:%M:%S')}] [UPSTREAM-ERR] "
                f"{self.base_url}/chat/completions 未知异常 {type(e).__name__}: {e}",
                flush=True,
            )
            yield _sse("error", {
                "type": "error",
                "error": {
                    "type": "upstream_error",
                    "message": f"upstream error: {type(e).__name__}: {e}",
                },
            }), {"status": 502, "error": f"{type(e).__name__}: {e}"}
            return
        if final_usage is None:
            final_usage = {"input_tokens": 0, "output_tokens": 0, "cache_w": 0, "cache_r": 0}
        if "cache_r" not in final_usage:
            final_usage["cache_r"] = 0
        if "cache_w" not in final_usage:
            final_usage["cache_w"] = 0
        ttft_ms = int((time.time() - t0) * 1000) if first_byte else 0
        yield b"", {**final_usage, "_eof": True, "ttft_ms": ttft_ms}
