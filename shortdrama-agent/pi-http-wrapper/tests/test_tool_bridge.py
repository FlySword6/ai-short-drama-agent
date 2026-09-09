import threading
import unittest

from pi_http_wrapper.contract import ToolCall, ToolResult
from pi_http_wrapper.tool_bridge import ExternalToolBridge, StaleToolCallback


class ToolBridgeTests(unittest.TestCase):
    def test_deferred_external_result_unblocks_exact_call(self):
        bridge = ExternalToolBridge()
        bridge.begin_turn(turn_nonce="turn-1", conversation_id="conv-1")
        outcome = {}

        def execute():
            outcome["result"] = bridge.execute(
                ToolCall(id="call-1", name="search_assets", arguments={"q": "rain"}),
                turn_nonce="turn-1",
                conversation_id="conv-1",
                timeout=2,
            )

        thread = threading.Thread(target=execute)
        thread.start()
        while not bridge.has_pending():
            thread.join(0.01)
        pending = bridge.take_unreported()
        self.assertEqual([call.id for call in pending], ["call-1"])
        self.assertEqual(bridge.resolve([ToolResult(tool_call_id="call-1", content={"ref_id": "a1"})]), [])
        thread.join(1)
        self.assertEqual(outcome["result"].content, {"ref_id": "a1"})

    def test_stale_callback_interleaved_with_new_turn_is_rejected(self):
        bridge = ExternalToolBridge()
        bridge.begin_turn(turn_nonce="old-nonce", conversation_id="conv-old")
        self.assertTrue(bridge.end_turn(turn_nonce="old-nonce", code="turn_stopped"))
        bridge.begin_turn(turn_nonce="new-nonce", conversation_id="conv-new")

        with self.assertRaises(StaleToolCallback):
            bridge.execute(
                ToolCall(id="call-old", name="create_asset", arguments={"stale": True}),
                turn_nonce="old-nonce",
                conversation_id="conv-old",
                timeout=0.01,
            )
        self.assertEqual(bridge.take_unreported(), [])

        outcome = {}

        def execute_new():
            outcome["result"] = bridge.execute(
                ToolCall(id="call-new", name="search_assets", arguments={}),
                turn_nonce="new-nonce",
                conversation_id="conv-new",
                timeout=1,
            )

        thread = threading.Thread(target=execute_new)
        thread.start()
        while not bridge.has_pending():
            thread.join(0.01)
        self.assertEqual([call.id for call in bridge.take_unreported()], ["call-new"])
        bridge.resolve([ToolResult(tool_call_id="call-new", content={"ok": True})])
        thread.join(1)
        self.assertEqual(outcome["result"].content, {"ok": True})
