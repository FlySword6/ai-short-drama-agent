"""Pipeline orchestration that persists each validated step before continuing."""

from pathlib import Path

from shortdrama_cli.agents.character_breakdown import CharacterBreakdownAgent
from shortdrama_cli.agents.image import ImageAgent
from shortdrama_cli.agents.planner import PIPELINE_TASKS
from shortdrama_cli.agents.script_breakdown import ScriptBreakdownAgent
from shortdrama_cli.agents.storyboard_breakdown import StoryboardBreakdownAgent
from shortdrama_cli.agents.video import VideoAgent
from shortdrama_cli.domain.run import RunManifest, RunTask
from shortdrama_cli.providers.mock import MockProvider
from shortdrama_cli.schemas.generation import ImageGenerationRequest, VideoGenerationRequest
from shortdrama_cli.storage.artifacts import write_json
from shortdrama_cli.storage.manifest import ManifestStore
from shortdrama_cli.storage.workspace import Workspace


class PipelineRunner:
    """Execute the mock milestone pipeline with resumable file boundaries."""

    def __init__(self, provider: MockProvider) -> None:
        self.provider = provider

    def run(self, input_path: Path, out_dir: Path, provider_name: str) -> RunManifest:
        workspace = Workspace.create(out_dir)
        workspace.copy_input(input_path)
        manifest = RunManifest.new(
            provider=provider_name,
            input_file=str(workspace.input_path(input_path.name)),
            tasks=[RunTask(name=task) for task in PIPELINE_TASKS],
        )
        store = ManifestStore(workspace.manifest_path())
        store.save(manifest)

        script_text = input_path.read_text(encoding="utf-8")

        script = ScriptBreakdownAgent(self.provider).run(script_text, {})
        write_json(workspace.output_path("script-breakdown.json"), script)
        manifest.mark_succeeded("script-breakdown", "output/script-breakdown.json")

        characters = CharacterBreakdownAgent(self.provider).run(script_text, {})
        write_json(workspace.output_path("characters.json"), characters)
        manifest.mark_succeeded("character-breakdown", "output/characters.json")

        storyboard = StoryboardBreakdownAgent(self.provider).run(script_text, {})
        write_json(workspace.output_path("storyboard.json"), storyboard)
        manifest.mark_succeeded("storyboard-breakdown", "output/storyboard.json")

        image_prompt = storyboard.shots[0].visual_prompt if storyboard.shots else "short drama key visual"
        image = ImageAgent(self.provider, workspace).run(ImageGenerationRequest(prompt=image_prompt), {})
        write_json(workspace.output_path("images.json"), [image])
        manifest.mark_succeeded("image-generation", "output/images.json")

        video = VideoAgent(self.provider, workspace).run(VideoGenerationRequest(prompt=image_prompt), {})
        write_json(workspace.output_path("videos.json"), [video])
        manifest.mark_succeeded("video-generation", "output/videos.json")

        manifest.mark_succeeded("export-artifacts", "run-manifest.json")
        store.save(manifest)
        return manifest
