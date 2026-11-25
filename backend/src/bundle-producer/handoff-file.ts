import { readFile, writeFile } from 'node:fs/promises';

const REQUIRED_FIELDS = [
  'bundleUrl',
  'contentHash',
  'assetManifestHash',
  'menuRevisionId',
  'contentApprovalId',
  'assetApprovalId',
] as const;

type HandoffFile = Record<(typeof REQUIRED_FIELDS)[number], string> & {
  diagnostics: unknown[];
};

function isCompatibleHandoff(value: unknown, expected: HandoffFile): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;

  const actual = value as Record<string, unknown>;
  const keys = Object.keys(actual).sort();
  const allowedWithDiagnostics = [...REQUIRED_FIELDS, 'diagnostics'].sort();
  const allowedWithoutDiagnostics = [...REQUIRED_FIELDS].sort();

  if (
    JSON.stringify(keys) !== JSON.stringify(allowedWithDiagnostics) &&
    JSON.stringify(keys) !== JSON.stringify(allowedWithoutDiagnostics)
  ) {
    return false;
  }

  if ('diagnostics' in actual && !Array.isArray(actual.diagnostics)) return false;

  return REQUIRED_FIELDS.every((field) => actual[field] === expected[field]);
}

export async function writeHandoffImmutable(path: string, handoff: HandoffFile) {
  const bytes = `${JSON.stringify(handoff, null, 2)}\n`;

  try {
    await writeFile(path, bytes, { flag: 'wx' });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
      throw error;
    }

    let existing: unknown;
    try {
      existing = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      throw new Error(`${path} already exists with invalid handoff content; refusing to overwrite`);
    }

    if (!isCompatibleHandoff(existing, handoff)) {
      throw new Error(
        `${path} already exists with different handoff metadata; refusing to overwrite`,
      );
    }
  }
}
