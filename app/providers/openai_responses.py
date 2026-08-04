"""OpenAI Responses API adapter."""
import json
import time
from typing import AsyncIterator

import httpx

from ._utils import model_list_urls
from .base import BaseProvider
from ..translation.responses import (
    ResponsesTranslationError,
    anthropic_to_responses_request,
    responses_to_anthropic_response,
    responses_stream_to_anthropic_sse,
)
from ..translation.o2a import _sse


def _empty_usage() -> dict:
    """创建字段完整且初始值为零的 token 用量字典。"""
    return {"input_tokens": 0, "output_tokens": 0, "cache_w": 0, "cache_r": 0}


def _translation_error_response(error: ResponsesTranslationError) -> tuple[bytes, str, dict, int]:
    """将本地协议转换错误规范为 Anthropic 错误响应和日志元数据。"""
    payload = {
        "type": "error",
        "error": {"type": error.error_type, "message": str(error)},
    }
    return (
        json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        "application/json",
        {**_empty_usage(), "error": str(error), "error_type": error.error_type},
        error.status_code,
    )


def _translation_error_sse(error: ResponsesTranslationError) -> tuple[bytes, dict]:
    """将本地协议转换错误规范为 Anthropic 流式错误事件和元数据。"""
    return _sse(
        "error",
        {
            "type": "error",
            "error": {"type": error.error_type, "message": str(error)},
        },
    ), {"status": error.status_code, "error": str(error), "error_type": error.error_type}


class OpenAIResponsesAdapter(BaseProvider):
    format = "openai_responses"

    def _headers(self, *, stream: bool) -> dict:
        """构造 Responses API 的认证、组织和按请求类型匹配的 Accept 头。"""
        ua = (
            self.extra.get("user_agent")
            or "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
               "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        )
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "User-Agent": ua,
            "Accept": "text/event-stream" if stream else "application/json",
            "Accept-Language": "en-US,en;q=0.9",
        }
        if self.extra.get("organization"):
            headers["OpenAI-Organization"] = self.extra["organization"]
        if self.extra.get("project"):
            headers["OpenAI-Project"] = self.extra["project"]
        return headers

    def _model_headers(self) -> dict:
        """基于通用请求头构造模型发现所需的 JSON 响应头。"""
        return self._headers(stream=False)

    def _store_enabled(self) -> bool:
        """读取 Provider 的 Responses 存储策略，缺省时保持启用。"""
        return self.extra.get("store") is not False

    def _responses_url(self) -> str:
        """根据不同基础地址写法解析最终 Responses API 地址。"""
        if self.base_url.endswith("/responses"):
            return self.base_url
        if self.base_url.endswith("/v1"):
            return f"{self.base_url}/responses"
        return f"{self.base_url}/v1/responses"

    async def list_models(self) -> list[dict]:
        """尝试候选模型端点并返回 Anthropic 风格模型列表。"""
        last_status: int | None = None
        async with httpx.AsyncClient(timeout=30.0) as client:
            for url in model_list_urls(self.base_url):
                try:
                    resp = await client.get(url, headers=self._model_headers())
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
        """发送非流式 Responses 请求并转换为 Anthropic 响应。"""
        try:
            responses_body = anthropic_to_responses_request(
                {**body, "stream": False}, store=self._store_enabled()
            )
        except ResponsesTranslationError as error:
            return _translation_error_response(error)
        payload = json.dumps(responses_body).encode("utf-8")
        model = body.get("model", "")
        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(
                self._responses_url(),
                content=payload,
                headers=self._headers(stream=False),
            )
        ct = resp.headers.get("content-type", "application/json")
        if resp.status_code >= 400:
            err_text = resp.content[:500].decode("utf-8", "ignore")
            return resp.content, ct, {
                **_empty_usage(), "error": err_text, "error_type": "upstream_error"
            }, resp.status_code
        try:
            responses_payload = resp.json()
        except Exception:
            return resp.content, ct, {
                **_empty_usage(), "error": "Responses API returned invalid JSON", "error_type": "upstream_error"
            }, resp.status_code

        try:
            anth = responses_to_anthropic_response(responses_payload, model)
        except ResponsesTranslationError as error:
            return _translation_error_response(error)
        usage = anth.get("usage") or {}
        raw_usage = responses_payload.get("usage") or {}
        input_details = raw_usage.get("input_tokens_details") or {}
        cache_r = input_details.get("cached_tokens", 0) if isinstance(input_details, dict) else 0
        return (
            json.dumps(anth).encode("utf-8"),
            "application/json",
            {
                "input_tokens": usage.get("input_tokens", 0),
                "output_tokens": usage.get("output_tokens", 0),
                "cache_w": 0,
                "cache_r": cache_r,
            },
            resp.status_code,
        )

    async def stream(self, body: dict) -> AsyncIterator[tuple[bytes, dict | None]]:
        """发送流式 Responses 请求并产出 Anthropic SSE 事件和最终用量。"""
        try:
            responses_body = anthropic_to_responses_request(
                {**body, "stream": True}, store=self._store_enabled()
            )
        except ResponsesTranslationError as error:
            yield _translation_error_sse(error)
            return
        payload = json.dumps(responses_body).encode("utf-8")
        model = body.get("model", "")
        t0 = time.time()
        first_byte = False
        final_usage: dict | None = None
        try:
            async with httpx.AsyncClient(timeout=120.0) as client:
                async with client.stream(
                    "POST",
                    self._responses_url(),
                    content=payload,
                    headers=self._headers(stream=True),
                ) as resp:
                    if resp.status_code >= 400:
                        err = await resp.aread()
                        err_text = err[:500].decode("utf-8", "ignore")
                        print(
                            f"[{time.strftime('%H:%M:%S')}] [UPSTREAM-ERR] "
                            f"{self._responses_url()} HTTP {resp.status_code} {err_text}",
                            flush=True,
                        )
                        yield _sse(
                            "error",
                            {
                                "type": "error",
                                "error": {
                                    "type": "upstream_error",
                                    "message": f"HTTP {resp.status_code}: {err_text}",
                                },
                            },
                        ), {"status": resp.status_code, "error": err_text}
                        return

                    ct = resp.headers.get("content-type", "")
                    if "text/event-stream" not in ct:
                        raw = await resp.aread()
                        try:
                            responses_payload = json.loads(raw)
                        except Exception:
                            err_text = raw[:500].decode("utf-8", "ignore")
                            yield _sse(
                                "error",
                                {
                                    "type": "error",
                                    "error": {
                                        "type": "upstream_error",
                                        "message": f"non-SSE non-JSON response: {err_text}",
                                    },
                                },
                            ), {"status": 502, "error": err_text}
                            return

                        try:
                            anth = responses_to_anthropic_response(responses_payload, model)
                        except ResponsesTranslationError as error:
                            yield _translation_error_sse(error)
                            return
                        usage = anth.get("usage") or {}
                        raw_usage = responses_payload.get("usage") or {}
                        input_details = raw_usage.get("input_tokens_details") or {}
                        cache_r = input_details.get("cached_tokens", 0) if isinstance(input_details, dict) else 0
                        msg_id = anth.get("id")
                        yield _sse(
                            "message_start",
                            {
                                "type": "message_start",
                                "message": {
                                    "id": msg_id,
                                    "type": "message",
                                    "role": "assistant",
                                    "model": anth.get("model") or model,
                                    "content": [],
                                    "stop_reason": None,
                                    "stop_sequence": None,
                                    "usage": {
                                        "input_tokens": usage.get("input_tokens", 0),
                                        "output_tokens": 1,
                                    },
                                },
                            },
                        ), None
                        for index, block in enumerate(anth.get("content", [])):
                            if block.get("type") == "text":
                                yield _sse(
                                    "content_block_start",
                                    {
                                        "type": "content_block_start",
                                        "index": index,
                                        "content_block": {"type": "text", "text": ""},
                                    },
                                ), None
                                yield _sse(
                                    "content_block_delta",
                                    {
                                        "type": "content_block_delta",
                                        "index": index,
                                        "delta": {"type": "text_delta", "text": block.get("text", "")},
                                    },
                                ), None
                                yield _sse("content_block_stop", {"type": "content_block_stop", "index": index}), None
                            elif block.get("type") == "tool_use":
                                yield _sse(
                                    "content_block_start",
                                    {
                                        "type": "content_block_start",
                                        "index": index,
                                        "content_block": {
                                            "type": "tool_use",
                                            "id": block.get("id"),
                                            "name": block.get("name", ""),
                                            "input": {},
                                        },
                                    },
                                ), None
                                yield _sse(
                                    "content_block_delta",
                                    {
                                        "type": "content_block_delta",
                                        "index": index,
                                        "delta": {
                                            "type": "input_json_delta",
                                            "partial_json": json.dumps(block.get("input", {})),
                                        },
                                    },
                                ), None
                                yield _sse("content_block_stop", {"type": "content_block_stop", "index": index}), None

                        yield _sse(
                            "message_delta",
                            {
                                "type": "message_delta",
                                "delta": {"stop_reason": anth.get("stop_reason", "end_turn"), "stop_sequence": None},
                                "usage": {"output_tokens": usage.get("output_tokens", 0)},
                            },
                        ), None
                        yield _sse("message_stop", {"type": "message_stop"}), None
                        final_usage = {
                            "input_tokens": usage.get("input_tokens", 0),
                            "output_tokens": usage.get("output_tokens", 0),
                            "cache_w": 0,
                            "cache_r": cache_r,
                        }
                        yield b"", {**final_usage, "_eof": True, "ttft_ms": int((time.time() - t0) * 1000)}
                        return

                    async for chunk, usage in responses_stream_to_anthropic_sse(resp.aiter_bytes(), model):
                        if chunk:
                            first_byte = True
                        if usage is not None and "input_tokens" in usage and "status" not in usage:
                            final_usage = usage
                        if usage is not None and usage.get("status", 0) >= 400:
                            yield chunk, usage
                            return
                        yield chunk, None
        except ResponsesTranslationError as error:
            yield _translation_error_sse(error)
            return
        except (
            httpx.ReadError,
            httpx.RemoteProtocolError,
            httpx.ConnectError,
            httpx.ReadTimeout,
            httpx.WriteError,
        ) as e:
            print(
                f"[{time.strftime('%H:%M:%S')}] [UPSTREAM-ERR] "
                f"{self._responses_url()} network error {type(e).__name__}: {e}",
                flush=True,
            )
            yield _sse(
                "error",
                {
                    "type": "error",
                    "error": {
                        "type": "upstream_error",
                        "message": f"upstream network error: {type(e).__name__}: {e}",
                    },
                },
            ), {"status": 502, "error": f"{type(e).__name__}: {e}"}
            return
        except Exception as e:
            print(
                f"[{time.strftime('%H:%M:%S')}] [UPSTREAM-ERR] "
                f"{self._responses_url()} error {type(e).__name__}: {e}",
                flush=True,
            )
            yield _sse(
                "error",
                {
                    "type": "error",
                    "error": {
                        "type": "upstream_error",
                        "message": f"upstream error: {type(e).__name__}: {e}",
                    },
                },
            ), {"status": 502, "error": f"{type(e).__name__}: {e}"}
            return

        if final_usage is None:
            final_usage = _empty_usage()
        ttft_ms = int((time.time() - t0) * 1000) if first_byte else 0
        yield b"", {**final_usage, "_eof": True, "ttft_ms": ttft_ms}
