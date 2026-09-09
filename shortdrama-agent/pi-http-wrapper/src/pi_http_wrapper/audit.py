"""Append-only request audit without prompt, token, or tool-result leakage."""

from __future__ import annotations

import json
from datetime import datetime, timezone
UTC = timezone.utc
from pathlib import Path
from typing import Any


class AuditLog:
    def __init__(self, path: Path) -> None:
        self.path = path

    def append(self, *, request_id: str, token_id: str | None, endpoint: str, outcome: str, metadata: dict[str, Any] | None = None) -> None:
        self.path.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
        event = {
            "ts": datetime.now(UTC).isoformat(),
            "request_id": request_id,
            "token_id": token_id,
            "endpoint": endpoint,
            "outcome": outcome,
            "metadata": metadata or {},
        }
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n")

