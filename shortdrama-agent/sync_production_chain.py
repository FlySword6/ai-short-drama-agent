#!/usr/bin/env python3
"""同步 production_chain/ 到所有子 Agent 目录.

在 production-chain-agent/ 修改并测试通过后，运行此脚本同步到各子 Agent。

用法:
    cd zhongwen-shortdrama-agent
    python sync_production_chain.py
"""
import shutil
import pathlib

BASE = pathlib.Path(__file__).parent
SRC = BASE / "production-chain-agent" / "production_chain"
AGENTS = [
    "sd-script-agent",
    "sd-asset-agent",
    "sd-scene-agent",
    "sd-generation-agent",
    "sd-orchestrator",
]

def main() -> None:
    if not SRC.exists():
        raise FileNotFoundError(f"source not found: {SRC}")
    for agent in AGENTS:
        dst = BASE / agent / "production_chain"
        if dst.exists():
            shutil.rmtree(dst)
        shutil.copytree(SRC, dst)
        print(f"  synced → {agent}/production_chain/")
    print(f"\ndone. synced {len(AGENTS)} agents from {SRC.relative_to(BASE)}")


if __name__ == "__main__":
    main()
