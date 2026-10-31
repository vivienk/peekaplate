// Placeholder for the shared tracking layer (S3-TRK-01), which will add consent, buffering and
// delivery behind this same signature, so callers do not change. Until then it only logs.
export type TrackPayload = Record<string, unknown>;

export function newExposureId(): string {
  return crypto.randomUUID();
}

export function newOpeningId(): string {
  return crypto.randomUUID();
}

export function newComparisonId(): string {
  return crypto.randomUUID();
}

export function track(eventName: string, payload: TrackPayload): void {
  try {
    console.info('[track]', eventName, payload);
  } catch {
    // Fire-and-forget: a tracking failure must never break browsing, Save or Compare.
  }
}

// Interim only: TRK-01 owns checkpoint timing, idle pause and cap. Keep this until Nifemi confirms.
export type OpeningClockPayload = {
  publication_revision_id: string;
  dish_id: string;
  dish_revision_id: string;
  opening_id: string;
};

export type OpeningClock = {
  activity: () => void;
  end: () => void;
};

export function startOpeningClock(
  payload: OpeningClockPayload,
  options: { send?: typeof track } = {},
): OpeningClock {
  const send = options.send ?? track;
  const start = Date.now();
  let lastActivity = start;
  let cumulative = 0;
  let sequence = 0;
  let ended = false;
  let interval: number | undefined;

  const onVisibilityChange = () => {
    if (document.hidden) {
      lastActivity = Date.now() - 30_000;
    }
  };
  document.addEventListener('visibilitychange', onVisibilityChange);

  const checkpoint = () => {
    if (ended) return;
    const now = Date.now();
    if (now - lastActivity >= 30_000) return;
    cumulative = Math.min(300_000, cumulative + 5_000);
    sequence += 1;
    try {
      send('dish_activity_checkpoint', {
        publication_revision_id: payload.publication_revision_id,
        dish_id: payload.dish_id,
        dish_revision_id: payload.dish_revision_id,
        opening_id: payload.opening_id,
        checkpoint: sequence,
        cumulative_active_ms: cumulative,
        final: cumulative >= 300_000,
      });
    } catch {
      // Tracking must not break the detail screen.
    }
    if (cumulative >= 300_000) {
      end();
    }
  };

  interval = window.setInterval(checkpoint, 5_000);

  const activity = () => {
    if (!ended) lastActivity = Date.now();
  };

  const end = () => {
    if (ended) return;
    ended = true;
    if (interval !== undefined) window.clearInterval(interval);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    try {
      send('dish_activity_checkpoint', {
        publication_revision_id: payload.publication_revision_id,
        dish_id: payload.dish_id,
        dish_revision_id: payload.dish_revision_id,
        opening_id: payload.opening_id,
        checkpoint: sequence + 1,
        cumulative_active_ms: cumulative,
        final: true,
      });
    } catch {
      // Tracking must not break the detail screen.
    }
  };

  return { activity, end };
}
