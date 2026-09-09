"""Pure domain rules shared by the Agent-facing main-chain adapter.

Migration note: when shortdrama-cli gains name-resolution domain functions,
move this module as a whole into CLI core and change the Agent repository to
import it.  Keep this module free of Pi runtime and HTTP client dependencies so
that move remains mechanical.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable


@dataclass(frozen=True)
class NameResolution:
    item: dict[str, Any] | None
    code: str | None = None
    message: str | None = None
    candidates: tuple[dict[str, Any], ...] = ()

    @property
    def ok(self) -> bool:
        return self.item is not None


def resolve_unique_name(
    items: Iterable[dict[str, Any]],
    *,
    query: str,
    fields: tuple[str, ...],
    entity_label: str,
) -> NameResolution:
    """Resolve one exact display value and never guess between candidates."""

    value = query.strip()
    matches = [
        item
        for item in items
        if any(_comparable(item.get(field)) == value for field in fields)
    ]
    if len(matches) == 1:
        return NameResolution(item=matches[0])
    candidates = tuple(_candidate(item, fields) for item in matches[:20])
    if not matches:
        return NameResolution(
            item=None,
            code="name_not_found",
            message=f"没有找到名称完全等于“{value}”的{entity_label}，请先列出候选或直接提供 ID。",
        )
    return NameResolution(
        item=None,
        code="name_ambiguous",
        message=f"找到多个名称完全等于“{value}”的{entity_label}，请改用明确 ID。",
        candidates=candidates,
    )


def resolve_unique_number(
    items: Iterable[dict[str, Any]],
    *,
    query: int,
    fields: tuple[str, ...],
    entity_label: str,
) -> NameResolution:
    """Resolve one exact numeric ordinal without selecting the first match."""

    matches = [
        item
        for item in items
        if any(_integer(item.get(field)) == query for field in fields)
    ]
    if len(matches) == 1:
        return NameResolution(item=matches[0])
    candidates = tuple(_candidate(item, fields) for item in matches[:20])
    if not matches:
        return NameResolution(
            item=None,
            code="name_not_found",
            message=f"没有找到编号为 {query} 的{entity_label}，请先列出候选或直接提供 ID。",
        )
    return NameResolution(
        item=None,
        code="name_ambiguous",
        message=f"找到多个编号为 {query} 的{entity_label}，请改用明确 ID。",
        candidates=candidates,
    )


def require_record_id(item: dict[str, Any], *, entity_label: str) -> str:
    value = item.get("id")
    if not isinstance(value, str) or not value:
        raise ValueError(f"{entity_label}响应缺少 id，不能继续推断。")
    return value


def _candidate(item: dict[str, Any], fields: tuple[str, ...]) -> dict[str, Any]:
    return {
        "id": item.get("id") if isinstance(item.get("id"), str) else None,
        "labels": {
            field: item.get(field)
            for field in fields
            if isinstance(item.get(field), (str, int))
        },
    }


def _comparable(value: Any) -> str | None:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, int) and not isinstance(value, bool):
        return str(value)
    return None


def _integer(value: Any) -> int | None:
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    return None
