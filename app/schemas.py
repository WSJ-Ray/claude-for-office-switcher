from typing import Optional
from pydantic import BaseModel, Field, field_validator

from .providers import is_supported_provider_format, supported_provider_formats


class ProviderFormatModel(BaseModel):
    """Validate provider formats against the runtime adapter registry."""

    @field_validator("format", check_fields=False)
    @classmethod
    def validate_format(cls, value: str | None) -> str | None:
        """校验提供商格式是否已在运行时适配器注册表中注册。"""
        if value is None:
            return value
        if not is_supported_provider_format(value):
            supported = ", ".join(supported_provider_formats())
            raise ValueError(
                f"Unsupported provider format: {value}. Supported: {supported}"
            )
        return value


class ProviderIn(ProviderFormatModel):
    name: str
    format: str
    base_url: str
    api_key: str
    enabled: bool = True
    is_default: bool = False
    extra_config: dict = Field(default_factory=dict)


class ProviderUpdate(ProviderFormatModel):
    name: Optional[str] = None
    format: Optional[str] = None
    base_url: Optional[str] = None
    api_key: Optional[str] = None
    enabled: Optional[bool] = None
    is_default: Optional[bool] = None
    extra_config: Optional[dict] = None


class ProviderOut(BaseModel):
    id: int
    name: str
    format: str
    base_url: str
    api_key: str
    enabled: bool
    is_default: bool
    extra_config: dict
    created_at: str


class MappingReorderIn(BaseModel):
    client_model: str
    mapping_ids: list[int]


class MappingIn(BaseModel):
    provider_id: int
    client_model: str
    upstream_model: str
    enabled: bool = True
    priority: Optional[int] = None


class MappingUpdate(BaseModel):
    provider_id: Optional[int] = None
    client_model: Optional[str] = None
    upstream_model: Optional[str] = None
    enabled: Optional[bool] = None
    priority: Optional[int] = None


class MappingOut(BaseModel):
    id: int
    provider_id: int
    client_model: str
    upstream_model: str
    enabled: bool
    provider_name: str
    provider_format: str


class PreviewModelsIn(ProviderFormatModel):
    provider_id: Optional[int] = None
    format: str
    base_url: str
    api_key: str
    extra_config: dict = Field(default_factory=dict)
    timeout: int = 30
