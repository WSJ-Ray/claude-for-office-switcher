"""OpenAI Responses API <-> Anthropic Messages translation helpers."""
import base64
import json
import uuid
from typing import Any, AsyncIterator

from .o2a import _sse


class ResponsesTranslationError(ValueError):
    """描述无法在 Anthropic 与 Responses 协议之间安全转换的内容。"""

    def __init__(
        self,
        message: str,
        *,
        error_type: str = "invalid_request_error",
        status_code: int = 400,
    ) -> None:
        super().__init__(message)
        self.error_type = error_type
        self.status_code = status_code


def _new_id() -> str:
    """生成 Anthropic 风格的消息 ID。"""
    return f"msg_{uuid.uuid4().hex[:24]}"


def _block_id() -> str:
    """生成 Anthropic 风格的工具调用内容块 ID。"""
    return f"toolu_{uuid.uuid4().hex[:24]}"


def _usage_from_response(usage: dict | None) -> dict:
    """规范化 Responses API 用量并提取缓存读取 token。"""
    if not isinstance(usage, dict):
        return {"input_tokens": 0, "output_tokens": 0, "cache_w": 0, "cache_r": 0}
    input_details = usage.get("input_tokens_details") or {}
    return {
        "input_tokens": usage.get("input_tokens", 0),
        "output_tokens": usage.get("output_tokens", 0),
        "cache_w": 0,
        "cache_r": input_details.get("cached_tokens", 0) if isinstance(input_details, dict) else 0,
    }


def _data_url(media_type: str, data: str, context: str) -> str:
    """校验 Base64 输入并返回可供 Responses 使用的 data URL。"""
    if not isinstance(data, str) or not data:
        raise ResponsesTranslationError(f"{context} 缺少 Base64 数据")
    if not isinstance(media_type, str) or not media_type:
        raise ResponsesTranslationError(f"{context} 缺少 media_type")
    return f"data:{media_type};base64,{data}"


def _document_filename(block: dict, media_type: str) -> str:
    """从 Anthropic 文档块推导供 Responses 展示的稳定文件名。"""
    title = block.get("title") or block.get("name")
    if isinstance(title, str) and title.strip():
        return title.strip()
    if media_type == "application/pdf":
        return "document.pdf"
    if media_type.startswith("text/"):
        return "document.txt"
    return "document"


def _image_to_responses(block: dict, context: str) -> dict:
    """将 Anthropic 图片块转换为 Responses input_image 内容项。"""
    source = block.get("source")
    if not isinstance(source, dict):
        raise ResponsesTranslationError(f"{context} 的 image.source 必须是对象")
    source_type = source.get("type")
    detail = block.get("detail") or "auto"
    if detail not in {"auto", "low", "high", "original"}:
        raise ResponsesTranslationError(f"{context} 的图片 detail 不受支持: {detail}")
    if source_type == "base64":
        return {
            "type": "input_image",
            "image_url": _data_url(
                source.get("media_type", ""), source.get("data", ""), context
            ),
            "detail": detail,
        }
    if source_type == "url" and isinstance(source.get("url"), str) and source["url"]:
        return {"type": "input_image", "image_url": source["url"], "detail": detail}
    raise ResponsesTranslationError(f"{context} 的图片 source.type 不受支持: {source_type}")


def _document_to_responses(block: dict, context: str) -> list[dict]:
    """将 Anthropic 文档块转换为 Responses 文件或嵌入内容项。"""
    source = block.get("source")
    if not isinstance(source, dict):
        raise ResponsesTranslationError(f"{context} 的 document.source 必须是对象")
    source_type = source.get("type")
    media_type = source.get("media_type") or "text/plain"
    filename = _document_filename(block, media_type)
    if source_type == "base64":
        return [
            {
                "type": "input_file",
                "file_data": _data_url(media_type, source.get("data", ""), context),
                "filename": filename,
            }
        ]
    if source_type == "url" and isinstance(source.get("url"), str) and source["url"]:
        return [{"type": "input_file", "file_url": source["url"], "filename": filename}]
    if source_type == "text":
        text = source.get("data")
        if not isinstance(text, str):
            raise ResponsesTranslationError(f"{context} 的文本文件缺少 data")
        encoded = base64.b64encode(text.encode("utf-8")).decode("ascii")
        return [
            {
                "type": "input_file",
                "file_data": _data_url(media_type, encoded, context),
                "filename": filename,
            }
        ]
    if source_type == "content":
        content = source.get("content")
        if not isinstance(content, list):
            raise ResponsesTranslationError(f"{context} 的嵌入文档内容必须是数组")
        prefix = [{"type": "input_text", "text": f"Document: {filename}"}]
        return prefix + _content_to_responses(content, f"{context}.source.content")
    raise ResponsesTranslationError(f"{context} 的文档 source.type 不受支持: {source_type}")


def _content_to_responses(content: Any, context: str) -> list[dict]:
    """将可表示的 Anthropic 用户内容按原顺序转换为 Responses 输入项。"""
    if isinstance(content, str):
        return [{"type": "input_text", "text": content}]
    if not isinstance(content, list):
        raise ResponsesTranslationError(f"{context} 必须是字符串或内容块数组")

    converted: list[dict] = []
    for index, block in enumerate(content):
        block_context = f"{context}[{index}]"
        if not isinstance(block, dict):
            raise ResponsesTranslationError(f"{block_context} 必须是对象")
        block_type = block.get("type")
        if block_type == "text":
            text = block.get("text")
            if not isinstance(text, str):
                raise ResponsesTranslationError(f"{block_context}.text 必须是字符串")
            converted.append({"type": "input_text", "text": text})
        elif block_type == "image":
            converted.append(_image_to_responses(block, block_context))
        elif block_type == "document":
            converted.extend(_document_to_responses(block, block_context))
        else:
            raise ResponsesTranslationError(f"{block_context} 的内容类型不受支持: {block_type}")
    return converted


def _system_to_instructions(system: Any) -> str | None:
    """将 Anthropic system 内容转换为单个 Responses instructions 字符串。"""
    if system is None:
        return None
    if isinstance(system, str):
        return system
    if not isinstance(system, list):
        raise ResponsesTranslationError("system 必须是字符串或内容块数组")
    parts: list[str] = []
    for index, block in enumerate(system):
        if not isinstance(block, dict) or block.get("type") != "text":
            raise ResponsesTranslationError(f"system[{index}] 仅支持 text 内容块")
        text = block.get("text")
        if not isinstance(text, str):
            raise ResponsesTranslationError(f"system[{index}].text 必须是字符串")
        parts.append(text)
    return "\n".join(parts)


def _tool_to_responses(tool: dict, index: int) -> dict:
    """将 Anthropic 工具定义转换为 Responses 函数工具定义。"""
    name = tool.get("name")
    if not isinstance(name, str) or not name:
        raise ResponsesTranslationError(f"tools[{index}].name 必须是非空字符串")
    parameters = tool.get("input_schema") or {"type": "object", "properties": {}}
    if not isinstance(parameters, dict):
        raise ResponsesTranslationError(f"tools[{index}].input_schema 必须是对象")
    result = {"type": "function", "name": name, "parameters": parameters}
    description = tool.get("description")
    if isinstance(description, str) and description:
        result["description"] = description
    return result


def _tool_choice_to_responses(tool_choice: Any) -> str | dict:
    """将 Anthropic 工具选择策略转换为 Responses 的等价表达。"""
    if isinstance(tool_choice, str):
        tool_choice = {"type": tool_choice}
    if not isinstance(tool_choice, dict):
        raise ResponsesTranslationError("tool_choice 必须是字符串或对象")
    choice_type = tool_choice.get("type")
    if choice_type == "auto":
        return "auto"
    if choice_type == "any":
        return "required"
    if choice_type == "none":
        return "none"
    if choice_type == "tool":
        name = tool_choice.get("name")
        if not isinstance(name, str) or not name:
            raise ResponsesTranslationError("tool_choice.type=tool 时必须提供 name")
        return {"type": "function", "name": name}
    raise ResponsesTranslationError(f"tool_choice.type 不受支持: {choice_type}")


def _function_output_from_tool_result(block: dict, context: str) -> dict:
    """将 Anthropic tool_result 转换为支持多模态内容的函数调用结果。"""
    call_id = block.get("tool_use_id")
    if not isinstance(call_id, str) or not call_id:
        raise ResponsesTranslationError(f"{context}.tool_use_id 必须是非空字符串")
    content = block.get("content", "")
    if isinstance(content, str):
        output: str | list[dict] = content
    else:
        output = _content_to_responses(content, f"{context}.content")
    if block.get("is_error"):
        error_marker = {"type": "input_text", "text": "Tool execution failed."}
        output = [error_marker, *([{"type": "input_text", "text": output}] if isinstance(output, str) else output)]
    return {"type": "function_call_output", "call_id": call_id, "output": output}


def _append_user_message(items: list[dict], content: list[dict]) -> None:
    """在存在普通内容时追加一个 Responses user message，避免空消息。"""
    if content:
        items.append({"type": "message", "role": "user", "content": content})


def _append_assistant_message(items: list[dict], content: list[dict]) -> None:
    """在存在文本时追加一个可重放的 Responses assistant message。"""
    if content:
        items.append({"type": "message", "role": "assistant", "content": content})


def _convert_user_message(items: list[dict], content: Any, context: str) -> None:
    """保序转换包含普通内容和工具结果的 Anthropic user 消息。"""
    if not isinstance(content, list):
        _append_user_message(items, _content_to_responses(content, context))
        return

    pending: list[dict] = []
    for index, block in enumerate(content):
        block_context = f"{context}[{index}]"
        if not isinstance(block, dict):
            raise ResponsesTranslationError(f"{block_context} 必须是对象")
        if block.get("type") == "tool_result":
            _append_user_message(items, pending)
            pending = []
            items.append(_function_output_from_tool_result(block, block_context))
        else:
            pending.extend(_content_to_responses([block], block_context))
    _append_user_message(items, pending)


def _convert_assistant_message(items: list[dict], content: Any, context: str) -> None:
    """保序转换 Anthropic assistant 文本和函数工具调用历史。"""
    if isinstance(content, str):
        _append_assistant_message(items, [{"type": "output_text", "text": content}])
        return
    if not isinstance(content, list):
        raise ResponsesTranslationError(f"{context} 必须是字符串或内容块数组")

    pending: list[dict] = []
    for index, block in enumerate(content):
        block_context = f"{context}[{index}]"
        if not isinstance(block, dict):
            raise ResponsesTranslationError(f"{block_context} 必须是对象")
        block_type = block.get("type")
        if block_type == "text":
            text = block.get("text")
            if not isinstance(text, str):
                raise ResponsesTranslationError(f"{block_context}.text 必须是字符串")
            pending.append({"type": "output_text", "text": text})
            continue
        if block_type != "tool_use":
            raise ResponsesTranslationError(f"{block_context} 的 assistant 内容类型不受支持: {block_type}")
        _append_assistant_message(items, pending)
        pending = []
        name = block.get("name")
        if not isinstance(name, str) or not name:
            raise ResponsesTranslationError(f"{block_context}.name 必须是非空字符串")
        call_id = block.get("id") or _block_id()
        if not isinstance(call_id, str):
            raise ResponsesTranslationError(f"{block_context}.id 必须是字符串")
        input_value = block.get("input") or {}
        if not isinstance(input_value, dict):
            raise ResponsesTranslationError(f"{block_context}.input 必须是对象")
        items.append(
            {
                "type": "function_call",
                "call_id": call_id,
                "name": name,
                "arguments": json.dumps(input_value, ensure_ascii=False),
                "status": "completed",
            }
        )
    _append_assistant_message(items, pending)


def anthropic_to_responses_request(body: dict, *, store: bool = True) -> dict:
    """将 Anthropic Messages 请求转换为 OpenAI Responses 请求。"""
    model = body.get("model")
    if not isinstance(model, str) or not model:
        raise ResponsesTranslationError("model 必须是非空字符串")
    out: dict = {"model": model, "input": [], "store": bool(store)}

    instructions = _system_to_instructions(body.get("system"))
    if instructions:
        out["instructions"] = instructions

    messages = body.get("messages") or []
    if not isinstance(messages, list):
        raise ResponsesTranslationError("messages 必须是数组")
    for index, message in enumerate(messages):
        if not isinstance(message, dict):
            raise ResponsesTranslationError(f"messages[{index}] 必须是对象")
        role = message.get("role")
        content = message.get("content")
        if role == "user":
            _convert_user_message(out["input"], content, f"messages[{index}].content")
        elif role == "assistant":
            _convert_assistant_message(out["input"], content, f"messages[{index}].content")
        else:
            raise ResponsesTranslationError(f"messages[{index}].role 不受支持: {role}")

    if body.get("stop_sequences"):
        raise ResponsesTranslationError("Responses API 不支持 stop_sequences")
    if "max_tokens" in body:
        out["max_output_tokens"] = body["max_tokens"]
    for key in ("temperature", "top_p", "stream", "metadata", "parallel_tool_calls"):
        if key in body:
            out[key] = body[key]

    tools = body.get("tools")
    if tools is not None:
        if not isinstance(tools, list):
            raise ResponsesTranslationError("tools 必须是数组")
        out["tools"] = [_tool_to_responses(tool, index) for index, tool in enumerate(tools) if isinstance(tool, dict)]
        if len(out["tools"]) != len(tools):
            raise ResponsesTranslationError("tools 只能包含对象")
    if body.get("tool_choice") is not None:
        out["tool_choice"] = _tool_choice_to_responses(body["tool_choice"])

    return out


def responses_to_anthropic_response(payload: dict, model: str) -> dict:
    """将非流式 Responses API 响应转换为 Anthropic Messages 响应。"""
    if not isinstance(payload, dict):
        raise ResponsesTranslationError(
            "Responses API 返回的 JSON 不是对象", error_type="upstream_error", status_code=502
        )
    if payload.get("status") == "failed":
        error = payload.get("error") or {}
        message = error.get("message") if isinstance(error, dict) else None
        raise ResponsesTranslationError(
            message or "Responses API 请求失败", error_type="upstream_error", status_code=502
        )

    content: list[dict] = []
    for output_index, item in enumerate(payload.get("output") or []):
        if not isinstance(item, dict):
            raise ResponsesTranslationError(
                f"Responses output[{output_index}] 不是对象",
                error_type="upstream_error",
                status_code=502,
            )
        item_type = item.get("type")
        if item_type == "reasoning":
            continue
        if item_type == "message":
            for content_index, part in enumerate(item.get("content") or []):
                if not isinstance(part, dict):
                    raise ResponsesTranslationError(
                        f"Responses message content[{content_index}] 不是对象",
                        error_type="upstream_error",
                        status_code=502,
                    )
                part_type = part.get("type")
                if part_type == "output_text":
                    content.append({"type": "text", "text": part.get("text", "")})
                elif part_type == "refusal":
                    content.append({"type": "text", "text": part.get("refusal", "")})
                else:
                    raise ResponsesTranslationError(
                        f"Responses 输出内容类型无法转换: {part_type}",
                        error_type="upstream_error",
                        status_code=502,
                    )
        elif item_type == "function_call":
            try:
                arguments = json.loads(item.get("arguments") or "{}")
            except (TypeError, json.JSONDecodeError) as exc:
                raise ResponsesTranslationError(
                    "Responses 函数调用参数不是有效 JSON",
                    error_type="upstream_error",
                    status_code=502,
                ) from exc
            if not isinstance(arguments, dict):
                raise ResponsesTranslationError(
                    "Responses 函数调用参数必须是 JSON 对象",
                    error_type="upstream_error",
                    status_code=502,
                )
            content.append(
                {
                    "type": "tool_use",
                    "id": item.get("call_id") or item.get("id") or _block_id(),
                    "name": item.get("name", ""),
                    "input": arguments,
                }
            )
        else:
            raise ResponsesTranslationError(
                f"Responses 输出项类型无法转换: {item_type}",
                error_type="upstream_error",
                status_code=502,
            )

    incomplete = payload.get("incomplete_details") or {}
    stop_reason = "tool_use" if any(block.get("type") == "tool_use" for block in content) else "end_turn"
    if payload.get("status") == "incomplete" and incomplete.get("reason") in {"max_output_tokens", "max_tokens"}:
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
        "usage": {"input_tokens": usage["input_tokens"], "output_tokens": usage["output_tokens"]},
    }


def _event_index(event: dict, field: str, default: int = 0) -> int:
    """读取并校验 Responses SSE 事件中的数组索引字段。"""
    value = event.get(field, default)
    try:
        return int(value)
    except (TypeError, ValueError) as exc:
        raise ResponsesTranslationError(
            f"Responses SSE 事件 {field} 不是有效索引",
            error_type="upstream_error",
            status_code=502,
        ) from exc


def _stream_error(message: str) -> bytes:
    """构造可直接返回给 Anthropic 客户端的标准上游错误 SSE 事件。"""
    return _sse(
        "error",
        {
            "type": "error",
            "error": {"type": "upstream_error", "message": message},
        },
    )


async def responses_stream_to_anthropic_sse(
    responses_iter: AsyncIterator[bytes], model: str
) -> AsyncIterator[tuple[bytes, dict | None]]:
    """将 Responses API SSE 事件转换为连续编号的 Anthropic SSE 事件。"""
    msg_id = _new_id()
    model_name = model
    sent_message_start = False
    open_blocks: set[int] = set()
    part_blocks: dict[tuple[int, int], int] = {}
    call_blocks: dict[int, int] = {}
    tool_names: dict[int, str] = {}
    tool_ids: dict[int, str] = {}
    text_had_delta: set[tuple[int, int]] = set()
    tool_had_delta: set[int] = set()
    next_block_index = 0
    final_usage = {"input_tokens": 0, "output_tokens": 0, "cache_w": 0, "cache_r": 0}
    stop_reason = "end_turn"
    received_event = False

    def update_response(response: dict | None) -> None:
        """从 SSE 内嵌响应对象更新消息标识和模型名称。"""
        nonlocal msg_id, model_name
        if isinstance(response, dict):
            msg_id = response.get("id") or msg_id
            model_name = response.get("model") or model_name

    def ensure_message_start() -> bytes | None:
        """仅在存在可表示输出时生成一次 Anthropic message_start。"""
        nonlocal sent_message_start
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

    def allocate_part_block(output_index: int, content_index: int) -> int:
        """为每个 Responses 内容部分分配全局唯一的 Anthropic 块索引。"""
        nonlocal next_block_index
        key = (output_index, content_index)
        if key not in part_blocks:
            part_blocks[key] = next_block_index
            next_block_index += 1
        return part_blocks[key]

    def allocate_call_block(output_index: int) -> int:
        """为每个 Responses 函数调用分配全局唯一的 Anthropic 块索引。"""
        nonlocal next_block_index
        if output_index not in call_blocks:
            call_blocks[output_index] = next_block_index
            next_block_index += 1
        return call_blocks[output_index]

    async def event_iter() -> AsyncIterator[dict]:
        """从任意字节分块中恢复以空行分隔的完整 SSE JSON 事件。"""
        buffer = b""
        data_lines: list[bytes] = []

        def decode_event(lines: list[bytes]) -> dict | None:
            """解析一组 SSE data 行并跳过无效或终止标记。"""
            if not lines:
                return None
            data = b"\n".join(lines).strip()
            if data == b"[DONE]":
                return {"_done": True}
            try:
                value = json.loads(data)
            except (TypeError, json.JSONDecodeError):
                return None
            return value if isinstance(value, dict) else None

        async for chunk in responses_iter:
            buffer += chunk
            while b"\n" in buffer:
                raw_line, buffer = buffer.split(b"\n", 1)
                line = raw_line.rstrip(b"\r")
                if not line:
                    event = decode_event(data_lines)
                    data_lines = []
                    if event:
                        yield event
                        if event.get("_done"):
                            return
                    continue
                if line.startswith(b"data:"):
                    data_lines.append(line[5:].lstrip())
        if buffer:
            line = buffer.rstrip(b"\r")
            if line.startswith(b"data:"):
                data_lines.append(line[5:].lstrip())
        event = decode_event(data_lines)
        if event:
            yield event

    async for event in event_iter():
        if event.get("_done"):
            break
        received_event = True
        event_type = event.get("type")
        update_response(event.get("response"))

        if event_type in {"response.created", "response.in_progress"}:
            continue

        if event_type == "response.output_item.added":
            item = event.get("item") or {}
            if not isinstance(item, dict):
                yield _stream_error("Responses SSE output item 无效"), {"status": 502, "error": "invalid output item"}
                return
            item_type = item.get("type")
            output_index = _event_index(event, "output_index")
            if item_type == "reasoning" or item_type == "message":
                continue
            if item_type == "function_call":
                stop_reason = "tool_use"
                tool_ids[output_index] = item.get("call_id") or item.get("id") or _block_id()
                tool_names[output_index] = item.get("name", "")
                block_index = allocate_call_block(output_index)
                start = ensure_message_start()
                if start:
                    yield start, None
                if block_index not in open_blocks:
                    open_blocks.add(block_index)
                    yield _sse(
                        "content_block_start",
                        {
                            "type": "content_block_start",
                            "index": block_index,
                            "content_block": {
                                "type": "tool_use",
                                "id": tool_ids[output_index],
                                "name": tool_names[output_index],
                                "input": {},
                            },
                        },
                    ), None
                continue
            message = f"Responses 输出项类型无法转换: {item_type}"
            yield _stream_error(message), {"status": 502, "error": message}
            return

        if event_type == "response.content_part.added":
            part = event.get("part") or {}
            if not isinstance(part, dict):
                yield _stream_error("Responses SSE content part 无效"), {"status": 502, "error": "invalid content part"}
                return
            part_type = part.get("type")
            if part_type not in {"output_text", "refusal"}:
                message = f"Responses 输出内容类型无法转换: {part_type}"
                yield _stream_error(message), {"status": 502, "error": message}
                return
            output_index = _event_index(event, "output_index")
            content_index = _event_index(event, "content_index")
            block_index = allocate_part_block(output_index, content_index)
            start = ensure_message_start()
            if start:
                yield start, None
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

        if event_type in {"response.output_text.delta", "response.refusal.delta"}:
            output_index = _event_index(event, "output_index")
            content_index = _event_index(event, "content_index")
            key = (output_index, content_index)
            block_index = allocate_part_block(*key)
            start = ensure_message_start()
            if start:
                yield start, None
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
            text_had_delta.add(key)
            yield _sse(
                "content_block_delta",
                {
                    "type": "content_block_delta",
                    "index": block_index,
                    "delta": {"type": "text_delta", "text": event.get("delta", "")},
                },
            ), None
            continue

        if event_type == "response.function_call_arguments.delta":
            output_index = _event_index(event, "output_index")
            block_index = allocate_call_block(output_index)
            start = ensure_message_start()
            if start:
                yield start, None
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
                            "id": tool_ids.get(output_index) or event.get("item_id") or _block_id(),
                            "name": tool_names.get(output_index, ""),
                            "input": {},
                        },
                    },
                ), None
            tool_had_delta.add(output_index)
            yield _sse(
                "content_block_delta",
                {
                    "type": "content_block_delta",
                    "index": block_index,
                    "delta": {"type": "input_json_delta", "partial_json": event.get("delta", "")},
                },
            ), None
            continue

        if event_type in {"response.output_text.done", "response.refusal.done"}:
            output_index = _event_index(event, "output_index")
            content_index = _event_index(event, "content_index")
            key = (output_index, content_index)
            block_index = allocate_part_block(*key)
            start = ensure_message_start()
            if start:
                yield start, None
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
            if key not in text_had_delta:
                full_text = event.get("text") if event_type == "response.output_text.done" else event.get("refusal", "")
                if full_text:
                    yield _sse(
                        "content_block_delta",
                        {
                            "type": "content_block_delta",
                            "index": block_index,
                            "delta": {"type": "text_delta", "text": full_text},
                        },
                    ), None
            if block_index in open_blocks:
                open_blocks.remove(block_index)
                yield _sse("content_block_stop", {"type": "content_block_stop", "index": block_index}), None
            continue

        if event_type == "response.content_part.done":
            output_index = _event_index(event, "output_index")
            content_index = _event_index(event, "content_index")
            block_index = part_blocks.get((output_index, content_index))
            if block_index is not None and block_index in open_blocks:
                open_blocks.remove(block_index)
                yield _sse("content_block_stop", {"type": "content_block_stop", "index": block_index}), None
            continue

        if event_type == "response.function_call_arguments.done":
            output_index = _event_index(event, "output_index")
            block_index = allocate_call_block(output_index)
            start = ensure_message_start()
            if start:
                yield start, None
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
                            "id": tool_ids.get(output_index) or event.get("item_id") or _block_id(),
                            "name": tool_names.get(output_index, ""),
                            "input": {},
                        },
                    },
                ), None
            if output_index not in tool_had_delta and event.get("arguments"):
                yield _sse(
                    "content_block_delta",
                    {
                        "type": "content_block_delta",
                        "index": block_index,
                        "delta": {"type": "input_json_delta", "partial_json": event["arguments"]},
                    },
                ), None
            continue

        if event_type == "response.output_item.done":
            item = event.get("item") or {}
            if isinstance(item, dict) and item.get("type") == "function_call":
                output_index = _event_index(event, "output_index")
                block_index = allocate_call_block(output_index)
                if output_index not in tool_had_delta and item.get("arguments"):
                    yield _sse(
                        "content_block_delta",
                        {
                            "type": "content_block_delta",
                            "index": block_index,
                            "delta": {"type": "input_json_delta", "partial_json": item["arguments"]},
                        },
                    ), None
                if block_index in open_blocks:
                    open_blocks.remove(block_index)
                    yield _sse("content_block_stop", {"type": "content_block_stop", "index": block_index}), None
            continue

        if event_type in {"response.completed", "response.incomplete"}:
            response = event.get("response") or {}
            update_response(response)
            final_usage = _usage_from_response(response.get("usage") if isinstance(response, dict) else None)
            if event_type == "response.incomplete":
                reason = (response.get("incomplete_details") or {}).get("reason") if isinstance(response, dict) else None
                if reason in {"max_output_tokens", "max_tokens"}:
                    stop_reason = "max_tokens"
            continue

        if event_type in {"response.failed", "error"}:
            response = event.get("response") or {}
            error = event.get("error") or (response.get("error") if isinstance(response, dict) else {}) or {}
            message = error.get("message") if isinstance(error, dict) else None
            message = message or "Responses API 流式请求失败"
            yield _stream_error(message), {"status": 502, "error": message}
            return

    if not received_event:
        message = "Responses API 流式响应未包含事件"
        yield _stream_error(message), {"status": 502, "error": message}
        return

    start = ensure_message_start()
    if start:
        yield start, None
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
