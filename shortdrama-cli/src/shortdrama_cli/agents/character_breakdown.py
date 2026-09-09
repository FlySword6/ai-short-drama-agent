"""Character breakdown business agent."""

from typing import Any

from shortdrama_cli.providers.mock import MockProvider
from shortdrama_cli.schemas.character_breakdown import CharacterBreakdown


class CharacterBreakdownAgent:
    """Extract character profiles from script text."""

    def __init__(self, provider: MockProvider) -> None:
        self.provider = provider

    def run(self, input: str, context: dict[str, Any]) -> CharacterBreakdown:
        return self.provider.break_down_characters(input)
