-- migrate:up
-- A fresh verified actor can allocate a NEW staging restaurant, never join an existing one.
-- The application is staging/local-only. Runtime gets EXECUTE, not INSERT privileges.
CREATE ROLE peekaplate_venue_creator NOLOGIN NOINHERIT
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT peekaplate_venue_creator TO CURRENT_USER;
GRANT USAGE ON SCHEMA app_private TO peekaplate_venue_creator;
GRANT INSERT ON app_private.venues, app_private.es_event, app_private.outbox TO peekaplate_venue_creator;
GRANT SELECT, INSERT ON app_private.staff_membership, app_private.es_command TO peekaplate_venue_creator;
-- Existing tenant policies govern writes; only this function role can insert owner membership.
CREATE POLICY owner_venue_member_insert ON app_private.staff_membership
  FOR INSERT TO peekaplate_venue_creator WITH CHECK (
    tenant_id = NULLIF(current_setting('app.tenant_id', true),'')::uuid
    AND actor_id = NULLIF(current_setting('app.actor_id', true),'')::uuid AND permission='owner');
-- Replay/quota discovery happens before a tenant exists. No general runtime receipt read is added.
CREATE POLICY owner_venue_receipt_read ON app_private.es_command
  FOR SELECT TO peekaplate_venue_creator USING (
    actor_id = NULLIF(current_setting('app.actor_id', true),'')::uuid
    AND command_type='owner.venue.create.v1');
CREATE UNIQUE INDEX owner_venue_command_identity ON app_private.es_command(actor_id,idempotency_key)
  WHERE command_type='owner.venue.create.v1';

CREATE FUNCTION app_private.create_owner_venue(p_command_id uuid, p_name text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog
AS $$
DECLARE
  v_actor uuid := NULLIF(current_setting('app.actor_id',true),'')::uuid;
  v_previous_tenant text := current_setting('app.tenant_id',true);
  v_name text := btrim(p_name);
  v_receipt app_private.es_command%ROWTYPE;
  v_hash text;
  v_venue uuid;
  v_event uuid;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'actor required' USING ERRCODE='42501'; END IF;
  IF p_command_id IS NULL OR v_name IS NULL OR char_length(v_name) NOT BETWEEN 1 AND 160
    OR v_name ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'invalid creation' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('owner-venue:'||v_actor::text,0));
  v_hash := encode(sha256(convert_to(jsonb_build_object('name',v_name)::text,'UTF8')),'hex');
  SELECT * INTO v_receipt FROM app_private.es_command
    WHERE actor_id=v_actor AND command_type='owner.venue.create.v1'
      AND idempotency_key=p_command_id::text;
  IF FOUND THEN
    IF v_receipt.request_hash<>v_hash THEN RAISE EXCEPTION 'command conflict' USING ERRCODE='P0003'; END IF;
    PERFORM set_config('app.tenant_id',v_receipt.tenant_id::text,true);
    IF NOT EXISTS (SELECT 1 FROM app_private.staff_membership
      WHERE tenant_id=v_receipt.tenant_id AND actor_id=v_actor AND permission='owner') THEN
      RAISE EXCEPTION 'owner membership required' USING ERRCODE='42501';
    END IF;
    PERFORM set_config('app.tenant_id',coalesce(v_previous_tenant,''),true);
    RETURN v_receipt.result;
  END IF;
  IF (SELECT count(*) FROM app_private.es_command WHERE actor_id=v_actor
        AND command_type='owner.venue.create.v1') >= 20
    OR (SELECT count(*) FROM app_private.es_command WHERE actor_id=v_actor
        AND command_type='owner.venue.create.v1' AND created_at>now()-interval '24 hours') >= 5
    OR (SELECT count(*) FROM app_private.staff_membership WHERE actor_id=v_actor) >= 100 THEN
    RAISE EXCEPTION 'restaurant limit reached' USING ERRCODE='P0001';
  END IF;
  v_venue := gen_random_uuid();
  v_event := gen_random_uuid();
  PERFORM set_config('app.tenant_id',v_venue::text,true);
  INSERT INTO app_private.venues(id,name) VALUES(v_venue,v_name);
  INSERT INTO app_private.staff_membership(tenant_id,actor_id,permission) VALUES(v_venue,v_actor,'owner');
  v_result := jsonb_build_object('venueId',v_venue,'name',v_name,'permission','owner');
  INSERT INTO app_private.es_event(id,tenant_id,stream_type,stream_id,version,schema_version,event_type,payload,metadata)
    VALUES(v_event,v_venue,'venue',v_venue,1,1,'owner.venue.created',
      jsonb_build_object('name',v_name),jsonb_build_object('actorId',v_actor,'commandId',p_command_id));
  INSERT INTO app_private.es_command(id,tenant_id,actor_id,command_type,idempotency_key,payload,request_hash,result)
    VALUES(gen_random_uuid(),v_venue,v_actor,'owner.venue.create.v1',p_command_id::text,
      jsonb_build_object('commandType','owner.venue.create.v1','name',v_name),v_hash,v_result);
  INSERT INTO app_private.outbox(id,tenant_id,event_id,topic,payload)
    VALUES(gen_random_uuid(),v_venue,v_event,'owner.venue.created',v_result);
  PERFORM set_config('app.tenant_id',coalesce(v_previous_tenant,''),true);
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION app_private.create_owner_venue(uuid,text) FROM PUBLIC;
GRANT CREATE ON SCHEMA app_private TO peekaplate_venue_creator;
ALTER FUNCTION app_private.create_owner_venue(uuid,text) OWNER TO peekaplate_venue_creator;
REVOKE CREATE ON SCHEMA app_private FROM peekaplate_venue_creator;
GRANT EXECUTE ON FUNCTION app_private.create_owner_venue(uuid,text) TO peekaplate_runtime;

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'Forward-only restaurant audit migration; use a corrective migration.'; END $$;
