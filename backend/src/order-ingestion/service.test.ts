import {
  MAX_ORDER_OUTCOME_ROWS,
  PILOT_ORDER_OUTCOME_SCHEMA_VERSION,
  type PublicMenuContentBundle,
} from '@peekaplate/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  cleanupOrphanedOrderImports,
  type ImportOrderOutcomeOptions,
  importOrderOutcomes,
  OrderImportError,
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
  bundleContent?: PublicMenuContentBundle;
  posDishMappings: Map<string, any>;
  venueTrackingActivations?: Map<string, any>;
  batches: Map<string, any>;
  lines: Map<string, any>;
  quarantine: any[];
  conflicts: any[];
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

      // 5. Menu approval & public bundle check
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
        const key = `${tenantId}:${orderId}:${orderLineId}:${outcomeType}`;
        const existing = state.lines.get(key);
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

      // 1. Run cleanup with default 90-day retention
      return cleanupOrphanedOrderImports({
        storage: mockStorage as any,
        client: client as any,
        now: () => now,
      }).then(async (resultDefault) => {
        expect(resultDefault.scanned).toBe(4);
        expect(resultDefault.skippedActive).toBe(1); // 30 mins ago
        expect(resultDefault.deletedOrphans).toBe(1); // 4 hours ago orphan
        expect(resultDefault.deletedAgedRawCsv).toBe(1); // 100 days ago (> 90 days)
        expect(resultDefault.retained).toBe(1); // 40 days ago (< 90 days)
        expect(resultDefault.deleted).toBe(2);

        // 2. Run cleanup with custom 30-day retention policy: 40-day-old file is now deleted
        mockStorage.delete.mockClear();
        const resultCustom = await cleanupOrphanedOrderImports({
          storage: mockStorage as any,
          client: client as any,
          retentionConfig: {
            rawCsvRetentionDays: 30,
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

    it('quarantines row with missing_tracking_start_evidence when trackingStartedAt is omitted', async () => {
      const state = defaultState();
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
});
