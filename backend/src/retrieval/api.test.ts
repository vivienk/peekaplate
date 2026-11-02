import type { BoundedRetrievalResult } from '@peekaplate/contracts';
import { describe, expect, it, vi } from 'vitest';
import { CommandError } from '../dish-command';
import { createApp } from '../index';

describe('Retrieval API HTTP Boundary (/venues/:venueId/menu-evidence)', () => {
  const venueId = '00000000-0000-4000-8000-000000000001';
  const path = `/venues/${venueId}/menu-evidence`;

  it('rejects unauthenticated requests with 401', async () => {
    const app = createApp({
      verify: vi.fn(),
      execute: vi.fn(),
    });

    const response = await app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'Tomato Soup' }),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized' });
  });

  it('rejects malformed non-UUID venueId with 400', async () => {
    const app = createApp({
      verify: vi.fn().mockResolvedValue('actor-123'),
      execute: vi.fn(),
    });

    const response = await app.request('/venues/not-a-uuid/menu-evidence', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer valid.jwt.token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: 'Tomato Soup' }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_request' });
  });

  it('rejects unsupported media type with 415', async () => {
    const app = createApp({
      verify: vi.fn().mockResolvedValue('actor-123'),
      execute: vi.fn(),
    });

    const response = await app.request(path, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer valid.jwt.token',
        'Content-Type': 'text/plain',
      },
      body: 'query=Tomato+Soup',
    });

    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({ error: 'unsupported_media_type' });
  });

  it('executes retrieval and returns validated bounded response', async () => {
    const mockRetrievalResult: BoundedRetrievalResult = {
      schema_version: 1,
      status: 'success',
      passages: [
        {
          passage_id: 'pass_1',
          source: { source_id: 'src_1', segment_id: 'seg_1' },
          text: 'Tomato Basil Soup: $10.00',
          start_offset: 0,
          end_offset: 25,
          rank: 1,
          score: 0.95,
        },
      ],
      warnings: [],
    };

    const retrieveMock = vi.fn().mockResolvedValue(mockRetrievalResult);
    const app = createApp({
      verify: vi.fn().mockResolvedValue('actor-123'),
      execute: vi.fn(),
      retrieve: retrieveMock,
    });

    const response = await app.request(path, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer valid.jwt.token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: 'Tomato Basil Soup',
        max_passages: 5,
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual(mockRetrievalResult);
    expect(retrieveMock).toHaveBeenCalledWith({
      query: 'Tomato Basil Soup',
      max_passages: 5,
      venue_id: venueId,
    });
  });

  it('rejects cross-venue ID substitution in request body with 400', async () => {
    const app = createApp({
      verify: vi.fn().mockResolvedValue('actor-123'),
      execute: vi.fn(),
      retrieve: vi.fn(),
    });

    const differentVenueId = '00000000-0000-4000-8000-000000000099';
    const response = await app.request(path, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer valid.jwt.token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: 'Tomato Basil Soup',
        venue_id: differentVenueId, // Spoofed / mismatched venue ID
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_request' });
  });

  it('accepts matching venue_id in request body', async () => {
    const retrieveMock = vi.fn().mockResolvedValue({
      schema_version: 1,
      status: 'no_result',
      passages: [],
      warnings: [],
    });
    const app = createApp({
      verify: vi.fn().mockResolvedValue('actor-123'),
      execute: vi.fn(),
      retrieve: retrieveMock,
    });

    const response = await app.request(path, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer valid.jwt.token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: 'Tomato Basil Soup',
        venue_id: venueId, // Matches path venueId
      }),
    });

    expect(response.status).toBe(200);
    expect(retrieveMock).toHaveBeenCalledWith({
      query: 'Tomato Basil Soup',
      venue_id: venueId,
    });
  });

  it('denies access when staff is not authorized for the requested venue with 403', async () => {
    const authorizeVenue = vi.fn().mockRejectedValue(new CommandError('forbidden', 403));
    const retrieveMock = vi.fn();
    const app = createApp({
      verify: vi.fn().mockResolvedValue('actor-123'),
      execute: vi.fn(),
      authorizeVenue,
      retrieve: retrieveMock,
    });

    const response = await app.request(path, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer valid.jwt.token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: 'Tomato Basil Soup' }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'forbidden' });
    expect(authorizeVenue).toHaveBeenCalledWith('actor-123', venueId, {});
    expect(retrieveMock).not.toHaveBeenCalled();
  });

  describe('Finding P1: authorizeStaffVenue transaction-local actor context & RLS enforcement', () => {
    it('sets transaction-local app.actor_id before querying membership and allows owner', async () => {
      const actorId = '00000000-0000-4000-8000-000000000001';
      const venueId = '00000000-0000-4000-8000-000000000002';
      const executedQueries: { text: string; values?: unknown[] | undefined }[] = [];

      const mockClient = {
        query: vi.fn(async (text: string, values?: unknown[]) => {
          executedQueries.push({ text, values });
          if (text === 'BEGIN') return { rows: [] };
          if (text.includes("set_config('app.actor_id'")) {
            return { rows: [{ set_config: actorId }] };
          }
          if (text.includes('FROM app_private.staff_membership')) {
            // Verify app.actor_id was established BEFORE this query was run
            const actorContextQuery = executedQueries.find((q) =>
              q.text.includes("set_config('app.actor_id'"),
            );
            expect(actorContextQuery).toBeDefined();
            expect(actorContextQuery?.values).toEqual([actorId]);
            return { rows: [{ permission: 'owner' }] };
          }
          if (text === 'COMMIT') return { rows: [] };
          return { rows: [] };
        }),
      };

      const { authorizeStaffVenue } = await import('../index');
      await expect(
        authorizeStaffVenue(mockClient as any, actorId, venueId),
      ).resolves.toBeUndefined();

      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith("SET LOCAL statement_timeout = '5s'");
      expect(mockClient.query).toHaveBeenCalledWith("SET LOCAL lock_timeout = '3s'");
      expect(mockClient.query).toHaveBeenCalledWith("SELECT set_config('app.actor_id', $1, true)", [
        actorId,
      ]);
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    });

    it('allows editor under established actor context', async () => {
      const actorId = '00000000-0000-4000-8000-000000000001';
      const venueId = '00000000-0000-4000-8000-000000000002';

      const mockClient = {
        query: vi.fn(async (text: string) => {
          if (text.includes('FROM app_private.staff_membership')) {
            return { rows: [{ permission: 'editor' }] };
          }
          return { rows: [] };
        }),
      };

      const { authorizeStaffVenue } = await import('../index');
      await expect(
        authorizeStaffVenue(mockClient as any, actorId, venueId),
      ).resolves.toBeUndefined();
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    });

    it('denies viewer with 403 CommandError and issues ROLLBACK', async () => {
      const actorId = '00000000-0000-4000-8000-000000000001';
      const venueId = '00000000-0000-4000-8000-000000000002';

      const mockClient = {
        query: vi.fn(async (text: string) => {
          if (text.includes('FROM app_private.staff_membership')) {
            return { rows: [{ permission: 'viewer' }] };
          }
          return { rows: [] };
        }),
      };

      const { authorizeStaffVenue } = await import('../index');
      await expect(authorizeStaffVenue(mockClient as any, actorId, venueId)).rejects.toMatchObject({
        code: 'forbidden',
        status: 403,
      });

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClient.query).not.toHaveBeenCalledWith('COMMIT');
    });

    it('denies nonmember (no membership rows) with 403 CommandError and issues ROLLBACK', async () => {
      const actorId = '00000000-0000-4000-8000-000000000001';
      const venueId = '00000000-0000-4000-8000-000000000002';

      const mockClient = {
        query: vi.fn(async (text: string) => {
          if (text.includes('FROM app_private.staff_membership')) {
            return { rows: [] }; // No matching membership row
          }
          return { rows: [] };
        }),
      };

      const { authorizeStaffVenue } = await import('../index');
      await expect(authorizeStaffVenue(mockClient as any, actorId, venueId)).rejects.toMatchObject({
        code: 'forbidden',
        status: 403,
      });

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClient.query).not.toHaveBeenCalledWith('COMMIT');
    });

    it('issues ROLLBACK when a database error occurs during authorization', async () => {
      const actorId = '00000000-0000-4000-8000-000000000001';
      const venueId = '00000000-0000-4000-8000-000000000002';

      const mockClient = {
        query: vi.fn(async (text: string) => {
          if (text.includes('FROM app_private.staff_membership')) {
            throw new Error('Connection timeout during query');
          }
          return { rows: [] };
        }),
      };

      const { authorizeStaffVenue } = await import('../index');
      await expect(authorizeStaffVenue(mockClient as any, actorId, venueId)).rejects.toThrow(
        'Connection timeout during query',
      );

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    });

    it('uses is_local = true in set_config to prevent actor context leakage across transactions', async () => {
      const actorId = '00000000-0000-4000-8000-000000000001';
      const venueId = '00000000-0000-4000-8000-000000000002';

      const setConfigCalls: unknown[][] = [];
      const mockClient = {
        query: vi.fn(async (text: string, values?: unknown[]) => {
          if (text.includes("set_config('app.actor_id'")) {
            setConfigCalls.push(values ?? []);
          }
          if (text.includes('FROM app_private.staff_membership')) {
            return { rows: [{ permission: 'owner' }] };
          }
          return { rows: [] };
        }),
      };

      const { authorizeStaffVenue } = await import('../index');
      await authorizeStaffVenue(mockClient as any, actorId, venueId);

      // Verify third parameter of set_config is true (transaction-local)
      expect(mockClient.query).toHaveBeenCalledWith("SELECT set_config('app.actor_id', $1, true)", [
        actorId,
      ]);
    });
  });
});
