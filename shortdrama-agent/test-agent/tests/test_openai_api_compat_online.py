"""Opt-in checks for OpenAI-compatible online API endpoints.

Run against a deployed service with:

    RUN_REAL_OPENAI_COMPAT=1 \
    OPENAI_COMPAT_BASE_URL=https://example.apigateway-cn-beijing.volceapi.com \
    OPENAI_COMPAT_API_KEY=... \
    uv run python -m unittest tests.test_openai_api_compat_online -v

These tests intentionally fail when the service only exposes AgentKit/ADK
endpoints such as /invoke or /run_sse, because those are not OpenAI-compatible
REST API endpoints.
"""

from __future__ import annotations

import json
import os
import unittest
from typing import Any
from urllib.error import HTTPError
from urllib.request import Request, urlopen


def _enabled() -> bool:
    return os.getenv("RUN_REAL_OPENAI_COMPAT") == "1"


def _base_url() -> str:
    value = os.getenv("OPENAI_COMPAT_BASE_URL", "").strip()
    if not value:
        raise unittest.SkipTest("set OPENAI_COMPAT_BASE_URL to run online checks")
    return value.rstrip("/")


def _api_key() -> str:
    value = os.getenv("OPENAI_COMPAT_API_KEY", "").strip()
    if not value:
        raise unittest.SkipTest("set OPENAI_COMPAT_API_KEY to run online checks")
    return value


def _url(path: str) -> str:
    base = _base_url()
    if base.endswith("/v1") and path.startswith("/v1/"):
        return base + path[len("/v1") :]
    return base + path


def _request_json(
    method: str,
    path: str,
    *,
    body: dict[str, Any] | None = None,
) -> tuple[int, dict[str, str], Any]:
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = Request(
        _url(path),
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {_api_key()}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    try:
        with urlopen(req, timeout=90) as response:
            payload = response.read().decode("utf-8")
            return response.status, dict(response.headers.items()), json.loads(payload)
    except HTTPError as exc:
        payload = exc.read().decode("utf-8", errors="replace")
        try:
            parsed: Any = json.loads(payload)
        except json.JSONDecodeError:
            parsed = payload
        return exc.code, dict(exc.headers.items()), parsed


def _request_sse(path: str, body: dict[str, Any]) -> tuple[int, dict[str, str], list[str]]:
    req = Request(
        _url(path),
        data=json.dumps(body).encode("utf-8"),
        method="POST",
        headers={
            "Authorization": f"Bearer {_api_key()}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
        },
    )
    try:
        with urlopen(req, timeout=90) as response:
            raw = response.read().decode("utf-8", errors="replace")
            return response.status, dict(response.headers.items()), raw.splitlines()
    except HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        return exc.code, dict(exc.headers.items()), raw.splitlines()


@unittest.skipUnless(_enabled(), "set RUN_REAL_OPENAI_COMPAT=1 to call online service")
class OpenAIAPICompatibilityOnlineTest(unittest.TestCase):
    model = os.getenv("OPENAI_COMPAT_MODEL", "short_drama_asset_agent")

    def test_models_endpoint_matches_openai_shape(self):
        status, _headers, payload = _request_json("GET", "/v1/models")

        self.assertEqual(status, 200, payload)
        self.assertIsInstance(payload, dict)
        self.assertEqual(payload.get("object"), "list")
        self.assertIsInstance(payload.get("data"), list)
        self.assertGreater(len(payload["data"]), 0)
        self.assertIn("id", payload["data"][0])
        self.assertEqual(payload["data"][0].get("object"), "model")

    def test_chat_completions_non_stream_matches_openai_shape(self):
        status, _headers, payload = _request_json(
            "POST",
            "/v1/chat/completions",
            body={
                "model": self.model,
                "messages": [
                    {
                        "role": "user",
                        "content": "用一句话回复：OpenAI API 兼容性测试。",
                    }
                ],
                "stream": False,
                "temperature": 0,
            },
        )

        self.assertEqual(status, 200, payload)
        self.assertIsInstance(payload, dict)
        self.assertEqual(payload.get("object"), "chat.completion")
        self.assertIsInstance(payload.get("choices"), list)
        self.assertGreater(len(payload["choices"]), 0)
        message = payload["choices"][0].get("message")
        self.assertIsInstance(message, dict)
        self.assertEqual(message.get("role"), "assistant")
        self.assertIsInstance(message.get("content"), str)
        self.assertTrue(message["content"].strip())

    def test_chat_completions_stream_matches_openai_sse_shape(self):
        status, headers, lines = _request_sse(
            "/v1/chat/completions",
            {
                "model": self.model,
                "messages": [
                    {
                        "role": "user",
                        "content": "用一句话回复：流式兼容性测试。",
                    }
                ],
                "stream": True,
                "temperature": 0,
            },
        )

        self.assertEqual(status, 200, "\n".join(lines[:20]))
        self.assertIn("text/event-stream", headers.get("Content-Type", ""))

        data_lines = [line.removeprefix("data:").strip() for line in lines if line.startswith("data:")]
        self.assertTrue(data_lines, "expected at least one SSE data line")
        self.assertEqual(data_lines[-1], "[DONE]")

        first_chunk = json.loads(next(line for line in data_lines if line != "[DONE]"))
        self.assertEqual(first_chunk.get("object"), "chat.completion.chunk")
        self.assertIsInstance(first_chunk.get("choices"), list)
        self.assertGreater(len(first_chunk["choices"]), 0)
        self.assertIsInstance(first_chunk["choices"][0].get("delta"), dict)


if __name__ == "__main__":
    unittest.main()
