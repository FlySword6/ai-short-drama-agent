/** Server-owned source channels persisted in media_provenance_subjects. */
export type MediaSourceChannel =
  | "first_party_generation"
  | "external_upload"
  | "provider_library"
  | "unknown";

/** The routing categories required by the S49 Seedance admission contract. */
export type SeedanceImageOriginRoute =
  | "self_produced"
  | "third_party"
  | "third_party_i2i"
  | "provider_library"
  | "unknown";

/**
 * A generated media result is recorded as an application generation only
 * because the repository observed its persisted attempt.  User payload,
 * provider model labels, C2PA claims and metadata are intentionally absent:
 * none may self-certify first-party provenance.
 */
export function generatedSubjectChannelFromServerPersistence(): MediaSourceChannel {
  return "first_party_generation";
}

/**
 * The recursive closure itself is calculated in PostgreSQL.  This pure
 * mapping is used by tests/documentation to make the admission policy
 * explicit once the DB reports the source fact and the derived ancestor bit.
 */
export function classifySeedanceImageOrigin(input: {
  sourceChannel: MediaSourceChannel;
  containsExternalImageAncestor: boolean;
}): SeedanceImageOriginRoute {
  if (input.sourceChannel === "provider_library") return "provider_library";
  if (input.sourceChannel === "external_upload") return "third_party";
  if (input.sourceChannel === "unknown") return "unknown";
  return input.containsExternalImageAncestor ? "third_party_i2i" : "self_produced";
}
