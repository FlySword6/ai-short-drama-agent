"""Schema for storyboard shot output."""

from pydantic import BaseModel


class StoryboardShot(BaseModel):
    """One shot ready to feed image and video generation prompts."""

    scene_id: str
    shot_id: str
    shot_type: str
    framing: str
    camera_movement: str
    visual_prompt: str
    duration: int


class Storyboard(BaseModel):
    """Top-level storyboard contract."""

    shots: list[StoryboardShot]
