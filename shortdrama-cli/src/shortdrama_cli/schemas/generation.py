"""Schemas for generation requests and persisted artifacts."""

from typing import Any, Literal

from pydantic import BaseModel, Field


class ImageGenerationRequest(BaseModel):
    """Local image request independent from any provider payload."""

    prompt: str
    reference_assets: list[str] = Field(default_factory=list)
    aspect_ratio: str = "9:16"
    style: str | None = None
    seed: int = 1


class VideoGenerationRequest(BaseModel):
    """Local video request independent from any provider payload."""

    prompt: str
    reference_assets: list[str] = Field(default_factory=list)
    duration: int = 5
    aspect_ratio: str = "9:16"
    motion_control: str | None = None


class Artifact(BaseModel):
    """Generated asset metadata persisted by the CLI."""

    id: str
    type: Literal["image", "video"]
    local_path: str | None = None
    remote_uri: str | None = None
    provider: str
    source_task_id: str
    metadata: dict[str, Any] = Field(default_factory=dict)
