import { describe, expect, it } from 'vitest';
import {
  BoundedRetrievalResultSchema,
  CreateDishRevisionSchema,
  DishIntentEventSchema,
  EvidencePassageSchema,
  HealthResponseSchema,
  MAX_AGGREGATE_PASSAGE_CHARS,
  MAX_PASSAGE_CHARS,
  MAX_PASSAGES,
  RetrievalRequestSchema,
  SourceReferenceSchema,
} from './index';

const event = {
  eventId: '0199b409-a700-7000-8000-000000000001',
  schemaVersion: 1,
  sessionId: '0199b409-a700-7000-8000-000000000002',
  sequence: 1,
  eventType: 'dish_open',
  occurredAt: '2026-10-13T12:00:00.000Z',
  publicationHash: 'a'.repeat(64),
  dishRevisionHash: 'b'.repeat(64),
  displayedTier: 'T0',
  rendererVersion: null,
  manifestHash: null,
  availabilityVersion: 0,
  experimentAssignment: null,
};

describe('dish observation boundary', () => {
  it('accepts a pinned photo exposure without a renderer', () => {
    expect(DishIntentEventSchema.parse(event)).toEqual(event);
  });
  it('rejects enhanced evidence on a photo-only exposure', () => {
    expect(
      DishIntentEventSchema.safeParse({ ...event, manifestHash: 'c'.repeat(64) }).success,
    ).toBe(false);
    expect(DishIntentEventSchema.safeParse({ ...event, rendererVersion: '0.183.0' }).success).toBe(
      false,
    );
  });
  it('rejects browser-supplied authority and server timestamps', () => {
    expect(DishIntentEventSchema.safeParse({ ...event, tenantId: 'spoofed' }).success).toBe(false);
    expect(
      DishIntentEventSchema.safeParse({ ...event, receivedAt: event.occurredAt }).success,
    ).toBe(false);
  });
  it('requires actual renderer and manifest versions for enhanced tiers', () => {
    expect(DishIntentEventSchema.safeParse({ ...event, displayedTier: 'T1' }).success).toBe(false);
    expect(
      DishIntentEventSchema.safeParse({
        ...event,
        displayedTier: 'T1',
        rendererVersion: '0.183.2',
        manifestHash: 'c'.repeat(64),
      }).success,
    ).toBe(true);
  });
  it('rejects malformed identity, sequence and exposure references', () => {
    for (const patch of [
      { eventId: 'invalid' },
      { sequence: 0 },
      { publicationHash: '' },
      { occurredAt: 'yesterday' },
    ]) {
      expect(DishIntentEventSchema.safeParse({ ...event, ...patch }).success).toBe(false);
    }
  });
});

it('health describes the scaffold without claiming database readiness', () => {
  expect(
    HealthResponseSchema.parse({ status: 'ok', service: 'peekaplate-api', stage: 'foundation' })
      .stage,
  ).toBe('foundation');
});

describe('dish command boundary', () => {
  const command = {
    commandId: '00000000-0000-4000-8000-000000000001',
    expectedVersion: 0,
    name: ' Soup ',
    description: ' Seasonal vegetables ',
  };
  it('normalizes content for stable retries', () => {
    expect(CreateDishRevisionSchema.parse(command)).toEqual({
      ...command,
      name: 'Soup',
      description: 'Seasonal vegetables',
    });
  });
  it('rejects claimed authority, invalid versions and oversized content', () => {
    for (const patch of [
      { actorId: command.commandId },
      { tenantId: command.commandId },
      { role: 'owner' },
      { expectedVersion: -1 },
      { expectedVersion: 0.5 },
      { expectedVersion: 2_147_483_647 },
      { name: ' ' },
      { name: 'x'.repeat(161) },
      { name: 'Soup\u0000' },
      { description: 'Text\u0000' },
      { description: 'x'.repeat(4001) },
      { commandId: 'not-a-uuid' },
    ])
      expect(CreateDishRevisionSchema.safeParse({ ...command, ...patch }).success).toBe(false);
  });
});

describe('S3-VIS-04 bounded menu evidence retrieval contract boundary', () => {
  const sampleText = 'Roasted Tomato Soup with Basil: $12.50. Fresh vine tomatoes simmered.';
  const samplePassage = {
    passage_id: 'pass-001',
    source: {
      source_id: 'src-menu-web',
      segment_id: 'seg-mains-1',
    },
    text: sampleText,
    start_offset: 0,
    end_offset: sampleText.length,
    rank: 1,
    score: 0.95,
  };

  it('validates a correct evidence passage', () => {
    expect(EvidencePassageSchema.parse(samplePassage)).toEqual(samplePassage);
  });

  it('rejects passage offset inconsistencies and length mismatches', () => {
    // end <= start
    expect(
      EvidencePassageSchema.safeParse({
        ...samplePassage,
        start_offset: 10,
        end_offset: 10,
      }).success,
    ).toBe(false);

    expect(
      EvidencePassageSchema.safeParse({
        ...samplePassage,
        start_offset: 20,
        end_offset: 10,
      }).success,
    ).toBe(false);

    // text length != end_offset - start_offset
    expect(
      EvidencePassageSchema.safeParse({
        ...samplePassage,
        start_offset: 0,
        end_offset: 50, // text is 68 chars
      }).success,
    ).toBe(false);
  });

  it('rejects empty source or segment identifiers', () => {
    expect(
      SourceReferenceSchema.safeParse({
        source_id: '',
        segment_id: 'seg-1',
      }).success,
    ).toBe(false);

    expect(
      SourceReferenceSchema.safeParse({
        source_id: 'src-1',
        segment_id: '',
      }).success,
    ).toBe(false);
  });

  it('rejects passages longer than 2000 characters', () => {
    const longText = 'a'.repeat(2001);
    expect(
      EvidencePassageSchema.safeParse({
        ...samplePassage,
        text: longText,
        start_offset: 0,
        end_offset: 2001,
      }).success,
    ).toBe(false);
  });

  it('rejects invalid scores outside 0-1 range', () => {
    expect(EvidencePassageSchema.safeParse({ ...samplePassage, score: -0.1 }).success).toBe(false);
    expect(EvidencePassageSchema.safeParse({ ...samplePassage, score: 1.05 }).success).toBe(false);
    expect(EvidencePassageSchema.safeParse({ ...samplePassage, score: 0 }).success).toBe(true);
    expect(EvidencePassageSchema.safeParse({ ...samplePassage, score: 1 }).success).toBe(true);
    // optional score
    const withoutScore = { ...samplePassage };
    delete (withoutScore as any).score;
    expect(EvidencePassageSchema.safeParse(withoutScore).success).toBe(true);
  });

  it('accepts valid responses for every supported status', () => {
    // success
    const successRes = {
      schema_version: 1,
      status: 'success',
      passages: [samplePassage],
      warnings: [],
    };
    expect(BoundedRetrievalResultSchema.parse(successRes)).toEqual(successRes);

    // no_result
    const noResultRes = {
      schema_version: 1,
      status: 'no_result',
      passages: [],
      warnings: ['No matching menu evidence found for query: "Dragonfruit Curry"'],
    };
    expect(BoundedRetrievalResultSchema.parse(noResultRes)).toEqual(noResultRes);

    // ambiguous
    const ambiguousRes = {
      schema_version: 1,
      status: 'ambiguous',
      passages: [
        samplePassage,
        {
          ...samplePassage,
          passage_id: 'pass-002',
          text: 'Tomato Soup Cup: $6.00',
          start_offset: 70,
          end_offset: 92,
          rank: 2,
          score: 0.91,
        },
      ],
      warnings: ['Multiple conflicting dish entries detected across sources'],
    };
    expect(BoundedRetrievalResultSchema.parse(ambiguousRes)).toEqual(ambiguousRes);

    // failed
    const failedRes = {
      schema_version: 1,
      status: 'failed',
      passages: [],
      warnings: ['Candidate URL connection timed out after 10000ms'],
    };
    expect(BoundedRetrievalResultSchema.parse(failedRes)).toEqual(failedRes);
  });

  it('rejects unexpected fields in response and passages (strict schema)', () => {
    const resWithExtra = {
      schema_version: 1,
      status: 'success',
      passages: [{ ...samplePassage, raw_html: '<div>soup</div>' }],
      warnings: [],
      tenant_id: 'should-be-rejected',
    };
    expect(BoundedRetrievalResultSchema.safeParse(resWithExtra).success).toBe(false);
  });

  it('rejects more than 10 passages', () => {
    const elevenPassages = Array.from({ length: 11 }, (_, i) => ({
      passage_id: `pass-${i + 1}`,
      source: { source_id: 'src-1', segment_id: 'seg-1' },
      text: `Dish Item ${i + 1}`,
      start_offset: i * 20,
      end_offset: i * 20 + `Dish Item ${i + 1}`.length,
      rank: i + 1,
    }));

    expect(
      BoundedRetrievalResultSchema.safeParse({
        schema_version: 1,
        status: 'success',
        passages: elevenPassages,
        warnings: [],
      }).success,
    ).toBe(false);
  });

  it('enforces strictly sequential ranks starting at 1', () => {
    // Rank starting at 2
    expect(
      BoundedRetrievalResultSchema.safeParse({
        schema_version: 1,
        status: 'success',
        passages: [{ ...samplePassage, rank: 2 }],
        warnings: [],
      }).success,
    ).toBe(false);

    // Duplicate ranks
    const twoPassages = [
      { ...samplePassage, rank: 1 },
      {
        ...samplePassage,
        passage_id: 'pass-002',
        text: 'Another text item',
        start_offset: 100,
        end_offset: 117,
        rank: 1,
      },
    ];
    expect(
      BoundedRetrievalResultSchema.safeParse({
        schema_version: 1,
        status: 'success',
        passages: twoPassages,
        warnings: [],
      }).success,
    ).toBe(false);
  });

  it('rejects duplicate passage_id values', () => {
    const dupPassages = [
      { ...samplePassage, rank: 1 },
      {
        ...samplePassage,
        passage_id: samplePassage.passage_id,
        text: 'Duplicate id item',
        start_offset: 100,
        end_offset: 117,
        rank: 2,
      },
    ];
    expect(
      BoundedRetrievalResultSchema.safeParse({
        schema_version: 1,
        status: 'success',
        passages: dupPassages,
        warnings: [],
      }).success,
    ).toBe(false);
  });

  it('enforces total aggregate context size limits', () => {
    // 9 passages of 1800 chars = 16200 chars > 16000 max
    const text1800 = 'x'.repeat(1800);
    const passagesOverLimit = Array.from({ length: 9 }, (_, i) => ({
      passage_id: `pass-${i + 1}`,
      source: { source_id: 'src-1', segment_id: 'seg-1' },
      text: text1800,
      start_offset: i * 2000,
      end_offset: i * 2000 + 1800,
      rank: i + 1,
    }));

    const result = BoundedRetrievalResultSchema.safeParse({
      schema_version: 1,
      status: 'success',
      passages: passagesOverLimit,
      warnings: [],
    });
    expect(result.success).toBe(false);
  });

  it('validates retrieval request schema bounds', () => {
    // Valid query
    expect(RetrievalRequestSchema.safeParse({ query: 'Tomato Soup' }).success).toBe(true);

    // Empty query rejected
    expect(RetrievalRequestSchema.safeParse({ query: '   ' }).success).toBe(false);

    // Oversized query rejected
    expect(RetrievalRequestSchema.safeParse({ query: 'a'.repeat(501) }).success).toBe(false);

    // Candidate URLs validated
    expect(
      RetrievalRequestSchema.safeParse({
        query: 'Burger',
        candidate_urls: ['https://restaurant.example.com/menu', 'invalid-url'],
      }).success,
    ).toBe(false);
  });
});
