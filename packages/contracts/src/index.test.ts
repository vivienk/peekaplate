import { describe, expect, it } from 'vitest';
import {
  BoundedRetrievalResultSchema,
  CreateDishRevisionSchema,
  canonicalJson,
  DishIntentEventSchema,
  EvidencePassageSchema,
  HealthResponseSchema,
  MAX_AGGREGATE_PASSAGE_CHARS,
  MAX_PASSAGE_CHARS,
  MAX_PASSAGES,
  ObservationBatchV2Schema,
  ObservationConflictQueueMessageSchema,
  ObservationQueueEnvelopeSchema,
  ObservationQueueMessageSchema,
  ObservationReceiptSchema,
  ObservationV2Schema,
  RetrievalRequestSchema,
  SourceReferenceSchema,
  sha256,
  toCanonicalObservation,
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

describe('observation.v2 contract', () => {
  const base = {
    schema_version: 'observation.v2',
    event_id: '10000000-0000-4000-8000-000000000001',
    type: 'dish_saved',
    session_id: '20000000-0000-4000-8000-000000000001',
    producer_id: '30000000-0000-4000-8000-000000000001',
    local_sequence: 1,
    occurred_at: '2026-10-24T16:00:00.000Z',
    publication_revision_id: '40000000-0000-4000-8000-000000000001',
    payload: {
      dish_id: '50000000-0000-4000-8000-000000000001',
      dish_revision_id: '60000000-0000-4000-8000-000000000001',
      save_origin: 'direct',
      save_surface: 'dish_detail',
      shortlist_size: 1,
    },
  };

  it('accepts the string schema version and approved Save fields', () => {
    expect(ObservationV2Schema.parse(base)).toEqual(base);
    expect(
      ObservationBatchV2Schema.parse({ contract: 'observation.v2', events: [base] }).events,
    ).toHaveLength(1);
  });

  it('accepts and rejects a fixture for every P0 event payload', () => {
    const dishId = base.payload.dish_id;
    const dishRevisionId = base.payload.dish_revision_id;
    const otherDishId = '50000000-0000-4000-8000-000000000002';
    const otherDishRevisionId = '60000000-0000-4000-8000-000000000002';
    const exposureId = '70000000-0000-4000-8000-000000000001';
    const openingId = '80000000-0000-4000-8000-000000000001';
    const fixtures = [
      {
        valid: { ...base, type: 'menu_viewed', payload: { entry_source: 'qr' } },
        invalid: { ...base, type: 'menu_viewed', payload: { entry_source: 'table_qr' } },
      },
      {
        valid: {
          ...base,
          type: 'dish_viewed',
          payload: {
            dish_id: dishId,
            dish_revision_id: dishRevisionId,
            exposure_id: exposureId,
            surface: 'menu_list',
            position: 1,
            exposure_basis: 'viewport_50pct_1s',
          },
        },
        invalid: {
          ...base,
          type: 'dish_viewed',
          payload: {
            dish_id: dishId,
            dish_revision_id: dishRevisionId,
            exposure_id: exposureId,
            surface: 'menu_list',
            position: 0,
            exposure_basis: 'viewport_50pct_1s',
          },
        },
      },
      {
        valid: {
          ...base,
          type: 'dish_detail_opened',
          payload: {
            dish_id: dishId,
            dish_revision_id: dishRevisionId,
            opening_id: openingId,
            source: 'menu_card',
            from_exposure_id: exposureId,
            nav_relation: 'none',
            save_available: true,
          },
        },
        invalid: {
          ...base,
          type: 'dish_detail_opened',
          payload: {
            dish_id: dishId,
            dish_revision_id: dishRevisionId,
            opening_id: openingId,
            source: 'direct_link',
            save_available: true,
          },
        },
      },
      {
        valid: {
          ...base,
          type: 'dish_activity_checkpoint',
          payload: {
            dish_id: dishId,
            dish_revision_id: dishRevisionId,
            opening_id: openingId,
            active_ms: 300_000,
            final: true,
          },
        },
        invalid: {
          ...base,
          type: 'dish_activity_checkpoint',
          payload: {
            dish_id: dishId,
            dish_revision_id: dishRevisionId,
            opening_id: openingId,
            active_ms: 300_001,
            final: true,
          },
        },
      },
      {
        valid: {
          ...base,
          type: 'dish_detail_closed',
          payload: { dish_id: dishId, dish_revision_id: dishRevisionId, opening_id: openingId },
        },
        invalid: {
          ...base,
          type: 'dish_detail_closed',
          payload: {
            dish_id: dishId,
            dish_revision_id: dishRevisionId,
            opening_id: openingId,
            active_ms: 1,
          },
        },
      },
      {
        valid: {
          ...base,
          type: 'dish_compared',
          payload: {
            dish_id: dishId,
            dish_revision_id: dishRevisionId,
            other_dish_id: otherDishId,
            other_dish_revision_id: otherDishRevisionId,
            comparison_id: '90000000-0000-4000-8000-000000000001',
            compare_action: 'start',
            save_available: true,
          },
        },
        invalid: {
          ...base,
          type: 'dish_compared',
          payload: {
            dish_id: dishId,
            dish_revision_id: dishRevisionId,
            other_dish_id: dishId,
            other_dish_revision_id: dishRevisionId,
            comparison_id: '90000000-0000-4000-8000-000000000001',
            compare_action: 'start',
            save_available: true,
          },
        },
      },
      {
        valid: base,
        invalid: { ...base, payload: { ...base.payload, save_origin: 'toast' } },
      },
      {
        valid: {
          ...base,
          type: 'dish_unsaved',
          payload: {
            dish_id: dishId,
            dish_revision_id: dishRevisionId,
            unsave_surface: 'compare_view',
            shortlist_size: 0,
          },
        },
        invalid: {
          ...base,
          type: 'dish_unsaved',
          payload: {
            dish_id: dishId,
            dish_revision_id: dishRevisionId,
            unsave_surface: 'toast',
            shortlist_size: 0,
          },
        },
      },
      {
        valid: { ...base, type: 'shortlist_viewed', payload: { shortlist_size: 1 } },
        invalid: {
          ...base,
          type: 'shortlist_viewed',
          payload: { shortlist_size: 1, dish_id: dishId },
        },
      },
    ];

    for (const fixture of fixtures) {
      expect(ObservationV2Schema.safeParse(fixture.valid).success).toBe(true);
      expect(ObservationV2Schema.safeParse(fixture.invalid).success).toBe(false);
    }
  });

  it('rejects numeric versions, client authority, unknown fields and removed event types', () => {
    for (const candidate of [
      { ...base, schema_version: 2 },
      { ...base, venue_id: base.event_id },
      { ...base, received_at: base.occurred_at },
      { ...base, type: 'ingredient_viewed' },
      { ...base, payload: { ...base.payload, search_text: 'soup' } },
    ]) {
      expect(ObservationV2Schema.safeParse(candidate).success).toBe(false);
    }
  });

  it('keeps Save, Unsave and Undo in the approved event vocabulary', () => {
    expect(
      ObservationV2Schema.safeParse({
        ...base,
        payload: { ...base.payload, save_origin: 'undo', save_surface: 'saved_screen' },
      }).success,
    ).toBe(true);
    expect(
      ObservationV2Schema.safeParse({
        ...base,
        type: 'dish_unsaved',
        payload: {
          dish_id: base.payload.dish_id,
          dish_revision_id: base.payload.dish_revision_id,
          unsave_surface: 'saved_screen',
          shortlist_size: 0,
        },
      }).success,
    ).toBe(true);
    expect(
      ObservationV2Schema.safeParse({
        ...base,
        type: 'dish_unsaved',
        payload: {
          dish_id: base.payload.dish_id,
          dish_revision_id: base.payload.dish_revision_id,
          unsave_surface: 'compare_view',
          shortlist_size: 0,
        },
      }).success,
    ).toBe(true);
    expect(ObservationV2Schema.safeParse({ ...base, type: 'undo' }).success).toBe(false);
  });
});

describe('observation receipt contract', () => {
  const eventId = '10000000-0000-4000-8000-000000000001';

  it('accepts only coherent accepted, retry and rejected dispositions', () => {
    for (const receipt of [
      { event_id: eventId, status: 'accepted', reason_code: null, retryable: false },
      {
        event_id: eventId,
        status: 'accepted',
        reason_code: 'duplicate_in_batch',
        retryable: false,
      },
      { event_id: eventId, status: 'retry', reason_code: null, retryable: true },
      {
        event_id: eventId,
        status: 'rejected',
        reason_code: 'schema_invalid',
        retryable: false,
      },
      { event_id: null, status: 'rejected', reason_code: 'schema_invalid', retryable: false },
    ]) {
      expect(ObservationReceiptSchema.safeParse(receipt).success).toBe(true);
    }
  });

  it('rejects contradictory status, reason and retryability combinations', () => {
    for (const receipt of [
      { event_id: eventId, status: 'accepted', reason_code: 'schema_invalid', retryable: false },
      { event_id: eventId, status: 'accepted', reason_code: null, retryable: true },
      { event_id: null, status: 'accepted', reason_code: null, retryable: false },
      { event_id: eventId, status: 'retry', reason_code: 'too_old', retryable: true },
      { event_id: eventId, status: 'retry', reason_code: null, retryable: false },
      { event_id: null, status: 'retry', reason_code: null, retryable: true },
      { event_id: eventId, status: 'rejected', reason_code: null, retryable: false },
      { event_id: eventId, status: 'rejected', reason_code: 'too_old', retryable: true },
      { event_id: null, status: 'rejected', reason_code: 'too_old', retryable: false },
    ]) {
      expect(ObservationReceiptSchema.safeParse(receipt).success).toBe(false);
    }
  });
});

describe('observation Queue contracts', () => {
  const event = {
    schema_version: 'observation.v2' as const,
    event_id: '10000000-0000-4000-8000-000000000001',
    type: 'shortlist_viewed' as const,
    session_id: '20000000-0000-4000-8000-000000000001',
    producer_id: '30000000-0000-4000-8000-000000000001',
    local_sequence: 2,
    occurred_at: '2026-10-24T16:00:00.000Z',
    publication_revision_id: '40000000-0000-4000-8000-000000000001',
    payload: { shortlist_size: 2 },
  };

  it('validates the flattened observation payload against its event type', () => {
    const message = {
      kind: 'observation.v2',
      tenantId: '50000000-0000-4000-8000-000000000001',
      eventId: event.event_id,
      sessionId: event.session_id,
      schemaVersion: event.schema_version,
      occurredAt: event.occurred_at,
      type: event.type,
      authorizedPublicationId: event.publication_revision_id,
      producerId: event.producer_id,
      localSequence: event.local_sequence,
      payload: event.payload,
      firstReceivedAt: '2026-10-24T16:00:01.000Z',
    };
    expect(ObservationQueueMessageSchema.safeParse(message).success).toBe(true);
    expect(
      ObservationQueueMessageSchema.safeParse({
        ...message,
        payload: { shortlist_size: 2, search_text: 'private' },
      }).success,
    ).toBe(false);
  });

  it('bounds conflict evidence to validated events or fixed safe metadata', () => {
    const message = {
      kind: 'observation_conflict.v1',
      tenantId: '50000000-0000-4000-8000-000000000001',
      eventId: event.event_id,
      authorizedPublicationId: event.publication_revision_id,
      firstReceivedAt: '2026-10-24T16:00:01.000Z',
      reasonCode: 'event_id_conflict',
      copies: [
        { validation: 'valid', canonicalChecksum: 'a'.repeat(64), event },
        {
          validation: 'invalid',
          canonicalChecksum: 'b'.repeat(64),
          metadata: {
            schemaVersionStatus: 'other',
            eventType: 'shortlist_viewed',
            occurredAt: event.occurred_at,
            publicationStatus: 'matches_authority',
            payloadObject: true,
          },
        },
      ],
    };
    expect(ObservationConflictQueueMessageSchema.safeParse(message).success).toBe(true);
    expect(
      ObservationConflictQueueMessageSchema.safeParse({
        ...message,
        copies: [message.copies[0], { ...message.copies[1], search_text: 'private' }],
      }).success,
    ).toBe(false);
  });
});

describe('ObservationQueueEnvelopeSchema contract boundary', () => {
  const tenantId = '50000000-0000-4000-8000-000000000001';
  const eventId = '10000000-0000-4000-8000-000000000001';
  const pubId = '40000000-0000-4000-8000-000000000001';
  const sessionId = '20000000-0000-4000-8000-000000000001';
  const producerId = '30000000-0000-4000-8000-000000000001';

  const validNormal = {
    kind: 'observation.v2' as const,
    tenantId,
    eventId,
    authorizedPublicationId: pubId,
    sessionId,
    schemaVersion: 'observation.v2' as const,
    occurredAt: '2026-10-24T12:00:00.000Z',
    type: 'dish_viewed' as const,
    producerId,
    localSequence: 1,
    payload: {
      dish_id: '60000000-0000-4000-8000-000000000001',
      dish_revision_id: '70000000-0000-4000-8000-000000000001',
      exposure_id: '80000000-0000-4000-8000-000000000001',
      surface: 'menu_list' as const,
      position: 1,
      exposure_basis: 'viewport_50pct_1s' as const,
    },
    firstReceivedAt: '2026-10-24T12:00:01.000Z',
  };

  const validConflictPayload = {
    kind: 'observation_conflict.v1' as const,
    tenantId,
    eventId,
    authorizedPublicationId: pubId,
    firstReceivedAt: '2026-10-24T12:00:01.000Z',
    reasonCode: 'event_id_conflict' as const,
    copies: [
      {
        validation: 'valid' as const,
        canonicalChecksum: 'a'.repeat(64),
        event: {
          schema_version: 'observation.v2' as const,
          event_id: eventId,
          session_id: sessionId,
          producer_id: producerId,
          local_sequence: 1,
          occurred_at: '2026-10-24T12:00:00.000Z',
          publication_revision_id: pubId,
          type: 'shortlist_viewed' as const,
          payload: { shortlist_size: 1 },
        },
      },
      {
        validation: 'invalid' as const,
        canonicalChecksum: 'b'.repeat(64),
        metadata: {
          schemaVersionStatus: 'other' as const,
          eventType: 'shortlist_viewed' as const,
          occurredAt: '2026-10-24T12:00:00.000Z',
          publicationStatus: 'matches_authority' as const,
          payloadObject: true,
        },
      },
    ],
  };

  it('validates canonical normal observation.v2 envelopes', () => {
    const parsed = ObservationQueueEnvelopeSchema.parse(validNormal);
    expect(parsed.kind).toBe('observation.v2');
    expect(parsed.tenantId).toBe(tenantId);
    expect(parsed.eventId).toBe(eventId);
    expect(parsed.authorizedPublicationId).toBe(pubId);

    // Accepts ISO datetime with explicit timezone offset (e.g., +02:00, -04:00)
    const withOffset = {
      ...validNormal,
      occurredAt: '2026-10-24T14:00:00+02:00',
      firstReceivedAt: '2026-10-24T08:00:00-04:00',
    };
    const parsedOffset = ObservationQueueEnvelopeSchema.parse(withOffset);
    expect(parsedOffset.kind).toBe('observation.v2');
    if (parsedOffset.kind === 'observation.v2') {
      expect(parsedOffset.occurredAt).toBe('2026-10-24T14:00:00+02:00');
    }
  });

  it('validates canonical conflict observation_conflict.v1 envelopes', () => {
    const parsedPayload = ObservationQueueEnvelopeSchema.parse(validConflictPayload);
    expect(parsedPayload.kind).toBe('observation_conflict.v1');
    expect(parsedPayload.tenantId).toBe(tenantId);
    if (parsedPayload.kind === 'observation_conflict.v1') {
      expect(parsedPayload.copies).toHaveLength(2);
    }
  });

  it('rejects browser-facing snake_case formats at the queue boundary', () => {
    const snakeCase = {
      tenant_id: tenantId,
      event_id: eventId,
      authorized_publication_id: pubId,
      schema_version: 'observation.v2',
      occurred_at: '2026-10-24T12:00:00.000Z',
      type: 'dish_viewed',
      payload: {},
    };
    expect(ObservationQueueEnvelopeSchema.safeParse(snakeCase).success).toBe(false);
  });

  it('rejects unknown envelope kinds and unsupported schema versions', () => {
    expect(
      ObservationQueueEnvelopeSchema.safeParse({
        ...validNormal,
        kind: 'observation.v3',
      }).success,
    ).toBe(false);

    expect(
      ObservationQueueEnvelopeSchema.safeParse({
        ...validNormal,
        schemaVersion: 'observation.v1',
      }).success,
    ).toBe(false);

    expect(
      ObservationQueueEnvelopeSchema.safeParse({
        ...validConflictPayload,
        kind: 'unknown_conflict',
      }).success,
    ).toBe(false);
  });

  it('rejects invalid UUIDs and unauthorized/malformed identifiers', () => {
    for (const badUuid of ['not-a-uuid', '12345', '', 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz']) {
      expect(
        ObservationQueueEnvelopeSchema.safeParse({
          ...validNormal,
          tenantId: badUuid,
        }).success,
      ).toBe(false);
      expect(
        ObservationQueueEnvelopeSchema.safeParse({
          ...validNormal,
          eventId: badUuid,
        }).success,
      ).toBe(false);
      expect(
        ObservationQueueEnvelopeSchema.safeParse({
          ...validNormal,
          authorizedPublicationId: badUuid,
        }).success,
      ).toBe(false);
      expect(
        ObservationQueueEnvelopeSchema.safeParse({
          ...validNormal,
          sessionId: badUuid,
        }).success,
      ).toBe(false);
      expect(
        ObservationQueueEnvelopeSchema.safeParse({
          ...validNormal,
          producerId: badUuid,
        }).success,
      ).toBe(false);
    }
  });

  it('rejects unknown observation types', () => {
    expect(
      ObservationQueueEnvelopeSchema.safeParse({
        ...validNormal,
        type: 'unsupported_event_type',
      }).success,
    ).toBe(false);
  });

  it('rejects unknown extra properties on strict objects', () => {
    expect(
      ObservationQueueEnvelopeSchema.safeParse({
        ...validNormal,
        extraInjectedField: 'unauthorized',
      }).success,
    ).toBe(false);

    expect(
      ObservationQueueEnvelopeSchema.safeParse({
        ...validConflictPayload,
        extraInjectedField: 'unauthorized',
      }).success,
    ).toBe(false);
  });
});

describe('canonical observation checksum and identity', () => {
  const envelope = {
    kind: 'observation.v2' as const,
    tenantId: '50000000-0000-4000-8000-000000000001',
    eventId: '10000000-0000-4000-8000-000000000001',
    sessionId: '20000000-0000-4000-8000-000000000001',
    schemaVersion: 'observation.v2' as const,
    occurredAt: '2026-10-24T12:00:00.000Z',
    type: 'dish_viewed' as const,
    authorizedPublicationId: '40000000-0000-4000-8000-000000000001',
    producerId: '30000000-0000-4000-8000-000000000001',
    localSequence: 1,
    payload: {
      dish_id: '60000000-0000-4000-8000-000000000001',
      dish_revision_id: '70000000-0000-4000-8000-000000000001',
      exposure_id: '80000000-0000-4000-8000-000000000001',
      surface: 'menu_list' as const,
      position: 1,
      exposure_basis: 'viewport_50pct_1s' as const,
    },
    firstReceivedAt: '2026-10-24T12:00:01.000Z',
  };

  it('reconstructs complete canonical observation and computes matching checksum', async () => {
    const obs = toCanonicalObservation(envelope);
    expect(obs.schema_version).toBe('observation.v2');
    expect(obs.event_id).toBe(envelope.eventId);
    expect(obs.session_id).toBe(envelope.sessionId);
    expect(obs.occurred_at).toBe(envelope.occurredAt);
    expect(obs.publication_revision_id).toBe(envelope.authorizedPublicationId);
    expect(obs.type).toBe('dish_viewed');

    const canonicalStr = canonicalJson(obs);
    const hash = await sha256(canonicalStr);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    // Producer and consumer generate matching canonical checksums for the same valid observation
    const producerEvent = {
      schema_version: 'observation.v2' as const,
      event_id: envelope.eventId,
      session_id: envelope.sessionId,
      producer_id: envelope.producerId,
      local_sequence: envelope.localSequence,
      occurred_at: envelope.occurredAt,
      publication_revision_id: envelope.authorizedPublicationId,
      type: envelope.type,
      payload: envelope.payload,
    };
    const producerCanonical = canonicalJson(producerEvent);
    const producerHash = await sha256(producerCanonical);
    expect(hash).toBe(producerHash);
  });

  it('detects top-level field differences when payload is identical', async () => {
    const baseObs = toCanonicalObservation(envelope);
    const baseHash = await sha256(canonicalJson(baseObs));

    // 1. Different occurredAt
    const diffOccurred = toCanonicalObservation({
      ...envelope,
      occurredAt: '2026-10-24T12:05:00.000Z',
    });
    const hashDiffOccurred = await sha256(canonicalJson(diffOccurred));
    expect(hashDiffOccurred).not.toBe(baseHash);

    // 2. Different sessionId
    const diffSession = toCanonicalObservation({
      ...envelope,
      sessionId: '20000000-0000-4000-8000-000000000099',
    });
    const hashDiffSession = await sha256(canonicalJson(diffSession));
    expect(hashDiffSession).not.toBe(baseHash);

    // 3. Different authorizedPublicationId
    const diffPub = toCanonicalObservation({
      ...envelope,
      authorizedPublicationId: '40000000-0000-4000-8000-000000000099',
    });
    const hashDiffPub = await sha256(canonicalJson(diffPub));
    expect(hashDiffPub).not.toBe(baseHash);

    // 4. Different producerId
    const diffProducer = toCanonicalObservation({
      ...envelope,
      producerId: '30000000-0000-4000-8000-000000000099',
    });
    const hashDiffProducer = await sha256(canonicalJson(diffProducer));
    expect(hashDiffProducer).not.toBe(baseHash);

    // 5. Different localSequence
    const diffSeq = toCanonicalObservation({
      ...envelope,
      localSequence: 2,
    });
    const hashDiffSeq = await sha256(canonicalJson(diffSeq));
    expect(hashDiffSeq).not.toBe(baseHash);
  });
});

describe('observation canonical queue schema export verification', () => {
  it('exports canonical ObservationQueueMessageSchema and ObservationConflictQueueMessageSchema', () => {
    expect(ObservationQueueMessageSchema).toBeDefined();
    expect(ObservationConflictQueueMessageSchema).toBeDefined();
    expect(ObservationQueueEnvelopeSchema).toBeDefined();
  });
});
