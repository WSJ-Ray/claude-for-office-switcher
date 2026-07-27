from abc import ABC, abstractmethod
from typing import AsyncIterator


class BaseProvider(ABC):
    format: str = ""

    def __init__(self, cfg: dict):
        """从提供商配置中初始化基础地址、密钥和扩展选项。"""
        self.base_url = cfg["base_url"].rstrip("/")
        self.api_key = cfg["api_key"]
        self.extra = cfg.get("extra_config") or {}

    @abstractmethod
    async def list_models(self) -> list[dict]:
        """返回上游模型列表，格式为 Anthropic 风格的模型列表：[{id, type, display_name, created_at}, ...]"""

    @abstractmethod
    async def send(self, body: dict) -> tuple[bytes, str, dict, int]:
        """非流式发送请求。

        返回 (响应字节, 内容类型, 用量字典, HTTP 状态码)。
        状态码 >= 400 表示上游请求失败，调用方可据此触发故障转移。
        用量字典 key：input_tokens, output_tokens, cache_w, cache_r。
        """

    @abstractmethod
    async def stream(self, body: dict) -> AsyncIterator[tuple[bytes, dict | None]]:
        """流式发送请求。逐块产出 (SSE 字节, 用量或None)。

        适配器负责产出 Anthropic 格式的 SSE 事件。
        最后一次产出的元组为 (b"", 用量字典)，标记流结束。
        """
