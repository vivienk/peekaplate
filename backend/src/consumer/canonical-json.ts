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
 * Delegates to the authoritative canonicalJson implementation in @peekaplate/contracts (ADR 0015).
 */
export function canonicalizeJson(value: unknown): string {
  try {
    return canonicalJson(value);
  } catch (err: unknown) {
    if (err instanceof CanonicalJsonError) throw err;
    throw new CanonicalJsonError(err instanceof Error ? err.message : String(err));
  }
}

export { canonicalJson, sha256 };

/**
 * Computes deterministic SHA-256 hex digest of a string or buffer using Web Crypto API.
 */
export const sha256Hex = sha256;
