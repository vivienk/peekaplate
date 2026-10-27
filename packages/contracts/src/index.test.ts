import { describe, expect, it } from 'vitest';
import {
  ApproveMenuRevisionSchema,
  BoundedRetrievalResultSchema,
  CreateDishRevisionSchema,
  DishIntentEventSchema,
  EvidencePassageSchema,
  HealthResponseSchema,
  MAX_AGGREGATE_PASSAGE_CHARS,
  MAX_PASSAGE_CHARS,
  MAX_PASSAGES,
  MenuPublicationSchema,
  PublicMenuContentBundleSchema,
  PublicMenuDeliverySchema,
  PublishMenuSchema,
  RetrievalRequestSchema,
  SourceReferenceSchema,
  WithdrawMenuSchema,
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

describe('RES-02 review and publication boundary', () => {
  const commandId = '00000000-0000-4000-8000-000000000001';
  const approvalId = '00000000-0000-4000-8000-000000000002';
  const approval = {
    commandId,
    expectedVersion: 0,
    menuRevisionId: '00000000-0000-4000-8000-000000000003',
    contentApprovalId: '00000000-0000-4000-8000-000000000006',
    assetApprovalId: '00000000-0000-4000-8000-000000000007',
  };

  it('pins the exact immutable menu and asset revisions under review', () => {
    expect(ApproveMenuRevisionSchema.parse(approval)).toEqual(approval);
  });

  it('keeps approval, publication and withdrawal as separate commands', () => {
    expect(PublishMenuSchema.parse({ commandId, expectedVersion: 0, approvalId })).toEqual({
      commandId,
      expectedVersion: 0,
      approvalId,
    });
    expect(WithdrawMenuSchema.parse({ commandId, expectedVersion: 1 })).toEqual({
      commandId,
      expectedVersion: 1,
    });
  });

  it('rejects claimed authority, unknown fields and malformed immutable references', () => {
    for (const patch of [
      { venueId: approvalId },
      { actorId: approvalId },
      { permission: 'owner' },
      { expectedVersion: -1 },
      { menuRevisionId: 'not-a-uuid' },
      { contentApprovalId: 'not-a-uuid' },
      { assetApprovalId: 'not-a-uuid' },
    ]) {
      expect(ApproveMenuRevisionSchema.safeParse({ ...approval, ...patch }).success).toBe(false);
    }
  });

  it('represents withdrawn content explicitly without changing its publication identity', () => {
    const publication = {
      menuId: '00000000-0000-4000-8000-000000000004',
      publicationId: '00000000-0000-4000-8000-000000000005',
      version: 2,
      approvalId,
      publicationHash: 'c'.repeat(64),
      availabilityVersion: 2,
      status: 'withdrawn' as const,
    };
    expect(MenuPublicationSchema.parse(publication)).toEqual(publication);
  });
});

describe('RES-02 immutable diner bundle boundary', () => {
  const bundle = {
    schema_version: 1,
    venue_id: '00000000-0000-4000-8000-000000000101',
    menu_id: '00000000-0000-4000-8000-000000000102',
    menu_revision_id: '00000000-0000-4000-8000-000000000103',
    publication_id: '00000000-0000-4000-8000-000000000104',
    restaurant: {
      name: 'Synthetic Test Kitchen',
      logo: null,
    },
    categories: [
      {
        category_id: '00000000-0000-4000-8000-000000000105',
        name: 'Mains',
        dishes: [
          {
            dish_id: '00000000-0000-4000-8000-000000000106',
            dish_revision_id: '00000000-0000-4000-8000-000000000107',
            complete: true,
            name: 'Garden Bowl',
            description: 'Synthetic fixture content.',
            price: { amount: '12.50', currency: 'USD' },
            ingredients: [
              {
                ingredient_id: '00000000-0000-4000-8000-000000000108',
                name: 'Tomato',
                description: null,
              },
            ],
            dietary: ['Vegan', 'Gluten-free'],
            images: {
              card: {
                url: 'https://assets.example.test/dishes/card.webp',
                width: 640,
                height: 480,
                alt: 'Synthetic garden bowl fixture',
              },
              detail: {
                url: 'https://assets.example.test/dishes/detail.webp',
                width: 1280,
                height: 960,
                alt: 'Synthetic garden bowl fixture',
              },
            },
          },
          {
            dish_id: '00000000-0000-4000-8000-000000000109',
            dish_revision_id: '00000000-0000-4000-8000-000000000110',
            complete: false,
          },
        ],
      },
    ],
  } as const;

  it('accepts an ordered T0 bundle with complete and deliberately incomplete dishes', () => {
    expect(PublicMenuContentBundleSchema.parse(bundle)).toEqual(bundle);
  });

  it('rejects partial claims, arbitrary allergens and insecure image URLs', () => {
    const incompleteDish = bundle.categories[0].dishes[1];
    expect(
      PublicMenuContentBundleSchema.safeParse({
        ...bundle,
        categories: [
          {
            ...bundle.categories[0],
            dishes: [{ ...incompleteDish, price: { amount: '8.00', currency: 'USD' } }],
          },
        ],
      }).success,
    ).toBe(false);
    const completeDish = bundle.categories[0].dishes[0];
    expect(
      PublicMenuContentBundleSchema.safeParse({
        ...bundle,
        categories: [
          {
            ...bundle.categories[0],
            dishes: [{ ...completeDish, allergens: ['Peanuts'] }],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      PublicMenuContentBundleSchema.safeParse({
        ...bundle,
        categories: [
          {
            ...bundle.categories[0],
            dishes: [
              {
                ...completeDish,
                images: {
                  ...completeDish.images,
                  card: {
                    ...completeDish.images.card,
                    url: 'http://assets.example.test/card.webp',
                  },
                },
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects content identities that do not match the active public response', () => {
    expect(
      PublicMenuDeliverySchema.safeParse({
        response: {
          schemaVersion: 1,
          venueId: bundle.venue_id,
          menuId: bundle.menu_id,
          menuRevisionId: bundle.menu_revision_id,
          publicationId: '00000000-0000-4000-8000-000000000999',
          publicationHash: 'a'.repeat(64),
          availabilityVersion: 1,
          tier: 'T0',
          bundle: {
            url: 'https://assets.example.test/menu.json',
            contentHash: 'b'.repeat(64),
            assetManifestHash: 'c'.repeat(64),
          },
          menuToken: 'synthetic-token',
          tokenExpiresAt: '2026-10-27T00:30:00.000Z',
        },
        content: bundle,
      }).success,
    ).toBe(false);
  });

  it('rejects duplicate identities and invalid money or dietary values', () => {
    const completeDish = bundle.categories[0].dishes[0];
    expect(
      PublicMenuContentBundleSchema.safeParse({
        ...bundle,
        categories: [bundle.categories[0], { ...bundle.categories[0], name: 'Duplicate category' }],
      }).success,
    ).toBe(false);
    expect(
      PublicMenuContentBundleSchema.safeParse({
        ...bundle,
        categories: [
          {
            ...bundle.categories[0],
            dishes: [completeDish, { ...completeDish, dish_revision_id: bundle.menu_revision_id }],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      PublicMenuContentBundleSchema.safeParse({
        ...bundle,
        categories: [
          {
            ...bundle.categories[0],
            dishes: [
              {
                ...completeDish,
                price: { amount: '12.500', currency: 'usd' },
                dietary: ['Vegan', 'Vegan'],
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
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

  it('validates VIS-02 compatible source inputs, OCR methods, and provenance', () => {
    // 1. SourceInputSchema accepting 'image' and 'website' kinds with sha256 & provenance
    const imageSource = {
      source_id: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      kind: 'image' as const,
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      retrieved_at: '2026-10-22T20:00:00.000Z',
      size_bytes: 1024,
      segments: [
        {
          segment_id:
            'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855#image-1',
          text: 'Clam Chowder $11.50',
          page_number: 1,
          method: 'ocr_space_engine3' as const,
          status: 'ready' as const,
          metadata: { engine: 3, bounding_box: [10, 20, 100, 200] },
          warnings: ['Low confidence OCR on line 1'],
        },
      ],
    };

    const reqWithImage = RetrievalRequestSchema.safeParse({
      query: 'Clam Chowder',
      sources: [imageSource],
    });
    expect(reqWithImage.success).toBe(true);

    // 2. SourceReferenceSchema with full URL provenance
    const refWithProvenance = {
      source_id: 'src_url_1',
      segment_id: 'src_url_1#seg-1',
      source_sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      original_url: 'https://example.com/menu',
      final_url: 'https://example.com/menu/dinner',
      retrieved_at: '2026-10-22T20:00:00.000Z',
    };
    expect(SourceReferenceSchema.safeParse(refWithProvenance).success).toBe(true);
  });
});
