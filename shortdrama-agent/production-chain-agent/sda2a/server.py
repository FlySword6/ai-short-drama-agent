"""A2A HTTP server — lightweight agent endpoint using stdlib.

Each sub-agent runs an ``A2AAgentServer`` that serves its AgentCard
at ``/.well-known/agent.json`` and accepts JSON-RPC 2.0 task requests
at ``/`` (or ``/tasks/send``).  The server uses ``ThreadingHTTPServer``
so it can handle concurrent requests from the orchestrator.

Designed for both:
- **Standalone deployment**: run as a separate process on a fixed port
- **In-process testing**: start on port 0 (random) in a daemon thread
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable

from .protocol import (
    AgentCard,
    build_task_result,
    extract_task_data,
    make_error,
    make_response,
)

# Task handler signature: receives the business payload dict, returns a result dict.
TaskHandler = Callable[[dict[str, Any]], dict[str, Any]]


class _A2ARequestHandler(BaseHTTPRequestHandler):
    """HTTP request handler implementing the A2A protocol routes."""

    # Suppress default logging to keep CLI output clean.
    def log_message(self, fmt: str, *args: object) -> None:
        pass

    # ------------------------------------------------------------------
    # GET /.well-known/agent.json → AgentCard
    # ------------------------------------------------------------------
    def do_GET(self) -> None:
        if self.path in ("/.well-known/agent.json", "/.well-known/agent-card.json"):
            # veadk RemoteVeAgent uses /.well-known/agent-card.json
            card: AgentCard = self.server._card  # type: ignore[attr-defined]
            self._json_response(200, card.to_dict())
        elif self.path == "/health":
            self._json_response(200, {"status": "ok"})
        else:
            self._json_response(404, {"error": "not found"})

    # ------------------------------------------------------------------
    # POST / → JSON-RPC 2.0 tasks/send
    # ------------------------------------------------------------------
    def do_POST(self) -> None:
        if self.path not in ("/", "/tasks/send"):
            self._json_response(404, {"error": "not found"})
            return

        raw_body = self._read_body()
        if raw_body is None:
            return  # error response already sent

        req_id = raw_body.get("id")
        method = raw_body.get("method", "")
        params = raw_body.get("params", {})

        if method != "tasks/send":
            self._json_response(
                200,
                make_error(-32601, f"method not found: {method}", req_id),
            )
            return

        task_id = params.get("id", "")

        try:
            # Extract business payload from A2A message envelope.
            payload = extract_task_data(params)

            # Dispatch to the agent's task handler.
            handler: TaskHandler = self.server._task_handler  # type: ignore[attr-defined]
            result_data = handler(payload)

            # Wrap result in A2A task result envelope.
            task_result = build_task_result(task_id, result_data)
            self._json_response(200, make_response(task_result, req_id))

        except Exception as exc:
            # Return A2A task with failed state.
            task_result = build_task_result(
                task_id, {"error": str(exc)}, state="failed",
            )
            self._json_response(200, make_response(task_result, req_id))

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------
    def _read_body(self) -> dict[str, Any] | None:
        content_length = int(self.headers.get("Content-Length", 0))
        if content_length == 0:
            self._json_response(400, {"error": "empty body"})
            return None
        raw = self.rfile.read(content_length)
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            self._json_response(400, {"error": "invalid JSON"})
            return None

    def _json_response(self, status: int, body: dict[str, Any]) -> None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class A2AAgentServer:
    """Manages an HTTP server that exposes an A2A agent endpoint.

    Usage::

        server = A2AAgentServer(card, handler_fn)
        url = server.start()       # returns base URL (e.g. http://127.0.0.1:54321)
        # ... client calls happen here ...
        server.stop()

    When ``port=0`` (default), the OS assigns a random free port,
    which is ideal for in-process testing and CLI mode.
    """

    def __init__(
        self,
        card: AgentCard,
        task_handler: TaskHandler,
        host: str = "127.0.0.1",
        port: int = 0,
    ) -> None:
        self._card = card
        self._task_handler = task_handler
        self._host = host
        self._port = port
        self._httpd: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    @property
    def card(self) -> AgentCard:
        return self._card

    @property
    def url(self) -> str:
        """Base URL of the running server (empty if not started)."""

        if self._httpd is None:
            return ""
        _, actual_port = self._httpd.server_address
        return f"http://{self._host}:{actual_port}"

    def start(self) -> str:
        """Start the HTTP server in a daemon thread. Returns the base URL."""

        self._httpd = ThreadingHTTPServer(
            (self._host, self._port), _A2ARequestHandler,
        )
        self._httpd._card = self._card  # type: ignore[attr-defined]
        self._httpd._task_handler = self._task_handler  # type: ignore[attr-defined]

        self._thread = threading.Thread(
            target=self._httpd.serve_forever,
            daemon=True,
        )
        self._thread.start()

        # Update card URL to reflect the actual address.
        self._card = AgentCard(
            name=self._card.name,
            description=self._card.description,
            url=self.url,
            version=self._card.version,
            capabilities=self._card.capabilities,
            skills=self._card.skills,
        )
        return self.url

    def stop(self) -> None:
        """Stop the HTTP server and wait for the thread to finish."""

        if self._httpd is not None:
            self._httpd.shutdown()
            self._httpd.server_close()
            self._httpd = None
        if self._thread is not None:
            self._thread.join(timeout=5)
            self._thread = None
