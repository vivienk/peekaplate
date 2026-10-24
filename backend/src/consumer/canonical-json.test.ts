import { describe, expect, it } from 'vitest';
import { CanonicalJsonError, canonicalizeJson, sha256Hex } from './canonical-json';

describe('canonicalizeJson', () => {
  it('orders object keys deterministically regardless of insertion order', () => {
    const objA = { z: 1, a: 2, m: { b: 3, a: 4 } };
    const objB = { a: 2, m: { a: 4, b: 3 }, z: 1 };
    expect(canonicalizeJson(objA)).toBe(canonicalizeJson(objB));
    expect(canonicalizeJson(objA)).toBe('{"a":2,"m":{"a":4,"b":3},"z":1}');
  });

  it('normalizes -0 to 0', () => {
    expect(canonicalizeJson(-0)).toBe('0');
    expect(canonicalizeJson({ x: -0 })).toBe('{"x":0}');
  });

  it('rejects NaN and Infinity', () => {
    expect(() => canonicalizeJson(NaN)).toThrow(CanonicalJsonError);
    expect(() => canonicalizeJson(Infinity)).toThrow(CanonicalJsonError);
    expect(() => canonicalizeJson(-Infinity)).toThrow(CanonicalJsonError);
  });

  it('rejects circular references', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(() => canonicalizeJson(circular)).toThrow(CanonicalJsonError);
  });

  it('handles nested arrays and objects correctly', () => {
    const data = {
      items: [
        { id: 2, name: 'two' },
        { id: 1, name: 'one' },
      ],
      active: true,
      count: 0,
      note: null,
    };
    expect(canonicalizeJson(data)).toBe(
      '{"active":true,"count":0,"items":[{"id":2,"name":"two"},{"id":1,"name":"one"}],"note":null}',
    );
  });

  it('preserves unicode characters safely', () => {
    const data = { greeting: 'こんにちは', emoji: '🍜' };
    expect(canonicalizeJson(data)).toBe('{"emoji":"🍜","greeting":"こんにちは"}');
  });
});

describe('sha256Hex', () => {
  it('computes expected SHA-256 hex vector', async () => {
    // SHA-256 of empty string is e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    const emptyHash = await sha256Hex('');
    expect(emptyHash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');

    const helloHash = await sha256Hex('hello');
    expect(helloHash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('computes identical hash for canonicalized payloads with different key orders', async () => {
    const p1 = { venue_id: 'v1', event_id: 'e1', type: 'dish_open', data: { a: 1, b: 2 } };
    const p2 = { type: 'dish_open', event_id: 'e1', data: { b: 2, a: 1 }, venue_id: 'v1' };

    const hash1 = await sha256Hex(canonicalizeJson(p1));
    const hash2 = await sha256Hex(canonicalizeJson(p2));
    expect(hash1).toBe(hash2);
  });
});
