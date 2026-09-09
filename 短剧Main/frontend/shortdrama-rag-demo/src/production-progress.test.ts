import assert from "node:assert/strict";
import test from "node:test";
import { inferProductionProgress, type ProductionShotRecord } from "./production-progress";

const episode = { id: "episode-1", project_id: "project-1", episode_no: 1 };

test("empty project starts at storyboard import", () => {
  assert.equal(inferProductionProgress([]).current, "storyboard");
});

test("missing persisted image points to image generation", () => {
  const progress = inferProductionProgress([record("shot-1", "G01", [])]);
  assert.equal(progress.current, "image");
  assert.equal(progress.shotId, "shot-1");
});

test("persisted image without video points to video generation", () => {
  const progress = inferProductionProgress([record("shot-1", "G01", [media("image")])]);
  assert.equal(progress.current, "video");
});

test("persisted video without selected primary points to primary selection", () => {
  const progress = inferProductionProgress([record("shot-1", "G01", [media("image"), media("video")])]);
  assert.equal(progress.current, "primary");
});

test("all selected video versions make delivery available", () => {
  const item = record("shot-1", "G01", [media("image"), media("video")]);
  item.shot.selected_video_result_id = "video-1";
  const progress = inferProductionProgress([item]);
  assert.equal(progress.current, "delivery");
  assert.equal(progress.episodeId, "episode-1");
});

function record(id: string, shotNo: string, mediaItems: ProductionShotRecord["media"]): ProductionShotRecord {
  return {
    episode,
    shot: { id, episode_id: episode.id, shot_no: shotNo },
    media: mediaItems,
  };
}

function media(kind: "image" | "video"): ProductionShotRecord["media"][number] {
  return {
    id: `${kind}-1`,
    media_kind: kind,
    persistence_status: "persisted",
    storage_url: `https://example.test/${kind}.bin`,
  };
}
