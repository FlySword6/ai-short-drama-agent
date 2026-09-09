import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from queue import Queue

from pi_http_wrapper.contract import Message, PromptRequest, ToolCall, ToolDefinition, ToolResult
from pi_http_wrapper.engine import InvalidContinuation, PiRpcEngine, RuntimeUnavailable
from pi_http_wrapper.tool_bridge import ExternalToolBridge, StaleToolCallback


class FakeRpcManager:
    def __init__(self, on_prompt=None, on_sync=None):
        self.running = True
        self.commands = []
        self.queue = Queue()
        self.on_prompt = on_prompt
        self.on_sync = on_sync

    def start(self):
        self.running = True

    def stop(self):
        self.running = False

    def restart(self, *, extra_args=None):
        self.running = True

    def is_agent_busy(self):
        return False

    def subscribe(self):
        return self.queue

    def unsubscribe(self, queue):
        pass

    def send_command(self, command, *, wait_response=True, timeout=30):
        self.commands.append(command)
        if command.get("message") == "/shortdrama-sync-context":
            if self.on_sync:
                self.on_sync(command)
        elif self.on_prompt:
            self.on_prompt(command, self.queue)
        return {"type": "response", "command": command["type"], "success": True}


class TimeoutRpcManager(FakeRpcManager):
    def send_command(self, command, *, wait_response=True, timeout=30):
        if command.get("message") != "/shortdrama-sync-context":
            raise TimeoutError("acceptance timeout")
        return super().send_command(command, wait_response=wait_response, timeout=timeout)


def execute_for_active_turn(
    engine: PiRpcEngine,
    bridge: ExternalToolBridge,
    call: ToolCall,
    *,
    timeout: float,
):
    assert engine._active_turn_nonce is not None
    assert engine._active_conversation_id is not None
    return bridge.execute(
        call,
        turn_nonce=engine._active_turn_nonce,
        conversation_id=engine._active_conversation_id,
        timeout=timeout,
    )


class EngineTests(unittest.TestCase):
    def test_system_and_external_tool_schema_are_written_before_prompt(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            captured_context = {}
            manager = FakeRpcManager(
                on_sync=lambda _command: captured_context.update(
                    json.loads((root / "context.json").read_text(encoding="utf-8"))
                ),
                on_prompt=lambda _command, queue: (
                    queue.put({"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "delta": "done"}}),
                    queue.put({"type": "agent_settled"}),
                )
            )
            engine = PiRpcEngine(
                bridge=ExternalToolBridge(),
                context_path=root / "context.json",
                extension_path=root / "extension.ts",
                manager=manager,
            )
            response = engine.prompt_sync(PromptRequest(
                system="shortdrama system",
                messages=[Message(role="user", content="find asset")],
                tools=[ToolDefinition(name="search_assets", description="search", input_schema={"type": "object"})],
                conversation_id="conv-complete",
            ))
            self.assertEqual(response.status, "completed")
            self.assertEqual(response.text, "done")
            self.assertEqual(manager.commands[0]["message"], "/shortdrama-sync-context")
            self.assertEqual(manager.commands[1]["message"], "find asset")
            self.assertEqual(captured_context["system"], "shortdrama system")
            self.assertEqual(captured_context["conversationId"], "conv-complete")
            self.assertTrue(captured_context["turnNonce"])
            self.assertEqual(captured_context["tools"][0]["name"], "search_assets")
            self.assertFalse((root / "context.json").exists())

    def test_tool_result_resumes_same_pi_turn(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            bridge = ExternalToolBridge()
            holder = {}

            def on_prompt(_command, queue):
                def execute_tool():
                    holder["result"] = execute_for_active_turn(
                        engine,
                        bridge,
                        ToolCall(id="call-1", name="search_assets", arguments={"query": "rain"}),
                        timeout=3,
                    )
                    queue.put({"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "delta": "asset found"}})
                    queue.put({"type": "agent_settled"})
                threading.Thread(target=execute_tool, daemon=True).start()

            manager = FakeRpcManager(on_prompt=on_prompt)
            engine = PiRpcEngine(
                bridge=bridge,
                context_path=root / "context.json",
                extension_path=root / "extension.ts",
                manager=manager,
                response_timeout=3,
            )
            first = engine.prompt_sync(PromptRequest(
                messages=[Message(role="user", content="search")],
                tools=[ToolDefinition(name="search_assets", description="search", input_schema={})],
                conversation_id="conv-tool",
            ))
            self.assertEqual(first.status, "requires_tool")
            self.assertEqual(first.tool_calls[0].id, "call-1")
            second = engine.prompt_sync(PromptRequest(
                messages=[],
                tool_results=[ToolResult(tool_call_id="call-1", content={"ref_id": "asset-1"})],
                conversation_id="conv-tool",
            ))
            self.assertEqual(second.status, "completed")
            self.assertEqual(second.text, "asset found")
            self.assertEqual(holder["result"].content, {"ref_id": "asset-1"})

    def test_tool_result_rejects_conversation_mismatch_and_unknown_call_id(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            bridge = ExternalToolBridge()

            def on_prompt(_command, _queue):
                threading.Thread(
                    target=lambda: execute_for_active_turn(
                        engine,
                        bridge,
                        ToolCall(id="call-stable", name="search_assets", arguments={}),
                        timeout=3,
                    ),
                    daemon=True,
                ).start()

            engine = PiRpcEngine(
                bridge=bridge,
                context_path=root / "context.json",
                extension_path=root / "extension.ts",
                manager=FakeRpcManager(on_prompt=on_prompt),
                response_timeout=3,
            )
            first = engine.prompt_sync(PromptRequest(
                messages=[Message(role="user", content="search")],
                tools=[ToolDefinition(name="search_assets", description="search", input_schema={})],
                conversation_id="conv-stable",
            ))
            self.assertEqual(first.tool_calls[0].id, "call-stable")

            with self.assertRaises(InvalidContinuation) as mismatch:
                engine.prompt_sync(PromptRequest(
                    messages=[],
                    tool_results=[ToolResult(tool_call_id="call-stable", content={})],
                    conversation_id="conv-other",
                ))
            self.assertEqual(mismatch.exception.code, "conversation_mismatch")

            with self.assertRaises(InvalidContinuation) as unknown:
                engine.prompt_sync(PromptRequest(
                    messages=[],
                    tool_results=[ToolResult(tool_call_id="call-other", content={})],
                    conversation_id="conv-stable",
                ))
            self.assertEqual(unknown.exception.code, "unknown_tool_call")
            engine.shutdown()

    def test_old_callback_interleaved_with_new_turn_never_becomes_a_tool_call(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            bridge = ExternalToolBridge()
            manager = FakeRpcManager()
            old_identity = {}
            callback_outcome = {}

            engine = PiRpcEngine(
                bridge=bridge,
                context_path=root / "context.json",
                extension_path=root / "extension.ts",
                manager=manager,
                response_timeout=3,
            )

            def on_prompt(_command, queue):
                if engine._active_conversation_id == "conv-old":
                    old_identity["nonce"] = engine._active_turn_nonce
                    queue.put({"type": "agent_settled"})
                    return

                def interleave_callbacks():
                    try:
                        bridge.execute(
                            ToolCall(id="call-old", name="create_asset", arguments={"stale": True}),
                            turn_nonce=old_identity["nonce"],
                            conversation_id="conv-old",
                            timeout=0.1,
                        )
                    except StaleToolCallback:
                        callback_outcome["old_rejected"] = True
                    callback_outcome["new_result"] = execute_for_active_turn(
                        engine,
                        bridge,
                        ToolCall(id="call-new", name="search_assets", arguments={}),
                        timeout=3,
                    )

                threading.Thread(target=interleave_callbacks, daemon=True).start()

            manager.on_prompt = on_prompt
            completed = engine.prompt_sync(PromptRequest(
                messages=[Message(role="user", content="old turn")],
                conversation_id="conv-old",
            ))
            self.assertEqual(completed.status, "completed")
            self.assertTrue(old_identity["nonce"])

            pending = engine.prompt_sync(PromptRequest(
                messages=[Message(role="user", content="new turn")],
                tools=[ToolDefinition(name="search_assets", description="search", input_schema={})],
                conversation_id="conv-new",
            ))
            self.assertTrue(callback_outcome["old_rejected"])
            self.assertEqual([call.id for call in pending.tool_calls], ["call-new"])
            self.assertNotIn("call-old", bridge.pending_ids())
            engine.shutdown()

    def test_sse_maps_pi_events_to_stable_contract_without_raw_events(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manager = FakeRpcManager(
                on_prompt=lambda _command, queue: (
                    queue.put({"type": "agent_start"}),
                    queue.put({
                        "type": "message_update",
                        "assistantMessageEvent": {"type": "text_delta", "delta": "hello"},
                    }),
                    queue.put({
                        "type": "message_end",
                        "message": {
                            "role": "assistant",
                            "usage": {"input": 0, "output": 2, "totalTokens": 2, "cost": {}},
                        },
                    }),
                    queue.put({"type": "agent_settled"}),
                )
            )
            engine = PiRpcEngine(
                bridge=ExternalToolBridge(),
                context_path=root / "context.json",
                extension_path=root / "extension.ts",
                manager=manager,
            )
            events = list(engine.prompt_events(PromptRequest(
                messages=[Message(role="user", content="hello")],
                conversation_id="conv-sse",
            )))
            self.assertEqual([event["type"] for event in events], ["text_delta", "usage", "done"])
            self.assertEqual(events[0]["delta"], "hello")
            self.assertEqual(events[1]["usage"]["inputTokens"], 0)
            self.assertIsNone(events[1]["usage"]["cost"])
            self.assertFalse(events[1]["usage"]["costKnown"])
            self.assertEqual(events[2]["status"], "completed")

    def test_concurrent_turn_is_rejected_without_waiting(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            engine = PiRpcEngine(
                bridge=ExternalToolBridge(),
                context_path=root / "context.json",
                extension_path=root / "extension.ts",
                manager=FakeRpcManager(),
            )
            self.assertTrue(engine._turn_lock.acquire(blocking=False))
            try:
                with self.assertRaises(InvalidContinuation) as busy:
                    engine.prompt_sync(PromptRequest(
                        messages=[Message(role="user", content="hello")],
                        conversation_id="conv-busy",
                    ))
                self.assertEqual(busy.exception.code, "runtime_busy")
            finally:
                engine._turn_lock.release()

    def test_closing_sse_cleans_runtime_and_allows_next_turn(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manager = FakeRpcManager(
                on_prompt=lambda _command, queue: queue.put({
                    "type": "message_update",
                    "assistantMessageEvent": {"type": "text_delta", "delta": "partial"},
                })
            )
            engine = PiRpcEngine(
                bridge=ExternalToolBridge(),
                context_path=root / "context.json",
                extension_path=root / "extension.ts",
                manager=manager,
                response_timeout=3,
            )
            stream = engine.prompt_events(PromptRequest(
                messages=[Message(role="user", content="hello")],
                conversation_id="conv-close",
            ))
            self.assertEqual(next(stream), {"type": "text_delta", "delta": "partial"})
            stream.close()
            self.assertFalse(manager.running)
            self.assertIsNone(engine._active_queue)
            self.assertIsNone(engine._active_conversation_id)
            self.assertFalse((root / "context.json").exists())
            self.assertTrue(engine._turn_lock.acquire(blocking=False))
            engine._turn_lock.release()

    def test_runtime_exit_fails_fast_as_runtime_unavailable(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manager = FakeRpcManager()

            def exit_on_prompt(_command, queue):
                manager.running = False
                queue.put({"type": "runtime_exited"})

            manager.on_prompt = exit_on_prompt
            engine = PiRpcEngine(
                bridge=ExternalToolBridge(),
                context_path=root / "context.json",
                extension_path=root / "extension.ts",
                manager=manager,
                response_timeout=3,
            )
            with self.assertRaises(RuntimeUnavailable):
                engine.prompt_sync(PromptRequest(
                    messages=[Message(role="user", content="hello")],
                    conversation_id="conv-exit",
                ))
            self.assertIsNone(engine._active_queue)

    def test_command_timeout_maps_to_runtime_unavailable_and_cleans_context(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            engine = PiRpcEngine(
                bridge=ExternalToolBridge(),
                context_path=root / "context.json",
                extension_path=root / "extension.ts",
                manager=TimeoutRpcManager(),
            )
            with self.assertRaises(RuntimeUnavailable):
                engine.prompt_sync(PromptRequest(
                    messages=[Message(role="user", content="hello")],
                    conversation_id="conv-timeout",
                ))
            self.assertFalse((root / "context.json").exists())
            self.assertIsNone(engine._active_queue)

    def test_sse_reports_unknown_usage_before_done(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manager = FakeRpcManager(
                on_prompt=lambda _command, queue: queue.put({"type": "agent_settled"})
            )
            engine = PiRpcEngine(
                bridge=ExternalToolBridge(),
                context_path=root / "context.json",
                extension_path=root / "extension.ts",
                manager=manager,
            )
            events = list(engine.prompt_events(PromptRequest(
                messages=[Message(role="user", content="hello")],
                conversation_id="conv-no-usage",
            )))
            self.assertEqual([event["type"] for event in events], ["usage", "done"])
            self.assertEqual(events[0]["usage"]["status"], "unknown")
            self.assertIsNone(events[0]["usage"]["cost"])

    def test_pending_tool_turn_is_aborted_when_result_never_arrives(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            bridge = ExternalToolBridge()

            def on_prompt(_command, _queue):
                threading.Thread(
                    target=lambda: execute_for_active_turn(
                        engine,
                        bridge,
                        ToolCall(id="call-timeout", name="search_assets", arguments={}),
                        timeout=3,
                    ),
                    daemon=True,
                ).start()

            manager = FakeRpcManager(on_prompt=on_prompt)
            engine = PiRpcEngine(
                bridge=bridge,
                context_path=root / "context.json",
                extension_path=root / "extension.ts",
                manager=manager,
                response_timeout=3,
                pending_turn_timeout=0.05,
            )
            first = engine.prompt_sync(PromptRequest(
                messages=[Message(role="user", content="search")],
                tools=[ToolDefinition(name="search_assets", description="search", input_schema={})],
                conversation_id="conv-tool-timeout",
            ))
            self.assertEqual(first.status, "requires_tool")
            deadline = time.monotonic() + 1
            while engine._active_queue is not None and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertIsNone(engine._active_queue)
            self.assertFalse(manager.running)
            self.assertFalse(bridge.has_pending())

            # The watchdog clears externally visible turn state before the
            # final process teardown; wait until its lifecycle lock is also
            # released before proving the next turn can acquire it.
            lock_acquired = engine._turn_lock.acquire(blocking=False)
            while not lock_acquired and time.monotonic() < deadline:
                time.sleep(0.01)
                lock_acquired = engine._turn_lock.acquire(blocking=False)
            self.assertTrue(lock_acquired)
            engine._turn_lock.release()

            manager.on_prompt = lambda _command, queue: queue.put({"type": "agent_settled"})
            next_turn = engine.prompt_sync(PromptRequest(
                messages=[Message(role="user", content="next")],
                conversation_id="conv-after-tool-timeout",
            ))
            self.assertEqual(next_turn.status, "completed")

    def test_late_tool_result_cannot_cancel_pending_turn_watchdog(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            bridge = ExternalToolBridge()

            def on_prompt(_command, _queue):
                threading.Thread(
                    target=lambda: execute_for_active_turn(
                        engine,
                        bridge,
                        ToolCall(id="call-expired", name="search_assets", arguments={}),
                        timeout=0.02,
                    ),
                    daemon=True,
                ).start()

            manager = FakeRpcManager(on_prompt=on_prompt)
            engine = PiRpcEngine(
                bridge=bridge,
                context_path=root / "context.json",
                extension_path=root / "extension.ts",
                manager=manager,
                response_timeout=3,
                pending_turn_timeout=0.08,
            )
            first = engine.prompt_sync(PromptRequest(
                messages=[Message(role="user", content="search")],
                tools=[ToolDefinition(name="search_assets", description="search", input_schema={})],
                conversation_id="conv-expired-result",
            ))
            self.assertEqual(first.status, "requires_tool")

            # The extension-side wait expires before the wrapper turn watchdog.
            # A late product result must be rejected atomically and must not
            # cancel the watchdog that owns cleanup of the still-active turn.
            deadline = time.monotonic() + 1
            while bridge.has_pending() and time.monotonic() < deadline:
                time.sleep(0.005)
            self.assertFalse(bridge.has_pending())
            with self.assertRaises(InvalidContinuation) as late:
                engine.prompt_sync(PromptRequest(
                    messages=[],
                    tool_results=[ToolResult(tool_call_id="call-expired", content={})],
                    conversation_id="conv-expired-result",
                ))
            self.assertEqual(late.exception.code, "unknown_tool_call")

            deadline = time.monotonic() + 1
            while engine._active_queue is not None and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertIsNone(engine._active_queue)
            self.assertFalse(manager.running)
