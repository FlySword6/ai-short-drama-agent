import type {
  DirectParentEdge,
  LineageAuthority,
  MediaSourceChannel,
  ProvenanceSubject,
  ServerSourceObservation,
} from "./types.js";

/**
 * Classifies only a server-side observation.  In particular a client-uploaded
 * model name, C2PA blob, or arbitrary metadata cannot select the trusted path.
 */
export function sourceChannelFromServerObservation(observation: ServerSourceObservation): MediaSourceChannel {
  switch (observation.kind) {
    case "provider_generation": return "first_party_generation";
    case "external_upload": return "external_upload";
    case "provider_library": return "provider_library";
    case "historical_or_unprovable": return "unknown";
  }
}

/** Pure mirror of the recursive PostgreSQL authority query, used for unit tests. */
export function deriveLineageAuthority(
  targetSubjectId: string,
  subjects: readonly ProvenanceSubject[],
  edges: readonly DirectParentEdge[],
): LineageAuthority {
  const byId = new Map(subjects.map((subject) => [subject.subjectId, subject]));
  const target = byId.get(targetSubjectId);
  if (!target) throw new Error(`Unknown provenance subject ${targetSubjectId}`);
  const parents = new Map<string, string[]>();
  for (const edge of edges) {
    const existing = parents.get(edge.childSubjectId) ?? [];
    existing.push(edge.parentSubjectId);
    parents.set(edge.childSubjectId, existing);
  }

  const visited = new Set<string>();
  const pending = [...(parents.get(targetSubjectId) ?? [])];
  while (pending.length > 0) {
    const parentId = pending.pop();
    if (!parentId || visited.has(parentId)) continue;
    visited.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) throw new Error(`Lineage edge references unknown parent ${parentId}`);
    if (parent.mediaKind === "image" && (parent.sourceChannel === "external_upload" || parent.sourceChannel === "unknown")) {
      return { sourceChannel: target.sourceChannel, containsExternalImageAncestor: true };
    }
    pending.push(...(parents.get(parentId) ?? []));
  }
  return { sourceChannel: target.sourceChannel, containsExternalImageAncestor: false };
}
