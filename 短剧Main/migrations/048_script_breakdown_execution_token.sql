-- A reclaimed script-breakdown worker must not overwrite a later resumed
-- execution. Each claim receives a new token; all execution writes are fenced
-- by that token, and terminal/recovery paths clear it.

ALTER TABLE {{schema}}.script_breakdown_runs
  ADD COLUMN IF NOT EXISTS execution_token uuid;
