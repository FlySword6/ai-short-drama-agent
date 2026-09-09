"""FastAPI transport for the versioned Pi wrapper contract."""

from __future__ import annotations

import asyncio
import json
import uuid
from contextlib import asynccontextmanager
from dataclasses import asdict, replace
from pathlib import Path
from typing import Any, Literal

from fastapi import Depends, FastAPI, Header, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from .audit import AuditLog
from .auth import authenticate_bearer
from .config import Settings
from .contract import Message, PromptRequest, ToolCall, ToolDefinition, ToolResult
from .engine import AwaitingSourceEngine, InvalidContinuation, PiEngine, PiRpcEngine, RuntimeUnavailable
from .main_chain import MainChainAdapter, build_main_chain_adapter
from .skills import SkillNotFoundError, SkillRegistry
from .tool_bridge import ExternalToolBridge, StaleToolCallback


class MessageBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: Literal["system", "user", "assistant", "tool"]
    content: str


class ToolBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    description: str = ""
    inputSchema: dict[str, Any] = Field(default_factory=dict)


class ToolResultBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    toolCallId: str
    content: Any
    isError: bool = False


class PromptBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # ``message`` keeps both captured clients compatible while ``messages`` is
    # the product-facing conversation contract.
    message: str | None = None
    messages: list[MessageBody] = Field(default_factory=list)
    system: str | None = None
    tools: list[ToolBody] = Field(default_factory=list)
    toolResults: list[ToolResultBody] = Field(default_factory=list)
    conversationId: str | None = None

    def to_contract(self, *, conversation_id: str | None = None) -> PromptRequest:
        messages = [Message(**body.model_dump()) for body in self.messages]
        if self.message is not None:
            messages.append(Message(role="user", content=self.message))
        return PromptRequest(
            system=self.system,
            messages=messages,
            tools=[
                ToolDefinition(
                    name=body.name,
                    description=body.description,
                    input_schema=body.inputSchema,
                )
                for body in self.tools
            ],
            tool_results=[
                ToolResult(
                    tool_call_id=body.toolCallId,
                    content=body.content,
                    is_error=body.isError,
                )
                for body in self.toolResults
            ],
            conversation_id=conversation_id if conversation_id is not None else self.conversationId,
        )


class InternalToolCallBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    toolCallId: str
    name: str
    arguments: dict[str, Any] = Field(default_factory=dict)
    turnNonce: str
    conversationId: str


def create_app(
    *,
    settings: Settings | None = None,
    engine: PiEngine | None = None,
    bridge: ExternalToolBridge | None = None,
    main_chain: MainChainAdapter | None = None,
) -> FastAPI:
    settings = settings or Settings.from_environment()
    audit_log = AuditLog(settings.audit_log_path)
    registry = SkillRegistry(settings.skill_roots, settings.skill_state_path)
    bridge = bridge or ExternalToolBridge()
    main_chain = main_chain or build_main_chain_adapter(
        settings.main_environment,
        settings.main_agent_token,
    )
    if engine is None:
        engine = PiRpcEngine(
            bridge=bridge,
            context_path=settings.context_path,
            extension_path=Path(__file__).parent / "extensions" / "external-tools.ts",
            pi_bin=settings.pi_bin,
            command_timeout=settings.pi_command_timeout_seconds,
            internal_token=settings.internal_token,
            tool_callback_url=settings.tool_callback_url,
            skill_paths=registry.enabled_paths(),
            pending_turn_timeout=settings.tool_result_timeout_seconds,
        )
    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        del _app
        try:
            yield
        finally:
            if isinstance(engine, PiRpcEngine):
                engine.shutdown()

    app = FastAPI(title="Shortdrama Pi HTTP Wrapper", version="0.3.0", lifespan=lifespan)

    def authorize(authorization: str | None = Header(default=None)) -> str:
        token_id = authenticate_bearer(authorization, settings.bearer_tokens)
        if token_id is None:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Bearer token required")
        return token_id

    def authorize_internal(authorization: str | None = Header(default=None)) -> str:
        token_id = authenticate_bearer(authorization, (settings.internal_token,))
        if token_id is None:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Internal Bearer token required")
        return token_id

    def contract(body: PromptBody, conversation_id: str | None) -> PromptRequest:
        prompt = body.to_contract(conversation_id=conversation_id)
        if main_chain is None or prompt.tool_results:
            return prompt
        owned = {tool.name for tool in main_chain.definitions()}
        caller_tools = [tool for tool in prompt.tools if tool.name not in owned]
        return replace(prompt, tools=[*main_chain.definitions(), *caller_tools])

    def run_prompt(body: PromptBody, *, token_id: str, endpoint: str) -> dict[str, Any]:
        request_id = str(uuid.uuid4())
        conversation_id = body.conversationId
        if not body.toolResults and not conversation_id:
            conversation_id = str(uuid.uuid4())
        prompt = contract(body, conversation_id)
        try:
            response = engine.prompt_sync(prompt)
        except InvalidContinuation as error:
            audit_log.append(
                request_id=request_id,
                token_id=token_id,
                endpoint=endpoint,
                outcome=error.code,
            )
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={"code": error.code, "message": str(error), "requestId": request_id},
            ) from error
        except RuntimeUnavailable as error:
            audit_log.append(
                request_id=request_id,
                token_id=token_id,
                endpoint=endpoint,
                outcome="runtime_unavailable",
                metadata={"tool_count": len(prompt.tools), "tool_result_count": len(prompt.tool_results)},
            )
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail={"code": "runtime_unavailable", "message": str(error), "requestId": request_id},
            ) from error
        result = response.to_wire() | {"requestId": request_id}
        audit_log.append(
            request_id=request_id,
            token_id=token_id,
            endpoint=endpoint,
            outcome="ok",
            metadata={
                "tool_count": len(prompt.tools),
                "tool_result_count": len(prompt.tool_results),
                "returned_tool_call_count": len(response.tool_calls),
            },
        )
        return result

    @app.get("/health")
    @app.get("/healthz")
    def healthz() -> dict[str, Any]:
        runtime_status = engine.runtime_status() if isinstance(engine, PiRpcEngine) else "unavailable"
        return {
            "status": "ok" if runtime_status == "available" else "degraded",
            "source_status": "awaiting_source" if isinstance(engine, AwaitingSourceEngine) else "ready",
            "runtime_status": runtime_status,
            "main_api_status": "configured" if main_chain is not None else "unconfigured",
        }

    @app.post("/prompt/sync")
    @app.post("/pi/prompt/sync")
    def prompt_sync(body: PromptBody, token_id: str = Depends(authorize)) -> dict[str, Any]:
        return run_prompt(body, token_id=token_id, endpoint="/pi/prompt/sync")

    @app.post("/prompt")
    @app.post("/pi/prompt")
    def prompt_sse(body: PromptBody, token_id: str = Depends(authorize)) -> StreamingResponse:
        request_id = str(uuid.uuid4())
        conversation_id = body.conversationId
        if not body.toolResults and not conversation_id:
            conversation_id = str(uuid.uuid4())
        prompt = contract(body, conversation_id)

        def events():
            meta = {"type": "meta", "requestId": request_id, "conversationId": conversation_id}
            yield f"event: meta\ndata: {json.dumps(meta, ensure_ascii=False)}\n\n"
            iterator = None
            try:
                iterator = engine.prompt_events(prompt)
                for event in iterator:
                    event_type = str(event.get("type", "message"))
                    yield f"event: {event_type}\ndata: {json.dumps(event, ensure_ascii=False)}\n\n"
                audit_log.append(
                    request_id=request_id,
                    token_id=token_id,
                    endpoint="/pi/prompt",
                    outcome="ok",
                    metadata={"tool_count": len(prompt.tools), "tool_result_count": len(prompt.tool_results)},
                )
            except (InvalidContinuation, RuntimeUnavailable) as error:
                code = error.code if isinstance(error, InvalidContinuation) else "runtime_unavailable"
                audit_log.append(
                    request_id=request_id,
                    token_id=token_id,
                    endpoint="/pi/prompt",
                    outcome=code,
                )
                payload = {
                    "type": "error",
                    "code": code,
                    "message": str(error),
                    "requestId": request_id,
                    "retryable": isinstance(error, RuntimeUnavailable),
                }
                yield f"event: error\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"
            finally:
                if iterator is not None:
                    close = getattr(iterator, "close", None)
                    if callable(close):
                        close()

        return StreamingResponse(
            events(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @app.post("/internal/tool-calls", include_in_schema=False)
    async def receive_tool_call(
        body: InternalToolCallBody,
        _token_id: str = Depends(authorize_internal),
    ) -> dict[str, Any]:
        call = ToolCall(id=body.toolCallId, name=body.name, arguments=body.arguments)
        try:
            bridge.assert_active(
                turn_nonce=body.turnNonce,
                conversation_id=body.conversationId,
            )
            if main_chain is not None and main_chain.handles(call.name):
                result = await asyncio.to_thread(main_chain.execute, call)
            else:
                result = await asyncio.to_thread(
                    bridge.execute,
                    call,
                    turn_nonce=body.turnNonce,
                    conversation_id=body.conversationId,
                    timeout=settings.tool_result_timeout_seconds,
                )
        except StaleToolCallback as error:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={"code": "stale_tool_callback", "message": str(error)},
            ) from error
        return {"content": result.content, "isError": result.is_error}

    @app.get("/pi/skills")
    def list_skills(token_id: str = Depends(authorize)) -> dict[str, Any]:
        request_id = str(uuid.uuid4())
        skills = [asdict(skill) for skill in registry.list()]
        audit_log.append(
            request_id=request_id,
            token_id=token_id,
            endpoint="/pi/skills",
            outcome="ok",
            metadata={"skill_count": len(skills)},
        )
        return {"skills": skills, "requestId": request_id}

    def set_skill(skill_id: str, enabled: bool, token_id: str, endpoint: str) -> dict[str, Any]:
        request_id = str(uuid.uuid4())
        previous_enabled: bool | None = None
        try:
            previous = next((skill for skill in registry.list() if skill.id == skill_id), None)
            if previous is None:
                raise SkillNotFoundError(skill_id)
            previous_enabled = previous.enabled
            skill = registry.set_enabled(skill_id, enabled)
            if isinstance(engine, PiRpcEngine):
                engine.reload_skills(registry.enabled_paths())
        except SkillNotFoundError as error:
            audit_log.append(
                request_id=request_id,
                token_id=token_id,
                endpoint=endpoint,
                outcome="not_found",
            )
            raise HTTPException(status_code=404, detail="skill not found") from error
        except RuntimeError as error:
            if previous_enabled is not None:
                registry.set_enabled(skill_id, previous_enabled)
            audit_log.append(
                request_id=request_id,
                token_id=token_id,
                endpoint=endpoint,
                outcome="runtime_busy",
            )
            raise HTTPException(status_code=409, detail=str(error)) from error
        audit_log.append(
            request_id=request_id,
            token_id=token_id,
            endpoint=endpoint,
            outcome="ok",
            metadata={"skill_id": skill_id, "enabled": enabled},
        )
        return {"skill": asdict(skill), "requestId": request_id}

    @app.post("/pi/skills/{skill_id:path}/enable")
    def enable_skill(skill_id: str, token_id: str = Depends(authorize)) -> dict[str, Any]:
        return set_skill(skill_id, True, token_id, "/pi/skills/{id}/enable")

    @app.post("/pi/skills/{skill_id:path}/disable")
    def disable_skill(skill_id: str, token_id: str = Depends(authorize)) -> dict[str, Any]:
        return set_skill(skill_id, False, token_id, "/pi/skills/{id}/disable")

    return app


def main() -> None:
    import uvicorn

    settings = Settings.from_environment()
    uvicorn.run(create_app(settings=settings), host=settings.bind_host, port=settings.bind_port)
