import type { SaveStorage } from './storage';

// Test helper: an in-memory stand-in for localStorage that can be told to fail like a blocked or
// full browser. Only tests import it.
export class FakeStorage implements SaveStorage {
  readonly values = new Map<string, string>();
  failReads = false;
  failWrites = false;
  writes = 0;

  getItem(key: string): string | null {
    if (this.failReads) throw new DOMException('blocked', 'SecurityError');
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) throw new DOMException('full', 'QuotaExceededError');
    this.writes += 1;
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}
