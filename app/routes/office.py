"""Local Office integration management and add-in bootstrap endpoints."""

import hmac
import ipaddress
from functools import lru_cache

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

from .. import db
from ..auth import verify_auth
from ..office_integration import OfficeIntegration, OfficeIntegrationError


router = APIRouter()

PIVOT_ORIGIN = "https://pivot.claude.ai"

_BOOTSTRAP_CACHE_HEADERS = {
    "Cache-Control": "no-store, max-age=0",
    "Pragma": "no-cache",
    "Vary": "Origin",
}

_CONFLICT_ERROR_CODES = frozenset(
    {
        "developer_override_conflict",
        "invalid_bootstrap_secret",
        "invalid_gateway_url",
        "manifest_template_invalid",
        "manifest_template_missing",
        "office_not_found",
        "unsupported_platform",
    }
)

_LOCAL_ACCESS_DETAIL = {
    "code": "local_access_required",
    "message": "Office integration changes require a loopback connection.",
}
_GATEWAY_TOKEN_DETAIL = {
    "code": "gateway_token_missing",
    "message": "Configure a gateway token before setting up Office integration.",
}
_INVALID_ORIGIN_DETAIL = {
    "code": "invalid_origin",
    "message": "Bootstrap requests must originate from https://pivot.claude.ai.",
}
_INVALID_BOOTSTRAP_SECRET_DETAIL = {
    "code": "invalid_bootstrap_secret",
    "message": "The bootstrap secret is invalid.",
}
_UNEXPECTED_ERROR_DETAIL = {
    "code": "office_integration_failed",
    "message": "The Office integration operation failed.",
}


@lru_cache(maxsize=1)
def get_office_integration() -> OfficeIntegration:
    return OfficeIntegration()


def _is_local_request(request: Request) -> bool:
    if request.client is None:
        return False
    try:
        return ipaddress.ip_address(request.client.host).is_loopback
    except ValueError:
        return False


def _raise_office_error(error: Exception, headers=None) -> None:
    if isinstance(error, OfficeIntegrationError):
        status_code = 409 if error.code in _CONFLICT_ERROR_CODES else 500
        detail = {"code": error.code, "message": error.message}
    else:
        status_code = 500
        detail = dict(_UNEXPECTED_ERROR_DETAIL)
    raise HTTPException(
        status_code=status_code,
        detail=detail,
        headers=headers,
    ) from error


@router.get("/admin/office/status")
def office_status(request: Request):
    verify_auth(request)
    try:
        status = dict(get_office_integration().status())
    except Exception as error:
        _raise_office_error(error)
    status["local_access"] = _is_local_request(request)
    status["gateway_ready"] = db.has_gateway_token()
    return status


@router.post("/admin/office/setup")
def setup_office(request: Request):
    verify_auth(request)
    if not _is_local_request(request):
        raise HTTPException(status_code=409, detail=dict(_LOCAL_ACCESS_DETAIL))
    if not db.has_gateway_token():
        raise HTTPException(status_code=409, detail=dict(_GATEWAY_TOKEN_DETAIL))

    try:
        secret = db.get_or_create_office_bootstrap_secret()
        return get_office_integration().setup(secret)
    except Exception as error:
        _raise_office_error(error)


@router.delete("/admin/office/setup")
def remove_office(request: Request):
    verify_auth(request)
    if not _is_local_request(request):
        raise HTTPException(status_code=409, detail=dict(_LOCAL_ACCESS_DETAIL))

    try:
        return get_office_integration().remove()
    except Exception as error:
        _raise_office_error(error)


@router.get("/office/bootstrap/{secret}")
def office_bootstrap(secret: str, request: Request):
    if request.headers.get("Origin") != PIVOT_ORIGIN:
        raise HTTPException(
            status_code=403,
            detail=dict(_INVALID_ORIGIN_DETAIL),
            headers=_BOOTSTRAP_CACHE_HEADERS,
        )

    stored_secret = db.get_setting(db.SETTING_OFFICE_BOOTSTRAP_SECRET)
    if not stored_secret or not hmac.compare_digest(secret, stored_secret):
        raise HTTPException(
            status_code=404,
            detail=dict(_INVALID_BOOTSTRAP_SECRET_DETAIL),
            headers=_BOOTSTRAP_CACHE_HEADERS,
        )

    gateway_token = db.get_gateway_token()
    if not gateway_token:
        raise HTTPException(
            status_code=503,
            detail=dict(_GATEWAY_TOKEN_DETAIL),
            headers=_BOOTSTRAP_CACHE_HEADERS,
        )

    try:
        gateway_url = get_office_integration().gateway_url
    except Exception as error:
        _raise_office_error(error, headers=_BOOTSTRAP_CACHE_HEADERS)

    return JSONResponse(
        {
            "gateway_url": gateway_url,
            "gateway_token": gateway_token,
            "gateway_api_format": "anthropic",
            "auto_connect": "1",
        },
        headers=_BOOTSTRAP_CACHE_HEADERS,
    )
