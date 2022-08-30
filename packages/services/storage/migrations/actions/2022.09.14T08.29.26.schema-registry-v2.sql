-- 
-- Add new things
-- 
CREATE TYPE commit_action AS ENUM ('ADD', 'MODIFY', 'DELETE', 'N/A');
CREATE TYPE schema_change_criticality_level AS ENUM ('SAFE', 'DANGEROUS', 'BREAKING');

ALTER TABLE public.commits
  ADD COLUMN service_url text,
  ADD COLUMN service_name text,
  ADD COLUMN sdl text,
  ADD COLUMN action commit_action;

ALTER TABLE public.versions
  ADD COLUMN is_composable boolean;

ALTER TABLE public.projects
  ADD COLUMN legacy_registry_model boolean NOT NULL DEFAULT FALSE;

-- 
-- migrate the state
-- 

-- migrate from valid to is_composable
UPDATE public.versions SET is_composable = valid;
-- migrate from service to service_name
UPDATE public.commits SET service_name = service;
-- migrate from content to sdl
UPDATE public.commits SET sdl = content;
-- set 'projects.legacy_registry_model' to 'FALSE' for all projects
UPDATE public.projects SET legacy_registry_model = TRUE WHERE type = 'FEDERATION' OR type = 'STITCHING';

-- move 'version_commit.url' to 'commits.service_url'
UPDATE public.commits
SET service_url = (
  SELECT vc.url FROM public.version_commit vc
  LEFT JOIN public.versions v ON v.id = vc.version_id
  WHERE vc.commit_id = commits.id
  ORDER BY v.created_at DESC LIMIT 1
);

-- set 'N/A' for single/custom projects
UPDATE public.commits
SET action = 'N/A'
WHERE project_id IN (
  SELECT id FROM public.projects WHERE type = 'SINGLE' OR type = 'CUSTOM'
);

-- set 'ADD' for commits where 'service_name' appears for the first time (stitching/federation projects)
UPDATE public.commits
SET action = 'ADD'
WHERE id IN (
  SELECT DISTINCT ON (c.service, c.target_id) c.id
  FROM public.commits c
  LEFT JOIN public.projects p ON p.id = c.project_id
  WHERE p.type = 'FEDERATION' OR p.type = 'STITCHING'
  GROUP BY (c.service, c.target_id, c.created_at, c.id)
  ORDER BY c.service, c.target_id, c.created_at ASC
);

-- set 'MODIFY' for commits where 'service_name' does not appear for the first time (stitching/federation projects)
UPDATE public.commits
SET action = 'MODIFY'
WHERE 
  action is null
  AND 
  project_id IN (
    SELECT id FROM public.projects WHERE type = 'FEDERATION' OR type = 'STITCHING'
  )
;

-- 
-- Make null non-nullable and drop migrated columns
-- 
ALTER TABLE public.commits DROP COLUMN service;
ALTER TABLE public.commits DROP COLUMN content;
ALTER TABLE public.versions DROP COLUMN valid;
ALTER TABLE public.version_commit DROP COLUMN url;
ALTER TABLE public.commits ALTER COLUMN action SET NOT NULL;
ALTER TABLE public.versions ALTER COLUMN is_composable SET NOT NULL;