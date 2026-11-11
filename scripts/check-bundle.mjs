import { gzipSync } from 'node:zlib';

export function checkInitialBundle(bundle, limit = 150_000) {
  const pending = Object.values(bundle)
    .filter((part) => part.type === 'chunk' && part.isEntry)
    .map((part) => part.fileName);
  const visited = new Set();
  let gzipBytes = 0;
  while (pending.length) {
    const name = pending.pop();
    if (visited.has(name)) continue;
    visited.add(name);
    const chunk = bundle[name];
    if (chunk?.type !== 'chunk') throw new Error(`Missing initial JS chunk: ${name}`);
    for (const module of Object.keys(chunk.modules)) {
      if (
        /(?:^|[/\\])(?:three|@react-three|@sparkjsdev|@google[/\\]model-viewer)(?:[/\\]|$)/.test(
          module,
        )
      )
        throw new Error(`Renderer in initial diner graph: ${module}`);
    }
    gzipBytes += gzipSync(chunk.code).length;
    pending.push(...chunk.imports);
  }
  if (!visited.size) throw new Error('No diner entry chunk found');
  if (gzipBytes > limit)
    throw new Error(`Initial diner JS ${gzipBytes} gzip bytes exceeds ${limit}`);
  return { chunks: visited.size, gzipBytes, limit };
}

// ADR 0004 T1 total: compressed tap-loaded code + bounded manifest + decoded-input bytes.
export function checkPortionBundle(bundle, limit = 400_000) {
  const pending = Object.values(bundle)
    .filter(
      (part) =>
        part.type === 'chunk' &&
        Object.keys(part.modules).some((name) => name.endsWith('/menu/portionRenderer.ts')),
    )
    .map((part) => part.fileName);
  if (!pending.length) return null;
  const visited = new Set();
  let gzipBytes = 0;
  while (pending.length) {
    const name = pending.pop();
    if (visited.has(name)) continue;
    visited.add(name);
    const chunk = bundle[name];
    if (chunk?.type !== 'chunk') throw new Error(`Missing portion chunk: ${name}`);
    gzipBytes += gzipSync(chunk.code).length;
    pending.push(...chunk.imports);
  }
  // PublicPortionSchema caps layer bytes at 180 KB; six URLs + metadata fit in 20 KB.
  const fontBytes = Object.values(bundle)
    .filter(
      (part) =>
        part.type === 'asset' && /inter-latin-(400|600)-normal.*\.woff2$/.test(part.fileName),
    )
    .reduce((sum, part) => sum + Buffer.byteLength(part.source), 0);
  const total = gzipBytes + fontBytes + 180_000 + 20_000;
  if (total > limit) throw new Error(`T1 delivery ${total} bytes exceeds ${limit}`);
  return { gzipBytes, fontBytes, assetAndManifestBudget: 200_000, total, limit };
}

export function dinerBudget() {
  return {
    name: 'peekaplate-diner-budget',
    generateBundle(_options, bundle) {
      console.log(`Diner initial JS: ${JSON.stringify(checkInitialBundle(bundle))}`);
      console.log(`Diner T1 delivery: ${JSON.stringify(checkPortionBundle(bundle))}`);
    },
  };
}
