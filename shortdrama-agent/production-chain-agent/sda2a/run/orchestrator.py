"""Run the A2A orchestrator — discovers sub-agents via Hub.

Usage::

    # Discover agents from Hub and run the default fixture
    python -m sda2a.run.orchestrator --hub-port 9000

    # With custom script
    python -m sda2a.run.orchestrator --hub-port 9000 \\
        --script "角色：林夏；场景：旧画室" --title "测试"
"""

from __future__ import annotations

from dotenv import load_dotenv
load_dotenv()

import argparse
import json
import os

from sda2a.hub import HubManager
from sda2a.orchestrator import A2AOrchestrator
from sda2a.client import A2AClient


if __name__ == "__main__":
    if os.getenv("SHORTDRAMA_RESEARCH_RUNTIME") != "DEV" or os.getenv("SHORTDRAMA_RESEARCH_OPT_IN") != "1":
        raise SystemExit("A2A research runtime is disabled; set SHORTDRAMA_RESEARCH_RUNTIME=DEV and SHORTDRAMA_RESEARCH_OPT_IN=1")
    parser = argparse.ArgumentParser(description="Run A2A orchestrator via Hub")
    parser.add_argument("--hub-host", default="127.0.0.1", help="Hub host")
    parser.add_argument("--hub-port", type=int, default=9000, help="Hub port")
    parser.add_argument("--project-id", default="demo-project")
    parser.add_argument("--title", default="画室夜训")
    parser.add_argument("--episode", type=int, default=1)
    parser.add_argument("--script", default=None, help="script text (default: built-in fixture)")
    parser.add_argument("--reviewer", default="director")
    parser.add_argument("-q", "--quiet", action="store_true")
    args = parser.parse_args()

    # Discover agents via Hub.
    hub = HubManager(host=args.hub_host, port=args.hub_port)
    print(f"Discovering agents from Hub at {hub.url}...")
    agent_urls = hub.discover_agent_urls()

    if not agent_urls:
        print("Error: no agents found in Hub. Start sub-agents first.")
        raise SystemExit(1)

    print(f"Discovered {len(agent_urls)} agents:")
    for name, url in agent_urls.items():
        print(f"  {name}: {url}")

    # Verify all required agents are present.
    required = {"script", "asset", "scene", "generation"}
    missing = required - set(agent_urls.keys())
    if missing:
        print(f"Error: missing agents: {missing}")
        raise SystemExit(1)

    # Run the orchestrator.
    orchestrator = A2AOrchestrator(agent_urls)

    kwargs = dict(
        project_id=args.project_id,
        title=args.title,
        episode_no=args.episode,
        reviewer=args.reviewer,
        verbose=not args.quiet,
    )
    if args.script:
        kwargs["script_text"] = args.script

    receipt = orchestrator.run(**kwargs)
    print("\n=== Trace Receipt ===")
    print(json.dumps(receipt, ensure_ascii=False, indent=2))
