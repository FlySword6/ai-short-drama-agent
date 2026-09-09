"""Typed HTTP boundary for the standalone asset-library search service."""

from typing import Any

from shortdrama_cli.api.client import ApiTransport, UrlLibTransport
from shortdrama_cli.api.errors import ApiConfigurationError


class AssetLibraryClient:
    """Call documented read-only asset-library endpoints without database access."""

    def __init__(self, api_base: str, transport: ApiTransport | None = None) -> None:
        normalized = api_base.strip().rstrip("/")
        if not normalized:
            raise ApiConfigurationError("Asset library API base URL is required.")
        self.api_base = normalized
        self.transport = transport or UrlLibTransport()

    def semantic_search(self, query: str, limit: int) -> dict[str, Any]:
        """Search asset entities semantically and preserve the server result ordering."""

        return self.transport.request(
            "POST",
            f"{self.api_base}/asset-search/semantic",
            {"Accept": "application/json"},
            {"query": query, "limit": limit},
        )
