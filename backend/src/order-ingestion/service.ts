import { randomUUID } from 'node:crypto';
import {
  type AcceptPilotOrderAgreementResponse,
  type CsvParseResult,
  classifyOrderTimestampWindow,
  computeOrderLineChecksum,
  DEFAULT_HISTORICAL_IMPORT_WINDOW_DAYS,
  DEFAULT_RAW_CSV_RETENTION_DAYS,
  type DeleteOrderDataResponse,
  MAX_ORDER_OUTCOME_FILE_BYTES,
  MAX_ORDER_OUTCOME_ROWS,
  type OrderDataDeletionReason,
  type OrderOutcomeImportResponse,
  OrderOutcomeLineSchema,
  type OrderOutcomeQuarantineReason,
  type OrderOutcomeType,
  OrderTokenIdentifierSchema,
  PILOT_ORDER_AGREEMENT_VERSION,
  PublicMenuContentBundleSchema,
  parseOrderOutcomeCsv,
  type SanitizedRowDiagnostic,
  type SubmitOrderDeletionResponse,
  sha256,
} from '@peekaplate/contracts';
import type { Client } from 'pg';

const CANONICAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONSECUTIVE_DIGITS_PATTERN = /\d{10,}/;

export class OrderImportError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 400,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'OrderImportError';
  }
}

export type OrderOutcomeBundleLoader = (bundleUrl: string) => Promise<string | object>;

export type StoredObjectInfo = {
  key: string;
  uploaded: Date;
  customMetadata?: Record<string, string> | undefined;
};

export type OrderOutcomeStorage = {
  put(
    key: string,
    value: string | ArrayBuffer | ReadableStream,
    options?: {
      customMetadata?: Record<string, string>;
      httpMetadata?: { contentType?: string };
      onlyIf?: { etagDoesNotMatch?: string };
    },
  ): Promise<unknown>;
  delete?(key: string): Promise<unknown>;
  list?(options?: {
    prefix?: string | undefined;
    cursor?: string | undefined;
    limit?: number | undefined;
  }): Promise<{
    objects: StoredObjectInfo[];
    truncated: boolean;
    cursor?: string | undefined;
  }>;
};

export type OrderOutcomeRetentionConfig = {
  rawCsvRetentionDays?: number | undefined; // default 90 days (pilot proposal)
  orphanGracePeriodMs?: number | undefined; // default 2 hours (7_200_000 ms)
  enableRawCsvPurge?: boolean | undefined; // Gated: requires explicit product/privacy approval
};

export const DEFAULT_RETENTION_CONFIG: Required<OrderOutcomeRetentionConfig> = {
  rawCsvRetentionDays: DEFAULT_RAW_CSV_RETENTION_DAYS,
  orphanGracePeriodMs: 2 * 60 * 60 * 1000,
  enableRawCsvPurge: false,
};

export type ImportOrderOutcomeOptions = {
  client: Client;
  actorId: string;
  venueId: string;
  csvText: string;
  sourceFilename?: string | undefined;
  bundleLoader?: OrderOutcomeBundleLoader | undefined;
  storage?: OrderOutcomeStorage | undefined;
  trackingStartedAt?: string | Date | undefined;
  maxHistoricalDays?: number | undefined;
  agreementVersion?: string | undefined;
  now?: (() => Date) | undefined;
};

type DishInfo = {
  dish_id: string;
  dish_revision_id: string;
  name: string;
};

type MenuRevisionResolution =
  | {
      valid: true;
      menuRevisionId: string;
      dishMap: Map<string, string>; // dish_id -> dish_revision_id
      dishes: DishInfo[];
    }
  | {
      valid: false;
      reasonCode: OrderOutcomeQuarantineReason;
      message: string;
    };

/**
 * Executes a controlled pilot order-outcome import synchronously.
 */
export async function importOrderOutcomes(
  options: ImportOrderOutcomeOptions,
): Promise<OrderOutcomeImportResponse> {
  const { client, actorId, venueId, csvText, sourceFilename = 'orders.csv' } = options;
  const now = (options.now ?? (() => new Date()))();
  const nowIso = now.toISOString();

  // 1. Enforce payload size limit
  const byteLength = Buffer.byteLength(csvText, 'utf8');
  if (byteLength > MAX_ORDER_OUTCOME_FILE_BYTES) {
    throw new OrderImportError(
      'payload_too_large',
      413,
      `CSV file size (${byteLength} bytes) exceeds maximum permitted limit (${MAX_ORDER_OUTCOME_FILE_BYTES} bytes)`,
    );
  }

  // 2. Compute file SHA-256
  const fileSha256 = await sha256(csvText);

  // 3. Authorize actor as owner of venueId & check for duplicate completed batch
  // Scoped within an explicit transaction so SET LOCAL and set_config(..., true) are active
  // and cleanly cleared on COMMIT/ROLLBACK, preventing session context leakage in connection pools
  let duplicateCompletedResponse: OrderOutcomeImportResponse | null = null;
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL lock_timeout = '3s'");
    await client.query("SELECT set_config('app.actor_id', $1, true)", [actorId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [venueId]);

    const membership = await client.query<{ permission: string }>(
      `SELECT permission
       FROM app_private.staff_membership
       WHERE tenant_id = $1 AND actor_id = $2
       FOR SHARE`,
      [venueId, actorId],
    );

    if (membership.rows[0]?.permission !== 'owner') {
      throw new OrderImportError(
        'forbidden',
        403,
        'Order outcome import requires owner permission',
      );
    }

    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `order_lifecycle:${venueId}`,
    ]);

    const activeDeletion = await client.query<{ id: string; status: string }>(
      `SELECT id, status
       FROM app_private.order_data_deletion_requests
       WHERE tenant_id = $1 AND status IN ('requested', 'executing', 'r2_deleted', 'failed')
       LIMIT 1`,
      [venueId],
    );

    if (activeDeletion.rows.length > 0) {
      throw new OrderImportError(
        'deletion_in_progress',
        409,
        'Order outcome import is blocked while an order-data deletion request is pending or in progress for this venue',
      );
    }

    const requiredAgreementVersion = options.agreementVersion ?? PILOT_ORDER_AGREEMENT_VERSION;
    const acceptance = await client.query<{ id: string }>(
      `SELECT id
       FROM app_private.pilot_order_agreement_acceptances
       WHERE tenant_id = $1 AND agreement_version = $2`,
      [venueId, requiredAgreementVersion],
    );

    if (acceptance.rows.length === 0) {
      throw new OrderImportError(
        'agreement_not_accepted',
        403,
        `Pilot order-outcome agreement (${requiredAgreementVersion}) must be accepted for this venue before importing`,
      );
    }

    const existingFile = await client.query<{
      id: string;
      status: string;
      total_rows: number;
      accepted_rows: number;
      duplicate_rows: number;
      quarantined_rows: number;
      conflict_rows: number;
      file_sha256: string;
      created_at: Date;
      finished_at: Date | null;
    }>(
      `SELECT id, status, total_rows, accepted_rows, duplicate_rows, quarantined_rows, conflict_rows,
              file_sha256, created_at, finished_at
       FROM app_private.order_outcome_import_batches
       WHERE tenant_id = $1 AND file_sha256 = $2`,
      [venueId, fileSha256],
    );

    if (existingFile.rows.length > 0) {
      const existing = existingFile.rows[0]!;
      if (existing.status === 'completed') {
        duplicateCompletedResponse = {
          batchId: existing.id,
          venueId,
          status: 'completed',
          totalRows: existing.total_rows,
          acceptedRows: existing.accepted_rows,
          duplicateRows: existing.duplicate_rows,
          quarantinedRows: existing.quarantined_rows,
          conflictRows: existing.conflict_rows,
          isDuplicateFile: true,
          fileSha256: existing.file_sha256,
          diagnostics: [],
          createdAt: existing.created_at.toISOString(),
          finishedAt: existing.finished_at ? existing.finished_at.toISOString() : null,
        };
      } else if (existing.status === 'processing') {
        throw new OrderImportError(
          'conflict',
          409,
          'An import batch for this identical file is currently processing',
        );
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }

  if (duplicateCompletedResponse) {
    return duplicateCompletedResponse;
  }

  // 5. Parse CSV structure
  const parseResult: CsvParseResult = parseOrderOutcomeCsv(csvText, {
    maxRows: MAX_ORDER_OUTCOME_ROWS,
  });

  if (!parseResult.success) {
    const status = parseResult.reasonCode === 'payload_too_large' ? 413 : 400;
    throw new OrderImportError(parseResult.reasonCode, status, parseResult.message);
  }

  // 6. Generate Batch ID and Archive to Storage
  const batchId = randomUUID();
  const storageKey = `order-imports/${venueId}/${batchId}/source.csv`;
  if (options.storage) {
    await options.storage.put(storageKey, csvText, {
      customMetadata: {
        'file-sha256': fileSha256,
        'tenant-id': venueId,
        'batch-id': batchId,
        'archived-at': nowIso,
      },
      httpMetadata: {
        contentType: 'text/csv',
      },
    });
  }

  // 7. Begin atomic processing transaction
  let inTx = false;
  let commitAttempted = false;
  try {
    await client.query('BEGIN');
    inTx = true;
    await client.query("SET LOCAL statement_timeout = '10s'");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SELECT set_config('app.actor_id', $1, true)", [actorId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [venueId]);

    // Recheck owner permission inside the final processing transaction and hold FOR SHARE through commit/rollback (Finding B)
    const recheckMembership = await client.query<{ permission: string }>(
      `SELECT permission
       FROM app_private.staff_membership
       WHERE tenant_id = $1 AND actor_id = $2
       FOR SHARE`,
      [venueId, actorId],
    );

    if (recheckMembership.rows[0]?.permission !== 'owner') {
      throw new OrderImportError(
        'forbidden',
        403,
        'Order outcome import requires owner permission',
      );
    }

    // Transaction-level advisory locks serialize concurrent imports and deletion lifecycle for the venue
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `order_lifecycle:${venueId}`,
    ]);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `order_import:${venueId}`,
    ]);

    const activeDeletionRecheck = await client.query<{ id: string; status: string }>(
      `SELECT id, status
       FROM app_private.order_data_deletion_requests
       WHERE tenant_id = $1 AND status IN ('requested', 'executing', 'r2_deleted', 'failed')
       LIMIT 1`,
      [venueId],
    );

    if (activeDeletionRecheck.rows.length > 0) {
      throw new OrderImportError(
        'deletion_in_progress',
        409,
        'Order outcome import is blocked while an order-data deletion request is pending or in progress for this venue',
      );
    }

    // Recheck identical file hash under the advisory lock to handle concurrent imports (Finding E)
    const existingFileAfterLock = await client.query<{
      id: string;
      status: string;
      total_rows: number;
      accepted_rows: number;
      duplicate_rows: number;
      quarantined_rows: number;
      conflict_rows: number;
      file_sha256: string;
      created_at: Date;
      finished_at: Date | null;
    }>(
      `SELECT id, status, total_rows, accepted_rows, duplicate_rows, quarantined_rows, conflict_rows,
              file_sha256, created_at, finished_at
       FROM app_private.order_outcome_import_batches
       WHERE tenant_id = $1 AND file_sha256 = $2`,
      [venueId, fileSha256],
    );

    if (existingFileAfterLock.rows.length > 0) {
      const existing = existingFileAfterLock.rows[0]!;
      if (existing.status === 'completed') {
        if (options.storage && typeof options.storage.delete === 'function') {
          try {
            await options.storage.delete(storageKey);
          } catch {
            // Compensating cleanup failure suppressed
          }
        }
        await client.query('COMMIT');
        inTx = false;
        return {
          batchId: existing.id,
          venueId,
          status: 'completed',
          totalRows: existing.total_rows,
          acceptedRows: existing.accepted_rows,
          duplicateRows: existing.duplicate_rows,
          quarantinedRows: existing.quarantined_rows,
          conflictRows: existing.conflict_rows,
          isDuplicateFile: true,
          fileSha256: existing.file_sha256,
          diagnostics: [],
          createdAt: existing.created_at.toISOString(),
          finishedAt: existing.finished_at ? existing.finished_at.toISOString() : null,
        };
      }
    }

    // Query venue tracking activation inside the authorized tenant transaction if not passed (Finding A)
    let effectiveTrackingStartedAt = options.trackingStartedAt;
    if (effectiveTrackingStartedAt === undefined) {
      const trackingRes = await client.query<{ activated_at: Date | null }>(
        `SELECT activated_at
         FROM app_private.venue_tracking_activations
         WHERE tenant_id = $1`,
        [venueId],
      );
      effectiveTrackingStartedAt = trackingRes.rows[0]?.activated_at ?? undefined;
    }

    // Insert batch in 'processing' status
    await client.query(
      `INSERT INTO app_private.order_outcome_import_batches
        (id, tenant_id, schema_version, source_filename, file_sha256, storage_key, status,
         total_rows, accepted_rows, duplicate_rows, quarantined_rows, conflict_rows, created_by, started_at)
       VALUES ($1, $2, 'pilot_order_outcome.v1', $3, $4, $5, 'processing', $6, 0, 0, 0, 0, $7, now())`,
      [batchId, venueId, sourceFilename, fileSha256, storageKey, parseResult.rows.length, actorId],
    );

    // 8. Resolve Menu Revisions and Tracking Start Boundary
    // Preload only valid canonical UUIDs into PostgreSQL; malformed revision IDs fail closed as row-level quarantine
    const distinctMenuRevisionIds = new Set<string>();
    const invalidMenuRevisionIds = new Set<string>();
    for (const r of parseResult.rows) {
      if (r.data.menu_revision_id) {
        const trimmed = r.data.menu_revision_id.trim();
        if (CANONICAL_UUID_PATTERN.test(trimmed)) {
          distinctMenuRevisionIds.add(trimmed);
        } else {
          invalidMenuRevisionIds.add(r.data.menu_revision_id);
        }
      }
    }

    const revisionResolutions = new Map<string, MenuRevisionResolution>();
    for (const invalidId of invalidMenuRevisionIds) {
      revisionResolutions.set(invalidId, {
        valid: false,
        reasonCode: 'invalid_format',
        message: 'menu_revision_id must be a valid canonical UUID',
      });
    }

    for (const menuRevId of distinctMenuRevisionIds) {
      const resolution = await resolveMenuRevision(
        client,
        venueId,
        menuRevId,
        options.bundleLoader,
      );
      revisionResolutions.set(menuRevId, resolution);
    }

    // 9. Process rows
    let acceptedRows = 0;
    let duplicateRows = 0;
    let quarantinedRows = 0;
    let conflictRows = 0;
    const diagnostics: SanitizedRowDiagnostic[] = [];
    const seenInBatch = new Map<string, string>(); // order_id:order_line_id:outcome_type -> payload_checksum

    for (const parsedRow of parseResult.rows) {
      const { rowIndex, data } = parsedRow;

      // Validate schema version
      if (data.schema_version !== 'pilot_order_outcome.v1') {
        const diagnostic: SanitizedRowDiagnostic = {
          rowIndex,
          fieldName: 'schema_version',
          reasonCode: 'schema_version_unsupported',
          diagnosticMessage: 'Unsupported schema version',
        };
        await insertQuarantine(client, venueId, batchId, diagnostic);
        diagnostics.push(diagnostic);
        quarantinedRows++;
        continue;
      }

      // Validate order_id and order_line_id
      const orderIdParse = OrderTokenIdentifierSchema.safeParse(data.order_id);
      const lineIdParse = OrderTokenIdentifierSchema.safeParse(data.order_line_id);
      if (!orderIdParse.success || !lineIdParse.success) {
        const fieldName = !orderIdParse.success ? 'order_id' : 'order_line_id';
        const diagnostic: SanitizedRowDiagnostic = {
          rowIndex,
          fieldName,
          reasonCode: 'prohibited_identifier',
          diagnosticMessage: 'Identifier contains disallowed characters or patterns',
        };
        await insertQuarantine(client, venueId, batchId, diagnostic);
        diagnostics.push(diagnostic);
        quarantinedRows++;
        continue;
      }

      // Validate outcome_type
      if (!['ordered', 'refunded', 'voided'].includes(data.outcome_type || '')) {
        const diagnostic: SanitizedRowDiagnostic = {
          rowIndex,
          fieldName: 'outcome_type',
          reasonCode: 'invalid_format',
          diagnosticMessage: 'outcome_type must be ordered, refunded, or voided',
        };
        await insertQuarantine(client, venueId, batchId, diagnostic);
        diagnostics.push(diagnostic);
        quarantinedRows++;
        continue;
      }

      // Validate quantity (Finding G: complete token validation before conversion)
      const rawQty = data.quantity ?? '';
      if (!/^[1-9]\d{0,2}$/.test(rawQty)) {
        const diagnostic: SanitizedRowDiagnostic = {
          rowIndex,
          fieldName: 'quantity',
          reasonCode: 'invalid_format',
          diagnosticMessage: 'quantity must be an integer between 1 and 999',
        };
        await insertQuarantine(client, venueId, batchId, diagnostic);
        diagnostics.push(diagnostic);
        quarantinedRows++;
        continue;
      }
      const qty = Number.parseInt(rawQty, 10);

      // Validate pricing fields
      const hasUnitPrice = Boolean(data.unit_price && data.unit_price.trim().length > 0);
      const hasCurrency = Boolean(data.currency && data.currency.trim().length > 0);
      if (hasUnitPrice !== hasCurrency) {
        const diagnostic: SanitizedRowDiagnostic = {
          rowIndex,
          fieldName: hasUnitPrice ? 'currency' : 'unit_price',
          reasonCode: 'price_currency_mismatch',
          diagnosticMessage: 'unit_price and currency must both be present or both be omitted',
        };
        await insertQuarantine(client, venueId, batchId, diagnostic);
        diagnostics.push(diagnostic);
        quarantinedRows++;
        continue;
      }
      if (
        hasUnitPrice &&
        (!/^(0|[1-9]\d{0,7})(\.\d{1,2})?$/.test(data.unit_price!) ||
          !/^[A-Z]{3}$/.test(data.currency!))
      ) {
        const fieldName = !/^(0|[1-9]\d{0,7})(\.\d{1,2})?$/.test(data.unit_price!)
          ? 'unit_price'
          : 'currency';
        const diagnostic: SanitizedRowDiagnostic = {
          rowIndex,
          fieldName,
          reasonCode: 'invalid_format',
          diagnosticMessage:
            'unit_price must be a positive decimal string with up to 2 places and currency must be an ISO 4217 code',
        };
        await insertQuarantine(client, venueId, batchId, diagnostic);
        diagnostics.push(diagnostic);
        quarantinedRows++;
        continue;
      }

      // Validate tracking-start evidence and timestamp limits (Finding A)
      if (!effectiveTrackingStartedAt) {
        const diagnostic: SanitizedRowDiagnostic = {
          rowIndex,
          fieldName: 'ordered_at',
          reasonCode: 'missing_tracking_start_evidence',
          diagnosticMessage:
            'Authoritative venue tracking-start date is not established; historical orders cannot establish event association without tracking activation',
        };
        await insertQuarantine(client, venueId, batchId, diagnostic);
        diagnostics.push(diagnostic);
        quarantinedRows++;
        continue;
      }

      const timeCheck = classifyOrderTimestampWindow(data.ordered_at || '', nowIso, {
        maxHistoricalDays: options.maxHistoricalDays,
        trackingStartedAt: effectiveTrackingStartedAt,
      });
      if (!timeCheck.valid) {
        const diagnostic: SanitizedRowDiagnostic = {
          rowIndex,
          fieldName: 'ordered_at',
          reasonCode: timeCheck.reasonCode,
          diagnosticMessage: timeCheck.message,
        };
        await insertQuarantine(client, venueId, batchId, diagnostic);
        diagnostics.push(diagnostic);
        quarantinedRows++;
        continue;
      }

      // Validate canonical menu_revision_id format before resolution
      if (data.menu_revision_id && !CANONICAL_UUID_PATTERN.test(data.menu_revision_id.trim())) {
        const diagnostic: SanitizedRowDiagnostic = {
          rowIndex,
          fieldName: 'menu_revision_id',
          reasonCode: 'invalid_format',
          diagnosticMessage: 'menu_revision_id must be a valid canonical UUID',
        };
        await insertQuarantine(client, venueId, batchId, diagnostic);
        diagnostics.push(diagnostic);
        quarantinedRows++;
        continue;
      }

      // Resolve Menu Revision & Dish Mapping
      let canonicalMenuRevId: string;
      let canonicalDishId: string;
      let canonicalDishRevId: string;

      const hasExplicitCanonicalIds = Boolean(
        data.menu_revision_id && data.dish_id && data.dish_revision_id,
      );
      const posItemCode = data.pos_item_id || data.pos_item_code;

      if (hasExplicitCanonicalIds) {
        const revRes = revisionResolutions.get(data.menu_revision_id!);
        if (!revRes || !revRes.valid) {
          const diagnostic: SanitizedRowDiagnostic = {
            rowIndex,
            fieldName: 'menu_revision_id',
            reasonCode: revRes ? revRes.reasonCode : 'unsupported_menu_revision',
            diagnosticMessage: revRes
              ? revRes.message
              : 'Menu revision is not authorized or approved for this venue',
          };
          await insertQuarantine(client, venueId, batchId, diagnostic);
          diagnostics.push(diagnostic);
          quarantinedRows++;
          continue;
        }

        // Enforce actual publication and withdrawal history at ordered_at (Finding D)
        const activePubs = await getActiveMenuPublicationsAtTimestamp(
          client,
          venueId,
          data.ordered_at!,
        );
        const isRevisionActive = activePubs.some(
          (p) => p.eventType === 'menu.published' && p.menuRevisionId === data.menu_revision_id,
        );
        if (!isRevisionActive) {
          const diagnostic: SanitizedRowDiagnostic = {
            rowIndex,
            fieldName: 'menu_revision_id',
            reasonCode: 'out_of_revision_window',
            diagnosticMessage: 'Specified menu revision was not active at order timestamp',
          };
          await insertQuarantine(client, venueId, batchId, diagnostic);
          diagnostics.push(diagnostic);
          quarantinedRows++;
          continue;
        }

        if (!revRes.dishMap.has(data.dish_id!)) {
          const diagnostic: SanitizedRowDiagnostic = {
            rowIndex,
            fieldName: 'dish_id',
            reasonCode: 'unmatched_dish',
            diagnosticMessage: 'Dish is not present in the specified menu revision',
          };
          await insertQuarantine(client, venueId, batchId, diagnostic);
          diagnostics.push(diagnostic);
          quarantinedRows++;
          continue;
        }

        const expectedDishRevId = revRes.dishMap.get(data.dish_id!);
        if (expectedDishRevId !== data.dish_revision_id) {
          const diagnostic: SanitizedRowDiagnostic = {
            rowIndex,
            fieldName: 'dish_revision_id',
            reasonCode: 'unsupported_dish_revision',
            diagnosticMessage:
              'Dish revision does not match the published revision in the menu bundle',
          };
          await insertQuarantine(client, venueId, batchId, diagnostic);
          diagnostics.push(diagnostic);
          quarantinedRows++;
          continue;
        }

        canonicalMenuRevId = data.menu_revision_id!;
        canonicalDishId = data.dish_id!;
        canonicalDishRevId = data.dish_revision_id!;
      } else if (posItemCode && posItemCode.trim().length > 0) {
        const cleanCode = posItemCode.trim();

        // Validate POS item identifier before database lookup (no raw values leaked, bounded length)
        const posIdentifierParse = OrderTokenIdentifierSchema.safeParse(cleanCode);
        if (!posIdentifierParse.success) {
          const isProhibited =
            cleanCode.includes('@') || CONSECUTIVE_DIGITS_PATTERN.test(cleanCode);
          const diagnostic: SanitizedRowDiagnostic = {
            rowIndex,
            fieldName: data.pos_item_id ? 'pos_item_id' : 'pos_item_code',
            reasonCode: isProhibited ? 'prohibited_identifier' : 'invalid_format',
            diagnosticMessage: isProhibited
              ? 'Identifier contains disallowed characters or patterns'
              : 'POS item identifier must contain only safe ASCII characters up to 128 bytes',
          };
          await insertQuarantine(client, venueId, batchId, diagnostic);
          diagnostics.push(diagnostic);
          quarantinedRows++;
          continue;
        }

        // Query reviewed POS mapping from app_private.pos_dish_mappings
        const mappingRes = await client.query<{
          dish_id: string;
          dish_name: string | null;
          review_status: 'pending' | 'approved' | 'rejected';
          reviewed_by: string | null;
          reviewed_at: Date | null;
        }>(
          `SELECT dish_id, dish_name, review_status, reviewed_by, reviewed_at
           FROM app_private.pos_dish_mappings
           WHERE tenant_id = $1 AND pos_item_code = $2`,
          [venueId, cleanCode],
        );

        const mapping = mappingRes.rows[0];
        if (!mapping) {
          const diagnostic: SanitizedRowDiagnostic = {
            rowIndex,
            fieldName: 'pos_item_id',
            reasonCode: 'missing_pos_mapping',
            diagnosticMessage: 'POS item code has no registered mapping in PeekaPlate',
          };
          await insertQuarantine(client, venueId, batchId, diagnostic);
          diagnostics.push(diagnostic);
          quarantinedRows++;
          continue;
        }

        if (mapping.review_status !== 'approved') {
          const diagnostic: SanitizedRowDiagnostic = {
            rowIndex,
            fieldName: 'pos_item_id',
            reasonCode: 'unreviewed_pos_mapping',
            diagnosticMessage:
              'POS item mapping has not been approved (reviewed approval required)',
          };
          await insertQuarantine(client, venueId, batchId, diagnostic);
          diagnostics.push(diagnostic);
          quarantinedRows++;
          continue;
        }

        // Resolve active menu revision at order timestamp
        const revRes = await resolveActiveMenuRevisionAtTimestamp(
          client,
          venueId,
          data.ordered_at!,
          options.bundleLoader,
          revisionResolutions,
        );

        if (!revRes.valid) {
          const diagnostic: SanitizedRowDiagnostic = {
            rowIndex,
            fieldName: 'ordered_at',
            reasonCode: revRes.reasonCode,
            diagnosticMessage: revRes.message,
          };
          await insertQuarantine(client, venueId, batchId, diagnostic);
          diagnostics.push(diagnostic);
          quarantinedRows++;
          continue;
        }

        // Verify mapped canonical dish exists in published menu bundle active at order timestamp
        if (!revRes.dishMap.has(mapping.dish_id)) {
          const diagnostic: SanitizedRowDiagnostic = {
            rowIndex,
            fieldName: 'pos_item_id',
            reasonCode: 'unmatched_dish',
            diagnosticMessage:
              'Dish mapped from POS code is not present in the published menu revision active at order timestamp',
          };
          await insertQuarantine(client, venueId, batchId, diagnostic);
          diagnostics.push(diagnostic);
          quarantinedRows++;
          continue;
        }

        canonicalMenuRevId = revRes.menuRevisionId;
        canonicalDishId = mapping.dish_id;
        canonicalDishRevId = revRes.dishMap.get(mapping.dish_id)!;
      } else {
        const diagnostic: SanitizedRowDiagnostic = {
          rowIndex,
          fieldName: 'pos_item_id',
          reasonCode: 'missing_pos_identifier',
          diagnosticMessage:
            'Row requires a reviewed POS item code (pos_item_id); dish_name alone cannot establish an approved mapping',
        };
        await insertQuarantine(client, venueId, batchId, diagnostic);
        diagnostics.push(diagnostic);
        quarantinedRows++;
        continue;
      }

      // Construct and validate normalized canonical outcome line
      const canonicalData = {
        schema_version: 'pilot_order_outcome.v1' as const,
        order_id: data.order_id!,
        order_line_id: data.order_line_id!,
        ordered_at: data.ordered_at!,
        menu_revision_id: canonicalMenuRevId,
        dish_id: canonicalDishId,
        dish_revision_id: canonicalDishRevId,
        outcome_type: data.outcome_type as OrderOutcomeType,
        quantity: qty,
        unit_price: hasUnitPrice ? data.unit_price! : undefined,
        currency: hasCurrency ? data.currency! : undefined,
      };

      const lineParse = OrderOutcomeLineSchema.safeParse(canonicalData);
      if (!lineParse.success) {
        const issue = lineParse.error.issues[0];
        const diagnostic: SanitizedRowDiagnostic = {
          rowIndex,
          fieldName: issue?.path[0] ? String(issue.path[0]) : null,
          reasonCode: 'invalid_format',
          diagnosticMessage: issue?.message
            ? issue.message.slice(0, 500)
            : 'Canonical line validation failed',
        };
        await insertQuarantine(client, venueId, batchId, diagnostic);
        diagnostics.push(diagnostic);
        quarantinedRows++;
        continue;
      }

      const line = lineParse.data;

      // Compute canonical payload checksum
      const checksum = await computeOrderLineChecksum({
        menuRevisionId: line.menu_revision_id,
        dishId: line.dish_id,
        dishRevisionId: line.dish_revision_id,
        orderedAt: line.ordered_at,
        outcomeType: line.outcome_type,
        quantity: line.quantity,
        unitPrice: line.unit_price ?? null,
        currency: line.currency ?? null,
      });

      // Encode composite order identity tuple without delimiter collisions (Finding F)
      const lineIdentity = JSON.stringify([line.order_id, line.order_line_id, line.outcome_type]);

      // In-batch duplicate / conflict check
      if (seenInBatch.has(lineIdentity)) {
        const existingBatchChecksum = seenInBatch.get(lineIdentity)!;
        if (existingBatchChecksum === checksum) {
          duplicateRows++;
          continue;
        }
        // Different checksum in the same batch: conflict
        await insertConflict(
          client,
          venueId,
          batchId,
          line.order_id,
          line.order_line_id,
          line.outcome_type,
          existingBatchChecksum,
          checksum,
        );
        conflictRows++;
        continue;
      }
      seenInBatch.set(lineIdentity, checksum);

      // Check database for existing order line
      const existingDbLine = await client.query<{ payload_checksum: string }>(
        `SELECT payload_checksum
         FROM app_private.order_outcome_lines
         WHERE tenant_id = $1 AND order_id = $2 AND order_line_id = $3 AND outcome_type = $4`,
        [venueId, line.order_id, line.order_line_id, line.outcome_type],
      );

      if (existingDbLine.rows.length > 0) {
        const storedChecksum = existingDbLine.rows[0]!.payload_checksum;
        if (storedChecksum === checksum) {
          duplicateRows++;
          continue;
        }
        // Conflict with previously accepted line: preserve canonical record, record in conflicts table
        await insertConflict(
          client,
          venueId,
          batchId,
          line.order_id,
          line.order_line_id,
          line.outcome_type,
          storedChecksum,
          checksum,
        );
        conflictRows++;
        continue;
      }

      // Insert new accepted order outcome line
      await client.query(
        `INSERT INTO app_private.order_outcome_lines
          (tenant_id, order_id, order_line_id, batch_id, ordered_at, menu_revision_id, dish_id, dish_revision_id,
           outcome_type, quantity, unit_price, currency, payload_checksum)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          venueId,
          line.order_id,
          line.order_line_id,
          batchId,
          line.ordered_at,
          line.menu_revision_id,
          line.dish_id,
          line.dish_revision_id,
          line.outcome_type,
          line.quantity,
          line.unit_price ? Number.parseFloat(line.unit_price) : null,
          line.currency ?? null,
          checksum,
        ],
      );
      acceptedRows++;
    }

    // 10. Update batch status to completed
    await client.query(
      `UPDATE app_private.order_outcome_import_batches
       SET total_rows = $3,
           accepted_rows = $4,
           duplicate_rows = $5,
           quarantined_rows = $6,
           conflict_rows = $7,
           status = 'completed',
           finished_at = now()
       WHERE tenant_id = $1 AND id = $2`,
      [
        venueId,
        batchId,
        parseResult.rows.length,
        acceptedRows,
        duplicateRows,
        quarantinedRows,
        conflictRows,
      ],
    );

    commitAttempted = true;
    await client.query('COMMIT');
    inTx = false;

    return {
      batchId,
      venueId,
      status: 'completed',
      totalRows: parseResult.rows.length,
      acceptedRows,
      duplicateRows,
      quarantinedRows,
      conflictRows,
      isDuplicateFile: false,
      fileSha256,
      diagnostics,
      createdAt: nowIso,
      finishedAt: new Date().toISOString(),
    };
  } catch (error) {
    if (inTx) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Rollback failure preserved
      }
    }
    // Only perform compensating archive deletion on confirmed transaction failure BEFORE commit.
    // If COMMIT was already attempted, the outcome is uncertain (PostgreSQL may have committed the transaction
    // before the client lost the connection/acknowledgement). In that case, preserve the archive
    // so committed batches retain their source archive, leaving orphan cleanup / retry to reconcile safely.
    if (!commitAttempted && options.storage && typeof options.storage.delete === 'function') {
      try {
        await options.storage.delete(storageKey);
      } catch {
        // Compensating cleanup failure suppressed to bubble root cause
      }
    }
    throw error;
  }
}

async function insertQuarantine(
  client: Client,
  venueId: string,
  batchId: string,
  diagnostic: SanitizedRowDiagnostic,
): Promise<void> {
  const boundedMessage =
    diagnostic.diagnosticMessage.length > 500
      ? diagnostic.diagnosticMessage.slice(0, 500)
      : diagnostic.diagnosticMessage;
  const boundedFieldName = diagnostic.fieldName
    ? diagnostic.fieldName.length > 64
      ? diagnostic.fieldName.slice(0, 64)
      : diagnostic.fieldName
    : null;

  await client.query(
    `INSERT INTO app_private.order_outcome_quarantine
      (id, tenant_id, batch_id, row_index, reason_code, field_name, diagnostic_message)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      randomUUID(),
      venueId,
      batchId,
      diagnostic.rowIndex,
      diagnostic.reasonCode,
      boundedFieldName,
      boundedMessage,
    ],
  );
}

async function insertConflict(
  client: Client,
  venueId: string,
  batchId: string,
  orderId: string,
  orderLineId: string,
  outcomeType: string,
  existingChecksum: string,
  incomingChecksum: string,
): Promise<void> {
  await client.query(
    `INSERT INTO app_private.order_outcome_conflicts
      (tenant_id, order_id, order_line_id, outcome_type, batch_id, existing_checksum, incoming_checksum)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (tenant_id, order_id, order_line_id, outcome_type, incoming_checksum) DO NOTHING`,
    [venueId, orderId, orderLineId, outcomeType, batchId, existingChecksum, incomingChecksum],
  );
}

async function resolveMenuRevision(
  client: Client,
  venueId: string,
  menuRevisionId: string,
  bundleLoader?: OrderOutcomeBundleLoader,
): Promise<MenuRevisionResolution> {
  // Query menu approval and public bundle for this venue
  const res = await client.query<{
    bundle_url: string;
    content_hash: string;
  }>(
    `SELECT bundle.bundle_url, approval.content_hash
     FROM app_private.menu_approval approval
     JOIN app_private.public_menu_bundle bundle
       ON bundle.tenant_id = approval.tenant_id
      AND bundle.menu_id = approval.menu_id
      AND bundle.menu_revision_id = approval.menu_revision_id
     WHERE approval.tenant_id = $1 AND approval.menu_revision_id = $2`,
    [venueId, menuRevisionId],
  );

  const row = res.rows[0];
  if (!row) {
    return {
      valid: false,
      reasonCode: 'unsupported_menu_revision',
      message: 'Menu revision is not approved or published for this venue',
    };
  }

  if (!bundleLoader) {
    // If no bundle loader is supplied, try default fetch
    bundleLoader = async (url: string) => {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching menu bundle`);
      return resp.text();
    };
  }

  let bundleRaw: unknown;
  try {
    const rawContent = await bundleLoader(row.bundle_url);
    if (typeof rawContent === 'string') {
      const computedHash = await sha256(rawContent);
      if (computedHash !== row.content_hash) {
        return {
          valid: false,
          reasonCode: 'unsupported_menu_revision',
          message: 'Published menu bundle content hash mismatch',
        };
      }
      bundleRaw = JSON.parse(rawContent);
    } else {
      bundleRaw = rawContent;
    }
  } catch (err: unknown) {
    return {
      valid: false,
      reasonCode: 'unsupported_menu_revision',
      message: `Failed to load published menu bundle: ${err instanceof Error ? err.message : 'Unknown error'}`,
    };
  }

  const parsedBundle = PublicMenuContentBundleSchema.safeParse(bundleRaw);
  if (!parsedBundle.success) {
    return {
      valid: false,
      reasonCode: 'unsupported_menu_revision',
      message: 'Published menu bundle does not conform to PublicMenuContentBundleSchema',
    };
  }

  const bundle = parsedBundle.data;
  if (bundle.venue_id !== venueId || bundle.menu_revision_id !== menuRevisionId) {
    return {
      valid: false,
      reasonCode: 'cross_venue_forbidden',
      message: 'Published menu bundle does not match authorized venue or revision identity',
    };
  }

  const dishMap = new Map<string, string>();
  const dishes: DishInfo[] = [];
  for (const category of bundle.categories) {
    for (const dish of category.dishes) {
      dishMap.set(dish.dish_id, dish.dish_revision_id);
      dishes.push({
        dish_id: dish.dish_id,
        dish_revision_id: dish.dish_revision_id,
        name: dish.complete ? dish.name : '',
      });
    }
  }

  return {
    valid: true,
    menuRevisionId,
    dishMap,
    dishes,
  };
}

async function getActiveMenuPublicationsAtTimestamp(
  client: Client,
  venueId: string,
  orderedAtIso: string,
): Promise<{ menuId: string; menuRevisionId: string | null; eventType: string }[]> {
  const res = await client.query<{
    menu_id: string;
    event_type: string;
    menu_revision_id: string | null;
  }>(
    `SELECT DISTINCT ON (e.stream_id)
       e.stream_id AS menu_id,
       e.event_type,
       a.menu_revision_id
     FROM app_private.es_event e
     LEFT JOIN app_private.menu_approval a
       ON a.tenant_id = e.tenant_id
      AND a.approval_id = (e.payload->>'approvalId')::uuid
     WHERE e.tenant_id = $1
       AND e.stream_type = 'menu_publication'
       AND e.occurred_at <= $2
     ORDER BY e.stream_id, e.version DESC, e.occurred_at DESC`,
    [venueId, orderedAtIso],
  );

  return res.rows.map((r) => ({
    menuId: r.menu_id,
    menuRevisionId: r.menu_revision_id,
    eventType: r.event_type,
  }));
}

async function resolveActiveMenuRevisionAtTimestamp(
  client: Client,
  venueId: string,
  orderedAtIso: string,
  bundleLoader?: OrderOutcomeBundleLoader,
  cache?: Map<string, MenuRevisionResolution>,
): Promise<MenuRevisionResolution> {
  const activePubs = await getActiveMenuPublicationsAtTimestamp(client, venueId, orderedAtIso);
  const publishedActive = activePubs.filter(
    (p) => p.eventType === 'menu.published' && p.menuRevisionId,
  );

  if (publishedActive.length === 0) {
    return {
      valid: false,
      reasonCode: 'out_of_revision_window',
      message: 'No published menu revision was active at order timestamp',
    };
  }

  if (publishedActive.length > 1) {
    return {
      valid: false,
      reasonCode: 'out_of_revision_window',
      message: 'Multiple active menus were published at order timestamp (ambiguous menu history)',
    };
  }

  const activePub = publishedActive[0];
  if (!activePub || !activePub.menuRevisionId) {
    return {
      valid: false,
      reasonCode: 'out_of_revision_window',
      message: 'No published menu revision was active at order timestamp',
    };
  }

  const menuRevisionId = activePub.menuRevisionId;
  if (cache?.has(menuRevisionId)) {
    return cache.get(menuRevisionId)!;
  }

  const resolution = await resolveMenuRevision(client, venueId, menuRevisionId, bundleLoader);
  if (cache) {
    cache.set(menuRevisionId, resolution);
  }
  return resolution;
}

export type CleanupOrphanedImportsOptions = {
  storage: OrderOutcomeStorage;
  client: Client;
  venueId?: string | undefined;
  retentionConfig?: OrderOutcomeRetentionConfig | undefined;
  gracePeriodMs?: number | undefined; // legacy backwards compat
  now?: (() => Date) | undefined;
};

export type CleanupOrphanedImportsResult = {
  scanned: number;
  deleted: number;
  deletedOrphans: number;
  deletedAgedRawCsv: number;
  skippedActive: number;
  retained: number;
};

const ORDER_IMPORT_KEY_PATTERN = /^order-imports\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/source\.csv$/;

/**
 * Reconciles and prunes orphaned source CSV uploads in private R2 storage.
 *
 * An orphan occurs when:
 * 1. CSV upload to R2 succeeds.
 * 2. Worker crashes before the database transaction commits.
 * 3. No batch record exists in `app_private.order_outcome_import_batches`.
 * 4. Compensating cleanup could not execute.
 *
 * Safety guarantees:
 * - Grace Period: Objects younger than orphanGracePeriodMs (default 2 hours) are strictly skipped
 *   to ensure in-flight active transactions are never deleted.
 * - Raw CSV Retention: Configurable policy (default 90 days, pilot proposal) prunes aged source CSVs
 *   while preserving append-only normalized outcome records in the database.
 * - Key Validation: Matches strict UUID regex `order-imports/<tenant_id>/<batch_id>/source.csv`.
 * - Database Check: Confirms against `order_outcome_import_batches`. If a batch record exists,
 *   the object is preserved unless it has exceeded the configured retention window.
 * - Idempotent: Calling repeatedly produces identical safe state.
 */
export async function cleanupOrphanedOrderImports(
  options: CleanupOrphanedImportsOptions,
): Promise<CleanupOrphanedImportsResult> {
  const result: CleanupOrphanedImportsResult = {
    scanned: 0,
    deleted: 0,
    deletedOrphans: 0,
    deletedAgedRawCsv: 0,
    skippedActive: 0,
    retained: 0,
  };

  if (!options.storage.list || !options.storage.delete) {
    return result;
  }

  const nowMs = (options.now ? options.now() : new Date()).getTime();
  const gracePeriodMs =
    options.retentionConfig?.orphanGracePeriodMs ?? options.gracePeriodMs ?? 7_200_000;
  const retentionDays =
    options.retentionConfig?.rawCsvRetentionDays ?? DEFAULT_RAW_CSV_RETENTION_DAYS;
  const rawCsvRetentionMs = BigInt(retentionDays) * 24n * 60n * 60n * 1000n;
  const prefix = options.venueId ? `order-imports/${options.venueId}/` : 'order-imports/';

  let cursor: string | undefined;
  do {
    const listResult = await options.storage.list({ prefix, cursor, limit: 100 });
    for (const obj of listResult.objects) {
      result.scanned++;
      const match = obj.key.match(ORDER_IMPORT_KEY_PATTERN);
      if (!match) {
        // Non-standard key: retain safely
        result.retained++;
        continue;
      }

      const [, tenantId, batchId] = match;
      if (!tenantId || !batchId) {
        result.retained++;
        continue;
      }

      // If venueId is specified, ensure key belongs to that venue
      if (options.venueId && tenantId !== options.venueId) {
        result.retained++;
        continue;
      }

      // Check object upload time against active grace period
      const uploadedMs = obj.uploaded ? new Date(obj.uploaded).getTime() : nowMs;
      if (nowMs - uploadedMs < gracePeriodMs) {
        // Within active grace period; preserve to protect in-flight active imports
        result.skippedActive++;
        continue;
      }

      // Check if batch exists in database within an explicit transaction to ensure
      // transaction-local `set_config(..., true)` is active for RLS and connection-leak-free
      let batchExists = false;
      let queryFailed = false;

      try {
        await options.client.query('BEGIN');
        await options.client.query("SET LOCAL statement_timeout = '5s'");
        await options.client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);

        const batchCheck = await options.client.query<{ id: string; status: string }>(
          `SELECT id, status FROM app_private.order_outcome_import_batches WHERE tenant_id = $1 AND id = $2`,
          [tenantId, batchId],
        );
        batchExists = batchCheck.rows.length > 0;
        await options.client.query('COMMIT');
      } catch {
        queryFailed = true;
        try {
          await options.client.query('ROLLBACK');
        } catch {
          // Suppress rollback failure
        }
      }

      if (queryFailed) {
        // Database query failed: fail closed and preserve object in R2
        result.retained++;
        continue;
      }

      if (!batchExists) {
        // Confirmed orphan: no DB record exists after grace period
        await options.storage.delete(obj.key);
        result.deletedOrphans++;
        result.deleted++;
      } else {
        // DB record exists: check raw CSV retention policy (Finding I)
        // Destructive purge of raw source files requires explicit approval and configuration
        const purgeEnabled = options.retentionConfig?.enableRawCsvPurge === true;
        const ageMs = BigInt(nowMs - uploadedMs);
        if (purgeEnabled && ageMs >= rawCsvRetentionMs) {
          // Object exceeded raw CSV retention period: safely prune from storage
          await options.storage.delete(obj.key);
          result.deletedAgedRawCsv++;
          result.deleted++;
        } else {
          result.retained++;
        }
      }
    }

    cursor = listResult.truncated ? listResult.cursor : undefined;
  } while (cursor);

  return result;
}

export type AcceptPilotOrderAgreementOptions = {
  client: Client;
  actorId: string;
  venueId: string;
  agreementVersion: string;
};

/**
 * Records a venue owner's acceptance of the S6-DATA-14.1 pilot order-outcome agreement.
 * Idempotent per (venueId, agreementVersion).
 */
export async function acceptPilotOrderAgreement(
  options: AcceptPilotOrderAgreementOptions,
): Promise<AcceptPilotOrderAgreementResponse> {
  const { client, actorId, venueId, agreementVersion } = options;
  if (agreementVersion !== PILOT_ORDER_AGREEMENT_VERSION) {
    throw new OrderImportError(
      'invalid_agreement_version',
      400,
      `Agreement version must match current pilot version (${PILOT_ORDER_AGREEMENT_VERSION})`,
    );
  }

  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL lock_timeout = '3s'");
    await client.query("SELECT set_config('app.actor_id', $1, true)", [actorId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [venueId]);

    const membership = await client.query<{ permission: string }>(
      `SELECT permission
       FROM app_private.staff_membership
       WHERE tenant_id = $1 AND actor_id = $2
       FOR SHARE`,
      [venueId, actorId],
    );

    if (membership.rows[0]?.permission !== 'owner') {
      throw new OrderImportError(
        'forbidden',
        403,
        'Accepting the pilot order-outcome agreement requires owner permission',
      );
    }

    const inserted = await client.query<{
      agreement_version: string;
      accepted_by: string;
      accepted_at: Date;
    }>(
      `INSERT INTO app_private.pilot_order_agreement_acceptances (
         id, tenant_id, agreement_version, accepted_by
       ) VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, agreement_version) DO NOTHING
       RETURNING agreement_version, accepted_by, accepted_at`,
      [randomUUID(), venueId, agreementVersion, actorId],
    );

    if (inserted.rows.length > 0) {
      await client.query('COMMIT');
      const row = inserted.rows[0]!;
      return {
        venueId,
        agreementVersion: row.agreement_version,
        acceptedBy: row.accepted_by,
        acceptedAt: row.accepted_at.toISOString(),
        alreadyAccepted: false,
      };
    }

    const existing = await client.query<{
      agreement_version: string;
      accepted_by: string;
      accepted_at: Date;
    }>(
      `SELECT agreement_version, accepted_by, accepted_at
       FROM app_private.pilot_order_agreement_acceptances
       WHERE tenant_id = $1 AND agreement_version = $2`,
      [venueId, agreementVersion],
    );

    if (existing.rows.length === 0) {
      throw new OrderImportError(
        'agreement_acceptance_failed',
        500,
        'Failed to record or retrieve pilot order-outcome agreement acceptance',
      );
    }

    await client.query('COMMIT');
    const row = existing.rows[0]!;
    return {
      venueId,
      agreementVersion: row.agreement_version,
      acceptedBy: row.accepted_by,
      acceptedAt: row.accepted_at.toISOString(),
      alreadyAccepted: true,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

export type SubmitOrderDataDeletionRequestOptions = {
  client: Client;
  actorId: string;
  venueId: string;
  requestId: string;
  reason?: OrderDataDeletionReason | undefined;
};

/**
 * Submits an owner's order-data deletion request (S6-DATA-14.2 P0).
 * Immediately blocks new imports for the venue while awaiting manual operator execution.
 * Idempotent per (venueId, requestId).
 */
export async function submitOrderDataDeletionRequest(
  options: SubmitOrderDataDeletionRequestOptions,
): Promise<SubmitOrderDeletionResponse> {
  const { client, actorId, venueId, requestId, reason } = options;

  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL lock_timeout = '3s'");
    await client.query("SELECT set_config('app.actor_id', $1, true)", [actorId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [venueId]);

    const membership = await client.query<{ permission: string }>(
      `SELECT permission
       FROM app_private.staff_membership
       WHERE tenant_id = $1 AND actor_id = $2
       FOR SHARE`,
      [venueId, actorId],
    );

    if (membership.rows[0]?.permission !== 'owner') {
      throw new OrderImportError(
        'forbidden',
        403,
        'Submitting an order-data deletion request requires owner permission',
      );
    }

    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `order_lifecycle:${venueId}`,
    ]);

    const inserted = await client.query<{
      id: string;
      status: string;
      reason: OrderDataDeletionReason | null;
      requested_at: Date;
    }>(
      `INSERT INTO app_private.order_data_deletion_requests (
         id, tenant_id, requested_by, reason, status
       ) VALUES ($1, $2, $3, $4, 'requested')
       ON CONFLICT (tenant_id, id) DO NOTHING
       RETURNING id, status, reason, requested_at`,
      [requestId, venueId, actorId, reason ?? null],
    );

    if (inserted.rows.length > 0) {
      await client.query('COMMIT');
      const row = inserted.rows[0]!;
      return {
        requestId: row.id,
        venueId,
        status: 'requested',
        reason: row.reason ?? null,
        requestedAt: row.requested_at.toISOString(),
        alreadyExists: false,
      };
    }

    const existing = await client.query<{
      id: string;
      status: 'requested' | 'executing' | 'r2_deleted' | 'completed' | 'failed';
      reason: OrderDataDeletionReason | null;
      requested_at: Date;
    }>(
      `SELECT id, status, reason, requested_at
       FROM app_private.order_data_deletion_requests
       WHERE tenant_id = $1 AND id = $2`,
      [venueId, requestId],
    );

    if (existing.rows.length === 0) {
      throw new OrderImportError(
        'deletion_request_failed',
        500,
        'Failed to record or retrieve order-data deletion request',
      );
    }

    await client.query('COMMIT');
    const row = existing.rows[0]!;
    return {
      requestId: row.id,
      venueId,
      status: row.status,
      reason: row.reason ?? null,
      requestedAt: row.requested_at.toISOString(),
      alreadyExists: true,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

export type DeleteVenueOrderDataOptions = {
  client: Client;
  operatorId: string;
  venueId: string;
  requestId: string;
  storage?: OrderOutcomeStorage | undefined;
  authorizedOperatorIds: ReadonlySet<string>;
  executionLeaseMs?: number | undefined;
  now?: (() => Date) | undefined;
};

async function recordDeletionFailureBestEffort(
  client: Client,
  operatorId: string,
  venueId: string,
  requestId: string,
  executionToken: string,
  errorCode: string,
): Promise<void> {
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '3s'");
    await client.query("SELECT set_config('app.actor_id', $1, true)", [operatorId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [venueId]);
    await client.query(
      `UPDATE app_private.order_data_deletion_requests
       SET status = 'failed',
           error_code = $3,
           execution_token = NULL,
           execution_lease_expires_at = NULL
       WHERE id = $1 AND tenant_id = $2 AND execution_token = $4 AND status <> 'completed'`,
      [requestId, venueId, errorCode, executionToken],
    );
    await client.query('COMMIT');
  } catch {
    await client.query('ROLLBACK').catch(() => {});
  }
}

/**
 * Operator-executed deletion of all order-outcome data for a single venue (S6-DATA-14.2 P0):
 * 1. Verifies authorized operator and an existing owner-submitted deletion request.
 * 2. Deletes all original CSV objects for the venue in private R2 storage.
 * 3. Deletes database rows via the privileged `app_private.delete_venue_order_data` function.
 * 4. Writes a non-PII deletion ledger receipt in R2 for backup-restore reconciliation.
 * Never claims success if R2 or DB deletion fails; safe to retry with the same `requestId`.
 */
export async function deleteVenueOrderData(
  options: DeleteVenueOrderDataOptions,
): Promise<DeleteOrderDataResponse> {
  const {
    client,
    operatorId,
    venueId,
    requestId,
    storage,
    authorizedOperatorIds,
    executionLeaseMs = 5 * 60 * 1000,
    now = () => new Date(),
  } = options;

  if (
    !operatorId ||
    !CANONICAL_UUID_PATTERN.test(operatorId) ||
    !authorizedOperatorIds ||
    authorizedOperatorIds.size === 0 ||
    !authorizedOperatorIds.has(operatorId)
  ) {
    throw new OrderImportError(
      'forbidden',
      403,
      'Order data deletion execution requires an authorized internal operator',
    );
  }

  if (
    !storage ||
    typeof storage.list !== 'function' ||
    typeof storage.delete !== 'function' ||
    typeof storage.put !== 'function'
  ) {
    throw new OrderImportError(
      'storage_unavailable',
      503,
      'Order outcome archive storage is unavailable; cannot verify or complete R2 deletion',
    );
  }

  const intentKey = `order-deletion-ledger/${venueId}/${requestId}/intent.json`;
  const completedKey = `order-deletion-ledger/${venueId}/${requestId}/completed.json`;
  const leaseMs = Math.max(50, executionLeaseMs);
  const executionToken = randomUUID();
  let lastRenewedAtMs = now().getTime();
  let storageKeysFromDb: string[] = [];

  const renewExecutionLeaseOrThrow = async (): Promise<void> => {
    const currentMs = now().getTime();
    const newExpiry = new Date(currentMs + leaseMs);
    await client.query('BEGIN');
    try {
      await client.query("SET LOCAL statement_timeout = '3s'");
      await client.query("SELECT set_config('app.actor_id', $1, true)", [operatorId]);
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [venueId]);
      const renewed = await client.query<{ id: string }>(
        `UPDATE app_private.order_data_deletion_requests
         SET execution_lease_expires_at = $4
         WHERE id = $1 AND tenant_id = $2 AND status = 'executing' AND execution_token = $3
         RETURNING id`,
        [requestId, venueId, executionToken, newExpiry],
      );
      await client.query('COMMIT');
      if (renewed.rowCount === 0) {
        throw new OrderImportError(
          'deletion_lease_lost',
          409,
          'Order data deletion execution lease was lost to another worker',
        );
      }
      lastRenewedAtMs = currentMs;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (err instanceof OrderImportError) {
        throw err;
      }
      throw new OrderImportError(
        'deletion_lease_lost',
        409,
        'Failed to renew order data deletion execution lease',
      );
    }
  };

  const putCreateOnly = async (key: string, payload: Record<string, unknown>): Promise<void> => {
    try {
      await storage.put(key, JSON.stringify(payload), {
        httpMetadata: { contentType: 'application/json' },
        onlyIf: { etagDoesNotMatch: '*' },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/precondition|412|already exists/i.test(msg)) {
        return;
      }
      throw err;
    }
  };

  // Phase 1: Require existing owner-submitted request, check idempotency, claim fenced 'executing' lease
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL lock_timeout = '3s'");
    await client.query("SELECT set_config('app.actor_id', $1, true)", [operatorId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [venueId]);

    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `order_lifecycle:${venueId}`,
    ]);

    const existingRequest = await client.query<{
      status: string;
      executed_by: string | null;
      execution_lease_expires_at: Date | null;
      r2_objects_deleted: number;
      db_batches_deleted: number;
      db_lines_deleted: number;
      db_quarantine_deleted: number;
      db_conflicts_deleted: number;
      completed_at: Date | null;
    }>(
      `SELECT status, executed_by, execution_lease_expires_at, r2_objects_deleted, db_batches_deleted, db_lines_deleted,
              db_quarantine_deleted, db_conflicts_deleted, completed_at
       FROM app_private.order_data_deletion_requests
       WHERE id = $1 AND tenant_id = $2
       FOR UPDATE`,
      [requestId, venueId],
    );

    if (existingRequest.rows.length === 0) {
      throw new OrderImportError(
        'deletion_request_not_found',
        404,
        'Order data deletion requires an existing owner-submitted deletion request',
      );
    }

    const row = existingRequest.rows[0]!;
    if (row.status === 'completed') {
      await client.query('COMMIT');
      const completedAtIso = (row.completed_at ?? now()).toISOString();
      const resolvedOperatorId = row.executed_by ?? operatorId;
      await putCreateOnly(completedKey, {
        requestId,
        venueId,
        operatorId: resolvedOperatorId,
        status: 'completed',
        r2ObjectsDeleted: row.r2_objects_deleted,
        dbBatchesDeleted: row.db_batches_deleted,
        dbLinesDeleted: row.db_lines_deleted,
        dbQuarantineDeleted: row.db_quarantine_deleted,
        dbConflictsDeleted: row.db_conflicts_deleted,
        completedAt: completedAtIso,
      }).catch(() => {});
      return {
        requestId,
        venueId,
        status: 'completed',
        operatorId: resolvedOperatorId,
        r2ObjectsDeleted: row.r2_objects_deleted,
        dbBatchesDeleted: row.db_batches_deleted,
        dbLinesDeleted: row.db_lines_deleted,
        dbQuarantineDeleted: row.db_quarantine_deleted,
        dbConflictsDeleted: row.db_conflicts_deleted,
        completedAt: completedAtIso,
        alreadyCompleted: true,
      };
    }

    const claimNow = now();
    if (
      row.status === 'executing' &&
      row.execution_lease_expires_at &&
      row.execution_lease_expires_at.getTime() > claimNow.getTime()
    ) {
      throw new OrderImportError(
        'deletion_in_progress',
        409,
        'Order data deletion is already executing for this venue',
      );
    }

    const leaseExpiresAt = new Date(claimNow.getTime() + leaseMs);
    await client.query(
      `UPDATE app_private.order_data_deletion_requests
       SET status = 'executing',
           executed_by = $3,
           execution_token = $4,
           execution_started_at = $5,
           execution_lease_expires_at = $6,
           error_code = NULL
       WHERE id = $1 AND tenant_id = $2 AND status <> 'completed'`,
      [requestId, venueId, operatorId, executionToken, claimNow, leaseExpiresAt],
    );
    lastRenewedAtMs = claimNow.getTime();

    const batchKeys = await client.query<{ storage_key: string }>(
      `SELECT storage_key FROM app_private.order_outcome_import_batches WHERE tenant_id = $1`,
      [venueId],
    );
    storageKeysFromDb = batchKeys.rows.map((r) => r.storage_key);

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }

  // Phase 1b: Establish immutable external deletion intent in R2 BEFORE any destructive operation
  try {
    await putCreateOnly(intentKey, {
      requestId,
      venueId,
      operatorId,
      status: 'in_progress',
      intentRecordedAt: now().toISOString(),
    });
  } catch {
    await recordDeletionFailureBestEffort(
      client,
      operatorId,
      venueId,
      requestId,
      executionToken,
      'ledger_intent_failed',
    );
    throw new OrderImportError(
      'deletion_storage_failed',
      502,
      'Failed to record durable deletion intent in external ledger before destructive operations; retry with the same requestId',
    );
  }

  // Phase 2: Delete all venue CSV objects from private R2 storage with lease heartbeat & fencing
  const venuePrefix = `order-imports/${venueId}/`;
  const keysToDelete = new Set<string>(storageKeysFromDb.filter((k) => k.startsWith(venuePrefix)));
  let r2ObjectsDeleted = 0;

  try {
    let cursor: string | undefined;
    do {
      if (now().getTime() - lastRenewedAtMs >= leaseMs / 3) {
        await renewExecutionLeaseOrThrow();
      }
      const listResult = await storage.list({ prefix: venuePrefix, cursor, limit: 100 });
      for (const obj of listResult.objects) {
        if (obj.key.startsWith(venuePrefix)) {
          keysToDelete.add(obj.key);
        }
      }
      cursor = listResult.truncated ? listResult.cursor : undefined;
    } while (cursor);

    for (const key of keysToDelete) {
      if (now().getTime() - lastRenewedAtMs >= leaseMs / 3) {
        await renewExecutionLeaseOrThrow();
      }
      await storage.delete(key);
      r2ObjectsDeleted++;
    }
  } catch (err) {
    if (err instanceof OrderImportError && err.code === 'deletion_lease_lost') {
      throw err;
    }
    await recordDeletionFailureBestEffort(
      client,
      operatorId,
      venueId,
      requestId,
      executionToken,
      'r2_delete_failed',
    );
    throw new OrderImportError(
      'deletion_storage_failed',
      502,
      'Failed to delete one or more raw CSV objects from archive storage; retry with the same requestId',
    );
  }

  // Phase 3: Fenced DB deletion via reviewed SECURITY DEFINER function and finalize audit record
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL statement_timeout = '10s'");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SELECT set_config('app.actor_id', $1, true)", [operatorId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [venueId]);

    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `order_lifecycle:${venueId}`,
    ]);

    const fenceCheck = await client.query<{ status: string; execution_token: string | null }>(
      `SELECT status, execution_token
       FROM app_private.order_data_deletion_requests
       WHERE id = $1 AND tenant_id = $2
       FOR UPDATE`,
      [requestId, venueId],
    );

    const fenced = fenceCheck.rows[0];
    if (!fenced || fenced.status !== 'executing' || fenced.execution_token !== executionToken) {
      throw new OrderImportError(
        'deletion_lease_lost',
        409,
        'Order data deletion execution lease was lost before database deletion',
      );
    }

    await client.query(
      `UPDATE app_private.order_data_deletion_requests
       SET status = 'r2_deleted', r2_objects_deleted = $3, error_code = NULL
       WHERE id = $1 AND tenant_id = $2 AND execution_token = $4 AND status = 'executing'`,
      [requestId, venueId, r2ObjectsDeleted, executionToken],
    );

    const dbCounts = await client.query<{
      batches_deleted: number;
      lines_deleted: number;
      quarantine_deleted: number;
      conflicts_deleted: number;
    }>(
      `SELECT batches_deleted, lines_deleted, quarantine_deleted, conflicts_deleted
       FROM app_private.delete_venue_order_data($1, $2, $3, $4)`,
      [venueId, requestId, operatorId, executionToken],
    );

    const counts = dbCounts.rows[0] ?? {
      batches_deleted: 0,
      lines_deleted: 0,
      quarantine_deleted: 0,
      conflicts_deleted: 0,
    };

    const completed = await client.query<{ completed_at: Date }>(
      `UPDATE app_private.order_data_deletion_requests
       SET status = 'completed',
           executed_by = $8,
           execution_token = NULL,
           execution_lease_expires_at = NULL,
           r2_objects_deleted = $3,
           db_batches_deleted = $4,
           db_lines_deleted = $5,
           db_quarantine_deleted = $6,
           db_conflicts_deleted = $7,
           error_code = NULL,
           completed_at = now()
       WHERE id = $1 AND tenant_id = $2 AND execution_token = $9
       RETURNING completed_at`,
      [
        requestId,
        venueId,
        r2ObjectsDeleted,
        counts.batches_deleted,
        counts.lines_deleted,
        counts.quarantine_deleted,
        counts.conflicts_deleted,
        operatorId,
        executionToken,
      ],
    );

    await client.query('COMMIT');
    const completedAtIso = (completed.rows[0]?.completed_at ?? now()).toISOString();

    // Phase 4: Record immutable non-PII completion receipt in R2 (separate from intent.json)
    await putCreateOnly(completedKey, {
      requestId,
      venueId,
      operatorId,
      status: 'completed',
      r2ObjectsDeleted,
      dbBatchesDeleted: counts.batches_deleted,
      dbLinesDeleted: counts.lines_deleted,
      dbQuarantineDeleted: counts.quarantine_deleted,
      dbConflictsDeleted: counts.conflicts_deleted,
      completedAt: completedAtIso,
    }).catch(() => {});

    return {
      requestId,
      venueId,
      status: 'completed',
      operatorId,
      r2ObjectsDeleted,
      dbBatchesDeleted: counts.batches_deleted,
      dbLinesDeleted: counts.lines_deleted,
      dbQuarantineDeleted: counts.quarantine_deleted,
      dbConflictsDeleted: counts.conflicts_deleted,
      completedAt: completedAtIso,
      alreadyCompleted: false,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error instanceof OrderImportError && error.code === 'deletion_lease_lost') {
      throw error;
    }
    await recordDeletionFailureBestEffort(
      client,
      operatorId,
      venueId,
      requestId,
      executionToken,
      'db_delete_failed',
    );
    if (error instanceof OrderImportError) {
      throw error;
    }
    throw new OrderImportError(
      'deletion_db_failed',
      500,
      'Failed to delete database order-outcome records; retry with the same requestId',
    );
  }
}
