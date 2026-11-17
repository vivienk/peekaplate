-- migrate:up
-- A reopened pending draft retains its historical canonical dish association. Approval is still
-- determined by review_status; superseded drafts cannot keep a link. Keep the tenant FK and the
-- existing pending reviewed_by/reviewed_at checks unchanged.
ALTER TABLE app_private.dish_drafts
  DROP CONSTRAINT dish_drafts_check,
  DROP CONSTRAINT dish_drafts_check3,
  ADD CONSTRAINT dish_drafts_check CHECK (review_status <> 'superseded' OR published_dish_id IS NULL),
  ADD CONSTRAINT dish_drafts_check3 CHECK (published_dish_id IS NULL OR review_status IN ('pending','accepted','edited'));
-- Owner-prepared menus (automatic menu preparation, Part A). After an owner verifies their
-- dishes, the Worker builds the public menu bundle and admits it for S13 through this one
-- narrow function. The runtime role still cannot insert menu_review_subject or
-- public_menu_bundle directly; the operator path (produce:bundle --admit) is unchanged.
-- Admission is not approval or publication: the owner still approves and publishes in S13.
CREATE ROLE peekaplate_menu_preparer NOLOGIN NOINHERIT
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT peekaplate_menu_preparer TO CURRENT_USER;
GRANT USAGE ON SCHEMA app_private TO peekaplate_menu_preparer;
-- The existing tenant and actor RLS policies apply to this role as to every role.
GRANT SELECT (tenant_id, actor_id, permission) ON app_private.staff_membership
  TO peekaplate_menu_preparer;
GRANT SELECT, INSERT ON app_private.menu_review_subject TO peekaplate_menu_preparer;
GRANT SELECT, INSERT ON app_private.public_menu_bundle TO peekaplate_menu_preparer;

CREATE FUNCTION app_private.admit_owner_prepared_menu(
  p_menu_id uuid,
  p_menu_revision_id uuid,
  p_content_approval_id uuid,
  p_content_hash text,
  p_asset_approval_id uuid,
  p_asset_manifest_hash text,
  p_bundle_url text
) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  v_tenant uuid := NULLIF(current_setting('app.tenant_id', true), '')::uuid;
  v_actor uuid := NULLIF(current_setting('app.actor_id', true), '')::uuid;
  v_inserted integer := 0;
  v_rows integer;
  v_subject app_private.menu_review_subject%ROWTYPE;
  v_url text;
BEGIN
  IF v_tenant IS NULL OR v_actor IS NULL THEN
    RAISE EXCEPTION 'owner scope required' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app_private.staff_membership m
     WHERE m.tenant_id = v_tenant AND m.actor_id = v_actor AND m.permission = 'owner'
  ) THEN
    RAISE EXCEPTION 'owner membership required' USING ERRCODE = '42501';
  END IF;
  -- Only the Worker's own immutable bundle address for exactly this venue/menu/revision.
  IF p_bundle_url IS NULL OR p_bundle_url !~ ('^https://[a-z0-9.-]+(:[0-9]+)?/public/prepared-bundles/'
      || v_tenant::text || '/' || p_menu_id::text || '/' || p_menu_revision_id::text || '\.json$') THEN
    RAISE EXCEPTION 'unexpected bundle url' USING ERRCODE = '22023';
  END IF;

  INSERT INTO app_private.menu_review_subject
    (tenant_id, menu_id, menu_revision_id, content_approval_id, content_hash,
     asset_approval_id, asset_manifest_hash)
  VALUES (v_tenant, p_menu_id, p_menu_revision_id, p_content_approval_id, p_content_hash,
          p_asset_approval_id, p_asset_manifest_hash)
  ON CONFLICT (tenant_id, menu_id, menu_revision_id) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_inserted := v_inserted + v_rows;
  INSERT INTO app_private.public_menu_bundle (tenant_id, menu_id, menu_revision_id, bundle_url)
  VALUES (v_tenant, p_menu_id, p_menu_revision_id, p_bundle_url)
  ON CONFLICT (tenant_id, menu_id, menu_revision_id) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_inserted := v_inserted + v_rows;

  SELECT * INTO v_subject FROM app_private.menu_review_subject s
   WHERE s.tenant_id = v_tenant AND s.menu_id = p_menu_id AND s.menu_revision_id = p_menu_revision_id;
  SELECT b.bundle_url INTO v_url FROM app_private.public_menu_bundle b
   WHERE b.tenant_id = v_tenant AND b.menu_id = p_menu_id AND b.menu_revision_id = p_menu_revision_id;
  IF v_subject.content_approval_id IS DISTINCT FROM p_content_approval_id
     OR v_subject.content_hash IS DISTINCT FROM p_content_hash
     OR v_subject.asset_approval_id IS DISTINCT FROM p_asset_approval_id
     OR v_subject.asset_manifest_hash IS DISTINCT FROM p_asset_manifest_hash
     OR v_url IS DISTINCT FROM p_bundle_url THEN
    RAISE EXCEPTION 'handoff conflict' USING ERRCODE = '23505';
  END IF;
  RETURN CASE WHEN v_inserted > 0 THEN 'inserted' ELSE 'already_present' END;
END;
$$;
REVOKE ALL ON FUNCTION app_private.admit_owner_prepared_menu(uuid, uuid, uuid, text, uuid, text, text)
  FROM PUBLIC;
GRANT CREATE ON SCHEMA app_private TO peekaplate_menu_preparer;
ALTER FUNCTION app_private.admit_owner_prepared_menu(uuid, uuid, uuid, text, uuid, text, text)
  OWNER TO peekaplate_menu_preparer;
REVOKE CREATE ON SCHEMA app_private FROM peekaplate_menu_preparer;
GRANT EXECUTE ON FUNCTION app_private.admit_owner_prepared_menu(uuid, uuid, uuid, text, uuid, text, text)
  TO peekaplate_runtime;

-- migrate:down
DROP FUNCTION app_private.admit_owner_prepared_menu(uuid, uuid, uuid, text, uuid, text, text);
REVOKE ALL ON app_private.public_menu_bundle FROM peekaplate_menu_preparer;
REVOKE ALL ON app_private.menu_review_subject FROM peekaplate_menu_preparer;
REVOKE ALL ON app_private.staff_membership FROM peekaplate_menu_preparer;
REVOKE USAGE ON SCHEMA app_private FROM peekaplate_menu_preparer;
DROP ROLE peekaplate_menu_preparer;
ALTER TABLE app_private.dish_drafts
  DROP CONSTRAINT dish_drafts_check,
  DROP CONSTRAINT dish_drafts_check3,
  ADD CONSTRAINT dish_drafts_check CHECK (review_status NOT IN ('pending','superseded') OR published_dish_id IS NULL),
  ADD CONSTRAINT dish_drafts_check3 CHECK (published_dish_id IS NULL OR review_status IN ('accepted','edited'));
