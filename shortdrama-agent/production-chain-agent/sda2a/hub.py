"""A2A Hub — agent registration and discovery using veadk's A2AHubServer.

The Hub is a central registry where sub-agents register their AgentCards
and the orchestrator discovers them.  Based on veadk's ``A2AHubServer``
(FastAPI + uvicorn), compatible with the Volcengine AgentKit A2A ecosystem.

Two modes:
- **Local**: ``HubManager`` starts the Hub in a background thread
- **Remote**: connect to an already-running Hub (e.g., in AgentKit cloud)
"""

from __future__ import annotations

import socket
import threading
import time
from typing import Any

import httpx
import uvicorn
from veadk.a2a.hub.a2a_hub_server import A2AHubServer

DEFAULT_GROUP = "shortdrama-production-chain"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 9000


class HubManager:
    """Manages an A2A Hub server for agent registration and discovery.

    Args:
        host: Hub server host.
        port: Hub server port.
        group_id: Agent group ID for registration/discovery.
    """

    def __init__(
        self,
        host: str = DEFAULT_HOST,
        port: int = DEFAULT_PORT,
        group_id: str = DEFAULT_GROUP,
    ) -> None:
        self._host = host
        self._port = port
        self._group_id = group_id
        self._server: uvicorn.Server | None = None
        self._thread: threading.Thread | None = None
        self._started = False

    # ------------------------------------------------------------------
    # Properties
    # ------------------------------------------------------------------

    @property
    def url(self) -> str:
        """Base URL of the Hub server."""

        return f"http://{self._host}:{self._port}"

    @property
    def group_id(self) -> str:
        return self._group_id

    @property
    def is_running(self) -> bool:
        return self._started

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def start(self) -> str:
        """Start the Hub server in a background thread.

        Returns the Hub's base URL.
        """

        if self._started:
            return self.url

        # port=0 时先查找空闲端口，避免 uvicorn 绑定后无法获知实际端口。
        if self._port == 0:
            self._port = self._find_free_port()

        hub = A2AHubServer()
        config = uvicorn.Config(
            hub.app,
            host=self._host,
            port=self._port,
            log_level="warning",
        )
        self._server = uvicorn.Server(config)
        self._thread = threading.Thread(
            target=self._server.run, daemon=True,
        )
        self._thread.start()
        self._wait_ready()

        # Create the agent group.
        self._create_group()
        self._started = True
        return self.url

    def stop(self) -> None:
        """Stop the Hub server."""

        if self._server is not None:
            self._server.should_exit = True
        if self._thread is not None:
            self._thread.join(timeout=5)
        self._server = None
        self._thread = None
        self._started = False

    # ------------------------------------------------------------------
    # Agent registration / discovery
    # ------------------------------------------------------------------

    def register_agent(
        self,
        agent_id: str,
        agent_card: dict[str, Any],
    ) -> None:
        """Register an agent to the Hub.

        Args:
            agent_id: Unique agent identifier (e.g. "script-agent").
            agent_card: AgentCard dict (from ``AgentCard.to_dict()``).
        """

        with httpx.Client(timeout=10) as client:
            resp = client.post(
                f"{self.url}/register_agent",
                json={
                    "group_id": self._group_id,
                    "agent_id": agent_id,
                    "agent_card": agent_card,
                },
            )
            resp.raise_for_status()
            data = resp.json()
            if data.get("err_code", 0) != 0:
                raise RuntimeError(
                    f"Hub registration failed: {data.get('msg', 'unknown')}"
                )

    def discover_agents(self) -> dict[str, dict[str, Any]]:
        """Discover all registered agents in the group.

        Returns:
            Dict mapping ``agent_id`` → ``agent_card`` dict.
        """

        with httpx.Client(timeout=10) as client:
            resp = client.get(
                f"{self.url}/group/{self._group_id}/agents",
            )
            resp.raise_for_status()
            data = resp.json()

        if data.get("err_code", 0) != 0:
            return {}

        return {
            info["agent_id"]: info["agent_card"]
            for info in data.get("agent_infos", [])
        }

    def discover_agent_urls(self) -> dict[str, str]:
        """Discover all agents and return a mapping of ``agent_id → url``.

        The returned dict uses the same keys as ``SubAgentCluster.urls``:
        ``"script"``, ``"asset"``, ``"scene"``, ``"generation"``.
        """

        agents = self.discover_agents()
        url_map: dict[str, str] = {}
        for agent_id, card in agents.items():
            # Map agent_id to the short name used by the orchestrator.
            short_name = agent_id.replace("-agent", "")
            url_map[short_name] = card.get("url", "")
        return url_map

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _wait_ready(self, timeout: float = 10.0) -> None:
        """Wait for the Hub server to respond to health checks."""

        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                resp = httpx.get(f"{self.url}/ping", timeout=1)
                if resp.status_code == 200:
                    return
            except Exception:
                pass
            time.sleep(0.2)
        raise RuntimeError(
            f"Hub server at {self.url} did not start within {timeout}s"
        )

    def _create_group(self) -> None:
        """Create the agent group on the Hub."""

        with httpx.Client(timeout=10) as client:
            resp = client.post(
                f"{self.url}/create_group",
                params={"group_id": self._group_id},
            )
            resp.raise_for_status()

    @staticmethod
    def _find_free_port() -> int:
        """Find a free TCP port for the Hub server."""

        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(("", 0))
            return s.getsockname()[1]
