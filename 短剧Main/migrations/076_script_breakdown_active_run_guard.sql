-- One episode may have only one active script-breakdown run.  The service
-- provides the user-facing guard; this partial unique index closes the
-- concurrent create window between its read and insert.
--
-- Historical rows predate that invariant. Preserve the earliest accepted run
-- (the request that would have won if this guard had existed) and fail later
-- duplicates. Clearing their execution tokens fences any stale workers; the
-- error remains visible and the ordinary failed-run retry contract still
-- applies after the surviving active run reaches a terminal state.
WITH ranked_active_runs AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY episode_id
      ORDER BY created_at ASC, id ASC
    ) AS active_rank
  FROM {{schema}}.script_breakdown_runs
  WHERE status IN ('queued', 'running', 'draft')
),
demoted_runs AS (
  UPDATE {{schema}}.script_breakdown_runs AS run
  SET
    status = 'failed',
    execution_token = NULL,
    error_code = 'lite_run_in_flight',
    error_message = '同一集已有更早的活跃解析，迁移时已停止重复运行。',
    updated_at = now()
  FROM ranked_active_runs AS ranked
  WHERE run.id = ranked.id
    AND ranked.active_rank > 1
  RETURNING run.id
),
failed_stages AS (
  UPDATE {{schema}}.script_breakdown_run_stages AS stage
  SET
    status = 'failed',
    error_code = 'lite_run_in_flight',
    error_message = '同一集已有更早的活跃解析，迁移时已停止重复运行。',
    completed_at = now(),
    updated_at = now()
  WHERE stage.run_id IN (SELECT id FROM demoted_runs)
    AND stage.status = 'running'
  RETURNING stage.id
)
UPDATE {{schema}}.ai_calls AS call
SET
  status = 'failed',
  error_code = 'lite_run_in_flight',
  duration_ms = LEAST(
    2147483647,
    GREATEST(0, EXTRACT(EPOCH FROM (now() - call.created_at)) * 1000)
  )::integer,
  completed_at = now()
WHERE call.related_object_type = 'script_breakdown_run'
  AND call.related_object_id IN (SELECT id::text FROM demoted_runs)
  AND call.status = 'running';

CREATE UNIQUE INDEX IF NOT EXISTS script_breakdown_runs_episode_active_unique
  ON {{schema}}.script_breakdown_runs (episode_id)
  WHERE status IN ('queued', 'running', 'draft');
