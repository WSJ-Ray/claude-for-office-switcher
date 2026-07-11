"""Provider adapter registry."""
from .base import BaseProvider
from .anthropic import AnthropicAdapter
from .openai_chat import OpenAIChatAdapter
from .openai_responses import OpenAIResponsesAdapter
from .url_adaptive import URLAdaptiveAdapter

REGISTRY: dict[str, type[BaseProvider]] = {
    "anthropic": AnthropicAdapter,
    "openai_chat": OpenAIChatAdapter,
    "openai_responses": OpenAIResponsesAdapter,
    "url_adaptive": URLAdaptiveAdapter,
}


# Provider format metadata lives beside the adapter registry so the UI does not
# need to keep a separate, stale list of formats.
_CAPABILITY_METADATA: dict[str, dict] = {
    "anthropic": {
        "label": "Anthropic Messages",
        "description": "Anthropic Messages API compatible endpoint.",
        "base_url_placeholder": "https://api.anthropic.com",
        "base_url_hint": "Use the API origin; /v1/messages is appended automatically.",
        "supports": {
            "model_discovery": True,
            "streaming": True,
            "tool_calls": True,
            "prompt_caching": True,
        },
        "extra_config_fields": [
            {
                "key": "enable_prompt_caching",
                "label": "Enable prompt caching",
                "type": "boolean",
                "default": False,
            },
            {
                "key": "user_agent",
                "label": "Custom User-Agent",
                "type": "string",
            },
        ],
    },
    "openai_chat": {
        "label": "OpenAI Chat Completions",
        "description": "OpenAI-compatible Chat Completions endpoint translated to Anthropic Messages.",
        "base_url_placeholder": "https://api.openai.com/v1",
        "base_url_hint": "Use the API base ending in /v1; /chat/completions is appended automatically.",
        "supports": {
            "model_discovery": True,
            "streaming": True,
            "tool_calls": True,
            "prompt_caching": False,
        },
        "extra_config_fields": [
            {
                "key": "organization",
                "label": "OpenAI organization",
                "type": "string",
            },
            {
                "key": "project",
                "label": "OpenAI project",
                "type": "string",
            },
            {
                "key": "user_agent",
                "label": "Custom User-Agent",
                "type": "string",
            },
        ],
    },
    "openai_responses": {
        "label": "OpenAI Responses",
        "description": "OpenAI-compatible Responses endpoint translated to Anthropic Messages.",
        "base_url_placeholder": "https://api.openai.com/v1",
        "base_url_hint": "An API origin or /v1 base is accepted; /responses is resolved automatically.",
        "supports": {
            "model_discovery": True,
            "streaming": True,
            "tool_calls": True,
            "prompt_caching": False,
        },
        "extra_config_fields": [
            {
                "key": "organization",
                "label": "OpenAI organization",
                "type": "string",
            },
            {
                "key": "project",
                "label": "OpenAI project",
                "type": "string",
            },
            {
                "key": "user_agent",
                "label": "Custom User-Agent",
                "type": "string",
            },
        ],
    },
    "url_adaptive": {
        "label": "Anthropic Messages (adaptive URL)",
        "description": "Anthropic-compatible endpoint that accepts common API base URL variants.",
        "base_url_placeholder": "https://gateway.example.com/v1/anthropic",
        "base_url_hint": "Accepts an origin, /v1, /anthropic, or /v1/anthropic base URL.",
        "supports": {
            "model_discovery": True,
            "streaming": True,
            "tool_calls": True,
            "prompt_caching": True,
        },
        "extra_config_fields": [
            {
                "key": "enable_prompt_caching",
                "label": "Enable prompt caching",
                "type": "boolean",
                "default": False,
            },
            {
                "key": "user_agent",
                "label": "Custom User-Agent",
                "type": "string",
            },
        ],
    },
}


def supported_provider_formats() -> tuple[str, ...]:
    """Return formats that can actually be instantiated at runtime."""
    return tuple(REGISTRY)


def is_supported_provider_format(fmt: str) -> bool:
    return fmt in REGISTRY


def list_provider_capabilities() -> list[dict]:
    """Return UI-safe metadata for every registered provider format.

    Iterating over ``REGISTRY`` makes registration the single source of truth:
    future adapters appear in this catalog automatically, even before custom
    presentation metadata is added for them.
    """
    capabilities: list[dict] = []
    for fmt in supported_provider_formats():
        metadata = _CAPABILITY_METADATA.get(fmt, {})
        capabilities.append(
            {
                "format": fmt,
                "label": metadata.get("label", fmt.replace("_", " ").title()),
                "description": metadata.get("description", "Registered provider adapter."),
                "base_url_placeholder": metadata.get("base_url_placeholder", "https://api.example.com"),
                "base_url_hint": metadata.get("base_url_hint", ""),
                "supports": metadata.get("supports", {}),
                "extra_config_fields": metadata.get("extra_config_fields", []),
            }
        )
    return capabilities


def get_adapter(provider: dict) -> BaseProvider:
    fmt = provider["format"]
    cls = REGISTRY.get(fmt)
    if not cls:
        raise ValueError(f"Unsupported provider format: {fmt}")
    return cls(provider)


__all__ = [
    "BaseProvider",
    "AnthropicAdapter",
    "OpenAIChatAdapter",
    "OpenAIResponsesAdapter",
    "URLAdaptiveAdapter",
    "get_adapter",
    "REGISTRY",
    "is_supported_provider_format",
    "list_provider_capabilities",
    "supported_provider_formats",
]
