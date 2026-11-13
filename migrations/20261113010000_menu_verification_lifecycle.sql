-- migrate:up
ALTER TABLE app_private.dish_drafts
  ADD COLUMN verification_status text NOT NULL DEFAULT 'not_verified'
  CHECK (verification_status IN ('not_verified', 'verified'));

ALTER TABLE app_private.dish_draft_photo
  ADD COLUMN verification_status text NOT NULL DEFAULT 'not_verified'
  CHECK (verification_status IN ('not_verified', 'verified', 'rejected')),
  ADD COLUMN promoted_storage_key text,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE app_private.dish_current
  ADD COLUMN verification_status text NOT NULL DEFAULT 'not_verified'
  CHECK (verification_status IN ('not_verified', 'verified'));

GRANT UPDATE (verification_status) ON app_private.dish_drafts TO peekaplate_runtime;
GRANT UPDATE (storage_key, verification_status, promoted_storage_key, updated_at) ON app_private.dish_draft_photo TO peekaplate_runtime;
GRANT UPDATE (verification_status) ON app_private.dish_current TO peekaplate_runtime;

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'Menu verification lifecycle requires a forward corrective migration.'; END $$;
