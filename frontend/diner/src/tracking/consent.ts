// The consent gate (S3-TRK-01). One gate for both destinations, the canonical observation path and
// PostHog (Sai with Vivien, 3 Nov; details 4 Nov), so the two can never disagree:
// - the diner's choice, off by default, and
// - the browser's privacy signals (Do Not Track or Global Privacy Control), the same rule as the
//   existing analytics consent in packages/analytics.
// Collection is allowed only when the diner has opted in and no privacy signal is set. If the
// browser cannot be read, it counts as a privacy signal. Fixture mode does not consult the gate,
// because it never sends anything.
export type PrivacySignal = () => boolean;

export function browserPrivacySignal(): boolean {
  try {
    const nav = globalThis.navigator as
      | (Navigator & { globalPrivacyControl?: boolean })
      | undefined;
    if (!nav) return false;
    return nav.doNotTrack === '1' || nav.globalPrivacyControl === true;
  } catch {
    return true;
  }
}

let chosen = false;
let privacySignal: PrivacySignal = browserPrivacySignal;
const listeners = new Set<(allowed: boolean) => void>();

export function isTrackingAllowed(): boolean {
  try {
    return chosen && !privacySignal();
  } catch {
    return false;
  }
}

function notify() {
  const allowed = isTrackingAllowed();
  for (const listener of listeners) {
    try {
      listener(allowed);
    } catch {}
  }
}

// The diner's choice. Withdrawing it (false) stops collection and pending sends on both paths.
export function setTrackingAllowed(value: boolean): void {
  chosen = value;
  notify();
}

// Called with the gate's current answer whenever the choice changes; returns an unsubscribe.
export function onTrackingAllowedChange(listener: (allowed: boolean) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// For tests and the app shell: replace how the privacy signal is read.
export function setPrivacySignal(signal: PrivacySignal): void {
  privacySignal = signal;
  notify();
}
