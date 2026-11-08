import { clearBrowserOutboxes } from './outbox';

const REQUESTED = 'peekaplate:tracking:withdrawal:v1';
const COMPLETED = 'peekaplate:tracking:withdrawal-completed:v1';
const stores = ['sessionStorage', 'localStorage'] as const;
let generation = 0;
let pending = false;

// These markers record deletion work, never permission to collect or a diner identity.
export function markWithdrawal(): void {
  pending = true;
  generation++;
  const token = crypto.randomUUID();
  for (const name of stores) {
    try {
      globalThis[name]?.setItem(REQUESTED, token);
    } catch {}
  }
}

export function hasPendingWithdrawal(): boolean {
  if (pending) return true;
  for (const name of stores) {
    try {
      const storage = globalThis[name];
      const requested = storage?.getItem(REQUESTED);
      if (requested && requested !== storage?.getItem(COMPLETED)) return true;
    } catch {
      return true;
    }
  }
  return false;
}

export async function clearPendingWithdrawal(): Promise<void> {
  const started = generation;
  let unreadable = false;
  const markers = stores.flatMap((name) => {
    try {
      const storage = globalThis[name];
      return [{ storage, token: storage?.getItem(REQUESTED) }];
    } catch {
      unreadable = true;
      return [];
    }
  });
  await clearBrowserOutboxes();
  if (unreadable) throw new Error('Tracking withdrawal marker is unavailable');
  // A separate completion token cannot erase a newer withdrawal from another page.
  for (const { storage, token } of markers) {
    if (token) storage?.setItem(COMPLETED, token);
  }
  if (generation === started) pending = false;
}
