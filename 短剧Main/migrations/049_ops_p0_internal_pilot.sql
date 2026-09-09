-- Issue #26: one shared internal pilot code. It snapshots the existing
-- invited-user allowance (50,000 points balance and daily ceiling) so later
-- tier edits cannot silently change a code already handed to colleagues.

-- Admin-issued codes always have an issuer. The fixed platform code is
-- system-issued before any Day-0 admin exists, so only this provenance column
-- becomes nullable; registration redemption and audit rows remain unchanged.
ALTER TABLE {{schema}}.invite_codes
  ALTER COLUMN issued_by_user_id DROP NOT NULL;

ALTER TABLE {{schema}}.invite_codes
  DROP CONSTRAINT IF EXISTS invite_codes_issuer_provenance_check;
ALTER TABLE {{schema}}.invite_codes
  ADD CONSTRAINT invite_codes_issuer_provenance_check CHECK (
    issued_by_user_id IS NOT NULL
    OR (
      id = '3d0222ba-7c6f-4ffc-901f-510c3e4aa003'::uuid
      AND code_hash = '9b062e193fc35fbf9267d3f5ec74324edb9f7dd07f333e7b0eb8c5b8f771638a'
    )
  );

INSERT INTO {{schema}}.invite_codes AS current_code (
  id,
  code_hash,
  code_prefix,
  tier_id,
  tier_key,
  grant_points,
  daily_limit_points,
  expires_at,
  max_uses,
  used_count,
  status,
  issued_by_user_id,
  created_at,
  updated_at
)
SELECT
  '3d0222ba-7c6f-4ffc-901f-510c3e4aa003',
  '9b062e193fc35fbf9267d3f5ec74324edb9f7dd07f333e7b0eb8c5b8f771638a',
  'COLTE••••',
  tier.id,
  tier.tier_key,
  50000,
  50000,
  NULL,
  2147483647,
  0,
  'active',
  NULL,
  now(),
  now()
FROM {{schema}}.invite_tiers AS tier
WHERE tier.tier_key = 'invited'
ON CONFLICT (code_hash) DO UPDATE SET
  code_prefix = EXCLUDED.code_prefix,
  tier_id = EXCLUDED.tier_id,
  tier_key = EXCLUDED.tier_key,
  grant_points = EXCLUDED.grant_points,
  daily_limit_points = EXCLUDED.daily_limit_points,
  updated_at = now()
WHERE (
  current_code.code_prefix,
  current_code.tier_id,
  current_code.tier_key,
  current_code.grant_points,
  current_code.daily_limit_points
) IS DISTINCT FROM (
  EXCLUDED.code_prefix,
  EXCLUDED.tier_id,
  EXCLUDED.tier_key,
  EXCLUDED.grant_points,
  EXCLUDED.daily_limit_points
);
