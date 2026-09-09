#!/usr/bin/env python3
"""
Multi-User Pi Agent Orchestrator - HTTP API Server

Provides a unified REST + SSE API that routes requests to per-user
pi RPC instances managed by MultiInstanceManager.

Usage:
    python3 server.py [--port PORT] [--host HOST]

Endpoints:
    POST /instances/start   - Start a user's pi process
    POST /instances/stop    - Stop a user's pi process
    POST /instances/stop-all- Stop all instances
    GET  /instances         - List all running instances
    GET  /users             - List all discovered tenants on disk
    POST /prompt            - Send prompt (X-Agent-Id + X-User-Id headers)
    POST /chat              - Auto-start + send prompt (convenience)
    GET  /events            - SSE event stream (per-user, via headers)
    POST /steer             - Queue steering message
    POST /abort             - Abort current operation
    POST /bash              - Execute bash command in workspace
    GET  /health            - Health check
"""

from __future__ import annotations

import asyncio
import hmac
import json
import os
import re
import subprocess
import time
import urllib.parse
import urllib.request
from pathlib import Path
from queue import Empty, Queue
from typing import AsyncIterator, Optional

from fastapi import FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import FileResponse, HTMLResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

from multi_instance_manager import MultiInstanceManager
from user_provision import provision_user, list_all_users, delete_user

# ── Configuration ──────────────────────────────────────────────────────────

DEFAULT_HOST = os.environ.get("PI_MULTI_HOST", "127.0.0.1")
DEFAULT_PORT = int(os.environ.get("PI_MULTI_PORT", "8001"))
DATA_ROOT = os.environ.get("PI_DATA_ROOT", "/var/lib/pi-http-wrapper/data")

# RemotePiProvider sync endpoint auth (required; refuses to start if unset)
PI_SYNC_TOKEN = os.environ.get("PI_SYNC_TOKEN", "")
PI_SYNC_AGENT_ID = os.environ.get("PI_SYNC_AGENT_ID", "")
PI_SYNC_USER_ID = os.environ.get("PI_SYNC_USER_ID", "")
if not PI_SYNC_TOKEN:
    raise RuntimeError("PI_SYNC_TOKEN is required. Set it in environment before starting.")


def _auth_ok_token(authorization: str | None) -> bool:
    """管理面统一 Bearer 鉴权：与 wrapper 的 authenticate_bearer 契约一致（hmac 常量时间比较）。"""
    if not authorization or not authorization.startswith("Bearer "):
        return False
    candidate = authorization.removeprefix("Bearer ").strip()
    return hmac.compare_digest(candidate, PI_SYNC_TOKEN)

# ── Shortdrama 会话认证 API ────────────────────────────────────────────────
# 注意：shortdrama-cli 0.0.2-beta 的 --profile 只对 login 写盘生效，status/refresh
# 读会话时永远读 $HOME/.config/shortdrama-cli/profiles/default.json（strace 实证）。
# 因此这里不用 --profile，而是给每次 CLI 调用注入独立的 HOME，实现每租户会话隔离：
#   $HOME = {SHORTDRAMA_SESSION_ROOT}/{user_id}
# 各租户的会话文件互不可见、无需全局锁，也天然避开了并发 swap default.json 的踩踏。
SHORTDRAMA_CLI = os.environ.get(
    "SHORTDRAMA_CLI", f"{DATA_ROOT}/.shortdrama/bin/shortdrama-cli"
)
SHORTDRAMA_ENV = os.environ.get("SHORTDRAMA_ENV", "").strip()
if os.environ.get("SHORTDRAMA_API_BASE", "").strip():
    raise RuntimeError(
        "SHORTDRAMA_API_BASE 已不再支持：shortdrama-cli 不再接受任意 URL，"
        "请改用 SHORTDRAMA_ENV 指定受信环境名（prod/test/dev），"
        "后端地址由 CLI 内置的受信端点清单决定。",
    )
if ":" in SHORTDRAMA_ENV or "/" in SHORTDRAMA_ENV:
    raise RuntimeError(
        f"SHORTDRAMA_ENV 不接受 URL（收到：{SHORTDRAMA_ENV}），只接受受信环境名：prod、test、dev。",
    )
SHORTDRAMA_SESSION_ROOT = os.environ.get(
    "SHORTDRAMA_SESSION_ROOT", f"{DATA_ROOT}/.shortdrama-sessions"
)
AUTH_TIMEOUT_STATUS = 20
AUTH_TIMEOUT_LOGIN = 45
AUTH_TIMEOUT_REFRESH = 20
# user_id 会拼进 HOME 路径，必须白名单校验，防路径穿越
_USER_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")

# 产物下载主机白名单：仅允许 https 访问这些域名，防止 SSRF（逗号分隔）。
# 默认空（禁用任意下载）；部署时按需用 DOWNLOAD_ALLOWED_HOSTS 显式指定资产域名。
DOWNLOAD_ALLOWED_HOSTS = {
    h.strip().lower()
    for h in os.environ.get("DOWNLOAD_ALLOWED_HOSTS", "").split(",")
    if h.strip()
}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """拒绝一切 HTTP 重定向，防 SSRF 白名单被 30x Location 绕过。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_DOWNLOAD_OPENER = urllib.request.build_opener(_NoRedirect)


def _validated_user_id(user_id: str) -> str:
    """user_id 白名单校验，拒绝路径穿越与非法字符。"""
    uid = (user_id or "").strip()
    if not uid or uid in (".", "..") or not _USER_ID_RE.match(uid):
        raise HTTPException(status_code=400, detail=f"invalid user_id: {user_id!r}")
    return uid


# ── Global Manager ─────────────────────────────────────────────────────────

manager = MultiInstanceManager(data_root=DATA_ROOT)


# ── Data Models ────────────────────────────────────────────────────────────


class InstanceStartRequest(BaseModel):
    agent_id: str = Field(alias="agent_id")
    user_id: str = Field(alias="user_id")


class PromptRequest(BaseModel):
    message: str
    images: Optional[list[dict]] = None


class SteerRequest(BaseModel):
    message: str


class BashRequest(BaseModel):
    command: str


class PiPromptSyncRequest(BaseModel):
    prompt: str = Field(description="User prompt to send")
    conversationId: Optional[str] = Field(default=None, description="Conversation ID for continuing")
    toolResults: Optional[list[dict]] = Field(default=None, description="Tool execution results to feed back")
    images: Optional[list[dict]] = Field(default=None, description="Base64 images")


class PiChatMessage(BaseModel):
    role: str
    content: str


class PiChatSyncRequest(BaseModel):
    """OpenAI-compatible chat format accepted by RemotePiProvider clients."""
    system: Optional[str] = Field(default=None)
    messages: list[dict] = Field(default_factory=list)
    tools: Optional[list[dict]] = Field(default=None)
    toolResults: Optional[list[dict]] = Field(default=None)
    conversationId: Optional[str] = Field(default=None)


class AuthLoginRequest(BaseModel):
    user_id: str
    username: str
    password: str


class AuthRefreshRequest(BaseModel):
    user_id: str


# ── FastAPI App ────────────────────────────────────────────────────────────


app = FastAPI(
    title="Pi Agent Multi-User Orchestrator",
    description="REST + SSE API for managing multiple per-user pi RPC instances",
    version="0.1.0",
)


# ── Auth middleware ───────────────────────────────────────────────────────
# 除公开白名单外，所有端点统一要求 Authorization: Bearer <PI_SYNC_TOKEN>。
# 修复审查硬伤 /bash 等管理端点裸奔问题。公开端点仅限：根页面、文档、
# 健康检查与 shortdrama 会话登录/刷新（这些本来就走独立口令流程）。
_PUBLIC_PATHS = {
    "/",
    "/doc/p3",
    "/dashboard",
    "/health",
    "/auth/status",
    "/api/auth/status",
    "/auth/login",
    "/api/auth/login",
    "/auth/refresh",
    "/api/auth/refresh",
}


@app.middleware("http")
async def admin_auth_middleware(request: Request, call_next):
    path = request.url.path
    if path in _PUBLIC_PATHS or path.startswith("/docs") or path.startswith("/redoc") or path == "/openapi.json":
        return await call_next(request)

    authorization = request.headers.get("Authorization")
    if not _auth_ok_token(authorization):
        return Response(
            status_code=401,
            content=json.dumps({"detail": "Invalid or missing Bearer token"}),
            media_type="application/json",
        )
    return await call_next(request)


# ── Helpers ────────────────────────────────────────────────────────────────


def _require_headers(agent_id: Optional[str], user_id: Optional[str]):
    """Validate required X-Agent-Id and X-User-Id headers."""
    if not agent_id or not user_id:
        raise HTTPException(
            status_code=400,
            detail="X-Agent-Id and X-User-Id headers are required",
        )


def _download_task_outputs(event: dict):
    """如果 SSE 事件包含 task get 产物 URL，下载到 per-user outputs/ 目录。

    在 _event_stream 中对每个事件调用。检查 tool_result/bash_result
    类型事件中是否包含 shortdrama-cli task get 的 JSON 输出 URL，
    若发现则 curl 下载到 {DATA_ROOT}/{agent_id}/{user_id}/outputs/。
    """
    import re
    import subprocess

    # 只处理 tool_result / bash_result 类型
    event_type = event.get("type", "")
    if event_type not in ("tool_result", "tool_output", "bash_result"):
        return

    # 提取文本内容
    content = event.get("content", event.get("output", event.get("data", "")))
    if isinstance(content, dict):
        content = json.dumps(content)
    if not content or not isinstance(content, str):
        return

    # 用正则提取 JSON 格式的 url / result_url / output_url / download_url
    urls = re.findall(
        r'"(?:url|result_url|output_url|download_url)"\s*:\s*"([^"]+)"',
        content
    )
    if not urls:
        return

    # 从 session_key 解析 user_id
    session_key = event.get("_session_key", "")
    parts = session_key.split("/")
    if len(parts) < 2:
        return
    user_id = parts[1]

    user_outputs = Path(DATA_ROOT) / "agent-a" / user_id / "outputs"
    user_outputs.mkdir(parents=True, exist_ok=True)

    for url in urls:
        if not url or url.startswith("mock"):
            continue
        try:
            parsed = urllib.parse.urlparse(url)
            # SSRF 防护：仅允许 https，且主机必须在白名单内
            if parsed.scheme != "https":
                print(f"[download_task_outputs] {user_id}: SKIP non-https {url}")
                continue
            host = (parsed.hostname or "").lower()
            if host not in DOWNLOAD_ALLOWED_HOSTS:
                print(f"[download_task_outputs] {user_id}: SKIP disallowed host {url}")
                continue
            fname = parsed.path.split("/")[-1]
            if not fname or fname in (".", ".."):
                fname = "download"
            dest = user_outputs / fname
            # no-redirect opener：3xx 一律抛 HTTPError，不跟随 Location
            with _DOWNLOAD_OPENER.open(url, timeout=30) as resp:
                dest.write_bytes(resp.read())
            print(f"[download_task_outputs] {user_id}: {url} -> {dest}")
        except Exception as e:
            print(f"[download_task_outputs] {user_id}: error {url}: {e}")


def _require_running(agent_id: str, user_id: str):
    """Ensure the instance exists and is running."""
    inst = manager.get_instance(agent_id, user_id)
    if inst is None:
        raise HTTPException(
            status_code=404,
            detail=f"Instance {agent_id}/{user_id} not found. Start it first: POST /instances/start",
        )
    if not inst._running:
        raise HTTPException(
            status_code=409,
            detail=f"Instance {agent_id}/{user_id} is not running (status: {inst.status})",
        )
    return inst


async def _event_stream(subscriber_queue: Queue, stop_event: asyncio.Event) -> AsyncIterator[str]:
    """Yield SSE-formatted events from a subscriber queue."""
    loop = asyncio.get_event_loop()
    while not stop_event.is_set():
        try:
            event = await loop.run_in_executor(None, lambda: subscriber_queue.get(timeout=0.2))
        except Empty:
            yield f": heartbeat {time.time()}\n\n"
            continue

        # ── P3: 产物下载回调（在 yield 前检查 task 产物 URL）──
        try:
            _download_task_outputs(event)
        except Exception:
            pass  # 下载失败不阻塞 SSE 流

        event_type = event.get("type", "unknown")
        payload = json.dumps(event, ensure_ascii=False)
        yield f"event: {event_type}\ndata: {payload}\n\n"

        if event_type == "agent_settled":
            break

    yield "event: done\ndata: {}\n\n"


# ── Endpoints ──────────────────────────────────────────────────────────────


@app.get("/")
async def index():
    """Service info."""
    return {
        "service": "Pi Agent Multi-User Orchestrator",
        "version": "0.1.0",
        "endpoints": {
            "health": "GET /health",
            "users": "GET /users",
            "instances": "GET /instances",
            "start": "POST /instances/start",
            "stop": "POST /instances/stop",
            "stop_all": "POST /instances/stop-all",
            "prompt": "POST /prompt",
            "chat": "POST /chat",
            "events": "GET /events",
            "steer": "POST /steer",
            "abort": "POST /abort",
            "bash": "POST /bash",
        },
    }


@app.get("/doc/p3")
async def doc_p3():
    """Serve P3 documentation."""
    doc_path = Path(DATA_ROOT) / "P3-演进总结与测试文档.md"
    if not doc_path.exists():
        raise HTTPException(status_code=404, detail="Document not found")
    return FileResponse(doc_path, media_type="text/markdown; charset=utf-8", filename="p3.md")


@app.get("/dashboard")
async def dashboard():
    """实时仪表盘：展示三个角色用户的 agent 状态和最近 session。"""
    dash_path = Path("/opt/shortdrama-demo/frontend/dashboard.html")
    if not dash_path.exists():
        raise HTTPException(status_code=404, detail="Dashboard not found")
    return FileResponse(dash_path, media_type="text/html; charset=utf-8")


@app.get("/health")
async def health():
    """Health check with instance summary."""
    instances = manager.list_instances()
    active = [i for i in instances if i["status"] in ("ready", "busy", "starting")]
    return {
        "status": "ok",
        "active_instances": len(active),
        "total_instances": len(instances),
        "instances": instances,
    }


@app.get("/users")
async def list_users():
    """List all discovered tenant directories on disk."""
    users = manager.discover_users()
    provisioned = list_all_users()
    # 合并发现的和自举的
    return {
        "count": len(users),
        "users": users,
        "provisioned": provisioned,
    }


# ── 用户自举 API ──────────────────────────────────────────────────────

@app.post("/api/users/auto-provision")
async def api_auto_provision(body: dict = None):
    """自动创建新用户：分配 ID、端口、目录、nginx、pi-web、pi 进程。
    
    body: {"role": "art|director|writer", "project_id": "drama-001"}
    """
    role = (body or {}).get("role", "art")
    project_id = (body or {}).get("project_id", None)
    if role not in ["art", "director", "writer"]:
        raise HTTPException(status_code=400, detail=f"invalid role: {role}")
    try:
        meta = provision_user(role=role, project_id=project_id)
        user_id = meta["user_id"]
        agent_id = meta["agent_id"]

        # 自动启动 pi 进程
        result = manager.start_instance(agent_id, user_id)
        meta["pi_instance"] = result
        if result.get("success"):
            meta["status"] = "active"
        else:
            meta["status"] = "provisioned_no_instance"

        return {"success": True, "user": meta}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/users")
async def api_list_users():
    """列出所有已自举的用户。"""
    return {"users": list_all_users()}


@app.get("/api/users/{user_id}")
async def api_get_user(user_id: str):
    """查看单个用户的 meta 信息。"""
    uid = _validated_user_id(user_id)
    meta_path = Path(DATA_ROOT) / "agent-a" / uid / "meta.json"
    if meta_path.exists():
        return json.loads(meta_path.read_text())
    raise HTTPException(status_code=404, detail="user not found")


@app.delete("/api/users/{user_id}")
async def api_delete_user(user_id: str):
    """删除用户：停止 pi 进程、清理 nginx 路由和目录。"""
    uid = _validated_user_id(user_id)
    # 先停止 pi 进程
    try:
        manager.stop_instance("agent-a", uid)
    except Exception:
        pass
    success, message = delete_user(uid)
    if success:
        return {"success": True, "message": message}
    raise HTTPException(status_code=404, detail=message)


@app.get("/instances")
async def list_instances():
    """List all tracked instances (running or stopped)."""
    instances = manager.list_instances()
    active = [i for i in instances if i["status"] != "stopped"]
    return {
        "count": len(instances),
        "active_count": len(active),
        "instances": instances,
    }


@app.post("/instances/start")
async def start_instance(req: InstanceStartRequest):
    """Start a user's pi RPC process."""
    result = manager.start_instance(req.agent_id, req.user_id)
    if not result["success"]:
        raise HTTPException(
            status_code=500,
            detail=result["instance"].get("error", "Failed to start instance"),
        )
    return result


@app.post("/instances/stop")
async def stop_instance(
    x_agent_id: Optional[str] = Header(None, alias="X-Agent-Id"),
    x_user_id: Optional[str] = Header(None, alias="X-User-Id"),
):
    """Stop a user's pi RPC process."""
    _require_headers(x_agent_id, x_user_id)
    result = manager.stop_instance(x_agent_id, x_user_id)
    if not result["success"]:
        raise HTTPException(status_code=404, detail=result["error"])
    return result


@app.post("/instances/stop-all")
async def stop_all_instances():
    """Stop all running instances."""
    result = manager.stop_all()
    return result


@app.post("/prompt")
async def send_prompt(
    req: PromptRequest,
    x_agent_id: Optional[str] = Header(None, alias="X-Agent-Id"),
    x_user_id: Optional[str] = Header(None, alias="X-User-Id"),
):
    """
    Send a prompt to a specific user's agent.
    Requires X-Agent-Id and X-User-Id headers.
    Returns acknowledgment; subscribe to GET /events for streaming output.
    """
    _require_headers(x_agent_id, x_user_id)
    _require_running(x_agent_id, x_user_id)

    result = manager.send_prompt(x_agent_id, x_user_id, req.message, req.images)
    if not result.get("success"):
        raise HTTPException(status_code=500, detail=result.get("error", "Failed to send prompt"))
    return {
        "status": "accepted",
        "session_key": f"{x_agent_id}/{x_user_id}",
        "message": "Prompt sent. Subscribe to GET /events for streaming output.",
    }


@app.post("/chat")
async def chat(
    req: PromptRequest,
    x_agent_id: Optional[str] = Header(None, alias="X-Agent-Id"),
    x_user_id: Optional[str] = Header(None, alias="X-User-Id"),
):
    """
    Convenience endpoint: auto-start instance if needed, then send prompt.
    Returns SSE stream directly.
    """
    _require_headers(x_agent_id, x_user_id)

    # Auto-start if not running
    inst = manager.get_instance(x_agent_id, x_user_id)
    if inst is None or not inst._running:
        result = manager.start_instance(x_agent_id, x_user_id)
        if not result["success"]:
            raise HTTPException(
                status_code=500,
                detail=f"Failed to start instance: {result['instance'].get('error')}",
            )

    # Subscribe BEFORE sending prompt
    sub_result = manager.subscribe(x_agent_id, x_user_id)
    if sub_result is None:
        raise HTTPException(status_code=500, detail="Failed to subscribe to instance events")
    q, _ = sub_result

    stop_event = asyncio.Event()

    # Send prompt
    prompt_result = manager.send_prompt(x_agent_id, x_user_id, req.message, req.images)
    if not prompt_result.get("success"):
        manager.unsubscribe(x_agent_id, x_user_id, q)
        raise HTTPException(status_code=500, detail=prompt_result.get("error", "Failed to send prompt"))

    async def cleanup_and_stream():
        try:
            async for chunk in _event_stream(q, stop_event):
                yield chunk
        finally:
            manager.unsubscribe(x_agent_id, x_user_id, q)

    return StreamingResponse(
        cleanup_and_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/events")
async def event_stream(
    x_agent_id: Optional[str] = Header(None, alias="X-Agent-Id"),
    x_user_id: Optional[str] = Header(None, alias="X-User-Id"),
):
    """
    Subscribe to SSE event stream for a specific user's agent.
    Requires X-Agent-Id and X-User-Id headers.
    Stream terminates when agent_settled is received.
    """
    _require_headers(x_agent_id, x_user_id)

    sub_result = manager.subscribe(x_agent_id, x_user_id)
    if sub_result is None:
        raise HTTPException(
            status_code=404,
            detail=f"Instance {x_agent_id}/{x_user_id} not found or not running",
        )

    q, _ = sub_result
    stop_event = asyncio.Event()

    async def cleanup_and_stream():
        try:
            async for chunk in _event_stream(q, stop_event):
                yield chunk
        finally:
            manager.unsubscribe(x_agent_id, x_user_id, q)

    return StreamingResponse(
        cleanup_and_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/steer")
async def steer(
    req: SteerRequest,
    x_agent_id: Optional[str] = Header(None, alias="X-Agent-Id"),
    x_user_id: Optional[str] = Header(None, alias="X-User-Id"),
):
    """Queue a steering message to a user's agent."""
    _require_headers(x_agent_id, x_user_id)
    result = manager.send_steer(x_agent_id, x_user_id, req.message)
    if not result.get("success"):
        raise HTTPException(status_code=500, detail=result.get("error"))
    return result


@app.post("/abort")
async def abort(
    x_agent_id: Optional[str] = Header(None, alias="X-Agent-Id"),
    x_user_id: Optional[str] = Header(None, alias="X-User-Id"),
):
    """Abort the current operation for a user's agent."""
    _require_headers(x_agent_id, x_user_id)
    result = manager.send_abort(x_agent_id, x_user_id)
    if not result.get("success"):
        raise HTTPException(status_code=500, detail=result.get("error"))
    return result


@app.post("/pi/prompt/sync")
async def pi_prompt_sync(
    req: PiPromptSyncRequest,
    authorization: Optional[str] = Header(None, alias="Authorization"),
):
    """
    RemotePiProvider sync endpoint.

    Sends a prompt to a pi RPC instance and returns the result synchronously.
    Used by zhongwen-shortdrama RemotePiProvider to offload LLM inference to
    this ECS pi instance while keeping tool execution and auditing local.

    Protocol:
      Request:  { prompt, conversationId?, toolResults?, images? }
      Response: { status, text?, thinking?, toolCalls?, conversationId, usage? }

    Auth: Bearer token matching PI_SYNC_TOKEN.
    """
    # ── Auth ──────────────────────────────────────────────────────────
    if PI_SYNC_TOKEN:
        expected = f"Bearer {PI_SYNC_TOKEN}"
        if not authorization or not hmac.compare_digest(authorization, expected):
            raise HTTPException(status_code=401, detail="Invalid or missing token")

    # ── Ensure instance is running ────────────────────────────────────
    inst = manager.get_instance(PI_SYNC_AGENT_ID, PI_SYNC_USER_ID)
    if inst is None or not inst._running:
        result = manager.start_instance(PI_SYNC_AGENT_ID, PI_SYNC_USER_ID)
        if not result["success"]:
            raise HTTPException(status_code=503, detail="Pi instance unavailable")
        inst = manager.get_instance(PI_SYNC_AGENT_ID, PI_SYNC_USER_ID)

    # ── Build prompt message ──────────────────────────────────────────
    message = req.prompt
    if req.toolResults:
        # Feed tool results back as a follow-up message
        tool_text = "Tool execution results:\n" + json.dumps(req.toolResults, indent=2)
        message = tool_text

    if req.conversationId:
        # Continue existing conversation
        message = f"[conversationId: {req.conversationId}] {message}"

    # ── Subscribe to events ───────────────────────────────────────────
    sub_result = manager.subscribe(PI_SYNC_AGENT_ID, PI_SYNC_USER_ID)
    if sub_result is None:
        raise HTTPException(status_code=503, detail="Cannot subscribe to instance")
    q, _ = sub_result

    # ── Send prompt ───────────────────────────────────────────────────
    prompt_result = manager.send_prompt(
        PI_SYNC_AGENT_ID, PI_SYNC_USER_ID, message,
        images=req.images, timeout=30
    )
    if not prompt_result.get("success"):
        manager.unsubscribe(PI_SYNC_AGENT_ID, PI_SYNC_USER_ID, q)
        raise HTTPException(status_code=503, detail=prompt_result.get("error", "Prompt rejected"))

    # ── Collect events synchronously ──────────────────────────────────
    collected_text = ""
    collected_thinking = ""
    tool_calls = []
    usage = None
    status = "processing"
    conversation_id = None
    timeout_at = time.time() + 300  # 5 min max

    try:
        while time.time() < timeout_at:
            try:
                event = q.get(timeout=1)
            except Empty:
                if inst._running and inst.status == "ready":
                    # Agent might have finished without sending agent_end
                    break
                continue

            etype = event.get("type", "")

            # ── Text/thinking deltas ──────────────────────────────
            if etype == "message_update":
                sub = event.get("assistantMessageEvent", {})
                if sub.get("type") == "text_delta":
                    collected_text += sub.get("delta", "")
                elif sub.get("type") == "thinking_delta":
                    collected_thinking += sub.get("delta", "")

            # ── Tool calls ────────────────────────────────────────
            elif etype == "tool_execution_start":
                tc = {
                    "id": event.get("toolCallId", ""),
                    "name": event.get("toolName", ""),
                    "arguments": event.get("input", {}),
                }
                tool_calls.append(tc)

            elif etype == "tool_execution_end":
                # Attach result to the last matching tool call
                for tc in reversed(tool_calls):
                    if tc["id"] == event.get("toolCallId", ""):
                        tc["result"] = event.get("output", "")
                        tc["isError"] = event.get("isError", False)
                        break

            # ── Usage ─────────────────────────────────────────────
            elif etype == "turn_end":
                u = event.get("usage", {})
                if u:
                    usage = {
                        "input": u.get("inputTokens", 0),
                        "output": u.get("outputTokens", 0),
                        "cacheRead": u.get("cacheReadTokens", 0),
                    }

            # ── Agent finished ────────────────────────────────────
            elif etype == "agent_end":
                status = "done"
                conversation_id = conversation_id or event.get("sessionId", "")
                break

            elif etype == "agent_settled":
                status = "done"
                break

            # ── Track conversation ─────────────────────────────────
            if etype == "message_start":
                msg = event.get("message", {})
                if msg.get("role") == "user":
                    # Store conversation id from first user message
                    pass

        else:
            # Timeout
            status = "timeout"

    finally:
        manager.unsubscribe(PI_SYNC_AGENT_ID, PI_SYNC_USER_ID, q)

    # ── Build response ────────────────────────────────────────────────
    resp = {
        "status": "requires_tool" if tool_calls and status != "done" else status,
        "conversationId": conversation_id or req.conversationId or "",
    }
    if collected_text:
        resp["text"] = collected_text.strip()
    if collected_thinking:
        resp["thinking"] = collected_thinking.strip()
    if tool_calls:
        resp["toolCalls"] = tool_calls
    if usage:
        resp["usage"] = usage

    return resp


@app.post("/pi/chat")
async def pi_chat_sync(
    req: PiChatSyncRequest,
    authorization: Optional[str] = Header(None, alias="Authorization"),
):
    """
    RemotePiProvider chat endpoint — accepts OpenAI-compatible format.

    Converts {system, messages, tools, toolResults} → prompt for pi,
    then returns the synchronous result in OpenAI-compatible shape.

    Protocol:
      Request:  { system?, messages: [{role, content}], tools?, toolResults?, conversationId? }
      Response: { status, text?, thinking?, toolCalls?, conversationId, usage?, message? }

    Auth: Bearer token matching PI_SYNC_TOKEN.
    """
    # ── Auth ──────────────────────────────────────────────────────────
    if PI_SYNC_TOKEN:
        expected = f"Bearer {PI_SYNC_TOKEN}"
        if not authorization or not hmac.compare_digest(authorization, expected):
            raise HTTPException(status_code=401, detail="Invalid or missing token")

    # ── Ensure instance is running ────────────────────────────────────
    inst = manager.get_instance(PI_SYNC_AGENT_ID, PI_SYNC_USER_ID)
    if inst is None or not inst._running:
        result = manager.start_instance(PI_SYNC_AGENT_ID, PI_SYNC_USER_ID)
        if not result["success"]:
            raise HTTPException(status_code=503, detail="Pi instance unavailable")
        inst = manager.get_instance(PI_SYNC_AGENT_ID, PI_SYNC_USER_ID)

    # ── Convert chat messages to prompt ───────────────────────────────
    prompt_parts = []
    if req.system:
        prompt_parts.append(f"[System Instructions]\n{req.system}")
    if req.conversationId:
        prompt_parts.append(f"[Conversation: {req.conversationId}]")
    if req.toolResults:
        tool_text = "Tool execution results:\n" + json.dumps(req.toolResults, indent=2, ensure_ascii=False)
        prompt_parts.append(tool_text)
    for msg in req.messages:
        role = msg.get("role", "user")
        content = msg.get("content", "")
        if isinstance(content, list):
            # Multimodal content blocks → extract text
            text_parts = []
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    text_parts.append(block.get("text", ""))
            content = "\n".join(text_parts)
        tag = {"user": "User", "assistant": "Assistant", "system": "System"}.get(role, role.title())
        prompt_parts.append(f"[{tag}]\n{content}")
    message = "\n\n".join(prompt_parts)

    # ── Subscribe to events ───────────────────────────────────────────
    sub_result = manager.subscribe(PI_SYNC_AGENT_ID, PI_SYNC_USER_ID)
    if sub_result is None:
        raise HTTPException(status_code=503, detail="Cannot subscribe to instance")
    q, _ = sub_result

    # ── Send prompt ───────────────────────────────────────────────────
    prompt_result = manager.send_prompt(
        PI_SYNC_AGENT_ID, PI_SYNC_USER_ID, message,
        timeout=30
    )
    if not prompt_result.get("success"):
        manager.unsubscribe(PI_SYNC_AGENT_ID, PI_SYNC_USER_ID, q)
        raise HTTPException(status_code=503, detail=prompt_result.get("error", "Prompt rejected"))

    # ── Collect events synchronously ──────────────────────────────────
    collected_text = ""
    collected_thinking = ""
    tool_calls = []
    usage = None
    status = "processing"
    conversation_id = None
    timeout_at = time.time() + 300

    try:
        while time.time() < timeout_at:
            try:
                event = q.get(timeout=1)
            except Empty:
                if inst._running and inst.status == "ready":
                    break
                continue

            etype = event.get("type", "")

            if etype == "message_update":
                sub = event.get("assistantMessageEvent", {})
                if sub.get("type") == "text_delta":
                    collected_text += sub.get("delta", "")
                elif sub.get("type") == "thinking_delta":
                    collected_thinking += sub.get("delta", "")

            elif etype == "tool_execution_start":
                tc = {
                    "id": event.get("toolCallId", ""),
                    "name": event.get("toolName", ""),
                    "arguments": event.get("input", {}),
                }
                tool_calls.append(tc)

            elif etype == "tool_execution_end":
                for tc in reversed(tool_calls):
                    if tc["id"] == event.get("toolCallId", ""):
                        tc["result"] = event.get("output", "")
                        tc["isError"] = event.get("isError", False)
                        break

            elif etype == "turn_end":
                u = event.get("usage", {})
                if u:
                    usage = {
                        "input": u.get("inputTokens", 0),
                        "output": u.get("outputTokens", 0),
                        "cacheRead": u.get("cacheReadTokens", 0),
                    }

            elif etype in ("agent_end", "agent_settled"):
                status = "done"
                conversation_id = conversation_id or event.get("sessionId", "")
                break

            if etype == "message_start":
                msg = event.get("message", {})
                if msg.get("role") == "assistant" and not conversation_id:
                    conversation_id = event.get("sessionId", "")

        else:
            status = "timeout"

    finally:
        manager.unsubscribe(PI_SYNC_AGENT_ID, PI_SYNC_USER_ID, q)

    # ── Build OpenAI-compatible response ──────────────────────────────
    resp = {
        "status": "requires_tool" if tool_calls and status != "done" else status,
        "conversationId": conversation_id or req.conversationId or "",
    }
    if collected_text:
        resp["text"] = collected_text.strip()
        resp["message"] = {"role": "assistant", "content": collected_text.strip()}
    if collected_thinking:
        resp["thinking"] = collected_thinking.strip()
    if tool_calls:
        resp["toolCalls"] = tool_calls
    if usage:
        resp["usage"] = usage

    return resp


@app.post("/bash")
async def run_bash(
    req: BashRequest,
    x_agent_id: Optional[str] = Header(None, alias="X-Agent-Id"),
    x_user_id: Optional[str] = Header(None, alias="X-User-Id"),
):
    """Execute a bash command in the user's workspace."""
    _require_headers(x_agent_id, x_user_id)
    result = manager.send_bash(x_agent_id, x_user_id, req.command)
    if not result.get("success"):
        raise HTTPException(status_code=500, detail=result.get("error"))
    return result


# ── Shortdrama 会话认证端点 ───────────────────────────────────────────────


def _session_home(user_id: str) -> str:
    """每租户独立的 CLI 会话 HOME（含 .config/shortdrama-cli/profiles/）。"""
    home = os.path.join(SHORTDRAMA_SESSION_ROOT, user_id)
    os.makedirs(home, mode=0o700, exist_ok=True)
    return home


def _run_cli(user_id: str, args: list, input_text: str | None = None,
             timeout: float = AUTH_TIMEOUT_STATUS):
    """以租户独立 HOME 运行 shortdrama-cli。密码只经 stdin，绝不进 argv。"""
    env = dict(os.environ)
    env["HOME"] = _session_home(user_id)
    # 不注显式 --env：pinned CLI（fe3019b）的 --env 是根 callback 选项，只能出现在
    # 子命令之前；环境选择由随 env 继承到子进程的 SHORTDRAMA_ENV 环境变量完成
    # （CLI 优先级：--env > SHORTDRAMA_ENV > sticky login > prod）。
    cmd = [SHORTDRAMA_CLI, *args, "--json"]
    return subprocess.run(
        cmd,
        input=input_text,
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def _parse_cli_stdout(raw: str) -> dict:
    """解析 CLI stdout。auth login 缺省 --password 时 getpass 会把 'Password:'
    提示写到 stdout（无换行直接接 JSON），必须先剥掉；失败路径 stdout 可能为
    空或只有 'Password:'，统一兜底为 {}。"""
    if not raw:
        return {}
    s = raw.lstrip("\ufeff \t\r\n")
    if s.startswith("Password:"):
        s = s[len("Password:"):].lstrip()
    try:
        out = json.loads(s)
        return out if isinstance(out, dict) else {}
    except Exception:
        return {}


def _auth_ok(out: dict) -> bool:
    """login/refresh 的成功回执没有 authenticated 字段，用 status+token_stored 判定。"""
    return bool(out.get("status") == "succeeded"
                and out.get("session", {}).get("token_stored"))


@app.get("/auth/status")
@app.get("/api/auth/status")
async def auth_status(user_id: str = Query(...)):
    """查询某租户的 shortdrama 会话状态（只读，读该租户独立 HOME 的 default.json）。"""
    uid = _validated_user_id(user_id)
    try:
        r = _run_cli(uid, ["auth", "status"], timeout=AUTH_TIMEOUT_STATUS)
    except (subprocess.TimeoutExpired, OSError):
        return {"authenticated": False, "profile": uid, "account": None}
    out = _parse_cli_stdout(r.stdout)
    return {
        "authenticated": bool(out.get("authenticated", False)),
        "profile": uid,
        "account": out.get("account"),
    }


@app.post("/auth/login")
@app.post("/api/auth/login")
async def auth_login(req: AuthLoginRequest):
    """登录：密码经 stdin 传给 shortdrama-cli（不进 argv，ps aux 不可见）。
    成功时把会话写入该租户独立 HOME，供后续 status/refresh 使用。"""
    uid = _validated_user_id(req.user_id)
    # 去掉传输层可能带入的换行，避免 getpass 把 \n 读进密码
    password = (req.password or "").rstrip("\r\n")
    try:
        r = _run_cli(uid, ["auth", "login", "--username", req.username],
                     input_text=password, timeout=AUTH_TIMEOUT_LOGIN)
    except (subprocess.TimeoutExpired, OSError):
        return {"authenticated": False, "profile": uid, "account": None}
    out = _parse_cli_stdout(r.stdout)
    return {
        "authenticated": _auth_ok(out),
        "profile": uid,
        "account": None,  # login 回执不含账号信息，前端可接着调 status
    }


@app.post("/auth/refresh")
@app.post("/api/auth/refresh")
async def auth_refresh(req: AuthRefreshRequest):
    """刷新该租户会话 token。注意 refresh 回执没有 authenticated 字段，
    以 status==succeeded + token_stored 判定。"""
    uid = _validated_user_id(req.user_id)
    try:
        r = _run_cli(uid, ["auth", "refresh"], timeout=AUTH_TIMEOUT_REFRESH)
    except (subprocess.TimeoutExpired, OSError):
        return {"authenticated": False, "profile": uid}
    out = _parse_cli_stdout(r.stdout)
    return {"authenticated": _auth_ok(out), "profile": uid}


# ── Main ───────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse
    import uvicorn

    parser = argparse.ArgumentParser(description="Pi Agent Multi-User Orchestrator")
    parser.add_argument("--host", default=DEFAULT_HOST, help=f"Bind host (default: {DEFAULT_HOST})")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"Bind port (default: {DEFAULT_PORT})")
    parser.add_argument("--data-root", default=DATA_ROOT, help=f"Data root (default: {DATA_ROOT})")
    args = parser.parse_args()

    # Update manager's data root if different from default
    if args.data_root != DATA_ROOT:
        manager.data_root = args.data_root

    print(f"🚀 Pi Agent Multi-User Orchestrator")
    print(f"   Listening on {args.host}:{args.port}")
    print(f"   Data root: {manager.data_root}")
    print(f"   Discovered users: {len(manager.discover_users())}")

    uvicorn.run(
        "server:app",
        host=args.host,
        port=args.port,
        reload=False,
        log_level="info",
    )
