"""Filesystem layout for one CLI run."""

from pathlib import Path
from shutil import copy2


class Workspace:
    """Creates and resolves the run directory structure."""

    def __init__(self, root: Path) -> None:
        self.root = root

    @classmethod
    def create(cls, root: Path) -> "Workspace":
        workspace = cls(root)
        for path in [
            workspace.root,
            workspace.root / "input",
            workspace.root / "output",
            workspace.root / "assets" / "images",
            workspace.root / "assets" / "videos",
            workspace.root / "logs",
        ]:
            path.mkdir(parents=True, exist_ok=True)
        return workspace

    def copy_input(self, input_path: Path) -> Path:
        target = self.input_path(input_path.name)
        copy2(input_path, target)
        return target

    def input_path(self, name: str) -> Path:
        return self.root / "input" / name

    def output_path(self, name: str) -> Path:
        return self.root / "output" / name

    def asset_path(self, kind: str, name: str) -> Path:
        path = self.root / "assets" / kind / name
        path.parent.mkdir(parents=True, exist_ok=True)
        return path

    def manifest_path(self) -> Path:
        return self.root / "run-manifest.json"
