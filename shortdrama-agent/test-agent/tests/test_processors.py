import asyncio
import os
import unittest
from unittest.mock import Mock, patch

from google.adk.events.event import Event
from google.genai import types
from veadk.knowledgebase.entry import KnowledgebaseEntry

from short_drama_agent.processors import (
    AssetAwareRunProcessor,
    is_asset_generation_completion_query,
    is_asset_ingest_query,
    is_business_storyboard_ingestion_query,
    is_existing_work_asset_listing_query,
    is_external_action_query,
    is_script_breakdown_query,
)


class AssetAwareRunProcessorTest(unittest.TestCase):
    def setUp(self):
        os.environ.pop("AGENT_ENABLE_IMAGE_INPUT", None)

    def tearDown(self):
        os.environ.pop("AGENT_ENABLE_IMAGE_INPUT", None)

    def _run_processor(self, message):
        processor = AssetAwareRunProcessor(knowledgebase=Mock())

        async def event_generator():
            yield Event(
                author="agent",
                content=types.Content(
                    role="model",
                    parts=[types.Part(text="https://example.com/role.jpg")],
                ),
            )

        wrapped = processor.process_run(Mock(), message)(event_generator)
        return asyncio.run(self._collect(wrapped))

    async def _collect(self, wrapped):
        events = []
        async for event in wrapped():
            events.append(event)
        return events

    def test_image_urls_are_passed_as_text_by_default(self):
        message = types.Content(
            role="user",
            parts=[types.Part(text="叶逍遥有哪些相关照片？请返回图片URL")],
        )

        with patch(
            "short_drama_agent.processors.search_knowledge_entries",
            return_value=[
                KnowledgebaseEntry(
                    content="角色：叶逍遥",
                    metadata={"image_url": "https://example.com/role.jpg"},
                )
            ],
        ):
            events = self._run_processor(message)

        self.assertIsNotNone(message.parts)
        self.assertFalse(
            any(getattr(part, "file_data", None) for part in (message.parts or []))
        )
        injected_text = (message.parts or [])[1].text or ""
        event_text = events[0].content.parts[0].text or ""
        self.assertIn("![](https://example.com/role.jpg)", injected_text)
        self.assertIn("![](https://example.com/role.jpg)", event_text)

    def test_unrelated_asset_results_are_not_injected(self):
        message = types.Content(
            role="user",
            parts=[types.Part(text="春生照相馆悬疑开篇有哪些资产")],
        )

        with patch(
            "short_drama_agent.processors.search_knowledge_entries",
            return_value=[
                KnowledgebaseEntry(
                    content="角色：叶逍遥",
                    metadata={
                        "character_name": "叶逍遥",
                        "image_url": "https://example.com/yexiaoyao.jpg",
                    },
                )
            ],
        ):
            events = self._run_processor(message)

        self.assertEqual(len(message.parts or []), 1)
        event_text = events[0].content.parts[0].text or ""
        self.assertNotIn("![](https://example.com/yexiaoyao.jpg)", event_text)

    def test_asset_results_with_explicit_work_metadata_are_injected(self):
        message = types.Content(
            role="user",
            parts=[types.Part(text="春生照相馆悬疑开篇有哪些资产")],
        )

        with patch(
            "short_drama_agent.processors.search_knowledge_entries",
            return_value=[
                KnowledgebaseEntry(
                    content="场景：悬疑开篇",
                    metadata={
                        "work": "春生照相馆",
                        "tag": "悬疑开篇",
                        "image_url": "https://example.com/chunsheng.jpg",
                    },
                )
            ],
        ):
            self._run_processor(message)

        self.assertGreater(len(message.parts or []), 1)
        injected_text = (message.parts or [])[1].text or ""
        self.assertIn("![](https://example.com/chunsheng.jpg)", injected_text)

    def test_image_parts_can_be_enabled_for_vision_models(self):
        os.environ["AGENT_ENABLE_IMAGE_INPUT"] = "true"
        message = types.Content(
            role="user",
            parts=[types.Part(text="叶逍遥有哪些相关照片？请返回图片URL")],
        )

        with patch(
            "short_drama_agent.processors.search_knowledge_entries",
            return_value=[
                KnowledgebaseEntry(
                    content="角色：叶逍遥",
                    metadata={"image_url": "https://example.com/role.jpg"},
                )
            ],
        ):
            self._run_processor(message)

        self.assertTrue(
            any(getattr(part, "file_data", None) for part in (message.parts or []))
        )

    def test_asset_ingest_query_is_not_routed_to_external_mcp(self):
        query = (
            "调用知识库导入工具，将当前对话上传的小龙女剧照入库，"
            "文件名为刘亦菲版小龙女定妆照.jpg"
        )

        self.assertTrue(is_asset_ingest_query(query))
        self.assertFalse(is_external_action_query(query))

    def test_asset_generation_completion_query_uses_mcp_router(self):
        message = types.Content(
            role="user",
            parts=[
                types.Part(text="春生照相馆悬疑开篇剧本相关的资产完成图片生成")
            ],
        )

        self.assertTrue(
            is_asset_generation_completion_query(
                "春生照相馆悬疑开篇剧本相关的资产完成图片生成"
            )
        )

        with (
            patch.dict(
                os.environ,
                {"TOOL_MCP_ROUTER_URL": "https://mcp-router.example.com"},
            ),
            patch("short_drama_agent.processors.search_knowledge_entries") as search,
        ):
            self._run_processor(message)

        search.assert_not_called()
        injected_text = (message.parts or [])[1].text or ""
        self.assertIn("直接调用 `mcp_router`", injected_text)
        self.assertIn("不要调用 `execute_skills` 或 `script_breakdown`", injected_text)
        self.assertIn("不要反问用户提供完整剧本", injected_text)
        self.assertIn("先查询用户所指剧本/开篇/场景关联的资产清单", injected_text)
        self.assertIn("逐项检查每个关联资产的图片生成状态", injected_text)
        self.assertIn("发起图片生成", injected_text)

    def test_script_breakdown_query_prefers_execute_skills_context(self):
        message = types.Content(
            role="user",
            parts=[types.Part(text="请做剧本拆解并输出分镜 JSON")],
        )

        self.assertTrue(is_script_breakdown_query("请做剧本拆解并输出分镜 JSON"))

        with (
            patch(
                "short_drama_agent.processors.get_execute_skills_status",
                return_value={
                    "configured": True,
                    "loaded": True,
                    "tool_id": "skills-tool",
                    "tools": [{"name": "execute_skills"}],
                },
            ),
            patch("short_drama_agent.processors.search_knowledge_entries") as search,
        ):
            self._run_processor(message)

        search.assert_not_called()
        injected_text = (message.parts or [])[1].text or ""
        self.assertIn("优先直接调用 `execute_skills`", injected_text)
        self.assertIn("script-asset-breakdown", injected_text)
        self.assertIn("script_breakdown", injected_text)

    def test_business_storyboard_ingestion_uses_mcp_router(self):
        query = (
            "请将以下短剧剧本拆解为结构化剧本 JSON，并完成业务分镜入库。"
            "必须调用 ingestStoryboardDecomposition，最终包含 project_id 和 project_prompts。"
        )
        message = types.Content(role="user", parts=[types.Part(text=query)])

        self.assertTrue(is_script_breakdown_query(query))
        self.assertTrue(is_business_storyboard_ingestion_query(query))

        with (
            patch.dict(
                os.environ,
                {"TOOL_MCP_ROUTER_URL": "https://mcp-router.example.com"},
            ),
            patch(
                "short_drama_agent.processors.get_execute_skills_status",
                return_value={
                    "configured": True,
                    "loaded": True,
                    "tool_id": "skills-tool",
                    "tools": [{"name": "execute_skills"}],
                },
            ),
            patch("short_drama_agent.processors.search_knowledge_entries") as search,
        ):
            self._run_processor(message)

        search.assert_not_called()
        injected_text = (message.parts or [])[1].text or ""
        self.assertIn("不要调用 `execute_skills`", injected_text)
        self.assertIn("直接使用当前 agent 已挂载的 MCP Router", injected_text)
        self.assertIn("ingestStoryboardDecomposition", injected_text)
        self.assertIn("project_prompts", injected_text)

    def test_existing_work_asset_listing_prefers_knowledgebase_context(self):
        query = "春生照相馆，剧本内的角色、道具有哪些，分镜给我"
        message = types.Content(role="user", parts=[types.Part(text=query)])

        self.assertTrue(is_existing_work_asset_listing_query(query))

        with (
            patch(
                "short_drama_agent.processors.search_knowledge_entries",
                return_value=[
                    KnowledgebaseEntry(
                        content="《春生照相馆》角色：春生；道具：老式相机；分镜：春生擦拭相机。",
                        metadata={"title": "春生照相馆"},
                    )
                ],
            ) as search,
            patch(
                "short_drama_agent.processors.get_execute_skills_status",
                return_value={
                    "configured": True,
                    "loaded": True,
                    "tool_id": "skills-tool",
                    "tools": [{"name": "execute_skills"}],
                },
            ),
        ):
            self._run_processor(message)

        search.assert_called_once()
        injected_text = "\n".join(
            part.text or ""
            for part in (message.parts or [])
            if isinstance(getattr(part, "text", None), str)
        )
        self.assertIn("已有作品/剧本资料", injected_text)
        self.assertIn("不要调用 `execute_skills` 或 `script_breakdown`", injected_text)
        self.assertIn("春生照相馆", injected_text)

    def test_asset_ingest_processor_prefers_execute_skills_context(self):
        message = types.Content(
            role="user",
            parts=[
                types.Part(
                    text=(
                        "重新发起导入请求，将附件图片入知识库，"
                        "文件名为刘亦菲版小龙女定妆照.jpg"
                    )
                )
            ],
        )

        with (
            patch(
                "short_drama_agent.processors.get_execute_skills_status",
                return_value={
                    "configured": True,
                    "loaded": True,
                    "tool_id": "skills-tool",
                    "tools": [{"name": "execute_skills"}],
                },
            ),
            patch("short_drama_agent.processors.search_knowledge_entries") as search,
        ):
            self._run_processor(message)

        search.assert_not_called()
        injected_text = (message.parts or [])[1].text or ""
        self.assertIn("`execute_skills`", injected_text)
        self.assertIn("知识入库 skill 编排", injected_text)

    def test_asset_ingest_context_prefers_attachment_display_name(self):
        message = types.Content(
            role="user",
            parts=[
                types.Part(text="请把这张附件图片入知识库"),
                types.Part(
                    inline_data=types.Blob(
                        mime_type="image/jpeg",
                        data=b"jpg-bytes",
                        display_name="刘亦菲版小龙女定妆照.jpg",
                    )
                ),
            ],
        )

        with (
            patch(
                "short_drama_agent.processors.get_execute_skills_status",
                return_value={
                    "configured": True,
                    "loaded": True,
                    "tool_id": "skills-tool",
                    "tools": [{"name": "execute_skills"}],
                },
            ),
            patch("short_drama_agent.processors.search_knowledge_entries") as search,
        ):
            self._run_processor(message)

        search.assert_not_called()
        injected_text = (message.parts or [])[1].text or ""
        self.assertIn("刘亦菲版小龙女定妆照.jpg", injected_text)
        self.assertIn("mime_type=image/jpeg", injected_text)

    def test_asset_ingest_context_appends_extension_for_artifact_name_from_mime(self):
        message = types.Content(
            role="user",
            parts=[
                types.Part(text="把这个附件入知识库"),
                types.Part(
                    fileData=types.FileData(
                        file_uri="artifact_e-dd8f2709-2b5c-4922-b867-27215d9d8ebf_1",
                        mime_type="image/jpeg",
                    )
                ),
            ],
        )

        with (
            patch(
                "short_drama_agent.processors.get_execute_skills_status",
                return_value={
                    "configured": True,
                    "loaded": True,
                    "tool_id": "skills-tool",
                    "tools": [{"name": "execute_skills"}],
                },
            ),
            patch("short_drama_agent.processors.search_knowledge_entries") as search,
        ):
            self._run_processor(message)

        search.assert_not_called()
        injected_text = (message.parts or [])[1].text or ""
        self.assertIn(
            "artifact_e-dd8f2709-2b5c-4922-b867-27215d9d8ebf_1.jpg",
            injected_text,
        )
        self.assertNotIn(
            "artifact_e-dd8f2709-2b5c-4922-b867-27215d9d8ebf_1`",
            injected_text,
        )
        file_data = getattr((message.parts or [])[2], "file_data", None) or getattr(
            (message.parts or [])[2], "fileData", None
        )
        self.assertEqual(
            file_data.file_uri,
            "artifact_e-dd8f2709-2b5c-4922-b867-27215d9d8ebf_1.jpg",
        )

    def test_asset_ingest_context_infers_extension_from_octet_stream_bytes(self):
        message = types.Content(
            role="user",
            parts=[
                types.Part(text="把这个无后缀附件入知识库"),
                types.Part(
                    inline_data=types.Blob(
                        mime_type="application/octet-stream",
                        data=b"\xff\xd8\xff\xe0jpg-bytes",
                        display_name="artifact_upload_1",
                    )
                ),
            ],
        )

        with (
            patch(
                "short_drama_agent.processors.get_execute_skills_status",
                return_value={
                    "configured": True,
                    "loaded": True,
                    "tool_id": "skills-tool",
                    "tools": [{"name": "execute_skills"}],
                },
            ),
            patch("short_drama_agent.processors.search_knowledge_entries") as search,
        ):
            self._run_processor(message)

        search.assert_not_called()
        injected_text = (message.parts or [])[1].text or ""
        self.assertIn("artifact_upload_1.jpg", injected_text)
        self.assertIn("upload_file_name=`artifact_upload_1.jpg`", injected_text)
        self.assertEqual(
            (message.parts or [])[2].inline_data.display_name,
            "artifact_upload_1.jpg",
        )


if __name__ == "__main__":
    unittest.main()
