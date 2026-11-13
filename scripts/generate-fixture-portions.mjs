// PR147 is an ingestion input set, not a second image-processing implementation.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const root = new URL('../frontend/diner/src/menu/fixture-assets/', import.meta.url);
const input = new URL('portion-ingestion-input.json', root);
const target = new URL('portion-fixtures.json', root);
const jobs = JSON.parse(readFileSync(input, 'utf8'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const pipeline = join(repo, 'processing/src/peekaplate_processing/portion_ingestion.py');
const pipelineHash = hash(readFileSync(pipeline));
const prefix = 'https://portion-fixtures.invalid/';

function verify(record) {
  if (
    record.pipeline_sha256 !== pipelineHash ||
    record.entries.length !== jobs.jobs.length ||
    record.source_commit !== jobs.source_commit
  )
    throw new Error('Stale ingestion export');
  for (const [index, job] of jobs.jobs.entries()) {
    const entry = record.entries[index];
    const ingestion = record.ingestions?.[index];
    if (
      !ingestion ||
      ingestion.provenance.source_sha256 !== job.sha256 ||
      ingestion.provenance.dish_id !== job.dish_id ||
      ingestion.provenance.revision_id !== job.revision_id ||
      ingestion.provenance.capture_evidence !== job.capture_evidence ||
      ingestion.review.status !== 'needs_review' ||
      ingestion.publication.eligible !== false
    ) {
      throw new Error('Stale ingestion provenance');
    }
    const bytes = readFileSync(join(repo, job.source));
    const foreground = entry.layers[1];
    const background = entry.layers[0];
    if (
      entry.dish_id !== job.dish_id ||
      entry.dish_revision_id !== job.revision_id ||
      hash(bytes) !== job.sha256 ||
      foreground.sha256 !== hash(bytes) ||
      foreground.size_bytes !== bytes.length ||
      foreground.url !== prefix + basename(job.source) ||
      background.sha256 !== hash(record.background) ||
      background.size_bytes !== Buffer.byteLength(record.background) ||
      foreground.size_bytes + background.size_bytes > 180000
    )
      throw new Error('Photo ingestion binding mismatch');
  }
}

if (process.argv.includes('--check')) {
  verify(JSON.parse(readFileSync(target, 'utf8')));
} else {
  const temporary = mkdtempSync(join(tmpdir(), 'peekaplate-photo-ingestion-'));
  try {
    const stdout = execFileSync(
      process.env.PEEKAPLATE_PROCESSING_PYTHON || 'python3',
      [
        '-m',
        'peekaplate_processing.portion_ingestion',
        '--batch',
        fileURLToPath(input),
        '--source-root',
        repo,
        '--output-root',
        temporary,
      ],
      {
        cwd: repo,
        env: { ...process.env, PYTHONPATH: join(repo, 'processing/src') },
        timeout: 120000,
        maxBuffer: 5000000,
      },
    );
    const results = JSON.parse(stdout.toString()).results;
    const entries = [];
    const ingestions = [];
    let background;
    for (const result of results) {
      const record = result.record;
      if (record.status !== 'ready' || !record.portion || record.publication.eligible)
        throw new Error('Photo needs fallback/review; cannot export a 2.5D fixture');
      const foreground = readFileSync(join(result.directory, 'dish.webp'));
      // These PR147 sources are already delivery-ready; retain their exact bytes.
      if (hash(foreground) !== hash(readFileSync(join(repo, result.source))))
        throw new Error(
          'PR147 source was transformed; review the new generated artifact before exporting',
        );
      const backdrop = readFileSync(join(result.directory, 'background.svg'), 'utf8');
      if (background !== undefined && background !== backdrop)
        throw new Error('Fixture background sizes differ');
      background = backdrop;
      const portion = record.portion;
      portion.layers[0].url = prefix + 'background.svg';
      portion.layers[1].url = prefix + basename(result.source);
      entries.push(portion);
      ingestions.push({
        asset_id: record.asset_id,
        provenance: record.provenance,
        review: record.review,
        publication: record.publication,
      });
    }
    const output = {
      source_pr: jobs.source_pr,
      source_commit: jobs.source_commit,
      preview_only: true,
      pipeline_sha256: pipelineHash,
      background,
      entries,
      ingestions,
    };
    verify(output);
    writeFileSync(target, JSON.stringify(output, null, 2) + '\n');
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
console.log(`Validated ${jobs.jobs.length} pipeline-generated dish previews.`);
