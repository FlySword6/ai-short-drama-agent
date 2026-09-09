"""LLM client for real semantic understanding via Volcengine Ark API.

The Ark API is OpenAI-compatible, so we use httpx to call it directly
without pulling in the full openai SDK. Each Skill receives an LLMClient
instance (dependency injection), enabling tests to substitute a mock.
"""

from __future__ import annotations

import json
import os
import re
import time
from typing import Any, Callable

import httpx


class LLMClient:
    """Synchronous client for the Volcengine Ark chat and image APIs."""

    def __init__(
        self,
        api_key: str | None = None,
        model_id: str | None = None,
        image_model_id: str | None = None,
        base_url: str | None = None,
        timeout: float = 120.0,
    ) -> None:
        self._api_key = api_key or self._resolve_api_key()
        self._model_id = model_id or os.getenv(
            "MODEL_AGENT_ENDPOINT_ID", "doubao-1-5-pro-32k-250115",
        )
        self._image_model_id = image_model_id or os.getenv(
            "IMAGE_MODEL_ENDPOINT_ID", "doubao-seedream-3-0-t2i-250415",
        )
        self._base_url = (
            base_url
            or os.getenv("ARK_BASE_URL", "https://ark.cn-beijing.volces.com/api/v3")
        )
        self._timeout = timeout

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def chat(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        temperature: float = 0.3,
        timeout: float | None = None,
    ) -> str:
        """Call chat completions and return the raw assistant text."""
        body: dict[str, Any] = {
            "model": self._model_id,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "temperature": temperature,
        }
        resp = self._post("/chat/completions", body, timeout)
        return resp["choices"][0]["message"]["content"]

    def chat_json(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        temperature: float = 0.3,
        timeout: float | None = None,
        retries: int = 2,
        validate: Callable[[dict[str, Any]], str | None] | None = None,
    ) -> dict[str, Any]:
        """Call chat API, parse as JSON, and optionally validate the schema.

        Handles markdown code-block wrapping and mixed-text extraction.
        Retries up to *retries* times.  On each failure (parse error,
        non-dict, or validation error) the error message is fed back
        to the LLM so it can correct its output.  Returns an empty
        dict on total failure so downstream Skills can fall back.
        """
        correction = ""
        for attempt in range(1, retries + 2):
            try:
                prompt = user_prompt
                if correction:
                    prompt = (
                        f"{user_prompt}\n\n"
                        f"--- 修正提示 ---\n"
                        f"你上一轮返回不符合规范：{correction}\n"
                        f"请严格按照要求的 JSON 结构重新输出。"
                    )
                raw = self.chat(
                    system_prompt=system_prompt,
                    user_prompt=prompt,
                    temperature=temperature,
                    timeout=timeout,
                )
                text = raw.strip()
                if text.startswith("```"):
                    lines = text.splitlines()
                    if len(lines) >= 3:
                        text = "\n".join(lines[1:-1]).strip()
                # 尝试从混杂文本中提取 JSON 对象。
                text = self._extract_json(text)
                parsed = json.loads(text)
                if not isinstance(parsed, dict):
                    raise ValueError(
                        f"返回了 JSON {type(parsed).__name__}，应为 dict 对象"
                    )
                # 结构校验：如果不符规范，抛出让重试逻辑捕获。
                if validate is not None:
                    error_msg = validate(parsed)
                    if error_msg:
                        raise ValueError(error_msg)
                return parsed
            except (json.JSONDecodeError, ValueError) as exc:
                correction = str(exc)
                if attempt <= retries:
                    time.sleep(0.5 * attempt)
        # 全部重试失败后返回空 dict，让下游 Skill 走 fallback 逻辑。
        return {}

    @staticmethod
    def _extract_json(text: str) -> str:
        """Try to find a JSON object in mixed text (LLM may add prose)."""
        # 已经是纯 JSON 时直接返回。
        stripped = text.strip()
        if stripped.startswith("{"):
            return stripped
        # 从文本中提取第一个 {...} 块。
        match = re.search(r"\{.*\}", text, re.DOTALL)
        return match.group(0) if match else stripped

    def generate_image(
        self,
        *,
        prompt: str,
        size: str = "1024x1024",
        timeout: float | None = None,
    ) -> str:
        """Call the image generation API and return the image URL."""
        body: dict[str, Any] = {
            "model": self._image_model_id,
            "prompt": prompt,
            "n": 1,
            "size": size,
            "response_format": "url",
        }
        resp = self._post("/images/generations", body, timeout)
        return resp["data"][0]["url"]

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    @staticmethod
    def _resolve_api_key() -> str:
        # 1. 优先使用预配置的 Ark API Key（AgentKit 运行时或本地手动设置）
        for name in (
            "MODEL_AGENT_API_KEY",
            "ARK_API_KEY",
            "VOLCENGINE_ARK_API_KEY",
            "ARK_API_TOKEN",
        ):
            token = os.getenv(name, "").strip()
            if token:
                return token

        # 2. 没有直接的 Ark Key 时，用火山云 AK/SK 动态换取 Ark token
        from veadk.auth.veauth.ark_veauth import get_ark_token

        last_error: Exception | None = None
        for attempt in range(1, 4):
            try:
                if attempt > 1:
                    time.sleep(0.5 * attempt)
                return get_ark_token()
            except Exception as exc:
                last_error = exc

        raise RuntimeError(
            "Failed to resolve Ark API key. Either:\n"            "  1. Set MODEL_AGENT_API_KEY / ARK_API_KEY env var directly, or\n"
            "  2. Set VOLCENGINE_ACCESS_KEY + VOLCENGINE_SECRET_KEY so "
            "get_ark_token() can exchange them for an Ark token.\n"
            f"Last error: {last_error}"
        )

    def _post(
        self, path: str, body: dict[str, Any], timeout: float | None,
    ) -> dict[str, Any]:
        with httpx.Client(timeout=timeout or self._timeout) as client:
            resp = client.post(
                f"{self._base_url}{path}",
                headers={
                    "Authorization": f"Bearer {self._api_key}",
                    "Content-Type": "application/json",
                },
                json=body,
            )
            resp.raise_for_status()
            return resp.json()


_default_llm: LLMClient | None = None


def default_llm() -> LLMClient:
    """Return a process-wide default LLM client (lazy singleton)."""
    global _default_llm
    if _default_llm is None:
        _default_llm = LLMClient()
    return _default_llm
