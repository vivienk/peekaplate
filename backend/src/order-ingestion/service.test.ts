import {
  MAX_ORDER_OUTCOME_ROWS,
  PILOT_ORDER_AGREEMENT_VERSION,
  PILOT_ORDER_OUTCOME_SCHEMA_VERSION,
  type PublicMenuContentBundle,
} from '@peekaplate/contracts';
import { describe, expect, it, vi } from 'vitest';
import { reconcileOrderDeletionsAfterRestore } from './restore-reconciliation';
import {
  acceptPilotOrderAgreement,
  cleanupOrphanedOrderImports,
  deleteVenueOrderData,
  type ImportOrderOutcomeOptions,
  importOrderOutcomes,
  type OrderDeletionVerificationStorage,
  OrderImportError,
  retryPendingOrphanCleanups,
  submitOrderDataDeletionRequest,
  verifyVenueOrderDeletion,
} from './service';
import { getVenueTrackingActivation, recordVenueTrackingActivation } from './tracking-activation';

type MockDbState = {
  venueId: string;
  actorId: string;
  permission: string;
  venueCreatedAt?: Date;
  menuApproval?: {
    menuRevisionId: string;
    approvedAt?: Date;
    bundleUrl: string;
    contentHash: string;
  };
  publicationEvents?: Array<{
    menuId: string;
    menuRevisionId: string;
    eventType: 'menu.published' | 'menu.withdrawn';
    occurredAt: Date;
    version?: number;
  }>;
  bundleContent?: PublicMenuContentBundle;
  posDishMappings: Map<string, any>;
  venueTrackingActivations?: Map<string, any>;
  batches: Map<string, any>;
  lines: Map<string, any>;
  quarantine: any[];
  conflicts: any[];
  agreementAcceptances?: Map<
    string,
    {
      id: string;
      tenant_id: string;
      agreement_version: string;
      accepted_by: string;
      accepted_at: Date;
    }
  >;
  deletionRequests?: Map<string, any>;
  deletionGates?: Map<string, number>;
  restoreFreezeActive?: boolean;
  simulateSystemGatesUnreadable?: boolean;
  simulateDbDeletionFailure?: boolean;
};

function createMockClient(state: MockDbState) {
  let inTx = false;
  let currentTenantId: string | null = null;
  let currentActorId: string | null = null;

  return {
    query: vi.fn(async (sql: string, params?: any[]) => {
      const normalizedSql = sql.replace(/\s+/g, ' ').trim();

      if (normalizedSql.startsWith('BEGIN')) {
        inTx = true;
        return { rows: [], rowCount: 0 };
      }
      if (normalizedSql.startsWith('COMMIT') || normalizedSql.startsWith('ROLLBACK')) {
        inTx = false;
        currentTenantId = null;
        return { rows: [], rowCount: 0 };
      }
      if (normalizedSql.includes("set_config('app.actor_id'")) {
        currentActorId = params?.[0] ?? null;
        return { rows: [], rowCount: 0 };
      }
      if (normalizedSql.includes("set_config('app.tenant_id'")) {
        currentTenantId = params?.[0] ?? null;
        return { rows: [], rowCount: 0 };
      }
      if (normalizedSql.includes('SET LOCAL') || normalizedSql.includes('pg_advisory_xact_lock')) {
        return { rows: [], rowCount: 0 };
      }

      // 1. Staff membership check
      if (normalizedSql.includes('FROM app_private.staff_membership')) {
        const [tenantId, actorId] = params!;
        if (tenantId === state.venueId && actorId === state.actorId) {
          return { rows: [{ permission: state.permission }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      // 1a. Pilot order agreement acceptance check & insert
      if (normalizedSql.includes('FROM app_private.pilot_order_agreement_acceptances')) {
        const [tenantId, version] = params!;
        if (state.agreementAcceptances === undefined) {
          if (tenantId === state.venueId && version === PILOT_ORDER_AGREEMENT_VERSION) {
            return {
              rows: [
                {
                  id: '00000000-0000-4000-8000-000000000099',
                  agreement_version: version,
                  accepted_by: state.actorId,
                  accepted_at: new Date('2026-11-12T00:00:00Z'),
                },
              ],
              rowCount: 1,
            };
          }
          return { rows: [], rowCount: 0 };
        }
        const rec = state.agreementAcceptances.get(`${tenantId}:${version}`);
        return { rows: rec ? [rec] : [], rowCount: rec ? 1 : 0 };
      }

      if (normalizedSql.includes('INSERT INTO app_private.pilot_order_agreement_acceptances')) {
        const [id, tenantId, version, acceptedBy] = params!;
        if (!state.agreementAcceptances) state.agreementAcceptances = new Map();
        const key = `${tenantId}:${version}`;
        if (state.agreementAcceptances.has(key)) {
          return { rows: [], rowCount: 0 };
        }
        const rec = {
          id,
          tenant_id: tenantId,
          agreement_version: version,
          accepted_by: acceptedBy,
          accepted_at: new Date('2026-11-13T00:00:00Z'),
        };
        state.agreementAcceptances.set(key, rec);
        return { rows: [rec], rowCount: 1 };
      }

      // 1a-2. System gates, deletion epoch gates, and deletion request audit ledger
      if (normalizedSql.includes('FROM app_private.system_gates')) {
        if (state.simulateSystemGatesUnreadable) {
          return { rows: [], rowCount: 0 };
        }
        return {
          rows: [{ is_active: state.restoreFreezeActive === true }],
          rowCount: 1,
        };
      }

      if (normalizedSql.includes('FROM app_private.order_data_deletion_gates')) {
        const [tenantId] = params!;
        const epoch = state.deletionGates?.get(tenantId) ?? 0;
        return { rows: [{ deletion_epoch: epoch }], rowCount: 1 };
      }

      if (normalizedSql.includes('FROM app_private.order_data_deletion_requests')) {
        if (normalizedSql.includes("status <> 'verified'")) {
          const [tenantId] = params!;
          const active = [...(state.deletionRequests?.values() ?? [])].find(
            (r) => r.tenant_id === tenantId && r.status !== 'verified',
          );
          return { rows: active ? [active] : [], rowCount: active ? 1 : 0 };
        }
        const rec = normalizedSql.includes('WHERE tenant_id = $1 AND id = $2')
          ? state.deletionRequests?.get(`${params![0]}:${params![1]}`)
          : state.deletionRequests?.get(`${params![1]}:${params![0]}`);
        return { rows: rec ? [rec] : [], rowCount: rec ? 1 : 0 };
      }

      if (normalizedSql.includes('INSERT INTO app_private.order_data_deletion_requests')) {
        const [id, tenantId, requestedBy, reason] = params!;
        if (!state.deletionRequests) state.deletionRequests = new Map();
        const key = `${tenantId}:${id}`;
        if (state.deletionRequests.has(key)) {
          return { rows: [], rowCount: 0 };
        }
        if (!state.deletionGates) state.deletionGates = new Map();
        state.deletionGates.set(tenantId, (state.deletionGates.get(tenantId) ?? 0) + 1);
        const rec = {
          id,
          tenant_id: tenantId,
          requested_by: requestedBy,
          executed_by: null as string | null,
          execution_token: null as string | null,
          execution_started_at: null as Date | null,
          execution_lease_expires_at: null as Date | null,
          reason,
          status: 'requested',
          r2_objects_deleted: 0,
          db_batches_deleted: 0,
          db_lines_deleted: 0,
          db_quarantine_deleted: 0,
          db_conflicts_deleted: 0,
          error_code: null as string | null,
          requested_at: new Date('2026-11-13T00:00:00Z'),
          completed_at: null as Date | null,
          receipt_written_at: null as Date | null,
          verified_by: null as string | null,
          verified_at: null as Date | null,
          verification_outcome: null as string | null,
          verification_evidence_ref: null as string | null,
        };
        state.deletionRequests.set(key, rec);
        return {
          rows: [{ id, status: rec.status, reason: rec.reason, requested_at: rec.requested_at }],
          rowCount: 1,
        };
      }

      if (normalizedSql.includes('UPDATE app_private.order_data_deletion_requests')) {
        const [requestId, tenantId] = params!;
        const rec = state.deletionRequests?.get(`${tenantId}:${requestId}`);
        if (rec && rec.status !== 'verified') {
          if (normalizedSql.includes('SET execution_lease_expires_at = $4')) {
            if (rec.status === 'executing' && rec.execution_token === params![2]) {
              rec.execution_lease_expires_at = params![3];
              return { rows: [{ id: rec.id }], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
          }
          if (normalizedSql.includes('SET execution_token = $3')) {
            if (rec.status === 'db_deleted') {
              rec.execution_token = params![2];
              rec.execution_lease_expires_at = params![3];
              rec.error_code = null;
              return { rows: [], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
          }
          if (normalizedSql.includes('SET status = CASE WHEN $5')) {
            if (
              rec.execution_token === params![3] &&
              rec.status !== 'awaiting_verification' &&
              rec.status !== 'verified'
            ) {
              rec.status = params![4] && rec.status === 'db_deleted' ? 'db_deleted' : 'failed';
              rec.error_code = params![2];
              rec.execution_token = null;
              rec.execution_lease_expires_at = null;
            }
          } else if (normalizedSql.includes("SET status = 'executing'")) {
            rec.status = 'executing';
            rec.executed_by = params![2];
            rec.execution_token = params![3];
            rec.execution_started_at = params![4];
            rec.execution_lease_expires_at = params![5];
            rec.error_code = null;
          } else if (normalizedSql.includes("SET status = 'r2_deleted'")) {
            rec.status = 'r2_deleted';
            rec.r2_objects_deleted = params![2];
            rec.error_code = null;
          } else if (normalizedSql.includes("SET status = 'db_deleted'")) {
            if (rec.execution_token !== params![8]) {
              return { rows: [], rowCount: 0 };
            }
            rec.status = 'db_deleted';
            rec.r2_objects_deleted = params![2];
            rec.db_batches_deleted = params![3];
            rec.db_lines_deleted = params![4];
            rec.db_quarantine_deleted = params![5];
            rec.db_conflicts_deleted = params![6];
            rec.executed_by = params![7] ?? rec.executed_by;
            rec.error_code = null;
            rec.completed_at = new Date();
            return { rows: [{ completed_at: rec.completed_at }], rowCount: 1 };
          } else if (normalizedSql.includes("SET status = 'awaiting_verification'")) {
            if (rec.status !== 'db_deleted' || rec.execution_token !== params![2]) {
              return { rows: [], rowCount: 0 };
            }
            rec.status = 'awaiting_verification';
            rec.receipt_written_at = new Date('2026-11-13T00:01:05Z');
            rec.execution_token = null;
            rec.execution_lease_expires_at = null;
            rec.error_code = null;
            return { rows: [{ receipt_written_at: rec.receipt_written_at }], rowCount: 1 };
          }
        }
        return { rows: [], rowCount: rec ? 1 : 0 };
      }

      if (normalizedSql.includes('FROM app_private.record_deletion_verification')) {
        const [tenantId, requestId, checkerId, outcome, evidenceRef] = params!;
        const rec = state.deletionRequests?.get(`${tenantId}:${requestId}`);
        if (!rec) {
          throw new Error(`Deletion request ${requestId} not found for tenant ${tenantId}`);
        }
        if (rec.status !== 'awaiting_verification') {
          throw new Error(
            `Deletion request ${requestId} is in status ${rec.status}, expected awaiting_verification`,
          );
        }
        if (checkerId === rec.requested_by || checkerId === rec.executed_by) {
          throw new Error('Independent checker cannot be the requester or executing operator');
        }
        rec.verified_by = checkerId;
        rec.verified_at = new Date('2026-11-13T00:02:00Z');
        rec.verification_outcome = outcome;
        rec.verification_evidence_ref = evidenceRef;
        if (outcome === 'PASS') {
          rec.status = 'verified';
          rec.execution_token = null;
          rec.execution_lease_expires_at = null;
        }
        return {
          rows: [
            {
              request_id: requestId,
              venue_id: tenantId,
              status: rec.status,
              verified_by: rec.verified_by,
              verified_at: rec.verified_at,
              verification_outcome: rec.verification_outcome,
            },
          ],
          rowCount: 1,
        };
      }

      if (normalizedSql.includes('AS total_remaining')) {
        const [tenantId] = params!;
        const batchCount = [...state.batches.values()].filter(
          (b) => b.tenant_id === tenantId,
        ).length;
        const lineCount = [...state.lines.values()].filter((l) => l.tenant_id === tenantId).length;
        const qCount = state.quarantine.filter((q) => q.tenant_id === tenantId).length;
        const cCount = state.conflicts.filter((c) => c.tenant_id === tenantId).length;
        return {
          rows: [{ total_remaining: batchCount + lineCount + qCount + cCount }],
          rowCount: 1,
        };
      }

      if (
        normalizedSql.includes('SELECT storage_key FROM app_private.order_outcome_import_batches')
      ) {
        const [tenantId] = params!;
        const rows = [...state.batches.values()]
          .filter((b) => b.tenant_id === tenantId && b.storage_key)
          .map((b) => ({ storage_key: b.storage_key }));
        return { rows, rowCount: rows.length };
      }

      if (normalizedSql.includes('FROM app_private.delete_venue_order_data')) {
        if (state.simulateDbDeletionFailure) {
          throw new Error('Simulated DB deletion failure');
        }
        const [tenantId] = params!;
        let batchesDeleted = 0;
        let linesDeleted = 0;
        let quarantineDeleted = 0;
        let conflictsDeleted = 0;

        for (const [k, v] of state.lines.entries()) {
          if (v.tenant_id === tenantId || k.startsWith(`${tenantId}:`)) {
            state.lines.delete(k);
            linesDeleted++;
          }
        }
        for (let idx = state.quarantine.length - 1; idx >= 0; idx--) {
          if (state.quarantine[idx].tenant_id === tenantId) {
            state.quarantine.splice(idx, 1);
            quarantineDeleted++;
          }
        }
        for (let idx = state.conflicts.length - 1; idx >= 0; idx--) {
          if (state.conflicts[idx].tenant_id === tenantId) {
            state.conflicts.splice(idx, 1);
            conflictsDeleted++;
          }
        }
        for (const [k, v] of state.batches.entries()) {
          if (v.tenant_id === tenantId) {
            state.batches.delete(k);
            batchesDeleted++;
          }
        }
        return {
          rows: [
            {
              batches_deleted: batchesDeleted,
              lines_deleted: linesDeleted,
              quarantine_deleted: quarantineDeleted,
              conflicts_deleted: conflictsDeleted,
            },
          ],
          rowCount: 1,
        };
      }

      // 1b. POS dish mapping query
      if (normalizedSql.includes('FROM app_private.pos_dish_mappings')) {
        const [tenantId, posItemCode] = params!;
        const key = `${tenantId}:${posItemCode}`;
        const mapping = state.posDishMappings.get(key);
        return { rows: mapping ? [mapping] : [], rowCount: mapping ? 1 : 0 };
      }

      // 1c. Venue created_at check for tracking start
      if (normalizedSql.includes('FROM app_private.venues WHERE id = $1')) {
        const [venueId] = params!;
        if (venueId === state.venueId) {
          return {
            rows: [{ created_at: state.venueCreatedAt ?? new Date('2026-01-01T00:00:00Z') }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }

      // 1d. Venue tracking activation queries
      if (normalizedSql.includes('FROM app_private.venue_tracking_activations')) {
        const [tenantId] = params!;
        if (!state.venueTrackingActivations) {
          state.venueTrackingActivations = new Map();
        }
        const record = state.venueTrackingActivations.get(tenantId);
        return { rows: record ? [record] : [], rowCount: record ? 1 : 0 };
      }
      if (normalizedSql.includes('INSERT INTO app_private.venue_tracking_activations')) {
        if (!state.venueTrackingActivations) {
          state.venueTrackingActivations = new Map();
        }
        // If caller passed an explicit timestamp parameter (attempted client override/backdate)
        if (params && params.some((p) => p instanceof Date)) {
          throw new Error(
            'Client-supplied activation timestamp is prohibited; server controls activation timestamp',
          );
        }
        const [tenant_id, activated_by, source] = params!;
        if (!state.venueTrackingActivations.has(tenant_id)) {
          state.venueTrackingActivations.set(tenant_id, {
            tenant_id,
            activated_at: new Date(),
            activated_by,
            source: source ?? 'menu_publication',
          });
        }
        return { rows: [], rowCount: 1 };
      }

      // 2. Existing file check on import_batches
      if (
        normalizedSql.includes('FROM app_private.order_outcome_import_batches') &&
        normalizedSql.includes('file_sha256 = $2')
      ) {
        const [tenantId, fileSha256] = params!;
        const existing = [...state.batches.values()].find(
          (b) => b.tenant_id === tenantId && b.file_sha256 === fileSha256,
        );
        return { rows: existing ? [existing] : [], rowCount: existing ? 1 : 0 };
      }

      // 2b. Batch lookup by ID on import_batches with forced RLS simulation
      if (
        normalizedSql.includes('FROM app_private.order_outcome_import_batches') &&
        normalizedSql.includes('id = $2')
      ) {
        const [tenantId, id] = params!;
        if (!inTx || currentTenantId !== tenantId) {
          return { rows: [], rowCount: 0 };
        }
        const existing = state.batches.get(id);
        if (existing && existing.tenant_id === tenantId) {
          return { rows: [existing], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      // 3. Insert into order_outcome_import_batches
      if (normalizedSql.includes('INSERT INTO app_private.order_outcome_import_batches')) {
        const [id, tenant_id, source_filename, file_sha256, storage_key, total_rows, created_by] =
          params!;
        const batch = {
          id,
          tenant_id,
          schema_version: 'pilot_order_outcome.v1',
          source_filename,
          file_sha256,
          storage_key,
          status: 'processing',
          total_rows,
          accepted_rows: 0,
          duplicate_rows: 0,
          quarantined_rows: 0,
          conflict_rows: 0,
          created_by,
          created_at: new Date(),
          finished_at: null,
        };
        state.batches.set(id, batch);
        return { rows: [batch], rowCount: 1 };
      }

      // 4. Update order_outcome_import_batches
      if (normalizedSql.includes('UPDATE app_private.order_outcome_import_batches')) {
        const [
          tenant_id,
          id,
          total_rows,
          accepted_rows,
          duplicate_rows,
          quarantined_rows,
          conflict_rows,
        ] = params!;
        const batch = state.batches.get(id);
        if (batch) {
          batch.total_rows = total_rows;
          batch.accepted_rows = accepted_rows;
          batch.duplicate_rows = duplicate_rows;
          batch.quarantined_rows = quarantined_rows;
          batch.conflict_rows = conflict_rows;
          batch.status = 'completed';
          batch.finished_at = new Date();
        }
        return { rows: [], rowCount: 1 };
      }

      // 5. Menu publication event history query (Finding D)
      if (
        normalizedSql.includes('FROM app_private.es_event e') &&
        normalizedSql.includes('menu_publication')
      ) {
        const [tenantId, orderedAtIso] = params!;
        if (tenantId !== state.venueId) return { rows: [], rowCount: 0 };
        const orderedAt = new Date(orderedAtIso);
        const events =
          state.publicationEvents ??
          (state.menuApproval
            ? [
                {
                  menuId: '00000000-0000-0000-0000-000000000001',
                  menuRevisionId: state.menuApproval.menuRevisionId,
                  eventType: 'menu.published' as const,
                  occurredAt: state.menuApproval.approvedAt ?? new Date('2026-01-01T00:00:00Z'),
                  version: 1,
                },
              ]
            : []);

        const eligible = events.filter((e) => e.occurredAt <= orderedAt);
        const latestByMenu = new Map<string, (typeof eligible)[0]>();
        for (const ev of eligible) {
          const current = latestByMenu.get(ev.menuId);
          if (
            !current ||
            (ev.version ?? 1) > (current.version ?? 1) ||
            ((ev.version ?? 1) === (current.version ?? 1) && ev.occurredAt > current.occurredAt)
          ) {
            latestByMenu.set(ev.menuId, ev);
          }
        }
        const rows = [...latestByMenu.values()].map((e) => ({
          menu_id: e.menuId,
          event_type: e.eventType,
          menu_revision_id: e.menuRevisionId,
        }));
        return { rows, rowCount: rows.length };
      }

      // Legacy fallback for tests querying menu_approval directly
      if (
        normalizedSql.includes('FROM app_private.menu_approval approval') &&
        normalizedSql.includes('ORDER BY approval.approved_at DESC')
      ) {
        const [tenantId, orderedAtIso] = params!;
        if (tenantId === state.venueId && state.menuApproval) {
          const approvedAt = state.menuApproval.approvedAt ?? new Date('2026-01-01T00:00:00Z');
          const orderedAt = new Date(orderedAtIso);
          if (approvedAt <= orderedAt) {
            return {
              rows: [{ menu_revision_id: state.menuApproval.menuRevisionId }],
              rowCount: 1,
            };
          }
        }
        return { rows: [], rowCount: 0 };
      }

      if (
        normalizedSql.includes('FROM app_private.menu_approval approval') &&
        normalizedSql.includes('app_private.public_menu_bundle bundle')
      ) {
        const [tenantId, menuRevId] = params!;
        if (
          menuRevId &&
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(menuRevId)
        ) {
          throw new Error(`invalid input syntax for type uuid: "${menuRevId}"`);
        }
        if (
          tenantId === state.venueId &&
          state.menuApproval &&
          state.menuApproval.menuRevisionId === menuRevId
        ) {
          return {
            rows: [
              {
                bundle_url: state.menuApproval.bundleUrl,
                content_hash: state.menuApproval.contentHash,
              },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }

      // 6. Check existing order outcome line
      if (normalizedSql.includes('FROM app_private.order_outcome_lines')) {
        const [tenantId, orderId, orderLineId, outcomeType] = params!;
        const existing = [...state.lines.values()].find(
          (l) =>
            l.tenant_id === tenantId &&
            l.order_id === orderId &&
            l.order_line_id === orderLineId &&
            l.outcome_type === outcomeType,
        );
        return { rows: existing ? [existing] : [], rowCount: existing ? 1 : 0 };
      }

      // 7. Insert order outcome line
      if (normalizedSql.includes('INSERT INTO app_private.order_outcome_lines')) {
        const [
          tenant_id,
          order_id,
          order_line_id,
          batch_id,
          ordered_at,
          menu_revision_id,
          dish_id,
          dish_revision_id,
          outcome_type,
          quantity,
          unit_price,
          currency,
          payload_checksum,
        ] = params!;
        const key = `${tenant_id}:${order_id}:${order_line_id}:${outcome_type}`;
        const line = {
          tenant_id,
          order_id,
          order_line_id,
          batch_id,
          ordered_at,
          menu_revision_id,
          dish_id,
          dish_revision_id,
          outcome_type,
          quantity,
          unit_price,
          currency,
          payload_checksum,
        };
        state.lines.set(key, line);
        return { rows: [line], rowCount: 1 };
      }

      // 8. Insert quarantine
      if (normalizedSql.includes('INSERT INTO app_private.order_outcome_quarantine')) {
        const [id, tenant_id, batch_id, row_index, reason_code, field_name, diagnostic_message] =
          params!;
        if (diagnostic_message && diagnostic_message.length > 500) {
          throw new Error('check constraint violation: length(diagnostic_message) <= 500');
        }
        if (field_name && field_name.length > 64) {
          throw new Error('check constraint violation: length(field_name) <= 64');
        }
        state.quarantine.push({
          id,
          tenant_id,
          batch_id,
          row_index,
          reason_code,
          field_name,
          diagnostic_message,
        });
        return { rows: [], rowCount: 1 };
      }

      // 9. Insert conflict
      if (normalizedSql.includes('INSERT INTO app_private.order_outcome_conflicts')) {
        const [
          tenant_id,
          order_id,
          order_line_id,
          outcome_type,
          batch_id,
          existing_checksum,
          incoming_checksum,
        ] = params!;
        state.conflicts.push({
          tenant_id,
          order_id,
          order_line_id,
          outcome_type,
          batch_id,
          existing_checksum,
          incoming_checksum,
        });
        return { rows: [], rowCount: 1 };
      }

      return { rows: [], rowCount: 0 };
    }),
  };
}

describe('importOrderOutcomes service', () => {
  const venueId = '00000000-0000-4000-8000-000000000001';
  const actorId = '00000000-0000-4000-8000-000000000099';
  const menuRevisionId = '11111111-1111-4000-8000-000000000001';
  const dishId = '22222222-2222-4000-8000-000000000001';
  const dishRevisionId = '33333333-3333-4000-8000-000000000001';

  const validBundle: PublicMenuContentBundle = {
    schema_version: 1,
    venue_id: venueId,
    menu_id: '44444444-4444-4000-8000-000000000001',
    menu_revision_id: menuRevisionId,
    restaurant: { name: 'Test Restaurant', logo: null },
    categories: [
      {
        category_id: '55555555-5555-4000-8000-000000000001',
        name: 'Mains',
        dishes: [
          {
            dish_id: dishId,
            dish_revision_id: dishRevisionId,
            complete: true,
            name: 'Margherita Pizza',
            description: 'Classic pizza',
            price: { amount: '15.00', currency: 'USD' },
            ingredients: [],
            allergens: null,
            dietary: ['vegetarian'],
            images: {
              card: {
                url: 'https://cdn.example.com/card.jpg',
                width: 400,
                height: 300,
                alt: 'Pizza',
              },
              detail: {
                url: 'https://cdn.example.com/detail.jpg',
                width: 800,
                height: 600,
                alt: 'Pizza detail',
              },
            },
          },
        ],
      },
    ],
  };

  const defaultTrackingStartedAt = '2026-01-01T00:00:00Z';

  const defaultState = (): MockDbState => ({
    venueId,
    actorId,
    permission: 'owner',
    menuApproval: {
      menuRevisionId,
      bundleUrl: 'https://assets.peekaplate.com/bundles/test.json',
      contentHash: 'mock-hash',
    },
    bundleContent: validBundle,
    posDishMappings: new Map([
      [
        `${venueId}:POS-PIZZA-1`,
        {
          tenant_id: venueId,
          pos_item_code: 'POS-PIZZA-1',
          dish_id: dishId,
          dish_name: 'Margherita Pizza',
          review_status: 'approved',
          reviewed_by: actorId,
          reviewed_at: new Date('2026-10-01T00:00:00Z'),
        },
      ],
    ]),
    venueTrackingActivations: new Map([
      [
        venueId,
        {
          tenant_id: venueId,
          activated_at: new Date(defaultTrackingStartedAt),
          activated_by: actorId,
          source: 'menu_publication',
        },
      ],
    ]),
    batches: new Map(),
    lines: new Map(),
    quarantine: [],
    conflicts: [],
  });

  const bundleLoader = async () => validBundle;

  it('successfully processes valid CSV rows and persists accepted outcomes', async () => {
    const state = defaultState();
    const client = createMockClient(state);
    const mockStorage = { put: vi.fn(async () => {}) };

    const csvText = [
      'schema_version,order_id,order_line_id,ordered_at,menu_revision_id,dish_id,dish_revision_id,outcome_type,quantity,unit_price,currency',
      `pilot_order_outcome.v1,TICK-1,LINE-1,2026-11-01T12:00:00Z,${menuRevisionId},${dishId},${dishRevisionId},ordered,1,15.00,USD`,
      `pilot_order_outcome.v1,TICK-2,LINE-1,2026-11-01T12:05:00Z,${menuRevisionId},${dishId},${dishRevisionId},refunded,1,,`,
    ].join('\n');

    const result = await importOrderOutcomes({
      client: client as any,
      actorId,
      venueId,
      csvText,
      sourceFilename: 'pilot_orders.csv',
      bundleLoader,
      trackingStartedAt: defaultTrackingStartedAt,
      storage: mockStorage,
      now: () => new Date('2026-11-07T12:00:00Z'),
    });

    expect(result.status).toBe('completed');
    expect(result.totalRows).toBe(2);
    expect(result.acceptedRows).toBe(2);
    expect(result.duplicateRows).toBe(0);
    expect(result.quarantinedRows).toBe(0);
    expect(result.conflictRows).toBe(0);
    expect(result.isDuplicateFile).toBe(false);

    // Verified stored in mock DB
    expect(state.lines.size).toBe(2);
    expect(mockStorage.put).toHaveBeenCalledWith(
      expect.stringContaining(`order-imports/${venueId}/${result.batchId}/source.csv`),
      csvText,
      expect.objectContaining({
        customMetadata: expect.objectContaining({
          'tenant-id': venueId,
          'batch-id': result.batchId,
        }),
      }),
    );
  });

  it('rejects import with 403 when user is not owner', async () => {
    const state = defaultState();
    state.permission = 'editor';
    const client = createMockClient(state);

    const csvText = [
      'schema_version,order_id,order_line_id,ordered_at,menu_revision_id,dish_id,dish_revision_id,outcome_type,quantity',
      `pilot_order_outcome.v1,TICK-1,LINE-1,2026-11-01T12:00:00Z,${menuRevisionId},${dishId},${dishRevisionId},ordered,1`,
    ].join('\n');

    await expect(
      importOrderOutcomes({
        client: client as any,
        actorId,
        venueId,
        csvText,
        bundleLoader,
      }),
    ).rejects.toThrowError(/requires owner permission/);
  });

  it('detects duplicate file on re-import and returns existing batch summary with zero double-counting', async () => {
    const state = defaultState();
    const client = createMockClient(state);

    const csvText = [
      'schema_version,order_id,order_line_id,ordered_at,menu_revision_id,dish_id,dish_revision_id,outcome_type,quantity',
      `pilot_order_outcome.v1,TICK-1,LINE-1,2026-11-01T12:00:00Z,${menuRevisionId},${dishId},${dishRevisionId},ordered,1`,
    ].join('\n');

    // First import
    const firstResult = await importOrderOutcomes({
      client: client as any,
      actorId,
      venueId,
      csvText,
      bundleLoader,
      trackingStartedAt: defaultTrackingStartedAt,
      now: () => new Date('2026-11-07T12:00:00Z'),
    });
    expect(firstResult.acceptedRows).toBe(1);
    expect(firstResult.isDuplicateFile).toBe(false);

    // Second import of the exact same CSV text
    const secondResult = await importOrderOutcomes({
      client: client as any,
      actorId,
      venueId,
      csvText,
      bundleLoader,
      trackingStartedAt: defaultTrackingStartedAt,
      now: () => new Date('2026-11-07T12:00:00Z'),
    });

    expect(secondResult.batchId).toBe(firstResult.batchId);
    expect(secondResult.isDuplicateFile).toBe(true);
    expect(secondResult.acceptedRows).toBe(1);
    expect(state.lines.size).toBe(1); // No double counting
  });

  it('detects duplicate lines across subsequent files with same payload checksum', async () => {
    const state = defaultState();
    const client = createMockClient(state);

    const file1 = [
      'schema_version,order_id,order_line_id,ordered_at,menu_revision_id,dish_id,dish_revision_id,outcome_type,quantity',
      `pilot_order_outcome.v1,TICK-1,LINE-1,2026-11-01T12:00:00Z,${menuRevisionId},${dishId},${dishRevisionId},ordered,1`,
    ].join('\n');

    await importOrderOutcomes({
      client: client as any,
      actorId,
      venueId,
      csvText: file1,
      bundleLoader,
      trackingStartedAt: defaultTrackingStartedAt,
      now: () => new Date('2026-11-07T12:00:00Z'),
    });

    // File 2 has TICK-1/LINE-1 again plus a new line TICK-2/LINE-1
    const file2 = [
      'schema_version,order_id,order_line_id,ordered_at,menu_revision_id,dish_id,dish_revision_id,outcome_type,quantity',
      `pilot_order_outcome.v1,TICK-1,LINE-1,2026-11-01T12:00:00Z,${menuRevisionId},${dishId},${dishRevisionId},ordered,1`,
      `pilot_order_outcome.v1,TICK-2,LINE-1,2026-11-01T12:10:00Z,${menuRevisionId},${dishId},${dishRevisionId},ordered,1`,
    ].join('\n');

    const result2 = await importOrderOutcomes({
      client: client as any,
      actorId,
      venueId,
      csvText: file2,
      bundleLoader,
      trackingStartedAt: defaultTrackingStartedAt,
      now: () => new Date('2026-11-07T12:00:00Z'),
    });

    expect(result2.totalRows).toBe(2);
    expect(result2.acceptedRows).toBe(1); // Only TICK-2 accepted
    expect(result2.duplicateRows).toBe(1); // TICK-1 skipped
    expect(state.lines.size).toBe(2);
  });

  it('records conflict when an existing line identity is re-submitted with differing checksum', async () => {
    const state = defaultState();
    const client = createMockClient(state);

    const file1 = [
      'schema_version,order_id,order_line_id,ordered_at,menu_revision_id,dish_id,dish_revision_id,outcome_type,quantity,unit_price,currency',
      `pilot_order_outcome.v1,TICK-1,LINE-1,2026-11-01T12:00:00Z,${menuRevisionId},${dishId},${dishRevisionId},ordered,1,10.00,USD`,
    ].join('\n');

    await importOrderOutcomes({
      client: client as any,
      actorId,
      venueId,
      csvText: file1,
      bundleLoader,
      trackingStartedAt: defaultTrackingStartedAt,
      now: () => new Date('2026-11-07T12:00:00Z'),
    });

    // File 2 has TICK-1/LINE-1 with changed price
    const file2 = [
      'schema_version,order_id,order_line_id,ordered_at,menu_revision_id,dish_id,dish_revision_id,outcome_type,quantity,unit_price,currency',
      `pilot_order_outcome.v1,TICK-1,LINE-1,2026-11-01T12:00:00Z,${menuRevisionId},${dishId},${dishRevisionId},ordered,1,25.00,USD`,
    ].join('\n');

    const result2 = await importOrderOutcomes({
      client: client as any,
      actorId,
      venueId,
      csvText: file2,
      bundleLoader,
      trackingStartedAt: defaultTrackingStartedAt,
      now: () => new Date('2026-11-07T12:00:00Z'),
    });

    expect(result2.acceptedRows).toBe(0);
    expect(result2.conflictRows).toBe(1);
    expect(state.conflicts.length).toBe(1);
    expect(state.conflicts[0]?.order_id).toBe('TICK-1');

    // Original canonical line must NOT be mutated
    const originalLine = state.lines.get(`${venueId}:TICK-1:LINE-1:ordered`);
    expect(originalLine.unit_price).toBe(10.0);
  });

  it('quarantines row when dish is not present in the published menu revision', async () => {
    const state = defaultState();
    const client = createMockClient(state);
    const unknownDishId = '99999999-9999-4000-8000-000000000099';

    const csvText = [
      'schema_version,order_id,order_line_id,ordered_at,menu_revision_id,dish_id,dish_revision_id,outcome_type,quantity',
      `pilot_order_outcome.v1,TICK-1,LINE-1,2026-11-01T12:00:00Z,${menuRevisionId},${unknownDishId},${dishRevisionId},ordered,1`,
    ].join('\n');

    const result = await importOrderOutcomes({
      client: client as any,
      actorId,
      venueId,
      csvText,
      bundleLoader,
      trackingStartedAt: defaultTrackingStartedAt,
      now: () => new Date('2026-11-07T12:00:00Z'),
    });

    expect(result.quarantinedRows).toBe(1);
    expect(result.acceptedRows).toBe(0);
    expect(result.diagnostics[0]?.reasonCode).toBe('unmatched_dish');
    expect(state.quarantine.length).toBe(1);
  });

  it('quarantines row when dish revision does not match published bundle', async () => {
    const state = defaultState();
    const client = createMockClient(state);
    const mismatchedDishRevId = '88888888-8888-4000-8000-000000000088';

    const csvText = [
      'schema_version,order_id,order_line_id,ordered_at,menu_revision_id,dish_id,dish_revision_id,outcome_type,quantity',
      `pilot_order_outcome.v1,TICK-1,LINE-1,2026-11-01T12:00:00Z,${menuRevisionId},${dishId},${mismatchedDishRevId},ordered,1`,
    ].join('\n');

    const result = await importOrderOutcomes({
      client: client as any,
      actorId,
      venueId,
      csvText,
      bundleLoader,
      trackingStartedAt: defaultTrackingStartedAt,
      now: () => new Date('2026-11-07T12:00:00Z'),
    });

    expect(result.quarantinedRows).toBe(1);
    expect(result.acceptedRows).toBe(0);
    expect(result.diagnostics[0]?.reasonCode).toBe('unsupported_dish_revision');
  });

  it('quarantines row when menu revision does not belong to authorized venue', async () => {
    const state = defaultState();
    const client = createMockClient(state);
    const crossVenueMenuRevId = '77777777-7777-4000-8000-000000000077';

    const csvText = [
      'schema_version,order_id,order_line_id,ordered_at,menu_revision_id,dish_id,dish_revision_id,outcome_type,quantity',
      `pilot_order_outcome.v1,TICK-1,LINE-1,2026-11-01T12:00:00Z,${crossVenueMenuRevId},${dishId},${dishRevisionId},ordered,1`,
    ].join('\n');

    const result = await importOrderOutcomes({
      client: client as any,
      actorId,
      venueId,
      csvText,
      bundleLoader,
      trackingStartedAt: defaultTrackingStartedAt,
      now: () => new Date('2026-11-07T12:00:00Z'),
    });

    expect(result.quarantinedRows).toBe(1);
    expect(result.diagnostics[0]?.reasonCode).toBe('unsupported_menu_revision');
  });

  it('quarantines timestamps older than 90 days', async () => {
    const state = defaultState();
    const client = createMockClient(state);

    const csvText = [
      'schema_version,order_id,order_line_id,ordered_at,menu_revision_id,dish_id,dish_revision_id,outcome_type,quantity',
      `pilot_order_outcome.v1,TICK-1,LINE-1,2026-07-01T12:00:00Z,${menuRevisionId},${dishId},${dishRevisionId},ordered,1`,
    ].join('\n');

    const result = await importOrderOutcomes({
      client: client as any,
      actorId,
      venueId,
      csvText,
      bundleLoader,
      trackingStartedAt: defaultTrackingStartedAt,
      now: () => new Date('2026-11-07T12:00:00Z'),
    });

    expect(result.quarantinedRows).toBe(1);
    expect(result.diagnostics[0]?.reasonCode).toBe('too_old');
  });

  it('quarantines timestamps more than 5 minutes in the future', async () => {
    const state = defaultState();
    const client = createMockClient(state);

    const csvText = [
      'schema_version,order_id,order_line_id,ordered_at,menu_revision_id,dish_id,dish_revision_id,outcome_type,quantity',
      `pilot_order_outcome.v1,TICK-1,LINE-1,2026-11-07T12:15:00Z,${menuRevisionId},${dishId},${dishRevisionId},ordered,1`,
    ].join('\n');

    const result = await importOrderOutcomes({
      client: client as any,
      actorId,
      venueId,
      csvText,
      bundleLoader,
      trackingStartedAt: defaultTrackingStartedAt,
      now: () => new Date('2026-11-07T12:00:00Z'),
    });

    expect(result.quarantinedRows).toBe(1);
    expect(result.diagnostics[0]?.reasonCode).toBe('future_timestamp');
  });

  it('rejects files exceeding 1,000 rows with payload_too_large (413)', async () => {
    const state = defaultState();
    const client = createMockClient(state);

    const header =
      'schema_version,order_id,order_line_id,ordered_at,menu_revision_id,dish_id,dish_revision_id,outcome_type,quantity';
    const rows = Array.from(
      { length: 1005 },
      (_, i) =>
        `pilot_order_outcome.v1,O-${i},L-1,2026-11-01T12:00:00Z,${menuRevisionId},${dishId},${dishRevisionId},ordered,1`,
    );
    const csvText = [header, ...rows].join('\n');

    await expect(
      importOrderOutcomes({
        client: client as any,
        actorId,
        venueId,
        csvText,
        bundleLoader,
        trackingStartedAt: defaultTrackingStartedAt,
        now: () => new Date('2026-11-07T12:00:00Z'),
      }),
    ).rejects.toThrowError(/File exceeds maximum allowed rows/);
  });

  it('permits ordered and refunded outcomes for the same order line to coexist append-only without collision', async () => {
    const state = defaultState();
    const client = createMockClient(state);

    const csvText = [
      'schema_version,order_id,order_line_id,ordered_at,menu_revision_id,dish_id,dish_revision_id,outcome_type,quantity,unit_price,currency',
      `pilot_order_outcome.v1,TICK-1,LINE-1,2026-11-01T12:00:00Z,${menuRevisionId},${dishId},${dishRevisionId},ordered,1,15.00,USD`,
      `pilot_order_outcome.v1,TICK-1,LINE-1,2026-11-01T12:30:00Z,${menuRevisionId},${dishId},${dishRevisionId},refunded,1,15.00,USD`,
    ].join('\n');

    const result = await importOrderOutcomes({
      client: client as any,
      actorId,
      venueId,
      csvText,
      bundleLoader,
      trackingStartedAt: defaultTrackingStartedAt,
      now: () => new Date('2026-11-07T12:00:00Z'),
    });

    expect(result.totalRows).toBe(2);
    expect(result.acceptedRows).toBe(2);
    expect(result.conflictRows).toBe(0);
    expect(state.conflicts.length).toBe(0);
    expect(state.lines.size).toBe(2);
    expect(state.lines.has(`${venueId}:TICK-1:LINE-1:ordered`)).toBe(true);
    expect(state.lines.has(`${venueId}:TICK-1:LINE-1:refunded`)).toBe(true);
  });

  it('attempts compensating R2 deletion if database transaction rolls back', async () => {
    const state = defaultState();
    const client = createMockClient(state);

    // Force failure inside transaction
    const originalQuery = client.query;
    client.query = vi.fn(async (sql: string, params?: any[]) => {
      if (sql.includes('INSERT INTO app_private.order_outcome_lines')) {
        throw new Error('Database disk error');
      }
      return originalQuery(sql, params);
    });

    const mockPut = vi.fn().mockResolvedValue(undefined);
    const mockDelete = vi.fn().mockResolvedValue(undefined);
    const mockStorage = { put: mockPut, delete: mockDelete };

    const csvText = [
      'schema_version,order_id,order_line_id,ordered_at,menu_revision_id,dish_id,dish_revision_id,outcome_type,quantity',
      `pilot_order_outcome.v1,TICK-1,LINE-1,2026-11-01T12:00:00Z,${menuRevisionId},${dishId},${dishRevisionId},ordered,1`,
    ].join('\n');

    await expect(
      importOrderOutcomes({
        client: client as any,
        actorId,
        venueId,
        csvText,
        bundleLoader,
        storage: mockStorage,
        trackingStartedAt: defaultTrackingStartedAt,
        now: () => new Date('2026-11-07T12:00:00Z'),
      }),
    ).rejects.toThrow('Database disk error');

    expect(mockPut).toHaveBeenCalledTimes(1);
    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(mockDelete).toHaveBeenCalledWith(
      expect.stringMatching(/^order-imports\/.*\/source\.csv$/),
    );
  });

  it('fails closed and writes no database record if R2 storage put throws', async () => {
    const state = defaultState();
    const client = createMockClient(state);

    const mockPut = vi.fn().mockRejectedValue(new Error('R2 unavailable'));
    const mockStorage = { put: mockPut };

    const csvText = [
      'schema_version,order_id,order_line_id,ordered_at,menu_revision_id,dish_id,dish_revision_id,outcome_type,quantity',
      `pilot_order_outcome.v1,TICK-1,LINE-1,2026-11-01T12:00:00Z,${menuRevisionId},${dishId},${dishRevisionId},ordered,1`,
    ].join('\n');

    await expect(
      importOrderOutcomes({
        client: client as any,
        actorId,
        venueId,
        csvText,
        bundleLoader,
        storage: mockStorage,
        trackingStartedAt: defaultTrackingStartedAt,
        now: () => new Date('2026-11-07T12:00:00Z'),
      }),
    ).rejects.toThrow('R2 unavailable');

    // No transaction or batch was created in database
    expect(state.batches.size).toBe(0);
    expect(state.lines.size).toBe(0);
  });

  it('permits ordered and voided outcomes for the same order line to coexist append-only without collision', async () => {
    const state = defaultState();
    const client = createMockClient(state);

    const csvText = [
      'schema_version,order_id,order_line_id,ordered_at,menu_revision_id,dish_id,dish_revision_id,outcome_type,quantity,unit_price,currency',
      `pilot_order_outcome.v1,TICK-1,LINE-1,2026-11-01T12:00:00Z,${menuRevisionId},${dishId},${dishRevisionId},ordered,1,20.00,USD`,
      `pilot_order_outcome.v1,TICK-1,LINE-1,2026-11-01T12:05:00Z,${menuRevisionId},${dishId},${dishRevisionId},voided,1,20.00,USD`,
    ].join('\n');

    const result = await importOrderOutcomes({
      client: client as any,
      actorId,
      venueId,
      csvText,
      bundleLoader,
      trackingStartedAt: defaultTrackingStartedAt,
      now: () => new Date('2026-11-07T12:00:00Z'),
    });

    expect(result.totalRows).toBe(2);
    expect(result.acceptedRows).toBe(2);
    expect(result.conflictRows).toBe(0);
    expect(state.lines.has(`${venueId}:TICK-1:LINE-1:ordered`)).toBe(true);
    expect(state.lines.has(`${venueId}:TICK-1:LINE-1:voided`)).toBe(true);
  });

  describe('cleanupOrphanedOrderImports', () => {
    it('prunes orphaned R2 objects older than grace period that lack database batch records', async () => {
      const state = defaultState();
      const client = createMockClient(state);

      const activeBatchId = 'aaaaaaaa-aaaa-4000-8000-000000000001';
      const orphanedBatchId = 'bbbbbbbb-bbbb-4000-8000-000000000002';
      const recentOrphanBatchId = 'cccccccc-cccc-4000-8000-000000000003';

      // Insert activeBatchId into state batches
      state.batches.set(activeBatchId, {
        id: activeBatchId,
        tenant_id: venueId,
        status: 'completed',
      });

      const now = new Date('2026-11-07T12:00:00Z');
      const fourHoursAgo = new Date('2026-11-07T08:00:00Z');
      const thirtyMinutesAgo = new Date('2026-11-07T11:30:00Z');

      const objects = [
        // 1. Valid batch record in DB -> retain
        {
          key: `order-imports/${venueId}/${activeBatchId}/source.csv`,
          uploaded: fourHoursAgo,
        },
        // 2. Orphaned upload older than 2 hours without DB record -> delete
        {
          key: `order-imports/${venueId}/${orphanedBatchId}/source.csv`,
          uploaded: fourHoursAgo,
        },
        // 3. Orphaned upload within 2h grace period -> skip active
        {
          key: `order-imports/${venueId}/${recentOrphanBatchId}/source.csv`,
          uploaded: thirtyMinutesAgo,
        },
        // 4. Non-matching key -> retain safely
        {
          key: `order-imports/${venueId}/other.txt`,
          uploaded: fourHoursAgo,
        },
      ];

      const deletedKeys: string[] = [];
      const mockStorage = {
        put: vi.fn(),
        list: vi.fn().mockResolvedValue({ objects, truncated: false }),
        delete: vi.fn(async (key: string) => {
          deletedKeys.push(key);
        }),
      };

      const result = await cleanupOrphanedOrderImports({
        storage: mockStorage as any,
        client: client as any,
        venueId,
        gracePeriodMs: 7_200_000, // 2 hours
        now: () => now,
      });

      expect(result.scanned).toBe(4);
      expect(result.deleted).toBe(1);
      expect(result.skippedActive).toBe(1);
      expect(result.retained).toBe(2); // 1 active DB match + 1 non-standard key
      expect(deletedKeys).toEqual([`order-imports/${venueId}/${orphanedBatchId}/source.csv`]);
    });

    it('establishes tenant context inside an explicit transaction before checking database', async () => {
      const state = defaultState();
      const client = createMockClient(state);

      const orphanedBatchId = 'bbbbbbbb-bbbb-4000-8000-000000000002';
      const fourHoursAgo = new Date('2026-11-07T08:00:00Z');
      const now = new Date('2026-11-07T12:00:00Z');

      const objects = [
        {
          key: `order-imports/${venueId}/${orphanedBatchId}/source.csv`,
          uploaded: fourHoursAgo,
        },
      ];

      const mockStorage = {
        put: vi.fn(),
        list: vi.fn().mockResolvedValue({ objects, truncated: false }),
        delete: vi.fn().mockResolvedValue(undefined),
      };

      const result = await cleanupOrphanedOrderImports({
        storage: mockStorage as any,
        client: client as any,
        venueId,
        now: () => now,
      });

      expect(result.deleted).toBe(1);

      // Verify that BEGIN and COMMIT were invoked
      const queryStatements = client.query.mock.calls.map((call) => call[0]);
      expect(queryStatements).toContain('BEGIN');
      expect(queryStatements).toContain('COMMIT');

      // Verify set_config was invoked with venueId for RLS
      const tenantConfigs = client.query.mock.calls
        .filter((call) => call[0].includes("set_config('app.tenant_id'"))
        .map((call) => call[1]?.[0]);

      expect(tenantConfigs).toContain(venueId);
    });

    it('fails closed and preserves R2 objects if the database query fails', async () => {
      const state = defaultState();
      const client = createMockClient(state);

      // Force query failure during transaction
      client.query = vi.fn(async (sql: string, params?: any[]) => {
        if (sql.includes('FROM app_private.order_outcome_import_batches')) {
          throw new Error('Database connection reset');
        }
        return { rows: [], rowCount: 0 };
      });

      const orphanedBatchId = 'bbbbbbbb-bbbb-4000-8000-000000000002';
      const fourHoursAgo = new Date('2026-11-07T08:00:00Z');
      const now = new Date('2026-11-07T12:00:00Z');

      const objects = [
        {
          key: `order-imports/${venueId}/${orphanedBatchId}/source.csv`,
          uploaded: fourHoursAgo,
        },
      ];

      const mockDelete = vi.fn();
      const mockStorage = {
        put: vi.fn(),
        list: vi.fn().mockResolvedValue({ objects, truncated: false }),
        delete: mockDelete,
      };

      const result = await cleanupOrphanedOrderImports({
        storage: mockStorage as any,
        client: client as any,
        venueId,
        now: () => now,
      });

      expect(result.scanned).toBe(1);
      expect(result.deleted).toBe(0);
      expect(result.retained).toBe(1); // Preserved because DB query failed
      expect(mockDelete).not.toHaveBeenCalled();
    });

    it('strictly respects venue scope and never deletes objects belonging to another venue', async () => {
      const state = defaultState();
      const client = createMockClient(state);

      const otherVenueId = '99999999-9999-4000-8000-000000000099';
      const orphanedBatchId = 'bbbbbbbb-bbbb-4000-8000-000000000002';
      const fourHoursAgo = new Date('2026-11-07T08:00:00Z');
      const now = new Date('2026-11-07T12:00:00Z');

      const objects = [
        {
          key: `order-imports/${otherVenueId}/${orphanedBatchId}/source.csv`,
          uploaded: fourHoursAgo,
        },
      ];

      const mockStorage = {
        put: vi.fn(),
        list: vi.fn().mockResolvedValue({ objects, truncated: false }),
        delete: vi.fn().mockResolvedValue(undefined),
      };

      // Running cleanup scoped to venueId must NOT delete otherVenueId's object
      const result = await cleanupOrphanedOrderImports({
        storage: mockStorage as any,
        client: client as any,
        venueId,
        now: () => now,
      });

      expect(result.scanned).toBe(1);
      expect(result.deleted).toBe(0);
      expect(result.retained).toBe(1);
      expect(mockStorage.delete).not.toHaveBeenCalled();
    });

    it('prunes aged raw CSV files when configured retention period is exceeded', () => {
      const state = defaultState();
      const client = createMockClient(state);

      const now = new Date('2026-11-07T12:00:00Z');
      const hundredDaysAgo = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000);
      const fortyDaysAgo = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000);
      const fourHoursAgo = new Date(now.getTime() - 4 * 60 * 60 * 1000);
      const thirtyMinsAgo = new Date(now.getTime() - 30 * 60 * 1000);

      const batchAgedId = '00000000-0000-0000-0000-000000000010';
      const batchActiveId = '00000000-0000-0000-0000-000000000020';
      const orphanBatchId = '00000000-0000-0000-0000-000000000030';
      const inFlightBatchId = '00000000-0000-0000-0000-000000000040';

      // Batches in database
      state.batches.set(batchAgedId, {
        id: batchAgedId,
        tenant_id: venueId,
        status: 'completed',
      });
      state.batches.set(batchActiveId, {
        id: batchActiveId,
        tenant_id: venueId,
        status: 'completed',
      });

      const objects = [
        {
          key: `order-imports/${venueId}/${batchAgedId}/source.csv`,
          uploaded: hundredDaysAgo,
        },
        {
          key: `order-imports/${venueId}/${batchActiveId}/source.csv`,
          uploaded: fortyDaysAgo,
        },
        {
          key: `order-imports/${venueId}/${orphanBatchId}/source.csv`,
          uploaded: fourHoursAgo,
        },
        {
          key: `order-imports/${venueId}/${inFlightBatchId}/source.csv`,
          uploaded: thirtyMinsAgo,
        },
      ];

      const mockStorage = {
        put: vi.fn(),
        list: vi.fn().mockResolvedValue({ objects, truncated: false }),
        delete: vi.fn().mockResolvedValue(undefined),
      };

      // 1. Run cleanup with default retention policy: destructive purge of raw CSV is disabled by default
      return cleanupOrphanedOrderImports({
        storage: mockStorage as any,
        client: client as any,
        now: () => now,
      }).then(async (resultDefault) => {
        expect(resultDefault.scanned).toBe(4);
        expect(resultDefault.skippedActive).toBe(1); // 30 mins ago
        expect(resultDefault.deletedOrphans).toBe(1); // 4 hours ago orphan
        expect(resultDefault.deletedAgedRawCsv).toBe(0); // raw CSV purge disabled by default to prevent data loss
        expect(resultDefault.retained).toBe(2); // both 100 days ago and 40 days ago safely retained
        expect(resultDefault.deleted).toBe(1);

        // 2. Run cleanup with custom 30-day retention and explicit enableRawCsvPurge: true
        mockStorage.delete.mockClear();
        const resultCustom = await cleanupOrphanedOrderImports({
          storage: mockStorage as any,
          client: client as any,
          retentionConfig: {
            rawCsvRetentionDays: 30,
            enableRawCsvPurge: true,
          },
          now: () => now,
        });

        expect(resultCustom.scanned).toBe(4);
        expect(resultCustom.skippedActive).toBe(1);
        expect(resultCustom.deletedOrphans).toBe(1);
        expect(resultCustom.deletedAgedRawCsv).toBe(2); // both 100-day and 40-day (> 30 days)
        expect(resultCustom.retained).toBe(0);
        expect(resultCustom.deleted).toBe(3);
      });
    });
  });

  describe('POS export mapping & revision resolution boundary', () => {
    it('maps approved POS item code to canonical revision IDs and persists normalized outcome', async () => {
      const state = defaultState();
      state.menuApproval!.approvedAt = new Date('2026-10-01T00:00:00Z');
      const client = createMockClient(state);

      const csv = [
        'schema_version,order_id,order_line_id,ordered_at,pos_item_id,outcome_type,quantity,unit_price,currency',
        'pilot_order_outcome.v1,ORD-POS-1,LINE-1,2026-11-05T12:00:00Z,POS-PIZZA-1,ordered,2,14.50,USD',
      ].join('\n');

      const result = await importOrderOutcomes({
        client: client as any,
        actorId,
        venueId,
        csvText: csv,
        trackingStartedAt: '2026-10-01T00:00:00Z',
        bundleLoader,
        now: () => new Date('2026-11-07T12:00:00Z'),
      });

      expect(result.status).toBe('completed');
      expect(result.acceptedRows).toBe(1);
      expect(result.quarantinedRows).toBe(0);
      expect(result.conflictRows).toBe(0);

      // Verify canonical fields persisted in normalized outcome record
      const lineKey = `${venueId}:ORD-POS-1:LINE-1:ordered`;
      const persistedLine = state.lines.get(lineKey);
      expect(persistedLine).toBeDefined();
      expect(persistedLine.menu_revision_id).toBe(menuRevisionId);
      expect(persistedLine.dish_id).toBe(dishId);
      expect(persistedLine.dish_revision_id).toBe(dishRevisionId);
      expect(persistedLine.quantity).toBe(2);
      expect(persistedLine.unit_price).toBe(14.5);
      expect(persistedLine.currency).toBe('USD');
    });

    it('quarantines row with missing_pos_mapping when POS item code has no registered mapping', async () => {
      const state = defaultState();
      state.menuApproval!.approvedAt = new Date('2026-10-01T00:00:00Z');
      const client = createMockClient(state);

      const csv = [
        'schema_version,order_id,order_line_id,ordered_at,pos_item_id,outcome_type,quantity',
        'pilot_order_outcome.v1,ORD-UNKNOWN,LINE-1,2026-11-05T12:00:00Z,POS-UNREGISTERED-99,ordered,1',
      ].join('\n');

      const result = await importOrderOutcomes({
        client: client as any,
        actorId,
        venueId,
        csvText: csv,
        trackingStartedAt: '2026-10-01T00:00:00Z',
        bundleLoader,
        now: () => new Date('2026-11-07T12:00:00Z'),
      });

      expect(result.status).toBe('completed');
      expect(result.acceptedRows).toBe(0);
      expect(result.quarantinedRows).toBe(1);
      expect(result.diagnostics[0]?.reasonCode).toBe('missing_pos_mapping');
      expect(result.diagnostics[0]?.diagnosticMessage).toMatch(
        /no registered mapping in PeekaPlate/,
      );
    });

    it('quarantines row with unreviewed_pos_mapping when POS mapping is pending or rejected', async () => {
      const state = defaultState();
      state.menuApproval!.approvedAt = new Date('2026-10-01T00:00:00Z');
      state.posDishMappings.set(`${venueId}:POS-PENDING-1`, {
        tenant_id: venueId,
        pos_item_code: 'POS-PENDING-1',
        dish_id: dishId,
        dish_name: 'Pending Dish',
        review_status: 'pending',
        reviewed_by: null,
        reviewed_at: null,
      });
      const client = createMockClient(state);

      const csv = [
        'schema_version,order_id,order_line_id,ordered_at,pos_item_id,outcome_type,quantity',
        'pilot_order_outcome.v1,ORD-PEND,LINE-1,2026-11-05T12:00:00Z,POS-PENDING-1,ordered,1',
      ].join('\n');

      const result = await importOrderOutcomes({
        client: client as any,
        actorId,
        venueId,
        csvText: csv,
        trackingStartedAt: '2026-10-01T00:00:00Z',
        bundleLoader,
        now: () => new Date('2026-11-07T12:00:00Z'),
      });

      expect(result.status).toBe('completed');
      expect(result.acceptedRows).toBe(0);
      expect(result.quarantinedRows).toBe(1);
      expect(result.diagnostics[0]?.reasonCode).toBe('unreviewed_pos_mapping');
      expect(result.diagnostics[0]?.diagnosticMessage).toMatch(/reviewed approval required/);
    });

    it('quarantines row with missing_tracking_start_evidence when trackingStartedAt is omitted and no DB activation exists', async () => {
      const state = defaultState();
      state.venueTrackingActivations = new Map(); // No activation in DB either
      state.menuApproval!.approvedAt = new Date('2026-10-01T00:00:00Z');
      const client = createMockClient(state);

      const csv = [
        'schema_version,order_id,order_line_id,ordered_at,pos_item_id,outcome_type,quantity',
        'pilot_order_outcome.v1,ORD-NO-TRACK,LINE-1,2026-11-05T12:00:00Z,POS-PIZZA-1,ordered,1',
      ].join('\n');

      const result = await importOrderOutcomes({
        client: client as any,
        actorId,
        venueId,
        csvText: csv,
        // trackingStartedAt intentionally omitted
        bundleLoader,
        now: () => new Date('2026-11-07T12:00:00Z'),
      });

      expect(result.status).toBe('completed');
      expect(result.acceptedRows).toBe(0);
      expect(result.quarantinedRows).toBe(1);
      expect(result.diagnostics[0]?.reasonCode).toBe('missing_tracking_start_evidence');
      expect(result.diagnostics[0]?.diagnosticMessage).toMatch(
        /Authoritative venue tracking-start date is not established/,
      );
    });

    it('loads activation from authorized tenant context when trackingStartedAt is omitted and DB activation exists (Finding A)', async () => {
      const state = defaultState(); // Has venueTrackingActivations
      state.menuApproval!.approvedAt = new Date('2026-10-01T00:00:00Z');
      const client = createMockClient(state);

      const csv = [
        'schema_version,order_id,order_line_id,ordered_at,pos_item_id,outcome_type,quantity',
        'pilot_order_outcome.v1,ORD-TRACK-OK,LINE-1,2026-11-05T12:00:00Z,POS-PIZZA-1,ordered,1',
      ].join('\n');

      const result = await importOrderOutcomes({
        client: client as any,
        actorId,
        venueId,
        csvText: csv,
        // trackingStartedAt intentionally omitted
        bundleLoader,
        now: () => new Date('2026-11-07T12:00:00Z'),
      });

      expect(result.status).toBe('completed');
      expect(result.acceptedRows).toBe(1);
      expect(result.quarantinedRows).toBe(0);
    });

    it('quarantines row with before_tracking_start when order timestamp is before restaurant tracking start', async () => {
      const state = defaultState();
      state.menuApproval!.approvedAt = new Date('2026-10-01T00:00:00Z');
      const client = createMockClient(state);

      const csv = [
        'schema_version,order_id,order_line_id,ordered_at,pos_item_id,outcome_type,quantity',
        'pilot_order_outcome.v1,ORD-BEFORE-TRACK,LINE-1,2026-10-15T12:00:00Z,POS-PIZZA-1,ordered,1',
      ].join('\n');

      const result = await importOrderOutcomes({
        client: client as any,
        actorId,
        venueId,
        csvText: csv,
        trackingStartedAt: '2026-11-01T00:00:00Z',
        bundleLoader,
        now: () => new Date('2026-11-07T12:00:00Z'),
      });

      expect(result.status).toBe('completed');
      expect(result.acceptedRows).toBe(0);
      expect(result.quarantinedRows).toBe(1);
      expect(result.diagnostics[0]?.reasonCode).toBe('before_tracking_start');
      expect(result.diagnostics[0]?.diagnosticMessage).toMatch(
        /before the restaurant tracking start/,
      );
    });

    it('quarantines row with out_of_revision_window when order predates menu approval', async () => {
      const state = defaultState();
      state.menuApproval!.approvedAt = new Date('2026-11-01T00:00:00Z');
      const client = createMockClient(state);

      const csv = [
        'schema_version,order_id,order_line_id,ordered_at,pos_item_id,outcome_type,quantity',
        'pilot_order_outcome.v1,ORD-OLD-REV,LINE-1,2026-10-15T12:00:00Z,POS-PIZZA-1,ordered,1',
      ].join('\n');

      const result = await importOrderOutcomes({
        client: client as any,
        actorId,
        venueId,
        csvText: csv,
        trackingStartedAt: '2026-10-01T00:00:00Z',
        bundleLoader,
        now: () => new Date('2026-11-07T12:00:00Z'),
      });

      expect(result.status).toBe('completed');
      expect(result.acceptedRows).toBe(0);
      expect(result.quarantinedRows).toBe(1);
      expect(result.diagnostics[0]?.reasonCode).toBe('out_of_revision_window');
    });

    it('quarantines row with unmatched_dish when mapped dish does not exist in active menu', async () => {
      const state = defaultState();
      state.menuApproval!.approvedAt = new Date('2026-10-01T00:00:00Z');
      state.posDishMappings.set(`${venueId}:POS-NOT-IN-BUNDLE`, {
        tenant_id: venueId,
        pos_item_code: 'POS-NOT-IN-BUNDLE',
        dish_id: '99999999-9999-4000-8000-000000000099',
        dish_name: 'Missing Dish',
        review_status: 'approved',
        reviewed_by: actorId,
        reviewed_at: new Date('2026-10-01T00:00:00Z'),
      });
      const client = createMockClient(state);

      const csv = [
        'schema_version,order_id,order_line_id,ordered_at,pos_item_id,outcome_type,quantity',
        'pilot_order_outcome.v1,ORD-MISSING-DISH,LINE-1,2026-11-05T12:00:00Z,POS-NOT-IN-BUNDLE,ordered,1',
      ].join('\n');

      const result = await importOrderOutcomes({
        client: client as any,
        actorId,
        venueId,
        csvText: csv,
        trackingStartedAt: '2026-10-01T00:00:00Z',
        bundleLoader,
        now: () => new Date('2026-11-07T12:00:00Z'),
      });

      expect(result.status).toBe('completed');
      expect(result.acceptedRows).toBe(0);
      expect(result.quarantinedRows).toBe(1);
      expect(result.diagnostics[0]?.reasonCode).toBe('unmatched_dish');
      expect(result.diagnostics[0]?.diagnosticMessage).toMatch(
        /not present in the published menu revision/,
      );
    });

    it('respects configurable maxHistoricalDays during ingestion', async () => {
      const state = defaultState();
      state.menuApproval!.approvedAt = new Date('2026-09-01T00:00:00Z');
      const client = createMockClient(state);

      // Order timestamp is 45 days ago
      const csv = [
        'schema_version,order_id,order_line_id,ordered_at,pos_item_id,outcome_type,quantity',
        'pilot_order_outcome.v1,ORD-HIST,LINE-1,2026-09-23T12:00:00Z,POS-PIZZA-1,ordered,1',
      ].join('\n');

      // Ingest with 30-day limit: quarantined as too_old
      const resultRestricted = await importOrderOutcomes({
        client: client as any,
        actorId,
        venueId,
        csvText: csv,
        trackingStartedAt: '2026-08-01T00:00:00Z',
        maxHistoricalDays: 30,
        bundleLoader,
        now: () => new Date('2026-11-07T12:00:00Z'),
      });

      expect(resultRestricted.quarantinedRows).toBe(1);
      expect(resultRestricted.diagnostics[0]?.reasonCode).toBe('too_old');
      expect(resultRestricted.diagnostics[0]?.diagnosticMessage).toMatch(/30-day/);
    });
  });

  describe('Authoritative Venue Tracking Activation & POS Mapping Boundary Tests', () => {
    it('1. Activation timestamp is recorded when live tracking is enabled', async () => {
      const state = defaultState();
      state.venueTrackingActivations = new Map(); // initially unactivated
      const client = createMockClient(state);

      const before = Date.now();
      const record = await recordVenueTrackingActivation(
        client as any,
        actorId,
        venueId,
        'menu_publication',
      );
      const after = Date.now();

      expect(record.tenantId).toBe(venueId);
      expect(record.activatedBy).toBe(actorId);
      expect(record.source).toBe('menu_publication');
      expect(record.activatedAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(record.activatedAt.getTime()).toBeLessThanOrEqual(after);

      const retrieved = await getVenueTrackingActivation(client as any, venueId);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.activatedAt).toEqual(record.activatedAt);
    });

    it('2. Client-provided timestamps cannot override server-controlled activation', async () => {
      const state = defaultState();
      const client = createMockClient(state);

      // Attempting to backdate activation timestamp via client query
      const backdatedTime = new Date(Date.now() - 86400000 * 30); // 30 days ago
      await expect(
        client.query(
          `INSERT INTO app_private.venue_tracking_activations (tenant_id, activated_at, activated_by, source)
           VALUES ($1, $2, $3, 'administrative')`,
          [venueId, backdatedTime, actorId],
        ),
      ).rejects.toThrow(/Client-supplied activation timestamp is prohibited/);
    });

    it('3. First accepted observation arriving after activation does not change the activation timestamp', async () => {
      const state = defaultState();
      const fixedActivationTime = new Date('2026-10-01T00:00:00Z');
      state.venueTrackingActivations = new Map([
        [
          venueId,
          {
            tenant_id: venueId,
            activated_at: fixedActivationTime,
            activated_by: actorId,
            source: 'menu_publication',
          },
        ],
      ]);
      const client = createMockClient(state);

      // Simulate diner observation arriving at a later timestamp (e.g. 2026-10-02T12:00:00Z)
      // Observation pipeline writes to observation_index / observation_event, never modifying venue_tracking_activations
      const trackingActivationAfterObservation = await getVenueTrackingActivation(
        client as any,
        venueId,
      );
      expect(trackingActivationAfterObservation?.activatedAt).toEqual(fixedActivationTime);
    });

    it('4. Orders before activation are not eligible (quarantined with before_tracking_start)', async () => {
      const state = defaultState();
      const activationTime = new Date('2026-10-01T00:00:00Z');
      state.venueTrackingActivations = new Map([
        [
          venueId,
          {
            tenant_id: venueId,
            activated_at: activationTime,
            activated_by: actorId,
            source: 'menu_publication',
          },
        ],
      ]);
      const client = createMockClient(state);

      // Order timestamp is 2026-09-30 (1 day before activation)
      const csv = [
        'schema_version,order_id,order_line_id,ordered_at,pos_item_id,outcome_type,quantity',
        'pilot_order_outcome.v1,ORD-PRE,LINE-1,2026-09-30T12:00:00Z,POS-PIZZA-1,ordered,1',
      ].join('\n');

      const result = await importOrderOutcomes({
        client: client as any,
        actorId,
        venueId,
        csvText: csv,
        trackingStartedAt: activationTime,
        bundleLoader,
        now: () => new Date('2026-10-05T12:00:00Z'),
      });

      expect(result.acceptedRows).toBe(0);
      expect(result.quarantinedRows).toBe(1);
      expect(result.diagnostics[0]?.reasonCode).toBe('before_tracking_start');
      expect(result.diagnostics[0]?.diagnosticMessage).toMatch(
        /before the restaurant tracking start/,
      );
    });

    it('5. Orders after activation can become eligible for evaluation (accepted into order_outcome_lines)', async () => {
      const state = defaultState();
      const activationTime = new Date('2026-10-01T00:00:00Z');
      state.venueTrackingActivations = new Map([
        [
          venueId,
          {
            tenant_id: venueId,
            activated_at: activationTime,
            activated_by: actorId,
            source: 'menu_publication',
          },
        ],
      ]);
      const client = createMockClient(state);

      // Order timestamp is 2026-10-02 (after activation)
      const csv = [
        'schema_version,order_id,order_line_id,ordered_at,pos_item_id,outcome_type,quantity',
        'pilot_order_outcome.v1,ORD-POST,LINE-1,2026-10-02T12:00:00Z,POS-PIZZA-1,ordered,1',
      ].join('\n');

      const result = await importOrderOutcomes({
        client: client as any,
        actorId,
        venueId,
        csvText: csv,
        trackingStartedAt: activationTime,
        bundleLoader,
        now: () => new Date('2026-10-05T12:00:00Z'),
      });

      expect(result.acceptedRows).toBe(1);
      expect(result.quarantinedRows).toBe(0);
      expect(state.lines.size).toBe(1);
    });

    it('6. Missing activation evidence results in missing_tracking_start_evidence quarantine', async () => {
      const state = defaultState();
      state.venueTrackingActivations = new Map(); // empty
      const client = createMockClient(state);

      const csv = [
        'schema_version,order_id,order_line_id,ordered_at,pos_item_id,outcome_type,quantity',
        'pilot_order_outcome.v1,ORD-NO-TRACK,LINE-1,2026-10-02T12:00:00Z,POS-PIZZA-1,ordered,1',
      ].join('\n');

      const result = await importOrderOutcomes({
        client: client as any,
        actorId,
        venueId,
        csvText: csv,
        trackingStartedAt: undefined, // no activation evidence
        bundleLoader,
        now: () => new Date('2026-10-05T12:00:00Z'),
      });

      expect(result.acceptedRows).toBe(0);
      expect(result.quarantinedRows).toBe(1);
      expect(result.diagnostics[0]?.reasonCode).toBe('missing_tracking_start_evidence');
      expect(result.diagnostics[0]?.diagnosticMessage).toMatch(
        /Authoritative venue tracking-start date is not established/,
      );
    });

    it('7. Eligible orders without matching observation evidence remain explicitly unlinked', async () => {
      const state = defaultState();
      const activationTime = new Date('2026-10-01T00:00:00Z');
      state.venueTrackingActivations = new Map([
        [
          venueId,
          {
            tenant_id: venueId,
            activated_at: activationTime,
            activated_by: actorId,
            source: 'menu_publication',
          },
        ],
      ]);
      const client = createMockClient(state);

      const csv = [
        'schema_version,order_id,order_line_id,ordered_at,pos_item_id,outcome_type,quantity',
        'pilot_order_outcome.v1,ORD-UNLINKED,LINE-1,2026-10-02T12:00:00Z,POS-PIZZA-1,ordered,2',
      ].join('\n');

      const result = await importOrderOutcomes({
        client: client as any,
        actorId,
        venueId,
        csvText: csv,
        trackingStartedAt: activationTime,
        bundleLoader,
        now: () => new Date('2026-10-05T12:00:00Z'),
      });

      expect(result.acceptedRows).toBe(1);
      const lineKey = `${venueId}:ORD-UNLINKED:LINE-1:ordered`;
      const persistedLine = state.lines.get(lineKey);
      expect(persistedLine).toBeDefined();

      // Ensure explicit schema boundary: NO observation fields, NO session IDs, NO synthetic visit links
      expect(persistedLine).not.toHaveProperty('observation_id');
      expect(persistedLine).not.toHaveProperty('session_id');
      expect(persistedLine).not.toHaveProperty('visit_id');
      expect(persistedLine).not.toHaveProperty('event_id');
      expect(persistedLine.order_id).toBe('ORD-UNLINKED');
      expect(persistedLine.outcome_type).toBe('ordered');
    });

    it('8. Activation eligibility does not automatically create an order-to-visit match', async () => {
      const state = defaultState();
      const activationTime = new Date('2026-10-01T00:00:00Z');
      const client = createMockClient(state);

      const csv = [
        'schema_version,order_id,order_line_id,ordered_at,pos_item_id,outcome_type,quantity',
        'pilot_order_outcome.v1,ORD-NO-MATCH,LINE-1,2026-10-02T12:00:00Z,POS-PIZZA-1,ordered,1',
      ].join('\n');

      await importOrderOutcomes({
        client: client as any,
        actorId,
        venueId,
        csvText: csv,
        trackingStartedAt: activationTime,
        bundleLoader,
        now: () => new Date('2026-10-05T12:00:00Z'),
      });

      // Assert that none of the diner observation pipeline tables or views were queried or mutated
      const executedSqls = (client.query as any).mock.calls.map((c: any) => c[0]);
      expect(executedSqls.some((sql: string) => sql.includes('observation_index'))).toBe(false);
      expect(executedSqls.some((sql: string) => sql.includes('observation_event'))).toBe(false);
      expect(executedSqls.some((sql: string) => sql.includes('owner_observation_v1'))).toBe(false);
    });

    it('9. Venue isolation prevents one venue activation timestamp from affecting another venue', async () => {
      const venueA = '00000000-0000-4000-8000-000000000001';
      const venueB = '00000000-0000-4000-8000-000000000002';
      const state = defaultState();
      // Venue A is activated
      state.venueTrackingActivations = new Map([
        [
          venueA,
          {
            tenant_id: venueA,
            activated_at: new Date('2026-10-01T00:00:00Z'),
            activated_by: actorId,
            source: 'menu_publication',
          },
        ],
      ]);
      const client = createMockClient(state);

      // Venue B has no tracking activation
      const venueBActivation = await getVenueTrackingActivation(client as any, venueB);
      expect(venueBActivation).toBeNull();
    });

    it('10. Existing approved POS mapping and reviewer authorization safeguards remain intact', async () => {
      const state = defaultState();
      const client = createMockClient(state);

      // Set mapping to pending (unreviewed)
      state.posDishMappings.set(`${venueId}:POS-PIZZA-1`, {
        tenant_id: venueId,
        pos_item_code: 'POS-PIZZA-1',
        dish_id: dishId,
        dish_name: 'Margherita Pizza',
        review_status: 'pending',
        reviewed_by: null,
        reviewed_at: null,
      });

      const csv = [
        'schema_version,order_id,order_line_id,ordered_at,pos_item_id,outcome_type,quantity',
        'pilot_order_outcome.v1,ORD-UNREV,LINE-1,2026-10-02T12:00:00Z,POS-PIZZA-1,ordered,1',
      ].join('\n');

      const result = await importOrderOutcomes({
        client: client as any,
        actorId,
        venueId,
        csvText: csv,
        trackingStartedAt: '2026-10-01T00:00:00Z',
        bundleLoader,
        now: () => new Date('2026-10-05T12:00:00Z'),
      });

      expect(result.acceptedRows).toBe(0);
      expect(result.quarantinedRows).toBe(1);
      expect(result.diagnostics[0]?.reasonCode).toBe('unreviewed_pos_mapping');
      expect(result.diagnostics[0]?.diagnosticMessage).toMatch(/reviewed approval required/);
    });
  });

  describe('PR Review Findings Regression Coverage (DATA-07)', () => {
    // Finding G: Strict quantity validation
    describe('Strict quantity validation (Finding G)', () => {
      it.each([
        ['1.5', 'decimal number'],
        ['1junk', 'trailing non-digit characters'],
        ['1e2', 'scientific notation'],
        ['0', 'zero quantity'],
        ['1000', 'quantity exceeding 999 ceiling'],
        ['-1', 'negative quantity'],
        ['', 'empty quantity token'],
      ])('quarantines invalid quantity %s (%s) with invalid_format', async (qtyStr) => {
        const state = defaultState();
        const client = createMockClient(state);

        const csv = [
          'schema_version,order_id,order_line_id,ordered_at,pos_item_id,outcome_type,quantity',
          `pilot_order_outcome.v1,ORD-QTY-INV,LINE-1,2026-10-02T12:00:00Z,POS-PIZZA-1,ordered,${qtyStr}`,
        ].join('\n');

        const result = await importOrderOutcomes({
          client: client as any,
          actorId,
          venueId,
          csvText: csv,
          trackingStartedAt: '2026-10-01T00:00:00Z',
          bundleLoader,
          now: () => new Date('2026-10-05T12:00:00Z'),
        });

        expect(result.acceptedRows).toBe(0);
        expect(result.quarantinedRows).toBe(1);
        expect(result.diagnostics[0]?.fieldName).toBe('quantity');
        expect(result.diagnostics[0]?.reasonCode).toBe('invalid_format');
        expect(result.diagnostics[0]?.diagnosticMessage).toBe(
          'quantity must be an integer between 1 and 999',
        );
      });

      it.each([
        ['1', 1],
        ['999', 999],
        ['42', 42],
      ])('accepts valid boundary integer quantity %s', async (qtyStr, expectedQty) => {
        const state = defaultState();
        const client = createMockClient(state);

        const csv = [
          'schema_version,order_id,order_line_id,ordered_at,pos_item_id,outcome_type,quantity',
          `pilot_order_outcome.v1,ORD-QTY-OK,LINE-1,2026-10-02T12:00:00Z,POS-PIZZA-1,ordered,${qtyStr}`,
        ].join('\n');

        const result = await importOrderOutcomes({
          client: client as any,
          actorId,
          venueId,
          csvText: csv,
          trackingStartedAt: '2026-10-01T00:00:00Z',
          bundleLoader,
          now: () => new Date('2026-10-05T12:00:00Z'),
        });

        expect(result.acceptedRows).toBe(1);
        expect(result.quarantinedRows).toBe(0);
        const persisted = [...state.lines.values()][0];
        expect(persisted?.quantity).toBe(expectedQty);
      });
    });

    // Finding F: Unambiguous tuple identity encoding
    describe('Unambiguous order identity tuple (Finding F)', () => {
      it('accepts (A:B, C, ordered) and (A, B:C, ordered) independently in same batch without delimiter collision', async () => {
        const state = defaultState();
        const client = createMockClient(state);

        const csv = [
          'schema_version,order_id,order_line_id,ordered_at,pos_item_id,outcome_type,quantity',
          'pilot_order_outcome.v1,A:B,C,2026-10-02T12:00:00Z,POS-PIZZA-1,ordered,1',
          'pilot_order_outcome.v1,A,B:C,2026-10-02T12:00:00Z,POS-PIZZA-1,ordered,1',
        ].join('\n');

        const result = await importOrderOutcomes({
          client: client as any,
          actorId,
          venueId,
          csvText: csv,
          trackingStartedAt: '2026-10-01T00:00:00Z',
          bundleLoader,
          now: () => new Date('2026-10-05T12:00:00Z'),
        });

        expect(result.status).toBe('completed');
        expect(result.totalRows).toBe(2);
        expect(result.acceptedRows).toBe(2);
        expect(result.duplicateRows).toBe(0);
        expect(result.conflictRows).toBe(0);
        expect(result.quarantinedRows).toBe(0);
      });

      it('detects genuine duplicate lines within the batch with identical tuple identity and checksum', async () => {
        const state = defaultState();
        const client = createMockClient(state);

        const csv = [
          'schema_version,order_id,order_line_id,ordered_at,pos_item_id,outcome_type,quantity',
          'pilot_order_outcome.v1,ORD-DUP,LINE-1,2026-10-02T12:00:00Z,POS-PIZZA-1,ordered,1',
          'pilot_order_outcome.v1,ORD-DUP,LINE-1,2026-10-02T12:00:00Z,POS-PIZZA-1,ordered,1',
        ].join('\n');

        const result = await importOrderOutcomes({
          client: client as any,
          actorId,
          venueId,
          csvText: csv,
          trackingStartedAt: '2026-10-01T00:00:00Z',
          bundleLoader,
          now: () => new Date('2026-10-05T12:00:00Z'),
        });

        expect(result.acceptedRows).toBe(1);
        expect(result.duplicateRows).toBe(1);
        expect(result.conflictRows).toBe(0);
      });
    });

    // Finding D: Canonical Sprint 4 Publication and Withdrawal History
    describe('Canonical publication and withdrawal history (Finding D)', () => {
      it('quarantines row when order timestamp is before menu publication event (approval before publication)', async () => {
        const state = defaultState();
        // Menu was approved at 2026-09-01, but only published at 2026-10-05
        state.publicationEvents = [
          {
            menuId: '00000000-0000-0000-0000-000000000001',
            menuRevisionId,
            eventType: 'menu.published',
            occurredAt: new Date('2026-10-05T00:00:00Z'),
            version: 1,
          },
        ];
        const client = createMockClient(state);

        // Order occurred on 2026-10-02 (before publication on 2026-10-05)
        const csv = [
          'schema_version,order_id,order_line_id,ordered_at,pos_item_id,outcome_type,quantity',
          'pilot_order_outcome.v1,ORD-BEFORE-PUB,LINE-1,2026-10-02T12:00:00Z,POS-PIZZA-1,ordered,1',
        ].join('\n');

        const result = await importOrderOutcomes({
          client: client as any,
          actorId,
          venueId,
          csvText: csv,
          trackingStartedAt: '2026-09-01T00:00:00Z',
          bundleLoader,
          now: () => new Date('2026-10-10T12:00:00Z'),
        });

        expect(result.acceptedRows).toBe(0);
        expect(result.quarantinedRows).toBe(1);
        expect(result.diagnostics[0]?.reasonCode).toBe('out_of_revision_window');
        expect(result.diagnostics[0]?.diagnosticMessage).toMatch(
          /No published menu revision was active at order timestamp/,
        );
      });

      it('accepts row when order timestamp is during valid active publication', async () => {
        const state = defaultState();
        state.publicationEvents = [
          {
            menuId: '00000000-0000-0000-0000-000000000001',
            menuRevisionId,
            eventType: 'menu.published',
            occurredAt: new Date('2026-10-01T00:00:00Z'),
            version: 1,
          },
        ];
        const client = createMockClient(state);

        const csv = [
          'schema_version,order_id,order_line_id,ordered_at,pos_item_id,outcome_type,quantity',
          'pilot_order_outcome.v1,ORD-VALID-PUB,LINE-1,2026-10-02T12:00:00Z,POS-PIZZA-1,ordered,1',
        ].join('\n');

        const result = await importOrderOutcomes({
          client: client as any,
          actorId,
          venueId,
          csvText: csv,
          trackingStartedAt: '2026-10-01T00:00:00Z',
          bundleLoader,
          now: () => new Date('2026-10-10T12:00:00Z'),
        });

        expect(result.acceptedRows).toBe(1);
        expect(result.quarantinedRows).toBe(0);
      });

      it('quarantines row when order timestamp is after menu withdrawal', async () => {
        const state = defaultState();
        state.publicationEvents = [
          {
            menuId: '00000000-0000-0000-0000-000000000001',
            menuRevisionId,
            eventType: 'menu.published',
            occurredAt: new Date('2026-10-01T00:00:00Z'),
            version: 1,
          },
          {
            menuId: '00000000-0000-0000-0000-000000000001',
            menuRevisionId,
            eventType: 'menu.withdrawn',
            occurredAt: new Date('2026-10-03T00:00:00Z'),
            version: 2,
          },
        ];
        const client = createMockClient(state);

        // Order on 2026-10-04 (after withdrawal)
        const csv = [
          'schema_version,order_id,order_line_id,ordered_at,pos_item_id,outcome_type,quantity',
          'pilot_order_outcome.v1,ORD-AFTER-WITHDRAWN,LINE-1,2026-10-04T12:00:00Z,POS-PIZZA-1,ordered,1',
        ].join('\n');

        const result = await importOrderOutcomes({
          client: client as any,
          actorId,
          venueId,
          csvText: csv,
          trackingStartedAt: '2026-10-01T00:00:00Z',
          bundleLoader,
          now: () => new Date('2026-10-10T12:00:00Z'),
        });

        expect(result.acceptedRows).toBe(0);
        expect(result.quarantinedRows).toBe(1);
        expect(result.diagnostics[0]?.reasonCode).toBe('out_of_revision_window');
        expect(result.diagnostics[0]?.diagnosticMessage).toMatch(
          /No published menu revision was active at order timestamp/,
        );
      });

      it('quarantines row when multiple active menus are published at order timestamp (ambiguous menu history)', async () => {
        const state = defaultState();
        const secondMenuRevId = '00000000-0000-0000-0000-000000000099';
        state.publicationEvents = [
          {
            menuId: '00000000-0000-0000-0000-000000000001',
            menuRevisionId,
            eventType: 'menu.published',
            occurredAt: new Date('2026-10-01T00:00:00Z'),
            version: 1,
          },
          {
            menuId: '00000000-0000-0000-0000-000000000002',
            menuRevisionId: secondMenuRevId,
            eventType: 'menu.published',
            occurredAt: new Date('2026-10-01T00:00:00Z'),
            version: 1,
          },
        ];
        const client = createMockClient(state);

        const csv = [
          'schema_version,order_id,order_line_id,ordered_at,pos_item_id,outcome_type,quantity',
          'pilot_order_outcome.v1,ORD-MULTI-MENU,LINE-1,2026-10-02T12:00:00Z,POS-PIZZA-1,ordered,1',
        ].join('\n');

        const result = await importOrderOutcomes({
          client: client as any,
          actorId,
          venueId,
          csvText: csv,
          trackingStartedAt: '2026-10-01T00:00:00Z',
          bundleLoader,
          now: () => new Date('2026-10-10T12:00:00Z'),
        });

        expect(result.acceptedRows).toBe(0);
        expect(result.quarantinedRows).toBe(1);
        expect(result.diagnostics[0]?.reasonCode).toBe('out_of_revision_window');
        expect(result.diagnostics[0]?.diagnosticMessage).toMatch(
          /Multiple active menus were published at order timestamp/,
        );
      });

      it('quarantines explicit canonical ID row when the revision was never published', async () => {
        const state = defaultState();
        state.publicationEvents = []; // No publication events
        const client = createMockClient(state);

        const csv = [
          'schema_version,order_id,order_line_id,ordered_at,menu_revision_id,dish_id,dish_revision_id,outcome_type,quantity',
          `pilot_order_outcome.v1,ORD-CANON-UNPUB,LINE-1,2026-10-02T12:00:00Z,${menuRevisionId},${dishId},${dishRevisionId},ordered,1`,
        ].join('\n');

        const result = await importOrderOutcomes({
          client: client as any,
          actorId,
          venueId,
          csvText: csv,
          trackingStartedAt: '2026-10-01T00:00:00Z',
          bundleLoader,
          now: () => new Date('2026-10-10T12:00:00Z'),
        });

        expect(result.acceptedRows).toBe(0);
        expect(result.quarantinedRows).toBe(1);
        expect(result.diagnostics[0]?.reasonCode).toBe('out_of_revision_window');
        expect(result.diagnostics[0]?.diagnosticMessage).toMatch(
          /Specified menu revision was not active at order timestamp/,
        );
      });

      it('quarantines explicit canonical ID row when the revision was withdrawn before order timestamp', async () => {
        const state = defaultState();
        state.publicationEvents = [
          {
            menuId: '00000000-0000-0000-0000-000000000001',
            menuRevisionId,
            eventType: 'menu.published',
            occurredAt: new Date('2026-10-01T00:00:00Z'),
            version: 1,
          },
          {
            menuId: '00000000-0000-0000-0000-000000000001',
            menuRevisionId,
            eventType: 'menu.withdrawn',
            occurredAt: new Date('2026-10-03T00:00:00Z'),
            version: 2,
          },
        ];
        const client = createMockClient(state);

        const csv = [
          'schema_version,order_id,order_line_id,ordered_at,menu_revision_id,dish_id,dish_revision_id,outcome_type,quantity',
          `pilot_order_outcome.v1,ORD-CANON-WITHDRAWN,LINE-1,2026-10-04T12:00:00Z,${menuRevisionId},${dishId},${dishRevisionId},ordered,1`,
        ].join('\n');

        const result = await importOrderOutcomes({
          client: client as any,
          actorId,
          venueId,
          csvText: csv,
          trackingStartedAt: '2026-10-01T00:00:00Z',
          bundleLoader,
          now: () => new Date('2026-10-10T12:00:00Z'),
        });

        expect(result.acceptedRows).toBe(0);
        expect(result.quarantinedRows).toBe(1);
        expect(result.diagnostics[0]?.reasonCode).toBe('out_of_revision_window');
        expect(result.diagnostics[0]?.diagnosticMessage).toMatch(
          /Specified menu revision was not active at order timestamp/,
        );
      });
    });

    // Finding B: Reauthorization in processing transaction
    describe('Reauthorization in processing transaction (Finding B)', () => {
      it('rejects with 403 and cleans uploaded archive if owner permission is revoked before processing transaction', async () => {
        const state = defaultState();
        let checkCount = 0;
        const mockStorage = {
          put: vi.fn().mockResolvedValue(undefined),
          delete: vi.fn().mockResolvedValue(undefined),
        };

        const client = {
          query: vi.fn(async (sql: string, params?: any[]) => {
            const normalizedSql = sql.replace(/\s+/g, ' ').trim();
            if (
              normalizedSql.startsWith('BEGIN') ||
              normalizedSql.startsWith('COMMIT') ||
              normalizedSql.startsWith('ROLLBACK')
            ) {
              return { rows: [], rowCount: 0 };
            }
            if (
              normalizedSql.includes("set_config('app.actor_id'") ||
              normalizedSql.includes("set_config('app.tenant_id'")
            ) {
              return { rows: [], rowCount: 0 };
            }
            if (
              normalizedSql.includes('SET LOCAL') ||
              normalizedSql.includes('pg_advisory_xact_lock')
            ) {
              return { rows: [], rowCount: 0 };
            }
            if (normalizedSql.includes('FROM app_private.system_gates')) {
              return { rows: [{ is_active: false }], rowCount: 1 };
            }
            if (normalizedSql.includes('FROM app_private.order_data_deletion_gates')) {
              return { rows: [{ deletion_epoch: 0 }], rowCount: 1 };
            }
            if (normalizedSql.includes('FROM app_private.staff_membership')) {
              checkCount++;
              // First check during initial auth succeeds
              if (checkCount === 1) {
                return { rows: [{ permission: 'owner' }], rowCount: 1 };
              }
              // Second check inside processing transaction fails (e.g. membership revoked or downgraded)
              return { rows: [{ permission: 'editor' }], rowCount: 1 };
            }
            if (normalizedSql.includes('FROM app_private.pilot_order_agreement_acceptances')) {
              return { rows: [{ id: '00000000-0000-4000-8000-000000000099' }], rowCount: 1 };
            }
            if (normalizedSql.includes('FROM app_private.order_outcome_import_batches')) {
              return { rows: [], rowCount: 0 };
            }
            return { rows: [], rowCount: 0 };
          }),
        };

        const csv = [
          'schema_version,order_id,order_line_id,ordered_at,pos_item_id,outcome_type,quantity',
          'pilot_order_outcome.v1,ORD-REVOKED,LINE-1,2026-10-02T12:00:00Z,POS-PIZZA-1,ordered,1',
        ].join('\n');

        await expect(
          importOrderOutcomes({
            client: client as any,
            actorId,
            venueId,
            csvText: csv,
            storage: mockStorage as any,
            bundleLoader,
            now: () => new Date('2026-10-05T12:00:00Z'),
          }),
        ).rejects.toThrow('Order outcome import requires owner permission');

        // Verify storage compensation executed
        expect(mockStorage.delete).toHaveBeenCalledTimes(1);
      });
    });

    // Finding E: Idempotency under advisory lock
    describe('Concurrent file idempotency under advisory lock (Finding E)', () => {
      it('returns existing completed receipt and deletes redundant archive upload if file was completed concurrently', async () => {
        const state = defaultState();
        const existingBatchId = '00000000-0000-0000-0000-000000000888';
        let batchQueryCount = 0;

        const mockStorage = {
          put: vi.fn().mockResolvedValue(undefined),
          delete: vi.fn().mockResolvedValue(undefined),
        };

        const client = {
          query: vi.fn(async (sql: string, params?: any[]) => {
            const normalizedSql = sql.replace(/\s+/g, ' ').trim();
            if (
              normalizedSql.startsWith('BEGIN') ||
              normalizedSql.startsWith('COMMIT') ||
              normalizedSql.startsWith('ROLLBACK')
            ) {
              return { rows: [], rowCount: 0 };
            }
            if (
              normalizedSql.includes("set_config('app.actor_id'") ||
              normalizedSql.includes("set_config('app.tenant_id'")
            ) {
              return { rows: [], rowCount: 0 };
            }
            if (
              normalizedSql.includes('SET LOCAL') ||
              normalizedSql.includes('pg_advisory_xact_lock')
            ) {
              return { rows: [], rowCount: 0 };
            }
            if (normalizedSql.includes('FROM app_private.system_gates')) {
              return { rows: [{ is_active: false }], rowCount: 1 };
            }
            if (normalizedSql.includes('FROM app_private.order_data_deletion_gates')) {
              return { rows: [{ deletion_epoch: 0 }], rowCount: 1 };
            }
            if (normalizedSql.includes('FROM app_private.staff_membership')) {
              return { rows: [{ permission: 'owner' }], rowCount: 1 };
            }
            if (normalizedSql.includes('FROM app_private.pilot_order_agreement_acceptances')) {
              return { rows: [{ id: '00000000-0000-4000-8000-000000000099' }], rowCount: 1 };
            }
            if (
              normalizedSql.includes('FROM app_private.order_outcome_import_batches') &&
              normalizedSql.includes('file_sha256 = $2')
            ) {
              batchQueryCount++;
              // First query before upload: no batch exists yet
              if (batchQueryCount === 1) {
                return { rows: [], rowCount: 0 };
              }
              // Second query after advisory lock: another concurrent worker completed the import!
              return {
                rows: [
                  {
                    id: existingBatchId,
                    status: 'completed',
                    total_rows: 1,
                    accepted_rows: 1,
                    duplicate_rows: 0,
                    quarantined_rows: 0,
                    conflict_rows: 0,
                    file_sha256: 'mock-sha',
                    created_at: new Date('2026-10-01T00:00:00Z'),
                    finished_at: new Date('2026-10-01T00:01:00Z'),
                  },
                ],
                rowCount: 1,
              };
            }
            return { rows: [], rowCount: 0 };
          }),
        };

        const csv = [
          'schema_version,order_id,order_line_id,ordered_at,pos_item_id,outcome_type,quantity',
          'pilot_order_outcome.v1,ORD-CONC,LINE-1,2026-10-02T12:00:00Z,POS-PIZZA-1,ordered,1',
        ].join('\n');

        const result = await importOrderOutcomes({
          client: client as any,
          actorId,
          venueId,
          csvText: csv,
          storage: mockStorage as any,
          bundleLoader,
          now: () => new Date('2026-10-05T12:00:00Z'),
        });

        expect(result.batchId).toBe(existingBatchId);
        expect(result.status).toBe('completed');
        expect(result.isDuplicateFile).toBe(true);
        // Redundant storage file deleted
        expect(mockStorage.delete).toHaveBeenCalledTimes(1);
      });
    });

    describe('PR #120 Review Fixes Regressions', () => {
      describe('1. Preserve source archive when COMMIT outcome is uncertain', () => {
        it('preserves archive when COMMIT may have succeeded and lost acknowledgement on client', async () => {
          const state = defaultState();
          const client = createMockClient(state);

          const mockPut = vi.fn().mockResolvedValue(undefined);
          const mockDelete = vi.fn().mockResolvedValue(undefined);
          const mockStorage = { put: mockPut, delete: mockDelete };

          const csvText = [
            'schema_version,order_id,order_line_id,ordered_at,menu_revision_id,dish_id,dish_revision_id,outcome_type,quantity',
            `pilot_order_outcome.v1,TICK-1,LINE-1,2026-11-01T12:00:00Z,${menuRevisionId},${dishId},${dishRevisionId},ordered,1`,
          ].join('\n');

          let commitFailedOnClient = false;
          let commitSucceededOnDb = false;
          const originalQuery = client.query;
          client.query = vi.fn(async (sql: string, params?: any[]) => {
            const normalized = sql.trim().toUpperCase();
            if (normalized === 'COMMIT' && !commitFailedOnClient) {
              const batches = [...state.batches.values()];
              if (batches.length > 0 && batches[0]?.status === 'completed') {
                commitFailedOnClient = true;
                // PostgreSQL commits on the server
                await originalQuery(sql, params);
                commitSucceededOnDb = true;
                // Client loses acknowledgement
                throw new Error('Connection terminated unexpectedly during COMMIT acknowledgement');
              }
            }
            return originalQuery(sql, params);
          });

          // 1. Initial attempt fails on lost COMMIT acknowledgement
          await expect(
            importOrderOutcomes({
              client: client as any,
              actorId,
              venueId,
              csvText,
              bundleLoader,
              storage: mockStorage,
              trackingStartedAt: defaultTrackingStartedAt,
              now: () => new Date('2026-11-07T12:00:00Z'),
            }),
          ).rejects.toThrow('Connection terminated unexpectedly during COMMIT acknowledgement');

          // 2. Batch remains completed and facts remain stored
          expect(commitSucceededOnDb).toBe(true);
          const batches = [...state.batches.values()];
          expect(batches).toHaveLength(1);
          expect(batches[0]?.status).toBe('completed');
          expect(batches[0]?.accepted_rows).toBe(1);
          expect(state.lines.size).toBe(1);

          // 3. Source archive is NOT deleted
          expect(mockPut).toHaveBeenCalledTimes(1);
          expect(mockDelete).not.toHaveBeenCalled();

          // 4. Retrying the same file still behaves correctly
          const retryResult = await importOrderOutcomes({
            client: client as any,
            actorId,
            venueId,
            csvText,
            bundleLoader,
            storage: mockStorage,
            trackingStartedAt: defaultTrackingStartedAt,
            now: () => new Date('2026-11-07T12:00:00Z'),
          });

          expect(retryResult.status).toBe('completed');
          expect(retryResult.isDuplicateFile).toBe(true);
          expect(retryResult.batchId).toBe(batches[0]?.id);
          expect(mockDelete).not.toHaveBeenCalled();
        });
      });

      describe('2. Select publication state using highest stream version', () => {
        it('selects highest version when transaction timestamps are inverted so v2 withdrawal remains authoritative', async () => {
          const state = defaultState();
          // v1 published has later timestamp (2026-10-05) due to transaction timestamp inversion
          // v2 withdrawn has earlier timestamp (2026-10-01) but higher version
          state.publicationEvents = [
            {
              menuId: '00000000-0000-0000-0000-000000000001',
              menuRevisionId,
              eventType: 'menu.published',
              occurredAt: new Date('2026-10-05T00:00:00Z'),
              version: 1,
            },
            {
              menuId: '00000000-0000-0000-0000-000000000001',
              menuRevisionId,
              eventType: 'menu.withdrawn',
              occurredAt: new Date('2026-10-01T00:00:00Z'),
              version: 2,
            },
          ];
          const client = createMockClient(state);

          // Order occurs after both events (2026-10-10)
          const csv = [
            'schema_version,order_id,order_line_id,ordered_at,pos_item_id,outcome_type,quantity',
            'pilot_order_outcome.v1,ORD-INVERTED-TS,LINE-1,2026-10-10T12:00:00Z,POS-PIZZA-1,ordered,1',
          ].join('\n');

          const result = await importOrderOutcomes({
            client: client as any,
            actorId,
            venueId,
            csvText: csv,
            bundleLoader,
            now: () => new Date('2026-10-15T12:00:00Z'),
          });

          // The v2 withdrawal must remain authoritative despite earlier occurred_at
          expect(result.acceptedRows).toBe(0);
          expect(result.quarantinedRows).toBe(1);
          expect(result.diagnostics[0]?.reasonCode).toBe('out_of_revision_window');
          expect(result.diagnostics[0]?.diagnosticMessage).toMatch(
            /No published menu revision was active at order timestamp/,
          );
        });
      });

      describe('3. Validate revision IDs before PostgreSQL UUID resolution', () => {
        it('quarantines malformed menu_revision_id row without rolling back valid neighboring row', async () => {
          const state = defaultState();
          const client = createMockClient(state);

          const csvText = [
            'schema_version,order_id,order_line_id,ordered_at,menu_revision_id,dish_id,dish_revision_id,outcome_type,quantity',
            `pilot_order_outcome.v1,ORD-VALID,LINE-1,2026-11-01T12:00:00Z,${menuRevisionId},${dishId},${dishRevisionId},ordered,1`,
            `pilot_order_outcome.v1,ORD-MALFORMED,LINE-2,2026-11-01T12:00:00Z,not-a-uuid,${dishId},${dishRevisionId},ordered,1`,
          ].join('\n');

          const result = await importOrderOutcomes({
            client: client as any,
            actorId,
            venueId,
            csvText,
            bundleLoader,
            trackingStartedAt: defaultTrackingStartedAt,
            now: () => new Date('2026-11-07T12:00:00Z'),
          });

          expect(result.status).toBe('completed');
          expect(result.totalRows).toBe(2);
          expect(result.acceptedRows).toBe(1);
          expect(result.quarantinedRows).toBe(1);

          // Valid row stored
          expect(state.lines.has(`${venueId}:ORD-VALID:LINE-1:ordered`)).toBe(true);

          // Malformed row quarantined with row/field/reason and no raw input exposed
          const diag = result.diagnostics.find((d) => d.rowIndex === 3);
          expect(diag).toBeDefined();
          expect(diag?.fieldName).toBe('menu_revision_id');
          expect(diag?.reasonCode).toBe('invalid_format');
          expect(diag?.diagnosticMessage).toBe('menu_revision_id must be a valid canonical UUID');
          expect(diag?.diagnosticMessage).not.toContain('not-a-uuid');
        });
      });

      describe('4. Sanitize and bound quarantine diagnostics', () => {
        it('quarantines sensitive-looking and oversized POS values without leaking raw values or failing transaction', async () => {
          const state = defaultState();
          state.menuApproval!.approvedAt = new Date('2026-10-01T00:00:00Z');
          const client = createMockClient(state);

          const sensitivePosId = 'manager@restaurant.com';
          const oversizedPosId = 'A'.repeat(600);

          const csv = [
            'schema_version,order_id,order_line_id,ordered_at,pos_item_id,outcome_type,quantity',
            'pilot_order_outcome.v1,ORD-VALID,LINE-1,2026-11-05T12:00:00Z,POS-PIZZA-1,ordered,1',
            `pilot_order_outcome.v1,ORD-SENSITIVE,LINE-2,2026-11-05T12:00:00Z,${sensitivePosId},ordered,1`,
            `pilot_order_outcome.v1,ORD-OVERSIZED,LINE-3,2026-11-05T12:00:00Z,${oversizedPosId},ordered,1`,
          ].join('\n');

          const result = await importOrderOutcomes({
            client: client as any,
            actorId,
            venueId,
            csvText: csv,
            bundleLoader,
            trackingStartedAt: '2026-10-01T00:00:00Z',
            now: () => new Date('2026-11-07T12:00:00Z'),
          });

          expect(result.status).toBe('completed');
          expect(result.totalRows).toBe(3);
          expect(result.acceptedRows).toBe(1);
          expect(result.quarantinedRows).toBe(2);

          // Valid neighboring row accepted
          expect(state.lines.has(`${venueId}:ORD-VALID:LINE-1:ordered`)).toBe(true);

          // Diagnostics check
          expect(result.diagnostics).toHaveLength(2);
          for (const diag of result.diagnostics) {
            expect(diag.fieldName).toBe('pos_item_id');
            expect(diag.diagnosticMessage.length).toBeLessThanOrEqual(500);
            expect(diag.diagnosticMessage).not.toContain(sensitivePosId);
            expect(diag.diagnosticMessage).not.toContain('@');
            expect(diag.diagnosticMessage).not.toContain(oversizedPosId);
          }

          // Entire serialized response contains no sensitive or oversized raw input
          const serialized = JSON.stringify(result);
          expect(serialized).not.toContain(sensitivePosId);
          expect(serialized).not.toContain(oversizedPosId);

          // Quarantine table check
          expect(state.quarantine).toHaveLength(2);
          for (const row of state.quarantine) {
            expect(row.diagnostic_message.length).toBeLessThanOrEqual(500);
            expect(row.diagnostic_message).not.toContain(sensitivePosId);
            expect(row.diagnostic_message).not.toContain(oversizedPosId);
          }
        });
      });
    });

    describe('S6-DATA-14.1 Agreement Acceptance Enforcement', () => {
      const venueId = '00000000-0000-4000-8000-000000000810';
      const otherVenueId = '00000000-0000-4000-8000-000000000811';
      const ownerId = '00000000-0000-4000-8000-000000000010';
      const menuRevisionId = '00000000-0000-4000-8000-000000000910';
      const dishId = '11111111-1111-4000-8000-000000000910';
      const dishRevisionId = '22222222-2222-4000-8000-000000000910';

      const validCsv = [
        'schema_version,order_id,order_line_id,ordered_at,menu_revision_id,dish_id,dish_revision_id,outcome_type,quantity',
        `${PILOT_ORDER_OUTCOME_SCHEMA_VERSION},ORD-1,LINE-1,2026-11-10T12:00:00Z,${menuRevisionId},${dishId},${dishRevisionId},ordered,1`,
      ].join('\n');

      function makeState(overrides?: Partial<MockDbState>): MockDbState {
        return {
          venueId,
          actorId: ownerId,
          permission: 'owner',
          menuApproval: {
            menuRevisionId,
            approvedAt: new Date('2026-11-01T00:00:00Z'),
            bundleUrl: 'https://assets.peekaplate.example/menu.json',
            contentHash: 'hash',
          },
          bundleContent: {
            schema_version: 1,
            venue_id: venueId,
            menu_id: '00000000-0000-0000-0000-000000000001',
            menu_revision_id: menuRevisionId,
            restaurant: { name: 'Pilot Bistro', logo: null },
            categories: [
              {
                category_id: '00000000-0000-4000-8000-000000000002',
                name: 'Mains',
                dishes: [
                  {
                    dish_id: dishId,
                    dish_revision_id: dishRevisionId,
                    complete: true,
                    name: 'Dish',
                    description: 'Desc',
                    price: { amount: '12.00', currency: 'USD' },
                    ingredients: [],
                    allergens: null,
                    dietary: [],
                    images: {
                      card: {
                        url: 'https://cdn.example.com/c.jpg',
                        width: 400,
                        height: 300,
                        alt: 'c',
                      },
                      detail: {
                        url: 'https://cdn.example.com/d.jpg',
                        width: 800,
                        height: 600,
                        alt: 'd',
                      },
                    },
                  },
                ],
              },
            ],
          },
          posDishMappings: new Map(),
          venueTrackingActivations: new Map([
            [venueId, { tenant_id: venueId, activated_at: new Date('2026-11-01T00:00:00Z') }],
          ]),
          batches: new Map(),
          lines: new Map(),
          quarantine: [],
          conflicts: [],
          agreementAcceptances: new Map(),
          ...overrides,
        };
      }

      it('rejects import with 403 agreement_not_accepted when venue has no acceptance', async () => {
        const state = makeState();
        const client = createMockClient(state) as any;

        await expect(
          importOrderOutcomes({
            client,
            actorId: ownerId,
            venueId,
            csvText: validCsv,
            now: () => new Date('2026-11-12T12:00:00Z'),
            bundleLoader: async () => state.bundleContent!,
          }),
        ).rejects.toMatchObject({ code: 'agreement_not_accepted', status: 403 });
      });

      it('rejects import when acceptance exists only for a different venue', async () => {
        const state = makeState({
          agreementAcceptances: new Map([
            [
              `${otherVenueId}:${PILOT_ORDER_AGREEMENT_VERSION}`,
              {
                id: '00000000-0000-4000-8000-000000000001',
                tenant_id: otherVenueId,
                agreement_version: PILOT_ORDER_AGREEMENT_VERSION,
                accepted_by: ownerId,
                accepted_at: new Date('2026-11-12T00:00:00Z'),
              },
            ],
          ]),
        });
        const client = createMockClient(state) as any;

        await expect(
          importOrderOutcomes({
            client,
            actorId: ownerId,
            venueId,
            csvText: validCsv,
            now: () => new Date('2026-11-12T12:00:00Z'),
            bundleLoader: async () => state.bundleContent!,
          }),
        ).rejects.toMatchObject({ code: 'agreement_not_accepted', status: 403 });
      });

      it('rejects non-owner trying to accept the agreement', async () => {
        const state = makeState({ permission: 'editor' });
        const client = createMockClient(state) as any;

        await expect(
          acceptPilotOrderAgreement({
            client,
            actorId: ownerId,
            venueId,
            agreementVersion: PILOT_ORDER_AGREEMENT_VERSION,
          }),
        ).rejects.toMatchObject({ code: 'forbidden', status: 403 });
      });

      it('rejects invalid/mismatched agreement version on acceptance', async () => {
        const state = makeState();
        const client = createMockClient(state) as any;

        await expect(
          acceptPilotOrderAgreement({
            client,
            actorId: ownerId,
            venueId,
            agreementVersion: 'v99.0',
          }),
        ).rejects.toMatchObject({ code: 'invalid_agreement_version', status: 400 });
      });

      it('allows import after owner accepts current version and rejects when required version changes', async () => {
        const state = makeState();
        const client = createMockClient(state) as any;

        const first = await acceptPilotOrderAgreement({
          client,
          actorId: ownerId,
          venueId,
          agreementVersion: PILOT_ORDER_AGREEMENT_VERSION,
        });
        expect(first.alreadyAccepted).toBe(false);
        expect(first.agreementVersion).toBe(PILOT_ORDER_AGREEMENT_VERSION);

        const second = await acceptPilotOrderAgreement({
          client,
          actorId: ownerId,
          venueId,
          agreementVersion: PILOT_ORDER_AGREEMENT_VERSION,
        });
        expect(second.alreadyAccepted).toBe(true);

        const imported = await importOrderOutcomes({
          client,
          actorId: ownerId,
          venueId,
          csvText: validCsv,
          trackingStartedAt: new Date('2026-11-01T00:00:00Z'),
          now: () => new Date('2026-11-12T12:00:00Z'),
          bundleLoader: async () => state.bundleContent!,
        });
        expect(imported.status).toBe('completed');
        expect(imported.totalRows).toBe(1);

        // Changed agreement version requires fresh acceptance
        await expect(
          importOrderOutcomes({
            client,
            actorId: ownerId,
            venueId,
            csvText: validCsv,
            agreementVersion: 'v0.2',
            now: () => new Date('2026-11-12T12:00:00Z'),
            bundleLoader: async () => state.bundleContent!,
          }),
        ).rejects.toMatchObject({ code: 'agreement_not_accepted', status: 403 });
      });
    });

    describe('S6-DATA-14.2 Owner-Scoped Order-Data Deletion', () => {
      const venueId = '00000000-0000-4000-8000-000000000820';
      const otherVenueId = '00000000-0000-4000-8000-000000000821';
      const ownerId = '00000000-0000-4000-8000-000000000020';
      const requestId = '33333333-3333-4000-8000-000000000020';

      function makeDeletionFixture(overrides?: Partial<MockDbState>) {
        const r2Objects = new Map<string, string>([
          [`order-imports/${venueId}/batch-1/source.csv`, 'secret-order-csv-content'],
          [`order-imports/${otherVenueId}/batch-2/source.csv`, 'other-venue-csv'],
        ]);

        const state: MockDbState = {
          venueId,
          actorId: ownerId,
          permission: 'owner',
          posDishMappings: new Map([
            [`${venueId}:POS-1`, { pos_item_code: 'POS-1', review_status: 'approved' }],
          ]),
          batches: new Map([
            [
              'batch-1',
              {
                id: 'batch-1',
                tenant_id: venueId,
                storage_key: `order-imports/${venueId}/batch-1/source.csv`,
              },
            ],
            [
              'batch-2',
              {
                id: 'batch-2',
                tenant_id: otherVenueId,
                storage_key: `order-imports/${otherVenueId}/batch-2/source.csv`,
              },
            ],
          ]),
          lines: new Map([
            [`${venueId}:ORD-1:LINE-1:ordered`, { tenant_id: venueId, order_id: 'ORD-1' }],
            [
              `${otherVenueId}:ORD-2:LINE-1:ordered`,
              { tenant_id: otherVenueId, order_id: 'ORD-2' },
            ],
          ]),
          quarantine: [
            { tenant_id: venueId, batch_id: 'batch-1', diagnostic_message: 'too_old' },
            { tenant_id: otherVenueId, batch_id: 'batch-2', diagnostic_message: 'too_old' },
          ],
          conflicts: [
            { tenant_id: venueId, batch_id: 'batch-1', order_id: 'ORD-1' },
            { tenant_id: otherVenueId, batch_id: 'batch-2', order_id: 'ORD-2' },
          ],
          deletionRequests: new Map(),
          ...overrides,
        };

        const operatorId = '00000000-0000-4000-8000-000000000099';
        const authorizedOperatorIds = new Set([operatorId]);

        const storage = {
          put: vi.fn(
            async (
              key: string,
              value: string,
              opts?: { onlyIf?: { etagDoesNotMatch?: string } },
            ) => {
              if (opts?.onlyIf?.etagDoesNotMatch === '*' && r2Objects.has(key)) {
                return null;
              }
              r2Objects.set(key, value);
              return { key };
            },
          ),
          list: vi.fn(async (opts?: { prefix?: string }) => ({
            objects: [...r2Objects.keys()]
              .filter((k) => !opts?.prefix || k.startsWith(opts.prefix))
              .map((key) => ({ key, uploaded: new Date('2026-11-12T00:00:00Z') })),
            truncated: false,
          })),
          delete: vi.fn(async (key: string) => {
            r2Objects.delete(key);
          }),
        };

        return { state, r2Objects, storage, operatorId, authorizedOperatorIds };
      }

      it('submits owner deletion request, blocks new imports while active, and executes operator deletion with R2 ledger', async () => {
        const { state, r2Objects, storage, operatorId, authorizedOperatorIds } =
          makeDeletionFixture();
        const client = createMockClient(state) as any;

        const submitted = await submitOrderDataDeletionRequest({
          client,
          actorId: ownerId,
          venueId,
          requestId,
          reason: 'pilot_withdrawal',
        });
        expect(submitted.status).toBe('requested');
        expect(submitted.alreadyExists).toBe(false);

        // Idempotent submission returns alreadyExists: true
        const submittedAgain = await submitOrderDataDeletionRequest({
          client,
          actorId: ownerId,
          venueId,
          requestId,
          reason: 'pilot_withdrawal',
        });
        expect(submittedAgain.alreadyExists).toBe(true);

        // New imports are blocked while deletion request is active
        await expect(
          importOrderOutcomes({
            client,
            actorId: ownerId,
            venueId,
            csvText:
              'schema_version,order_id,order_line_id,ordered_at,pos_item_id,outcome_type,quantity\npilot_order_outcome.v1,ORD-NEW,LINE-1,2026-11-12T12:00:00Z,POS-1,ordered,1',
            now: () => new Date('2026-11-12T12:00:00Z'),
            bundleLoader: async () => state.bundleContent!,
          }),
        ).rejects.toMatchObject({ code: 'deletion_in_progress', status: 409 });

        const res = await deleteVenueOrderData({
          client,
          operatorId,
          venueId,
          requestId,
          storage,
          authorizedOperatorIds,
        });

        expect(res.status).toBe('awaiting_verification');
        expect(res.operatorId).toBe(operatorId);
        expect(res.alreadyCompleted).toBe(false);
        expect(res.r2ObjectsDeleted).toBe(1);
        expect(res.dbBatchesDeleted).toBe(1);
        expect(res.dbLinesDeleted).toBe(1);
        expect(res.dbQuarantineDeleted).toBe(1);
        expect(res.dbConflictsDeleted).toBe(1);

        // Target venue data removed
        expect(r2Objects.has(`order-imports/${venueId}/batch-1/source.csv`)).toBe(false);
        expect(state.batches.has('batch-1')).toBe(false);
        expect(state.lines.has(`${venueId}:ORD-1:LINE-1:ordered`)).toBe(false);
        expect(state.quarantine.filter((q) => q.tenant_id === venueId)).toHaveLength(0);
        expect(state.conflicts.filter((c) => c.tenant_id === venueId)).toHaveLength(0);

        // Other venue & POS mappings untouched
        expect(r2Objects.has(`order-imports/${otherVenueId}/batch-2/source.csv`)).toBe(true);
        expect(state.batches.has('batch-2')).toBe(true);
        expect(state.lines.has(`${otherVenueId}:ORD-2:LINE-1:ordered`)).toBe(true);
        expect(state.posDishMappings.has(`${venueId}:POS-1`)).toBe(true);

        // Non-PII R2 deletion intent & completion ledger receipts written as separate immutable objects
        const intentRaw = r2Objects.get(
          `order-deletion-ledger/${venueId}/${requestId}/intent.json`,
        );
        const completedRaw = r2Objects.get(
          `order-deletion-ledger/${venueId}/${requestId}/completed.json`,
        );
        expect(intentRaw).toBeDefined();
        expect(completedRaw).toBeDefined();
        expect(JSON.parse(intentRaw!).status).toBe('in_progress');
        expect(JSON.parse(completedRaw!).status).toBe('completed');
        expect(intentRaw).not.toContain('secret-order-csv-content');
        expect(completedRaw).not.toContain('secret-order-csv-content');
        expect(completedRaw).not.toContain('ORD-1');

        // Audit record contains no order contents
        const audit = state.deletionRequests!.get(`${venueId}:${requestId}`);
        expect(audit.status).toBe('awaiting_verification');
        expect(audit.executed_by).toBe(operatorId);
        expect(JSON.stringify(audit)).not.toContain('secret-order-csv-content');
        expect(JSON.stringify(audit)).not.toContain('ORD-1');
      });

      it('denies unauthorized requester, cross-tenant submission, missing request, and unauthorized operator', async () => {
        const { state, r2Objects, storage, operatorId, authorizedOperatorIds } =
          makeDeletionFixture({ permission: 'editor' });
        const client = createMockClient(state) as any;

        await expect(
          submitOrderDataDeletionRequest({
            client,
            actorId: ownerId,
            venueId,
            requestId,
          }),
        ).rejects.toMatchObject({ code: 'forbidden', status: 403 });

        expect(r2Objects.has(`order-imports/${venueId}/batch-1/source.csv`)).toBe(true);

        // Cross-tenant submission attempt (wrong venueId for actor)
        state.permission = 'owner';
        await expect(
          submitOrderDataDeletionRequest({
            client,
            actorId: ownerId,
            venueId: otherVenueId,
            requestId,
          }),
        ).rejects.toMatchObject({ code: 'forbidden', status: 403 });
        expect(r2Objects.has(`order-imports/${otherVenueId}/batch-2/source.csv`)).toBe(true);

        // Operator cannot execute without an existing owner-submitted request
        await expect(
          deleteVenueOrderData({
            client,
            operatorId,
            venueId,
            requestId,
            storage,
            authorizedOperatorIds,
          }),
        ).rejects.toMatchObject({ code: 'deletion_request_not_found', status: 404 });

        // Unauthorized operator cannot execute deletion
        await expect(
          deleteVenueOrderData({
            client,
            operatorId: ownerId,
            venueId,
            requestId,
            storage,
            authorizedOperatorIds,
          }),
        ).rejects.toMatchObject({ code: 'forbidden', status: 403 });

        // Empty or missing authorizedOperatorIds fails closed
        await expect(
          deleteVenueOrderData({
            client,
            operatorId,
            venueId,
            requestId,
            storage,
            authorizedOperatorIds: new Set(),
          }),
        ).rejects.toMatchObject({ code: 'forbidden', status: 403 });

        await expect(
          deleteVenueOrderData({
            client,
            operatorId,
            venueId,
            requestId,
            storage,
            authorizedOperatorIds: undefined as any,
          }),
        ).rejects.toMatchObject({ code: 'forbidden', status: 403 });
      });

      it('records durable in_progress ledger intent before destructive operations and upgrades on retry after crash', async () => {
        const { state, r2Objects, storage, operatorId, authorizedOperatorIds } =
          makeDeletionFixture();
        const client = createMockClient(state) as any;

        await submitOrderDataDeletionRequest({
          client,
          actorId: ownerId,
          venueId,
          requestId,
          reason: 'pilot_withdrawal',
        });

        // 1. If recording the pre-deletion intent fails, zero R2 or DB deletions occur
        storage.put = vi.fn().mockRejectedValueOnce(new Error('R2 intent write failed'));
        await expect(
          deleteVenueOrderData({
            client,
            operatorId,
            venueId,
            requestId,
            storage,
            authorizedOperatorIds,
          }),
        ).rejects.toMatchObject({ code: 'deletion_storage_failed', status: 502 });
        expect(r2Objects.has(`order-imports/${venueId}/batch-1/source.csv`)).toBe(true);
        expect(state.batches.has('batch-1')).toBe(true);

        // 2. If process/R2 fails at Phase 4 after DB commit, in_progress intent remains in R2 and retry upgrades it to completed
        let putCount = 0;
        storage.put = vi.fn(async (key: string, value: string) => {
          putCount++;
          if (putCount === 2) {
            throw new Error('Simulated crash before Phase 4 ledger finalization');
          }
          r2Objects.set(key, value);
          return { key };
        });

        await expect(
          deleteVenueOrderData({
            client,
            operatorId,
            venueId,
            requestId,
            storage,
            authorizedOperatorIds,
          }),
        ).rejects.toMatchObject({ code: 'deletion_storage_failed', status: 502 });
        expect(state.deletionRequests!.get(`${venueId}:${requestId}`).status).toBe('db_deleted');
        const intentKey = `order-deletion-ledger/${venueId}/${requestId}/intent.json`;
        const completedKey = `order-deletion-ledger/${venueId}/${requestId}/completed.json`;
        const originalIntentRaw = r2Objects.get(intentKey)!;
        expect(JSON.parse(originalIntentRaw).status).toBe('in_progress');
        expect(r2Objects.get(completedKey)).toBeUndefined();

        // Retrying from db_deleted writes missing completed.json without re-running destructive work
        storage.put = vi.fn(async (key: string, value: string) => {
          r2Objects.set(key, value);
          return { key };
        });
        const retried = await deleteVenueOrderData({
          client,
          operatorId,
          venueId,
          requestId,
          storage,
          authorizedOperatorIds,
        });
        expect(retried.status).toBe('awaiting_verification');
        expect(retried.alreadyCompleted).toBe(false);
        expect(r2Objects.get(intentKey)).toBe(originalIntentRaw);
        const completedAfterRetry = JSON.parse(r2Objects.get(completedKey)!);
        expect(completedAfterRetry.status).toBe('completed');
        expect(completedAfterRetry.operatorId).toBe(operatorId);
      });

      it('is idempotent on retry with the same requestId', async () => {
        const { state, storage, operatorId, authorizedOperatorIds } = makeDeletionFixture();
        const client = createMockClient(state) as any;

        await submitOrderDataDeletionRequest({
          client,
          actorId: ownerId,
          venueId,
          requestId,
        });

        const first = await deleteVenueOrderData({
          client,
          operatorId,
          venueId,
          requestId,
          storage,
          authorizedOperatorIds,
        });
        expect(first.alreadyCompleted).toBe(false);

        const retry = await deleteVenueOrderData({
          client,
          operatorId,
          venueId,
          requestId,
          storage,
          authorizedOperatorIds,
        });
        expect(retry.alreadyCompleted).toBe(true);
        expect(retry.operatorId).toBe(operatorId);
        expect(retry.r2ObjectsDeleted).toBe(1);
        expect(retry.dbBatchesDeleted).toBe(1);
      });

      it('preserves DB batch metadata on R2 failure and succeeds on retry', async () => {
        const { state, storage, operatorId, authorizedOperatorIds } = makeDeletionFixture();
        let failOnce = true;
        storage.delete = vi.fn(async () => {
          if (failOnce) {
            failOnce = false;
            throw new Error('R2 transient failure');
          }
        });
        const client = createMockClient(state) as any;

        await submitOrderDataDeletionRequest({
          client,
          actorId: ownerId,
          venueId,
          requestId,
        });

        await expect(
          deleteVenueOrderData({
            client,
            operatorId,
            venueId,
            requestId,
            storage,
            authorizedOperatorIds,
          }),
        ).rejects.toMatchObject({ code: 'deletion_storage_failed', status: 502 });

        // DB records preserved on R2 failure so retry can still find all storage keys
        expect(state.batches.has('batch-1')).toBe(true);
        expect(state.deletionRequests!.get(`${venueId}:${requestId}`).status).toBe('failed');

        // Retry succeeds cleanly
        const retried = await deleteVenueOrderData({
          client,
          operatorId,
          venueId,
          requestId,
          storage,
          authorizedOperatorIds,
        });
        expect(retried.status).toBe('awaiting_verification');
        expect(state.batches.has('batch-1')).toBe(false);
      });

      it('records failure on DB deletion error and succeeds on retry', async () => {
        const { state, storage, operatorId, authorizedOperatorIds } = makeDeletionFixture({
          simulateDbDeletionFailure: true,
        });
        const client = createMockClient(state) as any;

        await submitOrderDataDeletionRequest({
          client,
          actorId: ownerId,
          venueId,
          requestId,
        });

        await expect(
          deleteVenueOrderData({
            client,
            operatorId,
            venueId,
            requestId,
            storage,
            authorizedOperatorIds,
          }),
        ).rejects.toMatchObject({ code: 'deletion_db_failed', status: 500 });

        expect(state.deletionRequests!.get(`${venueId}:${requestId}`).status).toBe('failed');

        state.simulateDbDeletionFailure = false;
        const retried = await deleteVenueOrderData({
          client,
          operatorId,
          venueId,
          requestId,
          storage,
          authorizedOperatorIds,
        });
        expect(retried.status).toBe('awaiting_verification');
        expect(retried.dbBatchesDeleted).toBe(1);
      });

      it('fails closed with 503 when archive storage is unavailable', async () => {
        const { state, operatorId, authorizedOperatorIds } = makeDeletionFixture();
        const client = createMockClient(state) as any;

        await expect(
          deleteVenueOrderData({
            client,
            operatorId,
            venueId,
            requestId,
            storage: undefined,
            authorizedOperatorIds,
          }),
        ).rejects.toMatchObject({ code: 'storage_unavailable', status: 503 });
      });

      it('fences in-flight import via deletion_epoch even if deletion reaches verified before Tx 2, and cleans up uploaded R2 CSV', async () => {
        const { state, r2Objects, storage, operatorId, authorizedOperatorIds } =
          makeDeletionFixture();
        const checkerId = '00000000-0000-4000-8000-000000000777';
        const authorizedCheckerIds = new Set([checkerId]);
        const client = createMockClient(state) as any;

        const verificationStorage: OrderDeletionVerificationStorage = {
          list: storage.list!,
          get: async (key: string) => {
            const val = r2Objects.get(key);
            if (!val) return null;
            return { text: async () => val, json: async () => JSON.parse(val) };
          },
        };

        // Intercept storage.put during import so deletion submits, executes, and verifies while import is between Tx 1 and Tx 2
        const origPut = storage.put;
        let deletionTriggered = false;
        storage.put = vi.fn(async (key: string, value: string, opts?: any) => {
          const res = await origPut(key, value, opts);
          if (!deletionTriggered && key.startsWith(`order-imports/${venueId}/`)) {
            deletionTriggered = true;
            await submitOrderDataDeletionRequest({
              client,
              actorId: ownerId,
              venueId,
              requestId,
            });
            await deleteVenueOrderData({
              client,
              operatorId,
              venueId,
              requestId,
              storage: { ...storage, put: origPut },
              authorizedOperatorIds,
            });
            await verifyVenueOrderDeletion({
              client,
              checkerId,
              venueId,
              requestId,
              outcome: 'PASS',
              evidenceRef: 'clickup:task-1',
              verificationStorage,
              authorizedCheckerIds,
            });
          }
          return res;
        });

        await expect(
          importOrderOutcomes({
            client,
            actorId: ownerId,
            venueId,
            csvText:
              'schema_version,order_id,order_line_id,ordered_at,pos_item_id,outcome_type,quantity\npilot_order_outcome.v1,ORD-RACE,LINE-1,2026-11-12T12:00:00Z,POS-1,ordered,1',
            storage,
            now: () => new Date('2026-11-12T12:00:00Z'),
            bundleLoader: async () => state.bundleContent!,
          }),
        ).rejects.toMatchObject({ code: 'deletion_in_progress', status: 409 });

        // Uploaded CSV was cleaned up by compensating delete and no new batch was committed
        const remainingVenueCsvs = [...r2Objects.keys()].filter((k) =>
          k.startsWith(`order-imports/${venueId}/`),
        );
        expect(remainingVenueCsvs).toHaveLength(0);
      });

      it('blocks imports during global restore freeze and when system_gates is unreadable', async () => {
        const { state } = makeDeletionFixture();
        state.restoreFreezeActive = true;
        const client = createMockClient(state) as any;

        await expect(
          importOrderOutcomes({
            client,
            actorId: ownerId,
            venueId,
            csvText:
              'schema_version,order_id,order_line_id,ordered_at,pos_item_id,outcome_type,quantity\npilot_order_outcome.v1,ORD-FREEZE,LINE-1,2026-11-12T12:00:00Z,POS-1,ordered,1',
            now: () => new Date('2026-11-12T12:00:00Z'),
            bundleLoader: async () => state.bundleContent!,
          }),
        ).rejects.toMatchObject({ code: 'restore_reconciliation_pending', status: 503 });

        state.restoreFreezeActive = false;
        state.simulateSystemGatesUnreadable = true;
        await expect(
          importOrderOutcomes({
            client,
            actorId: ownerId,
            venueId,
            csvText:
              'schema_version,order_id,order_line_id,ordered_at,pos_item_id,outcome_type,quantity\npilot_order_outcome.v1,ORD-FREEZE2,LINE-1,2026-11-12T12:00:00Z,POS-1,ordered,1',
            now: () => new Date('2026-11-12T12:00:00Z'),
            bundleLoader: async () => state.bundleContent!,
          }),
        ).rejects.toMatchObject({ code: 'restore_reconciliation_pending', status: 503 });
      });

      it('rejects self-approval and unblocks imports only after independent checker PASS verification', async () => {
        const { state, r2Objects, storage, operatorId, authorizedOperatorIds } =
          makeDeletionFixture();
        const checkerId = '00000000-0000-4000-8000-000000000777';
        const authorizedCheckerIds = new Set([ownerId, operatorId, checkerId]);
        const client = createMockClient(state) as any;

        const verificationStorage: OrderDeletionVerificationStorage = {
          list: storage.list!,
          get: async (key: string) => {
            const val = r2Objects.get(key);
            if (!val) return null;
            return { text: async () => val, json: async () => JSON.parse(val) };
          },
        };

        await submitOrderDataDeletionRequest({
          client,
          actorId: ownerId,
          venueId,
          requestId,
        });
        await deleteVenueOrderData({
          client,
          operatorId,
          venueId,
          requestId,
          storage,
          authorizedOperatorIds,
        });

        // Imports remain blocked in awaiting_verification
        await expect(
          importOrderOutcomes({
            client,
            actorId: ownerId,
            venueId,
            csvText:
              'schema_version,order_id,order_line_id,ordered_at,pos_item_id,outcome_type,quantity\npilot_order_outcome.v1,ORD-WAIT,LINE-1,2026-11-12T12:00:00Z,POS-1,ordered,1',
            now: () => new Date('2026-11-12T12:00:00Z'),
            bundleLoader: async () => state.bundleContent!,
          }),
        ).rejects.toMatchObject({ code: 'deletion_in_progress', status: 409 });

        // Self-approval by requester or operator is rejected
        await expect(
          verifyVenueOrderDeletion({
            client,
            checkerId: ownerId,
            venueId,
            requestId,
            outcome: 'PASS',
            evidenceRef: 'clickup:self-1',
            verificationStorage,
            authorizedCheckerIds,
          }),
        ).rejects.toMatchObject({ code: 'forbidden', status: 403 });

        await expect(
          verifyVenueOrderDeletion({
            client,
            checkerId: operatorId,
            venueId,
            requestId,
            outcome: 'PASS',
            evidenceRef: 'clickup:self-2',
            verificationStorage,
            authorizedCheckerIds,
          }),
        ).rejects.toMatchObject({ code: 'forbidden', status: 403 });

        // Independent checker FAIL keeps imports blocked
        const failRes = await verifyVenueOrderDeletion({
          client,
          checkerId,
          venueId,
          requestId,
          outcome: 'FAIL',
          evidenceRef: 'clickup:fail-1',
          verificationStorage,
          authorizedCheckerIds,
        });
        expect(failRes.status).toBe('awaiting_verification');

        // Independent checker PASS transitions to verified and unblocks imports
        const passRes = await verifyVenueOrderDeletion({
          client,
          checkerId,
          venueId,
          requestId,
          outcome: 'PASS',
          evidenceRef: 'clickup:pass-1',
          verificationStorage,
          authorizedCheckerIds,
        });
        expect(passRes.status).toBe('verified');
        expect(passRes.r2RemainingObjectCount).toBe(0);
        expect(passRes.dbRemainingRowCount).toBe(0);

        const importRes = await importOrderOutcomes({
          client,
          actorId: ownerId,
          venueId,
          csvText:
            'schema_version,order_id,order_line_id,ordered_at,pos_item_id,outcome_type,quantity\npilot_order_outcome.v1,ORD-AFTER,LINE-1,2026-11-12T12:00:00Z,POS-1,ordered,1',
          now: () => new Date('2026-11-12T12:00:00Z'),
          bundleLoader: async () => state.bundleContent!,
        });
        expect(importRes.status).toBe('completed');
      });

      it('reconciles completed and intent-only R2 ledger entries after restore, keeping freeze active on anomalies', async () => {
        const operatorId = '00000000-0000-4000-8000-000000000888';
        const authorizedOperatorIds = new Set([operatorId]);
        const targetVenue = venueId;
        const intentOnlyVenue = '00000000-0000-4000-8000-000000000333';
        const controlVenue = otherVenueId;
        const reqCompleted = '00000000-0000-4000-8000-000000000444';
        const reqIntentOnly = '00000000-0000-4000-8000-000000000555';

        const r2Objects = new Map<string, string>([
          [`order-imports/${targetVenue}/b1/source.csv`, 'csv-resurrected'],
          [`order-imports/${controlVenue}/b2/source.csv`, 'csv-control'],
          [
            `order-deletion-ledger/${targetVenue}/${reqCompleted}/intent.json`,
            JSON.stringify({
              requestId: reqCompleted,
              venueId: targetVenue,
              operatorId,
              status: 'in_progress',
              intentRecordedAt: '2026-11-12T00:00:00.000Z',
            }),
          ],
          [
            `order-deletion-ledger/${targetVenue}/${reqCompleted}/completed.json`,
            JSON.stringify({
              requestId: reqCompleted,
              venueId: targetVenue,
              operatorId,
              status: 'completed',
              r2ObjectsDeleted: 1,
              dbBatchesDeleted: 1,
              dbLinesDeleted: 1,
              dbQuarantineDeleted: 0,
              dbConflictsDeleted: 0,
              completedAt: '2026-11-12T00:01:00.000Z',
            }),
          ],
          [
            `order-deletion-ledger/${intentOnlyVenue}/${reqIntentOnly}/intent.json`,
            JSON.stringify({
              requestId: reqIntentOnly,
              venueId: intentOnlyVenue,
              operatorId,
              status: 'in_progress',
              intentRecordedAt: '2026-11-12T00:02:00.000Z',
            }),
          ],
        ]);

        let freezeActive = false;
        const reconciledCalls: string[] = [];
        const mockClient = {
          query: vi.fn(async (sql: string, params?: any[]) => {
            const s = sql.replace(/\s+/g, ' ').trim();
            if (s.includes('UPDATE app_private.system_gates') && s.includes('is_active = true')) {
              freezeActive = true;
              return { rows: [], rowCount: 1 };
            }
            if (s.includes('UPDATE app_private.system_gates') && s.includes('is_active = false')) {
              freezeActive = false;
              return { rows: [], rowCount: 1 };
            }
            if (s.includes('FROM app_private.reconcile_venue_order_deletion')) {
              reconciledCalls.push(`${params![1]}:${params![2]}:${params![6]}`);
              return {
                rows: [
                  {
                    batches_deleted: params![6] === 'completed' ? 1 : 0,
                    lines_deleted: params![6] === 'completed' ? 1 : 0,
                    quarantine_deleted: 0,
                    conflicts_deleted: 0,
                  },
                ],
                rowCount: 1,
              };
            }
            return { rows: [], rowCount: 0 };
          }),
        } as any;

        const verificationStorage: OrderDeletionVerificationStorage = {
          list: async (opts) => {
            const prefix = opts?.prefix ?? '';
            const objects = [...r2Objects.keys()]
              .filter((k) => k.startsWith(prefix))
              .map((key) => ({ key, uploaded: new Date('2026-11-12T00:00:00Z') }));
            return { objects, truncated: false };
          },
          get: async (key: string) => {
            const val = r2Objects.get(key);
            if (!val) return null;
            return { text: async () => val, json: async () => JSON.parse(val) };
          },
        };

        const storage = {
          list: verificationStorage.list,
          put: async (key: string, value: string) => {
            r2Objects.set(key, value);
            return { key };
          },
          delete: async (key: string) => {
            r2Objects.delete(key);
          },
        };

        const res = await reconcileOrderDeletionsAfterRestore({
          client: mockClient,
          operatorId,
          authorizedOperatorIds,
          verificationStorage,
          storage,
        });

        expect(res.status).toBe('completed');
        expect(res.freezeLifted).toBe(true);
        expect(freezeActive).toBe(false);
        expect(res.reconciledCount).toBe(1);
        expect(res.blockedIntentOnlyCount).toBe(1);
        expect(r2Objects.has(`order-imports/${targetVenue}/b1/source.csv`)).toBe(false);
        expect(r2Objects.has(`order-imports/${controlVenue}/b2/source.csv`)).toBe(true);
        expect(
          r2Objects.has(`order-deletion-ledger/${targetVenue}/${reqCompleted}/reconciled.json`),
        ).toBe(true);
        expect(reconciledCalls).toEqual([
          `${targetVenue}:${reqCompleted}:completed`,
          `${intentOnlyVenue}:${reqIntentOnly}:intent_only`,
        ]);

        // Malformed ledger entry keeps global freeze active
        r2Objects.set(
          `order-deletion-ledger/${targetVenue}/00000000-0000-4000-8000-000000000666/intent.json`,
          '{not-valid-json',
        );
        const failRes = await reconcileOrderDeletionsAfterRestore({
          client: mockClient,
          operatorId,
          authorizedOperatorIds,
          verificationStorage,
          storage,
        });
        expect(failRes.status).toBe('failed');
        expect(failRes.freezeLifted).toBe(false);
        expect(freezeActive).toBe(true);
        expect(failRes.anomalyCount).toBe(1);
      });

      it('detects missing_in_r2, operator/timestamp conflicts, fail-closed cursors, and missing gate row (H2/M1)', async () => {
        const operatorId = '00000000-0000-4000-8000-000000000099';
        const otherOperatorId = '00000000-0000-4000-8000-000000000088';
        const authorizedOperatorIds = new Set([operatorId, otherOperatorId]);
        const venueId = '00000000-0000-4000-8000-000000000801';
        const reqMismatch = '00000000-0000-4000-8000-000000000301';
        const reqMissingInR2 = '00000000-0000-4000-8000-000000000302';

        const r2Objects = new Map<string, string>([
          [
            `order-deletion-ledger/${venueId}/${reqMismatch}/intent.json`,
            JSON.stringify({
              requestId: reqMismatch,
              venueId,
              operatorId,
              status: 'in_progress',
              intentRecordedAt: '2026-11-14T02:00:00.000Z',
            }),
          ],
          [
            `order-deletion-ledger/${venueId}/${reqMismatch}/completed.json`,
            JSON.stringify({
              requestId: reqMismatch,
              venueId,
              operatorId: otherOperatorId,
              status: 'completed',
              r2ObjectsDeleted: 0,
              dbBatchesDeleted: 0,
              dbLinesDeleted: 0,
              dbQuarantineDeleted: 0,
              dbConflictsDeleted: 0,
              completedAt: '2026-11-14T01:00:00.000Z',
            }),
          ],
        ]);

        const reconciledCalls: string[] = [];
        let gateRowCount = 1;
        const mockClient = {
          query: vi.fn(async (sql: string, params?: unknown[]) => {
            const s = sql.trim();
            if (s.includes('UPDATE app_private.system_gates')) {
              return { rows: [], rowCount: gateRowCount };
            }
            if (s.includes('list_order_deletion_requests_for_reconcile')) {
              return {
                rows: [
                  {
                    tenant_id: venueId,
                    id: reqMissingInR2,
                    status: 'verified',
                    executed_by: operatorId,
                    completed_at: '2026-11-14T01:30:00.000Z',
                  },
                ],
                rowCount: 1,
              };
            }
            if (s.includes('FROM app_private.reconcile_venue_order_deletion')) {
              reconciledCalls.push(`${params![1]}:${params![2]}:${params![6]}`);
              return {
                rows: [
                  {
                    batches_deleted: 0,
                    lines_deleted: 0,
                    quarantine_deleted: 0,
                    conflicts_deleted: 0,
                  },
                ],
                rowCount: 1,
              };
            }
            return { rows: [], rowCount: 0 };
          }),
        } as any;

        const verificationStorage: OrderDeletionVerificationStorage = {
          list: async (opts) => {
            const prefix = opts?.prefix ?? '';
            const objects = [...r2Objects.keys()]
              .filter((k) => k.startsWith(prefix))
              .map((key) => ({ key, uploaded: new Date('2026-11-14T00:00:00Z') }));
            return { objects, truncated: false };
          },
          get: async (key: string) => {
            const val = r2Objects.get(key);
            if (!val) return null;
            return { text: async () => val, json: async () => JSON.parse(val) };
          },
        };

        const storage = {
          list: verificationStorage.list,
          put: async (key: string, value: string) => {
            r2Objects.set(key, value);
            return { key };
          },
          delete: async (key: string) => {
            r2Objects.delete(key);
          },
        };

        const res = await reconcileOrderDeletionsAfterRestore({
          client: mockClient,
          operatorId,
          authorizedOperatorIds,
          verificationStorage,
          storage,
        });

        expect(res.status).toBe('failed');
        expect(res.freezeLifted).toBe(false);
        expect(res.anomalyCount).toBe(2);
        expect(
          res.entries.some((e) => e.requestId === reqMismatch && e.ledgerStatus === 'malformed'),
        ).toBe(true);
        expect(
          res.entries.some(
            (e) => e.requestId === reqMissingInR2 && e.ledgerStatus === 'missing_in_r2',
          ),
        ).toBe(true);
        expect(reconciledCalls).toContain(`${venueId}:${reqMissingInR2}:missing_in_r2`);

        // Fail-closed when verificationStorage.list is truncated without cursor
        await expect(
          reconcileOrderDeletionsAfterRestore({
            client: mockClient,
            operatorId,
            authorizedOperatorIds,
            verificationStorage: {
              list: async () => ({ objects: [], truncated: true }),
              get: async () => null,
            },
            storage,
          }),
        ).rejects.toMatchObject({ code: 'verification_storage_incomplete', status: 502 });

        // Fail-closed when verificationStorage.list repeats cursor
        await expect(
          reconcileOrderDeletionsAfterRestore({
            client: mockClient,
            operatorId,
            authorizedOperatorIds,
            verificationStorage: {
              list: async () => ({ objects: [], truncated: true, cursor: 'same-cursor' }),
              get: async () => null,
            },
            storage,
          }),
        ).rejects.toMatchObject({ code: 'verification_storage_incomplete', status: 502 });

        // Fail-closed when system_gates row is missing
        gateRowCount = 0;
        await expect(
          reconcileOrderDeletionsAfterRestore({
            client: mockClient,
            operatorId,
            authorizedOperatorIds,
            verificationStorage,
            storage,
          }),
        ).rejects.toMatchObject({ code: 'restore_freeze_gate_missing', status: 500 });
      });

      it('verifyVenueOrderDeletion enforces fail-closed pagination and receipt/DB cross-check (L1)', async () => {
        const venueId = '00000000-0000-4000-8000-000000000801';
        const requestId = '00000000-0000-4000-8000-000000000401';
        const operatorId = '00000000-0000-4000-8000-000000000099';
        const checkerId = '00000000-0000-4000-8000-000000000088';

        const mockClient = {
          query: vi.fn(async (sql: string) => {
            if (sql.includes('FROM app_private.order_data_deletion_requests')) {
              return {
                rows: [
                  {
                    executed_by: operatorId,
                    r2_objects_deleted: 2,
                    db_batches_deleted: 1,
                    db_lines_deleted: 3,
                    db_quarantine_deleted: 0,
                    db_conflicts_deleted: 0,
                  },
                ],
                rowCount: 1,
              };
            }
            return { rows: [], rowCount: 0 };
          }),
        } as any;

        // Truncated without cursor -> 502 verification_storage_incomplete
        await expect(
          verifyVenueOrderDeletion({
            client: mockClient,
            checkerId,
            authorizedCheckerIds: new Set([checkerId]),
            venueId,
            requestId,
            outcome: 'PASS',
            evidenceRef: 'CU-166',
            verificationStorage: {
              list: async () => ({ objects: [], truncated: true }),
              get: async () => null,
            },
          }),
        ).rejects.toMatchObject({ code: 'verification_storage_incomplete', status: 502 });

        // Count mismatch between completed.json and DB -> 409 deletion_receipt_mismatch
        const mismatchObjects = new Map<string, string>([
          [
            `order-deletion-ledger/${venueId}/${requestId}/intent.json`,
            JSON.stringify({
              requestId,
              venueId,
              operatorId,
              status: 'in_progress',
              intentRecordedAt: '2026-11-14T00:00:00.000Z',
            }),
          ],
          [
            `order-deletion-ledger/${venueId}/${requestId}/completed.json`,
            JSON.stringify({
              requestId,
              venueId,
              operatorId,
              status: 'completed',
              r2ObjectsDeleted: 99,
              dbBatchesDeleted: 1,
              dbLinesDeleted: 3,
              dbQuarantineDeleted: 0,
              dbConflictsDeleted: 0,
              completedAt: '2026-11-14T00:01:00.000Z',
            }),
          ],
        ]);
        await expect(
          verifyVenueOrderDeletion({
            client: mockClient,
            checkerId,
            authorizedCheckerIds: new Set([checkerId]),
            venueId,
            requestId,
            outcome: 'PASS',
            evidenceRef: 'CU-166',
            verificationStorage: {
              list: async (opts) => {
                const prefix = opts?.prefix ?? '';
                return {
                  objects: [...mismatchObjects.keys()]
                    .filter((k) => k.startsWith(prefix))
                    .map((key) => ({ key, uploaded: new Date('2026-11-14T00:00:00Z') })),
                  truncated: false,
                };
              },
              get: async (key: string) => {
                const val = mismatchObjects.get(key);
                if (!val) return null;
                return { text: async () => val, json: async () => JSON.parse(val) };
              },
            },
          }),
        ).rejects.toMatchObject({ code: 'verification_precondition_failed', status: 409 });
      });

      it('importOrderOutcomes logs structured error if compensating R2 delete fails after DB rollback (L2)', async () => {
        const venueId = '00000000-0000-4000-8000-000000000801';
        const actorId = '00000000-0000-4000-8000-000000000001';
        const client = createMockClient({
          venueId,
          actorId,
          permission: 'owner',
          posDishMappings: new Map(),
          batches: new Map(),
          lines: new Map(),
          quarantine: [],
          conflicts: [],
        });

        const origQuery = client.query.bind(client);
        client.query = (async (sql: string, params?: unknown[]) => {
          if (
            typeof sql === 'string' &&
            sql.includes('INSERT INTO app_private.order_outcome_import_batches')
          ) {
            throw new Error('simulated db insert failure');
          }
          return origQuery(sql, params);
        }) as typeof client.query;

        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
          await expect(
            importOrderOutcomes({
              client: client as any,
              venueId,
              actorId,
              sourceFilename: 'orders.csv',
              csvText:
                'schema_version,order_id,order_line_id,ordered_at,pos_item_id,outcome_type,quantity\npilot_order_outcome.v1,ORD-COMP,LINE-1,2026-11-12T12:00:00Z,POS-1,ordered,1',
              now: () => new Date('2026-11-12T12:00:00Z'),
              storage: {
                put: async (key) => ({ key }),
                delete: async () => {
                  throw new Error('r2 delete network timeout');
                },
              },
            }),
          ).rejects.toThrow('simulated db insert failure');

          expect(errSpy).toHaveBeenCalledTimes(1);
          const logged = JSON.parse(String(errSpy.mock.calls[0]?.[0]));
          expect(logged.event).toBe('order_import_compensating_r2_delete_failed');
          expect(logged.venueId).toBe(venueId);
          expect(logged.error).toContain('r2 delete network timeout');
        } finally {
          errSpy.mockRestore();
        }
      });

      it('records durable orphan state and supports idempotent retry, exhaustion, and deletion-race coordination (L2)', async () => {
        const venueId = '00000000-0000-4000-8000-000000000801';
        const otherVenueId = '00000000-0000-4000-8000-000000000802';
        const actorId = '00000000-0000-4000-8000-000000000001';
        const orphanRows = new Map<string, any>();
        let currentEpoch = 2;
        let activeDeletionCount = 0;

        const baseClient = createMockClient({
          venueId,
          actorId,
          permission: 'owner',
          posDishMappings: new Map(),
          batches: new Map(),
          lines: new Map(),
          quarantine: [],
          conflicts: [],
        });

        const origQuery = baseClient.query.bind(baseClient);
        const client = {
          query: vi.fn(async (sql: string, params?: unknown[]) => {
            const s = sql.trim();
            if (s.includes('INSERT INTO app_private.order_outcome_import_batches')) {
              throw new Error('simulated db insert failure');
            }
            if (s.includes('SELECT deletion_epoch') && s.includes('order_data_deletion_gates')) {
              return { rows: [{ deletion_epoch: currentEpoch }], rowCount: 1 };
            }
            if (
              s.includes('FROM app_private.order_data_deletion_requests') &&
              s.includes("status <> 'verified'")
            ) {
              return {
                rows: activeDeletionCount > 0 ? [{ id: 'del-1' }] : [],
                rowCount: activeDeletionCount > 0 ? 1 : 0,
              };
            }
            if (s.includes('INSERT INTO app_private.order_import_orphan_cleanups')) {
              const [tId, bId, key, epoch, err, ts] = params!;
              const mapKey = `${tId}:${bId}`;
              const row = {
                id: '00000000-0000-4000-8000-000000000901',
                tenant_id: tId,
                batch_id: bId,
                storage_key: key,
                deletion_epoch: epoch,
                status: 'pending',
                retry_count: 1,
                last_error: err,
                first_failed_at: ts,
                last_attempt_at: ts,
                cleaned_at: null,
              };
              orphanRows.set(mapKey, row);
              return { rows: [], rowCount: 1 };
            }
            if (s.includes('FROM app_private.order_import_orphan_cleanups')) {
              const [tId, maxRetries] = params!;
              const rows = [...orphanRows.values()].filter(
                (r) =>
                  r.tenant_id === tId &&
                  r.status === 'pending' &&
                  r.retry_count < Number(maxRetries),
              );
              return { rows, rowCount: rows.length };
            }
            if (s.includes('UPDATE app_private.order_import_orphan_cleanups')) {
              const [tId, id] = params!;
              const row = [...orphanRows.values()].find((r) => r.tenant_id === tId && r.id === id);
              if (row && row.status === 'pending') {
                if (s.includes("SET status = 'cleaned'")) {
                  row.status = 'cleaned';
                  row.cleaned_at = params![2];
                  row.last_error = null;
                } else {
                  row.retry_count += 1;
                  row.status = row.retry_count >= Number(params![3]) ? 'failed' : 'pending';
                  row.last_error = params![4];
                  row.last_attempt_at = params![5];
                }
              }
              return { rows: [], rowCount: row ? 1 : 0 };
            }
            return origQuery(sql, params);
          }),
        } as any;

        const r2Objects = new Set<string>();
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
          // 1. Initial compensating delete fails -> durable pending orphan record created
          await expect(
            importOrderOutcomes({
              client,
              venueId,
              actorId,
              sourceFilename: 'orders.csv',
              csvText:
                'schema_version,order_id,order_line_id,ordered_at,pos_item_id,outcome_type,quantity\npilot_order_outcome.v1,ORD-ORPH,LINE-1,2026-11-12T12:00:00Z,POS-1,ordered,1',
              now: () => new Date('2026-11-12T12:00:00Z'),
              storage: {
                put: async (key) => {
                  r2Objects.add(key);
                  return { key };
                },
                delete: async () => {
                  throw new Error('initial r2 timeout');
                },
              },
            }),
          ).rejects.toThrow('simulated db insert failure');

          expect(orphanRows.size).toBe(1);
          const recorded = [...orphanRows.values()][0]!;
          expect(recorded.status).toBe('pending');
          expect(recorded.deletion_epoch).toBe(2);
          expect(recorded.retry_count).toBe(1);

          // Cross-venue isolation: a foreign-venue orphan key is never deleted by retry
          orphanRows.set(`${venueId}:foreign`, {
            id: '00000000-0000-4000-8000-000000000902',
            tenant_id: venueId,
            batch_id: '00000000-0000-4000-8000-000000000999',
            storage_key: `order-imports/${otherVenueId}/b-other/source.csv`,
            deletion_epoch: 2,
            status: 'pending',
            retry_count: 1,
          });
          r2Objects.add(`order-imports/${otherVenueId}/b-other/source.csv`);

          // 2. Active deletion race skips cleanup without deleting R2
          activeDeletionCount = 1;
          const raceRes = await retryPendingOrphanCleanups({
            client,
            venueId,
            storage: {
              delete: async (key) => {
                r2Objects.delete(key);
              },
            },
          });
          expect(raceRes.skippedDeletionActive).toBe(true);
          expect(raceRes.attempted).toBe(0);
          expect(r2Objects.has(recorded.storage_key)).toBe(true);

          // 3. Repeated failure increments retry_count and marks 'failed' at maxRetries=2
          activeDeletionCount = 0;
          const failRetry = await retryPendingOrphanCleanups({
            client,
            venueId,
            maxRetries: 2,
            storage: {
              delete: async () => {
                throw new Error('persistent r2 outage');
              },
            },
          });
          expect(failRetry.attempted).toBe(1);
          expect(failRetry.failed).toBe(1);
          expect(failRetry.exhausted).toBe(1);
          expect(recorded.status).toBe('failed');
          expect(recorded.retry_count).toBe(2);

          // 4. Reset to pending and succeed -> cleans R2, marks 'cleaned', and is idempotent
          recorded.status = 'pending';
          recorded.retry_count = 1;
          const okRetry = await retryPendingOrphanCleanups({
            client,
            venueId,
            maxRetries: 5,
            storage: {
              delete: async (key) => {
                r2Objects.delete(key);
              },
            },
          });
          expect(okRetry.attempted).toBe(1);
          expect(okRetry.cleaned).toBe(1);
          expect(recorded.status).toBe('cleaned');
          expect(r2Objects.has(recorded.storage_key)).toBe(false);
          expect(r2Objects.has(`order-imports/${otherVenueId}/b-other/source.csv`)).toBe(true);

          // Idempotent re-run
          const secondRetry = await retryPendingOrphanCleanups({
            client,
            venueId,
            storage: {
              delete: async () => {
                throw new Error('should not be called');
              },
            },
          });
          expect(secondRetry.attempted).toBe(0);
          expect(secondRetry.cleaned).toBe(0);
        } finally {
          errSpy.mockRestore();
        }
      });

      it('fails closed in deleteVenueOrderData when R2 list returns truncated=true without a fresh cursor', async () => {
        const localVenueId = '11111111-1111-4111-8111-111111111111';
        const localOperatorId = '22222222-2222-4222-8222-222222222222';
        const requestId = '77777777-7777-4777-8777-777777777771';
        let currentStatus = 'requested';
        const query = vi.fn(async (sql: string) => {
          const normalized = sql.replace(/\s+/g, ' ').trim();
          if (
            normalized.startsWith('BEGIN') ||
            normalized.startsWith('COMMIT') ||
            normalized.startsWith('ROLLBACK') ||
            normalized.startsWith('SET LOCAL') ||
            normalized.startsWith('SELECT set_config') ||
            normalized.startsWith('SELECT pg_advisory_xact_lock')
          ) {
            return { rows: [], rowCount: 0 };
          }
          if (
            normalized.includes('FROM app_private.order_data_deletion_requests') &&
            normalized.includes('FOR UPDATE')
          ) {
            return {
              rows: [
                {
                  status: currentStatus,
                  executed_by: null,
                  execution_lease_expires_at: null,
                  r2_objects_deleted: 0,
                  db_batches_deleted: 0,
                  db_lines_deleted: 0,
                  db_quarantine_deleted: 0,
                  db_conflicts_deleted: 0,
                  completed_at: null,
                  receipt_written_at: null,
                },
              ],
              rowCount: 1,
            };
          }
          if (normalized.startsWith('UPDATE app_private.order_data_deletion_requests')) {
            if (normalized.includes("status = 'failed'")) currentStatus = 'failed';
            else if (normalized.includes("status = 'executing'")) currentStatus = 'executing';
            return { rows: [], rowCount: 1 };
          }
          if (normalized.includes('FROM app_private.order_outcome_import_batches')) {
            return { rows: [], rowCount: 0 };
          }
          return { rows: [], rowCount: 0 };
        });

        const storageDelete = vi.fn(async () => {});
        await expect(
          deleteVenueOrderData({
            client: { query } as unknown as Parameters<typeof deleteVenueOrderData>[0]['client'],
            operatorId: localOperatorId,
            venueId: localVenueId,
            requestId,
            authorizedOperatorIds: new Set([localOperatorId]),
            storage: {
              put: vi.fn(async () => {}),
              delete: storageDelete,
              list: vi.fn(async () => ({
                objects: [
                  {
                    key: `order-imports/${localVenueId}/b1/source.csv`,
                    uploaded: new Date('2026-11-13T00:00:00.000Z'),
                  },
                ],
                truncated: true,
                cursor: undefined,
              })),
            },
          }),
        ).rejects.toMatchObject({ code: 'deletion_storage_failed', status: 502 });
        expect(storageDelete).not.toHaveBeenCalled();
        expect(
          query.mock.calls.some(([sql]) => String(sql).includes('delete_venue_order_data')),
        ).toBe(false);
      });
    });
  });
});
