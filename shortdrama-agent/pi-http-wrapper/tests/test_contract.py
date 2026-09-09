import unittest

from pi_http_wrapper.auth import authenticate_bearer, token_fingerprint
from pi_http_wrapper.contract import Message, PromptRequest, PromptResponse, ToolDefinition, ToolResult


class ContractTests(unittest.TestCase):
    def test_sync_contract_transmits_system_tools_and_tool_results(self) -> None:
        request = PromptRequest(
            system="You are the shortdrama runtime.",
            messages=[Message(role="user", content="find rainy alley")],
            tools=[ToolDefinition(name="search_assets", description="Search assets", input_schema={"type": "object"})],
            tool_results=[ToolResult(tool_call_id="call-1", content={"ref_id": "asset-1"})],
            conversation_id="conv-1",
        )
        self.assertEqual(request.to_engine_payload(), {
            "system": "You are the shortdrama runtime.",
            "messages": [{"role": "user", "content": "find rainy alley"}],
            "tools": [{"name": "search_assets", "description": "Search assets", "inputSchema": {"type": "object"}}],
            "toolResults": [{"toolCallId": "call-1", "content": {"ref_id": "asset-1"}, "isError": False}],
            "conversationId": "conv-1",
        })

    def test_multiple_bearer_tokens_are_constant_time_matched(self) -> None:
        tokens = ("token-a", "token-b")
        self.assertEqual(authenticate_bearer("Bearer token-b", tokens), token_fingerprint("token-b"))
        self.assertIsNone(authenticate_bearer("Bearer wrong", tokens))
        self.assertIsNone(authenticate_bearer(None, tokens))

    def test_unknown_usage_is_explicit_and_never_reported_as_zero(self) -> None:
        wire = PromptResponse(status="completed", text="ok").to_wire()
        self.assertEqual(wire["usage"]["status"], "unknown")
        self.assertIsNone(wire["usage"]["inputTokens"])
        self.assertIsNone(wire["usage"]["cost"])
        self.assertFalse(wire["usage"]["costKnown"])
