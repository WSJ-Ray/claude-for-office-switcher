"""向 Claude Office 插件暴露的 Anthropic 格式 /v1/* 路由。

始终使用 Anthropic Messages API 通信。模型路由通过 model_mappings 解析；
未映射的模型回退到默认提供商。一个 client_model 可能映射到多个启用的提供商，
按 priority 排序；上游失败时网关自动故障转移到下一个候选。
"""
import copy
import json
import time
from datetime import datetime
from typing import AsyncIterator

from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import Response, StreamingResponse

from .. import db
from ..auth import verify_auth
from ..providers import get_adapter, is_supported_provider_format

router = APIRouter()


def _log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def _resolve_candidates(client_model: str) -> list[tuple[dict, str]]:
    """返回 (provider, upstream_model) 候选队列，按 priority 升序排列。

    无映射时回退到默认提供商，模型名透传。
    """
    cands: list[tuple[dict, str]] = []
    for m in db.find_mappings_by_client_model(client_model):
        p = db.get_provider(m["provider_id"])
        if p and p["enabled"] and is_supported_provider_format(p["format"]):
            cands.append((p, m["upstream_model"]))
    if not cands:
        p = db.get_default_provider()
        if p and p["enabled"] and is_supported_provider_format(p["format"]):
            cands.append((p, client_model))
    return cands


@router.get("/v1/models")
async def list_models(request: Request):
    verify_auth(request)
    mappings = db.list_mappings()
    # 去重：同一个 client_model 只展示一次
    seen: set[str] = set()
    data = []
    for m in mappings:
        if not m["enabled"] or not m.get("provider_enabled", True) or not is_supported_provider_format(m["provider_format"]) or m["client_model"] in seen:
            continue
        seen.add(m["client_model"])
        data.append(
            {
                "id": m["client_model"],
                "type": "model",
                "display_name": f"{m['provider_name']} · {m['upstream_model']}",
                "created_at": "",
            }
        )
    return {
        "data": data,
        "has_more": False,
        "first_id": data[0]["id"] if data else None,
        "last_id": data[-1]["id"] if data else None,
    }


@router.post("/v1/messages")
async def proxy_messages(request: Request):
    verify_auth(request)
    raw = await request.body()
    try:
        body = json.loads(raw)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")

    client_model = body.get("model", "")
    stream = bool(body.get("stream", False))
    cands = _resolve_candidates(client_model)
    if not cands:
        raise HTTPException(status_code=503, detail="No enabled provider configured")

    cand_desc = ", ".join(f'{p["name"]}/{u}' for p, u in cands)
    _log(
        f"[REQ] model={client_model} stream={stream} len={len(raw)} "
        f"candidates={len(cands)} ({cand_desc})"
    )
    t0 = time.time()

    if not stream:
        return await _proxy_nonstream(body, client_model, cands, t0)
    return _proxy_stream(body, client_model, cands, t0)


def _inject_system_cache(body: dict, provider_format: str, provider_extra: dict) -> dict:
    """对支持 Anthropic 缓存的提供商，在 system prompt 中注入 cache_control 标记。

    返回新的 body 副本，避免修改原始请求体导致故障转移时累积标记。
    """
    if not provider_extra.get("enable_prompt_caching"):
        return body
    if provider_format not in ("anthropic", "url_adaptive"):
        return body
    mutated = copy.deepcopy(body)
    system = mutated.get("system")
    if system:
        if isinstance(system, str):
            mutated["system"] = [{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}]
        elif isinstance(system, list):
            for block in mutated["system"]:
                if isinstance(block, dict) and block.get("type") == "text":
                    block["cache_control"] = {"type": "ephemeral"}
    return mutated


async def _proxy_nonstream(body, client_model, cands, t0):
    last_status = 502
    last_err = "all candidates failed"
    last_provider = cands[-1][0]
    last_upstream = cands[-1][1]
    for idx, (provider, upstream_model) in enumerate(cands):
        candidate_body = copy.deepcopy(body)
        candidate_body["model"] = upstream_model
        candidate_body = _inject_system_cache(
            candidate_body,
            provider["format"],
            provider.get("extra_config", {}),
        )
        adapter = get_adapter(provider)
        is_last = idx == len(cands) - 1
        try:
            content, ct, usage, status = await adapter.send(candidate_body)
        except Exception as e:
            _log(f"[FAIL] {provider['name']}/{upstream_model} 异常: {e}")
            last_err = str(e)[:200]
            last_status = 502
            last_provider, last_upstream = provider, upstream_model
            continue
        if status >= 400:
            _log(f"[FAIL] {provider['name']}/{upstream_model} HTTP {status}")
            last_status = status
            last_err = (usage.get("error") if isinstance(usage, dict) else "") or f"HTTP {status}"
            last_provider, last_upstream = provider, upstream_model
            continue
        # 成功：返回响应
        db.insert_log(
            {
                "provider_id": provider["id"], "provider_name": provider["name"],
                "client_model": client_model, "upstream_model": upstream_model,
                "stream": False, "status": status,
                "duration_ms": int((time.time() - t0) * 1000),
                "input_tokens": usage.get("input_tokens", 0),
                "output_tokens": usage.get("output_tokens", 0),
                "cache_w": usage.get("cache_w", 0), "cache_r": usage.get("cache_r", 0),
            }
        )
        _log(
            f"[OK] {provider['name']}/{upstream_model} {time.time() - t0:.2f}s "
            f"in={usage.get('input_tokens', 0)} out={usage.get('output_tokens', 0)}"
        )
        return Response(content=content, status_code=status, media_type=ct)

    # 全部候选均失败
    db.insert_log(
        {
            "provider_id": last_provider["id"], "provider_name": last_provider["name"],
            "client_model": client_model, "upstream_model": last_upstream,
            "stream": False, "status": last_status,
            "duration_ms": int((time.time() - t0) * 1000),
            "error": last_err[:200],
        }
    )
    return Response(
        content=json.dumps({"type": "error", "error": {"type": "upstream_error", "message": last_err}}).encode("utf-8"),
        status_code=last_status,
        media_type="application/json",
    )


def _proxy_stream(body, client_model, cands, t0):
    async def event_stream() -> AsyncIterator[bytes]:
        ttft_ms = 0
        first = True
        chosen_usage = {"input_tokens": 0, "output_tokens": 0, "cache_w": 0, "cache_r": 0}
        chosen_provider = None
        chosen_upstream = None
        final_status = 200
        final_error = None

        for idx, (provider, upstream_model) in enumerate(cands):
            candidate_body = copy.deepcopy(body)
            candidate_body["model"] = upstream_model
            candidate_body = _inject_system_cache(
                candidate_body,
                provider["format"],
                provider.get("extra_config", {}),
            )
            adapter = get_adapter(provider)
            is_last = idx == len(cands) - 1
            gen = adapter.stream(candidate_body)
            committed = False
            try:
                async for chunk, meta in gen:
                    if not committed:
                        # 首个事件若为上游错误，且非最后候选 → 故障转移
                        if meta and meta.get("status") and meta["status"] >= 400:
                            final_status = meta["status"]
                            final_error = (meta.get("error") or "")[:200]
                            _log(f"[FAIL] stream {provider['name']}/{upstream_model} HTTP {final_status} {final_error}")
                            if is_last and chunk:
                                yield chunk
                            break
                        committed = True
                        chosen_provider = provider
                        chosen_upstream = upstream_model
                    # 已提交：正常转发
                    if first and chunk:
                        ttft_ms = int((time.time() - t0) * 1000)
                        first = False
                    if meta and meta.get("_eof"):
                        chosen_usage = {
                            k: meta[k] for k in ("input_tokens", "output_tokens", "cache_w", "cache_r") if k in meta
                        }
                        if not ttft_ms and meta.get("ttft_ms"):
                            ttft_ms = int(meta["ttft_ms"])
                    if chunk:
                        yield chunk
                else:
                    # 生成器正常耗尽（未因错误中断）
                    pass
                if committed:
                    break  # 成功完成，退出候选循环
            finally:
                await gen.aclose()

        # 写日志
        log_provider = chosen_provider or cands[-1][0]
        log_upstream = chosen_upstream or cands[-1][1]
        status = 200 if chosen_provider else (final_status or 502)
        db.insert_log(
            {
                "provider_id": log_provider["id"], "provider_name": log_provider["name"],
                "client_model": client_model, "upstream_model": log_upstream,
                "stream": True, "status": status,
                "duration_ms": int((time.time() - t0) * 1000), "ttft_ms": ttft_ms,
                "input_tokens": chosen_usage.get("input_tokens", 0),
                "output_tokens": chosen_usage.get("output_tokens", 0),
                "cache_w": chosen_usage.get("cache_w", 0),
                "cache_r": chosen_usage.get("cache_r", 0),
                "error": None if chosen_provider else final_error,
            }
        )
        _log(
            f"[{'OK' if chosen_provider else 'FAIL'}] stream "
            f"{log_provider['name']}/{log_upstream} ttft={ttft_ms}ms "
            f"total={(time.time() - t0) * 1000:.0f}ms"
        )

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )
