-- migrate:up
CREATE FUNCTION app_private.create_first_owner_venue(p_command_id uuid, p_name text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog
AS $$
DECLARE
  v_actor uuid := NULLIF(current_setting('app.actor_id',true),'')::uuid;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'actor required' USING ERRCODE='42501'; END IF;
  -- Share the existing creation lock so a stale discovery or an independent tab cannot allocate twice.
  PERFORM pg_advisory_xact_lock(hashtextextended('owner-venue:'||v_actor::text,0));
  IF NOT EXISTS (SELECT 1 FROM app_private.es_command
      WHERE actor_id=v_actor AND command_type='owner.venue.create.v1'
        AND idempotency_key=p_command_id::text)
    AND (EXISTS (SELECT 1 FROM app_private.staff_membership WHERE actor_id=v_actor)
      OR EXISTS (SELECT 1 FROM app_private.es_command
        WHERE actor_id=v_actor AND command_type='owner.venue.create.v1')) THEN
    RAISE EXCEPTION 'restaurant already connected' USING ERRCODE='P0004';
  END IF;
  RETURN app_private.create_owner_venue(p_command_id,p_name);
END;
$$;
REVOKE ALL ON FUNCTION app_private.create_first_owner_venue(uuid,text) FROM PUBLIC;
GRANT CREATE ON SCHEMA app_private TO peekaplate_venue_creator;
ALTER FUNCTION app_private.create_first_owner_venue(uuid,text) OWNER TO peekaplate_venue_creator;
REVOKE CREATE ON SCHEMA app_private FROM peekaplate_venue_creator;
GRANT EXECUTE ON FUNCTION app_private.create_first_owner_venue(uuid,text) TO peekaplate_runtime;

-- migrate:down
DROP FUNCTION app_private.create_first_owner_venue(uuid,text);
