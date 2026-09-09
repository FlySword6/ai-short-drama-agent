"""Schema for character extraction output."""

from pydantic import BaseModel, Field


class Character(BaseModel):
    """Character profile used by generation continuity tasks."""

    id: str
    name: str
    role: str
    appearance: str
    voice: str
    relationships: list[str] = Field(default_factory=list)
    continuity_notes: list[str] = Field(default_factory=list)


class CharacterBreakdown(BaseModel):
    """Top-level character breakdown contract."""

    characters: list[Character]
