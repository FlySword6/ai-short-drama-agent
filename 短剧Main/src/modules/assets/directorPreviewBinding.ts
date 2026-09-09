import {
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";

const DIRECTOR_PREVIEW_ROLE = "director_3d_preview";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const sha256 = /^[0-9a-f]{64}$/u;

export interface DirectorPreviewBinding {
  sourceMediaId: string;
  sourceSha256: string;
}

/**
 * Normalizes the one supported director-preview meaning at the read seam.
 *
 * Current writers emit role/sourceMediaId/sourceSha256. The 519 historical
 * previews use previewOfAssetMediaId/previewOfSha256 and omit role. A row that
 * carries both shapes is ambiguous and fails closed rather than creating two
 * competing truths.
 */
export function directorPreviewBinding(
  metadata: Record<string, unknown>,
): DirectorPreviewBinding | null {
  const role = text(metadata.role);
  const canonicalId = text(metadata.sourceMediaId);
  const canonicalSha = text(metadata.sourceSha256);
  const legacyId = text(metadata.previewOfAssetMediaId);
  const legacySha = text(metadata.previewOfSha256);
  const hasCanonical = hasOwn(metadata, "role")
    || hasOwn(metadata, "sourceMediaId")
    || hasOwn(metadata, "sourceSha256");
  const hasLegacy = hasOwn(metadata, "previewOfAssetMediaId")
    || hasOwn(metadata, "previewOfSha256");
  if (hasCanonical && hasLegacy) return null;

  if (
    role === DIRECTOR_PREVIEW_ROLE
    && isSourceMediaId(canonicalId)
    && isSha256(canonicalSha)
  ) {
    return { sourceMediaId: canonicalId, sourceSha256: canonicalSha };
  }
  if (
    role === null
    && isSourceMediaId(legacyId)
    && isSha256(legacySha)
  ) {
    return { sourceMediaId: legacyId, sourceSha256: legacySha };
  }
  return null;
}

export function isDirectorPreviewMetadata(
  metadata: Record<string, unknown>,
): boolean {
  return directorPreviewBinding(metadata) !== null;
}

/**
 * Preview intent is deliberately broader than a valid binding. Malformed or
 * mixed-shape preview rows must stay display-only and fail closed instead of
 * falling back to an unrelated ordinary image.
 */
export function hasDirectorPreviewIntent(
  metadata: Record<string, unknown>,
): boolean {
  return metadata.role === DIRECTOR_PREVIEW_ROLE
    || metadata.sourceMediaId !== undefined
    || metadata.sourceSha256 !== undefined
    || metadata.previewOfAssetMediaId !== undefined
    || metadata.previewOfSha256 !== undefined;
}

/**
 * SQL equivalents of directorPreviewBinding(). Callers compare the normalized
 * values to authoritative asset_media rows; neither legacy nor current field
 * names leak past this module.
 */
export function directorPreviewSourceMediaIdSql(metadata: SQLWrapper): SQL<string> {
  return sql<string>`case
    when ${metadata}->>'role' = 'director_3d_preview'
      and not (${metadata} ? 'previewOfAssetMediaId')
      and not (${metadata} ? 'previewOfSha256')
    then ${metadata}->>'sourceMediaId'
    when not (${metadata} ? 'role')
      and not (${metadata} ? 'sourceMediaId')
      and not (${metadata} ? 'sourceSha256')
    then ${metadata}->>'previewOfAssetMediaId'
    else null
  end`;
}

export function directorPreviewSourceSha256Sql(metadata: SQLWrapper): SQL<string> {
  return sql<string>`case
    when ${metadata}->>'role' = 'director_3d_preview'
      and not (${metadata} ? 'previewOfAssetMediaId')
      and not (${metadata} ? 'previewOfSha256')
    then ${metadata}->>'sourceSha256'
    when not (${metadata} ? 'role')
      and not (${metadata} ? 'sourceMediaId')
      and not (${metadata} ? 'sourceSha256')
    then ${metadata}->>'previewOfSha256'
    else null
  end`;
}

export function directorPreviewBindingSql(metadata: SQLWrapper): SQL {
  const sourceMediaId = directorPreviewSourceMediaIdSql(metadata);
  const sourceSha256 = directorPreviewSourceSha256Sql(metadata);
  return sql`(
    ${sourceMediaId} ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    and ${sourceSha256} ~ '^[0-9a-f]{64}$'
  )`;
}

export function directorPreviewIntentSql(metadata: SQLWrapper): SQL {
  return sql`coalesce((
    ${metadata}->>'role' = 'director_3d_preview'
    or ${metadata} ? 'sourceMediaId'
    or ${metadata} ? 'sourceSha256'
    or ${metadata} ? 'previewOfAssetMediaId'
    or ${metadata} ? 'previewOfSha256'
  ), false)`;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isSourceMediaId(value: string | null): value is string {
  return value !== null && uuid.test(value);
}

function isSha256(value: string | null): value is string {
  return value !== null && sha256.test(value);
}
