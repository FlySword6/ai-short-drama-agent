"""Start a single sub-agent standalone with optional Hub registration.

Usage::

    # Start script-agent on port 8001, register to Hub at :9000
    python -m sda2a.run.agent --type script --port 8001 --hub-port 9000

    # Start without Hub registration
    python -m sda2a.run.agent --type asset --port 8002 --no-hub
"""

from __future__ import annotations

from dotenv import load_dotenv
load_dotenv()

import argparse
import os
import time

import httpx

from sda2a.hub import DEFAULT_GROUP, HubManager
from sda2a.sub_agents import (
    AssetAgentServer,
    GenerationAgentServer,
    SceneAgentServer,
    ScriptAgentServer,
)

AGENT_TYPES = {
    "script": ScriptAgentServer,
    "asset": AssetAgentServer,
    "scene": SceneAgentServer,
    "generation": GenerationAgentServer,
}


def _hub_is_running(host: str, port: int) -> bool:
    """Check if a Hub server is reachable."""

    try:
        resp = httpx.get(f"http://{host}:{port}/ping", timeout=3)
        return resp.status_code == 200
    except Exception:
        return False


if __name__ == "__main__":
    if os.getenv("SHORTDRAMA_RESEARCH_RUNTIME") != "DEV" or os.getenv("SHORTDRAMA_RESEARCH_OPT_IN") != "1":
        raise SystemExit("A2A research runtime is disabled; set SHORTDRAMA_RESEARCH_RUNTIME=DEV and SHORTDRAMA_RESEARCH_OPT_IN=1")
    parser = argparse.ArgumentParser(description="Start a sub-agent")
    parser.add_argument(
        "--type", required=True, choices=AGENT_TYPES.keys(),
        help="sub-agent type",
    )
    parser.add_argument("--host", default="0.0.0.0", help="bind host")
    parser.add_argument("--port", type=int, default=0, help="bind port (0=random)")
    parser.add_argument("--hub-host", default="127.0.0.1", help="Hub host")
    parser.add_argument("--hub-port", type=int, default=9000, help="Hub port")
    parser.add_argument("--no-hub", action="store_true", help="skip Hub registration")
    args = parser.parse_args()

    # Create and start the agent.
    agent_cls = AGENT_TYPES[args.type]
    agent = agent_cls()
    url = agent.start(host=args.host, port=args.port)
    print(f"{args.type}-agent running at {url}")

    # Register to Hub if it's running.
    if not args.no_hub:
        if _hub_is_running(args.hub_host, args.hub_port):
            hub = HubManager(
                host=args.hub_host, port=args.hub_port,
                group_id=DEFAULT_GROUP,
            )
            card = agent._server.card  # type: ignore[union-attr]
            hub.register_agent(card.name, card.to_dict())
            print(f"Registered to Hub at {hub.url} (group={hub.group_id})")
        else:
            print(
                f"Warning: Hub not reachable at {args.hub_host}:{args.hub_port}, "
                "skipping registration."
            )

    print("Press Ctrl+C to stop.")

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print(f"\nStopping {args.type}-agent...")
        agent.stop()
        print("Agent stopped.")
