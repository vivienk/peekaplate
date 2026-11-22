-- migrate:up
-- Only the production ingress can stamp new events. Existing rows remain unattributed.
ALTER TABLE app_private.observation_event
  ADD COLUMN source_environment text
  CHECK (source_environment IS NULL OR source_environment = 'production');

-- migrate:down
ALTER TABLE app_private.observation_event DROP COLUMN source_environment;
