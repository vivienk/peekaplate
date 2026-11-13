import { z } from 'zod';
import { canonicalJson, parseIsoToMicroseconds, sha256 } from './index';

export const PILOT_ORDER_OUTCOME_SCHEMA_VERSION = 'pilot_order_outcome.v1' as const;
export const PILOT_ORDER_AGREEMENT_VERSION = 'v0.1' as const;
export const MAX_ORDER_OUTCOME_ROWS = 1000;
export const MAX_ORDER_OUTCOME_FILE_BYTES = 5 * 1024 * 1024; // 5 MiB

export const DEFAULT_HISTORICAL_IMPORT_WINDOW_DAYS = 90; // Pilot policy confirmed by Hemu
export const DEFAULT_RAW_CSV_RETENTION_DAYS = 90; // Provisional default pending separate retention policy confirmation; not approved by Hemu

export const NINETY_DAYS_MICROS = 90n * 24n * 60n * 60n * 1000n * 1000n; // 7_776_000_000_000n µs
export const FIVE_MINUTES_MICROS = 5n * 60n * 1000n * 1000n; // 300_000_000n µs

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const uuid = z.string().regex(UUID_REGEX, 'Must be a valid UUID');

const TOKEN_PATTERN = /^[A-Za-z0-9_\-\.:]{1,128}$/;
const CONSECUTIVE_DIGITS_PATTERN = /\d{10,}/;

export const OrderTokenIdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((val) => !val.includes('@'), {
    message: 'Identifier must not contain email-like patterns (@)',
  })
  .refine((val) => !CONSECUTIVE_DIGITS_PATTERN.test(val), {
    message: 'Identifier must not contain 10 or more consecutive digits',
  })
  .regex(
    TOKEN_PATTERN,
    'Identifier must contain only safe ASCII characters (letters, numbers, _, -, ., :)',
  );

// Explicit timezone is required (Z or +/-HH:MM). Naive timestamps are rejected.
export const ISO_EXPLICIT_TIMEZONE_PATTERN =
  /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?)(Z|[+-]\d{2}:?\d{2})$/i;

function validOrderTimestamp(value: string): boolean {
  const match = ISO_EXPLICIT_TIMEZONE_PATTERN.exec(value);
  if (!match || value.startsWith('0000-')) return false;
  const civil = value.slice(0, 19).replace(/[t ]/i, 'T');
  const date = new Date(`${civil}Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== civil) return false;
  const zone = match[2]!.replace(':', '');
  // PostgreSQL rejects timezone displacements outside +/-15:59.
  return /^z$/i.test(zone) || (Number(zone.slice(1, 3)) <= 15 && Number(zone.slice(3)) <= 59);
}

export const OrderOutcomeTypeSchema = z.enum(['ordered', 'refunded', 'voided']);
export type OrderOutcomeType = z.infer<typeof OrderOutcomeTypeSchema>;

export const OrderOutcomeLineSchema = z
  .strictObject({
    schema_version: z.literal(PILOT_ORDER_OUTCOME_SCHEMA_VERSION),
    order_id: OrderTokenIdentifierSchema,
    order_line_id: OrderTokenIdentifierSchema,
    ordered_at: z
      .string()
      .regex(
        ISO_EXPLICIT_TIMEZONE_PATTERN,
        'Timestamp must be ISO 8601 with explicit timezone (Z or ±HH:MM)',
      )
      .refine(validOrderTimestamp, 'Timestamp must contain valid calendar and time fields'),
    menu_revision_id: uuid,
    dish_id: uuid,
    dish_revision_id: uuid,
    outcome_type: OrderOutcomeTypeSchema,
    quantity: z.number().int().min(1).max(999),
    unit_price: z
      .string()
      .regex(
        /^(0|[1-9]\d{0,7})(\.\d{1,2})?$/,
        'Price must be a positive decimal string with up to 2 decimal places',
      )
      .optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/, 'Currency must be an ISO 4217 3-letter uppercase code')
      .optional(),
  })
  .refine((data) => (data.unit_price === undefined) === (data.currency === undefined), {
    message: 'unit_price and currency must both be present or both be omitted',
    path: ['currency'],
  });

export type OrderOutcomeLine = z.infer<typeof OrderOutcomeLineSchema>;

export const OrderOutcomeQuarantineReasonSchema = z.enum([
  'malformed_row',
  'missing_required_field',
  'invalid_format',
  'unmatched_dish',
  'ambiguous_dish_match',
  'missing_pos_identifier',
  'missing_pos_mapping',
  'unreviewed_pos_mapping',
  'missing_tracking_start_evidence',
  'before_tracking_start',
  'out_of_revision_window',
  'unsupported_menu_revision',
  'unsupported_dish_revision',
  'future_timestamp',
  'too_old',
  'cross_venue_forbidden',
  'prohibited_identifier',
  'schema_version_unsupported',
  'unexpected_header',
  'price_currency_mismatch',
  'payload_too_large',
  'empty_file',
  'duplicate_line_in_batch',
  'conflict_in_batch',
]);
export type OrderOutcomeQuarantineReason = z.infer<typeof OrderOutcomeQuarantineReasonSchema>;

export const SanitizedRowDiagnosticSchema = z.strictObject({
  rowIndex: z.number().int().min(1),
  fieldName: z.string().nullable().optional(),
  reasonCode: OrderOutcomeQuarantineReasonSchema,
  diagnosticMessage: z.string().max(500),
});
export type SanitizedRowDiagnostic = z.infer<typeof SanitizedRowDiagnosticSchema>;

export const OrderOutcomeImportResponseSchema = z.strictObject({
  batchId: uuid,
  venueId: uuid,
  status: z.enum(['queued', 'processing', 'completed', 'failed']),
  totalRows: z.number().int().nonnegative(),
  acceptedRows: z.number().int().nonnegative(),
  duplicateRows: z.number().int().nonnegative(),
  quarantinedRows: z.number().int().nonnegative(),
  conflictRows: z.number().int().nonnegative(),
  isDuplicateFile: z.boolean().optional(),
  fileSha256: z.string().regex(/^[0-9a-f]{64}$/),
  diagnostics: z.array(SanitizedRowDiagnosticSchema),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type OrderOutcomeImportResponse = z.infer<typeof OrderOutcomeImportResponseSchema>;

export type ClassifyTimestampOptions = {
  maxHistoricalDays?: number | undefined;
  maxFutureMinutes?: number | undefined;
  trackingStartedAt?: string | Date | undefined;
};

/**
 * Classifies an order timestamp against reference ingest time:
 * - Must not be before restaurant tracking start date (if provided).
 * - Must not be older than the allowed historical window (default 90 days, proposed).
 * - Must not be more than 5 minutes in the future.
 */
export function classifyOrderTimestampWindow(
  orderedAtIso: string,
  referenceTimeIso: string,
  options?: ClassifyTimestampOptions,
): { valid: true } | { valid: false; reasonCode: OrderOutcomeQuarantineReason; message: string } {
  try {
    if (!validOrderTimestamp(orderedAtIso)) {
      return {
        valid: false,
        reasonCode: 'invalid_format',
        message: 'Invalid calendar or time fields',
      };
    }
    const orderedMicros = parseIsoToMicroseconds(orderedAtIso);
    const refMicros = parseIsoToMicroseconds(referenceTimeIso);
    const diffMicros = orderedMicros - refMicros;

    if (options?.trackingStartedAt) {
      const trackingStartIso =
        typeof options.trackingStartedAt === 'string'
          ? options.trackingStartedAt
          : options.trackingStartedAt.toISOString();
      const trackingMicros = parseIsoToMicroseconds(trackingStartIso);
      if (orderedMicros < trackingMicros) {
        return {
          valid: false,
          reasonCode: 'before_tracking_start',
          message: 'Order timestamp is before the restaurant tracking start date',
        };
      }
    }

    const maxDays = options?.maxHistoricalDays ?? DEFAULT_HISTORICAL_IMPORT_WINDOW_DAYS;
    const historicalLimitMicros = BigInt(maxDays) * 24n * 60n * 60n * 1000n * 1000n;

    if (diffMicros < -historicalLimitMicros) {
      return {
        valid: false,
        reasonCode: 'too_old',
        message: `Order timestamp is older than the allowed ${maxDays}-day historical window`,
      };
    }

    const maxFutureMinutes = options?.maxFutureMinutes ?? 5;
    const futureLimitMicros = BigInt(maxFutureMinutes) * 60n * 1000n * 1000n;

    if (diffMicros > futureLimitMicros) {
      return {
        valid: false,
        reasonCode: 'future_timestamp',
        message: `Order timestamp is more than ${maxFutureMinutes} minutes in the future`,
      };
    }
    return { valid: true };
  } catch {
    return {
      valid: false,
      reasonCode: 'too_old',
      message: 'Invalid ISO timestamp structure',
    };
  }
}

/**
 * Computes canonical SHA-256 payload checksum for an order outcome line.
 */
export async function computeOrderLineChecksum(line: {
  menuRevisionId: string;
  dishId: string;
  dishRevisionId: string;
  orderedAt: string;
  outcomeType: OrderOutcomeType;
  quantity: number;
  unitPrice?: string | null | undefined;
  currency?: string | null | undefined;
}): Promise<string> {
  const normalized = {
    currency: line.currency ?? null,
    dishId: line.dishId,
    dishRevisionId: line.dishRevisionId,
    menuRevisionId: line.menuRevisionId,
    orderedAt: line.orderedAt,
    outcomeType: line.outcomeType,
    quantity: line.quantity,
    unitPrice: line.unitPrice ?? null,
  };
  return sha256(canonicalJson(normalized));
}

export const BASE_REQUIRED_CSV_HEADERS = [
  'schema_version',
  'order_id',
  'order_line_id',
  'ordered_at',
  'outcome_type',
  'quantity',
] as const;

export const CANONICAL_REVISION_HEADERS = [
  'menu_revision_id',
  'dish_id',
  'dish_revision_id',
] as const;

export const POS_ITEM_HEADERS = ['pos_item_id', 'pos_item_code', 'dish_name'] as const;

export const OPTIONAL_PRICING_HEADERS = ['unit_price', 'currency'] as const;

export const REQUIRED_CSV_HEADERS = [
  ...BASE_REQUIRED_CSV_HEADERS,
  ...CANONICAL_REVISION_HEADERS,
] as const;

export const OPTIONAL_CSV_HEADERS = [...POS_ITEM_HEADERS, ...OPTIONAL_PRICING_HEADERS] as const;

export const ALL_ALLOWED_CSV_HEADERS = new Set<string>([
  ...BASE_REQUIRED_CSV_HEADERS,
  ...CANONICAL_REVISION_HEADERS,
  ...POS_ITEM_HEADERS,
  ...OPTIONAL_PRICING_HEADERS,
]);

export type ParsedCsvRow = {
  rowIndex: number;
  data: Record<string, string>;
};

export type CsvParseResult =
  | {
      success: true;
      headers: string[];
      rows: ParsedCsvRow[];
    }
  | {
      success: false;
      reasonCode: OrderOutcomeQuarantineReason;
      message: string;
      diagnostic?: SanitizedRowDiagnostic;
    };

/**
 * Parses RFC 4180 CSV text safely without third-party dependencies.
 * Correctly handles quoted fields, escaped quotes (""), CRLF/LF line breaks,
 * and enforces maximum row limits.
 */
export function parseOrderOutcomeCsv(
  csvText: string,
  options?: { maxRows?: number },
): CsvParseResult {
  const maxRows = options?.maxRows ?? MAX_ORDER_OUTCOME_ROWS;
  const trimmed = csvText.trim();
  if (trimmed.length === 0) {
    return {
      success: false,
      reasonCode: 'empty_file',
      message: 'CSV file is empty',
      diagnostic: {
        rowIndex: 1,
        reasonCode: 'empty_file',
        diagnosticMessage: 'CSV file contains no headers or records',
      },
    };
  }

  // Tokenize CSV into rows of string values
  const records: string[][] = [];
  let currentField = '';
  let currentRow: string[] = [];
  let inQuotes = false;
  let i = 0;
  const length = csvText.length;

  while (i < length) {
    const char = csvText[i];

    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < length && csvText[i + 1] === '"') {
          currentField += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      currentField += char;
      i++;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      i++;
      continue;
    }

    if (char === ',') {
      currentRow.push(currentField.trim());
      currentField = '';
      i++;
      continue;
    }

    if (char === '\r' || char === '\n') {
      if (char === '\r' && i + 1 < length && csvText[i + 1] === '\n') {
        i++;
      }
      currentRow.push(currentField.trim());
      currentField = '';
      if (currentRow.length > 1 || (currentRow.length === 1 && currentRow[0] !== '')) {
        records.push(currentRow);
      }
      currentRow = [];
      i++;
      continue;
    }

    currentField += char;
    i++;
  }

  if (inQuotes) {
    return {
      success: false,
      reasonCode: 'malformed_row',
      message: 'Unclosed quote detected in CSV',
      diagnostic: {
        rowIndex: records.length + 1,
        reasonCode: 'malformed_row',
        diagnosticMessage: 'Malformed CSV: unclosed quote reached end of file',
      },
    };
  }

  currentRow.push(currentField.trim());
  if (currentRow.length > 1 || (currentRow.length === 1 && currentRow[0] !== '')) {
    records.push(currentRow);
  }

  if (records.length === 0) {
    return {
      success: false,
      reasonCode: 'empty_file',
      message: 'No CSV records found',
      diagnostic: {
        rowIndex: 1,
        reasonCode: 'empty_file',
        diagnosticMessage: 'CSV file contains no records',
      },
    };
  }

  const rawHeaders = records[0];
  if (!rawHeaders || rawHeaders.length === 0) {
    return {
      success: false,
      reasonCode: 'missing_required_field',
      message: 'Missing CSV headers',
      diagnostic: {
        rowIndex: 1,
        reasonCode: 'missing_required_field',
        diagnosticMessage: 'Missing CSV header row',
      },
    };
  }

  const headers = rawHeaders.map((h) => h.trim());

  // Validate headers against unexpected or prohibited columns (no free-text, no PII, no redeem_code)
  for (const header of headers) {
    if (!ALL_ALLOWED_CSV_HEADERS.has(header)) {
      return {
        success: false,
        reasonCode: 'unexpected_header',
        message: `Unexpected or unauthorized column: ${header}`,
        diagnostic: {
          rowIndex: 1,
          fieldName: header,
          reasonCode: 'unexpected_header',
          diagnosticMessage: 'Header contains an unexpected or unauthorized column',
        },
      };
    }
  }

  // Verify base required headers are present in all CSV exports
  for (const required of BASE_REQUIRED_CSV_HEADERS) {
    if (!headers.includes(required)) {
      return {
        success: false,
        reasonCode: 'missing_required_field',
        message: `Missing required header column: ${required}`,
        diagnostic: {
          rowIndex: 1,
          fieldName: required,
          reasonCode: 'missing_required_field',
          diagnosticMessage: 'Required header column is missing from CSV',
        },
      };
    }
  }

  // Verify item identification headers: either POS export item code (pos_item_id / pos_item_code)
  // or explicit canonical revision resolution IDs (menu_revision_id, dish_id, dish_revision_id).
  // Note: dish_name alone cannot substitute for the required reviewed POS item code.
  const hasPosItemCode = headers.includes('pos_item_id') || headers.includes('pos_item_code');
  const hasCanonicalIds = CANONICAL_REVISION_HEADERS.every((h) => headers.includes(h));

  if (!hasPosItemCode && !hasCanonicalIds) {
    const isAttemptedCanonical =
      headers.includes('menu_revision_id') ||
      headers.includes('dish_id') ||
      headers.includes('dish_revision_id');
    const missingCanonical = CANONICAL_REVISION_HEADERS.find((h) => !headers.includes(h));
    const missingField = isAttemptedCanonical
      ? (missingCanonical ?? 'menu_revision_id')
      : 'pos_item_id';
    return {
      success: false,
      reasonCode: 'missing_required_field',
      message: `Missing item identification header: expected '${missingField}' or POS item code (pos_item_id/pos_item_code)`,
      diagnostic: {
        rowIndex: 1,
        fieldName: missingField,
        reasonCode: 'missing_required_field',
        diagnosticMessage:
          'CSV must supply pos_item_id (or pos_item_code) for reviewed mapping, or full canonical revision IDs',
      },
    };
  }

  const dataRecords = records.slice(1);
  if (dataRecords.length > maxRows) {
    return {
      success: false,
      reasonCode: 'payload_too_large',
      message: `File exceeds maximum allowed rows (${maxRows})`,
      diagnostic: {
        rowIndex: maxRows + 1,
        reasonCode: 'payload_too_large',
        diagnosticMessage: `CSV row count exceeds the maximum allowed limit of ${maxRows} rows`,
      },
    };
  }

  const rows: ParsedCsvRow[] = [];
  for (let idx = 0; idx < dataRecords.length; idx++) {
    const record = dataRecords[idx];
    const rowIndex = idx + 2; // 1-based, accounting for header row at row 1
    if (!record) continue;

    if (record.length !== headers.length) {
      return {
        success: false,
        reasonCode: 'malformed_row',
        message: `Row ${rowIndex} has column count ${record.length}, expected ${headers.length}`,
        diagnostic: {
          rowIndex,
          reasonCode: 'malformed_row',
          diagnosticMessage: 'Column count mismatch in CSV data row',
        },
      };
    }

    const rowData: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) {
      const h = headers[c]!;
      rowData[h] = record[c] ?? '';
    }
    rows.push({ rowIndex, data: rowData });
  }

  return {
    success: true,
    headers,
    rows,
  };
}

export const AcceptPilotOrderAgreementRequestSchema = z.strictObject({
  agreementVersion: z.string().trim().min(1).max(64),
  accepted: z.literal(true),
});
export type AcceptPilotOrderAgreementRequest = z.infer<
  typeof AcceptPilotOrderAgreementRequestSchema
>;

export const AcceptPilotOrderAgreementResponseSchema = z.strictObject({
  venueId: uuid,
  agreementVersion: z.string().min(1).max(64),
  acceptedBy: uuid,
  acceptedAt: z.string(),
  alreadyAccepted: z.boolean(),
});
export type AcceptPilotOrderAgreementResponse = z.infer<
  typeof AcceptPilotOrderAgreementResponseSchema
>;

export const OrderDataDeletionReasonSchema = z.enum([
  'pilot_withdrawal',
  'data_cleanup',
  'retention_policy_request',
]);
export type OrderDataDeletionReason = z.infer<typeof OrderDataDeletionReasonSchema>;

export const DeleteOrderDataRequestSchema = z.strictObject({
  requestId: uuid,
  reason: OrderDataDeletionReasonSchema.optional(),
});
export type DeleteOrderDataRequest = z.infer<typeof DeleteOrderDataRequestSchema>;

export const SubmitOrderDeletionResponseSchema = z.strictObject({
  requestId: uuid,
  venueId: uuid,
  status: z.enum(['requested', 'executing', 'r2_deleted', 'completed', 'failed']),
  reason: OrderDataDeletionReasonSchema.nullable(),
  requestedAt: z.string(),
  alreadyExists: z.boolean(),
});
export type SubmitOrderDeletionResponse = z.infer<typeof SubmitOrderDeletionResponseSchema>;

export const DeleteOrderDataResponseSchema = z.strictObject({
  requestId: uuid,
  venueId: uuid,
  status: z.enum(['completed']),
  operatorId: uuid,
  r2ObjectsDeleted: z.number().int().nonnegative(),
  dbBatchesDeleted: z.number().int().nonnegative(),
  dbLinesDeleted: z.number().int().nonnegative(),
  dbQuarantineDeleted: z.number().int().nonnegative(),
  dbConflictsDeleted: z.number().int().nonnegative(),
  completedAt: z.string(),
  alreadyCompleted: z.boolean(),
});
export type DeleteOrderDataResponse = z.infer<typeof DeleteOrderDataResponseSchema>;
