/** These are server facts, never fields accepted from a browser payload. */
export const mediaSourceChannels = [
  "first_party_generation",
  "external_upload",
  "provider_library",
  "unknown",
] as const;

export type MediaSourceChannel = (typeof mediaSourceChannels)[number];

export interface ProvenanceSubject {
  subjectId: string;
  subjectKind: "asset_media" | "media_result";
  mediaKind: string;
  sourceChannel: MediaSourceChannel;
}

export interface DirectParentEdge {
  childSubjectId: string;
  parentSubjectId: string;
}

export interface LineageAuthority {
  sourceChannel: MediaSourceChannel;
  containsExternalImageAncestor: boolean;
}

/**
 * Only trusted server integrations may create this value.  Deliberately no
 * client metadata/model/C2PA fields are representable here.
 */
export type ServerSourceObservation =
  | { kind: "provider_generation"; providerTaskRecorded: true }
  | { kind: "external_upload" }
  | { kind: "provider_library" }
  | { kind: "historical_or_unprovable" };
