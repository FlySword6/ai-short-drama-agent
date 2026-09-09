from types import SimpleNamespace
import unittest
from unittest.mock import patch

from short_drama_agent.runtime_patches import (
    patch_mcp_artifact_upload_filename_repair,
    patch_mcp_nullable_output_schema_validation,
)
from google.adk.tools.base_tool import BaseTool
from google.adk.tools.base_toolset import BaseToolset
from google.genai import types

from short_drama_agent.mcp_safety import make_asset_ingest_safe_mcp_toolset


class FakeMcpTool(BaseTool):
    def __init__(self, name: str):
        super().__init__(name=name, description="fake MCP tool")
        self.received_args = None

    async def run_async(self, *, args, tool_context):
        self.received_args = args
        return {"args": args}


class FakeMcpToolset(BaseToolset):
    name = "mcp_router"

    def __init__(self, tools):
        super().__init__()
        self._tools = tools

    async def get_tools(self, readonly_context=None):
        return self._tools


class FakeToolContext:
    async def load_artifact(self, filename):
        return types.Part(
            inline_data=types.Blob(
                mime_type="image/jpeg",
                data=b"jpg-bytes",
            )
        )


class McpSafetyTest(unittest.IsolatedAsyncioTestCase):
    async def test_upload_credential_tool_rewrites_generated_artifact_filename(self):
        tool = FakeMcpTool("viking-ingest-mcp_create_tos_upload_credential")
        safe_toolset = make_asset_ingest_safe_mcp_toolset(FakeMcpToolset([tool]))
        safe_tool = (await safe_toolset.get_tools())[0]

        result = await safe_tool.run_async(
            args={"file_name": "artifact_e-8d22fabc-3ff4-4d85-a761-3dcbf36ae8d2_1"},
            tool_context=FakeToolContext(),
        )

        self.assertEqual(
            result["args"]["file_name"],
            "artifact_e-8d22fabc-3ff4-4d85-a761-3dcbf36ae8d2_1.jpg",
        )
        self.assertEqual(tool.received_args, result["args"])

    async def test_non_upload_tools_only_rewrite_filename_like_args(self):
        tool = FakeMcpTool("viking-ingest-mcp_other_tool")
        safe_toolset = make_asset_ingest_safe_mcp_toolset(FakeMcpToolset([tool]))
        safe_tool = (await safe_toolset.get_tools())[0]

        result = await safe_tool.run_async(
            args={
                "file_name": "artifact_e-123_1",
                "artifact_name": "artifact_e-123_1",
            },
            tool_context=FakeToolContext(),
        )

        self.assertEqual(result["args"]["file_name"], "artifact_e-123_1.jpg")
        self.assertEqual(result["args"]["artifact_name"], "artifact_e-123_1")

    async def test_upload_credential_tool_infers_suffix_from_octet_stream_bytes(self):
        class OctetStreamToolContext:
            async def load_artifact(self, filename):
                return types.Part(
                    inline_data=types.Blob(
                        mime_type="application/octet-stream",
                        data=b"\xff\xd8\xff\xe0jpg-bytes",
                    )
                )

        tool = FakeMcpTool("viking-ingest-mcp_create_tos_upload_credential")
        safe_toolset = make_asset_ingest_safe_mcp_toolset(FakeMcpToolset([tool]))
        safe_tool = (await safe_toolset.get_tools())[0]

        result = await safe_tool.run_async(
            args={"file_name": "artifact_e-web-upload_1"},
            tool_context=OctetStreamToolContext(),
        )

        self.assertEqual(result["args"]["file_name"], "artifact_e-web-upload_1.jpg")

    async def test_global_mcp_tool_patch_rewrites_raw_mcp_tool_args(self):
        from google.adk.tools.mcp_tool.mcp_tool import McpTool

        patch_mcp_artifact_upload_filename_repair()
        original_run_async = McpTool.run_async
        captured = {}

        async def fake_original_run_async(self, *, args, tool_context):
            captured["args"] = args
            return {"args": args}

        McpTool.run_async = fake_original_run_async
        McpTool._agentkit_demo_artifact_filename_repair_patched = False
        try:
            patch_mcp_artifact_upload_filename_repair()
            raw_tool = object.__new__(McpTool)
            raw_tool.name = "viking-ingest-mcp_create_tos_upload_credential"

            result = await McpTool.run_async(
                raw_tool,
                args={"file_name": "artifact_e-web-upload_1"},
                tool_context=FakeToolContext(),
            )
        finally:
            McpTool.run_async = original_run_async
            McpTool._agentkit_demo_artifact_filename_repair_patched = True

        self.assertEqual(result["args"]["file_name"], "artifact_e-web-upload_1.jpg")
        self.assertEqual(captured["args"]["file_name"], "artifact_e-web-upload_1.jpg")

    async def test_ingest_tool_adds_viking_target_args(self):
        tool = FakeMcpTool("viking-ingest-mcp_ingest_to_agentkit_kb")
        safe_toolset = make_asset_ingest_safe_mcp_toolset(FakeMcpToolset([tool]))
        safe_tool = (await safe_toolset.get_tools())[0]

        with patch.dict(
            "os.environ",
            {
                "DATABASE_VIKING_PROJECT": "shortdrama",
                "DATABASE_VIKING_COLLECTION": "role",
                "AGENTKIT_KB_ID": "kb_real_001",
            },
            clear=False,
        ):
            result = await safe_tool.run_async(
                args={
                    "file_name": "artifact_e-web-upload_1.xlsx",
                    "tos_path": "drama-asset/viking-ingest/demo.xlsx",
                },
                tool_context=FakeToolContext(),
            )

        self.assertEqual(result["args"]["project"], "shortdrama")
        self.assertEqual(result["args"]["collection_name"], "role")
        self.assertEqual(result["args"]["kb_id"], "kb_real_001")
        self.assertEqual(result["args"]["resourceID"], "kb_real_001")

    async def test_mcp_nullable_output_schema_allows_null_structured_content_fields(
        self,
    ):
        from mcp.client.session import ClientSession

        patch_mcp_nullable_output_schema_validation()
        fake_session = SimpleNamespace(
            _tool_output_schemas={
                "短剧资产智能体接口_semanticSearch": {
                    "type": "object",
                    "properties": {
                        "_body": {
                            "type": "object",
                            "properties": {
                                "items": {
                                    "type": "array",
                                    "items": {
                                        "type": "object",
                                        "properties": {
                                            "visual_prompt": {
                                                "type": "string",
                                                "nullable": True,
                                            }
                                        },
                                    },
                                }
                            },
                        }
                    },
                }
            },
            list_tools=None,
        )
        result = SimpleNamespace(
            structuredContent={
                "_body": {"items": [{"visual_prompt": None}]}
            }
        )

        await ClientSession._validate_tool_result(
            fake_session, "短剧资产智能体接口_semanticSearch", result
        )

    async def test_mcp_nullable_output_schema_still_rejects_invalid_non_nullable_value(
        self,
    ):
        from mcp.client.session import ClientSession

        patch_mcp_nullable_output_schema_validation()
        fake_session = SimpleNamespace(
            _tool_output_schemas={
                "semanticSearch": {
                    "type": "object",
                    "properties": {"title": {"type": "string"}},
                }
            },
            list_tools=None,
        )
        result = SimpleNamespace(structuredContent={"title": None})

        with self.assertRaisesRegex(RuntimeError, "Invalid structured content"):
            await ClientSession._validate_tool_result(
                fake_session, "semanticSearch", result
            )


if __name__ == "__main__":
    unittest.main()
