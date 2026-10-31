import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHECKPOINT_EVERY_MS,
  IDLE_PAUSE_MS,
  OPENING_CAP_MS,
  type PageVisibility,
  startOpeningClock,
} from './activity-clock';

const opening = {
  publication_revision_id: 'a5000000-0000-4000-8000-000000000001',
  dish_id: 'a1000000-0000-4000-8000-000000000001',
  dish_revision_id: 'a2000000-0000-4000-8000-000000000001',
  opening_id: 'a8000000-0000-4000-8000-000000000001',
};

function fakeVisibility() {
  let visible = true;
  const changes: (() => void)[] = [];
  const hides: (() => void)[] = [];
  const page: PageVisibility = {
    isVisible: () => visible,
    onChange: (fn) => {
      changes.push(fn);
      return () => changes.splice(changes.indexOf(fn), 1);
    },
    onPageHide: (fn) => {
      hides.push(fn);
      return () => hides.splice(hides.indexOf(fn), 1);
    },
  };
  return {
    page,
    setVisible(value: boolean) {
      visible = value;
      for (const fn of [...changes]) fn();
    },
    leavePage() {
      for (const fn of [...hides]) fn();
    },
  };
}

function start() {
  const send = vi.fn();
  const visibility = fakeVisibility();
  const clock = startOpeningClock(opening, { send, visibility: visibility.page });
  const checkpoints = () =>
    send.mock.calls.map(([name, payload]) => {
      expect(name).toBe('dish_activity_checkpoint');
      return [payload.active_ms, payload.final];
    });
  return { clock, send, visibility, checkpoints };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('activity clock', () => {
  it('sends a cumulative checkpoint every 5 active seconds with the opening fields', () => {
    const { clock, send, checkpoints } = start();
    for (let n = 0; n < 3; n++) {
      vi.advanceTimersByTime(4000);
      clock.activity();
    }
    vi.advanceTimersByTime(4000);
    expect(checkpoints()).toEqual([
      [CHECKPOINT_EVERY_MS, false],
      [2 * CHECKPOINT_EVERY_MS, false],
      [3 * CHECKPOINT_EVERY_MS, false],
    ]);
    expect(send.mock.calls[0]?.[1]).toEqual({ ...opening, active_ms: 5000, final: false });
  });

  it('pauses 30 seconds after the last input, with a pause checkpoint, and resumes on input', () => {
    const { clock, checkpoints } = start();
    vi.advanceTimersByTime(IDLE_PAUSE_MS + 60_000);
    // 30 active seconds, then paused: six 5-second checkpoints and nothing while idle.
    expect(checkpoints().map(([ms]) => ms)).toEqual([5000, 10000, 15000, 20000, 25000, 30000]);
    clock.activity();
    vi.advanceTimersByTime(5000);
    expect(checkpoints().at(-1)).toEqual([35000, false]);
  });

  it('sends a pause checkpoint for time since the last one', () => {
    const { clock, checkpoints } = start();
    vi.advanceTimersByTime(3000);
    clock.activity();
    vi.advanceTimersByTime(IDLE_PAUSE_MS);
    // Active from 0 to 33 s: checkpoints at 5..30 s, then the pause at 33 s.
    expect(checkpoints().at(-1)).toEqual([33000, false]);
  });

  it('does not count hidden time and pauses when the tab is hidden', () => {
    const { clock, visibility, checkpoints } = start();
    vi.advanceTimersByTime(2000);
    visibility.setVisible(false);
    expect(checkpoints()).toEqual([[2000, false]]);
    vi.advanceTimersByTime(60_000);
    expect(checkpoints()).toEqual([[2000, false]]);
    visibility.setVisible(true);
    clock.activity();
    // The next checkpoint comes 5 active seconds after the previous one (the pause at 2 s).
    vi.advanceTimersByTime(4999);
    expect(checkpoints()).toEqual([[2000, false]]);
    vi.advanceTimersByTime(1);
    expect(checkpoints().at(-1)).toEqual([7000, false]);
  });

  it('stops adding time at the 300000 ms cap per opening', () => {
    const { clock, checkpoints } = start();
    for (let t = 0; t < OPENING_CAP_MS + 60_000; t += 10_000) {
      vi.advanceTimersByTime(10_000);
      clock.activity();
    }
    const values = checkpoints().map(([ms]) => ms as number);
    expect(Math.max(...values)).toBe(OPENING_CAP_MS);
    expect(values.filter((ms) => ms === OPENING_CAP_MS)).toHaveLength(1);
    clock.end();
    expect(checkpoints().at(-1)).toEqual([OPENING_CAP_MS, true]);
  });

  it('sends one final checkpoint when the opening ends, then nothing more', () => {
    const { clock, checkpoints } = start();
    vi.advanceTimersByTime(7000);
    clock.end();
    expect(checkpoints()).toEqual([
      [5000, false],
      [7000, true],
    ]);
    clock.end();
    clock.activity();
    vi.advanceTimersByTime(60_000);
    expect(checkpoints()).toHaveLength(2);
  });

  it('ends with a final checkpoint when the page is left', () => {
    const { visibility, checkpoints } = start();
    vi.advanceTimersByTime(1500);
    visibility.leavePage();
    expect(checkpoints()).toEqual([[1500, true]]);
  });

  // Browsers can fire timers late (battery saving, a busy device). The limits must hold even when
  // the clock only finds out at the next input, so time here runs ahead of the timers.
  describe('when timers fire late', () => {
    function startWithManualTime() {
      const time = { t: 0 };
      const send = vi.fn();
      const clock = startOpeningClock(opening, {
        send,
        visibility: fakeVisibility().page,
        now: () => time.t,
      });
      const last = () => send.mock.calls.at(-1)?.[1];
      return { time, clock, last };
    }

    it('still stops at the 300000 ms cap', () => {
      const { time, clock, last } = startWithManualTime();
      // 7-second steps overshoot 300000 (43 x 7 s = 301 s) unless the cap holds.
      for (let n = 0; n < 50; n++) {
        time.t += 7_000;
        clock.activity();
      }
      clock.end();
      expect(last()).toMatchObject({ active_ms: OPENING_CAP_MS, final: true });
    });

    it('still pauses 30 seconds after the last input', () => {
      const { time, clock, last } = startWithManualTime();
      time.t = 100_000;
      clock.end();
      expect(last()).toMatchObject({ active_ms: IDLE_PAUSE_MS, final: true });
    });
  });

  it('keeps working when sending throws', () => {
    const { clock, send } = start();
    send.mockImplementation(() => {
      throw new Error('tracking down');
    });
    expect(() => {
      vi.advanceTimersByTime(12_000);
      clock.end();
    }).not.toThrow();
  });
});
