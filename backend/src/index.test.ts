import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath, URL } from 'node:url';
import {
  canonicalJson,
  classifyObservationTimeWindow,
  ObservationConflictQueueMessageSchema,
  ObservationQueueEnvelopeSchema,
  ObservationQueueMessageSchema,
  ObservationReceiptBatchSchema,
  sha256,
  toCanonicalObservation,
} from '@peekaplate/contracts';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import { createStaffVerifier } from './auth';
import app, {
  CONSOLE_REPORT_CORS_ALLOWED_ORIGINS,
  consumeJtiRateLimit,
  createApp,
  createWorker,
  handleQueueBatch,
  handleScheduled,
  OrderImportError,
  queue,
  SYNTHETIC_REPORT_VENUE_ALLOWLIST,
  scheduled,
} from './index';
import { ingestObservations } from './observation-ingest';
import { ReviewCommandError } from './review-command';

const fixtureV2 = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        '../../processing/tests/fixtures/review-candidates/representative-candidates-v2.json',
        import.meta.url,
      ),
    ),
    'utf8',
  ),
);

const parseObservationReceiptBatch = async (response: Response) =>
  ObservationReceiptBatchSchema.parse(await response.json());

describe('worker queue consumer wiring', () => {
  it('exports queue handler on default app and as named export', () => {
    expect(typeof queue).toBe('function');
    expect(typeof (app as any).queue).toBe('function');
    expect((app as any).queue).toBe(queue);
  });

  it('safely handles queue invocation when archive bucket binding is missing', async () => {
    let retried = false;
    let delay: number | undefined;
    const batch = {
      queue: 'peekaplate-staging-observations',
      messages: [
        {
          id: 'msg-1',
          timestamp: new Date(),
          body: { test: true },
          attempts: 1,
          ack: vi.fn(),
          retry: vi.fn(),
        },
      ],
      ackAll: vi.fn(),
      retryAll: vi.fn((opts?: { delaySeconds?: number }) => {
        retried = true;
        delay = opts?.delaySeconds;
      }),
    };

    await (app as any).queue(batch, { APP_ENV: 'staging' });
    expect(retried).toBe(true);
    expect(delay).toBe(10);
  });

  it('delegates to injected queue consumer service through createWorker', async () => {
    let processBatchCalled = false;
    let cleanupCalled = false;

    const worker = createWorker(
      { verify: vi.fn(), execute: vi.fn() },
      {
        createConsumer: async () => ({
          consumer: {
            processBatch: async () => {
              processBatchCalled = true;
              return { processed: 1, acknowledged: 1, retried: 0, deadLettered: 0 };
            },
          } as any,
          cleanup: async () => {
            cleanupCalled = true;
          },
        }),
      },
    );

    const batch = {
      queue: 'peekaplate-staging-observations',
      messages: [],
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    };

    await worker.queue(batch, {});
    expect(processBatchCalled).toBe(true);
    expect(cleanupCalled).toBe(true);
  });

  it('exports scheduled cron handler on default app and as named export', () => {
    expect(typeof scheduled).toBe('function');
    expect(typeof (app as any).scheduled).toBe('function');
    expect((app as any).scheduled).toBe(scheduled);
  });

  it('safely completes scheduled invocation when bucket or database binding is missing', async () => {
    // Missing storage
    await expect(handleScheduled({}, {})).resolves.toBeUndefined();

    // Missing DB connection string with ORDER_IMPORT_BUCKET
    await expect(
      handleScheduled({}, { ORDER_IMPORT_BUCKET: { list: vi.fn(), delete: vi.fn() } }),
    ).resolves.toBeUndefined();

    // Missing DB connection string with ORDER_OUTCOME_ARCHIVE_BUCKET
    await expect(
      handleScheduled({}, { ORDER_OUTCOME_ARCHIVE_BUCKET: { list: vi.fn(), delete: vi.fn() } }),
    ).resolves.toBeUndefined();
  });
});

describe('foundation API', () => {
  it('returns a minimal liveness response without database or secret configuration', async () => {
    const response = await app.request('/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ok',
      service: 'peekaplate-api',
      stage: 'foundation',
    });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
  it('does not expose an unimplemented event ingestion endpoint', async () => {
    const response = await app.request('/events', { method: 'POST', body: '{}' });
    expect(response.status).toBe(404);
  });
  it('rejects an unauthenticated dish revision before accessing the database', async () => {
    const response = await app.request(
      '/venues/00000000-0000-4000-8000-000000000001/dishes/00000000-0000-4000-8000-000000000002/revisions',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized' });
  });
});

describe('owner report HTTP boundary', () => {
  it('fails closed without one explicit synthetic source using a signed staff JWT', async () => {
    const actorId = '00000000-0000-4000-8000-000000000003';
    const venueId = '00000000-0000-4000-8000-000000000001';
    const keys = await generateKeyPair('RS256');
    const publicJwk = {
      ...(await exportJWK(keys.publicKey)),
      kid: 'owner-report-test-key',
      use: 'sig',
      alg: 'RS256',
    };
    const jwksServer = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ keys: [publicJwk] }));
    });
    await new Promise<void>((resolve) => jwksServer.listen(0, '127.0.0.1', resolve));

    try {
      const address = jwksServer.address();
      if (!address || typeof address === 'string') {
        throw new Error('Test JWKS server did not provide an address.');
      }
      const issuer = `http://127.0.0.1:${address.port}/auth/v1`;
      const token = await new SignJWT({ role: 'authenticated', is_anonymous: false })
        .setProtectedHeader({ alg: 'RS256', kid: 'owner-report-test-key' })
        .setIssuer(issuer)
        .setAudience('authenticated')
        .setSubject(actorId)
        .setIssuedAt()
        .setExpirationTime('5 minutes')
        .sign(keys.privateKey);
      const syntheticVenueId = SYNTHETIC_REPORT_VENUE_ALLOWLIST[0];
      const readOwnerReport = vi.fn().mockResolvedValue({ venue_id: syntheticVenueId, dishes: [] });
      const app = createApp({
        verify: createStaffVerifier({ issuer, allowLocalIssuer: true }),
        execute: vi.fn(),
        readOwnerReport,
      });

      for (const [query, env] of [
        ['', { APP_ENV: 'local' }],
        ['?source=production', { APP_ENV: 'local' }],
        ['?source=synthetic&source=production', { APP_ENV: 'local' }],
        ['?source=synthetic', { APP_ENV: 'production' }],
        ['?source=synthetic', {}],
      ]) {
        const response = await app.request(
          `/api/v1/venues/${venueId}/analytics/dishes${query}`,
          {
            headers: { Authorization: `Bearer ${token}` },
          },
          env,
        );
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ error: 'service_unavailable' });
      }
      expect(readOwnerReport).not.toHaveBeenCalled();

      const syntheticResponse = await app.request(
        `/api/v1/venues/${syntheticVenueId}/analytics/dishes?source=synthetic`,
        { headers: { Authorization: `Bearer ${token}` } },
        { APP_ENV: 'local', SYNTHETIC_REPORT_VENUE_ID: syntheticVenueId },
      );
      expect(syntheticResponse.status).toBe(200);
      expect(await syntheticResponse.json()).toEqual({
        venue_id: syntheticVenueId,
        dishes: [],
      });
      expect(readOwnerReport).toHaveBeenCalledTimes(1);
      expect(readOwnerReport).toHaveBeenCalledWith(
        actorId,
        syntheticVenueId,
        expect.any(Date),
        { APP_ENV: 'local', SYNTHETIC_REPORT_VENUE_ID: syntheticVenueId },
        'synthetic',
      );

      const canonicalVenueResponse = await app.request(
        `/api/v1/venues/${venueId}/analytics/dishes?source=synthetic`,
        { headers: { Authorization: `Bearer ${token}` } },
        { APP_ENV: 'staging', SYNTHETIC_REPORT_VENUE_ID: venueId },
      );
      expect(canonicalVenueResponse.status).toBe(503);
      expect(await canonicalVenueResponse.json()).toEqual({ error: 'service_unavailable' });
      expect(readOwnerReport).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((resolve, reject) =>
        jwksServer.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('restricts the report reader to the configured synthetic venue', async () => {
    const actorId = '00000000-0000-4000-8000-000000000003';
    const venueId = SYNTHETIC_REPORT_VENUE_ALLOWLIST[0];
    const now = new Date('2026-11-06T12:00:00.000Z');
    const verify = vi.fn().mockResolvedValue(actorId);
    const readOwnerReport = vi.fn().mockResolvedValue({ venue_id: venueId, dishes: [] });
    const app = createApp({
      verify,
      execute: vi.fn(),
      readOwnerReport,
      now: () => now,
    });

    const response = await app.request(
      `/api/v1/venues/${venueId}/analytics/dishes?source=synthetic`,
      {
        headers: { Authorization: 'Bearer test-token' },
      },
      { APP_ENV: 'local', SYNTHETIC_REPORT_VENUE_ID: venueId },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ venue_id: venueId, dishes: [] });
    expect(verify).toHaveBeenCalledWith('Bearer test-token', {
      APP_ENV: 'local',
      SYNTHETIC_REPORT_VENUE_ID: venueId,
    });
    expect(readOwnerReport).toHaveBeenCalledWith(
      actorId,
      venueId,
      now,
      { APP_ENV: 'local', SYNTHETIC_REPORT_VENUE_ID: venueId },
      'synthetic',
    );
  });

  it('rejects an unapproved venue before reading live or mixed-provenance data', async () => {
    const actorId = '00000000-0000-4000-8000-000000000003';
    const requestedVenueId = '00000000-0000-4000-8000-000000000001';
    const approvedSyntheticVenueId = SYNTHETIC_REPORT_VENUE_ALLOWLIST[0];
    const readOwnerReport = vi.fn();
    const app = createApp({
      verify: vi.fn().mockResolvedValue(actorId),
      execute: vi.fn(),
      readOwnerReport,
    });

    const response = await app.request(
      `/api/v1/venues/${requestedVenueId}/analytics/dishes?source=synthetic`,
      { headers: { Authorization: ['Bearer', 'test-token'].join(' ') } },
      { APP_ENV: 'local', SYNTHETIC_REPORT_VENUE_ID: approvedSyntheticVenueId },
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'service_unavailable' });
    expect(readOwnerReport).not.toHaveBeenCalled();
  });

  it('allows only the exact console origins to call the report route from a browser', async () => {
    const actorId = '00000000-0000-4000-8000-000000000003';
    const venueId = SYNTHETIC_REPORT_VENUE_ALLOWLIST[0];
    const verify = vi.fn().mockResolvedValue(actorId);
    const readOwnerReport = vi.fn().mockResolvedValue({ venue_id: venueId, dishes: [] });
    const reportApp = createApp({ verify, execute: vi.fn(), readOwnerReport });
    const env = { APP_ENV: 'local', SYNTHETIC_REPORT_VENUE_ID: venueId };
    const path = `/api/v1/venues/${venueId}/analytics/dishes?source=synthetic`;
    const preflight = (origin: string) =>
      reportApp.request(
        path,
        {
          method: 'OPTIONS',
          headers: {
            Origin: origin,
            'Access-Control-Request-Method': 'GET',
            'Access-Control-Request-Headers': 'Authorization',
          },
        },
        env,
      );
    const get = (origin: string, authorization?: string) =>
      reportApp.request(
        path,
        { headers: { Origin: origin, ...(authorization ? { Authorization: authorization } : {}) } },
        env,
      );

    expect(CONSOLE_REPORT_CORS_ALLOWED_ORIGINS).toEqual([
      'https://peekaplate-console-staging.pages.dev',
      'http://127.0.0.1:5174',
    ]);
    for (const origin of CONSOLE_REPORT_CORS_ALLOWED_ORIGINS) {
      const allowed = await preflight(origin);
      expect(allowed.status).toBe(204);
      expect(allowed.headers.get('Access-Control-Allow-Origin')).toBe(origin);
      expect(allowed.headers.get('Access-Control-Allow-Methods')).toContain('GET');
      expect(allowed.headers.get('Access-Control-Allow-Methods')).not.toContain('POST');
      expect(allowed.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
      expect(allowed.headers.get('Access-Control-Max-Age')).toBe('86400');
      expect(allowed.headers.get('Access-Control-Allow-Credentials')).toBeNull();
      expect(allowed.headers.get('Vary')).toContain('Origin');

      const report = await get(origin, 'Bearer test-token');
      expect(report.status).toBe(200);
      expect(report.headers.get('Access-Control-Allow-Origin')).toBe(origin);
      expect(await report.json()).toEqual({ venue_id: venueId, dishes: [] });
    }
    // A preflight never reaches authentication or the report reader.
    expect(verify).toHaveBeenCalledTimes(CONSOLE_REPORT_CORS_ALLOWED_ORIGINS.length);
    expect(readOwnerReport).toHaveBeenCalledTimes(CONSOLE_REPORT_CORS_ALLOWED_ORIGINS.length);

    for (const origin of [
      'https://attacker.example.com',
      'https://peekaplate-console-staging.pages.dev.evil.com',
      'https://pr-128.peekaplate-console-preview.pages.dev',
      'http://localhost:5174',
      'http://127.0.0.1:5175',
      // The diner origins keep their own routes; they cannot read owner reports.
      'https://diner.peekaplate.com',
      'http://127.0.0.1:5173',
    ]) {
      const blocked = await preflight(origin);
      expect(blocked.headers.get('Access-Control-Allow-Origin')).toBeNull();
      expect(
        (await get(origin, 'Bearer test-token')).headers.get('Access-Control-Allow-Origin'),
      ).toBeNull();
    }
  });

  it('keeps authentication and venue checks unchanged for an allowed console origin', async () => {
    const venueId = SYNTHETIC_REPORT_VENUE_ALLOWLIST[0];
    const verify = vi.fn().mockResolvedValue('00000000-0000-4000-8000-000000000003');
    const readOwnerReport = vi.fn();
    const reportApp = createApp({ verify, execute: vi.fn(), readOwnerReport });
    const origin = 'https://peekaplate-console-staging.pages.dev';
    const env = { APP_ENV: 'staging', SYNTHETIC_REPORT_VENUE_ID: venueId };

    const noToken = await reportApp.request(
      `/api/v1/venues/${venueId}/analytics/dishes?source=synthetic`,
      { headers: { Origin: origin } },
      env,
    );
    expect(noToken.status).toBe(401);
    expect(noToken.headers.get('Access-Control-Allow-Origin')).toBe(origin);

    const otherVenue = await reportApp.request(
      '/api/v1/venues/00000000-0000-4000-8000-000000000001/analytics/dishes?source=synthetic',
      { headers: { Origin: origin, Authorization: 'Bearer test-token' } },
      env,
    );
    expect(otherVenue.status).toBe(503);

    const noSyntheticSource = await reportApp.request(
      `/api/v1/venues/${venueId}/analytics/dishes`,
      { headers: { Origin: origin, Authorization: 'Bearer test-token' } },
      env,
    );
    expect(noSyntheticSource.status).toBe(503);
    expect(readOwnerReport).not.toHaveBeenCalled();
  });

  it('does not add the console origins to the diner routes', async () => {
    const consoleOrigin = 'https://peekaplate-console-staging.pages.dev';
    const dinerApp = createApp({ verify: vi.fn(), execute: vi.fn() });
    const observationsPreflight = await dinerApp.request('/observations', {
      method: 'OPTIONS',
      headers: {
        Origin: consoleOrigin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Authorization, Content-Type',
      },
    });
    expect(observationsPreflight.headers.get('Access-Control-Allow-Origin')).toBeNull();
    const menuPreflight = await dinerApp.request(
      '/public/venues/00000000-0000-4000-8000-000000000001/menus/00000000-0000-4000-8000-000000000002',
      {
        method: 'OPTIONS',
        headers: { Origin: consoleOrigin, 'Access-Control-Request-Method': 'GET' },
      },
    );
    expect(menuPreflight.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('dish HTTP boundary', () => {
  const venueId = '00000000-0000-4000-8000-000000000001';
  const dishId = '00000000-0000-4000-8000-000000000002';
  const actorId = '00000000-0000-4000-8000-000000000003';
  const command = {
    commandId: crypto.randomUUID(),
    expectedVersion: 0,
    name: 'Soup',
    description: '',
  };
  const path = `/venues/${venueId}/dishes/${dishId}/revisions`;
  it('derives actor from verification and passes validated content to the transaction', async () => {
    const result = {
      dishId,
      revisionId: crypto.randomUUID(),
      version: 1,
      name: 'Soup',
      description: '',
    };
    const execute = vi.fn().mockResolvedValue(result);
    const verify = vi.fn().mockResolvedValue(actorId);
    const response = await createApp({ verify, execute }).request(path, {
      method: 'POST',
      headers: { Authorization: 'Bearer signed', 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(execute).toHaveBeenCalledWith(actorId, venueId, { ...command, dishId }, {});
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Request-ID')).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('rejects malformed JSON, forged authority, wrong media type and oversized bodies before writing', async () => {
    const execute = vi.fn();
    const testApp = createApp({ verify: async () => actorId, execute });
    for (const [body, contentType, status] of [
      ['{', 'application/json', 400],
      [JSON.stringify({ ...command, actorId }), 'application/json', 400],
      [JSON.stringify(command), 'text/plain', 415],
      ['x'.repeat(16_385), 'application/json', 413],
    ] as const) {
      const response = await testApp.request(path, {
        method: 'POST',
        headers: { Authorization: 'Bearer signed', 'Content-Type': contentType },
        body,
      });
      expect(response.status).toBe(status);
    }
    expect(execute).not.toHaveBeenCalled();
  });
  it('fails closed when hosted authentication is unconfigured', async () => {
    const response = await app.request(path, {
      method: 'POST',
      headers: { Authorization: 'Bearer signed', 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'service_unavailable' });
  });
});

describe('observation.v2 HTTP boundary', () => {
  const venueId = '00000000-0000-4000-8000-000000000001';
  const publicationId = '00000000-0000-4000-8000-000000000002';
  const jti = '00000000-0000-4000-8000-000000000003';
  const event = () => ({
    schema_version: 'observation.v2',
    event_id: crypto.randomUUID(),
    type: 'dish_saved',
    session_id: crypto.randomUUID(),
    producer_id: crypto.randomUUID(),
    local_sequence: 1,
    occurred_at: new Date().toISOString(),
    publication_revision_id: publicationId,
    payload: {
      dish_id: crypto.randomUUID(),
      dish_revision_id: crypto.randomUUID(),
      save_origin: 'direct',
      save_surface: 'dish_detail',
      shortlist_size: 1,
    },
  });
  const request = (events: unknown[], init: RequestInit = {}) =>
    new Request('http://localhost/observations', {
      method: 'POST',
      headers: { Authorization: 'Bearer signed', 'Content-Type': 'application/json' },
      body: JSON.stringify({ contract: 'observation.v2', events }),
      ...init,
    });
  const baseServices = {
    verify: vi.fn(),
    execute: vi.fn(),
    verifyMenu: vi.fn().mockResolvedValue({ venueId, publicationId, jti }),
    consumeObservationRateLimit: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 1 }),
  };

  it('derives authority from the token and accepts only after Queue send resolves', async () => {
    const enqueueObservation = vi.fn().mockResolvedValue(undefined);
    const input = event();
    const response = await createApp({ ...baseServices, enqueueObservation }).fetch(
      request([input]),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      contract: 'observation-receipt.v1',
      receipts: [
        { event_id: input.event_id, status: 'accepted', reason_code: null, retryable: false },
      ],
    });
    expect(enqueueObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: venueId,
        authorizedPublicationId: publicationId,
        schemaVersion: 'observation.v2',
        eventId: input.event_id,
        traffic_class: 'live',
      }),
      {},
    );
  });

  it('handles CORS allowlist and OPTIONS preflight aligned with PR #43', async () => {
    const app = createApp(baseServices);

    // 1. Allowed diner production origin preflight
    const preflight = await app.fetch(
      new Request('http://localhost/observations', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://diner.peekaplate.com',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'Authorization, Content-Type',
        },
      }),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://diner.peekaplate.com',
    );
    expect(preflight.headers.get('Access-Control-Allow-Origin')).not.toBe('*');
    expect(preflight.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(preflight.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
    expect(preflight.headers.get('Access-Control-Max-Age')).toBe('86400');
    expect(preflight.headers.get('Vary')).toContain('Origin');
    expect(preflight.headers.get('Access-Control-Allow-Credentials')).toBeNull();

    // 2. Allowed staging and local origins
    for (const allowedOrigin of [
      'https://peekaplate-diner-staging.pages.dev',
      'http://localhost:5173',
      'http://127.0.0.1:5173',
    ]) {
      const res = await app.fetch(
        request([event()], {
          headers: {
            Authorization: 'Bearer signed',
            'Content-Type': 'application/json',
            Origin: allowedOrigin,
          },
        }),
      );
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe(allowedOrigin);
      expect(res.headers.get('Access-Control-Allow-Origin')).not.toBe('*');
      expect(res.headers.get('Vary')).toContain('Origin');
    }

    // 3. Disallowed origin (e.g. malicious lookalike, external attacker, or preview) receives NO Access-Control-Allow-Origin
    for (const disallowedOrigin of [
      'https://attacker.example.com',
      'https://diner.peekaplate.com.evil.com',
      'https://pr-123.peekaplate-diner-preview.pages.dev',
    ]) {
      const disallowedPreflight = await app.fetch(
        new Request('http://localhost/observations', {
          method: 'OPTIONS',
          headers: {
            Origin: disallowedOrigin,
            'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'Authorization, Content-Type',
          },
        }),
      );
      expect(disallowedPreflight.status).toBe(204);
      expect(disallowedPreflight.headers.get('Access-Control-Allow-Origin')).toBeNull();

      const disallowedPost = await app.fetch(
        request([event()], {
          headers: {
            Authorization: 'Bearer signed',
            'Content-Type': 'application/json',
            Origin: disallowedOrigin,
          },
        }),
      );
      expect(disallowedPost.headers.get('Access-Control-Allow-Origin')).toBeNull();
    }

    // 3b. Missing Origin header (e.g. server-to-server or non-browser client) receives no CORS header
    const noOriginPost = await app.fetch(
      request([event()], {
        headers: {
          Authorization: 'Bearer signed',
          'Content-Type': 'application/json',
        },
      }),
    );
    expect(noOriginPost.headers.get('Access-Control-Allow-Origin')).toBeNull();

    // 4. Unauthorized POST from allowed origin still sets CORS header but returns 401
    const unauthorizedRes = await app.fetch(
      new Request('http://localhost/observations', {
        method: 'POST',
        headers: {
          Origin: 'https://diner.peekaplate.com',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ contract: 'observation.v2', events: [] }),
      }),
    );
    expect(unauthorizedRes.status).toBe(401);
    expect(unauthorizedRes.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://diner.peekaplate.com',
    );
    expect(unauthorizedRes.headers.get('Access-Control-Allow-Origin')).not.toBe('*');
  });

  it('propagates trusted traffic_class from verified menu token and ignores client-supplied values', async () => {
    const enqueueObservation = vi.fn().mockResolvedValue(undefined);
    const services = {
      ...baseServices,
      verifyMenu: vi.fn().mockResolvedValue({
        venueId,
        publicationId,
        jti,
        trafficClass: 'test',
      }),
      enqueueObservation,
    };
    const input = event();
    const response = await createApp(services).fetch(request([input]));
    expect(response.status).toBe(200);
    expect(enqueueObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: venueId,
        traffic_class: 'test',
        eventId: input.event_id,
      }),
      {},
    );
  });

  it('returns per-item permanent rejections without enqueueing invalid observations', async () => {
    const enqueueObservation = vi.fn();
    const valid = event();
    const response = await createApp({ ...baseServices, enqueueObservation }).fetch(
      request([
        { ...valid, schema_version: 2 },
        { ...event(), type: 'ingredient_viewed' },
        { ...event(), publication_revision_id: crypto.randomUUID() },
        { ...event(), occurred_at: new Date(Date.now() - 86_400_001).toISOString() },
        { ...event(), occurred_at: new Date(Date.now() + 360_001).toISOString() },
      ]),
    );
    expect(response.status).toBe(200);
    expect(
      (await parseObservationReceiptBatch(response)).receipts.map((receipt) => receipt.reason_code),
    ).toEqual([
      'schema_invalid',
      'unknown_type',
      'publication_not_allowed',
      'too_old',
      'future_time',
    ]);
    expect(enqueueObservation).not.toHaveBeenCalled();
  });

  it('enqueues identical IDs once and rejects every conflicting in-batch copy', async () => {
    const enqueueObservation = vi.fn().mockResolvedValue(undefined);
    const first = event();
    const conflict = event();
    const response = await createApp({ ...baseServices, enqueueObservation }).fetch(
      request([
        first,
        structuredClone(first),
        conflict,
        { ...conflict, payload: { ...conflict.payload, shortlist_size: 2 } },
      ]),
    );
    expect(response.status).toBe(200);
    expect((await parseObservationReceiptBatch(response)).receipts).toMatchObject([
      { status: 'accepted', reason_code: null },
      { status: 'accepted', reason_code: 'duplicate_in_batch' },
      { status: 'rejected', reason_code: 'event_id_conflict' },
      { status: 'rejected', reason_code: 'event_id_conflict' },
    ]);
    expect(enqueueObservation).toHaveBeenCalledTimes(2);
    expect(enqueueObservation.mock.calls.map(([message]) => message.kind)).toEqual([
      'observation_conflict.v1',
      'observation.v2',
    ]);
  });

  it('returns mixed receipts, but 503 without receipts when every Queue send is unavailable', async () => {
    const first = event();
    const second = event();
    const partial = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('queue unavailable'));
    const partialResponse = await createApp({ ...baseServices, enqueueObservation: partial }).fetch(
      request([first, second]),
    );
    expect(partialResponse.status).toBe(200);
    expect((await parseObservationReceiptBatch(partialResponse)).receipts).toMatchObject([
      { status: 'accepted', retryable: false },
      { status: 'retry', retryable: true },
    ]);

    const unavailableResponse = await createApp({
      ...baseServices,
      enqueueObservation: vi.fn().mockRejectedValue(new Error('queue unavailable')),
    }).fetch(request([event()]));
    expect(unavailableResponse.status).toBe(503);
    expect(await unavailableResponse.json()).toEqual({ error: 'queue_unavailable' });
  });

  it('enforces authentication, token-scoped throttling and envelope limits before Queue use', async () => {
    const enqueueObservation = vi.fn();
    const app = createApp({ ...baseServices, enqueueObservation });
    const missingAuth = await app.fetch(
      request([event()], { headers: { 'Content-Type': 'application/json' } }),
    );
    expect(missingAuth.status).toBe(401);

    const limited = await createApp({
      ...baseServices,
      consumeObservationRateLimit: vi
        .fn()
        .mockResolvedValue({ allowed: false, retryAfterSeconds: 3 }),
      enqueueObservation,
    }).fetch(request([event()]));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('3');

    const tooMany = await app.fetch(request(Array.from({ length: 26 }, event)));
    expect(tooMany.status).toBe(413);

    const malformed = await app.fetch(
      new Request('http://localhost/observations', {
        method: 'POST',
        headers: { Authorization: 'Bearer signed', 'Content-Type': 'application/json' },
        body: '{',
      }),
    );
    expect(malformed.status).toBe(400);
    expect(enqueueObservation).not.toHaveBeenCalled();
  });
  it('accepts exactly 32 KiB and rejects 32 KiB plus one byte', async () => {
    const enqueueObservation = vi.fn().mockResolvedValue(undefined);
    const app = createApp({ ...baseServices, enqueueObservation });
    const envelope = JSON.stringify({ contract: 'observation.v2', events: [event()] });
    const encodedLength = new TextEncoder().encode(envelope).byteLength;
    expect(encodedLength).toBeLessThan(32_768);

    const exact = `${envelope}${' '.repeat(32_768 - encodedLength)}`;
    const accepted = await app.fetch(
      new Request('http://localhost/observations', {
        method: 'POST',
        headers: { Authorization: 'Bearer signed', 'Content-Type': 'application/json' },
        body: exact,
      }),
    );
    expect(new TextEncoder().encode(exact)).toHaveLength(32_768);
    expect(accepted.status).toBe(200);

    const oversized = await app.fetch(
      new Request('http://localhost/observations', {
        method: 'POST',
        headers: { Authorization: 'Bearer signed', 'Content-Type': 'application/json' },
        body: `${exact} `,
      }),
    );
    expect(oversized.status).toBe(413);
    expect(enqueueObservation).toHaveBeenCalledTimes(1);
  });

  it('accepts exact time boundaries and rejects a one-millisecond excess', async () => {
    const now = new Date('2026-10-25T12:00:00.000Z');
    const inputs = [
      { ...event(), occurred_at: new Date(now.getTime() - 86_400_000).toISOString() },
      { ...event(), occurred_at: new Date(now.getTime() - 86_400_001).toISOString() },
      { ...event(), occurred_at: new Date(now.getTime() + 300_000).toISOString() },
      { ...event(), occurred_at: new Date(now.getTime() + 300_001).toISOString() },
    ];
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const result = await ingestObservations(
      inputs,
      { venueId, publicationId, jti },
      { enqueue, now: () => now },
    );
    expect(result.queueUnavailable).toBe(false);
    if (result.queueUnavailable) throw new Error('unexpected Queue failure');
    expect(
      result.response.receipts.map(({ status, reason_code }) => [status, reason_code]),
    ).toEqual([
      ['accepted', null],
      ['rejected', 'too_old'],
      ['accepted', null],
      ['rejected', 'future_time'],
    ]);
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it('applies both Cloudflare windows to the verified token jti', async () => {
    const minute = { limit: vi.fn().mockResolvedValue({ success: true }) };
    const burst = { limit: vi.fn().mockResolvedValue({ success: true }) };
    await expect(
      consumeJtiRateLimit(jti, {
        OBSERVATION_RATE_LIMITER_MINUTE: minute,
        OBSERVATION_RATE_LIMITER_BURST: burst,
      }),
    ).resolves.toEqual({ allowed: true, retryAfterSeconds: 1 });
    expect(minute.limit).toHaveBeenCalledWith({ key: jti });
    expect(burst.limit).toHaveBeenCalledWith({ key: jti });

    minute.limit.mockResolvedValueOnce({ success: false });
    await expect(
      consumeJtiRateLimit(jti, {
        OBSERVATION_RATE_LIMITER_MINUTE: minute,
        OBSERVATION_RATE_LIMITER_BURST: burst,
      }),
    ).resolves.toEqual({ allowed: false, retryAfterSeconds: 60 });

    burst.limit.mockResolvedValueOnce({ success: false });
    await expect(
      consumeJtiRateLimit(jti, {
        OBSERVATION_RATE_LIMITER_MINUTE: minute,
        OBSERVATION_RATE_LIMITER_BURST: burst,
      }),
    ).resolves.toEqual({ allowed: false, retryAfterSeconds: 10 });
  });

  it('detects same-ID conflicts before per-item validation and quarantines both copies', async () => {
    const enqueueObservation = vi.fn().mockResolvedValue(undefined);
    const valid = event();
    const response = await createApp({ ...baseServices, enqueueObservation }).fetch(
      request([
        valid,
        {
          ...valid,
          schema_version: 2,
          search_text: 'private query',
          email: 'person@example.com',
          credential: 'secret-value',
          full_url: 'https://example.com/private?token=secret',
        },
      ]),
    );
    expect(response.status).toBe(200);
    expect((await parseObservationReceiptBatch(response)).receipts).toMatchObject([
      { status: 'rejected', reason_code: 'event_id_conflict' },
      { status: 'rejected', reason_code: 'event_id_conflict' },
    ]);
    expect(enqueueObservation).toHaveBeenCalledTimes(1);
    expect(enqueueObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'observation_conflict.v1',
        tenantId: venueId,
        eventId: valid.event_id,
        authorizedPublicationId: publicationId,
        copies: expect.arrayContaining([
          expect.objectContaining({ validation: 'valid', event: valid }),
          expect.objectContaining({
            validation: 'invalid',
            metadata: expect.objectContaining({ schemaVersionStatus: 'other' }),
          }),
        ]),
      }),
      {},
    );
    const conflictMessage = enqueueObservation.mock.calls[0]?.[0];
    expect(JSON.stringify(conflictMessage)).not.toContain('private query');
    expect(JSON.stringify(conflictMessage)).not.toContain('person@example.com');
    expect(JSON.stringify(conflictMessage)).not.toContain('secret-value');
    expect(JSON.stringify(conflictMessage)).not.toContain('example.com/private');
  });

  it('rejects deeply nested invalid JSON without recursive canonicalization failure', async () => {
    let payload: unknown = 'leaf';
    for (let depth = 0; depth < 12_000; depth += 1) payload = [payload];
    const enqueue = vi.fn();
    const result = await ingestObservations(
      [{ event_id: crypto.randomUUID(), payload }],
      { venueId, publicationId, jti },
      { enqueue },
    );
    expect(result.queueUnavailable).toBe(false);
    if (result.queueUnavailable) throw new Error('unexpected Queue failure');
    expect(result.response.receipts).toMatchObject([
      { status: 'rejected', reason_code: 'schema_invalid', retryable: false },
    ]);
    expect(enqueue).not.toHaveBeenCalled();
  });
  it('quarantines invalid same-metadata copies when their raw payload checksums differ', async () => {
    const enqueueObservation = vi.fn().mockResolvedValue(undefined);
    const base = event();
    const first = { ...base, schema_version: 2, payload: { ...base.payload, shortlist_size: 1 } };
    const second = { ...base, schema_version: 2, payload: { ...base.payload, shortlist_size: 2 } };
    const response = await createApp({ ...baseServices, enqueueObservation }).fetch(
      request([first, second]),
    );
    expect(response.status).toBe(200);
    expect((await parseObservationReceiptBatch(response)).receipts).toMatchObject([
      { status: 'rejected', reason_code: 'event_id_conflict' },
      { status: 'rejected', reason_code: 'event_id_conflict' },
    ]);
    const message = enqueueObservation.mock.calls[0]?.[0];
    expect(message.kind).toBe('observation_conflict.v1');
    expect(message.copies[0].canonicalChecksum).not.toBe(message.copies[1].canonicalChecksum);
    expect(JSON.stringify(message)).not.toContain('shortlist_size');
  });
  it('returns 503 when the conflict quarantine handoff is not confirmed', async () => {
    const valid = event();
    const response = await createApp({
      ...baseServices,
      enqueueObservation: vi.fn().mockRejectedValue(new Error('queue unavailable')),
    }).fetch(request([valid, { ...valid, payload: { ...valid.payload, shortlist_size: 2 } }]));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'queue_unavailable' });
  });

  it('rejects client attempts to override venue_id or inject trusted/consent classification', async () => {
    const enqueueObservation = vi.fn().mockResolvedValue(undefined);
    const attackerVenue = crypto.randomUUID();
    const response = await createApp({ ...baseServices, enqueueObservation }).fetch(
      request([
        { ...event(), venue_id: attackerVenue },
        { ...event(), tenant_id: attackerVenue },
        { ...event(), is_trusted: true },
        { ...event(), consent: true },
        { ...event(), classification: 'real_diner' },
      ]),
    );
    expect(response.status).toBe(200);
    const parsed = await parseObservationReceiptBatch(response);
    expect(parsed.receipts).toHaveLength(5);
    for (const receipt of parsed.receipts) {
      expect(receipt.status).toBe('rejected');
      expect(receipt.reason_code).toBe('schema_invalid');
    }
    expect(enqueueObservation).not.toHaveBeenCalled();
  });

  it('enqueues repeated deliveries across separate requests for downstream consumer deduplication', async () => {
    const enqueueObservation = vi.fn().mockResolvedValue(undefined);
    const original = event();
    const appInstance = createApp({ ...baseServices, enqueueObservation });

    const firstResponse = await appInstance.fetch(request([original]));
    expect(firstResponse.status).toBe(200);
    const firstParsed = await parseObservationReceiptBatch(firstResponse);
    expect(firstParsed.receipts[0]).toMatchObject({
      event_id: original.event_id,
      status: 'accepted',
      reason_code: null,
    });

    const secondResponse = await appInstance.fetch(request([original]));
    expect(secondResponse.status).toBe(200);
    const secondParsed = await parseObservationReceiptBatch(secondResponse);
    expect(secondParsed.receipts[0]).toMatchObject({
      event_id: original.event_id,
      status: 'accepted',
      reason_code: null,
    });

    expect(enqueueObservation).toHaveBeenCalledTimes(2);
  });

  it('correctly handles fractional seconds up to nanoseconds and rejects invalid calendar dates in conflict evidence', async () => {
    const enqueueObservation = vi.fn().mockResolvedValue(undefined);
    const sharedEventId = crypto.randomUUID();

    // 1. Valid event with microseconds
    const validMicro = {
      ...event(),
      event_id: sharedEventId,
      occurred_at: '2026-10-31T12:30:45.123456Z',
    };

    // 2. Conflicting copy with nanoseconds and invalid schema (triggers conflict metadata)
    const invalidNano = {
      ...event(),
      event_id: sharedEventId,
      occurred_at: '2026-10-31T12:30:45.123456789Z',
      payload: { unknown_field: true },
    };

    const appInstance = createApp({ ...baseServices, enqueueObservation });
    const response = await appInstance.fetch(request([validMicro, invalidNano]));
    expect(response.status).toBe(200);

    const parsed = await parseObservationReceiptBatch(response);
    expect(parsed.receipts).toHaveLength(2);
    expect(parsed.receipts[0]?.status).toBe('rejected');
    expect(parsed.receipts[0]?.reason_code).toBe('event_id_conflict');
    expect(parsed.receipts[1]?.status).toBe('rejected');
    expect(parsed.receipts[1]?.reason_code).toBe('event_id_conflict');

    expect(enqueueObservation).toHaveBeenCalledTimes(1);
    const queued = enqueueObservation.mock.calls[0]?.[0] as {
      kind: string;
      copies: { validation: string; metadata?: { occurredAt: string | null } }[];
    };
    expect(queued.kind).toBe('observation_conflict.v1');
    expect(queued.copies).toHaveLength(2);

    // Microsecond copy is valid, so validation is 'valid'
    expect(queued.copies[0]?.validation).toBe('valid');

    // Nanosecond invalid copy metadata preserves occurredAt without sub-millisecond truncation
    expect(queued.copies[1]?.validation).toBe('invalid');
    expect(queued.copies[1]?.metadata?.occurredAt).toBe('2026-10-31T12:30:45.123456789Z');
  });

  it('rejects invalid calendar dates and overflowing fractional digits in conflict metadata', async () => {
    const enqueueObservation = vi.fn().mockResolvedValue(undefined);
    const sharedEventId = crypto.randomUUID();

    const validCopy = {
      ...event(),
      event_id: sharedEventId,
    };

    // Invalid calendar date: Feb 31 (must become null, not silently normalized to March 3)
    const feb31Copy = {
      ...event(),
      event_id: sharedEventId,
      occurred_at: '2026-02-31T12:30:45Z',
      payload: { invalid: true },
    };

    // Overflowing fractional digits (> 9 digits)
    const overflowFractionCopy = {
      ...event(),
      event_id: sharedEventId,
      occurred_at: '2026-10-31T12:30:45.1234567890Z',
      payload: { invalid: true },
    };

    const appInstance = createApp({ ...baseServices, enqueueObservation });
    const response = await appInstance.fetch(request([validCopy, feb31Copy, overflowFractionCopy]));
    expect(response.status).toBe(200);

    expect(enqueueObservation).toHaveBeenCalledTimes(1);
    const queued = enqueueObservation.mock.calls[0]?.[0] as {
      kind: string;
      copies: { validation: string; metadata?: { occurredAt: string | null } }[];
    };
    expect(queued.kind).toBe('observation_conflict.v1');
    expect(queued.copies).toHaveLength(3);

    // Feb 31 must be sanitized to null
    expect(queued.copies[1]?.validation).toBe('invalid');
    expect(queued.copies[1]?.metadata?.occurredAt).toBeNull();

    // 10-digit fractional seconds must be sanitized to null
    expect(queued.copies[2]?.validation).toBe('invalid');
    expect(queued.copies[2]?.metadata?.occurredAt).toBeNull();
  });

  it('enforces PostgreSQL-compatible microsecond timestamp precision and boundary classification matching PR #31', async () => {
    const fixedNow = new Date('2026-11-01T12:00:00.000Z');
    const enqueueObservation = vi.fn().mockResolvedValue(undefined);
    const appInstance = createApp({
      ...baseServices,
      enqueueObservation,
      now: () => fixedNow,
    });

    // 1. Reviewer reproduction case 1: 5 minutes + 1 microsecond is rejected as future_time
    const resFuture1Micro = await appInstance.fetch(
      request([
        {
          ...event(),
          occurred_at: '2026-11-01T12:05:00.000001Z',
        },
      ]),
    );
    expect(resFuture1Micro.status).toBe(200);
    const parsedFuture = await parseObservationReceiptBatch(resFuture1Micro);
    expect(parsedFuture.receipts[0]?.status).toBe('rejected');
    expect(parsedFuture.receipts[0]?.reason_code).toBe('future_time');
    expect(
      classifyObservationTimeWindow('2026-11-01T12:05:00.000001Z', fixedNow.toISOString()),
    ).toEqual({ disposition: 'rejected', reasonCode: 'future_time' });

    // 2. Reviewer reproduction case 2: 7-digit fractional second rounds onto inclusive 24h lower boundary and is accepted
    const res7DigitOld = await appInstance.fetch(
      request([
        {
          ...event(),
          occurred_at: '2026-10-31T11:59:59.9999999Z',
        },
      ]),
    );
    expect(res7DigitOld.status).toBe(200);
    const parsed7Digit = await parseObservationReceiptBatch(res7DigitOld);
    expect(parsed7Digit.receipts[0]?.status).toBe('accepted');
    expect(parsed7Digit.receipts[0]?.reason_code).toBeNull();
    expect(
      classifyObservationTimeWindow('2026-10-31T11:59:59.9999999Z', fixedNow.toISOString()),
    ).toEqual({ disposition: 'accepted' });

    // 3. Exact lower boundary (firstReceivedAt - 24 hours): accepted
    const resExactLower = await appInstance.fetch(
      request([{ ...event(), occurred_at: '2026-10-31T12:00:00.000000Z' }]),
    );
    const parsedExactLower = await parseObservationReceiptBatch(resExactLower);
    expect(parsedExactLower.receipts[0]?.status).toBe('accepted');
    expect(parsedExactLower.receipts[0]?.reason_code).toBeNull();

    // 4. Lower boundary + 1 microsecond: accepted
    const resLowerPlus1Micro = await appInstance.fetch(
      request([{ ...event(), occurred_at: '2026-10-31T12:00:00.000001Z' }]),
    );
    const parsedLowerPlus1Micro = await parseObservationReceiptBatch(resLowerPlus1Micro);
    expect(parsedLowerPlus1Micro.receipts[0]?.status).toBe('accepted');

    // 5. Lower boundary - 1 microsecond: rejected as too_old
    const resLowerMinus1Micro = await appInstance.fetch(
      request([{ ...event(), occurred_at: '2026-10-31T11:59:59.999999Z' }]),
    );
    const parsedLowerMinus1Micro = await parseObservationReceiptBatch(resLowerMinus1Micro);
    expect(parsedLowerMinus1Micro.receipts[0]?.status).toBe('rejected');
    expect(parsedLowerMinus1Micro.receipts[0]?.reason_code).toBe('too_old');

    // 6. Exact upper boundary (firstReceivedAt + 5 minutes): accepted
    const resExactUpper = await appInstance.fetch(
      request([{ ...event(), occurred_at: '2026-11-01T12:05:00.000000Z' }]),
    );
    const parsedExactUpper = await parseObservationReceiptBatch(resExactUpper);
    expect(parsedExactUpper.receipts[0]?.status).toBe('accepted');

    // 7. Upper boundary - 1 microsecond: accepted
    const resUpperMinus1Micro = await appInstance.fetch(
      request([{ ...event(), occurred_at: '2026-11-01T12:04:59.999999Z' }]),
    );
    const parsedUpperMinus1Micro = await parseObservationReceiptBatch(resUpperMinus1Micro);
    expect(parsedUpperMinus1Micro.receipts[0]?.status).toBe('accepted');

    // 8. Halfway fractional timestamp .0000005Z (banker round-to-even) at upper boundary: accepted
    const resHalfway = await appInstance.fetch(
      request([{ ...event(), occurred_at: '2026-11-01T12:05:00.0000005Z' }]),
    );
    const parsedHalfway = await parseObservationReceiptBatch(resHalfway);
    expect(parsedHalfway.receipts[0]?.status).toBe('accepted');

    // 9. Sub-microsecond .0000006Z > 5 rounds up to .000001Z: rejected as future_time
    const resRoundUpFuture = await appInstance.fetch(
      request([{ ...event(), occurred_at: '2026-11-01T12:05:00.0000006Z' }]),
    );
    const parsedRoundUpFuture = await parseObservationReceiptBatch(resRoundUpFuture);
    expect(parsedRoundUpFuture.receipts[0]?.status).toBe('rejected');
    expect(parsedRoundUpFuture.receipts[0]?.reason_code).toBe('future_time');
  });

  it('correctly isolates unauthorized publication in conflict copies with bounded invalid metadata', async () => {
    const enqueueObservation = vi.fn().mockResolvedValue(undefined);
    const sharedEventId = crypto.randomUUID();
    const authorizedPubId = publicationId;
    const unauthorizedPubId = '50000000-0000-4000-8000-000000000002';

    // Copy A: authorized publication
    const copyA = {
      ...event(),
      event_id: sharedEventId,
      publication_revision_id: authorizedPubId,
      payload: {
        ...event().payload,
        shortlist_size: 1,
      },
    };

    // Copy B: schema-valid event with a different, unauthorized publication ID
    const copyB = {
      ...event(),
      event_id: sharedEventId,
      publication_revision_id: unauthorizedPubId,
      payload: {
        ...event().payload,
        shortlist_size: 2,
      },
    };

    const appInstance = createApp({ ...baseServices, enqueueObservation });
    const response = await appInstance.fetch(request([copyA, copyB]));
    expect(response.status).toBe(200);

    // Both copies receive terminal conflict receipts
    const receipts = await parseObservationReceiptBatch(response);
    expect(receipts.receipts).toHaveLength(2);
    expect(receipts.receipts[0]?.status).toBe('rejected');
    expect(receipts.receipts[0]?.reason_code).toBe('event_id_conflict');
    expect(receipts.receipts[1]?.status).toBe('rejected');
    expect(receipts.receipts[1]?.reason_code).toBe('event_id_conflict');

    // Verify enqueued conflict envelope
    expect(enqueueObservation).toHaveBeenCalledTimes(1);
    const enqueuedEnvelope = enqueueObservation.mock.calls[0]?.[0];
    expect(enqueuedEnvelope).toBeDefined();
    expect(enqueuedEnvelope.kind).toBe('observation_conflict.v1');
    expect(enqueuedEnvelope.tenantId).toBe(venueId);
    expect(enqueuedEnvelope.eventId).toBe(sharedEventId);
    expect(enqueuedEnvelope.authorizedPublicationId).toBe(authorizedPubId);
    expect(enqueuedEnvelope.copies).toHaveLength(2);

    const [queuedCopyA, queuedCopyB] = enqueuedEnvelope.copies;

    // 1. Both copies retain their checksums
    const checksumA = await sha256(canonicalJson(copyA));
    const checksumB = await sha256(canonicalJson(copyB));
    expect(queuedCopyA.canonicalChecksum).toBe(checksumA);
    expect(queuedCopyB.canonicalChecksum).toBe(checksumB);

    // 2. The authorized copy remains valid
    expect(queuedCopyA.validation).toBe('valid');
    expect(queuedCopyA.event).toEqual(copyA);

    // 3. The unauthorized copy is represented with bounded invalid metadata
    expect(queuedCopyB.validation).toBe('invalid');
    expect(queuedCopyB.event).toBeUndefined();
    expect(queuedCopyB.metadata).toEqual({
      schemaVersionStatus: 'observation.v2',
      eventType: 'dish_saved',
      occurredAt: copyB.occurred_at,
      publicationStatus: 'mismatch',
      payloadObject: true,
    });

    // 4. Unauthorized copy does not bypass publication authorization
    expect(queuedCopyB.metadata.publicationStatus).toBe('mismatch');

    // 5. Current shared contracts validate the envelope without error.
    expect(ObservationConflictQueueMessageSchema.safeParse(enqueuedEnvelope).success).toBe(true);
    expect(ObservationQueueEnvelopeSchema.safeParse(enqueuedEnvelope).success).toBe(true);

    // 6. Check conflict integrity locally; this simulation does not execute PR #31.
    // (Simulating consumer's validateConflictObservationEnvelope & processConflictMessage)
    const copies = enqueuedEnvelope.copies;
    const validatedCopies = [];
    for (const copy of copies) {
      if (copy.validation === 'valid') {
        expect(copy.event.publication_revision_id).toBe(enqueuedEnvelope.authorizedPublicationId);
        const recomputed = await sha256(canonicalJson(copy.event));
        expect(copy.canonicalChecksum).toBe(recomputed);
        validatedCopies.push({ checksum: copy.canonicalChecksum, valid: true });
      } else if (copy.validation === 'invalid') {
        expect(copy.metadata.publicationStatus).toBe('mismatch');
        expect(copy.canonicalChecksum).toMatch(/^[0-9a-f]{64}$/);
        validatedCopies.push({ checksum: copy.canonicalChecksum, valid: false });
      }
    }
    expect(validatedCopies).toHaveLength(2);
    expect(validatedCopies[0]?.valid).toBe(true);
    expect(validatedCopies[1]?.valid).toBe(false);
  });

  it('preserves traffic_class in the shared Queue envelope and canonical reconstruction', async () => {
    const enqueueObservation = vi.fn().mockResolvedValue(undefined);
    const services = {
      ...baseServices,
      verifyMenu: vi.fn().mockResolvedValue({
        venueId,
        publicationId,
        jti,
        trafficClass: 'demo',
      }),
      enqueueObservation,
    };
    const input = event();
    const response = await createApp(services).fetch(request([input]));
    expect(response.status).toBe(200);

    expect(enqueueObservation).toHaveBeenCalledTimes(1);
    const enqueued = enqueueObservation.mock.calls[0]?.[0];
    expect(enqueued.traffic_class).toBe('demo');

    // Consumer parsing with shared contracts validates traffic_class
    const parsedEnvelope = ObservationQueueEnvelopeSchema.parse(enqueued);
    if (parsedEnvelope.kind === 'observation.v2') {
      expect(parsedEnvelope.traffic_class).toBe('demo');
      const canonical = toCanonicalObservation(parsedEnvelope);
      expect(canonical.event_id).toBe(input.event_id);
    }

    // Message without traffic_class (older producer / PR #31 schema) cleanly defaults to 'live'
    const withoutTrafficClass = { ...enqueued };
    delete withoutTrafficClass.traffic_class;
    const parsedDefault = ObservationQueueMessageSchema.parse(withoutTrafficClass);
    expect(parsedDefault.traffic_class).toBe('live');
  });
});

describe('RES-02 publication HTTP boundary', () => {
  const venueId = '00000000-0000-4000-8000-000000000011';
  const menuId = '00000000-0000-4000-8000-000000000012';
  const actorId = '00000000-0000-4000-8000-000000000013';
  const commandId = '00000000-0000-4000-8000-000000000014';
  const basePath = `/venues/${venueId}/menus/${menuId}`;
  const execute = vi.fn();
  const verify = vi.fn().mockResolvedValue(actorId);

  it('passes only validated immutable approval references to the command transaction', async () => {
    const approval = {
      menuId,
      approvalId: '00000000-0000-4000-8000-000000000015',
      version: 1,
      menuRevisionId: '00000000-0000-4000-8000-000000000016',
      contentApprovalId: '00000000-0000-4000-8000-000000000018',
      contentHash: 'a'.repeat(64),
      assetApprovalId: '00000000-0000-4000-8000-000000000019',
      assetManifestHash: 'b'.repeat(64),
      status: 'approved' as const,
    };
    const approve = vi.fn().mockResolvedValue(approval);
    const body = {
      commandId,
      expectedVersion: 0,
      menuRevisionId: approval.menuRevisionId,
      contentApprovalId: approval.contentApprovalId,
      assetApprovalId: approval.assetApprovalId,
    };
    const response = await createApp({ verify, execute, approve }).request(
      `${basePath}/approvals`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer signed', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(approval);
    expect(approve).toHaveBeenCalledWith(actorId, venueId, { ...body, menuId }, {});
  });

  it('keeps publish and withdrawal as distinct endpoints', async () => {
    const publication = {
      menuId,
      publicationId: '00000000-0000-4000-8000-000000000017',
      version: 1,
      approvalId: '00000000-0000-4000-8000-000000000015',
      publicationHash: 'c'.repeat(64),
      availabilityVersion: 1,
      status: 'published' as const,
    };
    const publish = vi.fn().mockResolvedValue(publication);
    const withdraw = vi.fn().mockResolvedValue({
      ...publication,
      version: 2,
      availabilityVersion: 2,
      status: 'withdrawn',
    });
    const testApp = createApp({ verify, execute, publish, withdraw });
    const publishBody = {
      commandId,
      expectedVersion: 0,
      approvalId: publication.approvalId,
    };
    expect(
      (
        await testApp.request(`${basePath}/publications`, {
          method: 'POST',
          headers: { Authorization: 'Bearer signed', 'Content-Type': 'application/json' },
          body: JSON.stringify(publishBody),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await testApp.request(`${basePath}/withdrawals`, {
          method: 'POST',
          headers: { Authorization: 'Bearer signed', 'Content-Type': 'application/json' },
          body: JSON.stringify({ commandId, expectedVersion: 1 }),
        })
      ).status,
    ).toBe(200);
    expect(publish).toHaveBeenCalledWith(actorId, venueId, { ...publishBody, menuId }, {});
    expect(withdraw).toHaveBeenCalledWith(
      actorId,
      venueId,
      { commandId, expectedVersion: 1, menuId },
      {},
    );
  });

  it('rejects browser-supplied authority and malformed hashes before command execution', async () => {
    const approve = vi.fn();
    const testApp = createApp({ verify, execute, approve });
    for (const body of [
      {
        commandId,
        expectedVersion: 0,
        menuRevisionId: '00000000-0000-4000-8000-000000000016',
        contentApprovalId: '00000000-0000-4000-8000-000000000018',
        assetApprovalId: '00000000-0000-4000-8000-000000000019',
        actorId,
      },
      {
        commandId,
        expectedVersion: 0,
        menuRevisionId: '00000000-0000-4000-8000-000000000016',
        contentApprovalId: 'not-an-id',
        assetApprovalId: '00000000-0000-4000-8000-000000000019',
      },
    ]) {
      const response = await testApp.request(`${basePath}/approvals`, {
        method: 'POST',
        headers: { Authorization: 'Bearer signed', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
    expect(approve).not.toHaveBeenCalled();
  });
});

describe('menu ingestion HTTP boundary', () => {
  const venueId = '00000000-0000-4000-8000-000000000001';
  const jobId = '00000000-0000-4000-8000-000000000002';
  const draftId = '00000000-0000-4000-8000-000000000003';
  const actorId = '00000000-0000-4000-8000-000000000004';

  it('submits a menu ingestion job when authenticated and authorized', async () => {
    const mockJob = {
      id: jobId,
      tenant_id: venueId,
      source_type: 'url',
      source_url: 'https://example.com/menu',
      idempotency_key: 'idem_post_1',
      status: 'queued',
    };
    const submitIngestion = vi.fn().mockResolvedValue(mockJob);
    const verify = vi.fn().mockResolvedValue(actorId);

    const testApp = createApp({
      verify,
      execute: vi.fn(),
      submitIngestion,
    });

    const response = await testApp.request(`/venues/${venueId}/menus/jobs`, {
      method: 'POST',
      headers: { Authorization: 'Bearer valid_token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceType: 'url',
        sourceUrl: 'https://example.com/menu',
        idempotencyKey: 'idem_post_1',
      }),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ job: mockJob });
    expect(submitIngestion).toHaveBeenCalledWith(
      actorId,
      venueId,
      {
        sourceType: 'url',
        sourceUrl: 'https://example.com/menu',
        idempotencyKey: 'idem_post_1',
      },
      {},
    );
  });

  it('retrieves an ingestion job status by ID', async () => {
    const mockJob = {
      id: jobId,
      tenant_id: venueId,
      status: 'complete',
      draft_count: 5,
    };
    const getIngestionJob = vi.fn().mockResolvedValue(mockJob);
    const verify = vi.fn().mockResolvedValue(actorId);

    const testApp = createApp({
      verify,
      execute: vi.fn(),
      getIngestionJob,
    });

    const response = await testApp.request(`/venues/${venueId}/menus/jobs/${jobId}`, {
      method: 'GET',
      headers: { Authorization: 'Bearer valid_token' },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ job: mockJob });
    expect(getIngestionJob).toHaveBeenCalledWith(actorId, venueId, jobId, {});
  });

  it('lists dish drafts for review', async () => {
    const mockDrafts = [
      {
        id: draftId,
        tenant_id: venueId,
        name: 'Soup',
        review_status: 'pending',
      },
    ];
    const listDrafts = vi.fn().mockResolvedValue(mockDrafts);
    const verify = vi.fn().mockResolvedValue(actorId);

    const testApp = createApp({
      verify,
      execute: vi.fn(),
      listDrafts,
    });

    const response = await testApp.request(`/venues/${venueId}/drafts?status=pending`, {
      method: 'GET',
      headers: { Authorization: 'Bearer valid_token' },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ drafts: mockDrafts });
    expect(listDrafts).toHaveBeenCalledWith(
      actorId,
      venueId,
      { status: 'pending', jobId: undefined },
      {},
    );
  });

  it('approves a dish draft and promotes to published revision', async () => {
    const mockResult = {
      draft: {
        id: draftId,
        review_status: 'accepted',
        published_dish_id: '00000000-0000-4000-8000-000000000005',
      },
      publishedRevision: {
        dishId: '00000000-0000-4000-8000-000000000005',
        revisionId: '00000000-0000-4000-8000-000000000006',
        version: 1,
        name: 'Soup',
        description: 'Warm soup',
      },
    };
    const approveDraft = vi.fn().mockResolvedValue(mockResult);
    const verify = vi.fn().mockResolvedValue(actorId);

    const testApp = createApp({
      verify,
      execute: vi.fn(),
      approveDraft,
    });

    const commandId = '00000000-0000-4000-8000-000000000007';
    const response = await testApp.request(`/venues/${venueId}/drafts/${draftId}/approve`, {
      method: 'POST',
      headers: { Authorization: 'Bearer valid_token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commandId,
        expectedVersion: 0,
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(mockResult);
    expect(approveDraft).toHaveBeenCalledWith(
      actorId,
      venueId,
      draftId,
      { commandId, expectedVersion: 0 },
      {},
    );
  });

  it('rejects malformed nonempty JSON on approval with 400 invalid_json without executing command', async () => {
    const venueId = '00000000-0000-4000-8000-000000000001';
    const draftId = '00000000-0000-4000-8000-000000000002';
    const actorId = '00000000-0000-4000-8000-000000000003';
    const approveDraft = vi.fn();
    const verify = vi.fn().mockResolvedValue(actorId);

    const testApp = createApp({
      verify,
      execute: vi.fn(),
      approveDraft,
    });

    const response = await testApp.request(`/venues/${venueId}/drafts/${draftId}/approve`, {
      method: 'POST',
      headers: { Authorization: 'Bearer valid_token', 'Content-Type': 'application/json' },
      body: '{"commandId":',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_json' });
    expect(approveDraft).not.toHaveBeenCalled();
  });

  it('rejects approval request without required commandId with 400 invalid_request', async () => {
    const venueId = '00000000-0000-4000-8000-000000000001';
    const draftId = '00000000-0000-4000-8000-000000000002';
    const actorId = '00000000-0000-4000-8000-000000000003';
    const approveDraft = vi.fn();
    const verify = vi.fn().mockResolvedValue(actorId);

    const testApp = createApp({
      verify,
      execute: vi.fn(),
      approveDraft,
    });

    const response = await testApp.request(`/venues/${venueId}/drafts/${draftId}/approve`, {
      method: 'POST',
      headers: { Authorization: 'Bearer valid_token', 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_request' });
    expect(approveDraft).not.toHaveBeenCalled();
  });

  describe('order outcome import route', () => {
    const venueId = '00000000-0000-4000-8000-000000000001';
    const actorId = '00000000-0000-4000-8000-000000000002';
    const validCsv =
      'schema_version,order_id,order_line_id,ordered_at,menu_revision_id,dish_id,dish_revision_id,outcome_type,quantity\npilot_order_outcome.v1,ORD-1,L-1,2026-11-01T12:00:00Z,00000000-0000-4000-8000-000000000010,00000000-0000-4000-8000-000000000020,00000000-0000-4000-8000-000000000030,ordered,1';

    const mockSuccessResult = {
      batchId: '00000000-0000-4000-8000-000000000099',
      venueId,
      status: 'completed',
      totalRows: 1,
      acceptedRows: 1,
      duplicateRows: 0,
      quarantinedRows: 0,
      conflictRows: 0,
      isDuplicateFile: false,
      fileSha256: 'abc123hash',
      diagnostics: [],
      createdAt: '2026-11-07T12:00:00.000Z',
      finishedAt: '2026-11-07T12:00:01.000Z',
    };

    it('rejects unauthenticated requests with 401', async () => {
      const response = await app.request(`/venues/${venueId}/orders/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/csv' },
        body: validCsv,
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'unauthorized' });
    });

    it('rejects invalid venueId UUID with 400', async () => {
      const verify = vi.fn().mockResolvedValue(actorId);
      const testApp = createApp({ verify, execute: vi.fn() });

      const response = await testApp.request('/venues/invalid-uuid/orders/import', {
        method: 'POST',
        headers: { Authorization: 'Bearer valid_token', 'Content-Type': 'text/csv' },
        body: validCsv,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_request' });
    });

    it('rejects unsupported Content-Type with 415', async () => {
      const verify = vi.fn().mockResolvedValue(actorId);
      const testApp = createApp({ verify, execute: vi.fn() });

      const response = await testApp.request(`/venues/${venueId}/orders/import`, {
        method: 'POST',
        headers: { Authorization: 'Bearer valid_token', 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(415);
      expect(await response.json()).toEqual({ error: 'unsupported_media_type' });
    });

    it('successfully processes text/csv upload and sets security headers', async () => {
      const verify = vi.fn().mockResolvedValue(actorId);
      const importOrderOutcomes = vi.fn().mockResolvedValue(mockSuccessResult);
      const testApp = createApp({ verify, execute: vi.fn(), importOrderOutcomes });

      const response = await testApp.request(`/venues/${venueId}/orders/import`, {
        method: 'POST',
        headers: { Authorization: 'Bearer valid_token', 'Content-Type': 'text/csv' },
        body: validCsv,
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(mockSuccessResult);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(response.headers.get('X-Request-ID')).toMatch(/^[0-9a-f-]{36}$/);
      expect(importOrderOutcomes).toHaveBeenCalledWith(
        actorId,
        venueId,
        validCsv,
        'orders.csv',
        expect.any(Object),
      );
    });

    it('successfully processes multipart/form-data upload', async () => {
      const verify = vi.fn().mockResolvedValue(actorId);
      const importOrderOutcomes = vi.fn().mockResolvedValue(mockSuccessResult);
      const testApp = createApp({ verify, execute: vi.fn(), importOrderOutcomes });

      const formData = new FormData();
      const fileBlob = new Blob([validCsv], { type: 'text/csv' });
      formData.append('file', fileBlob, 'pos_export_2026.csv');

      const response = await testApp.request(`/venues/${venueId}/orders/import`, {
        method: 'POST',
        headers: { Authorization: 'Bearer valid_token' },
        body: formData,
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(mockSuccessResult);
      expect(importOrderOutcomes).toHaveBeenCalledWith(
        actorId,
        venueId,
        validCsv,
        'pos_export_2026.csv',
        expect.any(Object),
      );
    });

    it('rejects multipart/form-data with missing file field with 400', async () => {
      const verify = vi.fn().mockResolvedValue(actorId);
      const testApp = createApp({ verify, execute: vi.fn() });

      const formData = new FormData();
      formData.append('unrelated', 'hello');

      const response = await testApp.request(`/venues/${venueId}/orders/import`, {
        method: 'POST',
        headers: { Authorization: 'Bearer valid_token' },
        body: formData,
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'missing_file' });
    });

    it('returns 403 when user is not owner', async () => {
      const verify = vi.fn().mockResolvedValue(actorId);
      const importOrderOutcomes = vi
        .fn()
        .mockRejectedValue(
          new OrderImportError('forbidden', 403, 'Order outcome import requires owner permission'),
        );
      const testApp = createApp({ verify, execute: vi.fn(), importOrderOutcomes });

      const response = await testApp.request(`/venues/${venueId}/orders/import`, {
        method: 'POST',
        headers: { Authorization: 'Bearer valid_token', 'Content-Type': 'text/csv' },
        body: validCsv,
      });

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: 'forbidden',
        message: 'Order outcome import requires owner permission',
      });
    });

    it('returns 413 when import fails with payload_too_large', async () => {
      const verify = vi.fn().mockResolvedValue(actorId);
      const importOrderOutcomes = vi
        .fn()
        .mockRejectedValue(
          new OrderImportError(
            'payload_too_large',
            413,
            'File exceeds maximum allowed rows (1000)',
          ),
        );
      const testApp = createApp({ verify, execute: vi.fn(), importOrderOutcomes });

      const response = await testApp.request(`/venues/${venueId}/orders/import`, {
        method: 'POST',
        headers: { Authorization: 'Bearer valid_token', 'Content-Type': 'text/csv' },
        body: validCsv,
      });

      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({
        error: 'payload_too_large',
        message: 'File exceeds maximum allowed rows (1000)',
      });
    });

    it('returns 503 when database connection is unavailable in default importFn', async () => {
      const verify = vi.fn().mockResolvedValue(actorId);
      const testApp = createApp({ verify, execute: vi.fn() });

      const response = await testApp.request(`/venues/${venueId}/orders/import`, {
        method: 'POST',
        headers: { Authorization: 'Bearer valid_token', 'Content-Type': 'text/csv' },
        body: validCsv,
      });

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'service_unavailable' });
    });
  });

  describe('Cloudflare Queue Worker Handler', () => {
    it('retries all messages when database connection string is unavailable', async () => {
      const msg1 = { ack: vi.fn(), retry: vi.fn() };
      const msg2 = { ack: vi.fn(), retry: vi.fn() };

      await handleQueueBatch(
        { messages: [msg1, msg2] as any },
        { APP_ENV: 'local' }, // no LOCAL_DATABASE_URL or HYPERDRIVE
      );

      expect(msg1.retry).toHaveBeenCalledTimes(1);
      expect(msg2.retry).toHaveBeenCalledTimes(1);
      expect(msg1.ack).not.toHaveBeenCalled();
      expect(msg2.ack).not.toHaveBeenCalled();
    });

    it('connects INGESTION_REPORTS_BUCKET to reportStorage and passes leaseTimeoutMinutes 15', async () => {
      const mockPut = vi.fn().mockResolvedValue(undefined);
      const mockBucket = { put: mockPut };
      const msg = { ack: vi.fn(), retry: vi.fn() };
      const mockProcessBatch = vi
        .fn()
        .mockImplementation(async (_client, _batch, _extractor, options) => {
          expect(options.leaseTimeoutMinutes).toBe(15);
          expect(options.reportStorage).toBeDefined();
          // Invoke put to verify bucket wiring
          await options.reportStorage.put('reports/t1/j1/extraction.json', '{"test":true}');
        });

      // Provide mock database URL to pass the initial connection check
      // Mock Client connection
      const mockEnv = {
        APP_ENV: 'local',
        LOCAL_DATABASE_URL: 'postgres://user:pass@localhost:5432/testdb',
        INGESTION_REPORTS_BUCKET: mockBucket,
      };

      // Mock Client prototype
      const { Client } = await import('pg');
      const connectSpy = vi.spyOn(Client.prototype, 'connect').mockResolvedValue(undefined as any);
      const endSpy = vi.spyOn(Client.prototype, 'end').mockResolvedValue(undefined as any);

      try {
        await handleQueueBatch({ messages: [msg as any] }, mockEnv, {
          verify: vi.fn(),
          execute: vi.fn(),
          processQueueBatch: mockProcessBatch,
        });

        expect(mockProcessBatch).toHaveBeenCalledTimes(1);
        expect(mockPut).toHaveBeenCalledWith('reports/t1/j1/extraction.json', '{"test":true}');
      } finally {
        connectSpy.mockRestore();
        endSpy.mockRestore();
      }
    });

    it('retries queue message when report storage throws before completion/ACK', async () => {
      const msg = { ack: vi.fn(), retry: vi.fn() };
      const mockFailingProcessBatch = vi.fn().mockImplementation(async () => {
        throw new Error('R2 write failed: INGESTION_REPORTS_BUCKET unavailable');
      });

      const mockEnv = {
        APP_ENV: 'local',
        LOCAL_DATABASE_URL: 'postgres://user:pass@localhost:5432/testdb',
        INGESTION_REPORTS_BUCKET: { put: vi.fn().mockRejectedValue(new Error('R2 write failed')) },
      };

      const { Client } = await import('pg');
      const connectSpy = vi.spyOn(Client.prototype, 'connect').mockResolvedValue(undefined as any);
      const endSpy = vi.spyOn(Client.prototype, 'end').mockResolvedValue(undefined as any);

      try {
        await handleQueueBatch({ messages: [msg as any] }, mockEnv, {
          verify: vi.fn(),
          execute: vi.fn(),
          processQueueBatch: mockFailingProcessBatch,
        });

        expect(msg.retry).toHaveBeenCalledTimes(1);
        expect(msg.ack).not.toHaveBeenCalled();
      } finally {
        connectSpy.mockRestore();
        endSpy.mockRestore();
      }
    });
  });
});

describe('review candidate HTTP boundaries', () => {
  const venueId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
  const extractionId = 'extraction:e1bb4c9c059eb377dc7e92f340e78416';
  const candidateId = 'draft:0bbe00087c6841623c76d7b6f9da5ebf';
  const actorId = 'a11ac10b-58cc-4372-a567-0e02b2c3d479';
  const commandId = 'c11ac10b-58cc-4372-a567-0e02b2c3d479';

  const sessionPath = `/venues/${venueId}/extractions/${extractionId}/review-session`;
  const candidatesPath = `/venues/${venueId}/extractions/${extractionId}/candidates`;
  const reviewPath = `/venues/${venueId}/extractions/${extractionId}/candidates/${candidateId}/review`;

  const minimalExtractionResult = fixtureV2;

  describe('PUT .../review-session', () => {
    it('rejects unauthenticated requests with 401', async () => {
      const response = await app.request(sessionPath, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commandId, extractionResult: minimalExtractionResult }),
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'unauthorized' });
    });

    it('rejects unsupported media type with 415', async () => {
      const testApp = createApp({
        verify: async () => actorId,
        execute: vi.fn(),
      });
      const response = await testApp.request(sessionPath, {
        method: 'PUT',
        headers: { Authorization: 'Bearer signed', 'Content-Type': 'text/plain' },
        body: 'invalid',
      });
      expect(response.status).toBe(415);
      expect(await response.json()).toEqual({ error: 'unsupported_media_type' });
    });

    it('rejects malformed JSON with 400', async () => {
      const testApp = createApp({
        verify: async () => actorId,
        execute: vi.fn(),
      });
      const response = await testApp.request(sessionPath, {
        method: 'PUT',
        headers: { Authorization: 'Bearer signed', 'Content-Type': 'application/json' },
        body: '{ malformed json',
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_json' });
    });

    it('rejects mismatched extraction_id with 400', async () => {
      const testApp = createApp({
        verify: async () => actorId,
        execute: vi.fn(),
      });
      const response = await testApp.request(sessionPath, {
        method: 'PUT',
        headers: { Authorization: 'Bearer signed', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commandId,
          extractionResult: {
            ...minimalExtractionResult,
            extraction_id: 'extraction:mismatched',
          },
        }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_request' });
    });

    it('delegates to upsertReviewSession and returns 200 on valid request', async () => {
      const expectedResponse = {
        schemaVersion: 1,
        venueId,
        extractionResult: minimalExtractionResult,
        items: [],
        privateArtifactRef: null,
        published: false,
      };
      const upsertReviewSession = vi.fn().mockResolvedValue(expectedResponse);
      const testApp = createApp({
        verify: async () => actorId,
        execute: vi.fn(),
        upsertReviewSession,
      });
      const response = await testApp.request(sessionPath, {
        method: 'PUT',
        headers: { Authorization: 'Bearer signed', 'Content-Type': 'application/json' },
        body: JSON.stringify({ commandId, extractionResult: minimalExtractionResult }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(expectedResponse);
      expect(upsertReviewSession).toHaveBeenCalledWith(
        actorId,
        venueId,
        { commandId, extractionResult: minimalExtractionResult },
        {},
      );
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(response.headers.get('X-Request-ID')).toMatch(/^[0-9a-f-]{36}$/);
    });
    it('enforces 512 KB limit on PUT review-session and allows bodies above 16 KB', async () => {
      const upsertReviewSession = vi.fn().mockResolvedValue({
        schemaVersion: 1,
        venueId,
        extractionResult: minimalExtractionResult,
        items: [],
        privateArtifactRef: null,
        published: false,
      });
      const testApp = createApp({
        verify: async () => actorId,
        execute: vi.fn(),
        upsertReviewSession,
      });

      // Positive case: valid payload > 16 KB (padded metadata ~30 KB)
      const largePayload = {
        commandId,
        extractionResult: {
          ...minimalExtractionResult,
          segments: minimalExtractionResult.segments.map(
            (seg: (typeof minimalExtractionResult.segments)[number], i: number) =>
              i === 0 ? { ...seg, metadata: { ...seg.metadata, pad: 'x'.repeat(30_000) } } : seg,
          ),
        },
      };
      const largePayloadString = JSON.stringify(largePayload);
      expect(largePayloadString.length).toBeGreaterThan(16_384);
      expect(largePayloadString.length).toBeLessThan(524_288);

      const largeResponse = await testApp.request(sessionPath, {
        method: 'PUT',
        headers: { Authorization: 'Bearer signed', 'Content-Type': 'application/json' },
        body: largePayloadString,
      });
      expect(largeResponse.status).toBe(200);
      expect(upsertReviewSession).toHaveBeenCalled();

      // Negative case: exceeds 512 KB
      const oversizeResponse = await testApp.request(sessionPath, {
        method: 'PUT',
        headers: { Authorization: 'Bearer signed', 'Content-Type': 'application/json' },
        body: 'x'.repeat(524_289),
      });
      expect(oversizeResponse.status).toBe(413);
      expect(await oversizeResponse.json()).toEqual({ error: 'body_too_large' });
    });
  });

  describe('GET .../candidates', () => {
    it('rejects unauthenticated requests with 401', async () => {
      const response = await app.request(candidatesPath);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'unauthorized' });
    });

    it('delegates to getReviewSession and returns 200 on success', async () => {
      const expectedResponse = {
        schemaVersion: 1,
        venueId,
        extractionResult: minimalExtractionResult,
        items: [],
        privateArtifactRef: null,
        published: false,
      };
      const getReviewSession = vi.fn().mockResolvedValue(expectedResponse);
      const testApp = createApp({
        verify: async () => actorId,
        execute: vi.fn(),
        getReviewSession,
      });
      const response = await testApp.request(candidatesPath, {
        headers: { Authorization: 'Bearer signed' },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(expectedResponse);
      expect(getReviewSession).toHaveBeenCalledWith(actorId, venueId, extractionId, {});
    });
  });

  describe('POST .../review', () => {
    const validCorrectCommand = {
      commandId,
      expectedVersion: 0,
      action: 'correct',
      corrected: { name: 'Organic Soup', price_amount: '10.00' },
    };

    it('rejects unauthenticated requests with 401', async () => {
      const response = await app.request(reviewPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validCorrectCommand),
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'unauthorized' });
    });

    it('rejects oversized candidate review bodies (> 16 KB) with 413', async () => {
      const testApp = createApp({
        verify: async () => actorId,
        execute: vi.fn(),
      });
      const response = await testApp.request(reviewPath, {
        method: 'POST',
        headers: { Authorization: 'Bearer signed', 'Content-Type': 'application/json' },
        body: 'x'.repeat(16_385),
      });
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: 'body_too_large' });
    });
    it('strictly enforces 16 KB limit even when extractionId is literal review-session', async () => {
      const testApp = createApp({
        verify: async () => actorId,
        execute: vi.fn(),
      });
      const bypassAttemptPath = `/venues/${venueId}/extractions/review-session/candidates/${candidateId}/review`;
      const response = await testApp.request(bypassAttemptPath, {
        method: 'POST',
        headers: { Authorization: 'Bearer signed', 'Content-Type': 'application/json' },
        body: 'x'.repeat(16_385),
      });
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: 'body_too_large' });
    });

    it('rejects invalid action commands with 400', async () => {
      const testApp = createApp({
        verify: async () => actorId,
        execute: vi.fn(),
      });
      // action correct without corrected fields
      const response = await testApp.request(reviewPath, {
        method: 'POST',
        headers: { Authorization: 'Bearer signed', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commandId,
          expectedVersion: 0,
          action: 'correct',
        }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_request' });
    });

    it('delegates to saveCandidateReview and returns 200 on success', async () => {
      const expectedItemResponse = {
        candidate: {
          candidate_id: candidateId,
          original: {
            name: 'Garden Soup',
            description: null,
            category: null,
            price_amount: null,
            price_currency: null,
            ingredients: null,
            source_id: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            source_text: 'Soup',
            image_id: null,
            review_warnings: [],
            status: 'needs_review',
          },
          evidence: [{ segment_id: 'seg:1', start: 0, end: 4 }],
          missing_fields: [],
        },
        review: {
          extractionId,
          candidateId,
          revisionId: crypto.randomUUID(),
          version: 1,
          reviewStatus: 'corrected',
          corrected: { name: 'Organic Soup', price_amount: '10.00' },
          editedFields: ['name', 'price_amount'],
          incompleteFields: [],
          reviewNote: null,
          reviewedBy: actorId,
          reviewedAt: new Date().toISOString(),
          publishable: false,
        },
        effective: {
          name: 'Organic Soup',
          description: null,
          category: null,
          price_amount: '10.00',
          price_currency: null,
          ingredients: null,
        },
      };

      const saveCandidateReview = vi.fn().mockResolvedValue(expectedItemResponse);
      const testApp = createApp({
        verify: async () => actorId,
        execute: vi.fn(),
        saveCandidateReview,
      });
      const response = await testApp.request(reviewPath, {
        method: 'POST',
        headers: { Authorization: 'Bearer signed', 'Content-Type': 'application/json' },
        body: JSON.stringify(validCorrectCommand),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(expectedItemResponse);
      expect(saveCandidateReview).toHaveBeenCalledWith(
        actorId,
        venueId,
        extractionId,
        candidateId,
        validCorrectCommand,
        {},
      );
    });
    it('maps ReviewCommandError codes and statuses properly in app.onError', async () => {
      for (const [code, status] of [
        ['forbidden', 403],
        ['not_found', 404],
        ['version_conflict', 409],
        ['command_conflict', 409],
        ['invalid_candidate', 400],
      ] as const) {
        const saveCandidateReview = vi.fn().mockRejectedValue(new ReviewCommandError(code, status));
        const testApp = createApp({
          verify: async () => actorId,
          execute: vi.fn(),
          saveCandidateReview,
        });
        const response = await testApp.request(reviewPath, {
          method: 'POST',
          headers: { Authorization: 'Bearer signed', 'Content-Type': 'application/json' },
          body: JSON.stringify(validCorrectCommand),
        });
        expect(response.status).toBe(status);
        expect(await response.json()).toEqual({ error: code });
      }
    });
  });
});
