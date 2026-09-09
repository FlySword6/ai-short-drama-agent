import {
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";

interface AssetMediaOwnershipSqlInput {
  mediaEntityId: SQLWrapper;
  mediaVariantId: SQLWrapper;
  mediaApproved: SQLWrapper;
  variantId: SQLWrapper;
  variantEntityId: SQLWrapper;
}

/**
 * One read-policy predicate for media that may represent an asset publicly.
 *
 * A displayable row must be approved and have exactly one consistent owner:
 * either a direct entity, or an active variant whose entity agrees with any
 * redundant direct entity declaration. Callers must join only active variants.
 */
export function approvedAssetMediaOwnershipSql(
  input: AssetMediaOwnershipSqlInput,
): SQL {
  return sql`(
    ${input.mediaApproved} = true
    and (
      (${input.mediaVariantId} is null and ${input.mediaEntityId} is not null)
      or (
        ${input.mediaVariantId} is not null
        and ${input.variantId} is not null
        and (
          ${input.mediaEntityId} is null
          or ${input.mediaEntityId} = ${input.variantEntityId}
        )
      )
    )
  )`;
}

/** Resolve the owner only after approvedAssetMediaOwnershipSql has succeeded. */
export function assetMediaOwnerIdSql(
  mediaEntityId: SQLWrapper,
  mediaVariantId: SQLWrapper,
  variantEntityId: SQLWrapper,
): SQL<string> {
  return sql<string>`case
    when ${mediaVariantId} is not null then ${variantEntityId}
    else ${mediaEntityId}
  end`;
}
