-- 0.2.x control package: the human-curated reference container for one shot.
-- This migration intentionally does not require every lane to be populated:
-- `ready_marked_at` is a human decision, not a machine completeness gate.

CREATE TABLE IF NOT EXISTS {{schema}}.control_packages (
  id uuid PRIMARY KEY,
  shot_id uuid NOT NULL REFERENCES {{schema}}.shots(id) ON DELETE CASCADE,
  ready_marked_by uuid REFERENCES {{schema}}.users(id),
  ready_marked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT control_packages_shot_unique UNIQUE (shot_id),
  CONSTRAINT control_packages_ready_pair_check
    CHECK ((ready_marked_by IS NULL) = (ready_marked_at IS NULL))
);

-- Keep the forward-only migration safe if a prior partial rollout created the
-- table without this invariant.
DO $migration$
BEGIN
  ALTER TABLE {{schema}}.control_packages
    ADD CONSTRAINT control_packages_ready_pair_check
    CHECK ((ready_marked_by IS NULL) = (ready_marked_at IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL;
END $migration$;

CREATE TABLE IF NOT EXISTS {{schema}}.control_package_refs (
  id uuid PRIMARY KEY,
  package_id uuid NOT NULL REFERENCES {{schema}}.control_packages(id) ON DELETE CASCADE,
  lane varchar(24) NOT NULL,
  asset_media_id uuid REFERENCES {{schema}}.asset_media(id),
  media_result_id uuid REFERENCES {{schema}}.media_results(id),
  note varchar(512),
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT control_package_refs_lane_check
    CHECK (lane IN ('character', 'scene', 'prop', 'camera_motion', 'reference_video', 'audio')),
  CONSTRAINT control_package_refs_source_xor_check
    CHECK ((asset_media_id IS NULL) <> (media_result_id IS NULL))
);

-- PostgreSQL UNIQUE treats NULL values as distinct. Partial indexes make the
-- requested "same object in the same lane is idempotent" rule executable.
CREATE UNIQUE INDEX IF NOT EXISTS control_package_refs_asset_lane_unique
  ON {{schema}}.control_package_refs (package_id, lane, asset_media_id)
  WHERE asset_media_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS control_package_refs_result_lane_unique
  ON {{schema}}.control_package_refs (package_id, lane, media_result_id)
  WHERE media_result_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS control_package_refs_package_lane_sort_idx
  ON {{schema}}.control_package_refs (package_id, lane, sort_order, created_at);
