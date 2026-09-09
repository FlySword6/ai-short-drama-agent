import assert from "node:assert/strict";
import test from "node:test";
import { applyNoBgmTemplate, NO_BGM_AUDIO_CONSTRAINT } from "../src/modules/vnext/workflows/noBgmTemplate.js";
import { Seedance25Provider } from "../src/modules/vnext/providers/seedance/seedance25Provider.js";

const seedance25Provider = new Seedance25Provider({ apiKey: "", endpointModel: "" });

// ─── applyNoBgmTemplate ───────────────────────────────────────────────────────

test("no-bgm template: noBgm=true appends audio constraint to prompt", () => {
  const result = applyNoBgmTemplate({ prompt: "雨夜巷口", noBgm: true, parameters: {} });
  assert.ok(result.prompt.includes(NO_BGM_AUDIO_CONSTRAINT));
  assert.ok(result.prompt.startsWith("雨夜巷口"));
});

test("no-bgm template: noBgm=true sets generateAudio=true", () => {
  const result = applyNoBgmTemplate({ prompt: "test", noBgm: true, parameters: {} });
  assert.equal(result.generateAudio, true);
});

test("no-bgm template: noBgm=false does not append constraint", () => {
  const result = applyNoBgmTemplate({ prompt: "test", noBgm: false, parameters: {} });
  assert.ok(!result.prompt.includes(NO_BGM_AUDIO_CONSTRAINT));
});

test("no-bgm template: noBgm=false still sets generateAudio=true", () => {
  const result = applyNoBgmTemplate({ prompt: "test", noBgm: false, parameters: {} });
  assert.equal(result.generateAudio, true);
});

test("no-bgm template: strips bgm and background_music from parameters regardless of noBgm", () => {
  const params = { bgm: true, background_music: "ambient", ratio: "9:16" };
  const enabled = applyNoBgmTemplate({ prompt: "test", noBgm: true, parameters: params });
  assert.ok(!("bgm" in enabled.parameters));
  assert.ok(!("background_music" in enabled.parameters));
  assert.equal(enabled.parameters["ratio"], "9:16");

  const disabled = applyNoBgmTemplate({ prompt: "test", noBgm: false, parameters: params });
  assert.ok(!("bgm" in disabled.parameters));
  assert.ok(!("background_music" in disabled.parameters));
});

test("no-bgm template: empty prompt still prepends constraint on noBgm=true", () => {
  const result = applyNoBgmTemplate({ prompt: "", noBgm: true, parameters: {} });
  assert.ok(result.prompt.includes(NO_BGM_AUDIO_CONSTRAINT));
});

test("no-bgm template: parameters are not mutated", () => {
  const params = { ratio: "16:9" };
  applyNoBgmTemplate({ prompt: "test", noBgm: true, parameters: params });
  // Original object unchanged.
  assert.equal(Object.keys(params).length, 1);
});

// ─── resolveSeedance25Params ──────────────────────────────────────────────────

test("resolveSeedance25Params: returns provided ratio/resolution/duration", () => {
  const result = seedance25Provider.resolveParameters({ ratio: "16:9", resolution: "1080p", durationSeconds: 6 });
  assert.equal(result.ratio, "16:9");
  assert.equal(result.resolution, "1080p");
  assert.equal(result.durationSeconds, 6);
});

test("resolveSeedance25Params: defaults to 9:16/720p/4s when absent", () => {
  const result = seedance25Provider.resolveParameters({});
  assert.equal(result.ratio, "9:16");
  assert.equal(result.resolution, "720p");
  assert.equal(result.durationSeconds, 4);
});

test("resolveSeedance25Params: defaults for zero/invalid durationSeconds while preserving locked duration", () => {
  assert.equal(seedance25Provider.resolveParameters({ durationSeconds: 0 }).durationSeconds, 4);
  assert.equal(seedance25Provider.resolveParameters({ durationSeconds: -1 }).durationSeconds, -1);
});
