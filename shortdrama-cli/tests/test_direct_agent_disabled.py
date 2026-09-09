import pytest

from shortdrama_cli.providers.agent import AgentGateway, AgentGatewayError, resolve_agent_token


def test_legacy_direct_agent_gateway_fails_closed_before_any_network_request() -> None:
    """The CLI must not retain a bypass around the backend AI Gateway."""

    with pytest.raises(AgentGatewayError, match="Direct Agent/Ark invocation is disabled"):
        AgentGateway("https://example.invalid/invoke", "test-token")


def test_legacy_direct_agent_credential_resolution_fails_closed() -> None:
    """No legacy environment or local credential-file fallback is permitted."""

    with pytest.raises(AgentGatewayError, match="Direct Agent/Ark invocation is disabled"):
        resolve_agent_token(None, None)
