import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  labelAigcMedia,
  readAigcImplicitLabel,
} from "../../src/modules/generation/aigcLabeler.js";

const s50E1VideoPath = process.env.S50_E1_VIDEO_PATH;

/**
 * This is intentionally a local, zero-cost regression.  The fixed S50
 * handoff remains the only evidence that Seedance accepted both the original
 * and metadata-appended video.  Here we verify that S49's writer keeps the
 * same provider C2PA/JUMBF observation while it updates the single Appendix
 * E label; no Ark request is sent.
 */
test("S50 E1 source keeps provider C2PA/JUMBF while S49 updates one implicit label", {
  skip: !s50E1VideoPath && "set S50_E1_VIDEO_PATH to the local S50 E1 source video",
}, async () => {
  assert.ok(s50E1VideoPath);
  const source = await readFile(path.resolve(s50E1VideoPath));
  const first = await labelAigcMedia({
    content: source,
    mediaKind: "video",
    contentType: "video/mp4",
    extension: "mp4",
    produceId: "s49-e1-regression:0",
  });
  const second = await labelAigcMedia({
    content: first.content,
    mediaKind: "video",
    contentType: "video/mp4",
    extension: "mp4",
    produceId: "s49-e1-regression:1",
  });

  const firstEvidence = first.complianceMetadata.providerOriginEvidence;
  const secondEvidence = second.complianceMetadata.providerOriginEvidence;
  assert.ok(firstEvidence, "S50 E1 input must retain an observed provider C2PA/JUMBF manifest");
  assert.ok(secondEvidence, "updated S49 output must retain provider origin evidence");
  assert.equal(firstEvidence.manifestFingerprint, secondEvidence.manifestFingerprint);
  assert.equal(firstEvidence.c2paPresentBefore, true);
  assert.equal(secondEvidence.c2paPresentAfter, true);
  const label = await readAigcImplicitLabel(second.content, "video", "mp4");
  assert.equal(label.ProduceID, "s49-e1-regression:1");
  assert.equal(label.PropagateID, "s49-e1-regression:1");
});
