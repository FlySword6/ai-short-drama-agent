/**
 * A locally cached GetAsset/binding observation is not permanent authority.
 * Until Ark exposes a webhook or a provider-declared authorization expiry,
 * every paid Seedance path fails closed once this verification age elapses.
 */
export const SEEDANCE_ASSET_VERIFICATION_MAX_AGE_MS = 15 * 60 * 1_000;
