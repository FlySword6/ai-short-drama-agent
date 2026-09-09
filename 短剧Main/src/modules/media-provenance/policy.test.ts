import assert from "node:assert/strict";
import test from "node:test";
import {
  classifySeedanceImageOrigin,
  generatedSubjectChannelFromServerPersistence,
} from "./policy.js";

test("S49 四类来源路由：自产、直接第三方、图生图污染、方舟既有素材、未知", () => {
  assert.equal(classifySeedanceImageOrigin({
    sourceChannel: "first_party_generation",
    containsExternalImageAncestor: false,
  }), "self_produced");
  assert.equal(classifySeedanceImageOrigin({
    sourceChannel: "external_upload",
    containsExternalImageAncestor: false,
  }), "third_party");
  assert.equal(classifySeedanceImageOrigin({
    sourceChannel: "first_party_generation",
    containsExternalImageAncestor: true,
  }), "third_party_i2i");
  assert.equal(classifySeedanceImageOrigin({
    sourceChannel: "provider_library",
    containsExternalImageAncestor: false,
  }), "provider_library");
  assert.equal(classifySeedanceImageOrigin({
    sourceChannel: "unknown",
    containsExternalImageAncestor: false,
  }), "unknown");
});

test("多代图生图的外来祖先持续污染，客户端自称自产不参与判定", () => {
  // Each later generation remains a first-party *operation*, but its recursive
  // DB closure remains true after an external/unknown image entered the graph.
  assert.equal(generatedSubjectChannelFromServerPersistence(), "first_party_generation");
  assert.equal(classifySeedanceImageOrigin({
    sourceChannel: generatedSubjectChannelFromServerPersistence(),
    containsExternalImageAncestor: true,
  }), "third_party_i2i");
  // A forged browser source_channel cannot influence
  // generatedSubjectChannelFromServerPersistence: it accepts no client input.
});
