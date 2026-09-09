-- Project-level generation defaults. Image and video resolutions remain
-- independent because provider capability matrices use different scales.

ALTER TABLE {{schema}}.projects
  ADD COLUMN IF NOT EXISTS default_ratio varchar(5) NOT NULL DEFAULT '9:16',
  ADD COLUMN IF NOT EXISTS default_image_resolution varchar(64) NOT NULL DEFAULT '1K',
  ADD COLUMN IF NOT EXISTS default_video_resolution varchar(64) NOT NULL DEFAULT '720p',
  ADD COLUMN IF NOT EXISTS image_style_description text,
  ADD COLUMN IF NOT EXISTS video_style_description text,
  ADD COLUMN IF NOT EXISTS image_style_reference_media_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS video_style_reference_media_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS image_prompt_template text,
  ADD COLUMN IF NOT EXISTS video_prompt_template text;

ALTER TABLE {{schema}}.projects
  ADD CONSTRAINT projects_default_ratio_check
    CHECK (default_ratio IN ('9:16', '16:9', '1:1')),
  ADD CONSTRAINT projects_default_image_resolution_nonblank_check
    CHECK (char_length(btrim(default_image_resolution)) > 0),
  ADD CONSTRAINT projects_default_video_resolution_nonblank_check
    CHECK (char_length(btrim(default_video_resolution)) > 0),
  ADD CONSTRAINT projects_image_style_reference_media_ids_array_check
    CHECK (jsonb_typeof(image_style_reference_media_ids) = 'array'),
  ADD CONSTRAINT projects_video_style_reference_media_ids_array_check
    CHECK (jsonb_typeof(video_style_reference_media_ids) = 'array');
