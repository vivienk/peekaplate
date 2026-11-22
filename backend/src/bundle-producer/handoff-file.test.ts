import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeHandoffImmutable } from './handoff-file';

const handoff = {
  bundleUrl: 'https://bundles.example.test/menu.json',
  contentHash: 'content-hash-a',
  assetManifestHash: 'asset-hash-a',
  menuRevisionId: 'revision-a',
  contentApprovalId: 'content-approval-a',
  assetApprovalId: 'asset-approval-a',
  diagnostics: [{ dishId: 'dish-a', code: 'allergens_unreviewed' }],
};

async function withHandoffFile(run: (path: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'peekaplate-handoff-'));
  const path = join(directory, 'revision-a.handoff.json');

  try {
    await run(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('writeHandoffImmutable', () => {
  it('creates a new handoff file when none exists', async () => {
    await withHandoffFile(async (path) => {
      await writeHandoffImmutable(path, handoff);
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(handoff);
    });
  });

  it('accepts an existing pre-diagnostics handoff when stable metadata matches', async () => {
    await withHandoffFile(async (path) => {
      const { diagnostics: _diagnostics, ...legacyHandoff } = handoff;
      await writeFile(path, `${JSON.stringify(legacyHandoff, null, 2)}\n`);

      await expect(writeHandoffImmutable(path, handoff)).resolves.toBeUndefined();
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(legacyHandoff);
    });
  });

  it('accepts an existing handoff when only diagnostics differ', async () => {
    await withHandoffFile(async (path) => {
      await writeFile(path, `${JSON.stringify({ ...handoff, diagnostics: [] }, null, 2)}\n`);

      await expect(writeHandoffImmutable(path, handoff)).resolves.toBeUndefined();
    });
  });

  it('rejects an existing handoff with a different content hash', async () => {
    await withHandoffFile(async (path) => {
      await writeFile(
        path,
        `${JSON.stringify({ ...handoff, contentHash: 'different-hash' }, null, 2)}\n`,
      );

      await expect(writeHandoffImmutable(path, handoff)).rejects.toThrow(
        'different handoff metadata',
      );
    });
  });

  it('rejects an existing handoff with a different revision ID', async () => {
    await withHandoffFile(async (path) => {
      await writeFile(
        path,
        `${JSON.stringify({ ...handoff, menuRevisionId: 'different-revision' }, null, 2)}\n`,
      );

      await expect(writeHandoffImmutable(path, handoff)).rejects.toThrow(
        'different handoff metadata',
      );
    });
  });
});
