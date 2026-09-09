#!/usr/bin/env python3
"""Render the offline Pi tool schema from the executable adapter registry."""

from __future__ import annotations

import json
from pathlib import Path

from pi_http_wrapper.main_chain import tool_schema_document


ROOT = Path(__file__).resolve().parents[2]
TARGET = ROOT / "agent_resources" / "pi" / "schemas" / "tools.json"


def main() -> None:
    TARGET.write_text(
        json.dumps(tool_schema_document(), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
