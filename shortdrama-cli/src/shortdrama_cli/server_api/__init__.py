"""Business-server API client layer.

The CLI talks to the business server only. It must not call AgentKit,
third-party providers, or PostgreSQL directly.
"""

from shortdrama_cli.server_api.client import BusinessServerClient

__all__ = ["BusinessServerClient"]
