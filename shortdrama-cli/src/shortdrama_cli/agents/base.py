"""Stable business-agent boundary independent from provider SDKs."""

from typing import Any, Protocol


class Agent(Protocol):
    """Workflow-level execution unit that returns validated local models."""

    def run(self, input: Any, context: dict[str, Any]) -> Any:
        """Execute the agent with local input and run context."""
