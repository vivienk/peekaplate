import { describe, expect, it, vi } from 'vitest';
import app, { createApp } from './index';

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
