-- R131 script breakdown enrichment.
-- Old shots stay readable with NULL; newly confirmed v2 breakdowns write the
-- four structured storyboard fields as one JSON object.
ALTER TABLE {{schema}}.shots
  ADD COLUMN IF NOT EXISTS breakdown_elements jsonb;

ALTER TABLE {{schema}}.shots
  DROP CONSTRAINT IF EXISTS shots_breakdown_elements_shape_check;

ALTER TABLE {{schema}}.shots
  ADD CONSTRAINT shots_breakdown_elements_shape_check CHECK (
    breakdown_elements IS NULL
    OR (
      jsonb_typeof(breakdown_elements) = 'object'
      AND breakdown_elements - ARRAY['subject', 'action', 'visual', 'camera_language'] = '{}'::jsonb
      AND breakdown_elements ?& ARRAY['subject', 'action', 'visual', 'camera_language']
      AND jsonb_typeof(breakdown_elements->'subject') IN ('string', 'null')
      AND jsonb_typeof(breakdown_elements->'action') IN ('string', 'null')
      AND jsonb_typeof(breakdown_elements->'visual') IN ('string', 'null')
      AND jsonb_typeof(breakdown_elements->'camera_language') IN ('string', 'null')
    )
  );
