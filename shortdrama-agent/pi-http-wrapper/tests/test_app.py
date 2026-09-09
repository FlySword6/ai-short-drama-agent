import os
import tempfile
import unittest
from pathlib import Path

try:
    from fastapi.testclient import TestClient
except ModuleNotFoundError:  # pragma: no cover - standard-library contract tests still run without package install
    TestClient = None

from pi_http_wrapper.app import create_app
from pi_http_wrapper.config import Settings
from pi_http_wrapper.contract import PromptResponse
from pi_http_wrapper.engine import AwaitingSourceEngine, InvalidContinuation
from pi_http_wrapper.main_chain import MainChainAdapter
from pi_http_wrapper.tool_bridge import ExternalToolBridge


class FakeCompletedEngine:
    last_request = None

    def prompt_sync(self, request):
        self.last_request = request
        return PromptResponse(status="completed", text="ok", conversation_id=request.conversation_id)

    def prompt_events(self, request):
        self.last_request = request
        yield {"type": "text_delta", "delta": "ok"}
        yield {"type": "done", "status": "completed", "conversationId": request.conversation_id}


class FakeMismatchEngine:
    def prompt_sync(self, request):
        raise InvalidContinuation("conversationId does not match", code="conversation_mismatch")

    def prompt_events(self, request):
        raise InvalidContinuation("unknown toolCallId", code="unknown_tool_call")
        yield


class FakeMainClient:
    def __init__(self):
        self.calls = []

    def request(self, method, path, body=None):
        self.calls.append((method, path, body))
        return {"permissions": ["projects:read"], "projects": []}

    def upload(self, path, filename, content, content_type, fields):
        raise AssertionError("upload was not expected")


@unittest.skipIf(TestClient is None, "fastapi is not installed")
class AppTests(unittest.TestCase):
    def settings(self, root: Path) -> Settings:
        return Settings(
            bearer_tokens=("test-token",),
            internal_token="internal-test-token",
            audit_log_path=root / "audit.jsonl",
            skill_roots=(root / "agents", root / "workbuddy"),
            skill_state_path=root / "skills.json",
        )

    def test_awaiting_source_is_explicit_and_authenticated(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            settings = self.settings(root)
            client = TestClient(create_app(settings=settings, engine=AwaitingSourceEngine()))
            unauthenticated = client.post("/pi/prompt/sync", json={"messages": []})
            self.assertEqual(unauthenticated.status_code, 401)
            response = client.post(
                "/pi/prompt/sync",
                headers={"Authorization": "Bearer test-token"},
                json={
                    "system": "test",
                    "messages": [{"role": "user", "content": "hello"}],
                    "tools": [{"name": "search_assets", "inputSchema": {}}],
                    "toolResults": [{"toolCallId": "call-1", "content": {"ref_id": "a1"}}],
                },
            )
            self.assertEqual(response.status_code, 503)
            self.assertEqual(response.json()["detail"]["code"], "runtime_unavailable")
            self.assertIn("tool_result_count", root.joinpath("audit.jsonl").read_text(encoding="utf-8"))

    def test_sync_generates_conversation_id_and_returns_status(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            client = TestClient(create_app(settings=self.settings(root), engine=FakeCompletedEngine()))
            response = client.post(
                "/pi/prompt/sync",
                headers={"Authorization": "Bearer test-token"},
                json={"message": "hello"},
            )
            self.assertEqual(response.status_code, 200)
            body = response.json()
            self.assertEqual(body["status"], "completed")
            self.assertTrue(body["conversationId"])
            self.assertEqual(body["usage"]["status"], "unknown")
            self.assertIsNone(body["usage"]["cost"])

    def test_sync_and_sse_preserve_specific_409_error_codes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            client = TestClient(create_app(settings=self.settings(root), engine=FakeMismatchEngine()))
            sync = client.post(
                "/pi/prompt/sync",
                headers={"Authorization": "Bearer test-token"},
                json={
                    "conversationId": "wrong",
                    "toolResults": [{"toolCallId": "call-1", "content": {}}],
                },
            )
            self.assertEqual(sync.status_code, 409)
            self.assertEqual(sync.json()["detail"]["code"], "conversation_mismatch")

            with client.stream(
                "POST",
                "/pi/prompt",
                headers={"Authorization": "Bearer test-token"},
                json={
                    "conversationId": "conv-1",
                    "toolResults": [{"toolCallId": "unknown", "content": {}}],
                },
            ) as stream:
                payload = "\n".join(stream.iter_lines())
            self.assertIn("event: meta", payload)
            self.assertIn("event: error", payload)
            self.assertIn('"code": "unknown_tool_call"', payload)

    def test_sse_only_emits_stable_event_names(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            client = TestClient(create_app(settings=self.settings(root), engine=FakeCompletedEngine()))
            with client.stream(
                "POST",
                "/pi/prompt",
                headers={"Authorization": "Bearer test-token"},
                json={"message": "hello"},
            ) as stream:
                payload = "\n".join(stream.iter_lines())
            self.assertIn("event: meta", payload)
            self.assertIn("event: text_delta", payload)
            self.assertIn("event: done", payload)
            self.assertNotIn("agent_start", payload)
            self.assertNotIn("message_update", payload)

    def test_internal_tool_callback_rejects_stale_turn_nonce(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            bridge = ExternalToolBridge()
            bridge.begin_turn(turn_nonce="new-nonce", conversation_id="conv-new")
            client = TestClient(create_app(
                settings=self.settings(root),
                engine=FakeCompletedEngine(),
                bridge=bridge,
            ))
            response = client.post(
                "/internal/tool-calls",
                headers={"Authorization": "Bearer internal-test-token"},
                json={
                    "toolCallId": "call-old",
                    "name": "create_asset",
                    "arguments": {"stale": True},
                    "turnNonce": "old-nonce",
                    "conversationId": "conv-old",
                },
            )
            self.assertEqual(response.status_code, 409)
            self.assertEqual(response.json()["detail"]["code"], "stale_tool_callback")
            self.assertEqual(bridge.take_unreported(), [])

    def test_main_chain_tools_are_server_owned_and_execute_without_external_round_trip(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            bridge = ExternalToolBridge()
            engine = FakeCompletedEngine()
            api = FakeMainClient()
            adapter = MainChainAdapter(api)
            client = TestClient(create_app(
                settings=self.settings(root),
                engine=engine,
                bridge=bridge,
                main_chain=adapter,
            ))
            prompt = client.post(
                "/pi/prompt/sync",
                headers={"Authorization": "Bearer test-token"},
                json={
                    "message": "列出项目",
                    "tools": [{
                        "name": "shortdrama_capabilities",
                        "description": "caller must not replace this",
                        "inputSchema": {"type": "string"},
                    }],
                },
            )
            self.assertEqual(prompt.status_code, 200)
            owned = {
                item.name: item
                for item in engine.last_request.tools
                if item.name == "shortdrama_capabilities"
            }
            self.assertEqual(len(owned), 1)
            self.assertEqual(owned["shortdrama_capabilities"].input_schema["type"], "object")

            bridge.begin_turn(turn_nonce="main-turn", conversation_id="main-conversation")
            result = client.post(
                "/internal/tool-calls",
                headers={"Authorization": "Bearer internal-test-token"},
                json={
                    "toolCallId": "call-main-1",
                    "name": "shortdrama_capabilities",
                    "arguments": {},
                    "turnNonce": "main-turn",
                    "conversationId": "main-conversation",
                },
            )
            self.assertEqual(result.status_code, 200)
            self.assertFalse(result.json()["isError"])
            self.assertTrue(result.json()["content"]["receipt"]["permissions_checked"])
            self.assertEqual(bridge.pending_ids(), set())
            self.assertEqual(api.calls, [("GET", "/me/capabilities", None)])

    def test_stale_main_chain_callback_is_rejected_before_api_call(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            bridge = ExternalToolBridge()
            bridge.begin_turn(turn_nonce="new-nonce", conversation_id="conv-new")
            api = FakeMainClient()
            client = TestClient(create_app(
                settings=self.settings(root),
                engine=FakeCompletedEngine(),
                bridge=bridge,
                main_chain=MainChainAdapter(api),
            ))
            result = client.post(
                "/internal/tool-calls",
                headers={"Authorization": "Bearer internal-test-token"},
                json={
                    "toolCallId": "call-old",
                    "name": "shortdrama_capabilities",
                    "arguments": {},
                    "turnNonce": "old-nonce",
                    "conversationId": "conv-old",
                },
            )
            self.assertEqual(result.status_code, 409)
            self.assertEqual(result.json()["detail"]["code"], "stale_tool_callback")
            self.assertEqual(api.calls, [])
