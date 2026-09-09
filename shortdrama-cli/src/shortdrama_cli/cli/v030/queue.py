"""Frozen v0.3 generation queue and retry commands."""

from __future__ import annotations

from typing import Annotated

import typer

from shortdrama_cli.cli.common import ClientIdempotencyKey, invoke
from shortdrama_cli.cli.v030._helpers import _path, _write

queue_app = typer.Typer(help="生成队列与重试。")


@queue_app.command("list")
def queue_list() -> None:
    invoke("queue_list", "GET", _path("generations", "in-flight"))


@queue_app.command("status")
def queue_status(generation_id: Annotated[str, typer.Option("--generation-id")]) -> None:
    invoke("queue_status", "GET", _path("generations", generation_id))


@queue_app.command("retry-estimate")
def retry_estimate(generation_id: Annotated[str, typer.Option("--generation-id")]) -> None:
    invoke(
        "queue_retry_estimate",
        "POST",
        _path("generations", "estimate"),
        {"action": "retry", "original_request_id": generation_id},
    )


@queue_app.command("retry-confirm")
def retry_confirm(quote_id: Annotated[str, typer.Option("--quote-id")]) -> None:
    invoke("queue_retry_confirm", "POST", _path("generation-quotes", quote_id, "confirm"))


@queue_app.command("retry-submit")
def retry_submit(
    generation_id: Annotated[str, typer.Option("--generation-id")],
    quote_id: Annotated[str, typer.Option("--quote-id")],
    client_idempotency_key: ClientIdempotencyKey = None,
) -> None:
    _write(
        "queue_retry_submit",
        "POST",
        _path("generations", generation_id, "retry"),
        client_idempotency_key,
        generation_quote_id=quote_id,
    )
