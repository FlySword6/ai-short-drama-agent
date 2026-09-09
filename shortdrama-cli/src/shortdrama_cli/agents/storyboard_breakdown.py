"""Storyboard breakdown business agent."""

from typing import Any

from shortdrama_cli.providers.mock import MockProvider
from shortdrama_cli.schemas.storyboard_breakdown import Storyboard


class StoryboardBreakdownAgent:
    """Turn script text into storyboard shots."""

    def __init__(self, provider: MockProvider) -> None:
        self.provider = provider

    def run(self, input: str, context: dict[str, Any]) -> Storyboard:
        return self.provider.break_down_storyboard(input)
