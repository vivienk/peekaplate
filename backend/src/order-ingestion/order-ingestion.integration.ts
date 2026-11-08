import { createHash, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../index';
import { importOrderOutcomes, type OrderOutcomeStorage } from './service';
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

  async function createTestVenue() {
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
});
