-- V0.2.0 hybrid asset search lexical foundation.
--
-- PostgreSQL stays the source of truth.  Milvus is a rebuildable semantic
-- projection, while this migration maintains the lexical text that the hybrid
-- service will search and fuse through RRF.  `pg_trgm` is deliberately a DBA
-- precondition: a schema-scoped release role must not gain database-wide
-- CREATE privilege just to install an extension.

DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    RAISE EXCEPTION
      '混合检索迁移需要 PostgreSQL 扩展 pg_trgm；请由数据库管理员先启用后再执行迁移'
      USING ERRCODE = '55000';
  END IF;
END;
$migration$;

-- `search_text` intentionally contains only approved human-facing retrieval
-- fields.  It never includes metadata, object-storage locations, URLs, IDs,
-- review history, or provider payloads.
ALTER TABLE IF EXISTS {{schema}}.asset_entities
  ADD COLUMN IF NOT EXISTS search_text text NOT NULL DEFAULT '';

ALTER TABLE IF EXISTS {{schema}}.asset_variants
  ADD COLUMN IF NOT EXISTS search_text text NOT NULL DEFAULT '';

CREATE OR REPLACE FUNCTION {{schema}}.refresh_asset_entity_search_text()
RETURNS trigger
LANGUAGE plpgsql
AS $migration$
DECLARE
  style_tags_text text;
BEGIN
  IF jsonb_typeof(COALESCE(NEW.style_tags, '[]'::jsonb)) = 'array' THEN
    SELECT string_agg(tag.value, ' ')
    INTO style_tags_text
    FROM jsonb_array_elements_text(NEW.style_tags) AS tag(value);
  END IF;

  -- Contracted entity fields: name/display name, source project, descriptive
  -- profile, category/style, and explicit structured attributes.  A label on
  -- numeric attributes keeps the stored text legible in diagnostics.
  NEW.search_text := regexp_replace(
    btrim(concat_ws(' ',
      NEW.name,
      NEW.display_name,
      NEW.source_project_name,
      NEW.intro,
      NEW.appearance,
      NEW.hair_description,
      NEW.outfit_description,
      NEW.category,
      style_tags_text,
      NEW.gender,
      CASE WHEN NEW.age_value IS NULL THEN NULL ELSE concat('年龄 ', NEW.age_value::text, ' 岁') END,
      CASE WHEN NEW.height_cm IS NULL THEN NULL ELSE concat('身高 ', NEW.height_cm::text, ' cm') END,
      NEW.asset_kind,
      NEW.role
    )),
    '[[:space:]]+',
    ' ',
    'g'
  );
  RETURN NEW;
END;
$migration$;

CREATE OR REPLACE FUNCTION {{schema}}.refresh_asset_variant_search_text()
RETURNS trigger
LANGUAGE plpgsql
AS $migration$
BEGIN
  -- Contracted variant fields only.  Parent entity text remains on the entity
  -- document; copying it here would create a hidden cross-row maintenance
  -- dependency whenever the parent changes.
  NEW.search_text := regexp_replace(
    btrim(concat_ws(' ',
      NEW.name,
      NEW.description,
      NEW.usage_context,
      NEW.visual_prompt,
      NEW.source_text
    )),
    '[[:space:]]+',
    ' ',
    'g'
  );
  RETURN NEW;
END;
$migration$;

DROP TRIGGER IF EXISTS asset_entities_refresh_search_text ON {{schema}}.asset_entities;
CREATE TRIGGER asset_entities_refresh_search_text
BEFORE INSERT OR UPDATE ON {{schema}}.asset_entities
FOR EACH ROW EXECUTE FUNCTION {{schema}}.refresh_asset_entity_search_text();

DROP TRIGGER IF EXISTS asset_variants_refresh_search_text ON {{schema}}.asset_variants;
CREATE TRIGGER asset_variants_refresh_search_text
BEFORE INSERT OR UPDATE ON {{schema}}.asset_variants
FOR EACH ROW EXECUTE FUNCTION {{schema}}.refresh_asset_variant_search_text();

-- Re-run every historical row through the trigger so `search_text` is not
-- contingent on a future write.  This is intentionally idempotent.
UPDATE {{schema}}.asset_entities
SET search_text = search_text;

UPDATE {{schema}}.asset_variants
SET search_text = search_text;

-- Only assets that remain visible to search are indexed.  This aligns the
-- PostgreSQL candidate pool with the clearance rule before RRF and prevents a
-- deleted or search-disabled asset from being recalled merely by keywords.
CREATE INDEX IF NOT EXISTS asset_entities_search_text_trgm_active_idx
  ON {{schema}}.asset_entities USING gin (search_text gin_trgm_ops)
  WHERE deleted_at IS NULL
    AND COALESCE(clearance ->> 'search', 'true') = 'true';

CREATE INDEX IF NOT EXISTS asset_variants_search_text_trgm_active_idx
  ON {{schema}}.asset_variants USING gin (search_text gin_trgm_ops)
  WHERE deleted_at IS NULL;

-- Visibility and project-reference indexes support the authorization filter
-- that is applied before a result is returned.  These do not grant access;
-- `project_members` remains the project authorization truth.
CREATE INDEX IF NOT EXISTS asset_entities_search_visibility_owner_idx
  ON {{schema}}.asset_entities (visibility, owner_user_id, id)
  WHERE deleted_at IS NULL
    AND COALESCE(clearance ->> 'search', 'true') = 'true';

CREATE INDEX IF NOT EXISTS asset_variants_asset_entity_active_idx
  ON {{schema}}.asset_variants (asset_entity_id, id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS project_asset_refs_entity_project_active_idx
  ON {{schema}}.project_asset_refs (asset_entity_id, project_id)
  WHERE deleted_at IS NULL;
