"""Safe, local skill discovery and enablement for exactly two allowlist roots."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path


class SkillNotFoundError(KeyError):
    pass


@dataclass(frozen=True)
class ManagedSkill:
    id: str
    root: str
    path: str
    enabled: bool


class SkillRegistry:
    def __init__(self, roots: tuple[Path, Path], state_path: Path) -> None:
        self.roots = tuple(root.resolve() for root in roots)
        self.state_path = state_path

    def list(self) -> list[ManagedSkill]:
        states = self._states()
        skills: list[ManagedSkill] = []
        for index, root in enumerate(self.roots):
            if not root.is_dir():
                continue
            for marker in sorted(root.glob("*/SKILL.md")):
                resolved = marker.resolve()
                try:
                    resolved.relative_to(root)
                except ValueError:
                    continue
                source = "agents" if index == 0 else "workbuddy"
                skill_id = f"{source}/{marker.parent.name}"
                skills.append(ManagedSkill(
                    id=skill_id,
                    root=str(root),
                    path=str(marker.parent),
                    enabled=states.get(skill_id, True),
                ))
        return skills

    def enabled_paths(self) -> list[Path]:
        return [Path(skill.path) for skill in self.list() if skill.enabled]

    def set_enabled(self, skill_id: str, enabled: bool) -> ManagedSkill:
        skills = {skill.id: skill for skill in self.list()}
        if skill_id not in skills:
            raise SkillNotFoundError(skill_id)
        states = self._states()
        states[skill_id] = enabled
        self.state_path.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
        self.state_path.write_text(json.dumps(states, sort_keys=True) + "\n", encoding="utf-8")
        updated = skills[skill_id]
        return ManagedSkill(**{**asdict(updated), "enabled": enabled})

    def _states(self) -> dict[str, bool]:
        if not self.state_path.is_file():
            return {}
        parsed = json.loads(self.state_path.read_text(encoding="utf-8"))
        if not isinstance(parsed, dict) or not all(isinstance(value, bool) for value in parsed.values()):
            raise ValueError("skill state file must be an object of booleans")
        return parsed
