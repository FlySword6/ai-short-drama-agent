"""JSON artifact writers for validated Pydantic models."""

import json
from pathlib import Path
from typing import Any

from pydantic import BaseModel


def write_json(path: Path, value: Any) -> None:
    """Write Pydantic models or simple structures as stable UTF-8 JSON."""

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(_to_jsonable(value), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _to_jsonable(value: Any) -> Any:
    if isinstance(value, BaseModel):
        return value.model_dump(mode="json")
    if isinstance(value, list):
        return [_to_jsonable(item) for item in value]
    if isinstance(value, dict):
        return {key: _to_jsonable(item) for key, item in value.items()}
    return value
