"""Shared utilities for provider adapters."""
from urllib.parse import urlparse


def model_list_urls(base: str) -> list[str]:
    """根据上游基础地址生成候选模型列表 URL。

    部分 Anthropic 兼容端点不会直接暴露 ``/v1/models``，模型列表可能位于
    同一主机的 OpenAI 风格路径，因此依次尝试以下候选地址：

    1. ``{base}/v1/models``
    2. ``{base}/models``
    3. 上一级路径的 ``/v1/models``
    4. 上一级路径的 ``/models``

    返回结果会保留顺序并去重。
    """
    urls = [f"{base}/v1/models", f"{base}/models"]
    parsed = urlparse(base)
    path = parsed.path.rstrip("/")
    if "/" in path:
        parent_path = path.rsplit("/", 1)[0]
        parent = f"{parsed.scheme}://{parsed.netloc}{parent_path}"
    else:
        parent = f"{parsed.scheme}://{parsed.netloc}"
    urls.append(f"{parent}/v1/models")
    urls.append(f"{parent}/models")
    seen: set[str] = set()
    out: list[str] = []
    for u in urls:
        if u not in seen:
            seen.add(u)
            out.append(u)
    return out
