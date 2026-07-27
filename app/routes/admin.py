"""管理后台 API：提供商管理、模型映射、统计数据、请求日志、模型预览、系统设置。"""
import time
from typing import AsyncIterator

import httpx
from fastapi import APIRouter, Request, HTTPException
from pydantic import BaseModel

from .. import db
from ..auth import verify_auth
from ..cache import model_cache
from ..schemas import (
    ProviderIn,
    ProviderUpdate,
    MappingIn,
    MappingUpdate,
    PreviewModelsIn,
    MappingReorderIn,
)
from ..providers import REGISTRY, list_provider_capabilities

router = APIRouter(prefix="/admin")


class SettingsIn(BaseModel):
    gateway_token: str = ""


def _mask_key(p: dict) -> dict:
    """返回列表时掩码处理 api_key，仅显示前后各 4 位。"""
    out = dict(p)
    k = out.get("api_key") or ""
    if len(k) > 8:
        out["api_key"] = k[:4] + "*" * (len(k) - 8) + k[-4:]
    elif k:
        out["api_key"] = "*" * len(k)
    return out


def _is_masked_key(value: str | None) -> bool:
    """判断 API Key 是否为管理端返回的掩码值。"""
    return bool(value) and "*" in value


def _is_placeholder_key(value: str | None) -> bool:
    """判断 API Key 是否为空或掩码占位值。"""
    return value == "" or _is_masked_key(value)


def _model_ids(models: list[dict]) -> list[str]:
    """从模型对象列表中提取非空模型 ID。"""
    return [m["id"] for m in models if m.get("id")]

def _discovery_metadata() -> dict:
    """返回模型发现操作的能力边界说明。"""
    return {
        "operation": "model_discovery",
        "end_to_end": False,
        "verifies": ["upstream model-list access", "authentication for that endpoint"],
        "does_not_verify": ["model mappings", "message translation", "streaming response"],
    }


@router.get("/provider-capabilities")
async def provider_capabilities(request: Request):
    """返回运行时当前注册的提供商格式和能力。"""
    verify_auth(request)
    return {"data": list_provider_capabilities()}


@router.get("/auth-check")
async def auth_check(request: Request):
    """验证已保存的网关令牌且不修改服务状态。"""
    verify_auth(request)
    return {"ok": True}


@router.get("/providers")
async def list_providers(request: Request):
    """返回 API Key 已掩码的提供商列表。"""
    verify_auth(request)
    return {"data": [_mask_key(p) for p in db.list_providers()]}


@router.post("/providers")
async def create_provider(payload: ProviderIn, request: Request):
    """创建提供商，并在需要时设为唯一默认项。"""
    verify_auth(request)
    data = payload.model_dump()
    if data.get("is_default"):
        # 确保默认提供商唯一性（由更新流程中的 set_default 保证）
        pass
    pid = db.create_provider(data)
    if data.get("is_default"):
        db.set_default_provider(pid)
    return {"id": pid}


@router.put("/providers/{pid}")
async def update_provider(pid: int, payload: ProviderUpdate, request: Request):
    """局部更新提供商并使其模型缓存失效。"""
    verify_auth(request)
    data = {k: v for k, v in payload.model_dump().items() if v is not None}
    if not db.get_provider(pid):
        raise HTTPException(404, "Provider not found")
    if _is_placeholder_key(data.get("api_key")):
        data.pop("api_key", None)
    db.update_provider(pid, data)
    model_cache.invalidate(pid)
    if data.get("is_default"):
        db.set_default_provider(pid)
    return {"ok": True}


@router.delete("/providers/{pid}")
async def delete_provider(pid: int, request: Request):
    """删除提供商并清理对应模型缓存。"""
    verify_auth(request)
    db.delete_provider(pid)
    model_cache.invalidate(pid)
    return {"ok": True}


@router.post("/providers/{pid}/test")
async def test_provider(pid: int, request: Request):
    """测试连通性：调用提供商的 list_models 端点验证连接。"""
    verify_auth(request)
    p = db.get_provider(pid)
    if not p:
        raise HTTPException(404, "Provider not found")

    cached = model_cache.get(pid)
    if cached:
        return {
            "ok": True,
            "models": len(cached),
            "latency_ms": 0,
            "cached": True,
            "metadata": _discovery_metadata(),
        }

    from ..providers import get_adapter
    t0 = time.time()
    try:
        adapter = get_adapter(p)
        models = await adapter.list_models()
        result = _model_ids(models)
        if not result:
            raise RuntimeError("未获取到模型列表")
        model_cache.set(pid, result)
        return {
            "ok": True,
            "models": len(result),
            "latency_ms": int((time.time() - t0) * 1000),
            "cached": False,
            "metadata": _discovery_metadata(),
        }
    except Exception as e:
        raise HTTPException(502, f"Test failed: {e}")


@router.get("/providers/{pid}/models")
async def provider_models(pid: int, request: Request):
    """拉取该提供商的上游模型 ID 列表，供模型映射页面快速选用。"""
    verify_auth(request)
    p = db.get_provider(pid)
    if not p:
        raise HTTPException(404, "Provider not found")

    cached = model_cache.get(pid)
    if cached:
        return {"ok": True, "models": cached, "cached": True}

    from ..providers import get_adapter
    try:
        adapter = get_adapter(p)
        models = await adapter.list_models()
        result = _model_ids(models)
        if not result:
            return {"ok": False, "error": "未获取到模型列表", "models": []}
        model_cache.set(pid, result)
        return {"ok": True, "models": result, "cached": False}
    except Exception as e:
        return {"ok": False, "error": str(e)[:200], "models": []}


@router.post("/providers/preview-models")
async def preview_models(payload: PreviewModelsIn, request: Request):
    """使用草稿状态的提供商配置（尚未保存）解析上游模型列表。"""
    verify_auth(request)
    fmt = payload.format
    if fmt not in REGISTRY:
        raise HTTPException(400, f"Unsupported format: {fmt}")

    api_key = payload.api_key
    if _is_placeholder_key(api_key) and payload.provider_id:
        saved = db.get_provider(payload.provider_id)
        if saved:
            api_key = saved["api_key"]

    cache_key = f"{fmt}|{payload.base_url}|{api_key}"
    cached = model_cache.get_preview(cache_key)
    if cached:
        return {"ok": True, "models": cached, "latency_ms": 0, "cached": True}

    from ..providers import get_adapter
    cfg = {
        "id": 0,
        "name": "preview",
        "format": fmt,
        "base_url": payload.base_url,
        "api_key": api_key,
        "enabled": True,
        "is_default": False,
        "extra_config": payload.extra_config,
        "created_at": "",
    }
    t0 = time.time()
    try:
        adapter = get_adapter(cfg)
        models = await adapter.list_models()
        result = _model_ids(models)
        if not result:
            return {"ok": False, "error": "未获取到模型列表", "models": []}
        model_cache.set_preview(cache_key, result)
        return {
            "ok": True,
            "models": result,
            "latency_ms": int((time.time() - t0) * 1000),
            "cached": False,
        }
    except Exception as e:
        return {"ok": False, "error": str(e)[:200]}


@router.get("/routes/preflight")
async def route_preflight(client_model: str, request: Request):
    """在不调用上游的情况下解释客户端模型的实际路由决策。"""
    verify_auth(request)
    normalized_model = (client_model or "").strip()
    if not normalized_model:
        raise HTTPException(400, "client_model is required")

    mappings = db.list_mapping_candidates(normalized_model)
    candidates = []
    exclusions = []
    for mapping in mappings:
        item = {
            "mapping_id": mapping["id"],
            "provider_id": mapping["provider_id"],
            "provider_name": mapping["provider_name"],
            "provider_format": mapping["provider_format"],
            "upstream_model": mapping["upstream_model"],
            "priority": mapping["priority"],
            "mapping_enabled": mapping["enabled"],
            "provider_enabled": mapping["provider_enabled"],
            "provider_format_supported": mapping["provider_format_supported"],
            "is_default_provider": mapping["provider_is_default"],
            "source": "mapping",
        }
        if mapping["routable"]:
            candidates.append(item)
        else:
            item["reason"] = mapping["exclusion_reason"]
            exclusions.append(item)

    default_route = None
    if not candidates:
        default_provider = db.get_default_provider()
        if default_provider:
            default_route = {
                "provider_id": default_provider["id"],
                "provider_name": default_provider["name"],
                "provider_format": default_provider["format"],
                "upstream_model": normalized_model,
                "source": "default",
                "is_default_provider": True,
            }
            candidates.append(default_route)

    return {
        "client_model": normalized_model,
        "candidates": candidates,
        "exclusions": exclusions,
        "used_default": default_route is not None,
        "default_route": default_route,
        "routable": bool(candidates),
        "reason": None if candidates else "no_enabled_mapping_or_default_provider",
    }


@router.get("/mappings")
async def list_mappings(request: Request):
    """返回全部模型映射及其当前可路由状态。"""
    verify_auth(request)
    return {"data": db.list_mappings()}


@router.post("/mappings")
async def create_mapping(payload: MappingIn, request: Request):
    """校验客户端模型名称并创建模型映射。"""
    verify_auth(request)
    cm = (payload.client_model or "").lower()
    if not any(t in cm for t in ("sonnet", "opus", "haiku")):
        raise HTTPException(400, "client_model 须包含 sonnet / opus / haiku 之一")
    mid = db.create_mapping(payload.model_dump())
    return {"id": mid}


@router.put("/mappings/reorder")
async def reorder_mappings(payload: MappingReorderIn, request: Request):
    """以原子方式设置一个客户端模型的完整优先级顺序。"""
    verify_auth(request)
    try:
        mappings = db.reorder_mappings(payload.client_model, payload.mapping_ids)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    return {"ok": True, "data": mappings}


@router.put("/mappings/{mid}")
async def update_mapping(mid: int, payload: MappingUpdate, request: Request):
    """校验并局部更新指定模型映射。"""
    verify_auth(request)
    data = {k: v for k, v in payload.model_dump().items() if v is not None}
    if "client_model" in data:
        cm = data["client_model"].lower()
        if not any(t in cm for t in ("sonnet", "opus", "haiku")):
            raise HTTPException(400, "client_model 须包含 sonnet / opus / haiku 之一")
    db.update_mapping(mid, data)
    return {"ok": True}


@router.delete("/mappings/{mid}")
async def delete_mapping(mid: int, request: Request):
    """删除指定模型映射。"""
    verify_auth(request)
    db.delete_mapping(mid)
    return {"ok": True}


@router.get("/stats")
async def stats(request: Request, range: str = "24h"):
    """返回汇总、趋势和提供商维度的仪表盘统计。"""
    verify_auth(request)
    if range not in {"24h", "7d", "30d"}:
        raise HTTPException(422, "range must be one of: 24h, 7d, 30d")
    return {
        "summary": db.stats_summary(),
        "providers": [
            {"id": p["id"], "name": p["name"], "format": p["format"], "enabled": p["enabled"]}
            for p in db.list_providers()
        ],
        "mappings_count": len(db.list_mappings()),
        "range": range,
        "trend": db.stats_trend(range),
        "by_provider": db.stats_by_provider(),
        "recent": db.list_logs(limit=8, offset=0),
    }


@router.get("/logs")
async def logs(request: Request, limit: int = 100, offset: int = 0):
    """分页返回请求日志。"""
    verify_auth(request)
    return {"data": db.list_logs(limit=min(limit, 500), offset=max(offset, 0))}


@router.get("/setup-status")
async def setup_status(request: Request):
    """返回网关令牌是否已配置，供前端判断首次引导流程。"""
    return {"configured": db.has_gateway_token()}


def _mask_setting(value: str) -> str:
    """掩码处理敏感设置值，仅显示前后各 4 位。"""
    if len(value) > 8:
        return value[:4] + "*" * (len(value) - 8) + value[-4:]
    return "*" * len(value) if value else ""


@router.get("/settings")
async def get_settings(request: Request):
    """读取系统设置（敏感字段掩码后返回）。"""
    if db.has_gateway_token():
        verify_auth(request)
    all_settings = db.get_all_settings()
    return {
        "gateway_token": _mask_setting(all_settings.get(db.SETTING_GATEWAY_TOKEN, "")),
        "has_token": bool(all_settings.get(db.SETTING_GATEWAY_TOKEN, "")),
    }


@router.put("/settings")
async def update_settings(payload: SettingsIn, request: Request):
    """更新系统设置。如果已有令牌，需要验证 auth；否则开放（首次设置阶段）。"""
    if db.has_gateway_token():
        verify_auth(request)
    if payload.gateway_token:
        db.set_setting(db.SETTING_GATEWAY_TOKEN, payload.gateway_token)
    return {"ok": True}
