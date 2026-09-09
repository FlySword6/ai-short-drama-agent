"""Stable request/response contract between the shortdrama app and Pi."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass(frozen=True)
class Message:
    role: str
    content: str


@dataclass(frozen=True)
class ToolDefinition:
    name: str
    description: str
    input_schema: dict[str, Any]


@dataclass(frozen=True)
class ToolCall:
    id: str
    name: str
    arguments: dict[str, Any]


@dataclass(frozen=True)
class ToolResult:
    tool_call_id: str
    content: Any
    is_error: bool = False


@dataclass(frozen=True)
class PromptRequest:
    """One Pi inference turn, including a continuation after local tool execution."""

    messages: list[Message]
    system: str | None = None
    tools: list[ToolDefinition] = field(default_factory=list)
    tool_results: list[ToolResult] = field(default_factory=list)
    conversation_id: str | None = None

    def to_engine_payload(self) -> dict[str, Any]:
        """Keep every caller-provided context field visible to the Pi adapter."""
        return {
            "system": self.system,
            "messages": [asdict(message) for message in self.messages],
            "tools": [
                {
                    "name": tool.name,
                    "description": tool.description,
                    "inputSchema": tool.input_schema,
                }
                for tool in self.tools
            ],
            "toolResults": [
                {
                    "toolCallId": result.tool_call_id,
                    "content": result.content,
                    "isError": result.is_error,
                }
                for result in self.tool_results
            ],
            "conversationId": self.conversation_id,
        }


@dataclass(frozen=True)
class PromptResponse:
    status: str
    text: str
    thinking: str | None = None
    tool_calls: list[ToolCall] = field(default_factory=list)
    tool_results: list[ToolResult] = field(default_factory=list)
    messages: list[Message] = field(default_factory=list)
    conversation_id: str | None = None
    usage: dict[str, Any] | None = None

    def to_wire(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "text": self.text,
            "thinking": self.thinking,
            "toolCalls": [asdict(call) for call in self.tool_calls],
            "toolResults": [
                {
                    "toolCallId": result.tool_call_id,
                    "content": result.content,
                    "isError": result.is_error,
                }
                for result in self.tool_results
            ],
            "messages": [asdict(message) for message in self.messages],
            "conversationId": self.conversation_id,
            "usage": self.usage or {
                "status": "unknown",
                "inputTokens": None,
                "outputTokens": None,
                "totalTokens": None,
                "cost": None,
                "costKnown": False,
            },
        }
