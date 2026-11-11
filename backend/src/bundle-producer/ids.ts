import { sha256 } from '@peekaplate/contracts';

/**
 * Deterministic, name-based UUID (RFC 9562 version 8): the first 16 bytes of
 * SHA-256("peekaplate:" + label + "\n" + parts.join("\n")) with version and variant bits set.
 * Same inputs always give the same ID, so repeat builds of unchanged approved content are
 * byte-identical and any content change yields new IDs.
 */
export async function derivedUuid(label: string, ...parts: string[]): Promise<string> {
  const digest = await sha256(`peekaplate:${label}\n${parts.join('\n')}`);
  const bytes = Array.from({ length: 16 }, (_, index) =>
    Number.parseInt(digest.slice(index * 2, index * 2 + 2), 16),
  );
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
