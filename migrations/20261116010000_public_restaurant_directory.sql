-- migrate:up
-- Scope-only discovery of currently published restaurants. No private venue facts.
CREATE FUNCTION app_private.list_published_restaurants(p_after uuid DEFAULT NULL)
RETURNS TABLE ("venueId" uuid, "menuId" uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT DISTINCT ON (publication.tenant_id) publication.tenant_id, publication.menu_id
    FROM app_private.menu_publication_current publication
   WHERE publication.status = 'published'
     AND (p_after IS NULL OR publication.tenant_id > p_after)
   ORDER BY publication.tenant_id, publication.menu_id
   LIMIT 65
$$;
REVOKE ALL ON FUNCTION app_private.list_published_restaurants(uuid) FROM PUBLIC;
GRANT CREATE ON SCHEMA app_private TO peekaplate_public_link_reader;
ALTER FUNCTION app_private.list_published_restaurants(uuid) OWNER TO peekaplate_public_link_reader;
REVOKE CREATE ON SCHEMA app_private FROM peekaplate_public_link_reader;
GRANT EXECUTE ON FUNCTION app_private.list_published_restaurants(uuid) TO peekaplate_runtime;

-- migrate:down
DROP FUNCTION app_private.list_published_restaurants(uuid);
