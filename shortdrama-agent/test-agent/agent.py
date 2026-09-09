import os

from agentkit.apps import AgentkitAgentServerApp
from fastapi.middleware.cors import CORSMiddleware
from veadk import Runner
from veadk.memory.short_term_memory import ShortTermMemory

from short_drama_agent.config import APP_NAME
from short_drama_agent.factory import create_root_agent
from short_drama_agent.local_server_security import (
    local_cors_origins,
    loopback_bind_host,
)
from short_drama_agent.runtime_patches import apply_runtime_patches

apply_runtime_patches()

# Public module-level objects are kept for AgentKit and A2A entrypoints.
root_agent, kb, long_term_memory = create_root_agent()

runner = Runner(
    agent=root_agent,
    app_name=APP_NAME,
    user_id="test_user",
)

short_term_memory = ShortTermMemory(backend="local")

agent_server_app = AgentkitAgentServerApp(
    agent=root_agent,
    short_term_memory=short_term_memory,
)


def _configure_agent_server_cors() -> None:
    """Allow only explicit local browser clients through ADK's Origin guard."""

    literal_origins = local_cors_origins("AGENT_SERVER_CORS_ORIGINS")

    agent_server_app.app.add_middleware(
        CORSMiddleware,
        allow_origins=literal_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
    )

    # AgentKit creates the ADK FastAPI app without exposing ADK's allow_origins
    # parameter, so adjust the existing private Origin guard to match CORS.
    for middleware in agent_server_app.app.user_middleware:
        if getattr(middleware.cls, "__name__", "") == "_OriginCheckMiddleware":
            middleware.kwargs["has_configured_allowed_origins"] = True
            middleware.kwargs["allowed_origins"] = literal_origins
            middleware.kwargs["allowed_origin_regex"] = None

    agent_server_app.app.middleware_stack = None


_configure_agent_server_cors()


if __name__ == "__main__":
    if os.getenv("SHORTDRAMA_RESEARCH_RUNTIME") != "DEV" or os.getenv("SHORTDRAMA_RESEARCH_OPT_IN") != "1":
        raise SystemExit("AgentKit research runtime is disabled; set SHORTDRAMA_RESEARCH_RUNTIME=DEV and SHORTDRAMA_RESEARCH_OPT_IN=1")
    agent_server_app.run(
        host=loopback_bind_host("AGENT_SERVER_HOST"),
        port=int(os.getenv("AGENT_SERVER_PORT", "8000")),
    )
