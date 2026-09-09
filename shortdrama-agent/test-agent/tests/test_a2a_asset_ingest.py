import base64
import json
import os
import re
import unittest
from unittest.mock import patch

from a2a.server.apps.jsonrpc.fastapi_app import A2AFastAPIApplication
from a2a.server.request_handlers.default_request_handler import DefaultRequestHandler
from a2a.server.tasks.inmemory_task_store import InMemoryTaskStore
from a2a.types import (
    FilePart,
    FileWithBytes,
    Message,
    MessageSendParams,
    Part,
    Role,
    SendMessageRequest,
    TextPart,
)
from google.adk.a2a.executor import a2a_agent_executor
from google.adk.artifacts.in_memory_artifact_service import InMemoryArtifactService
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.genai import types
from starlette.testclient import TestClient
from veadk import Agent
from veadk.a2a.agent_card import get_agent_card
from veadk.runner import Runner

from short_drama_agent.knowledge_assets import ingest_asset_to_knowledgebase
from short_drama_agent.runtime_patches import apply_runtime_patches


FILE_NAME = "liuyifei-xiaolongnv.jpg"
FILE_BYTES = b"fake image bytes from a2a"


class AssetIngestFakeLlm(BaseLlm):
    model: str = "fake-a2a-asset-ingest-model"

    async def generate_content_async(self, llm_request, stream=False):
        function_responses = [
            part.function_response
            for content in llm_request.contents
            for part in (content.parts or [])
            if part.function_response
        ]
        if function_responses:
            response = function_responses[-1].response
            yield LlmResponse(
                content=types.Content(
                    role="model",
                    parts=[
                        types.Part(
                            text=json.dumps(
                                {
                                    "tool_result": response,
                                    "final": "asset ingest completed",
                                },
                                ensure_ascii=False,
                            )
                        )
                    ],
                )
            )
            return

        request_text = "\n".join(
            part.text or ""
            for content in llm_request.contents
            for part in (content.parts or [])
            if part.text
        )
        self._assert_uploaded_artifact_hint_present(request_text)
        yield LlmResponse(
            content=types.Content(
                role="model",
                parts=[
                    types.Part(
                        function_call=types.FunctionCall(
                            id="call-ingest-asset",
                            name="ingest_asset_to_knowledgebase",
                            args={
                                "file_path": FILE_NAME,
                                "title": "刘亦菲版小龙女定妆照",
                                "metadata": {
                                    "character_name": "小龙女",
                                    "source": "a2a-test",
                                },
                            },
                        )
                    )
                ],
            )
        )

    def _assert_uploaded_artifact_hint_present(self, request_text: str) -> None:
        if not re.search(r"Uploaded file: artifact_[^\s]+_1", request_text):
            raise AssertionError(request_text)


def build_asset_ingest_a2a_app():
    apply_runtime_patches()
    root_agent = Agent(
        name="asset_ingest_a2a_test_agent",
        description="A2A asset ingest test agent",
        model_api_key="test-key",
        model_name="fake-a2a-asset-ingest-model",
        model=AssetIngestFakeLlm(),
        instruction=(
            "When the user asks to import an attached asset into the knowledge "
            "base, call ingest_asset_to_knowledgebase with the provided filename."
        ),
        tools=[ingest_asset_to_knowledgebase],
    )

    executor_config_cls = getattr(a2a_agent_executor, "A2aAgentExecutorConfig")
    agent_executor = a2a_agent_executor.A2aAgentExecutor(
        runner=Runner(
            agent=root_agent,
            app_name="asset_ingest_a2a_test",
            artifact_service=InMemoryArtifactService(),
        ),
        config=executor_config_cls(),
    )
    request_handler = DefaultRequestHandler(
        agent_executor=agent_executor,
        task_store=InMemoryTaskStore(),
    )
    return A2AFastAPIApplication(
        agent_card=get_agent_card(root_agent, "http://testserver"),
        http_handler=request_handler,
    ).build()


class A2AAssetIngestTest(unittest.TestCase):
    def test_a2a_file_attachment_is_imported_to_knowledgebase(self):
        client = TestClient(build_asset_ingest_a2a_app())
        upload_result = {
            "bucket": "test-bucket",
            "object_key": "knowledgebase/assets/liuyifei-xiaolongnv.jpg",
            "tos_path": "test-bucket/knowledgebase/assets/liuyifei-xiaolongnv.jpg",
            "tos_url": "tos://test-bucket/knowledgebase/assets/liuyifei-xiaolongnv.jpg",
            "public_url": "https://example.com/liuyifei-xiaolongnv.jpg",
            "content_type": "image/jpeg",
        }

        with (
            patch(
                "short_drama_agent.knowledge_assets.upload_asset_bytes_to_tos",
                return_value=upload_result,
            ) as upload_asset,
            patch(
                "short_drama_agent.knowledge_assets.add_uploaded_asset_to_knowledgebase",
                return_value={"code": 0, "message": "ok"},
            ) as add_to_kb,
        ):
            request = SendMessageRequest(
                id="a2a-asset-ingest-test",
                params=MessageSendParams(
                    message=Message(
                        messageId="msg-asset-1",
                        role=Role.user,
                        parts=[
                            Part(
                                root=TextPart(
                                    text=(
                                        "请将附件图片入知识库，文件名为 "
                                        f"{FILE_NAME}，角色是小龙女"
                                    )
                                )
                            ),
                            Part(
                                root=FilePart(
                                    file=FileWithBytes(
                                        bytes=base64.b64encode(FILE_BYTES).decode(
                                            "ascii"
                                        ),
                                        mime_type="image/jpeg",
                                        name=FILE_NAME,
                                    )
                                )
                            ),
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

        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertNotIn("error", payload)
        self.assertEqual(payload["result"]["status"]["state"], "completed")

        upload_asset.assert_called_once()
        upload_kwargs = upload_asset.call_args.kwargs
        self.assertEqual(upload_kwargs["file_name"], FILE_NAME)
        self.assertEqual(upload_kwargs["content"], FILE_BYTES)
        self.assertEqual(upload_kwargs["content_type"], "image/jpeg")
        self.assertEqual(upload_kwargs["metadata"]["character_name"], "小龙女")

        add_to_kb.assert_called_once()
        kb_upload_arg = add_to_kb.call_args.args[0]
        self.assertEqual(kb_upload_arg["tos_path"], upload_result["tos_path"])
        self.assertRegex(kb_upload_arg["artifact_name"], r"^artifact_.+_1$")

        final_text = payload["result"]["artifacts"][0]["parts"][0]["text"]
        final_payload = json.loads(final_text)
        self.assertTrue(final_payload["tool_result"]["success"])
        self.assertEqual(final_payload["tool_result"]["source"], "adk_artifact")

    @unittest.skipUnless(
        os.getenv("RUN_REAL_A2A_ASSET_INGEST") == "1",
        "set RUN_REAL_A2A_ASSET_INGEST=1 to write a real TOS/KB ingest record",
    )
    def test_real_a2a_file_attachment_is_imported_to_configured_knowledgebase(self):
        client = TestClient(build_asset_ingest_a2a_app())
        request = SendMessageRequest(
            id="a2a-real-asset-ingest-test",
            params=MessageSendParams(
                message=Message(
                    messageId="msg-real-asset-1",
                    role=Role.user,
                    parts=[
                        Part(
                            root=TextPart(
                                text=(
                                    "请将附件图片真实入知识库，文件名为 "
                                    f"{FILE_NAME}，角色是小龙女"
                                )
                            )
                        ),
                        Part(
                            root=FilePart(
                                file=FileWithBytes(
                                    bytes=base64.b64encode(FILE_BYTES).decode("ascii"),
                                    mime_type="image/jpeg",
                                    name=FILE_NAME,
                                )
                            )
                        ),
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

        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertNotIn("error", payload)
        self.assertEqual(payload["result"]["status"]["state"], "completed")
        final_text = payload["result"]["artifacts"][0]["parts"][0]["text"]
        final_payload = json.loads(final_text)
        tool_result = final_payload["tool_result"]
        self.assertTrue(tool_result["success"], tool_result)
        self.assertEqual(tool_result["source"], "adk_artifact")
        self.assertEqual(tool_result["knowledgebase"]["code"], 0)
        self.assertTrue(tool_result["tos"]["tos_url"].startswith("tos://"))


if __name__ == "__main__":
    unittest.main()
