import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type OpeningClockPayload, startOpeningClock } from './index';

const payload: OpeningClockPayload = {
  publication_revision_id: 'pub-1',
  dish_id: 'dish-1',
  dish_revision_id: 'rev-1',
  opening_id: 'opening-1',
};

describe('startOpeningClock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends a checkpoint after 5 active seconds', () => {
    const send = vi.fn();
    const clock = startOpeningClock(payload, { send });

    vi.advanceTimersByTime(5000);

    expect(send).toHaveBeenCalledWith(
      'dish_activity_checkpoint',
      expect.objectContaining({
        opening_id: 'opening-1',
        cumulative_active_ms: 5000,
        final: false,
      }),
    );

    clock.end();
  });

  it('pauses after 30 seconds without activity', () => {
    const send = vi.fn();
    const clock = startOpeningClock(payload, { send });

    vi.advanceTimersByTime(25000);
    const callsBeforePause = send.mock.calls.filter(
      ([name]) => name === 'dish_activity_checkpoint',
    ).length;

    vi.advanceTimersByTime(10000);

    const callsAfterPause = send.mock.calls.filter(
      ([name]) => name === 'dish_activity_checkpoint',
    ).length;
    expect(callsAfterPause).toBe(callsBeforePause);

    clock.end();
  });

  it('resumes after activity', () => {
    const send = vi.fn();
    const clock = startOpeningClock(payload, { send });

    vi.advanceTimersByTime(20000);
    clock.activity();
    vi.advanceTimersByTime(5000);

    expect(send).toHaveBeenCalledWith(
      'dish_activity_checkpoint',
      expect.objectContaining({
        cumulative_active_ms: 5000,
      }),
    );

    clock.end();
  });

  it('caps cumulative active time at 300000 ms', () => {
    const send = vi.fn();
    const clock = startOpeningClock(payload, { send });

    for (let i = 0; i < 61; i++) {
      clock.activity();
      vi.advanceTimersByTime(5000);
    }

    const calls = send.mock.calls.filter(([name]) => name === 'dish_activity_checkpoint');
    const last = calls[calls.length - 1]?.[1] as { cumulative_active_ms: number };
    expect(last.cumulative_active_ms).toBeLessThanOrEqual(300000);

    clock.end();
  });

  it('stops reporting after end()', () => {
    const send = vi.fn();
    const clock = startOpeningClock(payload, { send });

    clock.end();
    const count = send.mock.calls.length;

    vi.advanceTimersByTime(10000);

    expect(send.mock.calls.length).toBe(count);
  });
});
