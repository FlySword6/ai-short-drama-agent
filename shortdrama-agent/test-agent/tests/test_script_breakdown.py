import asyncio
import json
import os
import tempfile
import unittest
from unittest.mock import Mock, patch

from a2a.server.apps.jsonrpc.fastapi_app import A2AFastAPIApplication
from a2a.server.request_handlers.default_request_handler import DefaultRequestHandler
from a2a.server.tasks.inmemory_task_store import InMemoryTaskStore
from a2a.types import (
    Message,
    MessageSendParams,
    Part,
    Role,
    SendMessageRequest,
    TextPart,
)
from google.adk.a2a.executor import a2a_agent_executor
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.adk.tools.agent_tool import AgentTool
from google.genai import types
from starlette.testclient import TestClient
from veadk import Agent
from veadk.a2a.agent_card import get_agent_card
from veadk.runner import Runner

from short_drama_agent.knowledge_assets import ASSET_INGEST_ROUTING_INSTRUCTION
from short_drama_agent.runtime_patches import (
    _merge_agent_output_text_parts,
    _safe_validate_agent_tool_output,
    downgrade_json_schema_response_format,
    patch_adk_save_input_blobs_as_artifacts_default,
    patch_adk_trace_safe_serialization,
    patch_litellm_json_schema_response_format,
    patch_sqlite_session_stale_retry,
)
from short_drama_agent.script_breakdown import (
    SCRIPT_BREAKDOWN_ROUTING_INSTRUCTION,
    SCRIPT_BREAKDOWN_SKILL_NAME,
    ScriptBreakdownResult,
    _convert_skill_result_to_legacy_result,
    _extract_json_text,
    create_script_breakdown_subagent,
    create_script_breakdown_tool,
    execute_script_breakdown_skill,
)

BREAKDOWN_RESULT = {
    "characters": [
        {
            "name": "林夏",
            "identity": "高三美术艺考生",
            "personality": "敏感倔强，面对压力仍坚持创作",
            "relationship": "与周屿是互相支撑的同桌",
            "visual_notes": "校服外套沾有颜料，常背画板",
        }
    ],
    "scenes": [
        {
            "name": "画室夜训",
            "time_and_place": "夜晚，学校旧画室",
            "atmosphere": "安静压抑但有微弱希望",
            "story_function": "呈现艺考梦想与高考压力的冲突",
            "asset_notes": "石膏像、画架、冷白顶灯、堆叠试卷",
        }
    ],
    "props": [
        {
            "name": "折角艺考准考证",
            "purpose": "象征林夏对梦想的坚持",
            "appears_in": "画室夜训与考前争吵",
            "visual_notes": "边角磨损，夹在速写本中",
        }
    ],
    "storyboards": [
        {
            "id": "scene_1-1",
            "title": "1-1-1 画室夜训·独自修改素描",
            "description": "林夏在学校旧画室独自修改素描，窗外教学楼灯光逐排熄灭，冷白顶灯照在画架和石膏像上，校服外套沾有颜料，画面安静压抑但保留微弱希望。",
            "style": "cinematic",
            "camera": "中景缓慢推近",
            "movement": "push-in",
            "characters": "林夏(校服外套沾有颜料,背画板)",
            "dialogue": "林夏低声说：我再画一张。",
            "duration": 6,
            "aspectRatio": "16-9",
            "negativePrompt": "模糊,低质量,变形,多余手指,文字,水印",
        }
    ],
}


BREAKDOWN_SKILL_RESULT = {
    "mode": "script_breakdown",
    "characters": BREAKDOWN_RESULT["characters"],
    "scenes": BREAKDOWN_RESULT["scenes"],
    "props": BREAKDOWN_RESULT["props"],
    "storyboards": [
        {
            "shot_no": 1,
            "shot_type": "中景",
            "duration_sec": 6,
            "narration": "林夏在旧画室里独自改画，抬眼看向逐渐熄灯的教学楼，手指沾着炭粉，神情倔强又疲惫。",
            "dialogue": "林夏低声说：我再画一张。",
            "character_names": ["林夏"],
            "scene_names": ["画室夜训"],
            "prop_names": ["折角艺考准考证"],
            "scene_continuity_key": "SCENE_01",
            "scene_anchor": "学校旧画室夜晚冷白顶灯，画架石膏像与堆叠试卷保持不变，窗外教学楼逐排熄灯。",
            "video_prompt": "[@林夏]站在[@画室夜训]里伏在画架前继续修改素描，手指沾着炭粉，抬眼望向窗外逐排熄灭的教学楼灯光后又低头落笔，轻声说‘我再画一张。’中景缓慢推近，冷白顶灯压住石膏像和堆叠试卷的静物层次，节奏缓慢压抑，突出她倔强坚持的情绪，并带出[@折角艺考准考证]夹在速写本中的细节。",
        }
    ],
}


FINAL_TEXT = (
    "角色：林夏\n"
    "场景：画室夜训\n"
    "道具：折角艺考准考证\n"
    "分镜：scene_1-1｜1-1-1 画室夜训·独自修改素描\n"
    "如需入库或生成资产文件，可继续说明保存目标或格式。"
)


class BreakdownFakeLlm(BaseLlm):
    model: str = "fake-breakdown-model"

    async def generate_content_async(self, llm_request, stream=False):
        yield _text_response(BREAKDOWN_RESULT)


class MainDispatchFakeLlm(BaseLlm):
    model: str = "fake-main-model"

    async def generate_content_async(self, llm_request, stream=False):
        has_breakdown_response = any(
            part.function_response and part.function_response.name == "script_breakdown"
            for content in llm_request.contents
            for part in (content.parts or [])
        )
        if not has_breakdown_response:
            yield LlmResponse(
                content=types.Content(
                    role="model",
                    parts=[
                        types.Part(
                            function_call=types.FunctionCall(
                                id="call-breakdown",
                                name="script_breakdown",
                                args={
                                    "request": (
                                        "拆解校园青春剧本，生成角色、场景、道具、分镜"
                                    )
                                },
                            )
                        )
                    ],
                )
            )
            return

        yield LlmResponse(
            content=types.Content(
                role="model",
                parts=[types.Part(text=FINAL_TEXT)],
            )
        )


def _text_response(payload: dict) -> LlmResponse:
    return LlmResponse(
        content=types.Content(
            role="model",
            parts=[types.Part(text=json.dumps(payload, ensure_ascii=False))],
        )
    )


def _test_agent(**kwargs) -> Agent:
    return Agent(
        model_api_key="test-key",
        model_name="fake-breakdown-model",
        **kwargs,
    )


def _build_breakdown_root_agent() -> Agent:
    return _test_agent(
        name="script_main_scheduler",
        description="调度剧本拆解 sub-agent",
        model=MainDispatchFakeLlm(),
        instruction=(
            "遇到剧本拆解、生成角色、场景、道具、分镜请求时，调用 script_breakdown。"
        ),
        tools=[
            create_script_breakdown_tool(
                model=BreakdownFakeLlm(),
                model_api_key="test-key",
                model_name="fake-breakdown-model",
            )
        ],
    )


def _build_breakdown_a2a_app():
    root_agent = _build_breakdown_root_agent()
    executor_config_cls = getattr(a2a_agent_executor, "A2aAgentExecutorConfig")
    agent_executor = a2a_agent_executor.A2aAgentExecutor(
        runner=Runner(agent=root_agent, app_name="script_breakdown_a2a_test"),
        config=executor_config_cls(),
    )
    return A2AFastAPIApplication(
        agent_card=get_agent_card(root_agent, "http://testserver"),
        http_handler=DefaultRequestHandler(
            agent_executor=agent_executor,
            task_store=InMemoryTaskStore(),
        ),
    ).build()


class ScriptBreakdownTest(unittest.TestCase):
    def test_schema_validates_characters_scenes_props_storyboards(self):
        result = ScriptBreakdownResult.model_validate(BREAKDOWN_RESULT)

        self.assertEqual(result.characters[0].name, "林夏")
        self.assertEqual(result.scenes[0].name, "画室夜训")
        self.assertEqual(result.props[0].name, "折角艺考准考证")
        self.assertEqual(result.storyboards[0].id, "scene_1-1")
        self.assertEqual(result.storyboards[0].aspectRatio, "16-9")
        self.assertIn("模糊", result.storyboards[0].negativePrompt)

    def test_script_breakdown_subagent_mounts_remote_and_local_skill_tools(self):
        subagent = create_script_breakdown_subagent(
            model=BreakdownFakeLlm(),
            model_api_key="test-key",
            model_name="fake-breakdown-model",
        )

        tool_names = [getattr(tool, "name", "") for tool in subagent.tools]

        self.assertIn("execute_script_breakdown_skill", tool_names)
        self.assertIn("skills_tool", tool_names)
        self.assertIn("read_file_tool", tool_names)
        self.assertIn(SCRIPT_BREAKDOWN_SKILL_NAME, subagent.instruction)
        self.assertIn("execute_skills", subagent.instruction)

    def test_execute_script_breakdown_skill_converts_remote_skill_output(self):
        async def fake_execute_skills(workflow_prompt, tool_context=None):
            self.assertIn(SCRIPT_BREAKDOWN_SKILL_NAME, workflow_prompt)
            self.assertIn("script_breakdown", workflow_prompt)
            return (
                "```json\n"
                + json.dumps(BREAKDOWN_SKILL_RESULT, ensure_ascii=False)
                + "\n```"
            )

        with (
            patch.dict(os.environ, {"AGENTKIT_TOOL_ID": "tool-123"}, clear=False),
            patch(
                "short_drama_agent.script_breakdown.execute_skills",
                side_effect=fake_execute_skills,
            ),
        ):
            result = asyncio.run(execute_script_breakdown_skill("拆解这个校园青春剧本"))

        self.assertEqual(result["characters"][0]["name"], "林夏")
        self.assertEqual(result["storyboards"][0]["id"], "scene_01-1")
        self.assertEqual(result["storyboards"][0]["camera"], "medium")
        self.assertEqual(result["storyboards"][0]["movement"], "push-in")
        self.assertEqual(
            result["storyboards"][0]["negativePrompt"],
            "模糊,低质量,变形,多余手指,文字,水印",
        )

    def test_extract_json_text_skips_log_dict_before_skill_json(self):
        raw_output = (
            "Model extra config: {'extra_body': {'thinking': {'type': 'disabled'}}}\n"
            "stdout before json\n"
            + json.dumps(BREAKDOWN_SKILL_RESULT, ensure_ascii=False)
            + "\n"
        )

        extracted = _extract_json_text(raw_output)

        payload = json.loads(extracted)
        self.assertEqual(payload["mode"], "script_breakdown")
        self.assertEqual(payload["characters"][0]["name"], "林夏")

    def test_convert_remote_legacy_storyboard_alias_fields(self):
        payload = {
            "characters": BREAKDOWN_RESULT["characters"],
            "scenes": BREAKDOWN_RESULT["scenes"],
            "props": BREAKDOWN_RESULT["props"],
            "storyboards": [
                {
                    "shot_no": 8,
                    "shot_type": "对话",
                    "content": "林：谁在说话？",
                    "video_prompt": "林在深夜办公室里盯着屏幕，紧张询问是谁在说话。",
                    "characters_in_shot": ["林"],
                    "props_in_shot": ["电脑屏幕"],
                    "scene_anchor": "office_midnight",
                    "scene_continuity_key": "office_scene",
                }
            ],
        }

        result = _convert_skill_result_to_legacy_result(payload)

        self.assertEqual(result["storyboards"][0]["id"], "office_scene-8")
        self.assertEqual(result["storyboards"][0]["characters"], "林")
        self.assertEqual(result["storyboards"][0]["description"], payload["storyboards"][0]["video_prompt"])
        self.assertEqual(result["storyboards"][0]["duration"], 4)

    def test_json_schema_response_format_is_downgraded_for_ark_models(self):
        messages = [{"role": "system", "content": "你是剧本拆解 Agent。"}]
        response_format = {
            "type": "json_schema",
            "json_schema": {
                "name": "ScriptBreakdownResult",
                "schema": ScriptBreakdownResult.model_json_schema(),
            },
        }

        downgraded = downgrade_json_schema_response_format(messages, response_format)

        self.assertEqual(downgraded, {"type": "json_object"})
        self.assertIn("不支持 response_format.type=json_schema", messages[0]["content"])
        self.assertIn("ScriptBreakdownResult", messages[0]["content"])

    def test_merge_agent_output_text_parts_preserves_structured_json(self):
        payload = json.dumps(BREAKDOWN_RESULT, ensure_ascii=False)
        split_marker = "林夏低声说："
        split_index = payload.index(split_marker) + len(split_marker)
        parts = [
            Mock(text=payload[:split_index], thought=False),
            Mock(text=payload[split_index:], thought=False),
        ]

        with self.assertRaises(json.JSONDecodeError):
            json.loads("\n".join(part.text for part in parts))

        merged_text = _merge_agent_output_text_parts(parts, structured_output=True)
        result = ScriptBreakdownResult.model_validate_json(merged_text)

        self.assertEqual(result.storyboards[0].dialogue, "林夏低声说：我再画一张。")

    def test_merge_agent_output_text_parts_ignores_trailing_json_fragment(self):
        payload = json.dumps(BREAKDOWN_RESULT, ensure_ascii=False)
        parts = [
            Mock(text=payload, thought=False),
            Mock(text=', {"id": "scene_1-10",', thought=False),
        ]

        merged_text = _merge_agent_output_text_parts(parts, structured_output=True)
        result = ScriptBreakdownResult.model_validate_json(merged_text)

        self.assertEqual(merged_text, payload)
        self.assertEqual(result.storyboards[0].id, "scene_1-1")

    def test_merge_agent_output_text_parts_keeps_newlines_for_plain_text(self):
        parts = [Mock(text="第一行", thought=False), Mock(text="第二行", thought=False)]

        merged_text = _merge_agent_output_text_parts(parts, structured_output=False)

        self.assertEqual(merged_text, "第一行\n第二行")

    def test_safe_validate_agent_tool_output_returns_error_for_truncated_json(self):
        truncated_json = '{"characters": [{"name": "林夏", "identity": "学生"'

        result = _safe_validate_agent_tool_output(
            ScriptBreakdownResult, truncated_json
        )

        self.assertEqual(result["error"], "structured_output_validation_failed")
        self.assertIn("输出不是完整有效 JSON", result["message"])
        self.assertIn("characters", result["raw_output_preview"])

    def test_litellm_client_patch_downgrades_json_schema_at_request_boundary(self):
        from google.adk.models.lite_llm import LiteLLMClient

        captured: dict = {}
        original_acompletion = LiteLLMClient.acompletion
        original_completion = LiteLLMClient.completion
        original_flag = getattr(
            LiteLLMClient,
            "_agentkit_demo_response_format_patched",
            None,
        )

        async def fake_acompletion(self, model, messages, tools, **kwargs):
            captured["messages"] = messages
            captured["response_format"] = kwargs.get("response_format")
            return {"choices": [{"message": {"content": "{}"}}]}

        try:
            LiteLLMClient.acompletion = fake_acompletion
            LiteLLMClient._agentkit_demo_response_format_patched = False
            patch_litellm_json_schema_response_format()

            messages = [{"role": "system", "content": "你是剧本拆解 Agent。"}]
            asyncio.run(
                LiteLLMClient().acompletion(
                    model="fake-breakdown-model",
                    messages=messages,
                    tools=None,
                    response_format={
                        "type": "json_schema",
                        "json_schema": {
                            "name": "ScriptBreakdownResult",
                            "schema": ScriptBreakdownResult.model_json_schema(),
                        },
                    },
                )
            )
        finally:
            LiteLLMClient.acompletion = original_acompletion
            LiteLLMClient.completion = original_completion
            if original_flag is None:
                delattr(LiteLLMClient, "_agentkit_demo_response_format_patched")
            else:
                LiteLLMClient._agentkit_demo_response_format_patched = original_flag

        self.assertEqual(captured["response_format"], {"type": "json_object"})
        self.assertIn("ScriptBreakdownResult", captured["messages"][0]["content"])

    def test_sqlite_session_stale_retry_refreshes_session_once(self):
        from google.adk.sessions.sqlite_session_service import SqliteSessionService

        original_append_event = SqliteSessionService.append_event
        original_get_session = SqliteSessionService.get_session
        original_flag = getattr(
            SqliteSessionService,
            "_agentkit_demo_stale_retry_patched",
            None,
        )
        attempts = {"count": 0}

        async def fake_append_event(self, session, event):
            attempts["count"] += 1
            if attempts["count"] == 1:
                raise ValueError("Please check if it is a stale session.")
            return event

        async def fake_get_session(self, *, app_name, user_id, session_id, config=None):
            return Mock(last_update_time=99.0, state={"fresh": True})

        try:
            SqliteSessionService.append_event = fake_append_event
            SqliteSessionService.get_session = fake_get_session
            SqliteSessionService._agentkit_demo_stale_retry_patched = False
            patch_sqlite_session_stale_retry()

            session = Mock(
                app_name="short_drama_asset_agent",
                user_id="user-1",
                id="session-1",
                last_update_time=1.0,
                state={},
            )
            event = Mock()

            service = object.__new__(SqliteSessionService)
            result = asyncio.run(
                SqliteSessionService.append_event(service, session, event)
            )
        finally:
            SqliteSessionService.append_event = original_append_event
            SqliteSessionService.get_session = original_get_session
            if original_flag is None:
                delattr(
                    SqliteSessionService,
                    "_agentkit_demo_stale_retry_patched",
                )
            else:
                SqliteSessionService._agentkit_demo_stale_retry_patched = original_flag

        self.assertIs(result, event)
        self.assertEqual(attempts["count"], 2)
        self.assertEqual(session.last_update_time, 99.0)
        self.assertEqual(session.state, {"fresh": True})

    def test_runner_defaults_to_saving_input_blobs_as_artifacts(self):
        from google.adk.agents.run_config import RunConfig
        from google.adk.runners import Runner as AdkRunner

        original_handle_new_message = AdkRunner._handle_new_message
        original_flag = getattr(
            AdkRunner,
            "_agentkit_demo_artifact_save_patched",
            None,
        )
        captured = {}

        async def fake_handle_new_message(
            self,
            *,
            session,
            new_message,
            invocation_context,
            run_config=None,
            state_delta=None,
        ):
            captured["save_input_blobs_as_artifacts"] = (
                run_config.save_input_blobs_as_artifacts
            )
            captured["fields_set"] = set(run_config.model_fields_set)

        try:
            AdkRunner._handle_new_message = fake_handle_new_message
            AdkRunner._agentkit_demo_artifact_save_patched = False
            patch_adk_save_input_blobs_as_artifacts_default()

            invocation_context = Mock(run_config=RunConfig())
            asyncio.run(
                AdkRunner._handle_new_message(
                    Mock(),
                    session=Mock(),
                    new_message=Mock(),
                    invocation_context=invocation_context,
                    run_config=invocation_context.run_config,
                )
            )
        finally:
            AdkRunner._handle_new_message = original_handle_new_message
            if original_flag is None:
                delattr(AdkRunner, "_agentkit_demo_artifact_save_patched")
            else:
                AdkRunner._agentkit_demo_artifact_save_patched = original_flag

        self.assertTrue(captured["save_input_blobs_as_artifacts"])
        self.assertIn("save_input_blobs_as_artifacts", captured["fields_set"])

    def test_trace_request_serialization_tolerates_cyclic_tool_response(self):
        import google.adk.telemetry.tracing as tracing
        from google.adk.models.llm_request import LlmRequest

        loop = {}
        loop["self"] = loop
        content = types.Content(
            role="user",
            parts=[
                types.Part(
                    function_response=types.FunctionResponse(
                        name="ingest_asset_to_knowledgebase",
                        response={"loop": loop},
                    )
                )
            ],
        )
        request = LlmRequest(contents=[content])

        patch_adk_trace_safe_serialization()
        payload = tracing._build_llm_request_for_trace(request)

        self.assertEqual(
            payload["contents"][0]["parts"][0]["function_response"]["response"]["loop"][
                "self"
            ],
            "[CircularReference]",
        )

    def test_factory_mounts_script_breakdown_tool_before_mcp_router(self):
        sentinel_tool = Mock(name="script_breakdown_tool")
        sentinel_tool.name = "script_breakdown"
        fake_router = Mock(name="mcp_router")
        fake_router.name = "mcp_router"

        class FakeRootAgent:
            def __init__(self, **kwargs):
                self.instruction = kwargs["instruction"]
                self.model_api_key = kwargs["model_api_key"]
                self.tools = []

        with (
            patch.dict(
                os.environ,
                {
                    "TOOL_MCP_ROUTER_URL": "http://mcp-router.test/mcp",
                    "TOOL_MCP_ROUTER_API_KEY": "test-key",
                    "MODEL_AGENT_API_KEY": "",
                    "ARK_API_KEY": "",
                    "VOLCENGINE_ARK_API_KEY": "",
                    "ARK_API_TOKEN": "",
                },
            ),
            patch(
                "short_drama_agent.factory.get_ark_token", return_value="ark-aksk-key"
            ),
            patch("short_drama_agent.factory.Agent", FakeRootAgent),
            patch(
                "short_drama_agent.factory.create_knowledge_base", return_value=Mock()
            ),
            patch(
                "short_drama_agent.factory.create_long_term_memory", return_value=Mock()
            ),
            patch(
                "short_drama_agent.factory.make_after_agent_execution",
                return_value=Mock(),
            ),
            patch(
                "short_drama_agent.factory.AssetAwareRunProcessor", return_value=Mock()
            ),
            patch(
                "short_drama_agent.factory.AssetMetadataFirstLoadKnowledgebaseTool",
                return_value=Mock(name="asset_tool"),
            ),
            patch(
                "short_drama_agent.factory.create_script_breakdown_tool",
                return_value=sentinel_tool,
            ),
            patch(
                "short_drama_agent.factory.load_execute_skills_tool", return_value=[]
            ),
            patch(
                "short_drama_agent.factory.get_execute_skills_status", return_value={}
            ),
            patch("short_drama_agent.factory.mcp_router", fake_router),
        ):
            from short_drama_agent.factory import create_root_agent

            root_agent, _, _ = create_root_agent()

        self.assertIn(ASSET_INGEST_ROUTING_INSTRUCTION, root_agent.instruction)
        self.assertIn(SCRIPT_BREAKDOWN_ROUTING_INSTRUCTION, root_agent.instruction)
        self.assertIn(
            "已有剧本关联资产的图片生成状态检查、补生成或完成图片生成",
            root_agent.instruction,
        )
        self.assertIn(
            "不要调用 `execute_skills` 或 `script_breakdown`",
            root_agent.instruction,
        )
        self.assertEqual(root_agent.model_api_key, "ark-aksk-key")
        self.assertEqual(
            [getattr(tool, "name", "") for tool in root_agent.tools],
            ["script_breakdown", "mcp_router"],
        )

    def test_factory_mounts_execute_skills_before_script_breakdown_when_available(self):
        execute_skills_tool = Mock(name="execute_skills_tool")
        execute_skills_tool.name = "execute_skills"
        script_breakdown_tool = Mock(name="script_breakdown_tool")
        script_breakdown_tool.name = "script_breakdown"
        fake_router = Mock(name="mcp_router")
        fake_router.name = "mcp_router"

        class FakeRootAgent:
            def __init__(self, **kwargs):
                self.instruction = kwargs["instruction"]
                self.model_api_key = kwargs["model_api_key"]
                self.tools = []

        with (
            patch.dict(
                os.environ,
                {
                    "TOOL_MCP_ROUTER_URL": "http://mcp-router.test/mcp",
                    "TOOL_MCP_ROUTER_API_KEY": "test-key",
                    "MODEL_AGENT_API_KEY": "ark-test-key",
                },
                clear=False,
            ),
            patch("short_drama_agent.factory.Agent", FakeRootAgent),
            patch(
                "short_drama_agent.factory.create_knowledge_base", return_value=Mock()
            ),
            patch(
                "short_drama_agent.factory.create_long_term_memory", return_value=Mock()
            ),
            patch(
                "short_drama_agent.factory.make_after_agent_execution",
                return_value=Mock(),
            ),
            patch(
                "short_drama_agent.factory.AssetAwareRunProcessor", return_value=Mock()
            ),
            patch(
                "short_drama_agent.factory.AssetMetadataFirstLoadKnowledgebaseTool",
                return_value=Mock(name="asset_tool"),
            ),
            patch(
                "short_drama_agent.factory.create_script_breakdown_tool",
                return_value=script_breakdown_tool,
            ),
            patch(
                "short_drama_agent.factory.load_execute_skills_tool",
                return_value=[execute_skills_tool],
            ),
            patch(
                "short_drama_agent.factory.get_execute_skills_status",
                return_value={"loaded": True},
            ),
            patch("short_drama_agent.factory.mcp_router", fake_router),
        ):
            from short_drama_agent.factory import create_root_agent

            root_agent, _, _ = create_root_agent()

        self.assertEqual(
            [getattr(tool, "name", "") for tool in root_agent.tools],
            ["execute_skills", "script_breakdown", "mcp_router"],
        )

    def test_factory_uses_model_api_key_alias_without_startup_fetch(self):
        class FakeRootAgent:
            def __init__(self, **kwargs):
                self.model_api_key = kwargs["model_api_key"]
                self.tools = []

        with (
            patch.dict(
                os.environ,
                {
                    "ARK_API_KEY": "ark-test-key",
                },
                clear=False,
            ),
            patch("short_drama_agent.factory.Agent", FakeRootAgent),
            patch(
                "short_drama_agent.factory.create_knowledge_base", return_value=Mock()
            ),
            patch(
                "short_drama_agent.factory.create_long_term_memory", return_value=Mock()
            ),
            patch(
                "short_drama_agent.factory.make_after_agent_execution",
                return_value=Mock(),
            ),
            patch(
                "short_drama_agent.factory.AssetAwareRunProcessor", return_value=Mock()
            ),
            patch(
                "short_drama_agent.factory.AssetMetadataFirstLoadKnowledgebaseTool",
                return_value=Mock(name="asset_tool"),
            ),
            patch(
                "short_drama_agent.factory.create_script_breakdown_tool",
                return_value=Mock(),
            ),
            patch(
                "short_drama_agent.factory.load_execute_skills_tool", return_value=[]
            ),
            patch(
                "short_drama_agent.factory.get_execute_skills_status", return_value={}
            ),
            patch("short_drama_agent.factory.mcp_router", Mock(name="mcp_router")),
        ):
            from short_drama_agent.factory import create_root_agent

            root_agent, _, _ = create_root_agent()

        self.assertEqual(root_agent.model_api_key, "ark-test-key")

    def test_resolve_model_api_key_retries_aksk_fetch(self):
        from short_drama_agent.factory import resolve_model_api_key

        attempts = {"count": 0}

        def flaky_get_ark_token():
            attempts["count"] += 1
            if attempts["count"] < 3:
                raise OSError("SSL EOF")
            return "ark-key-from-aksk"

        with (
            patch.dict(
                os.environ,
                {
                    "MODEL_AGENT_API_KEY": "",
                    "ARK_API_KEY": "",
                    "VOLCENGINE_ARK_API_KEY": "",
                    "ARK_API_TOKEN": "",
                },
            ),
            patch("short_drama_agent.factory.get_ark_token", flaky_get_ark_token),
            patch("short_drama_agent.factory.time.sleep", return_value=None),
        ):
            api_key = resolve_model_api_key()

        self.assertEqual(api_key, "ark-key-from-aksk")
        self.assertEqual(attempts["count"], 3)

    def test_ingest_asset_tool_uploads_to_tos_then_adds_to_knowledgebase(self):
        from short_drama_agent.knowledge_assets import ingest_asset_to_knowledgebase

        upload_result = {
            "bucket": "asset-bucket",
            "object_key": "knowledgebase/assets/role.png",
            "tos_path": "asset-bucket/knowledgebase/assets/role.png",
            "tos_url": "tos://asset-bucket/knowledgebase/assets/role.png",
            "public_url": (
                "https://asset-bucket.tos-cn-beijing.volces.com/"
                "knowledgebase/assets/role.png"
            ),
            "content_type": "image/png",
        }

        with (
            tempfile.NamedTemporaryFile(suffix=".png") as asset_file,
            patch(
                "short_drama_agent.knowledge_assets.upload_asset_file_to_tos",
                return_value=upload_result,
            ) as upload_file,
            patch(
                "short_drama_agent.knowledge_assets.add_uploaded_asset_to_knowledgebase",
                return_value={"code": 0, "data": {"doc_id": "doc-1"}},
            ) as add_doc,
        ):
            asset_file.write(b"png-bytes")
            asset_file.flush()
            result = asyncio.run(
                ingest_asset_to_knowledgebase(
                    asset_file.name,
                    title="女主立绘",
                    metadata={"character_name": "林夏"},
                )
            )

        upload_file.assert_called_once()
        upload_kwargs = upload_file.call_args.kwargs
        self.assertEqual(
            upload_kwargs["metadata"],
            {"character_name": "林夏", "title": "女主立绘"},
        )
        add_doc.assert_called_once_with(upload_result)
        self.assertTrue(result["success"])
        self.assertEqual(result["tos"]["tos_url"], upload_result["tos_url"])

    def test_knowledgebase_ingest_retries_tos_url_when_plain_path_fails(self):
        from short_drama_agent.knowledge_assets import (
            add_uploaded_asset_to_knowledgebase,
        )

        upload_result = {
            "tos_path": "asset-bucket/knowledgebase/assets/role.png",
            "tos_url": "tos://asset-bucket/knowledgebase/assets/role.png",
            "public_url": (
                "https://asset-bucket.tos-cn-beijing.volces.com/"
                "knowledgebase/assets/role.png"
            ),
        }

        with patch(
            "short_drama_agent.knowledge_assets.add_tos_asset_to_knowledgebase",
            side_effect=[
                {
                    "code": -1,
                    "http_status": 400,
                    "response": {"message": "invalid tos path"},
                },
                {"code": 0, "data": {"doc_id": "doc-1"}},
            ],
        ) as add_doc:
            response = add_uploaded_asset_to_knowledgebase(upload_result)

        self.assertEqual(response["code"], 0)
        self.assertEqual(
            response["used_tos_path"],
            "tos://asset-bucket/knowledgebase/assets/role.png",
        )
        self.assertEqual(add_doc.call_count, 2)

    def test_tos_bucket_can_be_resolved_from_agentkit_yaml(self):
        from short_drama_agent.knowledge_assets import (
            _resolve_tos_bucket,
            _resolve_tos_prefix,
            _resolve_tos_region,
        )

        with (
            patch.dict(
                os.environ,
                {
                    "AGENTKIT_LAUNCH_TYPE": "cloud",
                },
                clear=True,
            ),
            patch(
                "short_drama_agent.knowledge_assets._resolve_agentkit_account_id",
                return_value="2100701382",
            ),
            patch(
                "short_drama_agent.knowledge_assets._load_agentkit_yaml_tos_config",
                return_value={
                    "tos_bucket": "agentkit-platform-2100701382",
                    "tos_prefix": "agentkit-builds",
                    "tos_region": "cn-beijing",
                },
            ),
        ):
            self.assertEqual(
                _resolve_tos_bucket(),
                "agentkit-platform-2100701382",
            )
            self.assertEqual(_resolve_tos_prefix(), "agentkit-builds")
            self.assertEqual(_resolve_tos_region(), "cn-beijing")

    def test_ingest_asset_tool_uses_adk_artifact_when_local_file_is_missing(self):
        from google.genai import types

        from short_drama_agent.knowledge_assets import ingest_asset_to_knowledgebase

        class FakeToolContext:
            async def list_artifacts(self):
                return ["zenitsu_agatsuma_promotional_art.png"]

            async def load_artifact(self, filename):
                self.loaded_filename = filename
                return types.Part(
                    inline_data=types.Blob(
                        mime_type="image/png",
                        data=b"png-bytes",
                    )
                )

        upload_result = {
            "bucket": "asset-bucket",
            "object_key": "knowledgebase/assets/zenitsu.png",
            "tos_path": "asset-bucket/knowledgebase/assets/zenitsu.png",
            "tos_url": "tos://asset-bucket/knowledgebase/assets/zenitsu.png",
            "public_url": (
                "https://asset-bucket.tos-cn-beijing.volces.com/"
                "knowledgebase/assets/zenitsu.png"
            ),
            "content_type": "image/png",
        }
        tool_context = FakeToolContext()

        with (
            patch(
                "short_drama_agent.knowledge_assets.upload_asset_bytes_to_tos",
                return_value=upload_result,
            ) as upload_bytes,
            patch(
                "short_drama_agent.knowledge_assets.add_uploaded_asset_to_knowledgebase",
                return_value={"code": 0, "data": {"doc_id": "doc-2"}},
            ),
        ):
            result = asyncio.run(
                ingest_asset_to_knowledgebase(
                    "./zenitsu_agatsuma_promotional_art.png",
                    title="善逸宣传图",
                    tool_context=tool_context,
                )
            )

        upload_bytes.assert_called_once()
        upload_kwargs = upload_bytes.call_args.kwargs
        self.assertEqual(
            upload_kwargs["file_name"],
            "zenitsu_agatsuma_promotional_art.png",
        )
        self.assertEqual(upload_kwargs["content"], b"png-bytes")
        self.assertTrue(result["success"])
        self.assertEqual(result["source"], "adk_artifact")
        self.assertEqual(
            result["tos"]["artifact_name"],
            "zenitsu_agatsuma_promotional_art.png",
        )

    def test_ingest_asset_tool_matches_chinese_artifact_name_flexibly(self):
        from google.genai import types

        from short_drama_agent.knowledge_assets import ingest_asset_to_knowledgebase

        class FakeToolContext:
            async def list_artifacts(self):
                return ["uploads/刘亦菲版小龙女定妆照.jpg"]

            async def load_artifact(self, filename):
                self.loaded_filename = filename
                return types.Part(
                    inline_data=types.Blob(
                        mime_type="image/jpeg",
                        data=b"jpg-bytes",
                    )
                )

        upload_result = {
            "bucket": "asset-bucket",
            "object_key": "knowledgebase/assets/xiaolongnv.jpg",
            "tos_path": "asset-bucket/knowledgebase/assets/xiaolongnv.jpg",
            "tos_url": "tos://asset-bucket/knowledgebase/assets/xiaolongnv.jpg",
            "public_url": (
                "https://asset-bucket.tos-cn-beijing.volces.com/"
                "knowledgebase/assets/xiaolongnv.jpg"
            ),
            "content_type": "image/jpeg",
        }
        tool_context = FakeToolContext()

        with (
            patch(
                "short_drama_agent.knowledge_assets.upload_asset_bytes_to_tos",
                return_value=upload_result,
            ) as upload_bytes,
            patch(
                "short_drama_agent.knowledge_assets.add_uploaded_asset_to_knowledgebase",
                return_value={"code": 0, "data": {"doc_id": "doc-xln"}},
            ),
        ):
            result = asyncio.run(
                ingest_asset_to_knowledgebase(
                    "./小龙女定妆照.jpg",
                    title="刘亦菲版小龙女定妆照",
                    metadata={
                        "asset_type": "图片",
                        "work": "神雕侠侣",
                        "character_name": "小龙女",
                        "tags": ["角色资产", "小龙女", "神雕侠侣"],
                    },
                    tool_context=tool_context,
                )
            )

        upload_bytes.assert_called_once()
        upload_kwargs = upload_bytes.call_args.kwargs
        self.assertEqual(upload_kwargs["content_type"], "image/jpeg")
        self.assertEqual(upload_kwargs["metadata"]["character_name"], "小龙女")
        self.assertTrue(result["success"])
        self.assertEqual(
            result["tos"]["artifact_name"],
            "uploads/刘亦菲版小龙女定妆照.jpg",
        )

    def test_ingest_asset_tool_matches_generated_artifact_by_display_name(self):
        from google.genai import types

        from short_drama_agent.knowledge_assets import ingest_asset_to_knowledgebase

        class FakeToolContext:
            async def list_artifacts(self):
                return ["artifact_invocation_0", "artifact_invocation_1"]

            async def load_artifact(self, filename):
                display_name = (
                    "刘亦菲_小龙女_神雕侠侣剧照.jpg"
                    if filename == "artifact_invocation_1"
                    else "杨过定妆照.jpg"
                )
                return types.Part(
                    inline_data=types.Blob(
                        mime_type="image/jpeg",
                        data=b"jpg-bytes",
                        display_name=display_name,
                    )
                )

        upload_result = {
            "bucket": "asset-bucket",
            "object_key": "knowledgebase/assets/xiaolongnv.jpg",
            "tos_path": "asset-bucket/knowledgebase/assets/xiaolongnv.jpg",
            "tos_url": "tos://asset-bucket/knowledgebase/assets/xiaolongnv.jpg",
            "public_url": (
                "https://asset-bucket.tos-cn-beijing.volces.com/"
                "knowledgebase/assets/xiaolongnv.jpg"
            ),
            "content_type": "image/jpeg",
        }

        with (
            patch(
                "short_drama_agent.knowledge_assets.upload_asset_bytes_to_tos",
                return_value=upload_result,
            ) as upload_bytes,
            patch(
                "short_drama_agent.knowledge_assets.add_uploaded_asset_to_knowledgebase",
                return_value={"code": 0, "data": {"doc_id": "doc-xln"}},
            ),
        ):
            result = asyncio.run(
                ingest_asset_to_knowledgebase(
                    "刘亦菲_小龙女_神雕侠侣剧照.jpg",
                    title="刘亦菲版小龙女剧照",
                    tool_context=FakeToolContext(),
                )
            )

        self.assertTrue(result["success"])
        self.assertEqual(result["tos"]["artifact_name"], "artifact_invocation_1")
        self.assertEqual(upload_bytes.call_args.kwargs["content"], b"jpg-bytes")

    def test_ingest_asset_tool_restores_suffix_for_artifact_upload_name(self):
        from google.genai import types

        from short_drama_agent.knowledge_assets import ingest_asset_to_knowledgebase

        class FakeToolContext:
            async def list_artifacts(self):
                return ["artifact_upload_1"]

            async def load_artifact(self, filename):
                return types.Part(
                    inline_data=types.Blob(
                        mime_type="image/jpeg",
                        data=b"jpg-bytes",
                        display_name="刘亦菲版小龙女定妆照.jpg",
                    )
                )

        upload_result = {
            "bucket": "asset-bucket",
            "object_key": "knowledgebase/assets/xiaolongnv.jpg",
            "tos_path": "asset-bucket/knowledgebase/assets/xiaolongnv.jpg",
            "tos_url": "tos://asset-bucket/knowledgebase/assets/xiaolongnv.jpg",
            "public_url": "https://example.com/xiaolongnv.jpg",
            "content_type": "image/jpeg",
        }

        with (
            patch(
                "short_drama_agent.knowledge_assets.upload_asset_bytes_to_tos",
                return_value=upload_result,
            ) as upload_bytes,
            patch(
                "short_drama_agent.knowledge_assets.add_uploaded_asset_to_knowledgebase",
                return_value={"code": 0, "data": {"doc_id": "doc-xln"}},
            ),
        ):
            result = asyncio.run(
                ingest_asset_to_knowledgebase(
                    "artifact_upload_1",
                    title="刘亦菲版小龙女剧照",
                    tool_context=FakeToolContext(),
                )
            )

        self.assertTrue(result["success"])
        self.assertEqual(
            upload_bytes.call_args.kwargs["file_name"],
            "刘亦菲版小龙女定妆照.jpg",
        )

    def test_ingest_asset_tool_returns_available_artifacts_when_not_found(self):
        from short_drama_agent.knowledge_assets import ingest_asset_to_knowledgebase

        class FakeToolContext:
            async def list_artifacts(self):
                return ["刘亦菲版小龙女定妆照.jpg", "杨过定妆照.jpg"]

        result = asyncio.run(
            ingest_asset_to_knowledgebase(
                "不存在的资产.jpg",
                tool_context=FakeToolContext(),
            )
        )

        self.assertFalse(result["success"])
        self.assertEqual(
            result["available_artifacts"],
            ["刘亦菲版小龙女定妆照.jpg", "杨过定妆照.jpg"],
        )
        self.assertIn("no matching ADK artifact", result["error"])

    def test_main_agent_dispatches_script_breakdown_for_breakdown_prompt(self):
        async def run_agent():
            return await Runner(
                agent=_build_breakdown_root_agent(),
                app_name="script_breakdown_runner_test",
            ).run(messages=("请拆解这个校园青春剧本，生成角色、场景、道具和分镜。"))

        output = asyncio.run(run_agent())

        self.assertIn("角色：林夏", output)
        self.assertIn("场景：画室夜训", output)
        self.assertIn("道具：折角艺考准考证", output)
        self.assertIn("分镜：scene_1-1", output)
        self.assertIn("如需入库或生成资产文件", output)

    def test_script_breakdown_works_through_a2a_message_send(self):
        client = TestClient(_build_breakdown_a2a_app())
        request = SendMessageRequest(
            id="script-breakdown-a2a-test",
            params=MessageSendParams(
                message=Message(
                    messageId="msg-1",
                    role=Role.user,
                    parts=[
                        Part(
                            root=TextPart(
                                text="请把这段校园青春剧本拆成角色、场景、道具和分镜"
                            )
                        )
                    ],
                )
            ),
        )

        response = client.post(
            "/",
            json=request.model_dump(
                mode="json",
                by_alias=True,
                exclude_none=True,
            ),
        )

        self.assertEqual(response.status_code, 200)
        task = response.json()["result"]
        self.assertEqual(task["status"]["state"], "completed")
        final_text = task["artifacts"][0]["parts"][0]["text"]
        self.assertIn("角色：林夏", final_text)

        calls = [
            part["data"]["name"]
            for event in task["history"]
            for part in event.get("parts", [])
            if part.get("metadata", {}).get("adk_type") == "function_call"
        ]
        self.assertEqual(calls, ["script_breakdown"])


if __name__ == "__main__":
    unittest.main()
