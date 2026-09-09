-- S-goal-06: resource-scoped cache/ledger keys for the catalog and each page.
-- Existing 018 rows are a legacy preselected hot-list snapshot, not the new
-- catalog resource. New repository writes always provide an explicit scope.
ALTER TABLE {{schema}}.topic_radar_snapshots ADD COLUMN IF NOT EXISTS resource_scope varchar(128) NOT NULL DEFAULT 'legacy_hot';
ALTER TABLE {{schema}}.topic_radar_upstream_calls ADD COLUMN IF NOT EXISTS resource_scope varchar(128) NOT NULL DEFAULT 'legacy_hot';
DROP INDEX IF EXISTS {{schema}}.topic_radar_upstream_calls_daily_unique;
DROP INDEX IF EXISTS {{schema}}.topic_radar_upstream_calls_manual_unique;
CREATE UNIQUE INDEX IF NOT EXISTS topic_radar_upstream_calls_daily_unique ON {{schema}}.topic_radar_upstream_calls (source, cache_date, request_kind, resource_scope) WHERE request_kind = 'daily';
CREATE UNIQUE INDEX IF NOT EXISTS topic_radar_upstream_calls_manual_unique ON {{schema}}.topic_radar_upstream_calls (source, cache_date, request_kind, resource_scope) WHERE request_kind = 'manual';
CREATE INDEX IF NOT EXISTS topic_radar_snapshots_scope_fetched_idx ON {{schema}}.topic_radar_snapshots (source, resource_scope, fetched_at DESC, id DESC);
