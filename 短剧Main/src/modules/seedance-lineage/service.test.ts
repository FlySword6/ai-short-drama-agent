import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveLineageAuthority,
  sourceChannelFromServerObservation,
} from "./service.js";
import type { DirectParentEdge, ProvenanceSubject } from "./types.js";

test("first-party image with no parents keeps its own first-party lineage authority", () => {
  const authority = deriveLineageAuthority("first", [
    {
      subjectId: "first",
      subjectKind: "media_result",
      mediaKind: "image",
      sourceChannel: "first_party_generation",
    },
  ], []);
  assert.deepEqual(authority, { sourceChannel: "first_party_generation", containsExternalImageAncestor: false });
});

test("direct external image parent is inherited in lineage authority", () => {
  const subjects: ProvenanceSubject[] = [
    { subjectId: "external", subjectKind: "asset_media", mediaKind: "image", sourceChannel: "external_upload" },
    { subjectId: "output", subjectKind: "media_result", mediaKind: "image", sourceChannel: "first_party_generation" },
  ];
  const edges: DirectParentEdge[] = [{ childSubjectId: "output", parentSubjectId: "external" }];
  const authority = deriveLineageAuthority("output", subjects, edges);
  assert.equal(authority.containsExternalImageAncestor, true);
});

test("external image lineage survives one and multiple model generations", () => {
  const subjects: ProvenanceSubject[] = [
    { subjectId: "external", subjectKind: "asset_media", mediaKind: "image", sourceChannel: "external_upload" },
    { subjectId: "one", subjectKind: "media_result", mediaKind: "image", sourceChannel: "first_party_generation" },
    { subjectId: "promoted", subjectKind: "asset_media", mediaKind: "image", sourceChannel: "first_party_generation" },
    { subjectId: "many", subjectKind: "media_result", mediaKind: "image", sourceChannel: "first_party_generation" },
  ];
  const edges: DirectParentEdge[] = [
    { childSubjectId: "one", parentSubjectId: "external" },
    { childSubjectId: "promoted", parentSubjectId: "one" },
    { childSubjectId: "many", parentSubjectId: "promoted" },
  ];
  assert.equal(deriveLineageAuthority("one", subjects, edges).containsExternalImageAncestor, true);
  assert.equal(deriveLineageAuthority("many", subjects, edges).containsExternalImageAncestor, true);
});

test("historical and client-forged claims stay unknown unless a server observation proves generation", () => {
  assert.equal(sourceChannelFromServerObservation({ kind: "historical_or_unprovable" }), "unknown");
  const forgedClientMetadata = { model: "seedream-5-pro", c2pa: "claimed", source_channel: "first_party_generation" };
  assert.equal(sourceChannelFromServerObservation({ kind: "historical_or_unprovable", ...forgedClientMetadata }), "unknown");
  assert.equal(sourceChannelFromServerObservation({ kind: "provider_generation", providerTaskRecorded: true }), "first_party_generation");
  assert.equal(sourceChannelFromServerObservation({ kind: "provider_library" }), "provider_library");
});
