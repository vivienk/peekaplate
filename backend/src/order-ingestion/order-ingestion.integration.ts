import { createHash, randomUUID } from 'node:crypto';
import { PILOT_ORDER_AGREEMENT_VERSION } from '@peekaplate/contracts';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../index';
import {
  acceptPilotOrderAgreement,
  deleteVenueOrderData,
  importOrderOutcomes,
  type OrderOutcomeStorage,
  submitOrderDataDeletionRequest,
} from './service';
import { recordVenueTrackingActivation } from './tracking-activation';

const runtimeUrl = process.env.PEEKAPLATE_DB_TEST_URL;
const adminUrl = process.env.PEEKAPLATE_DB_ADMIN_URL;

const hasDb = Boolean(runtimeUrl && adminUrl);

function sha256Hex(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

describe.skipIf(!hasDb)('Order Ingestion Real PostgreSQL Integration Tests (S5-DATA-07)', () => {
  let adminClient: Client;
  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    adminClient = new Client({ connectionString: adminUrl });
    await adminClient.connect();
  });

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    if (adminClient) {
      await adminClient.end().catch(() => {});
    }
  });

  async function createTestVenue(options?: { acceptAgreement?: boolean }) {
    const venueId = randomUUID();
    const ownerId = randomUUID();
    const editorId = randomUUID();

    await adminClient.query(`INSERT INTO app_private.venues (id, name) VALUES ($1, $2)`, [
      venueId,
      `Integration Venue ${venueId.slice(0, 8)}`,
    ]);

    await adminClient.query(
      `INSERT INTO app_private.staff_membership (tenant_id, actor_id, permission)
       VALUES ($1, $2, 'owner'), ($1, $3, 'editor')`,
      [venueId, ownerId, editorId],
    );

    if (options?.acceptAgreement !== false) {
      await acceptPilotOrderAgreement({
        client: adminClient,
        actorId: ownerId,
        venueId,
        agreementVersion: PILOT_ORDER_AGREEMENT_VERSION,
      });
    }

    return { venueId, ownerId, editorId };
  }

  // Probe 1: Runtime tracking activation lookup via real HTTP adapter and restricted runtime connection (Finding A)
  it('exercises real HTTP adapter with restricted runtime role: reads activation inside authorized tenant context', async () => {
    const { venueId, ownerId } = await createTestVenue();

    // Setup active tracking activation
    await recordVenueTrackingActivation(adminClient, ownerId, venueId, 'administrative');

    // Setup menu approval & bundle
    const menuId = randomUUID();
    const menuRevisionId = randomUUID();
    const dishId = randomUUID();
    const dishRevisionId = randomUUID();
    const approvalId = randomUUID();
    const contentApprovalId = randomUUID();
    const assetApprovalId = randomUUID();

    const bundleJson = {
      schema_version: 1,
      venue_id: venueId,
      menu_id: menuId,
      menu_revision_id: menuRevisionId,
      restaurant: { name: 'Test Restaurant', logo: null },
      categories: [
        {
          category_id: randomUUID(),
          name: 'Mains',
          dishes: [
            {
              dish_id: dishId,
              dish_revision_id: dishRevisionId,
              complete: true,
              name: 'Real Pasta',
              description: 'Delicious pasta',
              price: { amount: '15.00', currency: 'USD' },
              ingredients: [],
              allergens: null,
              dietary: ['vegetarian'],
              images: {
                card: {
                  url: 'https://cdn.example.com/card.jpg',
                  width: 400,
                  height: 300,
                  alt: 'Pasta',
                },
                detail: {
                  url: 'https://cdn.example.com/detail.jpg',
                  width: 800,
                  height: 600,
                  alt: 'Pasta detail',
                },
              },
            },
          ],
        },
      ],
    };
    const bundleString = JSON.stringify(bundleJson);
    const contentHash = sha256Hex(bundleString);
    const assetHash = 'a'.repeat(64);
    const bundleUrl = `https://assets.peekaplate.example/${venueId}/${menuRevisionId}/bundle.json`;

    globalThis.fetch = async (input, init) => {
      const urlStr =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url;
      if (urlStr === bundleUrl) {
        return new Response(bundleString, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return originalFetch(input, init);
    };

    await adminClient.query(
      `INSERT INTO app_private.menu_review_subject
        (tenant_id, menu_id, menu_revision_id, content_approval_id, content_hash, asset_approval_id, asset_manifest_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [venueId, menuId, menuRevisionId, contentApprovalId, contentHash, assetApprovalId, assetHash],
    );

    await adminClient.query(
      `INSERT INTO app_private.menu_approval
        (tenant_id, approval_id, menu_id, review_version, menu_revision_id, content_approval_id, content_hash, asset_approval_id, asset_manifest_hash, approved_by)
       VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9)`,
      [
        venueId,
        approvalId,
        menuId,
        menuRevisionId,
        contentApprovalId,
        contentHash,
        assetApprovalId,
        assetHash,
        ownerId,
      ],
    );

    await adminClient.query(
      `INSERT INTO app_private.public_menu_bundle (tenant_id, menu_id, menu_revision_id, bundle_url)
       VALUES ($1, $2, $3, $4)`,
      [venueId, menuId, menuRevisionId, bundleUrl],
    );

    // Publication event in es_event
    await adminClient.query(
      `INSERT INTO app_private.es_event
        (id, tenant_id, stream_type, stream_id, version, schema_version, event_type, payload, metadata, occurred_at)
       VALUES ($1, $2, 'menu_publication', $3, 1, 1, 'menu.published', $4::jsonb, '{}'::jsonb, now() - interval '1 hour')`,
      [
        randomUUID(),
        venueId,
        menuId,
        JSON.stringify({
          menuId,
          publicationId: randomUUID(),
          version: 1,
          approvalId,
          status: 'published',
        }),
      ],
    );

    // Setup reviewed approved POS dish mapping within explicit transaction with actor context
    await adminClient.query('BEGIN');
    await adminClient.query(`SELECT set_config('app.actor_id', $1, true)`, [ownerId]);
    await adminClient.query(`SELECT set_config('app.tenant_id', $1, true)`, [venueId]);
    await adminClient.query(
      `INSERT INTO app_private.pos_dish_mappings
        (tenant_id, pos_item_code, dish_id, dish_name, review_status, reviewed_by, reviewed_at)
       VALUES ($1, 'POS-ITEM-HTTP', $2, 'Real Pasta', 'approved', $3, now())`,
      [venueId, dishId, ownerId],
    );
    await adminClient.query('COMMIT');

    // Setup fake in-memory storage archive sink
    const stored = new Map<string, string>();
    const fakeStorage: OrderOutcomeStorage = {
      async put(key, val) {
        stored.set(key, typeof val === 'string' ? val : 'csv');
      },
      async delete(key) {
        stored.delete(key);
      },
    };

    const app = createApp({
      verify: async () => ownerId,
      execute: (async () => ({})) as any,
    });

    const actRow = await adminClient.query<{ activated_at: Date }>(
      `SELECT activated_at FROM app_private.venue_tracking_activations WHERE tenant_id = $1`,
      [venueId],
    );
    const firstAct = actRow.rows[0];
    if (!firstAct) throw new Error('Missing activation');
    const orderTimestamp = new Date(firstAct.activated_at.getTime() + 2000).toISOString();

    const csvBody = [
      'schema_version,order_id,order_line_id,ordered_at,pos_item_id,outcome_type,quantity',
      `pilot_order_outcome.v1,ORD-HTTP-1,LINE-1,${orderTimestamp},POS-ITEM-HTTP,ordered,2`,
    ].join('\n');

    // Execute via real HTTP adapter with restricted runtime database URL
    const res = await app.request(
      `http://localhost/venues/${venueId}/orders/import`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'text/csv',
        },
        body: csvBody,
      },
      {
        APP_ENV: 'local',
        LOCAL_DATABASE_URL: runtimeUrl,
        ORDER_OUTCOME_ARCHIVE_BUCKET: fakeStorage,
      },
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.status).toBe('completed');
    expect(json.acceptedRows).toBe(1);
    expect(json.quarantinedRows).toBe(0);
    expect(json.totalRows).toBe(1);

    // A malformed calendar row must not reach PostgreSQL or roll back a valid row.
    const futureYear = new Date().getUTCFullYear() + 1;
    const mixedCsv = [
      'schema_version,order_id,order_line_id,ordered_at,pos_item_id,outcome_type,quantity',
      `pilot_order_outcome.v1,ORD-CALENDAR-VALID,LINE-1,${futureYear}-03-01T12:00:00Z,POS-ITEM-HTTP,ordered,1`,
      `pilot_order_outcome.v1,ORD-CALENDAR-INVALID,LINE-2,${futureYear}-02-30T12:00:00Z,POS-ITEM-HTTP,ordered,1`,
    ].join('\n');
    const calendarClient = new Client({ connectionString: runtimeUrl });
    await calendarClient.connect();
    try {
      const mixed = await importOrderOutcomes({
        client: calendarClient,
        actorId: ownerId,
        venueId,
        csvText: mixedCsv,
        sourceFilename: 'synthetic-calendar.csv',
        storage: fakeStorage,
        now: () => new Date(`${futureYear}-03-03T12:00:00Z`),
      });
      expect(mixed.acceptedRows).toBe(1);
      expect(mixed.quarantinedRows).toBe(1);
      expect(mixed.diagnostics[0]?.reasonCode).toBe('invalid_format');
    } finally {
      await calendarClient.end();
    }

    // Test separate venue WITHOUT tracking activation: must quarantine with missing_tracking_start_evidence
    const noTrack = await createTestVenue();
    const appNoTrack = createApp({
      verify: async () => noTrack.ownerId,
      execute: (async () => ({})) as any,
    });

    const resNoTrack = await appNoTrack.request(
      `http://localhost/venues/${noTrack.venueId}/orders/import`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'text/csv',
        },
        body: csvBody,
      },
      {
        APP_ENV: 'local',
        LOCAL_DATABASE_URL: runtimeUrl,
        ORDER_OUTCOME_ARCHIVE_BUCKET: fakeStorage,
      },
    );

    expect(resNoTrack.status).toBe(200);
    const jsonNoTrack = (await resNoTrack.json()) as any;
    expect(jsonNoTrack.status).toBe('completed');
    expect(jsonNoTrack.acceptedRows).toBe(0);
    expect(jsonNoTrack.quarantinedRows).toBe(1);
    expect(jsonNoTrack.diagnostics[0]?.reasonCode).toBe('missing_tracking_start_evidence');
  });

  // Probe 2: Reauthorization race after archive upload (Finding B)
  it('re-evaluates staff permission FOR SHARE inside the processing transaction: revoked owner gets 403 and archive compensation', async () => {
    const { venueId, ownerId } = await createTestVenue();
    const client = new Client({ connectionString: runtimeUrl });
    await client.connect();

    try {
      let pauseBarrierResolve: () => void;
      const pauseBarrier = new Promise<void>((resolve) => {
        pauseBarrierResolve = resolve;
      });

      let storagePutStartedResolve: () => void;
      const storagePutStarted = new Promise<void>((resolve) => {
        storagePutStartedResolve = resolve;
      });

      let compensatedKey: string | null = null;
      const storage: OrderOutcomeStorage = {
        async put(key) {
          storagePutStartedResolve();
          // Pause upload to simulate slow network / worker delay
          await pauseBarrier;
        },
        async delete(key) {
          compensatedKey = key;
        },
      };

      const csv = [
        'schema_version,order_id,order_line_id,ordered_at,pos_item_id,outcome_type,quantity',
        `pilot_order_outcome.v1,ORD-REVOKE-1,LINE-1,${new Date().toISOString()},POS-ITEM-REV,ordered,1`,
      ].join('\n');

      // Start import in background
      const importPromise = importOrderOutcomes({
        client,
        actorId: ownerId,
        venueId,
        csvText: csv,
        storage,
        trackingStartedAt: new Date(Date.now() - 3600000),
      });

      // Wait until initial auth passed and storage.put began
      await storagePutStarted;

      // In another connection, revoke the owner's membership
      await adminClient.query(
        `DELETE FROM app_private.staff_membership WHERE tenant_id = $1 AND actor_id = $2`,
        [venueId, ownerId],
      );

      // Resume storage.put
      pauseBarrierResolve!();

      // The processing transaction must re-verify permission and fail with 403 forbidden
      await expect(importPromise).rejects.toMatchObject({
        status: 403,
        code: 'forbidden',
      });

      // Verify compensating deletion was invoked
      expect(compensatedKey).toMatch(/^order-imports\//);

      // Verify no batch record was committed
      const batches = await adminClient.query(
        `SELECT count(*)::int FROM app_private.order_outcome_import_batches WHERE tenant_id = $1`,
        [venueId],
      );
      expect(batches.rows[0].count).toBe(0);

      // Verify no order outcome lines were committed
      const lines = await adminClient.query(
        `SELECT count(*)::int FROM app_private.order_outcome_lines WHERE tenant_id = $1`,
        [venueId],
      );
      expect(lines.rows[0].count).toBe(0);
    } finally {
      await client.end().catch(() => {});
    }
  });

  // Probe 3: Membership removal preserving reviewer history (Finding C)
  it('preserves historical reviewer UUID provenance when staff membership is deleted (Finding C)', async () => {
    const { venueId, ownerId } = await createTestVenue();
    const dishId = randomUUID();

    // Insert approved mapping under owner session
    await adminClient.query('BEGIN');
    await adminClient.query(`SELECT set_config('app.actor_id', $1, true)`, [ownerId]);
    await adminClient.query(`SELECT set_config('app.tenant_id', $1, true)`, [venueId]);
    await adminClient.query(
      `INSERT INTO app_private.pos_dish_mappings
        (tenant_id, pos_item_code, dish_id, dish_name, review_status, reviewed_by, reviewed_at)
       VALUES ($1, 'POS-PROV-1', $2, 'Test Dish', 'approved', $3, now())`,
      [venueId, dishId, ownerId],
    );
    await adminClient.query('COMMIT');

    // Delete membership using standard repository removal operation
    await adminClient.query(
      `DELETE FROM app_private.staff_membership WHERE tenant_id = $1 AND actor_id = $2`,
      [venueId, ownerId],
    );

    // Verify historical reviewed_by remains intact
    const mapping = await adminClient.query<{ reviewed_by: string }>(
      `SELECT reviewed_by FROM app_private.pos_dish_mappings WHERE tenant_id = $1 AND pos_item_code = 'POS-PROV-1'`,
      [venueId],
    );
    expect(mapping.rows[0]?.reviewed_by).toBe(ownerId);

    // Verify removed actor can no longer create or modify mappings
    await adminClient.query('BEGIN');
    await adminClient.query(`SELECT set_config('app.actor_id', $1, true)`, [ownerId]);
    await adminClient.query(`SELECT set_config('app.tenant_id', $1, true)`, [venueId]);
    await expect(
      adminClient.query(
        `INSERT INTO app_private.pos_dish_mappings
          (tenant_id, pos_item_code, dish_id, review_status)
         VALUES ($1, 'POS-PROV-2', $2, 'pending')`,
        [venueId, dishId],
      ),
    ).rejects.toThrow(/Current actor is not authorized to create or modify POS dish mappings/);
    await adminClient.query('ROLLBACK');
  });

  // Probe 4: Concurrent identical-file idempotency (Finding E)
  it('handles concurrent identical-file imports safely using two PostgreSQL connections and advisory lock recheck', async () => {
    const { venueId, ownerId } = await createTestVenue();
    await recordVenueTrackingActivation(adminClient, ownerId, venueId, 'administrative');

    const client1 = new Client({ connectionString: runtimeUrl });
    const client2 = new Client({ connectionString: runtimeUrl });
    await client1.connect();
    await client2.connect();

    try {
      let barrierResolve: () => void;
      const barrier = new Promise<void>((resolve) => {
        barrierResolve = resolve;
      });

      let putsStarted = 0;
      let startBarrierResolve: () => void;
      const startBarrier = new Promise<void>((resolve) => {
        startBarrierResolve = resolve;
      });

      const deletedKeys: string[] = [];
      const storage: OrderOutcomeStorage = {
        async put() {
          putsStarted++;
          if (putsStarted === 2) {
            startBarrierResolve();
          }
          await barrier;
        },
        async delete(key) {
          deletedKeys.push(key);
        },
      };

      const csv = [
        'schema_version,order_id,order_line_id,ordered_at,pos_item_id,outcome_type,quantity',
        `pilot_order_outcome.v1,ORD-CONC-REAL,LINE-1,${new Date().toISOString()},POS-CONC,ordered,1`,
      ].join('\n');

      // Launch both requests simultaneously
      const req1 = importOrderOutcomes({
        client: client1,
        actorId: ownerId,
        venueId,
        csvText: csv,
        storage,
        trackingStartedAt: new Date(Date.now() - 3600000),
      });

      const req2 = importOrderOutcomes({
        client: client2,
        actorId: ownerId,
        venueId,
        csvText: csv,
        storage,
        trackingStartedAt: new Date(Date.now() - 3600000),
      });

      // Wait until both passed the initial check and began upload
      await startBarrier;
      // Release both to contend for the advisory lock
      barrierResolve!();

      const [res1, res2] = await Promise.all([req1, req2]);

      expect(res1.status).toBe('completed');
      expect(res2.status).toBe('completed');
      expect(res1.batchId).toBe(res2.batchId);

      // Exactly one request was original, the other was identified as duplicate file
      const duplicates = [res1.isDuplicateFile, res2.isDuplicateFile].filter(Boolean);
      expect(duplicates.length).toBe(1);

      // Redundant storage file was deleted
      expect(deletedKeys.length).toBe(1);

      // Exactly one batch exists in database
      const batchCount = await adminClient.query(
        `SELECT count(*)::int FROM app_private.order_outcome_import_batches WHERE tenant_id = $1`,
        [venueId],
      );
      expect(batchCount.rows[0].count).toBe(1);
    } finally {
      await client1.end().catch(() => {});
      await client2.end().catch(() => {});
    }
  });

  // Probe 5: Unambiguous tuple identity in real database (Finding F)
  it('accepts (A:B, C, ordered) and (A, B:C, ordered) independently in PostgreSQL composite primary key', async () => {
    const { venueId, ownerId } = await createTestVenue();
    const client = new Client({ connectionString: runtimeUrl });
    await client.connect();

    try {
      // Setup tracking & mapping
      await recordVenueTrackingActivation(adminClient, ownerId, venueId, 'administrative');
      const menuId = randomUUID();
      const menuRevisionId = randomUUID();
      const dishId = randomUUID();
      const dishRevisionId = randomUUID();
      const approvalId = randomUUID();
      const contentApprovalId = randomUUID();
      const assetApprovalId = randomUUID();

      const bundleJson = {
        schema_version: 1,
        venue_id: venueId,
        menu_id: menuId,
        menu_revision_id: menuRevisionId,
        restaurant: { name: 'Test Restaurant', logo: null },
        categories: [
          {
            category_id: randomUUID(),
            name: 'Cat',
            dishes: [
              {
                dish_id: dishId,
                dish_revision_id: dishRevisionId,
                complete: true,
                name: 'Dish',
                description: 'A delicious dish',
                price: { amount: '12.00', currency: 'USD' },
                ingredients: [],
                allergens: null,
                dietary: [],
                images: {
                  card: {
                    url: 'https://cdn.example.com/card.jpg',
                    width: 400,
                    height: 300,
                    alt: 'Dish',
                  },
                  detail: {
                    url: 'https://cdn.example.com/detail.jpg',
                    width: 800,
                    height: 600,
                    alt: 'Dish detail',
                  },
                },
              },
            ],
          },
        ],
      };
      const bundleString = JSON.stringify(bundleJson);
      const contentHash = sha256Hex(bundleString);
      const assetHash = 'b'.repeat(64);
      const bundleUrl = `https://assets.peekaplate.example/${venueId}/${menuRevisionId}/bundle.json`;

      globalThis.fetch = async (input, init) => {
        if (typeof input === 'string' && input === bundleUrl) {
          return new Response(bundleString, {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return originalFetch(input, init);
      };

      await adminClient.query(
        `INSERT INTO app_private.menu_review_subject
          (tenant_id, menu_id, menu_revision_id, content_approval_id, content_hash, asset_approval_id, asset_manifest_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          venueId,
          menuId,
          menuRevisionId,
          contentApprovalId,
          contentHash,
          assetApprovalId,
          assetHash,
        ],
      );

      await adminClient.query(
        `INSERT INTO app_private.menu_approval
          (tenant_id, approval_id, menu_id, review_version, menu_revision_id, content_approval_id, content_hash, asset_approval_id, asset_manifest_hash, approved_by)
         VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9)`,
        [
          venueId,
          approvalId,
          menuId,
          menuRevisionId,
          contentApprovalId,
          contentHash,
          assetApprovalId,
          assetHash,
          ownerId,
        ],
      );

      await adminClient.query(
        `INSERT INTO app_private.public_menu_bundle (tenant_id, menu_id, menu_revision_id, bundle_url)
         VALUES ($1, $2, $3, $4)`,
        [venueId, menuId, menuRevisionId, bundleUrl],
      );

      await adminClient.query(
        `INSERT INTO app_private.es_event
          (id, tenant_id, stream_type, stream_id, version, schema_version, event_type, payload, metadata, occurred_at)
         VALUES ($1, $2, 'menu_publication', $3, 1, 1, 'menu.published', $4::jsonb, '{}'::jsonb, now() - interval '1 hour')`,
        [
          randomUUID(),
          venueId,
          menuId,
          JSON.stringify({
            menuId,
            publicationId: randomUUID(),
            version: 1,
            approvalId,
            status: 'published',
          }),
        ],
      );

      await adminClient.query('BEGIN');
      await adminClient.query(`SELECT set_config('app.actor_id', $1, true)`, [ownerId]);
      await adminClient.query(`SELECT set_config('app.tenant_id', $1, true)`, [venueId]);
      await adminClient.query(
        `INSERT INTO app_private.pos_dish_mappings
          (tenant_id, pos_item_code, dish_id, dish_name, review_status, reviewed_by, reviewed_at)
         VALUES ($1, 'POS-TUPLE', $2, 'Dish', 'approved', $3, now())`,
        [venueId, dishId, ownerId],
      );
      await adminClient.query('COMMIT');

      const actRow = await adminClient.query<{ activated_at: Date }>(
        `SELECT activated_at FROM app_private.venue_tracking_activations WHERE tenant_id = $1`,
        [venueId],
      );
      const firstAct = actRow.rows[0];
      if (!firstAct) throw new Error('Missing activation');
      const orderTimestamp = new Date(firstAct.activated_at.getTime() + 2000).toISOString();

      const csv = [
        'schema_version,order_id,order_line_id,ordered_at,pos_item_id,outcome_type,quantity',
        `pilot_order_outcome.v1,A:B,C,${orderTimestamp},POS-TUPLE,ordered,1`,
        `pilot_order_outcome.v1,A,B:C,${orderTimestamp},POS-TUPLE,ordered,1`,
      ].join('\n');

      const result = await importOrderOutcomes({
        client,
        actorId: ownerId,
        venueId,
        csvText: csv,
        bundleLoader: async () => bundleJson,
      });

      expect(result.status).toBe('completed');
      expect(result.totalRows).toBe(2);
      expect(result.acceptedRows).toBe(2);
      expect(result.duplicateRows).toBe(0);

      // Verify both composite keys are distinct in PostgreSQL
      const persisted = await adminClient.query(
        `SELECT order_id, order_line_id FROM app_private.order_outcome_lines WHERE tenant_id = $1 ORDER BY order_id`,
        [venueId],
      );
      expect(persisted.rows.length).toBe(2);
      expect(persisted.rows[0].order_id).toBe('A');
      expect(persisted.rows[0].order_line_id).toBe('B:C');
      expect(persisted.rows[1].order_id).toBe('A:B');
      expect(persisted.rows[1].order_line_id).toBe('C');
    } finally {
      await client.end().catch(() => {});
    }
  });

  // Probe 6: Malformed UUID resolution does not raise PostgreSQL 22P02 or abort transaction
  it('prevents PostgreSQL 22P02 on malformed UUID and commits valid row beside quarantined row', async () => {
    const { venueId, ownerId } = await createTestVenue();
    const client = new Client({ connectionString: runtimeUrl });
    await client.connect();

    try {
      await recordVenueTrackingActivation(adminClient, ownerId, venueId, 'administrative');
      const menuId = randomUUID();
      const menuRevisionId = randomUUID();
      const dishId = randomUUID();
      const dishRevisionId = randomUUID();
      const approvalId = randomUUID();
      const contentApprovalId = randomUUID();
      const assetApprovalId = randomUUID();

      const bundleJson = {
        schema_version: 1,
        venue_id: venueId,
        menu_id: menuId,
        menu_revision_id: menuRevisionId,
        restaurant: { name: 'Test Restaurant', logo: null },
        categories: [
          {
            category_id: randomUUID(),
            name: 'Cat',
            dishes: [
              {
                dish_id: dishId,
                dish_revision_id: dishRevisionId,
                complete: true,
                name: 'Dish',
                description: 'A delicious dish',
                price: { amount: '12.00', currency: 'USD' },
                ingredients: [],
                allergens: null,
                dietary: [],
                images: {
                  card: {
                    url: 'https://cdn.example.com/card.jpg',
                    width: 400,
                    height: 300,
                    alt: 'Dish',
                  },
                  detail: {
                    url: 'https://cdn.example.com/detail.jpg',
                    width: 800,
                    height: 600,
                    alt: 'Dish detail',
                  },
                },
              },
            ],
          },
        ],
      };
      const bundleString = JSON.stringify(bundleJson);
      const contentHash = sha256Hex(bundleString);
      const assetHash = 'c'.repeat(64);
      const bundleUrl = `https://assets.peekaplate.example/${venueId}/${menuRevisionId}/bundle.json`;

      await adminClient.query(
        `INSERT INTO app_private.menu_review_subject
          (tenant_id, menu_id, menu_revision_id, content_approval_id, content_hash, asset_approval_id, asset_manifest_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          venueId,
          menuId,
          menuRevisionId,
          contentApprovalId,
          contentHash,
          assetApprovalId,
          assetHash,
        ],
      );

      await adminClient.query(
        `INSERT INTO app_private.menu_approval
          (tenant_id, approval_id, menu_id, review_version, menu_revision_id, content_approval_id, content_hash, asset_approval_id, asset_manifest_hash, approved_by)
         VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9)`,
        [
          venueId,
          approvalId,
          menuId,
          menuRevisionId,
          contentApprovalId,
          contentHash,
          assetApprovalId,
          assetHash,
          ownerId,
        ],
      );

      await adminClient.query(
        `INSERT INTO app_private.public_menu_bundle (tenant_id, menu_id, menu_revision_id, bundle_url)
         VALUES ($1, $2, $3, $4)`,
        [venueId, menuId, menuRevisionId, bundleUrl],
      );

      await adminClient.query(
        `INSERT INTO app_private.es_event
          (id, tenant_id, stream_type, stream_id, version, schema_version, event_type, payload, metadata, occurred_at)
         VALUES ($1, $2, 'menu_publication', $3, 1, 1, 'menu.published', $4::jsonb, '{}'::jsonb, now() - interval '1 hour')`,
        [
          randomUUID(),
          venueId,
          menuId,
          JSON.stringify({
            menuId,
            publicationId: randomUUID(),
            version: 1,
            approvalId,
            status: 'published',
          }),
        ],
      );

      const actRow = await adminClient.query<{ activated_at: Date }>(
        `SELECT activated_at FROM app_private.venue_tracking_activations WHERE tenant_id = $1`,
        [venueId],
      );
      const orderTimestamp = new Date(actRow.rows[0]!.activated_at.getTime() + 2000).toISOString();

      const csv = [
        'schema_version,order_id,order_line_id,ordered_at,menu_revision_id,dish_id,dish_revision_id,outcome_type,quantity',
        `pilot_order_outcome.v1,ORD-VALID-ROW,LINE-1,${orderTimestamp},${menuRevisionId},${dishId},${dishRevisionId},ordered,1`,
        `pilot_order_outcome.v1,ORD-BAD-UUID,LINE-2,${orderTimestamp},not-a-uuid,${dishId},${dishRevisionId},ordered,1`,
      ].join('\n');

      const result = await importOrderOutcomes({
        client,
        actorId: ownerId,
        venueId,
        csvText: csv,
        bundleLoader: async () => bundleJson,
      });

      expect(result.status).toBe('completed');
      expect(result.totalRows).toBe(2);
      expect(result.acceptedRows).toBe(1);
      expect(result.quarantinedRows).toBe(1);

      // Verify PostgreSQL state
      const lines = await adminClient.query(
        `SELECT order_id FROM app_private.order_outcome_lines WHERE tenant_id = $1`,
        [venueId],
      );
      expect(lines.rows).toHaveLength(1);
      expect(lines.rows[0].order_id).toBe('ORD-VALID-ROW');

      const quarantine = await adminClient.query(
        `SELECT reason_code, field_name, diagnostic_message FROM app_private.order_outcome_quarantine WHERE tenant_id = $1`,
        [venueId],
      );
      expect(quarantine.rows).toHaveLength(1);
      expect(quarantine.rows[0].reason_code).toBe('invalid_format');
      expect(quarantine.rows[0].field_name).toBe('menu_revision_id');
      expect(quarantine.rows[0].diagnostic_message).toBe(
        'menu_revision_id must be a valid canonical UUID',
      );
    } finally {
      await client.end().catch(() => {});
    }
  });

  // Probe 7: Sensitive and oversized POS identifiers are quarantined without violating PostgreSQL length constraints
  it('quarantines email-like and 600-character POS identifiers in real PostgreSQL without constraint violation', async () => {
    const { venueId, ownerId } = await createTestVenue();
    const client = new Client({ connectionString: runtimeUrl });
    await client.connect();

    try {
      await recordVenueTrackingActivation(adminClient, ownerId, venueId, 'administrative');
      const menuId = randomUUID();
      const menuRevisionId = randomUUID();
      const dishId = randomUUID();
      const dishRevisionId = randomUUID();
      const approvalId = randomUUID();
      const contentApprovalId = randomUUID();
      const assetApprovalId = randomUUID();

      const bundleJson = {
        schema_version: 1,
        venue_id: venueId,
        menu_id: menuId,
        menu_revision_id: menuRevisionId,
        restaurant: { name: 'Test Restaurant', logo: null },
        categories: [
          {
            category_id: randomUUID(),
            name: 'Cat',
            dishes: [
              {
                dish_id: dishId,
                dish_revision_id: dishRevisionId,
                complete: true,
                name: 'Pizza',
                description: 'A delicious pizza',
                price: { amount: '14.00', currency: 'USD' },
                ingredients: [],
                allergens: null,
                dietary: [],
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
      const bundleString = JSON.stringify(bundleJson);
      const contentHash = sha256Hex(bundleString);
      const assetHash = 'd'.repeat(64);
      const bundleUrl = `https://assets.peekaplate.example/${venueId}/${menuRevisionId}/bundle.json`;

      await adminClient.query(
        `INSERT INTO app_private.menu_review_subject
          (tenant_id, menu_id, menu_revision_id, content_approval_id, content_hash, asset_approval_id, asset_manifest_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          venueId,
          menuId,
          menuRevisionId,
          contentApprovalId,
          contentHash,
          assetApprovalId,
          assetHash,
        ],
      );

      await adminClient.query(
        `INSERT INTO app_private.menu_approval
          (tenant_id, approval_id, menu_id, review_version, menu_revision_id, content_approval_id, content_hash, asset_approval_id, asset_manifest_hash, approved_by)
         VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9)`,
        [
          venueId,
          approvalId,
          menuId,
          menuRevisionId,
          contentApprovalId,
          contentHash,
          assetApprovalId,
          assetHash,
          ownerId,
        ],
      );

      await adminClient.query(
        `INSERT INTO app_private.public_menu_bundle (tenant_id, menu_id, menu_revision_id, bundle_url)
         VALUES ($1, $2, $3, $4)`,
        [venueId, menuId, menuRevisionId, bundleUrl],
      );

      await adminClient.query(
        `INSERT INTO app_private.es_event
          (id, tenant_id, stream_type, stream_id, version, schema_version, event_type, payload, metadata, occurred_at)
         VALUES ($1, $2, 'menu_publication', $3, 1, 1, 'menu.published', $4::jsonb, '{}'::jsonb, now() - interval '1 hour')`,
        [
          randomUUID(),
          venueId,
          menuId,
          JSON.stringify({
            menuId,
            publicationId: randomUUID(),
            version: 1,
            approvalId,
            status: 'published',
          }),
        ],
      );

      await adminClient.query('BEGIN');
      await adminClient.query(`SELECT set_config('app.actor_id', $1, true)`, [ownerId]);
      await adminClient.query(`SELECT set_config('app.tenant_id', $1, true)`, [venueId]);
      await adminClient.query(
        `INSERT INTO app_private.pos_dish_mappings
          (tenant_id, pos_item_code, dish_id, dish_name, review_status, reviewed_by, reviewed_at)
         VALUES ($1, 'POS-VALID', $2, 'Pizza', 'approved', $3, now())`,
        [venueId, dishId, ownerId],
      );
      await adminClient.query('COMMIT');

      const actRow = await adminClient.query<{ activated_at: Date }>(
        `SELECT activated_at FROM app_private.venue_tracking_activations WHERE tenant_id = $1`,
        [venueId],
      );
      const orderTimestamp = new Date(actRow.rows[0]!.activated_at.getTime() + 2000).toISOString();

      const sensitiveEmail = 'waiter@private-restaurant.example';
      const oversized600 = 'X'.repeat(600);

      const csv = [
        'schema_version,order_id,order_line_id,ordered_at,pos_item_id,outcome_type,quantity',
        `pilot_order_outcome.v1,ORD-VALID,LINE-1,${orderTimestamp},POS-VALID,ordered,1`,
        `pilot_order_outcome.v1,ORD-EMAIL,LINE-2,${orderTimestamp},${sensitiveEmail},ordered,1`,
        `pilot_order_outcome.v1,ORD-BIG,LINE-3,${orderTimestamp},${oversized600},ordered,1`,
      ].join('\n');

      const result = await importOrderOutcomes({
        client,
        actorId: ownerId,
        venueId,
        csvText: csv,
        bundleLoader: async () => bundleJson,
      });

      expect(result.status).toBe('completed');
      expect(result.totalRows).toBe(3);
      expect(result.acceptedRows).toBe(1);
      expect(result.quarantinedRows).toBe(2);

      // Verify PostgreSQL lines
      const lines = await adminClient.query(
        `SELECT order_id FROM app_private.order_outcome_lines WHERE tenant_id = $1`,
        [venueId],
      );
      expect(lines.rows).toHaveLength(1);
      expect(lines.rows[0].order_id).toBe('ORD-VALID');

      // Verify PostgreSQL quarantine records: length constraints strictly respected and no leaked values
      const quarantine = await adminClient.query<{
        reason_code: string;
        diagnostic_message: string;
      }>(
        `SELECT reason_code, diagnostic_message FROM app_private.order_outcome_quarantine WHERE tenant_id = $1 ORDER BY created_at`,
        [venueId],
      );
      expect(quarantine.rows).toHaveLength(2);
      for (const row of quarantine.rows) {
        expect(row.diagnostic_message.length).toBeLessThanOrEqual(500);
        expect(row.diagnostic_message).not.toContain(sensitiveEmail);
        expect(row.diagnostic_message).not.toContain(oversized600);
      }
    } finally {
      await client.end().catch(() => {});
    }
  });

  // Probe 8: Inverted transaction timestamps in real PostgreSQL es_event: highest version withdrawal wins
  it('selects highest stream version in real PostgreSQL even when transaction timestamps are inverted', async () => {
    const { venueId, ownerId } = await createTestVenue();
    const client = new Client({ connectionString: runtimeUrl });
    await client.connect();

    try {
      await recordVenueTrackingActivation(adminClient, ownerId, venueId, 'administrative');
      const menuId = randomUUID();
      const menuRevisionId = randomUUID();
      const dishId = randomUUID();
      const dishRevisionId = randomUUID();
      const approvalId = randomUUID();
      const contentApprovalId = randomUUID();
      const assetApprovalId = randomUUID();

      const bundleJson = {
        schema_version: 1,
        venue_id: venueId,
        menu_id: menuId,
        menu_revision_id: menuRevisionId,
        restaurant: { name: 'Test Restaurant', logo: null },
        categories: [
          {
            category_id: randomUUID(),
            name: 'Cat',
            dishes: [
              {
                dish_id: dishId,
                dish_revision_id: dishRevisionId,
                complete: true,
                name: 'Salad',
                description: 'Fresh salad',
                price: { amount: '10.00', currency: 'USD' },
                ingredients: [],
                allergens: null,
                dietary: [],
                images: {
                  card: {
                    url: 'https://cdn.example.com/card.jpg',
                    width: 400,
                    height: 300,
                    alt: 'Salad',
                  },
                  detail: {
                    url: 'https://cdn.example.com/detail.jpg',
                    width: 800,
                    height: 600,
                    alt: 'Salad detail',
                  },
                },
              },
            ],
          },
        ],
      };
      const bundleString = JSON.stringify(bundleJson);
      const contentHash = sha256Hex(bundleString);
      const assetHash = 'e'.repeat(64);
      const bundleUrl = `https://assets.peekaplate.example/${venueId}/${menuRevisionId}/bundle.json`;

      await adminClient.query(
        `INSERT INTO app_private.menu_review_subject
          (tenant_id, menu_id, menu_revision_id, content_approval_id, content_hash, asset_approval_id, asset_manifest_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          venueId,
          menuId,
          menuRevisionId,
          contentApprovalId,
          contentHash,
          assetApprovalId,
          assetHash,
        ],
      );

      await adminClient.query(
        `INSERT INTO app_private.menu_approval
          (tenant_id, approval_id, menu_id, review_version, menu_revision_id, content_approval_id, content_hash, asset_approval_id, asset_manifest_hash, approved_by)
         VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9)`,
        [
          venueId,
          approvalId,
          menuId,
          menuRevisionId,
          contentApprovalId,
          contentHash,
          assetApprovalId,
          assetHash,
          ownerId,
        ],
      );

      await adminClient.query(
        `INSERT INTO app_private.public_menu_bundle (tenant_id, menu_id, menu_revision_id, bundle_url)
         VALUES ($1, $2, $3, $4)`,
        [venueId, menuId, menuRevisionId, bundleUrl],
      );

      const actRow = await adminClient.query<{ activated_at: Date }>(
        `SELECT activated_at FROM app_private.venue_tracking_activations WHERE tenant_id = $1`,
        [venueId],
      );
      const actDate = actRow.rows[0]!.activated_at;
      const v2OccurredAt = new Date(actDate.getTime()).toISOString();
      const v1OccurredAt = new Date(actDate.getTime() + 1000).toISOString();
      const orderTimestamp = new Date(actDate.getTime() + 2000).toISOString();

      // v1 published has LATER occurred_at (actDate + 1s)
      await adminClient.query(
        `INSERT INTO app_private.es_event
          (id, tenant_id, stream_type, stream_id, version, schema_version, event_type, payload, metadata, occurred_at)
         VALUES ($1, $2, 'menu_publication', $3, 1, 1, 'menu.published', $4::jsonb, '{}'::jsonb, $5)`,
        [
          randomUUID(),
          venueId,
          menuId,
          JSON.stringify({
            menuId,
            publicationId: randomUUID(),
            version: 1,
            approvalId,
            status: 'published',
          }),
          v1OccurredAt,
        ],
      );

      // v2 withdrawn has EARLIER occurred_at (actDate) due to transaction timestamp inversion
      await adminClient.query(
        `INSERT INTO app_private.es_event
          (id, tenant_id, stream_type, stream_id, version, schema_version, event_type, payload, metadata, occurred_at)
         VALUES ($1, $2, 'menu_publication', $3, 2, 1, 'menu.withdrawn', $4::jsonb, '{}'::jsonb, $5)`,
        [
          randomUUID(),
          venueId,
          menuId,
          JSON.stringify({ menuId, publicationId: randomUUID(), version: 2, status: 'withdrawn' }),
          v2OccurredAt,
        ],
      );

      const csv = [
        'schema_version,order_id,order_line_id,ordered_at,menu_revision_id,dish_id,dish_revision_id,outcome_type,quantity',
        `pilot_order_outcome.v1,ORD-INVERT-TS,LINE-1,${orderTimestamp},${menuRevisionId},${dishId},${dishRevisionId},ordered,1`,
      ].join('\n');

      const result = await importOrderOutcomes({
        client,
        actorId: ownerId,
        venueId,
        csvText: csv,
        bundleLoader: async () => bundleJson,
      });

      // v2 withdrawal wins: row is quarantined, 0 accepted
      expect(result.status).toBe('completed');
      expect(result.acceptedRows).toBe(0);
      expect(result.quarantinedRows).toBe(1);
      expect(result.diagnostics[0]?.reasonCode).toBe('out_of_revision_window');

      const lines = await adminClient.query(
        `SELECT count(*)::int as count FROM app_private.order_outcome_lines WHERE tenant_id = $1`,
        [venueId],
      );
      expect(lines.rows[0].count).toBe(0);
    } finally {
      await client.end().catch(() => {});
    }
  });

  // Probe 6: S6-DATA-14.1 & S6-DATA-14.2 real PostgreSQL RLS, trigger & deletion probes
  it('enforces agreement acceptance and owner-scoped deletion with restricted runtime role', async () => {
    const { venueId, ownerId, editorId } = await createTestVenue({ acceptAgreement: false });
    const { venueId: otherVenueId, ownerId: otherOwnerId } = await createTestVenue();

    const runtimeClient = new Client({ connectionString: runtimeUrl });
    await runtimeClient.connect();
    try {
      const csv = [
        'schema_version,order_id,order_line_id,ordered_at,pos_item_id,outcome_type,quantity',
        'pilot_order_outcome.v1,ORD-INT-1,LINE-1,2026-11-10T12:00:00Z,POS-1,ordered,1',
      ].join('\n');

      // 1. Import blocked before agreement acceptance
      await expect(
        importOrderOutcomes({
          client: runtimeClient,
          actorId: ownerId,
          venueId,
          csvText: csv,
        }),
      ).rejects.toMatchObject({ code: 'agreement_not_accepted', status: 403 });

      // 2. Editor cannot accept agreement
      await expect(
        acceptPilotOrderAgreement({
          client: runtimeClient,
          actorId: editorId,
          venueId,
          agreementVersion: PILOT_ORDER_AGREEMENT_VERSION,
        }),
      ).rejects.toMatchObject({ code: 'forbidden', status: 403 });

      // 3. Owner accepts agreement (concurrent/idempotent safety)
      const accepted = await acceptPilotOrderAgreement({
        client: runtimeClient,
        actorId: ownerId,
        venueId,
        agreementVersion: PILOT_ORDER_AGREEMENT_VERSION,
      });
      expect(accepted.alreadyAccepted).toBe(false);

      const acceptedAgain = await acceptPilotOrderAgreement({
        client: runtimeClient,
        actorId: ownerId,
        venueId,
        agreementVersion: PILOT_ORDER_AGREEMENT_VERSION,
      });
      expect(acceptedAgain.alreadyAccepted).toBe(true);

      // 4. Direct DELETE and GUC-spoofed DELETE on order_outcome_lines are rejected for runtime
      await expect(
        runtimeClient.query(`DELETE FROM app_private.order_outcome_lines WHERE tenant_id = $1`, [
          venueId,
        ]),
      ).rejects.toThrow();

      await expect(
        (async () => {
          await runtimeClient.query('BEGIN');
          await runtimeClient.query(
            "SELECT set_config('app.order_data_deletion_active', 'on', true)",
          );
          await runtimeClient.query(
            `DELETE FROM app_private.order_outcome_lines WHERE tenant_id = $1`,
            [venueId],
          );
        })(),
      ).rejects.toThrow();
      await runtimeClient.query('ROLLBACK').catch(() => {});

      // 5. Populate Venue A and Venue B order-outcome rows via adminClient, then run owner request + operator deletion
      const batchA = randomUUID();
      const batchB = randomUUID();
      await adminClient.query(
        `INSERT INTO app_private.order_outcome_import_batches
           (id, tenant_id, schema_version, created_by, source_filename, file_sha256, storage_key, status, finished_at)
         VALUES
           ($1, $2, 'pilot_order_outcome.v1', $3, 'a.csv', $4, $5, 'completed', now()),
           ($6, $7, 'pilot_order_outcome.v1', $8, 'b.csv', $9, $10, 'completed', now())`,
        [
          batchA,
          venueId,
          ownerId,
          sha256Hex('a'),
          `order-imports/${venueId}/b1/source.csv`,
          batchB,
          otherVenueId,
          otherOwnerId,
          sha256Hex('b'),
          `order-imports/${otherVenueId}/b2/source.csv`,
        ],
      );
      await adminClient.query(
        `INSERT INTO app_private.order_outcome_lines
           (tenant_id, batch_id, order_id, order_line_id, ordered_at, menu_revision_id, dish_id, dish_revision_id, outcome_type, quantity, payload_checksum)
         VALUES
           ($1, $2, 'ORD-A', 'L1', now(), $3, $4, $5, 'ordered', 1, $6),
           ($7, $8, 'ORD-B', 'L1', now(), $9, $10, $11, 'ordered', 1, $12)`,
        [
          venueId,
          batchA,
          randomUUID(),
          randomUUID(),
          randomUUID(),
          sha256Hex('line-a'),
          otherVenueId,
          batchB,
          randomUUID(),
          randomUUID(),
          randomUUID(),
          sha256Hex('line-b'),
        ],
      );

      await adminClient.query(
        `INSERT INTO app_private.order_outcome_quarantine
           (id, tenant_id, batch_id, row_index, reason_code, diagnostic_message)
         VALUES
           ($1, $2, $3, 1, 'invalid_format', 'bad_row_a'),
           ($4, $5, $6, 1, 'invalid_format', 'bad_row_b')`,
        [randomUUID(), venueId, batchA, randomUUID(), otherVenueId, batchB],
      );
      await adminClient.query(
        `INSERT INTO app_private.order_outcome_conflicts
           (tenant_id, order_id, order_line_id, outcome_type, batch_id, existing_checksum, incoming_checksum)
         VALUES
           ($1, 'ORD-A', 'L2', 'ordered', $2, $3, $4),
           ($5, 'ORD-B', 'L2', 'ordered', $6, $7, $8)`,
        [
          venueId,
          batchA,
          sha256Hex('c1'),
          sha256Hex('c2'),
          otherVenueId,
          batchB,
          sha256Hex('c3'),
          sha256Hex('c4'),
        ],
      );

      const r2Objects = new Map<string, string>([
        [`order-imports/${venueId}/b1/source.csv`, 'csv-a'],
        [`order-imports/${otherVenueId}/b2/source.csv`, 'csv-b'],
      ]);
      const storage: OrderOutcomeStorage = {
        put: async (key, val) => {
          r2Objects.set(key, typeof val === 'string' ? val : 'binary');
        },
        list: async (opts) => ({
          objects: [...r2Objects.keys()]
            .filter((k) => !opts?.prefix || k.startsWith(opts.prefix))
            .map((key) => ({ key, uploaded: new Date() })),
          truncated: false,
        }),
        delete: async (key) => {
          r2Objects.delete(key);
        },
      };

      const requestId = randomUUID();
      const operatorId = randomUUID();
      const authorizedOperatorIds = new Set([operatorId]);

      // Cross-tenant submission by otherOwnerId against venueId is denied
      await expect(
        submitOrderDataDeletionRequest({
          client: runtimeClient,
          actorId: otherOwnerId,
          venueId,
          requestId,
          reason: 'pilot_withdrawal',
        }),
      ).rejects.toMatchObject({ code: 'forbidden', status: 403 });

      // Owner submits deletion request for Venue A
      const submitted = await submitOrderDataDeletionRequest({
        client: runtimeClient,
        actorId: ownerId,
        venueId,
        requestId,
        reason: 'pilot_withdrawal',
      });
      expect(submitted.status).toBe('requested');

      // Other venue owner can use the same requestId in their own tenant (composite PK (tenant_id, id))
      const otherSubmitted = await submitOrderDataDeletionRequest({
        client: runtimeClient,
        actorId: otherOwnerId,
        venueId: otherVenueId,
        requestId,
        reason: 'data_cleanup',
      });
      expect(otherSubmitted.status).toBe('requested');

      // Concurrent deletion test with two separate PostgreSQL connections:
      // 1. Start deletion on Venue A with a slow storage.list so a second concurrent execution overlaps
      // 2. Verify second concurrent execution for Venue A fails with 409 deletion_in_progress
      // 3. Verify Venue B deletion runs independently without blocking
      const concurrentClient = new Client({ connectionString: runtimeUrl });
      await concurrentClient.connect();
      try {
        let releaseFirstList!: () => void;
        const firstListEntered = new Promise<void>((resolve) => {
          const origList = storage.list!;
          let intercepted = false;
          storage.list = async (opts) => {
            if (!intercepted && opts?.prefix === `order-imports/${venueId}/`) {
              intercepted = true;
              resolve();
              await new Promise<void>((r) => {
                releaseFirstList = r;
              });
            }
            return origList(opts);
          };
        });

        const firstDeletePromise = deleteVenueOrderData({
          client: runtimeClient,
          operatorId,
          venueId,
          requestId,
          storage,
          authorizedOperatorIds,
        });

        await firstListEntered;

        // Second concurrent execution for the same venue is rejected with 409 deletion_in_progress
        await expect(
          deleteVenueOrderData({
            client: concurrentClient,
            operatorId,
            venueId,
            requestId,
            storage,
            authorizedOperatorIds,
          }),
        ).rejects.toMatchObject({ code: 'deletion_in_progress', status: 409 });

        // Different venue (otherVenueId) is NOT blocked while Venue A is executing
        const otherDeleted = await deleteVenueOrderData({
          client: concurrentClient,
          operatorId,
          venueId: otherVenueId,
          requestId,
          storage,
          authorizedOperatorIds,
        });
        expect(otherDeleted.status).toBe('completed');
        expect(otherDeleted.dbBatchesDeleted).toBe(1);

        releaseFirstList();
        const deleted = await firstDeletePromise;
        expect(deleted.status).toBe('completed');
        expect(deleted.operatorId).toBe(operatorId);
        expect(deleted.r2ObjectsDeleted).toBe(1);
        expect(deleted.dbBatchesDeleted).toBe(1);
        expect(deleted.dbLinesDeleted).toBe(1);
        expect(deleted.dbQuarantineDeleted).toBe(1);
        expect(deleted.dbConflictsDeleted).toBe(1);
      } finally {
        await concurrentClient.end().catch(() => {});
      }
      expect(r2Objects.has(`order-imports/${venueId}/b1/source.csv`)).toBe(false);
      expect(r2Objects.has(`order-deletion-ledger/${venueId}/${requestId}/intent.json`)).toBe(true);
      expect(r2Objects.has(`order-deletion-ledger/${venueId}/${requestId}/completed.json`)).toBe(
        true,
      );
      expect(r2Objects.has(`order-imports/${otherVenueId}/b2/source.csv`)).toBe(false);

      // Verify both venues have 0 rows across all 4 tables after their respective deletions
      const remainingA = await adminClient.query<{ total: string }>(
        `SELECT (
           (SELECT count(*) FROM app_private.order_outcome_import_batches WHERE tenant_id = $1) +
           (SELECT count(*) FROM app_private.order_outcome_lines WHERE tenant_id = $1) +
           (SELECT count(*) FROM app_private.order_outcome_quarantine WHERE tenant_id = $1) +
           (SELECT count(*) FROM app_private.order_outcome_conflicts WHERE tenant_id = $1)
         )::text AS total`,
        [venueId],
      );
      expect(Number(remainingA.rows[0]?.total)).toBe(0);

      const remainingB = await adminClient.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM app_private.order_outcome_lines WHERE tenant_id = $1`,
        [otherVenueId],
      );
      expect(Number(remainingB.rows[0]?.count)).toBe(0);

      // Same CSV file_sha256 can be re-uploaded as a new import for Venue A after deletion completes
      const reuploadedBatchId = randomUUID();
      await expect(
        adminClient.query(
          `INSERT INTO app_private.order_outcome_import_batches
             (id, tenant_id, schema_version, created_by, source_filename, file_sha256, storage_key, status, finished_at)
           VALUES
             ($1, $2, 'pilot_order_outcome.v1', $3, 'a.csv', $4, $5, 'completed', now())`,
          [
            reuploadedBatchId,
            venueId,
            ownerId,
            sha256Hex('a'),
            `order-imports/${venueId}/b-reupload/source.csv`,
          ],
        ),
      ).resolves.toBeDefined();

      // Lease renewal (heartbeat) & stale-worker fencing test with controlled clock and separate DB connections:
      // 1. Long-running deletion renews lease past initial lease duration so a second worker gets 409 deletion_in_progress
      // 2. Stale paused worker whose lease expired is fenced out (409 deletion_lease_lost) when replacement worker takes over
      const leaseRequestId = randomUUID();
      const leaseClient2 = new Client({ connectionString: runtimeUrl });
      await leaseClient2.connect();
      try {
        await submitOrderDataDeletionRequest({
          client: runtimeClient,
          actorId: ownerId,
          venueId,
          requestId: leaseRequestId,
          reason: 'data_cleanup',
        });

        let clockMs = Date.parse('2026-11-13T12:00:00.000Z');
        const controlledNow = () => new Date(clockMs);
        const leaseMs = 150;

        r2Objects.set(`order-imports/${venueId}/b-reupload/source.csv`, 'csv-reupload');

        // Scenario A: Long-running R2 deletion advances clock beyond leaseMs while renewing heartbeat
        let releaseSlowDelete!: () => void;
        const slowDeleteStarted = new Promise<void>((resolve) => {
          const origDelete = storage.delete!;
          let intercepted = false;
          storage.delete = async (key: string) => {
            if (!intercepted && key.includes('b-reupload')) {
              intercepted = true;
              // Advance clock by 80ms (> leaseMs/3) so next step renews lease, and pause
              clockMs += 80;
              resolve();
              await new Promise<void>((r) => {
                releaseSlowDelete = r;
              });
            }
            return origDelete(key);
          };
        });

        const slowWorkerPromise = deleteVenueOrderData({
          client: runtimeClient,
          operatorId,
          venueId,
          requestId: leaseRequestId,
          storage,
          authorizedOperatorIds,
          executionLeaseMs: leaseMs,
          now: controlledNow,
        });

        await slowDeleteStarted;
        // Second worker tries to take over while Worker 1's lease is still valid -> 409 deletion_in_progress
        await expect(
          deleteVenueOrderData({
            client: leaseClient2,
            operatorId,
            venueId,
            requestId: leaseRequestId,
            storage,
            authorizedOperatorIds,
            executionLeaseMs: leaseMs,
            now: controlledNow,
          }),
        ).rejects.toMatchObject({ code: 'deletion_in_progress', status: 409 });

        releaseSlowDelete();
        const slowRes = await slowWorkerPromise;
        expect(slowRes.status).toBe('completed');

        // Scenario B: Stale worker pauses past lease expiry without renewing; replacement worker takes over and stale worker gets 409 deletion_lease_lost
        const staleReqId = randomUUID();
        await adminClient.query(
          `INSERT INTO app_private.order_outcome_import_batches
             (id, tenant_id, schema_version, created_by, source_filename, file_sha256, storage_key, status, finished_at)
           VALUES ($1, $2, 'pilot_order_outcome.v1', $3, 'stale.csv', $4, $5, 'completed', now())`,
          [
            randomUUID(),
            venueId,
            ownerId,
            sha256Hex('stale'),
            `order-imports/${venueId}/b-stale/source.csv`,
          ],
        );
        await submitOrderDataDeletionRequest({
          client: runtimeClient,
          actorId: ownerId,
          venueId,
          requestId: staleReqId,
          reason: 'data_cleanup',
        });

        let releaseStaleWorker!: () => void;
        const staleWorkerPaused = new Promise<void>((resolve) => {
          const origList = storage.list!;
          let intercepted = false;
          storage.list = async (opts) => {
            if (!intercepted && opts?.prefix === `order-imports/${venueId}/`) {
              intercepted = true;
              resolve();
              await new Promise<void>((r) => {
                releaseStaleWorker = r;
              });
            }
            return origList(opts);
          };
        });

        const staleWorkerPromise = deleteVenueOrderData({
          client: runtimeClient,
          operatorId,
          venueId,
          requestId: staleReqId,
          storage,
          authorizedOperatorIds,
          executionLeaseMs: leaseMs,
          now: controlledNow,
        });

        await staleWorkerPaused;
        // Advance clock past lease expiry (leaseMs = 150ms -> +200ms) while Worker 1 is frozen
        clockMs += 200;

        // Replacement worker (Worker 2) safely takes over the expired lease and completes deletion
        const replacementRes = await deleteVenueOrderData({
          client: leaseClient2,
          operatorId,
          venueId,
          requestId: staleReqId,
          storage,
          authorizedOperatorIds,
          executionLeaseMs: leaseMs,
          now: controlledNow,
        });
        expect(replacementRes.status).toBe('completed');
        expect(replacementRes.dbBatchesDeleted).toBe(1);

        // Stale Worker 1 wakes up and tries to continue -> fenced out with 409 deletion_lease_lost
        releaseStaleWorker();
        await expect(staleWorkerPromise).rejects.toMatchObject({
          code: 'deletion_lease_lost',
          status: 409,
        });

        // Audit record remains completed (never clobbered by stale Worker 1)
        const finalAudit = await adminClient.query<{ status: string; executed_by: string }>(
          `SELECT status, executed_by FROM app_private.order_data_deletion_requests WHERE tenant_id = $1 AND id = $2`,
          [venueId, staleReqId],
        );
        expect(finalAudit.rows[0]?.status).toBe('completed');
        expect(finalAudit.rows[0]?.executed_by).toBe(operatorId);
      } finally {
        await leaseClient2.end().catch(() => {});
      }
    } finally {
      await runtimeClient.end().catch(() => {});
    }
  });
});
