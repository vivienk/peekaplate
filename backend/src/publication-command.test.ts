import { describe, expect, it } from 'vitest';
import {
  approveMenuRevision,
  PublicationReplayError,
  replayPublication,
  replayReview,
} from './publication-command';

type Query = { text: string; values?: unknown[] };

class ScriptedClient {
  readonly queries: Query[] = [];
  private readonly responses: Array<{ rows: unknown[] }>;

  constructor(responses: Array<{ rows: unknown[] }>) {
    this.responses = responses;
  }

  async query(text: string, values?: unknown[]) {
    this.queries.push(values ? { text, values } : { text });
    return this.responses.shift() ?? { rows: [] };
  }
}

const actorId = '00000000-0000-4000-8000-000000000001';
const venueId = '00000000-0000-4000-8000-000000000002';
const menuId = '00000000-0000-4000-8000-000000000003';

describe('publication authorization', () => {
  it('requires owner permission before looking up a command receipt', async () => {
    const client = new ScriptedClient([
      { rows: [] },
      { rows: [] },
      { rows: [] },
      { rows: [] },
      { rows: [{ permission: 'editor' }] },
    ]);
    await expect(
      approveMenuRevision(client as never, actorId, venueId, {
        commandId: '00000000-0000-4000-8000-000000000004',
        menuId,
        expectedVersion: 0,
        menuRevisionId: '00000000-0000-4000-8000-000000000005',
        contentApprovalId: '00000000-0000-4000-8000-000000000006',
        assetApprovalId: '00000000-0000-4000-8000-000000000007',
      }),
    ).rejects.toMatchObject({ code: 'forbidden', status: 403 });
    expect(client.queries.some((query) => query.text.includes('app_private.es_command'))).toBe(
      false,
    );
    expect(client.queries.at(-1)?.text).toContain('ROLLBACK');
  });
});

describe('publication replay', () => {
  const published = {
    menuId,
    publicationId: '00000000-0000-4000-8000-000000000006',
    version: 1,
    approvalId: '00000000-0000-4000-8000-000000000007',
    publicationHash: 'c'.repeat(64),
    availabilityVersion: 1,
    status: 'published' as const,
  };

  it('rebuilds publication then withdrawal without side effects', () => {
    expect(
      replayPublication([
        {
          tenantId: venueId,
          streamType: 'menu_publication',
          streamId: menuId,
          version: 1,
          schemaVersion: 1,
          eventType: 'menu.published',
          payload: published,
          metadata: { actorId },
        },
        {
          tenantId: venueId,
          streamType: 'menu_publication',
          streamId: menuId,
          version: 2,
          schemaVersion: 1,
          eventType: 'menu.withdrawn',
          payload: {
            ...published,
            version: 2,
            availabilityVersion: 2,
            status: 'withdrawn',
          },
          metadata: { actorId },
        },
      ]),
    ).toEqual({
      tenantId: venueId,
      ...published,
      version: 2,
      availabilityVersion: 2,
      status: 'withdrawn',
    });
  });

  it('rejects a withdrawal that changes the immutable publication identity', () => {
    expect(() =>
      replayPublication([
        {
          tenantId: venueId,
          streamType: 'menu_publication',
          streamId: menuId,
          version: 1,
          schemaVersion: 1,
          eventType: 'menu.published',
          payload: published,
          metadata: {},
        },
        {
          tenantId: venueId,
          streamType: 'menu_publication',
          streamId: menuId,
          version: 2,
          schemaVersion: 1,
          eventType: 'menu.withdrawn',
          payload: {
            ...published,
            publicationId: '00000000-0000-4000-8000-000000000099',
            version: 2,
            availabilityVersion: 2,
            status: 'withdrawn',
          },
          metadata: {},
        },
      ]),
    ).toThrow(PublicationReplayError);
  });
});

describe('review replay', () => {
  const firstApproval = {
    menuId,
    approvalId: '00000000-0000-4000-8000-000000000020',
    version: 1,
    menuRevisionId: '00000000-0000-4000-8000-000000000021',
    contentApprovalId: '00000000-0000-4000-8000-000000000022',
    contentHash: 'd'.repeat(64),
    assetApprovalId: '00000000-0000-4000-8000-000000000023',
    assetManifestHash: 'e'.repeat(64),
    status: 'approved' as const,
  };

  it('rebuilds the latest exact approval from a contiguous review stream', () => {
    const secondApproval = {
      ...firstApproval,
      approvalId: '00000000-0000-4000-8000-000000000024',
      version: 2,
      menuRevisionId: '00000000-0000-4000-8000-000000000025',
    };
    expect(
      replayReview([
        {
          tenantId: venueId,
          streamType: 'menu_review',
          streamId: menuId,
          version: 1,
          schemaVersion: 1,
          eventType: 'menu.review.approved',
          payload: firstApproval,
          metadata: {},
        },
        {
          tenantId: venueId,
          streamType: 'menu_review',
          streamId: menuId,
          version: 2,
          schemaVersion: 1,
          eventType: 'menu.review.approved',
          payload: secondApproval,
          metadata: {},
        },
      ]),
    ).toEqual({ tenantId: venueId, ...secondApproval });
  });

  it('rejects gaps and mismatched review payloads', () => {
    expect(() =>
      replayReview([
        {
          tenantId: venueId,
          streamType: 'menu_review',
          streamId: menuId,
          version: 2,
          schemaVersion: 1,
          eventType: 'menu.review.approved',
          payload: { ...firstApproval, version: 2 },
          metadata: {},
        },
      ]),
    ).toThrow(PublicationReplayError);
  });
});
