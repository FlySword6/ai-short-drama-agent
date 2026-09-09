"""Thread-safe rendezvous between Pi extension tool calls and product results."""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Any

from .contract import ToolCall, ToolResult


class StaleToolCallback(ValueError):
    """The callback does not belong to the currently active Pi turn."""


@dataclass
class _PendingCall:
    call: ToolCall
    created_at: float = field(default_factory=time.monotonic)
    reported: bool = False
    result: ToolResult | None = None
    ready: threading.Event = field(default_factory=threading.Event)


class ExternalToolBridge:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._calls: dict[str, _PendingCall] = {}
        self._active_turn_nonce: str | None = None
        self._active_conversation_id: str | None = None

    def begin_turn(self, *, turn_nonce: str, conversation_id: str) -> None:
        if not turn_nonce or not conversation_id:
            raise ValueError("turn nonce and conversation id are required")
        with self._lock:
            if self._active_turn_nonce is not None or self._calls:
                raise RuntimeError("an external tool turn is already active")
            self._active_turn_nonce = turn_nonce
            self._active_conversation_id = conversation_id

    def execute(
        self,
        call: ToolCall,
        *,
        turn_nonce: str,
        conversation_id: str,
        timeout: float,
    ) -> ToolResult:
        self.assert_active(turn_nonce=turn_nonce, conversation_id=conversation_id)
        with self._lock:
            if call.id in self._calls:
                raise ValueError(f"duplicate tool call id: {call.id}")
            pending = _PendingCall(call=call)
            self._calls[call.id] = pending
        if not pending.ready.wait(timeout):
            with self._lock:
                if self._calls.get(call.id) is pending:
                    self._calls.pop(call.id, None)
            return ToolResult(
                tool_call_id=call.id,
                content={"error": "external_tool_result_timeout"},
                is_error=True,
            )
        with self._lock:
            if self._calls.get(call.id) is pending:
                self._calls.pop(call.id, None)
            result = pending.result
        if result is None:
            return ToolResult(tool_call_id=call.id, content={"error": "external_tool_result_missing"}, is_error=True)
        return result

    def assert_active(self, *, turn_nonce: str, conversation_id: str) -> None:
        """Reject callbacks from a completed or different Pi turn before side effects."""
        with self._lock:
            if (
                not turn_nonce
                or turn_nonce != self._active_turn_nonce
                or conversation_id != self._active_conversation_id
            ):
                raise StaleToolCallback("external tool callback does not belong to the active Pi turn")

    def take_unreported(self) -> list[ToolCall]:
        with self._lock:
            calls = [pending.call for pending in self._calls.values() if not pending.reported]
            for pending in self._calls.values():
                if not pending.reported:
                    pending.reported = True
            return calls

    def resolve(self, results: list[ToolResult]) -> list[str]:
        missing: list[str] = []
        with self._lock:
            for result in results:
                pending = self._calls.get(result.tool_call_id)
                if pending is None:
                    missing.append(result.tool_call_id)
                    continue
                pending.result = result
                pending.ready.set()
        return missing

    def resolve_exact(self, results: list[ToolResult]) -> tuple[list[str], list[str]]:
        """Atomically validate the whole result set and release matching calls."""
        provided = {result.tool_call_id for result in results}
        with self._lock:
            pending = set(self._calls)
            unknown = sorted(provided - pending)
            missing = sorted(pending - provided)
            if unknown or missing:
                return unknown, missing
            for result in results:
                call = self._calls[result.tool_call_id]
                call.result = result
                call.ready.set()
        return [], []

    def pending_ids(self) -> set[str]:
        with self._lock:
            return set(self._calls)

    def abort_all(self, *, code: str) -> None:
        """Release extension callbacks when a Pi turn is being discarded."""
        with self._lock:
            pending_calls = list(self._calls.values())
            for pending in pending_calls:
                pending.result = ToolResult(
                    tool_call_id=pending.call.id,
                    content={"error": code},
                    is_error=True,
                )
                pending.ready.set()
            self._calls.clear()
            self._active_turn_nonce = None
            self._active_conversation_id = None

    def end_turn(self, *, turn_nonce: str, code: str) -> bool:
        """Close one exact turn without allowing an old owner to close a new one."""
        with self._lock:
            if turn_nonce != self._active_turn_nonce:
                return False
            pending_calls = list(self._calls.values())
            for pending in pending_calls:
                pending.result = ToolResult(
                    tool_call_id=pending.call.id,
                    content={"error": code},
                    is_error=True,
                )
                pending.ready.set()
            self._calls.clear()
            self._active_turn_nonce = None
            self._active_conversation_id = None
            return True

    def has_pending(self) -> bool:
        with self._lock:
            return bool(self._calls)
