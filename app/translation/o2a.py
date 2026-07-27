"""OpenAI Chat Completions 响应/流式 chunk → Anthropic Messages 响应/SSE 转换器。"""
import json
import uuid
from typing import AsyncIterator


def _new_id() -> str:
    """生成 Anthropic 风格的消息 ID。"""
    return f"msg_{uuid.uuid4().hex[:24]}"


def _block_id() -> str:
    """生成 Anthropic 风格的工具调用内容块 ID。"""
    return f"toolu_{uuid.uuid4().hex[:24]}"


def _finish_to_stop(reason: str | None) -> str:
    """将 OpenAI 结束原因映射为 Anthropic 停止原因。"""
    return {
        "stop": "end_turn",
        "length": "max_tokens",
        "tool_calls": "tool_use",
        "content_filter": "end_turn",
        "function_call": "tool_use",
    }.get(reason or "", "end_turn")


def _sse(event: str, data: dict) -> bytes:
    """将事件名称和数据编码为标准 SSE 字节块。"""
    payload = json.dumps(data, ensure_ascii=False)
    return f"event: {event}\ndata: {payload}\n\n".encode("utf-8")


def _extract_openai_cache_r(usage) -> int:
    """从 OpenAI 兼容 usage dict 提取缓存读 tokens。

    优先级：
    1. prompt_tokens_details.cached_tokens（OpenAI 标准）
    2. prompt_cache_hit_tokens（DeepSeek）
    3. prompt_tokens_cached（旧版 / 其他）
    """
    if not isinstance(usage, dict):
        return 0
    details = usage.get("prompt_tokens_details")
    if isinstance(details, dict):
        val = details.get("cached_tokens")
        if val:
            return val
    val = usage.get("prompt_cache_hit_tokens")
    if val:
        return val
    return usage.get("prompt_tokens_cached") or 0


def openai_to_anthropic_response(payload: dict, model: str) -> dict:
    """将非流式的 OpenAI Chat Completions 响应翻译为 Anthropic Messages 响应。"""
    choice = (payload.get("choices") or [{}])[0]
    msg = choice.get("message") or {}
    content: list[dict] = []
    if msg.get("content"):
        content.append({"type": "text", "text": msg["content"]})
    for tc in msg.get("tool_calls") or []:
        fn = tc.get("function") or {}
        try:
            args = json.loads(fn.get("arguments") or "{}")
        except Exception:
            args = {}
        content.append(
            {
                "type": "tool_use",
                "id": tc.get("id", _block_id()),
                "name": fn.get("name", ""),
                "input": args,
            }
        )
    stop = _finish_to_stop(choice.get("finish_reason"))
    usage = payload.get("usage") or {}
    out = {
        "id": payload.get("id", _new_id()),
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": content,
        "stop_reason": stop,
        "stop_sequence": None,
        "usage": {
            "input_tokens": usage.get("prompt_tokens", 0),
            "output_tokens": usage.get("completion_tokens", 0),
        },
    }
    return out


async def openai_stream_to_anthropic_sse(
    openai_iter: AsyncIterator[bytes], model: str
) -> AsyncIterator[tuple[bytes, dict | None]]:
    """将 OpenAI Chat Completions SSE 流翻译为 Anthropic Messages SSE 流。

    产出 (SSE 字节, 用量或None)。最后一次产出的用量字典标记流结束。
    """
    msg_id = _new_id()
    sent_message_start = False
    sent_text_block_start = False
    text_block_index = 0
    tool_block_index = -1
    tool_block_started = False
    sent_stop = False
    text_started = False
    pending_text = ""
    pending_tool_args = ""
    tool_id = ""
    tool_name = ""
    final_usage: dict = {"input_tokens": 0, "output_tokens": 0, "cache_r": 0}
    finish_reason: str | None = None
    response_id = ""
    model_name = model

    def emit_text_start():
        """构造文本内容块开始事件。"""
        return _sse(
            "content_block_start",
            {
                "type": "content_block_start",
                "index": text_block_index,
                "content_block": {"type": "text", "text": ""},
            },
        )

    def emit_tool_start():
        """构造工具调用内容块开始事件。"""
        return _sse(
            "content_block_start",
            {
                "type": "content_block_start",
                "index": tool_block_index,
                "content_block": {
                    "type": "tool_use",
                    "id": tool_id,
                    "name": tool_name,
                    "input": {},
                },
            },
        )

    async def line_iter():
        """从任意字节分块中逐行解析 OpenAI SSE JSON 数据。"""
        buf = b""
        async for chunk in openai_iter:
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                line = line.strip()
                if not line:
                    continue
                if line.startswith(b"data:"):
                    data = line[5:].strip()
                    if data == b"[DONE]":
                        return
                    try:
                        yield json.loads(data)
                    except Exception:
                        continue

    async for data in line_iter():
        response_id = data.get("id") or response_id
        model_name = data.get("model") or model_name

        if not sent_message_start:
            sent_message_start = True
            yield _sse(
                "message_start",
                {
                    "type": "message_start",
                    "message": {
                        "id": response_id or msg_id,
                        "type": "message",
                        "role": "assistant",
                        "model": model_name,
                        "content": [],
                        "stop_reason": None,
                        "stop_sequence": None,
                        "usage": {
                            "input_tokens": final_usage["input_tokens"],
                            "output_tokens": 1,
                        },
                    },
                },
            ), None
            yield _sse(
                "ping",
                {"type": "ping"},
            ), None

        for choice in data.get("choices", []) or []:
            delta = choice.get("delta") or {}
            fr = choice.get("finish_reason")
            if fr:
                finish_reason = fr

            # text delta
            if delta.get("content"):
                if not text_started:
                    text_started = True
                    yield emit_text_start(), None
                yield _sse(
                    "content_block_delta",
                    {
                        "type": "content_block_delta",
                        "index": text_block_index,
                        "delta": {"type": "text_delta", "text": delta["content"]},
                    },
                ), None

            # tool calls
            for tc in (delta.get("tool_calls") or []):
                if tc.get("id"):
                    # finalize previous text block if any
                    if text_started and not sent_stop:
                        yield _sse(
                            "content_block_stop",
                            {"type": "content_block_stop", "index": text_block_index},
                        ), None
                        text_started = False
                    tool_id = tc.get("id", _block_id())
                    tool_name = (tc.get("function") or {}).get("name", "")
                    tool_block_index = text_block_index + 1
                    tool_block_started = True
                    yield emit_tool_start(), None
                # arguments delta
                arg_delta = (tc.get("function") or {}).get("arguments", "")
                if arg_delta:
                    yield _sse(
                        "content_block_delta",
                        {
                            "type": "content_block_delta",
                            "index": tool_block_index,
                            "delta": {"type": "input_json_delta", "partial_json": arg_delta},
                        },
                    ), None

        u = data.get("usage")
        if u:
            final_usage = {
                "input_tokens": u.get("prompt_tokens", 0),
                "output_tokens": u.get("completion_tokens", 0),
                "cache_r": _extract_openai_cache_r(u),
            }

    # 收尾：关闭所有已打开的 content block
    if text_started:
        yield _sse(
            "content_block_stop",
            {"type": "content_block_stop", "index": text_block_index},
        ), None
    if tool_block_started:
        yield _sse(
            "content_block_stop",
            {"type": "content_block_stop", "index": tool_block_index},
        ), None

    yield _sse(
        "message_delta",
        {
            "type": "message_delta",
            "delta": {"stop_reason": _finish_to_stop(finish_reason), "stop_sequence": None},
            "usage": {"output_tokens": final_usage["output_tokens"]},
        },
    ), None
    yield _sse("message_stop", {"type": "message_stop"}), {
        "input_tokens": final_usage["input_tokens"],
        "output_tokens": final_usage["output_tokens"],
        "cache_w": 0,
        "cache_r": final_usage["cache_r"],
    }
