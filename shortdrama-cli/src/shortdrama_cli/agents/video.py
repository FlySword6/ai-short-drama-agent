"""Video generation business agent."""

from typing import Any

from shortdrama_cli.providers.mock import MockProvider
from shortdrama_cli.schemas.generation import Artifact, VideoGenerationRequest
from shortdrama_cli.storage.workspace import Workspace


class VideoAgent:
    """Create a video artifact record through the configured provider."""

    def __init__(self, provider: MockProvider, workspace: Workspace) -> None:
        self.provider = provider
        self.workspace = workspace

    def run(self, input: VideoGenerationRequest, context: dict[str, Any]) -> Artifact:
        return self.provider.generate_video(input, self.workspace)
