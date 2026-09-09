-- R128: personal assets are immediately usable and never enter the review
-- state machine. Normalize historical entity, variant, and media projections
-- without changing their creation/update timestamps or deleting audit history.
UPDATE {{schema}}.asset_entities
SET status = 'approved', approved = TRUE
WHERE visibility = 'personal'
  AND (status IS DISTINCT FROM 'approved' OR approved IS DISTINCT FROM TRUE);

UPDATE {{schema}}.asset_variants AS variant
SET status = 'approved', approved = TRUE
FROM {{schema}}.asset_entities AS entity
WHERE variant.asset_entity_id = entity.id
  AND entity.visibility = 'personal'
  AND (variant.status IS DISTINCT FROM 'approved' OR variant.approved IS DISTINCT FROM TRUE);

UPDATE {{schema}}.asset_media AS media
SET approved = TRUE
WHERE media.approved IS DISTINCT FROM TRUE
  AND (
    EXISTS (
      SELECT 1
      FROM {{schema}}.asset_entities AS entity
      WHERE entity.id = media.asset_entity_id
        AND entity.visibility = 'personal'
    )
    OR EXISTS (
      SELECT 1
      FROM {{schema}}.asset_variants AS variant
      JOIN {{schema}}.asset_entities AS entity ON entity.id = variant.asset_entity_id
      WHERE variant.id = media.asset_variant_id
        AND entity.visibility = 'personal'
    )
  );
