#!/usr/bin/env python3
"""Ensure preserved AgentKit/A2A/Uvicorn research launchers require explicit opt-in."""

from __future__ import annotations

import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
GATE = "SHORTDRAMA_RESEARCH_RUNTIME"
OPT_IN = "SHORTDRAMA_RESEARCH_OPT_IN"
RUNTIME_TARGETS = (
    "production-chain-agent/agent.py",
    "production-chain-agent/sda2a/run/agent.py",
    "production-chain-agent/sda2a/run/all.py",
    "production-chain-agent/sda2a/run/hub.py",
    "production-chain-agent/sda2a/run/orchestrator.py",
    "sd-asset-agent/app.py",
    "sd-generation-agent/app.py",
    "sd-orchestrator/app.py",
    "sd-scene-agent/app.py",
    "sd-script-agent/app.py",
    "test-agent/agent.py",
    "test-agent/agent_a2a.py",
)


def main() -> int:
    missing: list[str] = []
    for relative in RUNTIME_TARGETS:
        content = (ROOT / relative).read_text(encoding="utf-8")
        if GATE not in content or OPT_IN not in content:
            missing.append(relative)
    manifest = (ROOT / "agent_resources" / "manifest.json").read_text(encoding="utf-8")
    if '"production_runtime": "main_openapi_only"' not in manifest:
        missing.append("agent_resources/manifest.json production_runtime")
    if missing:
        print("FAIL: implicit research runtime remains possible")
        print("\n".join(f"- {item}" for item in missing))
        return 1
    print("PASS: AgentKit/A2A/Uvicorn launchers require DEV and explicit opt-in; production runtime is Main OpenAPI only")
    return 0


if __name__ == "__main__":
    sys.exit(main())
