-- migrate:up
-- Forward migration: preserve POS dish mapping reviewer history without blocking staff membership removal (Finding C).
-- Removing the restrictive foreign key on staff_membership preserves reviewed_by UUID audit provenance
-- even after an owner or editor is removed from the venue.
-- Review-time authorization and actor binding continue to be enforced by enforce_pos_dish_mapping_review().

ALTER TABLE app_private.pos_dish_mappings
  DROP CONSTRAINT IF EXISTS pos_dish_mappings_tenant_id_reviewed_by_fkey;

-- migrate:down
DO $$
BEGIN
  RAISE EXCEPTION 'Rollback is intentionally unsupported; use a forward corrective migration.';
END;
$$;
