"""Start everything locally — Hub + 4 sub-agents + orchestrator.

This is the fastest way to test the full A2A multi-agent pipeline
without deploying separate processes.  The Hub, all sub-agents, and
the orchestrator run in the same process as background threads.

Usage::

    python -m sda2a.run.all
    python -m sda2a.run.all --script "角色：林夏；场景：旧画室"
    python -m sda2a.run.all -q          # quiet mode
"""

from __future__ import annotations

from dotenv import load_dotenv
load_dotenv()

import argparse
import json
import os
import time

from sda2a.client import A2AClient
from sda2a.hub import HubManager
from sda2a.orchestrator import A2AOrchestrator
from sda2a.sub_agents import SubAgentCluster


if __name__ == "__main__":
    if os.getenv("SHORTDRAMA_RESEARCH_RUNTIME") != "DEV" or os.getenv("SHORTDRAMA_RESEARCH_OPT_IN") != "1":
        raise SystemExit("A2A research runtime is disabled; set SHORTDRAMA_RESEARCH_RUNTIME=DEV and SHORTDRAMA_RESEARCH_OPT_IN=1")
    parser = argparse.ArgumentParser(
        description="Start Hub + all sub-agents + orchestrator locally",
    )
    parser.add_argument("--hub-host", default="127.0.0.1")
    parser.add_argument("--hub-port", type=int, default=9000)
    parser.add_argument("--agent-host", default="127.0.0.1")
    parser.add_argument("--project-id", default="demo-project")
    parser.add_argument("--title", default="画室夜训")
    parser.add_argument("--episode", type=int, default=1)
    parser.add_argument("--script", default=None)
    parser.add_argument("--reviewer", default="director")
    parser.add_argument("-q", "--quiet", action="store_true")
    args = parser.parse_args()

    # 1. Start Hub
    print("Starting A2A Hub...")
    hub = HubManager(host=args.hub_host, port=args.hub_port)
    hub.start()
    print(f"  Hub: {hub.url}  group={hub.group_id}")

    # 2. Start all sub-agents + register to Hub
    print("Starting sub-agents...")
    cluster = SubAgentCluster(hub=hub)
    urls = cluster.start(host=args.agent_host)
    for name, url in urls.items():
        print(f"  {name}: {url}")

    # 3. Discover agents via Hub (verify registration)
    print("\nDiscovering agents via Hub...")
    discovered = hub.discover_agent_urls()
    print(f"  Found {len(discovered)} agents: {list(discovered.keys())}")

    # 4. Run orchestrator
    print("\nRunning production chain...\n")
    orchestrator = A2AOrchestrator(discovered)

    kwargs = dict(
        project_id=args.project_id,
        title=args.title,
        episode_no=args.episode,
        reviewer=args.reviewer,
        verbose=not args.quiet,
    )
    if args.script:
        kwargs["script_text"] = args.script

    try:
        receipt = orchestrator.run(**kwargs)
        print("\n=== Trace Receipt ===")
        print(json.dumps(receipt, ensure_ascii=False, indent=2))
    finally:
        # 5. Cleanup
        print("\nStopping sub-agents...")
        cluster.stop()
        print("Stopping Hub...")
        hub.stop()
        print("Done.")
