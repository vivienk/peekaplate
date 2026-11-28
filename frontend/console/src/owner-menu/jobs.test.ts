import { describe, expect, it } from 'vitest';
import { type MenuJob, OwnerMenuApiError } from './api';
import { errorMessage, menuProcessingState, portionFailureMessage } from './jobs';

const job = (id: string, overrides: Partial<MenuJob> = {}): MenuJob => ({
  id,
  source_type: 'photo',
  status: 'queued',
  attempt_count: 0,
  max_attempts: 3,
  error_code: null,
  draft_count: 0,
  upload_index: Number(id.slice(1)),
  source_uploaded: true,
  created_at: '2026-11-12T10:00:00Z',
  started_at: null,
  finished_at: null,
  ...overrides,
});

describe('menuProcessingState', () => {
  it('waits for every file before processing', () => {
    const state = menuProcessingState([job('j0'), job('j1', { source_uploaded: false })]);
    expect(state).toMatchObject({ phase: 'uploading', total: 2, uploaded: 1 });
  });

  it('is processing while any job is queued or running', () => {
    const state = menuProcessingState([
      job('j0', { status: 'complete', draft_count: 4 }),
      job('j1', { status: 'running' }),
    ]);
    expect(state).toMatchObject({ phase: 'processing', finished: 1, draftCount: 4 });
  });

  it('reports ready, partial, empty and failed results distinctly', () => {
    expect(menuProcessingState([job('j0', { status: 'complete', draft_count: 3 })]).phase).toBe(
      'ready',
    );
    const partial = menuProcessingState([
      job('j0', { status: 'complete', draft_count: 3 }),
      job('j1', { status: 'failed', attempt_count: 1, error_code: 'provider_timeout' }),
    ]);
    expect(partial).toMatchObject({
      phase: 'partial',
      reviewable: ['j0'],
      retryable: ['j1'],
      errorCodes: ['provider_timeout'],
    });
    expect(menuProcessingState([job('j0', { status: 'complete', draft_count: 0 })]).phase).toBe(
      'empty',
    );
    expect(menuProcessingState([job('j0', { status: 'failed', attempt_count: 3 })])).toMatchObject({
      phase: 'failed',
      retryable: [],
    });
  });

  it('waits for missing job reads and preserves failures with no dishes', () => {
    expect(menuProcessingState([]).phase).toBe('processing');
    expect(
      menuProcessingState([
        job('j0', { status: 'complete' }),
        job('j1', { status: 'failed', error_code: 'extraction_failed' }),
      ]).phase,
    ).toBe('failed');
    expect(menuProcessingState([job('j0', { status: 'incomplete' })]).phase).toBe('failed');
  });

  it('ignores cancelled members and reports a fully cancelled menu', () => {
    expect(
      menuProcessingState([
        job('j0', { status: 'cancelled', source_uploaded: false }),
        job('j1', { status: 'complete', draft_count: 2 }),
      ]),
    ).toMatchObject({ phase: 'ready', total: 1 });
    expect(menuProcessingState([job('j0', { status: 'cancelled' })]).phase).toBe('cancelled');
  });
});

describe('errorMessage', () => {
  it('distinguishes extraction recovery from an exhausted provider allowance', () => {
    expect(errorMessage('extraction_failed')).toBe(
      'The source could not be fully extracted. Try another source or add dishes manually.',
    );
    expect(errorMessage('provider_call_budget_exhausted')).toBe(
      'The extraction limit has been reached. Add dishes manually or contact your administrator.',
    );
  });

  it('explains known codes and never shows a raw code', () => {
    expect(errorMessage('menu_file_link_required')).toContain('direct link');
    expect(errorMessage('something_new')).not.toContain('something_new');
  });
});

describe('portionFailureMessage', () => {
  it('reports client timeouts honestly as still processing and retryable', () => {
    const msg = portionFailureMessage(new OwnerMenuApiError(0, 'timeout'));
    expect(msg).toContain('still processing');
    expect(msg.toLowerCase()).toContain('try again');
    expect(msg).toContain('original photo is retained');
  });

  it('keeps processing failure copy for non-timeout failures', () => {
    const msg = portionFailureMessage(new OwnerMenuApiError(503, 'portion_processing_unavailable'));
    expect(msg).toContain('2.5D processing failed');
    expect(msg.toLowerCase()).toContain('try again');
  });
});
