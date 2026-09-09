# Copyright (c) 2025 Beijing Volcano Engine Technology Co., Ltd. and/or its affiliates.
#
# Licensed under the Apache License, Version 2.0 (the FreeLicense");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""A2A (Agent-to-Agent) 协议入口。

本文件复用 agent.py 中定义的 root_agent（知识库、长期记忆、思考链、
图片 markdown 渲染等能力全部保留），通过 A2A 协议对外提供服务。

与 agent.py 的区别：
- agent.py     → AgentkitAgentServerApp，暴露 HTTP /run_sse（SSE 流式）
- agent_a2a.py → VeA2AServer，暴露 A2A 协议
    - GET  /.well-known/agent-card.json  — Agent 名片（供其他 Agent 发现）
    - POST /                              — JSON-RPC 请求端点
    - GET  /ping                          — 健康检查（由 VeA2AServer 内置）

本地运行：
    .venv/bin/python agent_a2a.py

部署到火山云（将 entry_point 改为 agent_a2a.py）：
    .venv/bin/agentkit config \\
        --agent_name short_drama_asset_agent \\
        --entry_point 'agent_a2a.py' \\
        --runtime_envs DATABASE_VIKING_COLLECTION=role \\
        --runtime_envs DATABASE_VIKING_PROJECT=shortdrama \\
        --runtime_envs MODEL_AGENT_NAME=doubao-seed-2-0-pro-260215 \\
        --runtime_envs DATABASE_VIKINGMEM_COLLECTION=role_mem \\
        --launch_type cloud
    .venv/bin/agentkit launch

注意：
1. A2A 和 AgentServer 使用相同端口 8000，不能同时运行。
2. 需要 a2a-sdk>=0.3.7（已加入 requirements.txt）。
   注意 a2a-sdk 1.x 与 veadk 0.2.29 不兼容，必须用 0.x 版本。
"""

import io
import os
import sys

import uvicorn
from a2a.server.apps.jsonrpc.fastapi_app import A2AFastAPIApplication
from a2a.server.request_handlers.default_request_handler import DefaultRequestHandler
from a2a.server.tasks.inmemory_task_store import InMemoryTaskStore
from a2a.types import AgentCapabilities
from fastapi.middleware.cors import CORSMiddleware
from google.adk.a2a.converters.request_converter import (
    convert_a2a_request_to_agent_run_request,
)
from google.adk.a2a.executor import a2a_agent_executor
from google.adk.agents.run_config import RunConfig, StreamingMode
from google.adk.artifacts.in_memory_artifact_service import InMemoryArtifactService
from veadk.a2a.agent_card import get_agent_card
from veadk.runner import Runner

from short_drama_agent.tool_diagnostics import (
    log_startup_tool_diagnostics,
)
from short_drama_agent.local_server_security import (
    local_cors_origins,
    loopback_bind_host,
)


def _force_utf8_stdio() -> None:
    """Keep A2A runtimes from failing when FaaS defaults to ASCII streams."""
    for stream_name in ("stdout", "stderr"):
        stream = getattr(sys, stream_name, None)
        if isinstance(stream, io.TextIOBase) and stream.encoding != "utf-8":
            try:
                reconfigure = getattr(stream, "reconfigure", None)
                if callable(reconfigure):
                    reconfigure(encoding="utf-8", errors="replace")
            except ValueError:
                pass


_force_utf8_stdio()


# 复用 agent.py 中定义的 root_agent 和 short_term_memory。
# import agent 会触发模块级代码：patch ADK、连接知识库、连接记忆库、
# 创建 Runner 等。这些都是幂等操作，重复 import 无副作用。
# agent.py 末尾会创建 AgentkitAgentServerApp 实例，但不会自动启动
# （仅在 agent.py 作为 __main__ 时才 run），所以不影响本文件。
def _load_agent_runtime():
    from agent import APP_NAME, root_agent, short_term_memory

    return APP_NAME, root_agent, short_term_memory


APP_NAME, root_agent, short_term_memory = _load_agent_runtime()

# A2A 场景下需要给 Agent 一个有意义的 description，供其他 Agent 发现时识别。
# VeADK Agent 默认 description 是通用模板，这里覆盖为项目特定描述。
root_agent.description = (
    "漫剧资产管理 Agent。可基于知识库回答漫剧作品资料、角色设定、"
    "剧情内容、资产信息、标签分类和运营信息，并通过长期记忆记住用户的个人"
    "身份、偏好和过往交代的事项。"
)

# A2A 服务监听地址和端口
A2A_HOST = loopback_bind_host("A2A_HOST")
A2A_PORT = int(os.getenv("A2A_PORT", "8000"))
# This harness is local-only. Production Agent discovery must go through the
# authenticated platform backend, rather than exposing this A2A server.
A2A_URL = os.getenv("A2A_URL", f"http://{A2A_HOST}:{A2A_PORT}")


def _convert_a2a_request_to_streaming_run_request(request, part_converter):
    """Match ADK runner mode to the incoming A2A method.

    - message/stream → enable ADK SSE so clients receive incremental events
    - message/send   → disable ADK streaming and return one aggregated result
    """
    run_request = convert_a2a_request_to_agent_run_request(request, part_converter)
    if run_request.run_config is None:
        run_request.run_config = RunConfig()

    request_method = getattr(getattr(request, "call_context", None), "state", {}).get(
        "method"
    )
    run_request.run_config.streaming_mode = (
        StreamingMode.SSE if request_method == "message/stream" else StreamingMode.NONE
    )
    return run_request


# 构建 A2A FastAPI 应用，并显式声明 streaming 能力。
# veadk 0.2.29 默认生成的 AgentCard 未打开 capabilities.streaming，
# 同时默认 request_converter 也不会把 ADK Runner 切到 SSE streaming_mode。
# 这里手动接管两处配置：
#   1. AgentCard.capabilities.streaming = True
#   2. A2aAgentExecutor 使用自定义 request_converter，按 A2A method
#      在 message/send 与 message/stream 之间切换 Runner.streaming_mode
agent_card = get_agent_card(root_agent, A2A_URL)
agent_card.capabilities = agent_card.capabilities or AgentCapabilities()
agent_card.capabilities.streaming = True

executor_config_cls = getattr(a2a_agent_executor, "A2aAgentExecutorConfig")

agent_executor = a2a_agent_executor.A2aAgentExecutor(
    runner=Runner(
        agent=root_agent,
        app_name=APP_NAME,
        short_term_memory=short_term_memory,
        artifact_service=InMemoryArtifactService(),
    ),
    config=executor_config_cls(
        request_converter=_convert_a2a_request_to_streaming_run_request,
    ),
)

request_handler = DefaultRequestHandler(
    agent_executor=agent_executor,
    task_store=InMemoryTaskStore(),
)

app = A2AFastAPIApplication(
    agent_card=agent_card,
    http_handler=request_handler,
).build()

cors_origins = local_cors_origins("A2A_CORS_ORIGINS")
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


@app.on_event("startup")
async def startup_tool_diagnostics():
    """Log local ADK tools and MCP Router exposed tools at service startup."""
    await log_startup_tool_diagnostics(root_agent.tools)


@app.get("/list-apps")
async def list_apps():
    """Compatibility endpoint for AgentKit/ADK probes against A2A deployments."""
    return [APP_NAME]


@app.get("/apps/{app_name}")
async def get_app(app_name: str):
    """Return minimal app metadata for clients that probe ADK-style app routes."""
    if app_name != APP_NAME:
        return {"error": f"Unknown app: {app_name}"}
    return {
        "name": APP_NAME,
        "description": root_agent.description,
        "protocol": "a2a",
        "agent_card_url": f"{A2A_URL.rstrip('/')}/.well-known/agent-card.json",
    }


if __name__ == "__main__":
    if os.getenv("SHORTDRAMA_RESEARCH_RUNTIME") != "DEV" or os.getenv("SHORTDRAMA_RESEARCH_OPT_IN") != "1":
        raise SystemExit("A2A research runtime is disabled; set SHORTDRAMA_RESEARCH_RUNTIME=DEV and SHORTDRAMA_RESEARCH_OPT_IN=1")
    uvicorn.run(app, host=A2A_HOST, port=A2A_PORT)
