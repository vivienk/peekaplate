import { describe, expect, it } from 'vitest';
import { mintExtractionCapability, readExtractionCapability } from './extraction-capability';

describe('extraction environment boundaries', () => {
  it('rejects source capabilities from the other environment even with identical keys', async () => {
    const source = {
      tenantId: '11111111-1111-4111-8111-111111111111',
      jobId: '22222222-2222-4222-8222-222222222222',
      sourceHash: 'a'.repeat(64),
    };
    const key = 'test-only-key-'.repeat(4);
    const now = Date.now();
    for (const environment of ['staging', 'production'] as const) {
      const other = environment === 'staging' ? 'production' : 'staging';
      const token = await mintExtractionCapability(source, key, now, environment);
      expect(await readExtractionCapability(token, key, now, environment)).toEqual(source);
      expect(await readExtractionCapability(token, key, now, other)).toBeNull();
    }
  });
});
