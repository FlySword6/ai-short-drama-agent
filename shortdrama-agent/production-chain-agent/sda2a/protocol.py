"""A2A (Agent-to-Agent) protocol primitives.

Implements a pragmatic subset of the Google A2A open protocol:
- AgentCard for agent discovery (served at /.well-known/agent.json)
- JSON-RPC 2.0 envelope for task submission (tasks/send)
- Task lifecycle states

Each sub-agent exposes its AgentCard for discovery and accepts
JSON-RPC 2.0 task requests at its HTTP endpoint.  The orchestrator
discovers sub-agents, sends tasks, and collects results.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from typing import Any, Literal
from uuid import uuid4

# ---------------------------------------------------------------------------
# Task lifecycle states (A2A spec §5.1)
# ---------------------------------------------------------------------------

TaskState = Literal[
    "submitted",
    "working",
    "input-required",
    "completed",
    "canceled",
    "failed",
]


# ---------------------------------------------------------------------------
# AgentCard — agent metadata for discovery
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class AgentSkill:
    """A capability descriptor published in the AgentCard."""

    name: str
    description: str
    input_schema: dict[str, Any] = field(default_factory=dict)
    output_schema: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class AgentCard:
    """Agent metadata served at ``/.well-known/agent.json``.

    Following the A2A spec, the card lets the orchestrator discover
    what an agent can do and where to reach it.
    """

    name: str
    description: str
    url: str
    version: str = "0.1.0"
    capabilities: dict[str, bool] = field(
        default_factory=lambda: {"streaming": False}
    )
    skills: list[AgentSkill] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        d = {
            "name": self.name,
            "description": self.description,
            "url": self.url,
            "version": self.version,
            "capabilities": self.capabilities,
            "skills": [
                {
                    "name": s.name,
                    "description": s.description,
                    "inputSchema": s.input_schema,
                    "outputSchema": s.output_schema,
                }
                for s in self.skills
            ],
        }
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "AgentCard":
        skills = [
            AgentSkill(
                name=s["name"],
                description=s.get("description", ""),
                input_schema=s.get("inputSchema", s.get("input_schema", {})),
                output_schema=s.get("outputSchema", s.get("output_schema", {})),
            )
            for s in d.get("skills", [])
        ]
        return cls(
            name=d["name"],
            description=d.get("description", ""),
            url=d.get("url", ""),
            version=d.get("version", "0.1.0"),
            capabilities=d.get("capabilities", {"streaming": False}),
            skills=skills,
        )


# ---------------------------------------------------------------------------
# JSON-RPC 2.0 message builders
# ---------------------------------------------------------------------------

def make_request(
    method: str,
    params: dict[str, Any],
    req_id: str | None = None,
) -> dict[str, Any]:
    """Build a JSON-RPC 2.0 request envelope."""

    return {
        "jsonrpc": "2.0",
        "method": method,
        "id": req_id or str(uuid4()),
        "params": params,
    }


def make_response(
    result: dict[str, Any],
    req_id: str,
) -> dict[str, Any]:
    """Build a successful JSON-RPC 2.0 response."""

    return {
        "jsonrpc": "2.0",
        "id": req_id,
        "result": result,
    }


def make_error(
    code: int,
    message: str,
    req_id: str | None = None,
) -> dict[str, Any]:
    """Build a JSON-RPC 2.0 error response."""

    return {
        "jsonrpc": "2.0",
        "id": req_id,
        "error": {"code": code, "message": message},
    }


# ---------------------------------------------------------------------------
# Task helpers — build/parse the A2A task envelope
# ---------------------------------------------------------------------------

def build_task_payload(
    data: dict[str, Any],
    *,
    task_id: str | None = None,
    session_id: str | None = None,
) -> dict[str, Any]:
    """Wrap a business payload into an A2A ``tasks/send`` params object.

    The business data is JSON-encoded as the ``text`` part of the
    message, following the A2A multi-modal message format.
    """

    return {
        "id": task_id or str(uuid4()),
        "sessionId": session_id or str(uuid4()),
        "message": {
            "role": "user",
            "parts": [
                {
                    "type": "text",
                    "text": json.dumps(data, ensure_ascii=False),
                }
            ],
        },
    }


def extract_task_data(params: dict[str, Any]) -> dict[str, Any]:
    """Extract the business payload from an A2A task params object."""

    message = params.get("message", {})
    for part in message.get("parts", []):
        if part.get("type") == "text":
            return json.loads(part["text"])
    return {}


def build_task_result(
    task_id: str,
    data: dict[str, Any],
    state: TaskState = "completed",
) -> dict[str, Any]:
    """Build a completed task result with the business data as artifact."""

    return {
        "id": task_id,
        "status": {"state": state},
        "artifacts": [
            {
                "name": "result",
                "parts": [
                    {
                        "type": "text",
                        "text": json.dumps(data, ensure_ascii=False),
                    }
                ],
            }
        ],
    }


def extract_result_data(result: dict[str, Any]) -> dict[str, Any]:
    """Extract the business data from a task result's artifacts."""

    for artifact in result.get("artifacts", []):
        for part in artifact.get("parts", []):
            if part.get("type") == "text":
                return json.loads(part["text"])
    return {}
