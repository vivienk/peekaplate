import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { z } from 'zod';
import {
  type OrderDeletionVerificationStorage,
  OrderImportError,
  type OrderOutcomeStorage,
} from './service';

const LEDGER_KEY_PATTERN =
  /^order-deletion-ledger\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(intent|completed|reconciled)\.json$/i;

const IntentLedgerSchema = z.strictObject({
  requestId: z.string().uuid(),
  venueId: z.string().uuid(),
  operatorId: z.string().uuid(),
  status: z.literal('in_progress'),
  intentRecordedAt: z.string().datetime(),
});

const CompletedLedgerSchema = z.strictObject({
  requestId: z.string().uuid(),
  venueId: z.string().uuid(),
  operatorId: z.string().uuid(),
  status: z.literal('completed'),
  r2ObjectsDeleted: z.number().int().nonnegative(),
  dbBatchesDeleted: z.number().int().nonnegative(),
  dbLinesDeleted: z.number().int().nonnegative(),
  dbQuarantineDeleted: z.number().int().nonnegative(),
  dbConflictsDeleted: z.number().int().nonnegative(),
  completedAt: z.string().datetime(),
});

export type RestoreReconciliationEntryResult = {
  venueId: string;
  requestId: string;
  ledgerStatus:
    | 'completed'
    | 'intent_only'
    | 'completed_without_intent'
    | 'missing_in_r2'
    | 'malformed'
    | 'conflict';
  outcome: 'reconciled' | 'blocked_unresolved_intent' | 'blocked_anomaly' | 'failed';
  r2ObjectsDeleted: number;
  dbBatchesDeleted: number;
  dbLinesDeleted: number;
  dbQuarantineDeleted: number;
  dbConflictsDeleted: number;
  reason?: string;
};

export type ReconcileOrderDeletionsOptions = {
  client: Client;
  operatorId: string;
  authorizedOperatorIds: ReadonlySet<string>;
  verificationStorage: OrderDeletionVerificationStorage;
  storage: Pick<OrderOutcomeStorage, 'put' | 'delete' | 'list'>;
  reconciliationRunId?: string;
  now?: () => Date;
};

export type ReconcileOrderDeletionsResult = {
  reconciliationRunId: string;
  status: 'completed' | 'failed';
  freezeLifted: boolean;
  entriesProcessed: number;
  reconciledCount: number;
  blockedIntentOnlyCount: number;
  anomalyCount: number;
  entries: RestoreReconciliationEntryResult[];
};

export async function reconcileOrderDeletionsAfterRestore(
  options: ReconcileOrderDeletionsOptions,
): Promise<ReconcileOrderDeletionsResult> {
  const {
    client,
    operatorId,
    authorizedOperatorIds,
    verificationStorage,
    storage,
    reconciliationRunId = randomUUID(),
    now = () => new Date(),
  } = options;

  if (!authorizedOperatorIds || !authorizedOperatorIds.has(operatorId)) {
    throw new OrderImportError(
      'forbidden',
      403,
      'Restore reconciliation requires an authorized operator',
    );
  }

  // 1. Ensure global restore freeze is active before inspecting/modifying restored DB
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL statement_timeout = '5s'");
    const gateRes = await client.query(
      `UPDATE app_private.system_gates
       SET is_active = true,
           reason = 'Post-restore order deletion reconciliation in progress',
           updated_by = $1,
           updated_at = now()
       WHERE gate_name = 'order_imports_restore_freeze'`,
      [operatorId],
    );
    if (gateRes.rowCount !== 1) {
      throw new OrderImportError(
        'restore_freeze_gate_missing',
        500,
        'Global order_imports_restore_freeze gate row is missing',
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }

  // 2. Discover all R2 deletion ledger entries via full cursor pagination
  type LedgerPair = {
    venueId: string;
    requestId: string;
    intentKey?: string;
    completedKey?: string;
    duplicateOrInvalid?: string;
  };
  const pairs = new Map<string, LedgerPair>();

  let cursor: string | undefined;
  const seenLedgerCursors = new Set<string>();
  do {
    const page = await verificationStorage.list({
      prefix: 'order-deletion-ledger/',
      cursor,
      limit: 100,
    });
    for (const obj of page.objects) {
      const match = obj.key.match(LEDGER_KEY_PATTERN);
      if (!match) {
        continue;
      }
      const venueId = match[1]!.toLowerCase();
      const requestId = match[2]!.toLowerCase();
      const kind = match[3]!.toLowerCase();
      if (kind === 'reconciled') {
        continue;
      }
      const mapKey = `${venueId}:${requestId}`;
      const existing = pairs.get(mapKey) ?? { venueId, requestId };
      if (kind === 'intent') {
        if (existing.intentKey) {
          existing.duplicateOrInvalid = 'Duplicate intent.json entry';
        } else {
          existing.intentKey = obj.key;
        }
      } else if (kind === 'completed') {
        if (existing.completedKey) {
          existing.duplicateOrInvalid = 'Duplicate completed.json entry';
        } else {
          existing.completedKey = obj.key;
        }
      }
      pairs.set(mapKey, existing);
    }
    if (page.truncated) {
      if (!page.cursor || seenLedgerCursors.has(page.cursor)) {
        throw new OrderImportError(
          'verification_storage_incomplete',
          502,
          'R2 deletion ledger pagination returned truncated=true without a fresh cursor',
        );
      }
      seenLedgerCursors.add(page.cursor);
      cursor = page.cursor;
    } else {
      cursor = undefined;
    }
  } while (cursor);

  const entries: RestoreReconciliationEntryResult[] = [];
  let anomalyCount = 0;
  let reconciledCount = 0;
  let blockedIntentOnlyCount = 0;

  // 3. Validate and reconcile each discovered ledger entry
  for (const pair of pairs.values()) {
    const { venueId, requestId } = pair;
    if (pair.duplicateOrInvalid) {
      anomalyCount++;
      entries.push({
        venueId,
        requestId,
        ledgerStatus: 'conflict',
        outcome: 'blocked_anomaly',
        r2ObjectsDeleted: 0,
        dbBatchesDeleted: 0,
        dbLinesDeleted: 0,
        dbQuarantineDeleted: 0,
        dbConflictsDeleted: 0,
        reason: pair.duplicateOrInvalid,
      });
      continue;
    }

    let intentParsed: z.infer<typeof IntentLedgerSchema> | null = null;
    let completedParsed: z.infer<typeof CompletedLedgerSchema> | null = null;
    let parseError: string | null = null;

    if (pair.intentKey) {
      try {
        const obj = await verificationStorage.get(pair.intentKey);
        if (!obj) {
          parseError = 'intent.json disappeared during reconciliation';
        } else {
          const raw = await obj.json();
          const res = IntentLedgerSchema.safeParse(raw);
          if (!res.success || res.data.venueId !== venueId || res.data.requestId !== requestId) {
            parseError = 'intent.json schema or provenance mismatch';
          } else {
            intentParsed = res.data;
          }
        }
      } catch {
        parseError = 'Malformed intent.json';
      }
    }

    if (!parseError && pair.completedKey) {
      try {
        const obj = await verificationStorage.get(pair.completedKey);
        if (!obj) {
          parseError = 'completed.json disappeared during reconciliation';
        } else {
          const raw = await obj.json();
          const res = CompletedLedgerSchema.safeParse(raw);
          if (!res.success || res.data.venueId !== venueId || res.data.requestId !== requestId) {
            parseError = 'completed.json schema or provenance mismatch';
          } else {
            completedParsed = res.data;
          }
        }
      } catch {
        parseError = 'Malformed completed.json';
      }
    }

    if (!parseError && intentParsed && completedParsed) {
      if (completedParsed.operatorId !== intentParsed.operatorId) {
        parseError = 'completed.json operatorId does not match intent.json operatorId';
      } else if (
        Date.parse(completedParsed.completedAt) < Date.parse(intentParsed.intentRecordedAt)
      ) {
        parseError = 'completed.json completedAt predates intent.json intentRecordedAt';
      }
    }

    if (parseError) {
      anomalyCount++;
      entries.push({
        venueId,
        requestId,
        ledgerStatus: 'malformed',
        outcome: 'blocked_anomaly',
        r2ObjectsDeleted: 0,
        dbBatchesDeleted: 0,
        dbLinesDeleted: 0,
        dbQuarantineDeleted: 0,
        dbConflictsDeleted: 0,
        reason: parseError,
      });
      continue;
    }

    if (completedParsed && !intentParsed) {
      anomalyCount++;
      await recordReconcileInDb(client, {
        reconciliationRunId,
        venueId,
        requestId,
        operatorId,
        completedAt: completedParsed.completedAt,
        receiptWrittenAt: null,
        ledgerStatus: 'completed_without_intent',
        r2ObjectsDeleted: 0,
        evidenceRef: `r2://order-deletion-ledger/${venueId}/${requestId}/completed.json`,
      });
      entries.push({
        venueId,
        requestId,
        ledgerStatus: 'completed_without_intent',
        outcome: 'blocked_anomaly',
        r2ObjectsDeleted: 0,
        dbBatchesDeleted: 0,
        dbLinesDeleted: 0,
        dbQuarantineDeleted: 0,
        dbConflictsDeleted: 0,
        reason: 'completed.json present without intent.json',
      });
      continue;
    }

    if (intentParsed && !completedParsed) {
      blockedIntentOnlyCount++;
      await recordReconcileInDb(client, {
        reconciliationRunId,
        venueId,
        requestId,
        operatorId,
        completedAt: null,
        receiptWrittenAt: null,
        ledgerStatus: 'intent_only',
        r2ObjectsDeleted: 0,
        evidenceRef: `r2://order-deletion-ledger/${venueId}/${requestId}/intent.json`,
      });
      entries.push({
        venueId,
        requestId,
        ledgerStatus: 'intent_only',
        outcome: 'blocked_unresolved_intent',
        r2ObjectsDeleted: 0,
        dbBatchesDeleted: 0,
        dbLinesDeleted: 0,
        dbQuarantineDeleted: 0,
        dbConflictsDeleted: 0,
      });
      continue;
    }

    if (intentParsed && completedParsed) {
      // Purge any resurrected R2 order-imports/<venueId>/ CSVs first
      let r2Purged = 0;
      if (typeof storage.list === 'function' && typeof storage.delete === 'function') {
        const prefix = `order-imports/${venueId}/`;
        let r2Cursor: string | undefined;
        const seenR2Cursors = new Set<string>();
        do {
          const listRes = await storage.list({ prefix, cursor: r2Cursor, limit: 100 });
          for (const obj of listRes.objects) {
            if (obj.key.startsWith(prefix)) {
              await storage.delete(obj.key);
              r2Purged++;
            }
          }
          if (listRes.truncated) {
            if (!listRes.cursor || seenR2Cursors.has(listRes.cursor)) {
              throw new OrderImportError(
                'verification_storage_incomplete',
                502,
                'R2 order-imports pagination returned truncated=true without a fresh cursor',
              );
            }
            seenR2Cursors.add(listRes.cursor);
            r2Cursor = listRes.cursor;
          } else {
            r2Cursor = undefined;
          }
        } while (r2Cursor);
      }

      const dbRes = await recordReconcileInDb(client, {
        reconciliationRunId,
        venueId,
        requestId,
        operatorId,
        completedAt: completedParsed.completedAt,
        receiptWrittenAt: completedParsed.completedAt,
        ledgerStatus: 'completed',
        r2ObjectsDeleted: r2Purged,
        evidenceRef: `r2://order-deletion-ledger/${venueId}/${requestId}/reconciled.json`,
      });

      // Write durable reconciliation receipt to R2
      const reconciledKey = `order-deletion-ledger/${venueId}/${requestId}/reconciled.json`;
      await storage.put(
        reconciledKey,
        JSON.stringify({
          reconciliationRunId,
          requestId,
          venueId,
          operatorId,
          ledgerStatus: 'completed',
          r2ObjectsDeleted: r2Purged,
          dbBatchesDeleted: dbRes.batchesDeleted,
          dbLinesDeleted: dbRes.linesDeleted,
          dbQuarantineDeleted: dbRes.quarantineDeleted,
          dbConflictsDeleted: dbRes.conflictsDeleted,
          reconciledAt: now().toISOString(),
        }),
        { httpMetadata: { contentType: 'application/json' } },
      );

      reconciledCount++;
      entries.push({
        venueId,
        requestId,
        ledgerStatus: 'completed',
        outcome: 'reconciled',
        r2ObjectsDeleted: r2Purged,
        dbBatchesDeleted: dbRes.batchesDeleted,
        dbLinesDeleted: dbRes.linesDeleted,
        dbQuarantineDeleted: dbRes.quarantineDeleted,
        dbConflictsDeleted: dbRes.conflictsDeleted,
      });
    }
  }

  // 3b. Cross-check DB deletion requests against R2 ledger (detect missing_in_r2 anomalies)
  let dbDeletions: Array<{
    tenant_id: string;
    id: string;
    status: string;
    executed_by: string | null;
    completed_at: string | null;
  }> = [];
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL statement_timeout = '5s'");
    const dbRes = await client.query<{
      tenant_id: string;
      id: string;
      status: string;
      executed_by: string | null;
      completed_at: string | null;
    }>(
      `SELECT tenant_id, id, status, executed_by, completed_at
       FROM app_private.list_order_deletion_requests_for_reconcile()`,
    );
    dbDeletions = dbRes.rows;
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }

  for (const row of dbDeletions) {
    const mapKey = `${row.tenant_id}:${row.id}`;
    if (!pairs.has(mapKey)) {
      await recordReconcileInDb(client, {
        reconciliationRunId,
        venueId: row.tenant_id,
        requestId: row.id,
        operatorId,
        completedAt: row.completed_at,
        receiptWrittenAt: null,
        ledgerStatus: 'missing_in_r2',
        r2ObjectsDeleted: 0,
        evidenceRef: 'db_deletion_missing_in_r2_ledger',
      });
      anomalyCount++;
      entries.push({
        venueId: row.tenant_id,
        requestId: row.id,
        ledgerStatus: 'missing_in_r2',
        outcome: 'blocked_anomaly',
        r2ObjectsDeleted: 0,
        dbBatchesDeleted: 0,
        dbLinesDeleted: 0,
        dbQuarantineDeleted: 0,
        dbConflictsDeleted: 0,
        reason: `Database deletion request in status '${row.status}' has no matching R2 deletion ledger entry`,
      });
    }
  }

  // 4. Lift global restore freeze ONLY when zero anomalies occurred
  let freezeLifted = false;
  if (anomalyCount === 0) {
    await client.query('BEGIN');
    try {
      await client.query("SET LOCAL statement_timeout = '5s'");
      const liftRes = await client.query(
        `UPDATE app_private.system_gates
         SET is_active = false,
             reason = NULL,
             updated_by = $1,
             updated_at = now()
         WHERE gate_name = 'order_imports_restore_freeze'`,
        [operatorId],
      );
      if (liftRes.rowCount !== 1) {
        throw new OrderImportError(
          'restore_freeze_gate_missing',
          500,
          'Global order_imports_restore_freeze gate row is missing',
        );
      }
      await client.query('COMMIT');
      freezeLifted = true;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
  }

  return {
    reconciliationRunId,
    status: anomalyCount === 0 ? 'completed' : 'failed',
    freezeLifted,
    entriesProcessed: entries.length,
    reconciledCount,
    blockedIntentOnlyCount,
    anomalyCount,
    entries,
  };
}

async function recordReconcileInDb(
  client: Client,
  params: {
    reconciliationRunId: string;
    venueId: string;
    requestId: string;
    operatorId: string;
    completedAt: string | null;
    receiptWrittenAt: string | null;
    ledgerStatus: 'completed' | 'intent_only' | 'completed_without_intent' | 'missing_in_r2';
    r2ObjectsDeleted: number;
    evidenceRef: string;
  },
): Promise<{
  batchesDeleted: number;
  linesDeleted: number;
  quarantineDeleted: number;
  conflictsDeleted: number;
}> {
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL statement_timeout = '10s'");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SELECT set_config('app.actor_id', $1, true)", [params.operatorId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [params.venueId]);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `order_lifecycle:${params.venueId}`,
    ]);

    const res = await client.query<{
      batches_deleted: number;
      lines_deleted: number;
      quarantine_deleted: number;
      conflicts_deleted: number;
    }>(
      `SELECT batches_deleted, lines_deleted, quarantine_deleted, conflicts_deleted
       FROM app_private.reconcile_venue_order_deletion($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        params.reconciliationRunId,
        params.venueId,
        params.requestId,
        params.operatorId,
        params.completedAt,
        params.receiptWrittenAt,
        params.ledgerStatus,
        params.r2ObjectsDeleted,
        params.evidenceRef,
      ],
    );
    await client.query('COMMIT');
    const row = res.rows[0];
    return {
      batchesDeleted: row?.batches_deleted ?? 0,
      linesDeleted: row?.lines_deleted ?? 0,
      quarantineDeleted: row?.quarantine_deleted ?? 0,
      conflictsDeleted: row?.conflicts_deleted ?? 0,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}
