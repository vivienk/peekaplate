import { createHash } from 'node:crypto';
import { type PublicPortion, PublicPortionSchema } from '@peekaplate/contracts';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type PreparedPortionFile = {
  relativePath: string;
  url: string;
  sha256: string;
  sizeBytes: number;
  bytes: Uint8Array;
};

export type PreparedApprovedPortion = {
  portion: PublicPortion;
  files: PreparedPortionFile[];
};

type ExportLayer = { name: string; sha256: string; size_bytes: number; base64: string };
type ApprovedExport = {
  portion: unknown;
  layers: ExportLayer[];
  approval: {
    schema_version: number;
    status: string;
    source_sha256: string;
    portion_sha256: string;
    approved_by: string;
    approved_at: string;
  };
  venueId: string;
  dishId: string;
  dishRevisionId: string;
  publicationEligible: boolean;
};

/**
 * Import exact approved Screen 9 preview bytes into a prepared public bundle.
 * The authenticated owner export MUST correspond to the database's current
 * approved dish revision. This helper never grants publication authority.
 */
export function prepareApprovedPortion(
  input: unknown,
  expected: {
    venueId: string;
    dishId: string;
    dishRevisionId: string;
    draftId: string;
    photoId: string;
    assetBaseUrl: string;
  },
): PreparedApprovedPortion {
  if (!input || typeof input !== 'object') throw new Error('Invalid approved portion export');
  const exportData = input as ApprovedExport;
  if (
    exportData.publicationEligible !== false ||
    exportData.venueId !== expected.venueId ||
    exportData.dishId !== expected.dishId ||
    exportData.dishRevisionId !== expected.dishRevisionId ||
    !Array.isArray(exportData.layers) ||
    !exportData.approval
  ) {
    throw new Error('Approved export identity or publication boundary mismatch');
  }
  const portion = PublicPortionSchema.parse(exportData.portion);
  if (portion.dish_id !== expected.draftId || portion.dish_revision_id !== expected.photoId) {
    throw new Error('Draft photo portion identity does not match the approved export');
  }
  const portionBytes = new TextEncoder().encode(JSON.stringify(portion));
  const approval = exportData.approval;
  if (
    approval.schema_version !== 1 ||
    approval.status !== 'approved' ||
    !/^[a-f0-9]{64}$/.test(approval.source_sha256) ||
    sha(portionBytes) !== approval.portion_sha256 ||
    !uuid.test(approval.approved_by) ||
    !Number.isFinite(Date.parse(approval.approved_at))
  ) {
    throw new Error('Missing or invalid owner 2.5D approval evidence');
  }
  if (exportData.layers.length !== 2 || portion.layers.length !== 2) {
    throw new Error('S09 export requires one foreground and one background');
  }
  const files: PreparedPortionFile[] = [];
  const rewrittenLayers = [];
  for (const layer of portion.layers) {
    const name = layer.depth === 0 ? 'background.svg' : 'dish.webp';
    const match = exportData.layers.find((item) => item.name === name);
    if (
      !match ||
      match.size_bytes !== layer.size_bytes ||
      match.sha256 !== layer.sha256 ||
      typeof match.base64 !== 'string' ||
      match.base64.length > 260_000 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(match.base64)
    ) {
      throw new Error('Invalid 2.5D layer export');
    }
    const bytes = new Uint8Array(Buffer.from(match.base64, 'base64'));
    if (bytes.byteLength !== layer.size_bytes || sha(bytes) !== layer.sha256) {
      throw new Error('2.5D public layer bytes do not match approved hashes');
    }
    const relativePath =
      `portions/${expected.dishId}/${expected.dishRevisionId}/${layer.sha256}/${name}`;
    const url = `${expected.assetBaseUrl}/${relativePath}`;
    files.push({
      relativePath,
      url,
      sha256: layer.sha256,
      sizeBytes: layer.size_bytes,
      bytes,
    });
    rewrittenLayers.push({ ...layer, url });
  }
  const published = PublicPortionSchema.parse({
    ...portion,
    dish_id: expected.dishId,
    dish_revision_id: expected.dishRevisionId,
    layers: rewrittenLayers,
  });
  return { portion: published, files };
}

/** Admission cannot proceed until public immutable hosting returns the exact reviewed bytes. */
export async function verifyHostedPortionFiles(
  files: readonly PreparedPortionFile[],
  doFetch: typeof fetch = fetch,
): Promise<void> {
  for (const file of files) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 10_000);
    try {
      const response = await doFetch(file.url, {
        method: 'GET',
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        signal: abort.signal,
      });
      if (!response.ok) throw new Error('Approved public portion asset not hosted');
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength !== file.sizeBytes || sha(bytes) !== file.sha256) {
        throw new Error('Hosted 2.5D asset digest differs from approved bytes');
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
