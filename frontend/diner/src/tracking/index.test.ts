import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isTrackingAllowed,
  newComparisonId,
  newExposureId,
  newOpeningId,
  startOpeningClock,
  track,
} from './index';

afterEach(() => vi.restoreAllMocks());

const PUBLICATION = 'a5000000-0000-4000-8000-000000000001';

describe('track()', () => {
  it('in fixture mode (the default) logs the envelope as a test event and sends nothing', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    track('menu_viewed', { publication_revision_id: PUBLICATION, entry_source: 'qr' });
    expect(info).toHaveBeenCalledOnce();
    const [label, envelope] = info.mock.calls[0] ?? [];
    expect(label).toBe('[track] test event (fixture mode, not sent)');
    expect(envelope).toMatchObject({
      schema_version: 'observation.v2',
      type: 'menu_viewed',
      publication_revision_id: PUBLICATION,
      payload: { entry_source: 'qr' },
    });
  });

  it('numbers events in order within the visit', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    track('menu_viewed', { publication_revision_id: PUBLICATION, entry_source: 'qr' });
    track('shortlist_viewed', { publication_revision_id: PUBLICATION, shortlist_size: 0 });
    const [first, second] = info.mock.calls
      .filter((call) => String(call[0]).includes('test event'))
      .map((call) => call[1] as { local_sequence: number });
    expect((second?.local_sequence ?? 0) - (first?.local_sequence ?? 0)).toBe(1);
  });

  it('drops an unknown event, warning with its name only in development builds', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    track('toast_shown', { publication_revision_id: PUBLICATION, text: 'Removed from Saved' });
    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('[track] dropped an invalid event:', 'toast_shown');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('Removed from Saved');
  });

  it('never throws, so a tracking failure cannot break the screens', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {
      throw new Error('console unavailable');
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() =>
      track('menu_viewed', { publication_revision_id: PUBLICATION, entry_source: 'qr' }),
    ).not.toThrow();
    expect(() => track('menu_viewed', null as unknown as Record<string, unknown>)).not.toThrow();
  });

  it('exports the ID helpers and the activity clock for the screens', () => {
    expect(newExposureId()).toMatch(/^[0-9a-f-]{36}$/);
    expect(newOpeningId()).not.toBe(newOpeningId());
    expect(typeof newComparisonId).toBe('function');
    expect(typeof startOpeningClock).toBe('function');
  });

  it('fixture mode ignores the consent gate, which is off by default', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    expect(isTrackingAllowed()).toBe(false);
    track('menu_viewed', { publication_revision_id: PUBLICATION, entry_source: 'qr' });
    expect(info).toHaveBeenCalledOnce();
  });
});
