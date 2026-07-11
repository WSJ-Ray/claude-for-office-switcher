"""OpenAI Responses API <-> Anthropic Messages translation helpers."""
import json
import uuid
from typing import Any, AsyncIterator

from .o2a import _sse


def _new_id() -> str:
    return f"msg_{uuid.uuid4().hex[:24]}"


def _block_id() -> str:
    return f"toolu_{uuid.uuid4().hex[:24]}"


def _usage_from_response(usage: dict | None) -> dict:
    if not isinstance(usage, dict):
        return {"input_tokens": 0, "output_tokens": 0, "cache_w": 0, "cache_r": 0}
    input_details = usage.get("input_tokens_details") or {}
    return {
        "input_tokens": usage.get("input_tokens", 0),
        "output_tokens": usage.get("output_tokens", 0),
        "cache_w": 0,
        "cache_r": input_details.get("cached_tokens", 0) if isinstance(input_details, dict) else 0,
    }


def _text_from_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return str(content or "")
    parts: list[str] = []
    for block in content:
        if not isinstance(block, dict):
            continue
        btype = block.get("type")
        if btype == "text":
            parts.append(block.get("text", ""))
        elif btype == "tool_result":
            value = block.get("content")
            if isinstance(value, list):
                parts.append("\n".join(x.get("text", "") for x in value if isinstance(x, dict) and x.get("type") == "text"))
            else:
                parts.append(str(value or ""))
    return "\n".join(p for p in parts if p)


def _input_content_from_anthropic(content: Any) -> list[dict]:
    text = _text_from_content(content)
    return [{"type": "input_text", "text": text}] if text else []


def _output_content_from_anthropic(content: Any) -> list[dict]:
    if isinstance(content, str):
        return [{"type": "output_text", "text": content}]
    if not isinstance(content, list):
        return [{"type": "output_text", "text": str(content or "")}]
    out: list[dict] = []
    for block in content:
        if isinstance(block, dict) and block.get("type") == "text":
            out.append({"type": "output_text", "text": block.get("text", "")})
    return out


def _tool_to_responses(tool: dict) -> dict:
    return {
        "type": "function",
        "name": tool.get("name", ""),
        "description": tool.get("description", ""),
        "parameters": tool.get("input_schema") or {"type": "object", "properties": {}},
    }


def anthropic_to_responses_request(body: dict) -> dict:
    """Translate an Anthropic Messages request to an OpenAI Responses request."""
    out: dict = {"model": body["model"], "input": []}

    system = body.get("system")
    if system:
        if isinstance(system, str):
            system_text = system
        else:
            system_text = "\n".join(
                block.get("text", "") for block in system
                if isinstance(block, dict) and block.get("type") == "text"
            )
        if system_text:
            out["input"].append(
                {
                    "type": "message",
                    "role": "system",
                    "content": [{"type": "input_text", "text": system_text}],
                }
            )

    for message in body.get("messages", []):
        role = message.get("role")
        content = message.get("content")
        if role == "user":
            if isinstance(content, list):
                user_parts: list[dict] = []
                for block in content:
                    if not isinstance(block, dict):
                        continue
                    if block.get("type") == "tool_result":
                        out["input"].append(
                            {
                                "type": "function_call_output",
                                "call_id": block.get("tool_use_id", ""),
                                "output": _text_from_content(block.get("content")),
                            }
                        )
                    elif block.get("type") == "text":
                        user_parts.append({"type": "input_text", "text": block.get("text", "")})
                if user_parts:
                    out["input"].append({"type": "message", "role": "user", "content": user_parts})
            else:
                out["input"].append(
                    {
                        "type": "message",
                        "role": "user",
                        "content": _input_content_from_anthropic(content),
                    }
                )
        elif role == "assistant":
            output_content = _output_content_from_anthropic(content)
            if output_content:
                out["input"].append(
                    {
                        "type": "message",
                        "role": "assistant",
                        "content": output_content,
                    }
                )
            if isinstance(content, list):
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "tool_use":
                        out["input"].append(
                            {
                                "type": "function_call",
                                "call_id": block.get("id", _block_id()),
                                "name": block.get("name", ""),
                                "arguments": json.dumps(block.get("input") or {}),
                                "status": "completed",
                            }
                        )

    if "max_tokens" in body:
        out["max_output_tokens"] = body["max_tokens"]
    for key in ("temperature", "top_p", "stream", "metadata", "parallel_tool_calls"):
        if key in body:
            out[key] = body[key]
    tools = body.get("tools")
    if tools:
        out["tools"] = [_tool_to_responses(t) for t in tools if t.get("name")]
    tool_choice = body.get("tool_choice")
    if tool_choice is not None:
        if isinstance(tool_choice, str):
            out["tool_choice"] = "required" if tool_choice == "any" else tool_choice
        elif isinstance(tool_choice, dict):
            if tool_choice.get("type") == "tool":
                out["tool_choice"] = {"type": "function", "name": tool_choice.get("name", "")}
            else:
                out["tool_choice"] = "auto"

    return out


def responses_to_anthropic_response(payload: dict, model: str) -> dict:
    """Translate a non-streaming Responses API response to Anthropic Messages."""
    content: list[dict] = []
    for item in payload.get("output") or []:
        itype = item.get("type")
        if itype == "message":
            for part in item.get("content") or []:
                ptype = part.get("type")
                if ptype == "output_text":
                    content.append({"type": "text", "text": part.get("text", "")})
                elif ptype == "refusal":
                    content.append({"type": "text", "text": part.get("refusal", "")})
        elif itype == "function_call":
            try:
                args = json.loads(item.get("arguments") or "{}")
            except Exception:
                args = {}
            content.append(
                {
                    "type": "tool_use",
                    "id": item.get("call_id") or item.get("id") or _block_id(),
                    "name": item.get("name", ""),
                    "input": args,
                }
            )

    status = payload.get("status")
    has_tool = any(block.get("type") == "tool_use" for block in content)
    incomplete = payload.get("incomplete_details") or {}
    stop_reason = "tool_use" if has_tool else "end_turn"
    if status == "incomplete" and incomplete.get("reason") in {"max_output_tokens", "max_tokens"}:
        stop_reason = "max_tokens"

    usage = _usage_from_response(payload.get("usage"))
    return {
        "id": payload.get("id", _new_id()),
        "type": "message",
        "role": "assistant",
        "model": payload.get("model") or model,
        "content": content,
        "stop_reason": stop_reason,
        "stop_sequence": None,
        "usage": {
            "input_tokens": usage["input_tokens"],
            "output_tokens": usage["output_tokens"],
        },
    }


async def responses_stream_to_anthropic_sse(
    responses_iter: AsyncIterator[bytes], model: str
) -> AsyncIterator[tuple[bytes, dict | None]]:
    """Translate Responses API SSE events to Anthropic Messages SSE events."""
    msg_id = _new_id()
    model_name = model
    sent_message_start = False
    open_blocks: set[int] = set()
    block_index_by_output: dict[int, int] = {}
    tool_name_by_output: dict[int, str] = {}
    tool_id_by_output: dict[int, str] = {}
    final_usage = {"input_tokens": 0, "output_tokens": 0, "cache_w": 0, "cache_r": 0}
    stop_reason = "end_turn"

    def ensure_message_start(response: dict | None = None) -> bytes | None:
        nonlocal sent_message_start, msg_id, model_name
        if response:
            msg_id = response.get("id") or msg_id
            model_name = response.get("model") or model_name
        if sent_message_start:
            return None
        sent_message_start = True
        return _sse(
            "message_start",
            {
                "type": "message_start",
                "message": {
                    "id": msg_id,
                    "type": "message",
                    "role": "assistant",
                    "model": model_name,
                    "content": [],
                    "stop_reason": None,
                    "stop_sequence": None,
                    "usage": {"input_tokens": 0, "output_tokens": 1},
                },
            },
        )

    async def line_iter():
        buf = b""
        async for chunk in responses_iter:
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                line = line.strip()
                if not line or not line.startswith(b"data:"):
                    continue
                data = line[5:].strip()
                if data == b"[DONE]":
                    return
                try:
                    yield json.loads(data)
                except Exception:
                    continue

    async for event in line_iter():
        etype = event.get("type")
        response = event.get("response")

        if etype in {"response.created", "response.in_progress"}:
            start = ensure_message_start(response)
            if start:
                yield start, None
                yield _sse("ping", {"type": "ping"}), None
            continue

        start = ensure_message_start(response if isinstance(response, dict) else None)
        if start:
            yield start, None

        if etype == "response.output_item.added":
            item = event.get("item") or {}
            output_index = int(event.get("output_index", 0))
            if item.get("type") == "function_call":
                stop_reason = "tool_use"
                block_index_by_output[output_index] = output_index
                tool_id_by_output[output_index] = item.get("call_id") or item.get("id") or _block_id()
                tool_name_by_output[output_index] = item.get("name", "")
                open_blocks.add(output_index)
                yield _sse(
                    "content_block_start",
                    {
                        "type": "content_block_start",
                        "index": output_index,
                        "content_block": {
                            "type": "tool_use",
                            "id": tool_id_by_output[output_index],
                            "name": tool_name_by_output[output_index],
                            "input": {},
                        },
                    },
                ), None
            continue

        if etype == "response.content_part.added":
            part = event.get("part") or {}
            if part.get("type") in {"output_text", "refusal"}:
                output_index = int(event.get("output_index", 0))
                content_index = int(event.get("content_index", output_index))
                block_index = block_index_by_output.setdefault(output_index, content_index)
                if block_index not in open_blocks:
                    open_blocks.add(block_index)
                    yield _sse(
                        "content_block_start",
                        {
                            "type": "content_block_start",
                            "index": block_index,
                            "content_block": {"type": "text", "text": ""},
                        },
                    ), None
            continue

        if etype in {"response.output_text.delta", "response.refusal.delta"}:
            output_index = int(event.get("output_index", 0))
            content_index = int(event.get("content_index", output_index))
            block_index = block_index_by_output.setdefault(output_index, content_index)
            if block_index not in open_blocks:
                open_blocks.add(block_index)
                yield _sse(
                    "content_block_start",
                    {
                        "type": "content_block_start",
                        "index": block_index,
                        "content_block": {"type": "text", "text": ""},
                    },
                ), None
            yield _sse(
                "content_block_delta",
                {
                    "type": "content_block_delta",
                    "index": block_index,
                    "delta": {"type": "text_delta", "text": event.get("delta", "")},
                },
            ), None
            continue

        if etype == "response.function_call_arguments.delta":
            output_index = int(event.get("output_index", 0))
            block_index = block_index_by_output.setdefault(output_index, output_index)
            if block_index not in open_blocks:
                stop_reason = "tool_use"
                open_blocks.add(block_index)
                yield _sse(
                    "content_block_start",
                    {
                        "type": "content_block_start",
                        "index": block_index,
                        "content_block": {
                            "type": "tool_use",
                            "id": tool_id_by_output.get(output_index) or event.get("item_id") or _block_id(),
                            "name": tool_name_by_output.get(output_index, ""),
                            "input": {},
                        },
                    },
                ), None
            yield _sse(
                "content_block_delta",
                {
                    "type": "content_block_delta",
                    "index": block_index,
                    "delta": {"type": "input_json_delta", "partial_json": event.get("delta", "")},
                },
            ), None
            continue

        if etype == "response.content_part.done":
            output_index = int(event.get("output_index", 0))
            block_index = block_index_by_output.get(output_index, int(event.get("content_index", output_index)))
            if block_index in open_blocks:
                open_blocks.remove(block_index)
                yield _sse("content_block_stop", {"type": "content_block_stop", "index": block_index}), None
            continue

        if etype in {"response.output_text.done", "response.refusal.done"}:
            output_index = int(event.get("output_index", 0))
            block_index = block_index_by_output.get(output_index, int(event.get("content_index", output_index)))
            if block_index in open_blocks:
                open_blocks.remove(block_index)
                yield _sse("content_block_stop", {"type": "content_block_stop", "index": block_index}), None
            continue

        if etype == "response.output_item.done":
            output_index = int(event.get("output_index", 0))
            item = event.get("item") or {}
            if item.get("type") == "function_call":
                block_index = block_index_by_output.setdefault(output_index, output_index)
                if block_index in open_blocks:
                    open_blocks.remove(block_index)
                    yield _sse("content_block_stop", {"type": "content_block_stop", "index": block_index}), None
            continue

        if etype in {"response.completed", "response.incomplete"}:
            response_obj = event.get("response") or {}
            final_usage = _usage_from_response(response_obj.get("usage"))
            if etype == "response.incomplete":
                reason = (response_obj.get("incomplete_details") or {}).get("reason")
                if reason in {"max_output_tokens", "max_tokens"}:
                    stop_reason = "max_tokens"
            continue

        if etype == "response.failed":
            response_obj = event.get("response") or {}
            error = response_obj.get("error") or {}
            yield _sse(
                "error",
                {
                    "type": "error",
                    "error": {
                        "type": "upstream_error",
                        "message": error.get("message") or "Responses API stream failed",
                    },
                },
            ), {"status": 502, "error": error.get("message") or "Responses API stream failed"}
            return

    for block_index in sorted(open_blocks):
        yield _sse("content_block_stop", {"type": "content_block_stop", "index": block_index}), None

    yield _sse(
        "message_delta",
        {
            "type": "message_delta",
            "delta": {"stop_reason": stop_reason, "stop_sequence": None},
            "usage": {"output_tokens": final_usage["output_tokens"]},
        },
    ), None
    yield _sse("message_stop", {"type": "message_stop"}), final_usage
