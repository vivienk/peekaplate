import { describe, expect, it } from 'vitest';
import {
  ApproveDishDraftRequestSchema,
  BoundedRetrievalResultSchema,
  CreateDishRevisionSchema,
  DishIntentEventSchema,
  EvidencePassageSchema,
  ExtractionDishDraftSchema,
  ExtractionDraftEvidenceSchema,
  ExtractionSourceRecordSchema,
  ExtractionSourceSegmentSchema,
  ExtractionSourceSpanSchema,
  HealthResponseSchema,
  MAX_AGGREGATE_PASSAGE_CHARS,
  MAX_PASSAGE_CHARS,
  MAX_PASSAGES,
  MenuExtractionResultSchema,
  MenuIngestionQueueMessageSchema,
  RetrievalRequestSchema,
  SourceReferenceSchema,
  StructuredDishDraftSchema,
  SubmitMenuIngestionRequestSchema,
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

  describe('S3-VIS-01 / VIS-02 menu extraction and structured draft contracts', () => {
    const validSpan = {
      segment_id: 'seg_page_1',
      start: 0,
      end: 12,
    };

    const validEvidence = {
      draft_id: 'draft:abc123def456',
      draft_index: 0,
      spans: [validSpan],
    };

    const validDishDraft = {
      name: 'Tomato Soup',
      description: 'Fresh tomatoes, onion, and basil',
      category: 'Starters',
      price_amount: '8.50',
      price_currency: 'CAD',
      ingredients: ['tomatoes', 'onion', 'basil'],
      source_id: 'src_doc_1',
      source_text: 'Tomato Soup — tomatoes, onion, basil — 8.50 CAD',
      image_id: null,
      review_warnings: ['Verify price grounding.'],
      status: 'needs_review' as const,
    };

    const validSourceRecord = {
      source_id: 'src_doc_1',
      sha256: 'a'.repeat(64),
      kind: 'pdf' as const,
      location: 'https://example.com/menu.pdf',
      retrieved_at: '2026-10-24T12:00:00.000Z',
      size_bytes: 1024,
      snapshot_base64: 'c29tZSBwZGYgY29udGVudA==',
    };

    const validSegment = {
      segment_id: 'seg_page_1',
      page_number: 1,
      method: 'pdf_native' as const,
      status: 'ready' as const,
      text: 'Tomato Soup — tomatoes, onion, basil — 8.50 CAD',
      native_text: null,
      error: null,
      warnings: [],
      metadata: {},
    };

    const validExtractionResult = {
      schema_version: 1 as const,
      pipeline_version: '2' as const,
      status: 'complete' as const,
      source: validSourceRecord,
      started_at: '2026-10-24T12:00:00.000Z',
      finished_at: '2026-10-24T12:00:05.000Z',
      extraction_mode: 'ai' as const,
      extraction_model: 'chatgpt-4o-latest',
      ocr_engine: 3 as const,
      library_versions: { pymupdf: '1.24.0' },
      configuration: { batch_pages: 10 },
      segments: [validSegment],
      drafts: [validDishDraft],
      evidence: [validEvidence],
      capture_requests: [],
      warnings: [],
      errors: [],
    };

    it('validates a complete extraction result from the merged Python producer', () => {
      const parsed = MenuExtractionResultSchema.parse(validExtractionResult);
      expect(parsed.schema_version).toBe(1);
      expect(parsed.pipeline_version).toBe('2');
      expect(parsed.status).toBe('complete');
      expect(parsed.drafts).toHaveLength(1);
      expect(parsed.drafts[0]?.name).toBe('Tomato Soup');
      expect(parsed.drafts[0]?.price_amount).toBe('8.50');
      expect(parsed.drafts[0]?.status).toBe('needs_review');
    });

    it('preserves null and unknown fields on minimal drafts without fabricating values', () => {
      const minimalDraft = {
        name: 'Daily Special',
        source_id: 'src_doc_1',
        source_text: 'Daily Special — market price',
      };
      const parsed = ExtractionDishDraftSchema.parse(minimalDraft);
      expect(parsed.description).toBeNull();
      expect(parsed.category).toBeNull();
      expect(parsed.price_amount).toBeNull();
      expect(parsed.price_currency).toBeNull();
      expect(parsed.ingredients).toBeNull();
      expect(parsed.image_id).toBeNull();
      expect(parsed.review_warnings).toEqual([]);
      expect(parsed.status).toBe('needs_review');
    });

    it('preserves zero-price and large decimal string prices without precision loss', () => {
      const draftZero = ExtractionDishDraftSchema.parse({
        ...validDishDraft,
        price_amount: '0.00',
      });
      expect(draftZero.price_amount).toBe('0.00');

      const draftThousands = ExtractionDishDraftSchema.parse({
        ...validDishDraft,
        price_amount: '1200.50',
      });
      expect(draftThousands.price_amount).toBe('1200.50');

      // Numeric input is normalized to string representation
      const draftNumeric = ExtractionDishDraftSchema.parse({
        ...validDishDraft,
        price_amount: 14.99,
      });
      expect(draftNumeric.price_amount).toBe('14.99');
    });

    it('accepts supported versions (1/2 and 2/3) and rejects unsupported versions', () => {
      expect(
        MenuExtractionResultSchema.safeParse({
          ...validExtractionResult,
          schema_version: 1,
          pipeline_version: '2',
        }).success,
      ).toBe(true);

      expect(
        MenuExtractionResultSchema.safeParse({
          ...validExtractionResult,
          schema_version: 2,
          pipeline_version: '3',
        }).success,
      ).toBe(true);

      expect(
        MenuExtractionResultSchema.safeParse({
          ...validExtractionResult,
          schema_version: 99,
        }).success,
      ).toBe(false);

      expect(
        MenuExtractionResultSchema.safeParse({
          ...validExtractionResult,
          pipeline_version: '4',
        }).success,
      ).toBe(false);
    });

    it('rejects unauthorized approval or published status on drafts', () => {
      expect(
        ExtractionDishDraftSchema.safeParse({
          ...validDishDraft,
          status: 'approved',
        }).success,
      ).toBe(false);

      expect(
        ExtractionDishDraftSchema.safeParse({
          ...validDishDraft,
          status: 'published',
        }).success,
      ).toBe(false);
    });

    it('rejects malformed source spans where start >= end or negative', () => {
      expect(
        ExtractionSourceSpanSchema.safeParse({
          segment_id: 'seg_1',
          start: 5,
          end: 5,
        }).success,
      ).toBe(false);

      expect(
        ExtractionSourceSpanSchema.safeParse({
          segment_id: 'seg_1',
          start: 10,
          end: 5,
        }).success,
      ).toBe(false);

      expect(
        ExtractionSourceSpanSchema.safeParse({
          segment_id: 'seg_1',
          start: -1,
          end: 5,
        }).success,
      ).toBe(false);
    });

    it('rejects invalid currency patterns and negative prices', () => {
      expect(
        ExtractionDishDraftSchema.safeParse({
          ...validDishDraft,
          price_currency: 'cad', // must be uppercase
        }).success,
      ).toBe(false);

      expect(
        ExtractionDishDraftSchema.safeParse({
          ...validDishDraft,
          price_currency: '$', // not ISO 3-letter
        }).success,
      ).toBe(false);

      expect(
        ExtractionDishDraftSchema.safeParse({
          ...validDishDraft,
          price_amount: '-5.00',
        }).success,
      ).toBe(false);
    });

    it('rejects extra unexpected fields under strict schema enforcement', () => {
      expect(
        ExtractionDishDraftSchema.safeParse({
          ...validDishDraft,
          unexpected_extra_field: 'unsupported',
        }).success,
      ).toBe(false);

      expect(
        ExtractionDishDraftSchema.safeParse({
          ...validDishDraft,
          model_confidence: 0.99, // unsupported confidence field
        }).success,
      ).toBe(false);
    });

    it('validates persistence-ready StructuredDishDraft structure', () => {
      const structuredDraft = {
        draft_id: 'draft:abc123def456',
        draft_index: 0,
        name: 'Tomato Soup',
        description: 'Fresh tomatoes, onion, and basil',
        category: 'Starters',
        price_amount: '8.50',
        price_currency: 'CAD',
        ingredients: ['tomatoes', 'onion', 'basil'],
        source_id: 'src_doc_1',
        source_text: 'Tomato Soup — tomatoes, onion, basil — 8.50 CAD',
        image_id: null,
        code_point_spans: [validSpan],
        utf16_spans: [validSpan],
        review_warnings: ['Verify price grounding.'],
        status: 'needs_review' as const,
      };

      const parsed = StructuredDishDraftSchema.parse(structuredDraft);
      expect(parsed.draft_id).toBe('draft:abc123def456');
      expect(parsed.price_amount).toBe('8.50');
      expect(parsed.status).toBe('needs_review');
    });

    it('validates SubmitMenuIngestionRequestSchema and ApproveDishDraftRequestSchema', () => {
      const validSubmission = {
        sourceType: 'url' as const,
        sourceUrl: 'https://example.com/menu',
        idempotencyKey: 'key_123',
      };
      expect(SubmitMenuIngestionRequestSchema.parse(validSubmission)).toEqual(validSubmission);

      expect(
        SubmitMenuIngestionRequestSchema.safeParse({
          sourceType: 'url',
          sourceUrl: 'not-a-url',
          idempotencyKey: 'key_123',
        }).success,
      ).toBe(false);

      const validApproval = {
        commandId: '0199b409-a700-7000-8000-000000000001',
        expectedVersion: 0,
      };
      expect(ApproveDishDraftRequestSchema.parse(validApproval)).toEqual(validApproval);
      expect(ApproveDishDraftRequestSchema.safeParse({}).success).toBe(false);
      expect(ApproveDishDraftRequestSchema.safeParse({ expectedVersion: 0 }).success).toBe(false);
      expect(
        ApproveDishDraftRequestSchema.safeParse({
          commandId: 'not-a-uuid',
          expectedVersion: 0,
        }).success,
      ).toBe(false);

      const validQueueMessage = {
        version: 1 as const,
        tenantId: '0199b409-a700-7000-8000-000000000001',
        jobId: '0199b409-a700-7000-8000-000000000002',
        queuedAt: new Date().toISOString(),
      };
      expect(MenuIngestionQueueMessageSchema.parse(validQueueMessage)).toEqual(validQueueMessage);

      expect(
        MenuIngestionQueueMessageSchema.safeParse({
          ...validQueueMessage,
          version: 2,
        }).success,
      ).toBe(false);

      expect(
        MenuIngestionQueueMessageSchema.safeParse({
          ...validQueueMessage,
          tenantId: 'not-a-uuid',
        }).success,
      ).toBe(false);
    });
  });
});
