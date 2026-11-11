import { describe, expect, it } from 'vitest';
import {
  ALL_ALLOWED_CSV_HEADERS,
  classifyOrderTimestampWindow,
  computeOrderLineChecksum,
  MAX_ORDER_OUTCOME_ROWS,
  OPTIONAL_CSV_HEADERS,
  OrderOutcomeImportResponseSchema,
  OrderOutcomeLineSchema,
  OrderOutcomeQuarantineReasonSchema,
  OrderTokenIdentifierSchema,
  PILOT_ORDER_OUTCOME_SCHEMA_VERSION,
  parseOrderOutcomeCsv,
  REQUIRED_CSV_HEADERS,
  SanitizedRowDiagnosticSchema,
} from './index';

describe('S5-DATA-07 order outcome contracts & CSV parser', () => {
  const validLine = {
    schema_version: PILOT_ORDER_OUTCOME_SCHEMA_VERSION,
    order_id: 'TICKET-101',
    order_line_id: 'LINE-01',
    ordered_at: '2026-11-01T14:30:00Z',
    menu_revision_id: '00000000-0000-4000-8000-000000000101',
    dish_id: '11111111-1111-4000-8000-000000000001',
    dish_revision_id: '22222222-2222-4000-8000-000000000002',
    outcome_type: 'ordered',
    quantity: 2,
    unit_price: '14.50',
    currency: 'USD',
  };

  it('accepts a fully valid order outcome line with pricing', () => {
    const result = OrderOutcomeLineSchema.safeParse(validLine);
    expect(result.success).toBe(true);
  });

  it.each([
    '2026-10-32T12:00:00Z',
    '2026-02-29T12:00:00Z',
    '2026-11-01T24:00:00Z',
    '2026-11-01T12:60:00Z',
    '2026-11-01T12:00:60Z',
    '2026-11-01T12:00:00+16:00',
  ])('rejects invalid calendar/time fields before database use: %s', (ordered_at) => {
    expect(OrderOutcomeLineSchema.safeParse({ ...validLine, ordered_at }).success).toBe(false);
    expect(classifyOrderTimestampWindow(ordered_at, '2026-11-11T12:00:00Z')).toMatchObject({
      valid: false,
      reasonCode: 'invalid_format',
    });
  });

  it('accepts a valid line without optional price and currency', () => {
    const { unit_price, currency, ...withoutPrice } = validLine;
    const result = OrderOutcomeLineSchema.safeParse(withoutPrice);
    expect(result.success).toBe(true);
  });

  it('rejects line when unit_price is provided without currency', () => {
    const { currency, ...noCurrency } = validLine;
    const result = OrderOutcomeLineSchema.safeParse(noCurrency);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(
      /unit_price and currency must both be present/,
    );
  });

  it('rejects line when currency is provided without unit_price', () => {
    const { unit_price, ...noPrice } = validLine;
    const result = OrderOutcomeLineSchema.safeParse(noPrice);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(
      /unit_price and currency must both be present/,
    );
  });

  it('accepts valid outcome types: ordered, refunded, voided', () => {
    for (const outcome of ['ordered', 'refunded', 'voided'] as const) {
      expect(
        OrderOutcomeLineSchema.safeParse({ ...validLine, outcome_type: outcome }).success,
      ).toBe(true);
    }
    expect(
      OrderOutcomeLineSchema.safeParse({ ...validLine, outcome_type: 'cancelled' }).success,
    ).toBe(false);
  });

  describe('identifier policy & anti-PII enforcement', () => {
    it('accepts safe alphanumeric identifiers with hyphens, underscores, dots, and colons', () => {
      expect(OrderTokenIdentifierSchema.safeParse('ORD-9021').success).toBe(true);
      expect(OrderTokenIdentifierSchema.safeParse('pos_line:01.item').success).toBe(true);
    });

    it('rejects email-like identifiers containing @', () => {
      const res = OrderTokenIdentifierSchema.safeParse('john.doe@example.com');
      expect(res.success).toBe(false);
      expect(res.error?.issues[0]?.message).toMatch(/email-like patterns/);
    });

    it('rejects identifiers containing 10 or more consecutive digits (phone number pattern)', () => {
      const res = OrderTokenIdentifierSchema.safeParse('ORD-5551234567');
      expect(res.success).toBe(false);
      expect(res.error?.issues[0]?.message).toMatch(/10 or more consecutive digits/);
    });

    it('accepts identifiers with fewer than 10 consecutive digits', () => {
      expect(OrderTokenIdentifierSchema.safeParse('ORD-123456789').success).toBe(true);
    });

    it('rejects empty or whitespace-only identifiers', () => {
      expect(OrderTokenIdentifierSchema.safeParse('').success).toBe(false);
    });

    it('rejects identifiers exceeding 128 characters', () => {
      expect(OrderTokenIdentifierSchema.safeParse('a'.repeat(129)).success).toBe(false);
    });
  });

  describe('timestamp window and timezone validation', () => {
    it('rejects naive timestamps without explicit timezone offset', () => {
      const res = OrderOutcomeLineSchema.safeParse({
        ...validLine,
        ordered_at: '2026-11-01T14:30:00',
      });
      expect(res.success).toBe(false);
      expect(res.error?.issues[0]?.message).toMatch(/explicit timezone/);
    });

    it('accepts timestamps with Z or positive/negative numeric offsets', () => {
      expect(
        OrderOutcomeLineSchema.safeParse({
          ...validLine,
          ordered_at: '2026-11-01T14:30:00Z',
        }).success,
      ).toBe(true);
      expect(
        OrderOutcomeLineSchema.safeParse({
          ...validLine,
          ordered_at: '2026-11-01T10:30:00-04:00',
        }).success,
      ).toBe(true);
      expect(
        OrderOutcomeLineSchema.safeParse({
          ...validLine,
          ordered_at: '2026-11-01T16:30:00+02:00',
        }).success,
      ).toBe(true);
    });

    it('classifies timestamps within the 90-day window as valid', () => {
      const now = '2026-11-07T12:00:00.000Z';
      const recent = '2026-10-15T12:00:00.000Z';
      const result = classifyOrderTimestampWindow(recent, now);
      expect(result.valid).toBe(true);
    });

    it('rejects timestamps older than 90 days with too_old', () => {
      const now = '2026-11-07T12:00:00.000Z';
      const ninetyOneDaysAgo = '2026-08-01T12:00:00.000Z';
      const result = classifyOrderTimestampWindow(ninetyOneDaysAgo, now);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reasonCode).toBe('too_old');
        expect(result.message).toMatch(/90-day/);
      }
    });

    it('rejects future timestamps beyond 5 minutes with future_timestamp', () => {
      const now = '2026-11-07T12:00:00.000Z';
      const tenMinutesFuture = '2026-11-07T12:10:00.000Z';
      const result = classifyOrderTimestampWindow(tenMinutesFuture, now);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reasonCode).toBe('future_timestamp');
        expect(result.message).toMatch(/future/);
      }
    });

    it('allows timestamps up to 5 minutes in the future for clock skew', () => {
      const now = '2026-11-07T12:00:00.000Z';
      const fourMinutesFuture = '2026-11-07T12:04:00.000Z';
      const result = classifyOrderTimestampWindow(fourMinutesFuture, now);
      expect(result.valid).toBe(true);
    });

    it('rejects order timestamp before tracking start date with before_tracking_start', () => {
      const now = '2026-11-07T12:00:00.000Z';
      const trackingStart = '2026-10-01T00:00:00.000Z';
      const orderBeforeStart = '2026-09-30T23:59:59.000Z';

      const result = classifyOrderTimestampWindow(orderBeforeStart, now, {
        trackingStartedAt: trackingStart,
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reasonCode).toBe('before_tracking_start');
        expect(result.message).toMatch(/before the restaurant tracking start/);
      }
    });

    it('accepts order timestamp on or after tracking start date', () => {
      const now = '2026-11-07T12:00:00.000Z';
      const trackingStart = '2026-10-01T00:00:00.000Z';
      const orderAfterStart = '2026-10-01T00:00:00.000Z';

      const result = classifyOrderTimestampWindow(orderAfterStart, now, {
        trackingStartedAt: trackingStart,
      });
      expect(result.valid).toBe(true);
    });

    it('respects configurable historical import window', () => {
      const now = '2026-11-07T12:00:00.000Z';
      const fortyDaysAgo = '2026-09-28T12:00:00.000Z';

      // Valid under 90-day default
      const defaultCheck = classifyOrderTimestampWindow(fortyDaysAgo, now);
      expect(defaultCheck.valid).toBe(true);

      // Rejected under 30-day configured limit
      const restrictedCheck = classifyOrderTimestampWindow(fortyDaysAgo, now, {
        maxHistoricalDays: 30,
      });
      expect(restrictedCheck.valid).toBe(false);
      if (!restrictedCheck.valid) {
        expect(restrictedCheck.reasonCode).toBe('too_old');
        expect(restrictedCheck.message).toMatch(/30-day/);
      }
    });
  });

  describe('quantity and price constraints', () => {
    it('rejects zero or negative quantity', () => {
      expect(OrderOutcomeLineSchema.safeParse({ ...validLine, quantity: 0 }).success).toBe(false);
      expect(OrderOutcomeLineSchema.safeParse({ ...validLine, quantity: -1 }).success).toBe(false);
    });

    it('rejects quantity over 999', () => {
      expect(OrderOutcomeLineSchema.safeParse({ ...validLine, quantity: 1000 }).success).toBe(
        false,
      );
    });

    it('rejects malformed price decimals', () => {
      expect(OrderOutcomeLineSchema.safeParse({ ...validLine, unit_price: '14.555' }).success).toBe(
        false,
      );
      expect(OrderOutcomeLineSchema.safeParse({ ...validLine, unit_price: '-10.00' }).success).toBe(
        false,
      );
      expect(OrderOutcomeLineSchema.safeParse({ ...validLine, unit_price: 'abc' }).success).toBe(
        false,
      );
    });

    it('rejects invalid currency codes', () => {
      expect(OrderOutcomeLineSchema.safeParse({ ...validLine, currency: 'us' }).success).toBe(
        false,
      );
      expect(OrderOutcomeLineSchema.safeParse({ ...validLine, currency: 'USDT' }).success).toBe(
        false,
      );
    });
  });

  describe('canonical checksum computation', () => {
    it('produces deterministic SHA-256 checksum', async () => {
      const hash1 = await computeOrderLineChecksum({
        menuRevisionId: validLine.menu_revision_id,
        dishId: validLine.dish_id,
        dishRevisionId: validLine.dish_revision_id,
        orderedAt: validLine.ordered_at,
        outcomeType: 'ordered',
        quantity: 2,
        unitPrice: '14.50',
        currency: 'USD',
      });
      const hash2 = await computeOrderLineChecksum({
        menuRevisionId: validLine.menu_revision_id,
        dishId: validLine.dish_id,
        dishRevisionId: validLine.dish_revision_id,
        orderedAt: validLine.ordered_at,
        outcomeType: 'ordered',
        quantity: 2,
        unitPrice: '14.50',
        currency: 'USD',
      });
      expect(hash1).toMatch(/^[0-9a-f]{64}$/);
      expect(hash1).toBe(hash2);
    });

    it('detects divergent payload when price differs', async () => {
      const hash1 = await computeOrderLineChecksum({
        menuRevisionId: validLine.menu_revision_id,
        dishId: validLine.dish_id,
        dishRevisionId: validLine.dish_revision_id,
        orderedAt: validLine.ordered_at,
        outcomeType: 'ordered',
        quantity: 2,
        unitPrice: '14.50',
        currency: 'USD',
      });
      const hash2 = await computeOrderLineChecksum({
        menuRevisionId: validLine.menu_revision_id,
        dishId: validLine.dish_id,
        dishRevisionId: validLine.dish_revision_id,
        orderedAt: validLine.ordered_at,
        outcomeType: 'ordered',
        quantity: 2,
        unitPrice: '15.00',
        currency: 'USD',
      });
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('RFC 4180 CSV parser & sanitization', () => {
    it('parses valid CSV text into structured rows', () => {
      const csv = [
        'schema_version,order_id,order_line_id,ordered_at,menu_revision_id,dish_id,dish_revision_id,outcome_type,quantity,unit_price,currency',
        'pilot_order_outcome.v1,ORD-1,LINE-1,2026-11-01T12:00:00Z,00000000-0000-4000-8000-000000000101,11111111-1111-4000-8000-000000000001,22222222-2222-4000-8000-000000000002,ordered,1,10.00,USD',
        'pilot_order_outcome.v1,ORD-2,LINE-2,2026-11-01T12:05:00Z,00000000-0000-4000-8000-000000000101,11111111-1111-4000-8000-000000000003,33333333-3333-4000-8000-000000000004,voided,2,,',
      ].join('\n');

      const parsed = parseOrderOutcomeCsv(csv);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.rows.length).toBe(2);
        expect(parsed.rows[0]?.rowIndex).toBe(2);
        expect(parsed.rows[0]?.data.order_id).toBe('ORD-1');
        expect(parsed.rows[1]?.data.outcome_type).toBe('voided');
      }
    });

    it('correctly handles quoted fields and escaped quotes', () => {
      const csv = [
        'schema_version,order_id,order_line_id,ordered_at,menu_revision_id,dish_id,dish_revision_id,outcome_type,quantity',
        'pilot_order_outcome.v1,"ORD-""SPECIAL""",LINE-1,2026-11-01T12:00:00Z,00000000-0000-4000-8000-000000000101,11111111-1111-4000-8000-000000000001,22222222-2222-4000-8000-000000000002,ordered,1',
      ].join('\r\n');

      const parsed = parseOrderOutcomeCsv(csv);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.rows[0]?.data.order_id).toBe('ORD-"SPECIAL"');
      }
    });

    it('rejects empty CSV with empty_file diagnostic', () => {
      const parsed = parseOrderOutcomeCsv('   \n\n');
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.reasonCode).toBe('empty_file');
      }
    });

    it('rejects unclosed quotes with malformed_row', () => {
      const csv = [
        'schema_version,order_id,order_line_id,ordered_at,menu_revision_id,dish_id,dish_revision_id,outcome_type,quantity',
        'pilot_order_outcome.v1,"UNCLOSED,LINE-1,2026-11-01T12:00:00Z',
      ].join('\n');
      const parsed = parseOrderOutcomeCsv(csv);
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.reasonCode).toBe('malformed_row');
      }
    });

    it('rejects unexpected headers (such as redeem_code or PII fields)', () => {
      const csv = [
        'schema_version,order_id,order_line_id,ordered_at,menu_revision_id,dish_id,dish_revision_id,outcome_type,quantity,redeem_code',
        'pilot_order_outcome.v1,ORD-1,LINE-1,2026-11-01T12:00:00Z,00000000-0000-4000-8000-000000000101,11111111-1111-4000-8000-000000000001,22222222-2222-4000-8000-000000000002,ordered,1,RC-1234',
      ].join('\n');
      const parsed = parseOrderOutcomeCsv(csv);
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.reasonCode).toBe('unexpected_header');
        expect(parsed.diagnostic?.fieldName).toBe('redeem_code');
      }
    });

    it('rejects missing required header columns', () => {
      const csv = [
        'schema_version,order_id,ordered_at,menu_revision_id,dish_id,dish_revision_id,outcome_type,quantity',
        'pilot_order_outcome.v1,ORD-1,2026-11-01T12:00:00Z,00000000-0000-4000-8000-000000000101,11111111-1111-4000-8000-000000000001,22222222-2222-4000-8000-000000000002,ordered,1',
      ].join('\n');
      const parsed = parseOrderOutcomeCsv(csv);
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.reasonCode).toBe('missing_required_field');
        expect(parsed.diagnostic?.fieldName).toBe('order_line_id');
      }
    });

    it('accepts POS export CSV with pos_item_id code and supporting dish_name', () => {
      const csv = [
        'schema_version,order_id,order_line_id,ordered_at,pos_item_id,dish_name,outcome_type,quantity,unit_price,currency',
        'pilot_order_outcome.v1,ORD-1,LINE-1,2026-11-01T12:00:00Z,POS-101,Margherita Pizza,ordered,1,14.50,USD',
      ].join('\n');
      const parsed = parseOrderOutcomeCsv(csv);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.rows.length).toBe(1);
        expect(parsed.rows[0]?.data.pos_item_id).toBe('POS-101');
        expect(parsed.rows[0]?.data.dish_name).toBe('Margherita Pizza');
        expect(parsed.rows[0]?.data.menu_revision_id).toBeUndefined();
      }
    });

    it('rejects POS export CSV with dish_name alone when pos_item_id is missing', () => {
      const csv = [
        'schema_version,order_id,order_line_id,ordered_at,dish_name,outcome_type,quantity,unit_price,currency',
        'pilot_order_outcome.v1,ORD-1,LINE-1,2026-11-01T12:00:00Z,Margherita Pizza,ordered,1,14.50,USD',
      ].join('\n');
      const parsed = parseOrderOutcomeCsv(csv);
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.reasonCode).toBe('missing_required_field');
        expect(parsed.diagnostic?.fieldName).toBe('pos_item_id');
      }
    });

    it('accepts POS export CSV with pos_item_id SKU identifier', () => {
      const csv = [
        'schema_version,order_id,order_line_id,ordered_at,pos_item_id,dish_name,outcome_type,quantity',
        'pilot_order_outcome.v1,ORD-1,LINE-1,2026-11-01T12:00:00Z,SKU-990,Truffle Pasta,ordered,2',
      ].join('\n');
      const parsed = parseOrderOutcomeCsv(csv);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.rows[0]?.data.pos_item_id).toBe('SKU-990');
      }
    });

    it('rejects CSV when neither dish_name, pos_item_id, nor canonical revision IDs are provided', () => {
      const csv = [
        'schema_version,order_id,order_line_id,ordered_at,outcome_type,quantity',
        'pilot_order_outcome.v1,ORD-1,LINE-1,2026-11-01T12:00:00Z,ordered,1',
      ].join('\n');
      const parsed = parseOrderOutcomeCsv(csv);
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.reasonCode).toBe('missing_required_field');
      }
    });

    it('rejects files exceeding row count limit with payload_too_large', () => {
      const header = REQUIRED_CSV_HEADERS.join(',');
      const rows = Array.from(
        { length: 1005 },
        (_, i) =>
          `pilot_order_outcome.v1,O-${i},L-${i},2026-11-01T12:00:00Z,00000000-0000-4000-8000-000000000101,11111111-1111-4000-8000-000000000001,22222222-2222-4000-8000-000000000002,ordered,1`,
      );
      const csv = [header, ...rows].join('\n');
      const parsed = parseOrderOutcomeCsv(csv);
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.reasonCode).toBe('payload_too_large');
      }
    });

    it('rejects rows with column count mismatch', () => {
      const csv = [
        'schema_version,order_id,order_line_id,ordered_at,menu_revision_id,dish_id,dish_revision_id,outcome_type,quantity',
        'pilot_order_outcome.v1,ORD-1,LINE-1,2026-11-01T12:00:00Z,00000000-0000-4000-8000-000000000101,11111111-1111-4000-8000-000000000001,22222222-2222-4000-8000-000000000002,ordered', // missing quantity
      ].join('\n');
      const parsed = parseOrderOutcomeCsv(csv);
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.reasonCode).toBe('malformed_row');
        expect(parsed.diagnostic?.rowIndex).toBe(2);
      }
    });
  });

  describe('sanitized diagnostics & response schema validation', () => {
    it('validates sanitized diagnostic schema without exposing values', () => {
      const diagnostic = {
        rowIndex: 4,
        fieldName: 'ordered_at',
        reasonCode: 'invalid_format' as const,
        diagnosticMessage: 'Timestamp must be ISO 8601 with explicit timezone offset',
      };
      expect(SanitizedRowDiagnosticSchema.safeParse(diagnostic).success).toBe(true);
    });

    it('validates OrderOutcomeImportResponseSchema', () => {
      const response = {
        batchId: '00000000-0000-4000-8000-000000000001',
        venueId: '11111111-1111-4000-8000-000000000001',
        status: 'completed' as const,
        totalRows: 10,
        acceptedRows: 8,
        duplicateRows: 1,
        quarantinedRows: 1,
        conflictRows: 0,
        isDuplicateFile: false,
        fileSha256: 'a'.repeat(64),
        diagnostics: [
          {
            rowIndex: 5,
            fieldName: 'dish_id',
            reasonCode: 'unmatched_dish' as const,
            diagnosticMessage: 'Dish is not present in the specified menu revision',
          },
        ],
        createdAt: '2026-11-07T12:00:00.000Z',
        finishedAt: '2026-11-07T12:00:02.000Z',
      };
      expect(OrderOutcomeImportResponseSchema.safeParse(response).success).toBe(true);
    });

    it('validates the version-controlled synthetic DATA-08 handoff fixture', async () => {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const fixturePath = path.resolve(
        __dirname,
        '../fixtures/order-outcome.v1/handoff-fixture.json',
      );
      const raw = fs.readFileSync(fixturePath, 'utf8');
      const fixture = JSON.parse(raw);

      expect(fixture.schema_version).toBe('pilot_order_outcome.v1');
      expect(fixture.tenant_id).toBeDefined();
      expect(fixture.import_batch).toBeDefined();

      // Validate accepted outcomes match OrderOutcomeLineSchema
      for (const entry of fixture.accepted_order_outcomes) {
        expect(OrderOutcomeLineSchema.safeParse(entry.line).success).toBe(true);
        expect(entry.linkage_status).toBe('unlinked');
      }

      // Validate quarantined outcomes match diagnostic schema
      for (const q of fixture.quarantined_order_outcomes) {
        expect(SanitizedRowDiagnosticSchema.safeParse(q.diagnostic).success).toBe(true);
        expect(q.diagnostic.reasonCode).toBe('missing_pos_mapping');
      }
    });
  });
});
