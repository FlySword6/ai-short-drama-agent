"""Persistence helper for `run-manifest.json`."""

from pathlib import Path

from shortdrama_cli.domain.run import RunManifest
from shortdrama_cli.storage.artifacts import write_json


class ManifestStore:
    """Writes the current manifest snapshot."""

    def __init__(self, path: Path) -> None:
        self.path = path

    def save(self, manifest: RunManifest) -> None:
        write_json(self.path, manifest)
