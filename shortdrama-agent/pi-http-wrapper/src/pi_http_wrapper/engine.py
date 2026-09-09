"""Pi RPC adapter with per-turn system/tool context and deferred tool results."""

from __future__ import annotations

import json
import os
import secrets
import shutil
import threading
import time
from dataclasses import asdict
from pathlib import Path
from queue import Empty, Queue
from typing import Any, Iterator, Protocol

from .contract import Message, PromptRequest, PromptResponse, ToolCall, ToolResult
from .rpc_manager import PiRpcManager
from .tool_bridge import ExternalToolBridge


class RuntimeUnavailable(RuntimeError):
    pass


class InvalidContinuation(ValueError):
    def __init__(self, message: str, *, code: str = "invalid_continuation") -> None:
        super().__init__(message)
        self.code = code


class PiEngine(Protocol):
    def prompt_sync(self, request: PromptRequest) -> PromptResponse: ...

    def prompt_events(self, request: PromptRequest) -> Iterator[dict[str, Any]]: ...


class AwaitingSourceEngine:
    """Explicitly unavailable engine retained for source-transfer diagnostics."""

    def prompt_sync(self, request: PromptRequest) -> PromptResponse:
        del request
        raise RuntimeUnavailable("Pi engine source has not been transferred into this repository")

    def prompt_events(self, request: PromptRequest) -> Iterator[dict[str, Any]]:
        del request
        raise RuntimeUnavailable("Pi engine source has not been transferred into this repository")
        yield  # pragma: no cover


class PiRpcEngine:
    """Adapt the captured Pi JSONL manager to the shortdrama runtime contract.

    Pi RPC has no command fields for per-turn system prompts or external tool
    schemas. The bundled extension loads those fields from a private context
    file, registers real Pi tools, and blocks each execution until the product
    returns the matching ``toolResult``.
    """

    def __init__(
        self,
        *,
        bridge: ExternalToolBridge,
        context_path: Path,
        extension_path: Path,
        pi_bin: str = "pi",
        command_timeout: float = 30,
        internal_token: str | None = None,
        tool_callback_url: str = "http://127.0.0.1:8787/internal/tool-calls",
        skill_paths: list[Path] | None = None,
        manager: PiRpcManager | None = None,
        response_timeout: float = 300,
        pending_turn_timeout: float = 600,
    ) -> None:
        self.bridge = bridge
        self.context_path = context_path
        self.extension_path = extension_path
        self.pi_bin = pi_bin
        self.command_timeout = command_timeout
        self.internal_token = internal_token
        self.tool_callback_url = tool_callback_url
        self.skill_paths = list(skill_paths or [])
        self.response_timeout = response_timeout
        self.pending_turn_timeout = pending_turn_timeout
        self._manager = manager
        self._active_queue: Queue[dict[str, Any]] | None = None
        self._active_conversation_id: str | None = None
        self._active_turn_nonce: str | None = None
        self._pending_timer: threading.Timer | None = None
        self._pending_timer_generation = 0
        self._turn_lock = threading.Lock()

    def _extra_args(self) -> list[str]:
        args = ["--no-builtin-tools", "--no-skills", "--extension", str(self.extension_path)]
        for skill_path in self.skill_paths:
            args.extend(["--skill", str(skill_path)])
        return args

    def _ensure_manager(self) -> PiRpcManager:
        if self._manager is None:
            environment = dict(os.environ)
            environment["PI_WRAPPER_CONTEXT_PATH"] = str(self.context_path)
            environment["PI_WRAPPER_TOOL_CALLBACK_URL"] = self.tool_callback_url
            if self.internal_token:
                environment["PI_WRAPPER_INTERNAL_TOKEN"] = self.internal_token
            self._manager = PiRpcManager(
                bin_path=self.pi_bin,
                extra_args=self._extra_args(),
                environment=environment,
            )
        if not self._manager.running:
            try:
                self._manager.start()
            except (OSError, RuntimeError) as error:
                raise RuntimeUnavailable(f"Pi runtime could not start: {error}") from error
        return self._manager

    def runtime_status(self) -> str:
        if os.path.isabs(self.pi_bin):
            available = os.path.isfile(self.pi_bin) and os.access(self.pi_bin, os.X_OK)
        else:
            available = shutil.which(self.pi_bin) is not None
        return "available" if available else "missing"

    def shutdown(self) -> None:
        if self._active_queue is not None:
            self._abort_turn(self._active_queue, code="runtime_shutdown")
            return
        self.bridge.abort_all(code="runtime_shutdown")
        if self._manager is not None:
            self._manager.stop()
        self._clear_context()

    def reload_skills(self, paths: list[Path]) -> None:
        if not self._turn_lock.acquire(blocking=False):
            raise RuntimeError("cannot reload skills while Pi is processing a turn")
        try:
            manager = self._ensure_manager()
            if self._active_queue is not None or manager.is_agent_busy():
                raise RuntimeError("cannot reload skills while Pi is processing a turn")
            self.skill_paths = list(paths)
            try:
                manager.restart(extra_args=self._extra_args())
            except (OSError, RuntimeError) as error:
                raise RuntimeError(f"failed to reload Pi skills: {error}") from error
        finally:
            self._turn_lock.release()

    def _write_context(self, request: PromptRequest, *, turn_nonce: str) -> None:
        self.context_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        payload = {
            "system": request.system,
            "conversationId": request.conversation_id,
            "turnNonce": turn_nonce,
            "tools": [
                {
                    "name": tool.name,
                    "description": tool.description,
                    "inputSchema": tool.input_schema,
                }
                for tool in request.tools
            ],
        }
        temporary = self.context_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        temporary.chmod(0o600)
        temporary.replace(self.context_path)

    def _clear_context(self) -> None:
        try:
            self.context_path.unlink()
        except FileNotFoundError:
            pass

    @staticmethod
    def _send_command(manager: PiRpcManager, command: dict[str, Any], *, timeout: float) -> dict[str, Any] | None:
        try:
            return manager.send_command(command, timeout=timeout)
        except (TimeoutError, RuntimeError, OSError) as error:
            raise RuntimeUnavailable(f"Pi RPC command failed: {error}") from error

    @staticmethod
    def _user_message(request: PromptRequest) -> str:
        user_messages = [message.content for message in request.messages if message.role == "user"]
        if not user_messages:
            raise InvalidContinuation("a new Pi turn requires at least one user message")
        if len(request.messages) == 1 and request.messages[0].role == "user":
            return user_messages[-1]
        # The product database, not Pi, is the durable conversation truth. A
        # complete transcript is supplied on every new turn and the Pi process
        # is discarded after settlement.
        history = [asdict(message) for message in request.messages]
        return (
            "Use the following authoritative conversation history from the product database. "
            "Continue from the last user message.\n"
            "<conversation_history_json>\n"
            + json.dumps(history, ensure_ascii=False)
            + "\n</conversation_history_json>"
        )

    def _begin_or_continue(self, request: PromptRequest) -> Queue[dict[str, Any]]:
        if request.tool_results:
            if request.messages or request.tools or request.system is not None:
                raise InvalidContinuation(
                    "a tool continuation may only contain conversationId and toolResults",
                )
            if self._active_queue is None:
                raise InvalidContinuation("toolResults were supplied without a pending Pi tool call")
            if self._manager is None or not self._manager.running:
                self._abort_turn(self._active_queue, code="runtime_exited")
                raise RuntimeUnavailable("Pi runtime exited while waiting for tool results")
            if not request.conversation_id or request.conversation_id != self._active_conversation_id:
                raise InvalidContinuation(
                    "conversationId does not match the pending Pi turn",
                    code="conversation_mismatch",
                )
            provided_ids = [result.tool_call_id for result in request.tool_results]
            if len(provided_ids) != len(set(provided_ids)):
                raise InvalidContinuation("duplicate toolCallId in toolResults")
            unknown, missing = self.bridge.resolve_exact(request.tool_results)
            if unknown or missing:
                details = []
                if unknown:
                    details.append("unknown toolCallId: " + ", ".join(unknown))
                if missing:
                    details.append("missing toolResult: " + ", ".join(missing))
                code = "unknown_tool_call" if unknown else "missing_tool_result"
                raise InvalidContinuation("; ".join(details), code=code)
            self._cancel_pending_timer()
            return self._active_queue
        if self.bridge.has_pending():
            raise InvalidContinuation("Pi is waiting for external tool results", code="runtime_busy")
        if not request.conversation_id:
            raise InvalidContinuation("conversationId is required")
        user_message = self._user_message(request)
        manager = self._ensure_manager()
        if self._active_queue is not None or manager.is_agent_busy():
            raise InvalidContinuation(
                "Pi is waiting for the current turn or external tool result",
                code="runtime_busy",
            )
        turn_nonce = secrets.token_urlsafe(32)
        self._write_context(request, turn_nonce=turn_nonce)
        try:
            sync_response = self._send_command(
                manager,
                {"type": "prompt", "message": "/shortdrama-sync-context"},
                timeout=self.command_timeout,
            )
        finally:
            self._clear_context()
        if sync_response and not sync_response.get("success"):
            raise RuntimeUnavailable(str(sync_response.get("error", "failed to sync Pi context")))
        queue = manager.subscribe()
        try:
            self.bridge.begin_turn(turn_nonce=turn_nonce, conversation_id=request.conversation_id)
        except (RuntimeError, ValueError) as error:
            manager.unsubscribe(queue)
            manager.stop()
            raise RuntimeUnavailable(f"external tool bridge could not start the Pi turn: {error}") from error
        self._active_queue = queue
        self._active_conversation_id = request.conversation_id
        self._active_turn_nonce = turn_nonce
        try:
            response = self._send_command(
                manager,
                {"type": "prompt", "message": user_message},
                timeout=self.command_timeout,
            )
        except RuntimeUnavailable:
            self._abort_turn(queue, code="prompt_rejected")
            raise
        if response and not response.get("success"):
            self._abort_turn(queue, code="prompt_rejected")
            raise RuntimeUnavailable(str(response.get("error", "Pi rejected prompt")))
        return queue

    def _finish(self, queue: Queue[dict[str, Any]]) -> None:
        self._cancel_pending_timer()
        manager = self._manager
        if manager is not None:
            manager.unsubscribe(queue)
        if self._active_queue is queue:
            if self._active_turn_nonce is not None:
                self.bridge.end_turn(turn_nonce=self._active_turn_nonce, code="turn_completed")
            self._active_queue = None
            self._active_conversation_id = None
            self._active_turn_nonce = None
        # No durable wrapper-side conversation state: each settled turn starts
        # the next request with a fresh --no-session Pi process.
        if manager is not None:
            manager.stop()
        self._clear_context()

    def _abort_turn(self, queue: Queue[dict[str, Any]], *, code: str) -> None:
        self._cancel_pending_timer()
        manager = self._manager
        if manager is not None:
            manager.unsubscribe(queue)
        if self._active_queue is queue:
            if self._active_turn_nonce is not None:
                self.bridge.end_turn(turn_nonce=self._active_turn_nonce, code=code)
            self._active_queue = None
            self._active_conversation_id = None
            self._active_turn_nonce = None
        if manager is not None:
            manager.stop()
        self._clear_context()

    def _cancel_pending_timer(self) -> None:
        self._pending_timer_generation += 1
        timer = self._pending_timer
        self._pending_timer = None
        if timer is not None:
            timer.cancel()

    def _schedule_pending_timeout(self, queue: Queue[dict[str, Any]], conversation_id: str | None) -> None:
        self._cancel_pending_timer()
        generation = self._pending_timer_generation

        def expire() -> None:
            self._turn_lock.acquire()
            try:
                if (
                    self._pending_timer_generation == generation
                    and self._active_queue is queue
                    and self._active_conversation_id == conversation_id
                ):
                    self._abort_turn(queue, code="tool_result_timeout")
            finally:
                self._turn_lock.release()

        timer = threading.Timer(self.pending_turn_timeout, expire)
        timer.daemon = True
        self._pending_timer = timer
        timer.start()

    @staticmethod
    def _usage(raw_usage: dict[str, Any]) -> dict[str, Any]:
        raw_cost = raw_usage.get("cost")
        if isinstance(raw_cost, dict):
            cost = raw_cost.get("total")
        elif isinstance(raw_cost, (int, float)) and not isinstance(raw_cost, bool):
            cost = raw_cost
        else:
            cost = None
        return {
            "status": "reported",
            "inputTokens": raw_usage.get("input", raw_usage.get("inputTokens")),
            "outputTokens": raw_usage.get("output", raw_usage.get("outputTokens")),
            "totalTokens": raw_usage.get("totalTokens"),
            "cost": cost,
            "costKnown": cost is not None,
        }

    def prompt_sync(self, request: PromptRequest) -> PromptResponse:
        if not self._turn_lock.acquire(blocking=False):
            raise InvalidContinuation("Pi is already processing a turn", code="runtime_busy")
        queue: Queue[dict[str, Any]] | None = None
        keep_active = False
        finished = False
        try:
            queue = self._begin_or_continue(request)
            text_parts: list[str] = []
            thinking_parts: list[str] = []
            tool_results: list[ToolResult] = []
            messages: list[Message] = []
            usage: dict[str, Any] | None = None
            deadline = time.monotonic() + self.response_timeout
            while time.monotonic() < deadline:
                if self._manager is not None and not self._manager.running:
                    raise RuntimeUnavailable("Pi runtime exited during the active turn")
                pending_calls = self.bridge.take_unreported()
                if pending_calls:
                    self._schedule_pending_timeout(queue, request.conversation_id)
                    keep_active = True
                    return PromptResponse(
                        status="requires_tool",
                        text="".join(text_parts),
                        thinking="".join(thinking_parts) or None,
                        tool_calls=pending_calls,
                        tool_results=tool_results,
                        messages=messages,
                        conversation_id=request.conversation_id,
                        usage=usage,
                    )
                try:
                    event = queue.get(timeout=0.1)
                except Empty:
                    continue
                event_type = event.get("type")
                if event_type == "runtime_exited":
                    raise RuntimeUnavailable("Pi runtime exited during the active turn")
                if event_type == "message_update":
                    delta = event.get("assistantMessageEvent", {})
                    if delta.get("type") == "text_delta":
                        text_parts.append(str(delta.get("delta", "")))
                    elif delta.get("type") == "thinking_delta":
                        thinking_parts.append(str(delta.get("delta", "")))
                elif event_type == "tool_execution_end":
                    tool_results.append(ToolResult(
                        tool_call_id=str(event.get("toolCallId", "")),
                        content=event.get("result"),
                        is_error=bool(event.get("isError")),
                    ))
                elif event_type == "message_end":
                    message = event.get("message", {})
                    role = message.get("role")
                    content = message.get("content")
                    if isinstance(role, str) and isinstance(content, str):
                        messages.append(Message(role=role, content=content))
                    if role == "assistant" and isinstance(message.get("usage"), dict):
                        usage = self._usage(message["usage"])
                elif event_type == "agent_settled":
                    self._finish(queue)
                    finished = True
                    return PromptResponse(
                        status="completed",
                        text="".join(text_parts),
                        thinking="".join(thinking_parts) or None,
                        tool_results=tool_results,
                        messages=messages,
                        conversation_id=request.conversation_id,
                        usage=usage,
                    )
            raise RuntimeUnavailable("Pi response timed out")
        finally:
            if queue is not None and not keep_active and not finished and self._active_queue is queue:
                self._abort_turn(queue, code="runtime_interrupted")
            self._turn_lock.release()

    def prompt_events(self, request: PromptRequest) -> Iterator[dict[str, Any]]:
        if not self._turn_lock.acquire(blocking=False):
            raise InvalidContinuation("Pi is already processing a turn", code="runtime_busy")
        queue: Queue[dict[str, Any]] | None = None
        keep_active = False
        finished = False
        try:
            queue = self._begin_or_continue(request)
            deadline = time.monotonic() + self.response_timeout
            usage_seen = False
            while time.monotonic() < deadline:
                if self._manager is not None and not self._manager.running:
                    raise RuntimeUnavailable("Pi runtime exited during the active turn")
                pending_calls = self.bridge.take_unreported()
                if pending_calls:
                    for call in pending_calls:
                        yield {"type": "tool_call", "toolCall": asdict(call)}
                    self._schedule_pending_timeout(queue, request.conversation_id)
                    keep_active = True
                    yield {
                        "type": "done",
                        "status": "requires_tool",
                        "conversationId": request.conversation_id,
                    }
                    return
                try:
                    event = queue.get(timeout=0.1)
                except Empty:
                    continue
                event_type = event.get("type")
                if event_type == "runtime_exited":
                    raise RuntimeUnavailable("Pi runtime exited during the active turn")
                if event_type == "message_update":
                    delta = event.get("assistantMessageEvent", {})
                    if delta.get("type") == "text_delta":
                        yield {"type": "text_delta", "delta": str(delta.get("delta", ""))}
                    elif delta.get("type") == "thinking_delta":
                        yield {"type": "thinking_delta", "delta": str(delta.get("delta", ""))}
                elif event_type == "message_end":
                    message = event.get("message", {})
                    if message.get("role") == "assistant" and isinstance(message.get("usage"), dict):
                        usage_seen = True
                        yield {"type": "usage", "usage": self._usage(message["usage"])}
                elif event_type == "agent_settled":
                    self._finish(queue)
                    finished = True
                    if not usage_seen:
                        yield {
                            "type": "usage",
                            "usage": PromptResponse(status="completed", text="").to_wire()["usage"],
                        }
                    yield {
                        "type": "done",
                        "status": "completed",
                        "conversationId": request.conversation_id,
                    }
                    return
            raise RuntimeUnavailable("Pi response timed out")
        finally:
            if queue is not None and not keep_active and not finished and self._active_queue is queue:
                self._abort_turn(queue, code="stream_closed")
            self._turn_lock.release()
