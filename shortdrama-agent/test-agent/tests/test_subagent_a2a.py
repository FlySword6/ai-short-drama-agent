import json
import unittest

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
from pydantic import BaseModel
from starlette.testclient import TestClient
from veadk import Agent
from veadk.a2a.agent_card import get_agent_card
from veadk.runner import Runner


class ScriptFramework(BaseModel):
    protagonist1: str
    protagonist2: str
    core_conflict: str
    framework_summary: str


class ProjectSchedule(BaseModel):
    day1: str
    day2: str
    day3: str
    day4: str
    day5: str
    day6: str
    day7: str


SCRIPT_FRAMEWORK = {
    "protagonist1": "林夏",
    "protagonist2": "周屿",
    "core_conflict": "艺考梦想与高考压力的矛盾",
    "framework_summary": "高三学生在备考与艺考之间寻找选择。",
}
PROJECT_SCHEDULE = {f"day{index}": f"第{index}天任务" for index in range(1, 8)}
FINAL_OUTPUT = {"framework": SCRIPT_FRAMEWORK, "schedule": PROJECT_SCHEDULE}


class ScriptWorkflowFakeLlm(BaseLlm):
    role: str
    model: str = "fake-subagent-model"

    async def generate_content_async(self, llm_request, stream=False):
        if self.role == "script":
            yield _text_response(SCRIPT_FRAMEWORK)
            return

        if self.role == "schedule":
            yield _text_response(PROJECT_SCHEDULE)
            return

        function_responses = [
            part.function_response.name
            for content in llm_request.contents
            for part in (content.parts or [])
            if part.function_response
        ]
        if "script_creative" not in function_responses:
            yield _function_call_response(
                call_id="call-script",
                name="script_creative",
                request="生成校园青春剧本核心框架",
            )
            return

        if "project_scheduler" not in function_responses:
            yield _function_call_response(
                call_id="call-schedule",
                name="project_scheduler",
                request="根据剧本框架生成7天项目进度表",
            )
            return

        yield _text_response(FINAL_OUTPUT)


def _text_response(payload: dict) -> LlmResponse:
    return LlmResponse(
        content=types.Content(
            role="model",
            parts=[
                types.Part(text=json.dumps(payload, ensure_ascii=False)),
            ],
        )
    )


def _function_call_response(call_id: str, name: str, request: str) -> LlmResponse:
    return LlmResponse(
        content=types.Content(
            role="model",
            parts=[
                types.Part(
                    function_call=types.FunctionCall(
                        id=call_id,
                        name=name,
                        args={"request": request},
                    )
                )
            ],
        )
    )


def _test_agent(**kwargs) -> Agent:
    return Agent(
        model_api_key="test-key",
        model_name="fake-subagent-model",
        **kwargs,
    )


def build_subagent_a2a_app():
    creative_subagent = _test_agent(
        name="script_creative",
        description="生成校园青春剧本核心框架",
        model=ScriptWorkflowFakeLlm(role="script"),
        instruction="严格按 ScriptFramework 格式输出，不添加额外内容。",
        output_schema=ScriptFramework,
    )
    schedule_subagent = _test_agent(
        name="project_scheduler",
        description="根据剧本框架生成7天项目进度表",
        model=ScriptWorkflowFakeLlm(role="schedule"),
        instruction="严格按 ProjectSchedule 格式输出。",
        output_schema=ProjectSchedule,
    )
    root_agent = _test_agent(
        name="script_main_scheduler",
        description="调度剧本框架和进度表子 Agent",
        model=ScriptWorkflowFakeLlm(role="main"),
        instruction=(
            "先调用 script_creative 生成剧本框架，再调用 project_scheduler "
            "生成进度表，最后合并两个结构化结果输出。"
        ),
        tools=[
            AgentTool(creative_subagent),
            AgentTool(schedule_subagent),
        ],
    )

    executor_config_cls = getattr(a2a_agent_executor, "A2aAgentExecutorConfig")
    agent_executor = a2a_agent_executor.A2aAgentExecutor(
        runner=Runner(agent=root_agent, app_name="subagent_a2a_test"),
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


class SubagentA2ATest(unittest.TestCase):
    def test_subagents_are_dispatched_through_a2a_message_send(self):
        client = TestClient(build_subagent_a2a_app())

        card_response = client.get("/.well-known/agent-card.json")
        self.assertEqual(card_response.status_code, 200)
        self.assertEqual(card_response.json()["name"], "script_main_scheduler")

        request = SendMessageRequest(
            id="subagent-a2a-test",
            params=MessageSendParams(
                message=Message(
                    messageId="msg-1",
                    role=Role.user,
                    parts=[
                        Part(
                            root=TextPart(
                                text=(
                                    "启动校园青春剧本项目，主角为高三学生，"
                                    "核心冲突是艺考梦想与高考压力的矛盾"
                                )
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
        payload = response.json()
        self.assertNotIn("error", payload)
        task = payload["result"]
        self.assertEqual(task["status"]["state"], "completed")

        final_text = task["artifacts"][0]["parts"][0]["text"]
        self.assertEqual(json.loads(final_text), FINAL_OUTPUT)

        agent_events = [
            part["data"]["name"]
            for event in task["history"]
            for part in event.get("parts", [])
            if part.get("metadata", {}).get("adk_type") == "function_call"
        ]
        self.assertEqual(agent_events, ["script_creative", "project_scheduler"])


if __name__ == "__main__":
    unittest.main()
