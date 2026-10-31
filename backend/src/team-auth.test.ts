import { describe, expect, it, vi } from 'vitest';
import { verifyTeamCollaborator } from './team-auth';

describe('repository collaborator authorization', () => {
  const env = { TEAM_GITHUB_TOKEN: 'server-metadata-token' };
  it('verifies identity with the caller token and checks the fixed repo with the server token every time', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: 42, login: 'member', type: 'User' }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json({ id: 42, login: 'member', type: 'User' }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(
      verifyTeamCollaborator('Bearer personal-token', env, request),
    ).resolves.toBeUndefined();
    expect(request.mock.calls[0]?.[0]).toBe('https://api.github.com/user');
    expect(request.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer personal-token',
    });
    expect(request.mock.calls[0]?.[1]?.redirect).toBe('manual');
    expect(request.mock.calls[1]?.[0]).toBe(
      'https://api.github.com/repos/vivienk/peekaplate/collaborators/member',
    );
    expect(request.mock.calls[1]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer server-metadata-token',
    });
    await expect(
      verifyTeamCollaborator('Bearer personal-token', env, request),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(request).toHaveBeenCalledTimes(4);
  });
  it('denies invalid tokens, forged profile fields and unavailable providers without a fallback grant', async () => {
    for (const [response, status] of [
      [new Response(null, { status: 401 }), 401],
      [Response.json({ id: 42, login: '../outsider', type: 'User' }), 401],
      [new Response(null, { status: 429 }), 503],
    ] as const) {
      const request = vi.fn<typeof fetch>().mockResolvedValueOnce(response);
      await expect(
        verifyTeamCollaborator('Bearer personal-token', env, request),
      ).rejects.toMatchObject({ status });
      expect(request).toHaveBeenCalledTimes(1);
    }
    await expect(
      verifyTeamCollaborator('Bearer personal-token', {}, vi.fn()),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      verifyTeamCollaborator(
        'Bearer personal-token',
        env,
        vi.fn().mockRejectedValue(new Error('network')),
      ),
    ).rejects.toMatchObject({ status: 503 });
  });
  it('never sends credentials to a configured alternate host in staging', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    await expect(
      verifyTeamCollaborator(
        'Bearer personal-token',
        { ...env, APP_ENV: 'staging', LOCAL_GITHUB_API_URL: 'http://127.0.0.1:9999' },
        request,
      ),
    ).rejects.toMatchObject({ status: 401 });
    expect(request.mock.calls[0]?.[0]).toBe('https://api.github.com/user');
  });
});
