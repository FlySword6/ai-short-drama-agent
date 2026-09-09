"""Deterministic local provider used by tests and offline demos."""

from hashlib import sha1

from shortdrama_cli.schemas.character_breakdown import Character, CharacterBreakdown
from shortdrama_cli.schemas.generation import Artifact, ImageGenerationRequest, VideoGenerationRequest
from shortdrama_cli.schemas.script_breakdown import DialogueReference, Episode, Scene, ScriptBeat, ScriptBreakdown
from shortdrama_cli.schemas.storyboard_breakdown import Storyboard, StoryboardShot
from shortdrama_cli.storage.workspace import Workspace


class MockProvider:
    """Local provider that never reads credentials or calls the network."""

    def break_down_script(self, script_text: str) -> ScriptBreakdown:
        title = _title_from_script(script_text)
        scene_text = _first_non_title_line(script_text)
        return ScriptBreakdown(
            title=title,
            episodes=[
                Episode(
                    id="ep01",
                    title="Episode 1",
                    scenes=[
                        Scene(
                            id="scene-001",
                            summary=scene_text,
                            beats=[ScriptBeat(id="beat-001", summary=scene_text)],
                            dialogue_references=[
                                DialogueReference(character="A", quote=scene_text[:80] or "Mock dialogue")
                            ],
                        )
                    ],
                )
            ],
        )

    def break_down_characters(self, script_text: str) -> CharacterBreakdown:
        title = _title_from_script(script_text)
        return CharacterBreakdown(
            characters=[
                Character(
                    id="char-001",
                    name="A",
                    role="Protagonist",
                    appearance=f"Grounded lead character for {title}",
                    voice="Direct, urgent, emotionally clear",
                    relationships=["B: dramatic counterpoint"],
                    continuity_notes=["Keep costume and emotional state consistent across mock shots."],
                )
            ]
        )

    def break_down_storyboard(self, script_text: str) -> Storyboard:
        scene_text = _first_non_title_line(script_text)
        return Storyboard(
            shots=[
                StoryboardShot(
                    scene_id="scene-001",
                    shot_id="shot-001",
                    shot_type="dialogue",
                    framing="medium close-up",
                    camera_movement="slow push-in",
                    visual_prompt=f"Short drama scene, cinematic realism, {scene_text}",
                    duration=5,
                )
            ]
        )

    def generate_image(self, request: ImageGenerationRequest, workspace: Workspace) -> Artifact:
        artifact_id = f"img-{_stable_id(request.prompt)}"
        path = workspace.asset_path("images", f"{artifact_id}.txt")
        path.write_text(f"mock image for: {request.prompt}\n", encoding="utf-8")
        return Artifact(
            id=artifact_id,
            type="image",
            local_path=str(path),
            provider="mock",
            source_task_id="image-generation",
            metadata={"aspect_ratio": request.aspect_ratio, "seed": request.seed},
        )

    def generate_video(self, request: VideoGenerationRequest, workspace: Workspace) -> Artifact:
        artifact_id = f"vid-{_stable_id(request.prompt)}"
        path = workspace.asset_path("videos", f"{artifact_id}.txt")
        path.write_text(f"mock video for: {request.prompt}; duration={request.duration}\n", encoding="utf-8")
        return Artifact(
            id=artifact_id,
            type="video",
            local_path=str(path),
            provider="mock",
            source_task_id="video-generation",
            metadata={"aspect_ratio": request.aspect_ratio, "duration": request.duration},
        )


def _title_from_script(script_text: str) -> str:
    first = script_text.strip().splitlines()[0] if script_text.strip() else "Untitled Short Drama"
    return first.removeprefix("#").strip() or "Untitled Short Drama"


def _first_non_title_line(script_text: str) -> str:
    lines = [line.strip("# ").strip() for line in script_text.splitlines() if line.strip()]
    return lines[1] if len(lines) > 1 else (lines[0] if lines else "A decisive story beat unfolds.")


def _stable_id(value: str) -> str:
    return sha1(value.encode("utf-8"), usedforsecurity=False).hexdigest()[:10]
