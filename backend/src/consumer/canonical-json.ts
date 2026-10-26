/**
 * Canonical JSON serialization helper for deterministic hashing and comparison.
 * Formats objects with sorted keys recursively, handles primitives safely,
 * and normalizes values according to deterministic JSON rules.
 */

import { canonicalJson, sha256 } from '@peekaplate/contracts';

/**
 * Canonical JSON serialization helper for deterministic hashing and comparison.
 * Formats objects with sorted keys recursively, handles primitives safely,
 * and normalizes values according to deterministic JSON rules.
 *
 * Re-exports and aligns with the canonical implementation in @peekaplate/contracts (PR #40).
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JsonValue }
  | JsonValue[];

export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalJsonError';
  }
}

/**
 * Serializes any JSON-compatible value to a deterministic, canonical JSON string.
 * Validates inputs against non-finite numbers and circular references before canonicalizing.
 */
export function canonicalizeJson(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null) {
    return 'null';
  }

  const type = typeof value;

  if (type === 'boolean') {
    return value ? 'true' : 'false';
  }

  if (type === 'number') {
    const num = value as number;
    if (!Number.isFinite(num)) {
      throw new CanonicalJsonError('Non-finite numbers cannot be canonicalized');
    }
    return Object.is(num, -0) ? '0' : num.toString(10);
  }

  if (type === 'string') {
    return JSON.stringify(value);
  }

  if (type === 'object') {
    const obj = value as object;
    if (seen.has(obj)) {
      throw new CanonicalJsonError('Circular reference detected');
    }
    seen.add(obj);

    try {
      if (Array.isArray(obj)) {
        const elements = obj.map((el) => {
          if (el === undefined || typeof el === 'function' || typeof el === 'symbol') {
            return 'null';
          }
          return canonicalizeJson(el, seen);
        });
        return `[${elements.join(',')}]`;
      }

      // Plain object: sort keys with localeCompare to match PR #40 exactly
      const keys = Object.keys(obj).sort((a, b) => a.localeCompare(b));
      const entries: string[] = [];

      for (const key of keys) {
        const val = (obj as Record<string, unknown>)[key];
        if (val === undefined || typeof val === 'function' || typeof val === 'symbol') {
          continue;
        }
        entries.push(`${JSON.stringify(key)}:${canonicalizeJson(val, seen)}`);
      }

      return `{${entries.join(',')}}`;
    } finally {
      seen.delete(obj);
    }
  }

  throw new CanonicalJsonError(`Unsupported type: ${type}`);
}

export { canonicalJson, sha256 };

/**
 * Computes deterministic SHA-256 hex digest of a string or buffer using Web Crypto API.
 */
export const sha256Hex = sha256;
