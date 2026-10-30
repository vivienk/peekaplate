// Placeholder for the shared tracking layer (S3-TRK-01), which will add consent, buffering and
// delivery behind this same signature, so callers do not change. Until then it only logs.
export type TrackPayload = Record<string, unknown>;

export function track(eventName: string, payload: TrackPayload): void {
  try {
    console.info('[track]', eventName, payload);
  } catch {
    // Fire-and-forget: a tracking failure must never break browsing, Save or Compare.
  }
}
