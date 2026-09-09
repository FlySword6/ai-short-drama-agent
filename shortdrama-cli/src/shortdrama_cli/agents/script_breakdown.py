"""Script breakdown business agent."""

from typing import Any

from shortdrama_cli.providers.mock import MockProvider
from shortdrama_cli.schemas.script_breakdown import ScriptBreakdown


class ScriptBreakdownAgent:
    """Convert raw script text into the local script breakdown contract."""

    def __init__(self, provider: MockProvider) -> None:
        self.provider = provider

    def run(self, input: str, context: dict[str, Any]) -> ScriptBreakdown:
        return self.provider.break_down_script(input)
