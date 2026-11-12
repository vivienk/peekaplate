// FE-06.1/FE-06.2 integration harness: a local-only page (pnpm dev, http://127.0.0.1:5174/
// owner-menu-harness.html) that drives the real staging owner menu API through the same client
// and mappings the owner screens will use: upload → job status → drafts → review fields with
// evidence and unknowns → failure, retry and cancel. It is not an owner screen and is never part
// of any build (vite.config.ts and scripts/console-preview-demos.test.mjs). The staff token is
// pasted for one test session, kept in memory only, and never logged, stored or put in the URL.
import type { ExtractionReviewSessionResponse } from '@peekaplate/contracts';
import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../style.css';
import {
  createOwnerMenuClient,
  type DishDraft,
  type MenuJob,
  newCommandId,
  newIdempotencyKey,
  OwnerMenuApiError,
  type SourceType,
  sha256Hex,
} from './api';
import { allergenOutcome, dishFromReviewItem, STAFF_ALLERGY_LINE } from './dishForm';
import { evidenceExcerpts, pageProblems } from './evidence';
import { errorMessage, menuProcessingState } from './jobs';

const DEFAULT_API = 'https://peekaplate-api-staging.vxkong.workers.dev';
const POLL_MS = 5000;

type LogEntry = { at: string; text: string };

function describeError(error: unknown): string {
  if (error instanceof OwnerMenuApiError)
    return `${error.status || 'no response'} ${error.code}: ${errorMessage(error.code)}`;
  return error instanceof Error ? error.message : String(error);
}

function Harness() {
  const [apiBase, setApiBase] = useState(DEFAULT_API);
  const [venueId, setVenueId] = useState('');
  const token = useRef('');
  const [tokenSet, setTokenSet] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [menuUrl, setMenuUrl] = useState('');
  const [groupId, setGroupId] = useState('');
  const [jobs, setJobs] = useState<MenuJob[]>([]);
  const [drafts, setDrafts] = useState<Record<string, DishDraft[]>>({});
  const [session, setSession] = useState<{
    jobId: string;
    data: ExtractionReviewSessionResponse;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  // Retrying a submission must reuse its idempotency keys, so they are kept per selection.
  const keys = useRef<{ group: string; files: string[] } | null>(null);

  const note = useCallback((text: string) => {
    setLog((entries) => [{ at: new Date().toLocaleTimeString(), text }, ...entries].slice(0, 80));
  }, []);

  const client = useMemo(
    () => createOwnerMenuClient({ baseUrl: apiBase, getToken: () => token.current }),
    [apiBase],
  );
  const state = menuProcessingState(jobs);
  const ready = tokenSet && /^[0-9a-f-]{36}$/i.test(venueId.trim());

  const run = useCallback(
    async (label: string, work: () => Promise<void>) => {
      setBusy(true);
      note(`${label}…`);
      try {
        await work();
        note(`${label}: done`);
      } catch (error) {
        note(`${label}: failed (${describeError(error)})`);
      } finally {
        setBusy(false);
      }
    },
    [note],
  );

  const refreshJobs = useCallback(
    async (id = groupId) => {
      if (!id) return;
      const next = await client.listJobs(venueId.trim(), id);
      setJobs(next);
    },
    [client, groupId, venueId],
  );

  // Poll only while something is still moving; stop once every job has finished.
  useEffect(() => {
    if (!groupId || !ready) return;
    if (state.phase !== 'uploading' && state.phase !== 'processing') return;
    const timer = window.setInterval(() => {
      refreshJobs().catch((error) => note(`Job refresh failed (${describeError(error)})`));
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [groupId, ready, state.phase, refreshJobs, note]);

  const upload = () =>
    run('Upload', async () => {
      const venue = venueId.trim();
      const declared = await Promise.all(
        files.map(async (file) => ({
          sourceType: (file.type === 'application/pdf' ? 'pdf' : 'photo') as SourceType,
          sourceHash: await sha256Hex(file),
        })),
      );
      keys.current ??= { group: newIdempotencyKey(), files: files.map(() => newIdempotencyKey()) };
      const group = await client.createUploadGroup(venue, {
        idempotencyKey: keys.current.group,
        files: declared,
      });
      setGroupId(group.id);
      setJobs(group.jobs);
      note(`Group ${group.id} declared with ${group.jobs.length} job(s)`);
      for (const [index, file] of files.entries()) {
        const updated = await client.uploadGroupFile(
          venue,
          group.id,
          index,
          file,
          keys.current.files[index] ?? newIdempotencyKey(),
        );
        setJobs(updated.jobs);
        note(`File ${index + 1}/${files.length} verified by the server`);
      }
    });

  const submitUrl = () =>
    run('URL intake', async () => {
      keys.current ??= { group: newIdempotencyKey(), files: [] };
      const group = await client.submitMenuUrl(venueId.trim(), {
        url: menuUrl.trim(),
        idempotencyKey: keys.current.group,
      });
      setGroupId(group.id);
      setJobs(group.jobs);
    });

  const loadDrafts = (jobId: string) =>
    run(`Drafts for ${jobId.slice(0, 8)}`, async () => {
      const list = await client.listDrafts(venueId.trim(), { jobId });
      setDrafts((current) => ({ ...current, [jobId]: list }));
    });

  const openReview = (jobId: string) =>
    run(`Review session for ${jobId.slice(0, 8)}`, async () => {
      const data = await client.openReviewSession(venueId.trim(), jobId, newCommandId());
      setSession({ jobId, data });
    });

  const newSelection = () => {
    keys.current = null;
    setGroupId('');
    setJobs([]);
    setDrafts({});
    setSession(null);
  };

  return (
    <main style={{ maxWidth: '64rem', margin: '0 auto', padding: '1.5rem' }}>
      <p className="eyebrow">PeekaPlate · Integration harness (local only)</p>
      <h1>Owner menu staging journey</h1>
      <p className="note" role="note">
        Test page for FE-06.1, not an owner screen. Use only the synthetic staging restaurant. It
        calls the real staging API. Uploads start real extraction jobs once the queue window is
        open. Nothing is published from here.
      </p>

      <section aria-labelledby="setup">
        <h2 id="setup">Setup</h2>
        <label>
          API origin{' '}
          <input value={apiBase} onChange={(e) => setApiBase(e.target.value)} size={50} />
        </label>
        <br />
        <label>
          Venue ID <input value={venueId} onChange={(e) => setVenueId(e.target.value)} size={40} />
        </label>
        <br />
        <label>
          Staff access token (kept in memory only){' '}
          <input
            type="password"
            autoComplete="off"
            onChange={(e) => {
              token.current = e.target.value.trim();
              setTokenSet(token.current !== '');
            }}
            size={40}
          />
        </label>
      </section>

      <section aria-labelledby="input">
        <h2 id="input">1. Menu input</h2>
        <label>
          One PDF, or one to five JPEG/PNG photos{' '}
          <input
            type="file"
            multiple
            accept="application/pdf,image/jpeg,image/png"
            onChange={(e) => {
              newSelection();
              setFiles(Array.from(e.target.files ?? []));
            }}
          />
        </label>{' '}
        <button type="button" disabled={!ready || busy || files.length === 0} onClick={upload}>
          Upload
        </button>
        <br />
        <label>
          Or a menu URL{' '}
          <input
            value={menuUrl}
            onChange={(e) => {
              newSelection();
              setMenuUrl(e.target.value);
            }}
            size={50}
          />
        </label>{' '}
        <button
          type="button"
          disabled={!ready || busy || menuUrl.trim() === ''}
          onClick={submitUrl}
        >
          Submit URL
        </button>
      </section>

      <section aria-labelledby="status">
        <h2 id="status">2. Job status</h2>
        {groupId ? (
          <>
            <p role="status">
              Group {groupId}: <strong>{state.phase}</strong>, {state.uploaded}/{state.total}{' '}
              uploaded, {state.finished} finished, {state.draftCount} dish draft(s).
              {state.phase === 'processing' ? ' Refreshing every 5 seconds.' : ''}
            </p>
            {state.errorCodes.map((code) => (
              <p key={code} role="alert">
                {code}: {errorMessage(code)}
              </p>
            ))}
            <button
              type="button"
              disabled={busy}
              onClick={() => run('Refresh', () => refreshJobs())}
            >
              Refresh
            </button>{' '}
            <button
              type="button"
              disabled={busy || state.phase === 'cancelled'}
              onClick={() =>
                run('Cancel menu', async () => {
                  const group = await client.cancelGroup(venueId.trim(), groupId, newCommandId());
                  setJobs(group.jobs);
                })
              }
            >
              Cancel whole menu
            </button>
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Job</th>
                  <th>Type</th>
                  <th>Uploaded</th>
                  <th>Status</th>
                  <th>Attempts</th>
                  <th>Drafts</th>
                  <th>Error</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id}>
                    <td>{(job.upload_index ?? 0) + 1}</td>
                    <td>
                      <code>{job.id.slice(0, 8)}</code>
                    </td>
                    <td>{job.source_type}</td>
                    <td>{job.source_uploaded === false ? 'no' : 'yes'}</td>
                    <td>{job.status}</td>
                    <td>
                      {job.attempt_count}/{job.max_attempts}
                    </td>
                    <td>{job.draft_count}</td>
                    <td>{job.error_code ?? '—'}</td>
                    <td>
                      {state.retryable.includes(job.id) && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            run(`Retry ${job.id.slice(0, 8)}`, async () => {
                              await client.retryJob(venueId.trim(), job.id, newCommandId());
                              await refreshJobs();
                            })
                          }
                        >
                          Retry
                        </button>
                      )}{' '}
                      {(job.status === 'complete' || job.status === 'incomplete') && (
                        <>
                          <button type="button" disabled={busy} onClick={() => loadDrafts(job.id)}>
                            Drafts
                          </button>{' '}
                          <button type="button" disabled={busy} onClick={() => openReview(job.id)}>
                            Review
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : (
          <p>No upload yet.</p>
        )}
      </section>

      <section aria-labelledby="drafts">
        <h2 id="drafts">3. Canonical drafts</h2>
        {Object.entries(drafts).map(([jobId, list]) => (
          <div key={jobId}>
            <h3>
              Job <code>{jobId.slice(0, 8)}</code>: {list.length} draft(s)
            </h3>
            <ul>
              {list.map((draft) => (
                <li key={draft.id}>
                  {draft.name ?? <em>(no name read)</em>} · {draft.category ?? <em>no category</em>}{' '}
                  · {draft.price_amount ?? <em>no price</em>} {draft.price_currency ?? ''} ·{' '}
                  {draft.review_status}
                  {draft.review_warnings.length > 0 && ` · ${draft.review_warnings.join('; ')}`}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      <section aria-labelledby="review">
        <h2 id="review">4. Extracted fields with evidence</h2>
        {session ? (
          <>
            <p>
              Extraction <code>{session.data.extractionResult.extraction_id}</code>, status{' '}
              <strong>{session.data.extractionResult.status}</strong>, {session.data.items.length}{' '}
              candidate(s). Not published.
            </p>
            {pageProblems(session.data).map((problem) => (
              <p key={`${problem.page}-${problem.status}`} role="alert">
                Page {problem.page ?? '?'} was not read ({problem.status}
                {problem.error ? `: ${problem.error}` : ''}). Some dishes may be missing.
              </p>
            ))}
            {session.data.extractionResult.warnings.map((warning) => (
              <p key={warning}>Warning: {warning}</p>
            ))}
            {session.data.items.map((item) => {
              const form = dishFromReviewItem(session.data.extractionResult.extraction_id, item);
              const uncertain = new Set(form.source?.uncertainFields ?? []);
              const value = (key: string, text: string) =>
                text === '' || uncertain.has(key) ? (
                  <mark>{text === '' ? 'unknown' : `${text} (check)`}</mark>
                ) : (
                  text
                );
              return (
                <article
                  key={item.candidate.candidate_id}
                  style={{ border: '1px solid #ccc', padding: '0.75rem', margin: '0.75rem 0' }}
                >
                  <h3>{form.name}</h3>
                  <dl>
                    <dt>Category</dt>
                    <dd>{value('category', form.category)}</dd>
                    <dt>Price</dt>
                    <dd>
                      {value('price_amount', form.priceAmount)} {form.priceCurrency}
                      {form.source?.priceText ? ` (printed: ${form.source.priceText})` : ''}
                    </dd>
                    <dt>Description</dt>
                    <dd>{value('description', form.description)}</dd>
                    <dt>Ingredients</dt>
                    <dd>
                      {form.ingredients.status}
                      {form.ingredients.items.length > 0
                        ? `: ${form.ingredients.items.join(', ')}`
                        : ''}
                    </dd>
                    <dt>Allergens</dt>
                    <dd>
                      {allergenOutcome(form).label}. {STAFF_ALLERGY_LINE}
                    </dd>
                    <dt>Review</dt>
                    <dd>
                      {item.review.reviewStatus}, version {item.review.version}
                    </dd>
                  </dl>
                  <h4>Source evidence</h4>
                  {evidenceExcerpts(session.data, item).map((excerpt) => (
                    <blockquote key={`${excerpt.segmentId}-${excerpt.text.slice(0, 20)}`}>
                      <small>Page {excerpt.page ?? '?'}</small>
                      <pre style={{ whiteSpace: 'pre-wrap' }}>{excerpt.text}</pre>
                    </blockquote>
                  ))}
                  {item.candidate.original.review_warnings.map((warning) => (
                    <p key={warning}>
                      <small>{warning}</small>
                    </p>
                  ))}
                </article>
              );
            })}
          </>
        ) : (
          <p>Open a finished job's review session to see its dishes.</p>
        )}
      </section>

      <section aria-labelledby="log">
        <h2 id="log">5. Log</h2>
        <p>Requests and failures, newest first. The token is never shown.</p>
        <ol reversed>
          {log.map((entry, index) => (
            <li key={`${entry.at}-${index}`}>
              <time>{entry.at}</time> {entry.text}
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Harness root element is missing');
createRoot(root).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
