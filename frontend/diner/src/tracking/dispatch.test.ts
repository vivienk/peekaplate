import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FLUSH_EVERY_MS } from './batcher';
import type { Envelope } from './envelope';

// The shared dispatch (Sai with Vivien, 3 Nov): one track() call delivers independently to the
// canonical outbox and to PostHog, behind one consent gate with the browser privacy signals. Each
// test loads a fresh copy of the tracking module so its state never leaks between tests.
const PUBLICATION = 'a5000000-0000-4000-8000-000000000001';
const menuViewed = { publication_revision_id: PUBLICATION, entry_source: 'qr' };

async function fresh() {
  vi.resetModules();
  return import('./index');
}

function fakeSink() {
  return { capturePostHog: vi.fn(), setConsent: vi.fn() };
}

// A canonical sender that records each batch and reports every event as handled.
function recordingDeliver() {
  const batches: Envelope[][] = [];
  const deliver = vi.fn(async (batch: Envelope[]) => {
    batches.push(batch);
    return batch.map((event) => event.event_id);
  });
  return { deliver, batches, sent: () => batches.flat().map((event) => event.event_id) };
}

const flush = () => vi.advanceTimersByTimeAsync(FLUSH_EVERY_MS);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('shared dispatch', () => {
  it('fixture mode sends to neither destination', async () => {
    const tracking = await fresh();
    const sink = fakeSink();
    tracking.connectPostHog(sink);
    tracking.setTrackingAllowed(true);
    tracking.track('menu_viewed', menuViewed);
    await flush();
    expect(sink.capturePostHog).not.toHaveBeenCalled();
    expect(tracking.isLiveTracking()).toBe(false);
  });

  it('fixture mode logs nothing outside development builds', async () => {
    vi.stubEnv('DEV', false);
    try {
      const tracking = await fresh();
      const info = vi.mocked(console.info);
      tracking.track('menu_viewed', menuViewed);
      await flush();
      expect(info).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('consent denied (the default): live events reach neither destination', async () => {
    const tracking = await fresh();
    const sink = fakeSink();
    const canonical = recordingDeliver();
    tracking.enableLiveTracking(canonical.deliver);
    tracking.connectPostHog(sink);
    tracking.track('menu_viewed', menuViewed);
    await flush();
    expect(sink.capturePostHog).not.toHaveBeenCalled();
    expect(canonical.deliver).not.toHaveBeenCalled();
    expect(sink.setConsent).toHaveBeenLastCalledWith(false);
  });

  it('consent allowed: each event reaches both destinations once, with the same event_id', async () => {
    const tracking = await fresh();
    const sink = fakeSink();
    const canonical = recordingDeliver();
    tracking.enableLiveTracking(canonical.deliver);
    tracking.connectPostHog(sink);
    tracking.setTrackingAllowed(true);
    tracking.track('menu_viewed', menuViewed);
    await flush();
    expect(sink.capturePostHog).toHaveBeenCalledOnce();
    const [type, payload, ids] = sink.capturePostHog.mock.calls[0] ?? [];
    expect(type).toBe('menu_viewed');
    // Only the payload goes to PostHog: no session, producer or publication from the envelope.
    expect(payload).toEqual({ entry_source: 'qr' });
    expect(ids).toEqual({ eventId: canonical.sent()[0] });
    expect(canonical.sent()).toHaveLength(1);
  });

  it("keeps PostHog's consent in step with the gate", async () => {
    const tracking = await fresh();
    const sink = fakeSink();
    tracking.connectPostHog(sink);
    tracking.setTrackingAllowed(true);
    tracking.setTrackingAllowed(false);
    expect(sink.setConsent.mock.calls.map(([allowed]) => allowed)).toEqual([false, true, false]);
  });

  it('a privacy signal blocks both destinations, even with consent given', async () => {
    const tracking = await fresh();
    const sink = fakeSink();
    const canonical = recordingDeliver();
    tracking.enableLiveTracking(canonical.deliver);
    tracking.connectPostHog(sink);
    tracking.setPrivacySignal(() => true);
    tracking.setTrackingAllowed(true);
    expect(tracking.isTrackingAllowed()).toBe(false);
    expect(sink.setConsent).toHaveBeenLastCalledWith(false);
    tracking.track('menu_viewed', menuViewed);
    await flush();
    expect(sink.capturePostHog).not.toHaveBeenCalled();
    expect(canonical.deliver).not.toHaveBeenCalled();
  });

  it('treats an unreadable privacy signal as set', async () => {
    const tracking = await fresh();
    tracking.setPrivacySignal(() => {
      throw new Error('navigator unavailable');
    });
    tracking.setTrackingAllowed(true);
    expect(tracking.isTrackingAllowed()).toBe(false);
  });

  it('withdrawal stops new capture and pending canonical sends, and never backfills', async () => {
    const tracking = await fresh();
    const sink = fakeSink();
    const canonical = recordingDeliver();
    tracking.enableLiveTracking(canonical.deliver);
    tracking.connectPostHog(sink);
    tracking.setTrackingAllowed(true);
    tracking.track('menu_viewed', menuViewed);
    tracking.track('menu_viewed', menuViewed);
    tracking.setTrackingAllowed(false);
    tracking.track('menu_viewed', menuViewed);
    await flush();
    expect(canonical.deliver).not.toHaveBeenCalled();
    expect(sink.capturePostHog).toHaveBeenCalledTimes(2);
    expect(sink.setConsent).toHaveBeenLastCalledWith(false);

    // Consenting again sends only what is collected from now on.
    tracking.setTrackingAllowed(true);
    tracking.track('menu_viewed', menuViewed);
    await flush();
    expect(canonical.sent()).toHaveLength(1);
    expect(sink.capturePostHog).toHaveBeenCalledTimes(3);
  });

  it('canonical retries never capture to PostHog again', async () => {
    const tracking = await fresh();
    const sink = fakeSink();
    let attempts = 0;
    const deliver = vi.fn(async (batch: Envelope[]) => {
      attempts += 1;
      if (attempts < 3) throw new Error('503');
      return batch.map((event) => event.event_id);
    });
    tracking.enableLiveTracking(deliver);
    tracking.connectPostHog(sink);
    tracking.setTrackingAllowed(true);
    tracking.track('menu_viewed', menuViewed);
    await flush();
    await flush();
    await flush();
    expect(deliver).toHaveBeenCalledTimes(3);
    expect(sink.capturePostHog).toHaveBeenCalledOnce();
  });

  it('a PostHog failure never stops canonical delivery or throws', async () => {
    const tracking = await fresh();
    const canonical = recordingDeliver();
    tracking.enableLiveTracking(canonical.deliver);
    tracking.connectPostHog({
      capturePostHog: () => {
        throw new Error('PostHog down');
      },
      setConsent: () => {
        throw new Error('PostHog down');
      },
    });
    tracking.setTrackingAllowed(true);
    expect(() => tracking.track('menu_viewed', menuViewed)).not.toThrow();
    await flush();
    expect(canonical.sent()).toHaveLength(1);
  });

  it('a canonical failure never stops PostHog capture', async () => {
    const tracking = await fresh();
    const sink = fakeSink();
    tracking.enableLiveTracking(async () => {
      throw new Error('canonical down');
    });
    tracking.connectPostHog(sink);
    tracking.setTrackingAllowed(true);
    tracking.track('menu_viewed', menuViewed);
    await flush();
    expect(sink.capturePostHog).toHaveBeenCalledOnce();
  });

  it('an invalid event reaches neither destination', async () => {
    const tracking = await fresh();
    const sink = fakeSink();
    const canonical = recordingDeliver();
    tracking.enableLiveTracking(canonical.deliver);
    tracking.connectPostHog(sink);
    tracking.setTrackingAllowed(true);
    tracking.track('menu_viewed', { ...menuViewed, entry_source: 'table_qr' });
    await flush();
    expect(sink.capturePostHog).not.toHaveBeenCalled();
    expect(canonical.deliver).not.toHaveBeenCalled();
  });

  it('disconnecting stops PostHog capture and consent updates', async () => {
    const tracking = await fresh();
    const sink = fakeSink();
    tracking.enableLiveTracking(recordingDeliver().deliver);
    const disconnect = tracking.connectPostHog(sink);
    tracking.setTrackingAllowed(true);
    disconnect();
    const updates = sink.setConsent.mock.calls.length;
    tracking.setTrackingAllowed(false);
    tracking.setTrackingAllowed(true);
    tracking.track('menu_viewed', menuViewed);
    expect(sink.capturePostHog).not.toHaveBeenCalled();
    expect(sink.setConsent).toHaveBeenCalledTimes(updates);
  });
});
