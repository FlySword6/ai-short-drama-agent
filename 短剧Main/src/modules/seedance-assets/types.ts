import type { PublicVolcAssetFailureCode } from "../assets/volcAssetRegistry.js";
import type { ProjectAccessActor } from "../project-access/types.js";

/**
 * Local truth for an Ark private-library registration. The remote asset is
 * only eligible for generation after its persisted status is `active`.
 */
/**
 * `submitting` owns an in-flight CreateAsset call. `unknown` means the
 * transport outcome is ambiguous, so the system must not issue another
 * CreateAsset automatically and risk duplicating a remote asset.
 */
export type SeedanceAssetRegistrationStatus =
  | "pending"
  | "submitting"
  | "processing"
  | "active"
  | "failed"
  | "unknown"
  | "unavailable";

export interface SeedanceAssetRegistrationView {
  id: string;
  assetMediaId: string;
  sourceMediaResultId: string | null;
  assetGroupId: string | null;
  remoteAssetId: string | null;
  status: SeedanceAssetRegistrationStatus;
  createdAt: Date;
  updatedAt: Date;
  activatedAt: Date | null;
  authorizationExpiresAt: Date | null;
  lastVerifiedAt: Date | null;
  latestRequestId: string | null;
  latestErrorCode: PublicVolcAssetFailureCode | null;
  latestErrorMessage: string | null;
  retryCount: number;
  lastRetryAt: Date | null;
}

/**
 * HTTP callers pass the authenticated platform role through to the
 * repository.  The string form keeps narrow offline/legacy callers
 * source-compatible and is deliberately interpreted as an ordinary member.
 */
export type SeedanceAssetRegistrationActor = string | ProjectAccessActor;

/**
 * HTTP routes depend on this narrow port so they can be verified without a
 * database or an external Ark call.
 */
export interface SeedanceAssetRegistrationPort {
  registerMediaResult(actor: SeedanceAssetRegistrationActor, mediaResultId: string): Promise<SeedanceAssetRegistrationView>;
  registerAssetMedia(actor: SeedanceAssetRegistrationActor, assetId: string, mediaId: string): Promise<SeedanceAssetRegistrationView>;
  refreshMediaResult(actor: SeedanceAssetRegistrationActor, mediaResultId: string): Promise<SeedanceAssetRegistrationView>;
  refreshAssetMedia(actor: SeedanceAssetRegistrationActor, assetId: string, mediaId: string): Promise<SeedanceAssetRegistrationView>;
  getMediaResult(actor: SeedanceAssetRegistrationActor, mediaResultId: string): Promise<SeedanceAssetRegistrationView>;
  getAssetMedia(actor: SeedanceAssetRegistrationActor, assetId: string, mediaId: string): Promise<SeedanceAssetRegistrationView>;
  getRegistration(actor: SeedanceAssetRegistrationActor, registrationId: string): Promise<SeedanceAssetRegistrationView>;
  refreshRegistration(actor: SeedanceAssetRegistrationActor, registrationId: string): Promise<SeedanceAssetRegistrationView>;
}
