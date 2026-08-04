import asyncio
import json
import unittest

from app.providers.openai_responses import OpenAIResponsesAdapter
from app.translation.responses import (
    ResponsesTranslationError,
    anthropic_to_responses_request,
    responses_stream_to_anthropic_sse,
    responses_to_anthropic_response,
)


def _sse_event(payload: dict) -> bytes:
    """将测试事件对象编码为标准 SSE 数据块。"""
    return f"data: {json.dumps(payload)}\n\n".encode("utf-8")


async def _collect_stream(raw: bytes, model: str = "gpt-test") -> list[tuple[bytes, dict | None]]:
    """以分片字节流执行转换器并收集全部结果。"""
    async def source():
        split_points = (17, 89, 173)
        start = 0
        for end in split_points:
            if start < len(raw):
                yield raw[start:end]
            start = end
        if start < len(raw):
            yield raw[start:]

    return [item async for item in responses_stream_to_anthropic_sse(source(), model)]


def _event_payload(chunk: bytes) -> dict:
    """提取 Anthropic SSE 数据块中的 JSON 负载。"""
    return json.loads(chunk.decode("utf-8").split("data: ", 1)[1])


class ResponsesRequestTranslationTests(unittest.TestCase):
    def test_multimodal_input_and_tool_results_preserve_order(self):
        request = {
            "model": "gpt-test",
            "system": [{"type": "text", "text": "System instruction"}],
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "Before tool"},
                        {
                            "type": "tool_result",
                            "tool_use_id": "toolu_1",
                            "content": [
                                {
                                    "type": "image",
                                    "source": {
                                        "type": "base64",
                                        "media_type": "image/png",
                                        "data": "AA==",
                                    },
                                },
                                {
                                    "type": "document",
                                    "title": "notes.txt",
                                    "source": {"type": "text", "data": "document text"},
                                },
                            ],
                        },
                        {"type": "text", "text": "After tool"},
                    ],
                }
            ],
            "tools": [{"name": "lookup", "description": "Look up a value", "input_schema": {"type": "object"}}],
            "tool_choice": {"type": "any"},
        }

        translated = anthropic_to_responses_request(request, store=False)

        self.assertEqual(translated["instructions"], "System instruction")
        self.assertFalse(translated["store"])
        self.assertEqual(translated["tool_choice"], "required")
        self.assertEqual(translated["tools"][0]["type"], "function")
        self.assertEqual([item["type"] for item in translated["input"]], ["message", "function_call_output", "message"])
        self.assertEqual(translated["input"][0]["content"], [{"type": "input_text", "text": "Before tool"}])
        tool_output = translated["input"][1]["output"]
        self.assertEqual(tool_output[0]["image_url"], "data:image/png;base64,AA==")
        self.assertEqual(tool_output[1]["type"], "input_file")
        self.assertEqual(tool_output[1]["filename"], "notes.txt")
        self.assertEqual(translated["input"][2]["content"], [{"type": "input_text", "text": "After tool"}])

    def test_document_source_variants_and_assistant_tool_history(self):
        request = {
            "model": "gpt-test",
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "document",
                            "source": {"type": "url", "url": "https://example.com/report.pdf", "media_type": "application/pdf"},
                        },
                        {
                            "type": "document",
                            "source": {
                                "type": "content",
                                "content": [{"type": "text", "text": "embedded text"}],
                            },
                        },
                    ],
                },
                {
                    "role": "assistant",
                    "content": [
                        {"type": "text", "text": "Calling tool"},
                        {"type": "tool_use", "id": "toolu_2", "name": "lookup", "input": {"query": "one"}},
                    ],
                },
            ],
            "tool_choice": {"type": "tool", "name": "lookup"},
        }

        translated = anthropic_to_responses_request(request)

        user_content = translated["input"][0]["content"]
        self.assertEqual(user_content[0]["file_url"], "https://example.com/report.pdf")
        self.assertEqual(user_content[2], {"type": "input_text", "text": "embedded text"})
        self.assertEqual(translated["input"][2]["type"], "function_call")
        self.assertEqual(translated["input"][2]["call_id"], "toolu_2")
        self.assertEqual(translated["tool_choice"], {"type": "function", "name": "lookup"})
        self.assertTrue(translated["store"])

    def test_unsupported_content_and_stop_sequences_are_rejected(self):
        with self.assertRaisesRegex(ResponsesTranslationError, "stop_sequences"):
            anthropic_to_responses_request({"model": "gpt-test", "messages": [], "stop_sequences": ["END"]})
        with self.assertRaisesRegex(ResponsesTranslationError, "assistant 内容类型"):
            anthropic_to_responses_request(
                {
                    "model": "gpt-test",
                    "messages": [{"role": "assistant", "content": [{"type": "thinking", "thinking": "hidden"}]}],
                }
            )
        with self.assertRaisesRegex(ResponsesTranslationError, "图片 source.type"):
            anthropic_to_responses_request(
                {
                    "model": "gpt-test",
                    "messages": [{"role": "user", "content": [{"type": "image", "source": {"type": "file", "file_id": "file_1"}}]}],
                }
            )

    def test_adapter_returns_anthropic_invalid_request_without_network(self):
        adapter = OpenAIResponsesAdapter({"base_url": "https://api.openai.com/v1", "api_key": "test"})

        content, content_type, usage, status = asyncio.run(
            adapter.send({"model": "gpt-test", "messages": [], "stop_sequences": ["END"]})
        )

        self.assertEqual(status, 400)
        self.assertEqual(content_type, "application/json")
        self.assertEqual(json.loads(content)["error"]["type"], "invalid_request_error")
        self.assertEqual(usage["error_type"], "invalid_request_error")


class ResponsesOutputTranslationTests(unittest.TestCase):
    def test_non_streaming_response_maps_text_refusal_tool_and_usage(self):
        payload = {
            "id": "resp_1",
            "model": "gpt-test",
            "status": "completed",
            "output": [
                {"type": "reasoning", "summary": []},
                {"type": "message", "content": [{"type": "output_text", "text": "Answer"}, {"type": "refusal", "refusal": "No"}]},
                {"type": "function_call", "call_id": "call_1", "name": "lookup", "arguments": "{\"query\":\"x\"}"},
            ],
            "usage": {"input_tokens": 12, "output_tokens": 7, "input_tokens_details": {"cached_tokens": 3}},
        }

        translated = responses_to_anthropic_response(payload, "fallback-model")

        self.assertEqual(translated["id"], "resp_1")
        self.assertEqual(translated["content"][0], {"type": "text", "text": "Answer"})
        self.assertEqual(translated["content"][1], {"type": "text", "text": "No"})
        self.assertEqual(translated["content"][2]["input"], {"query": "x"})
        self.assertEqual(translated["stop_reason"], "tool_use")
        self.assertEqual(translated["usage"], {"input_tokens": 12, "output_tokens": 7})

    def test_non_streaming_unsupported_output_is_an_upstream_error(self):
        with self.assertRaisesRegex(ResponsesTranslationError, "无法转换") as raised:
            responses_to_anthropic_response(
                {"status": "completed", "output": [{"type": "image_generation_call"}]}, "gpt-test"
            )
        self.assertEqual(raised.exception.error_type, "upstream_error")
        self.assertEqual(raised.exception.status_code, 502)


class ResponsesStreamingTranslationTests(unittest.IsolatedAsyncioTestCase):
    async def test_streaming_text_and_function_calls_have_unique_block_indexes(self):
        events = b"".join(
            [
                _sse_event({"type": "response.created", "response": {"id": "resp_2", "model": "gpt-test"}}),
                _sse_event({"type": "response.output_text.delta", "output_index": 0, "content_index": 0, "delta": "Hello"}),
                _sse_event({"type": "response.output_text.done", "output_index": 0, "content_index": 0, "text": "Hello"}),
                _sse_event({"type": "response.output_item.added", "output_index": 1, "item": {"type": "function_call", "call_id": "call_2", "name": "lookup"}}),
                _sse_event({"type": "response.function_call_arguments.delta", "output_index": 1, "delta": "{\"q\":\"x\""}),
                _sse_event({"type": "response.function_call_arguments.done", "output_index": 1, "arguments": "{\"q\":\"x\"}"}),
                _sse_event({"type": "response.output_item.done", "output_index": 1, "item": {"type": "function_call", "arguments": "{\"q\":\"x\"}"}}),
                _sse_event({"type": "response.completed", "response": {"usage": {"input_tokens": 4, "output_tokens": 2}}}),
            ]
        )

        output = await _collect_stream(events)
        payloads = [_event_payload(chunk) for chunk, _ in output]
        starts = [payload for payload in payloads if payload["type"] == "content_block_start"]
        deltas = [payload for payload in payloads if payload["type"] == "content_block_delta"]

        self.assertEqual([payload["index"] for payload in starts], [0, 1])
        self.assertEqual(deltas[0]["delta"]["text"], "Hello")
        self.assertEqual(deltas[1]["delta"]["partial_json"], "{\"q\":\"x\"")
        self.assertEqual(payloads[-2]["delta"]["stop_reason"], "tool_use")
        self.assertEqual(output[-1][1], {"input_tokens": 4, "output_tokens": 2, "cache_w": 0, "cache_r": 0})

    async def test_streaming_incomplete_and_error_events_are_reported(self):
        incomplete = b"".join(
            [
                _sse_event({"type": "response.output_text.done", "output_index": 0, "content_index": 0, "text": "partial"}),
                _sse_event({"type": "response.incomplete", "response": {"incomplete_details": {"reason": "max_output_tokens"}, "usage": {"input_tokens": 2, "output_tokens": 1}}}),
            ]
        )
        incomplete_output = await _collect_stream(incomplete)
        incomplete_payloads = [_event_payload(chunk) for chunk, _ in incomplete_output]
        self.assertEqual(incomplete_payloads[-2]["delta"]["stop_reason"], "max_tokens")

        failed = await _collect_stream(_sse_event({"type": "error", "error": {"message": "upstream failed"}}))
        self.assertEqual(_event_payload(failed[0][0])["error"]["message"], "upstream failed")
        self.assertEqual(failed[0][1]["status"], 502)


if __name__ == "__main__":
    unittest.main()
