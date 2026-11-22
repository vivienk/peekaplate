-- migrate:up
-- Immutable routing settings; publication authority remains menu_publication_current.
CREATE TABLE app_private.restaurant_menu_link (
  tenant_id uuid NOT NULL,
  menu_id uuid NOT NULL,
  slug text PRIMARY KEY CHECK (
    slug ~ '^[a-z0-9]([a-z0-9_-]{0,62}[a-z0-9])?$'
    AND slug NOT IN ('diner','owner','venues','assets','api','auth','constructor')
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, menu_id),
  FOREIGN KEY (tenant_id, menu_id)
    REFERENCES app_private.menu_publication_current(tenant_id, menu_id) ON DELETE RESTRICT
);
CREATE TRIGGER restaurant_menu_link_immutable
  BEFORE UPDATE OR DELETE OR TRUNCATE ON app_private.restaurant_menu_link
  FOR EACH STATEMENT EXECUTE FUNCTION app_private.reject_append_only_change();
ALTER TABLE app_private.restaurant_menu_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.restaurant_menu_link FORCE ROW LEVEL SECURITY;
CREATE POLICY restaurant_menu_link_tenant ON app_private.restaurant_menu_link
  TO peekaplate_runtime
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app_private.restaurant_menu_link TO peekaplate_runtime;
GRANT SELECT (id, name) ON app_private.venues TO peekaplate_runtime;

CREATE ROLE peekaplate_public_link_reader NOLOGIN NOINHERIT
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT peekaplate_public_link_reader TO CURRENT_USER;
GRANT USAGE ON SCHEMA app_private TO peekaplate_public_link_reader;
GRANT SELECT (slug, tenant_id, menu_id) ON app_private.restaurant_menu_link
  TO peekaplate_public_link_reader;
GRANT SELECT (tenant_id, menu_id, status) ON app_private.menu_publication_current
  TO peekaplate_public_link_reader;
CREATE POLICY restaurant_menu_link_public_lookup ON app_private.restaurant_menu_link
  FOR SELECT TO peekaplate_public_link_reader USING (true);
CREATE POLICY publication_public_link_lookup ON app_private.menu_publication_current
  FOR SELECT TO peekaplate_public_link_reader USING (true);

CREATE FUNCTION app_private.resolve_restaurant_link(p_slug text)
RETURNS TABLE ("venueId" uuid, "menuId" uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT link.tenant_id, link.menu_id
    FROM app_private.restaurant_menu_link link
    JOIN app_private.menu_publication_current publication
      ON publication.tenant_id = link.tenant_id AND publication.menu_id = link.menu_id
   WHERE link.slug = p_slug AND publication.status = 'published'
     AND p_slug ~ '^[a-z0-9]([a-z0-9_-]{0,62}[a-z0-9])?$'
$$;
REVOKE ALL ON FUNCTION app_private.resolve_restaurant_link(text) FROM PUBLIC;
GRANT CREATE ON SCHEMA app_private TO peekaplate_public_link_reader;
ALTER FUNCTION app_private.resolve_restaurant_link(text) OWNER TO peekaplate_public_link_reader;
REVOKE CREATE ON SCHEMA app_private FROM peekaplate_public_link_reader;
GRANT EXECUTE ON FUNCTION app_private.resolve_restaurant_link(text) TO peekaplate_runtime;

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'Restaurant links are permanent; use a forward corrective migration.'; END $$;
