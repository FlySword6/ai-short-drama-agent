-- Grill Engine: information-insufficient clarification state + user preferences.
-- Adds clarification_state JSONB column to agent_sessions for persisting
-- the clarification round (question, collected answers, profile, step).
-- Adds user_preferences table for per-user genre/tone/style hints absorbed
-- from clarification rounds.

ALTER TABLE {{schema}}.agent_sessions
  ADD COLUMN IF NOT EXISTS clarification_state JSONB;

CREATE TABLE IF NOT EXISTS {{schema}}.user_preferences (
  user_id UUID PRIMARY KEY REFERENCES {{schema}}.users(id) ON DELETE CASCADE,
  preferred_genre VARCHAR(64),
  preferred_tone VARCHAR(64),
  style_tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_preferences_user_id
  ON {{schema}}.user_preferences(user_id);
