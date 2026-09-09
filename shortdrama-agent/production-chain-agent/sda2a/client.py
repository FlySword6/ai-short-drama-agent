"""A2A client — discovers agents and sends tasks via HTTP.

The orchestrator uses ``A2AClient`` to communicate with sub-agents.
Each call follows the A2A protocol: JSON-RPC 2.0 over HTTP, with
business data encoded as text parts in the A2A message envelope.

Uses ``httpx`` for HTTP transport (already a project dependency).
"""

from __future__ import annotations

import json
from typing import Any
from uuid import uuid4

import httpx

from .protocol import (
    AgentCard,
    build_task_payload,
    extract_result_data,
    make_request,
)


class A2AClient:
    """Synchronous client for A2A agent communication.

    Args:
        timeout: HTTP timeout in seconds for each request.
    """

    def __init__(self, timeout: float = 120.0) -> None:
        self._timeout = timeout

    # ------------------------------------------------------------------
    # Discovery
    # ------------------------------------------------------------------

    def discover(self, base_url: str) -> AgentCard:
        """Fetch and parse an agent's AgentCard.

        GET ``{base_url}/.well-known/agent.json``
        """

        url = f"{base_url.rstrip('/')}/.well-known/agent.json"
        with httpx.Client(timeout=self._timeout) as client:
            resp = client.get(url)
            resp.raise_for_status()
            return AgentCard.from_dict(resp.json())

    # ------------------------------------------------------------------
    # Task submission
    # ------------------------------------------------------------------

    def send_task(self, base_url: str, data: dict[str, Any]) -> dict[str, Any]:
        """Send a task to an A2A agent and return the business result.

        The *data* dict is the business payload (e.g. script parameters).
        It is wrapped in a JSON-RPC 2.0 ``tasks/send`` request, sent via
        HTTP POST, and the result artifact is extracted and returned.

        Raises ``RuntimeError`` if the agent returns a task-level error
        or a JSON-RPC error.
        """

        task_id = str(uuid4())
        params = build_task_payload(data, task_id=task_id)
        req = make_request("tasks/send", params)

        with httpx.Client(timeout=self._timeout) as client:
            resp = client.post(
                base_url.rstrip("/"),
                json=req,
                headers={"Content-Type": "application/json"},
            )
            resp.raise_for_status()
            body = resp.json()

        # Check for JSON-RPC level error.
        if "error" in body:
            err = body["error"]
            raise RuntimeError(
                f"A2A error [{err.get('code')}]: {err.get('message')}"
            )

        result = body.get("result", {})

        # Check for task-level failure.
        state = result.get("status", {}).get("state", "")
        if state == "failed":
            error_data = extract_result_data(result)
            raise RuntimeError(
                f"Agent task failed: {error_data.get('error', 'unknown')}"
            )

        # Extract and return the business data from artifacts.
        return extract_result_data(result)
