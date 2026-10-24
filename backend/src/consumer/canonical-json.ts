/**
 * Canonical JSON serialization helper for deterministic hashing and comparison.
 * Formats objects with sorted keys recursively, handles primitives safely,
 * and normalizes values according to deterministic JSON rules.
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
 * Serializes any JSON-compatible value to a deterministic, canonical JSON string:
 * - Object keys are sorted lexicographically (Unicode code point order).
 * - No extra whitespace.
 * - Rejects non-finite numbers (NaN, Infinity).
 * - Normalizes -0 to 0.
 * - Rejects undefined, functions, symbols, and circular references.
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
    // Normalize -0 to 0
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

      // Plain object
      const keys = Object.keys(obj).sort();
      const entries: string[] = [];

      for (const key of keys) {
        const val = (obj as Record<string, unknown>)[key];
        if (val === undefined || typeof val === 'function' || typeof val === 'symbol') {
          // Omit undefined/function properties from serialized object, matching JSON.stringify
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

/**
 * Computes deterministic SHA-256 hex digest of a string or buffer using Web Crypto API.
 * Cloudflare Workers and modern Node runtimes support crypto.subtle natively.
 */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const hashBuffer = await crypto.subtle.digest(
    'SHA-256',
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}
