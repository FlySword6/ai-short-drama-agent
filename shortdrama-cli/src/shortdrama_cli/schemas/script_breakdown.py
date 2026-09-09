"""Schema for structured script breakdown output."""

from pydantic import BaseModel, Field


class DialogueReference(BaseModel):
    """A dialogue quote tied to a character for later continuity checks."""

    character: str
    quote: str


class ScriptBeat(BaseModel):
    """One dramatic beat in a scene."""

    id: str
    summary: str


class Scene(BaseModel):
    """A scene with beats and dialogue references."""

    id: str
    summary: str
    beats: list[ScriptBeat] = Field(default_factory=list)
    dialogue_references: list[DialogueReference] = Field(default_factory=list)


class Episode(BaseModel):
    """Episode-level grouping for scenes."""

    id: str
    title: str
    scenes: list[Scene]


class ScriptBreakdown(BaseModel):
    """Top-level script breakdown contract."""

    title: str
    episodes: list[Episode]
