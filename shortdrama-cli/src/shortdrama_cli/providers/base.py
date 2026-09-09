"""Provider protocols keep vendor SDK details out of business agents."""

from typing import Protocol

from shortdrama_cli.schemas.generation import Artifact, ImageGenerationRequest, VideoGenerationRequest
from shortdrama_cli.storage.workspace import Workspace


class ImageProvider(Protocol):
    """Provider capability for image creation."""

    def generate_image(self, request: ImageGenerationRequest, workspace: Workspace) -> Artifact:
        """Generate or record an image artifact."""


class VideoProvider(Protocol):
    """Provider capability for video creation."""

    def generate_video(self, request: VideoGenerationRequest, workspace: Workspace) -> Artifact:
        """Generate or record a video artifact."""
