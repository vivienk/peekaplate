import type { ExtractionReviewSessionResponse } from '@peekaplate/contracts';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { AddMenuLink } from '../onboarding/AddMenuLink';
import { ChooseMenuSource, type MenuSource } from '../onboarding/ChooseMenuSource';
import { MenuProcessing } from '../onboarding/MenuProcessing';
import { menuFileKind } from '../onboarding/menu-source';
import { OnboardingLayout } from '../onboarding/OnboardingLayout';
import { type MenuUpload, UploadMenu } from '../onboarding/UploadMenu';
import { Btn, Icon } from '../owner-dashboard/controls';
import { MenuTable } from '../owner-dashboard/menu-presentation';
import {
  createOwnerMenuClient,
  type DishDraft,
  type MenuJob,
  newCommandId,
  newIdempotencyKey,
  OwnerMenuApiError,
  type OwnerMenuClient,
  sha256Hex,
} from '../owner-menu/api';
import { DishEditor } from '../owner-menu/DishEditor';
import {
  type DishForm,
  dishFromManualDraft,
  dishFromReviewItem,
  emptyManualDish,
  manualSaveCommand,
  reviewCorrection,
} from '../owner-menu/dishForm';
import { evidenceExcerpts } from '../owner-menu/evidence';
import { errorMessage } from '../owner-menu/jobs';
import { Button } from '../ui';
import { FirstDashboardContent } from './FirstDashboard';
import { OwnerPublish } from './OwnerPublish';
import '../onboarding/onboarding.css';

type Active = { client: OwnerMenuClient; controller: AbortController };
type Editing = {
  draft: DishDraft | null;
  id: string;
  form: DishForm;
  saved: string;
  session?: ExtractionReviewSessionResponse;
};
type FileSelection = { files: File[]; groupKey: string; fileKeys: string[]; groupId?: string };

// Dropped files may lack a MIME. Declare the UI-accepted kind without changing bytes;
// the server still verifies the actual signature and manifest hash.
function typedMenuFile(file: File): File {
  const kind = menuFileKind(file);
  if (file.type || !kind) return file;
  const type =
    kind === 'pdf' ? 'application/pdf' : /\.png$/i.test(file.name) ? 'image/png' : 'image/jpeg';
  return new File([file], file.name, { type, lastModified: file.lastModified });
}

export function OwnerMenuWorkspace({
  apiBase,
  actorId,
  venueId,
  restaurantName,
  canPublish,
  section,
  navigation,
  getAccessToken,
  onAccessFailure,
  onDirtyChange,
  renderShell,
  accountActions,
}: {
  apiBase: string;
  actorId: string;
  venueId: string;
  restaurantName: string;
  canPublish: boolean;
  section: 'overview' | 'menu';
  navigation: number;
  getAccessToken: () => Promise<string | null>;
  onAccessFailure: (kind: 'signed_out' | 'denied') => void;
  onDirtyChange: (dirty: boolean) => void;
  renderShell: (content: ReactNode) => ReactNode;
  accountActions: ReactNode;
}) {
  const runtime = useRef<Active | null>(null);
  const running = useRef(false);
  const commands = useRef(new Map<string, string>());
  const selection = useRef<FileSelection | null>(null);
  const readGeneration = useRef(0);
  const urlAttempt = useRef<{ url: string; key: string } | null>(null);
  const photoAttempt = useRef<{ file: File; key: string } | null>(null);
  const photoPicker = useRef<HTMLInputElement>(null);
  const [jobs, setJobs] = useState<MenuJob[]>([]);
  const [drafts, setDrafts] = useState<DishDraft[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [view, setRawView] = useState<
    'overview' | 'sources' | 'url' | 'photo' | 'pdf' | 'list' | 'edit' | 'processing' | 'publish'
  >('overview');
  const viewGeneration = useRef(0);
  const setView = useCallback((next: typeof view) => {
    viewGeneration.current++;
    setRawView(next);
  }, []);
  const [processingIds, setProcessingIds] = useState<string[]>([]);
  const [uploads, setUploads] = useState<MenuUpload[]>([]);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [pendingPhoto, setPendingPhoto] = useState<File | null>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);

  const current = useCallback(
    (active: Active) => runtime.current === active && !active.controller.signal.aborted,
    [],
  );
  const command = (kind: string, value: unknown) => {
    const key = JSON.stringify([kind, value]);
    let id = commands.current.get(key);
    if (!id) {
      id = newCommandId();
      commands.current.set(key, id);
    }
    return id;
  };
  const failure = useCallback(
    (reason: unknown) => {
      if (reason instanceof OwnerMenuApiError && reason.code === 'aborted') return;
      if (reason instanceof OwnerMenuApiError && (reason.status === 401 || reason.status === 403)) {
        setDrafts([]);
        setJobs([]);
        setEditing(null);
        setLoaded(false);
        onAccessFailure(reason.status === 401 ? 'signed_out' : 'denied');
      } else
        setError(
          reason instanceof OwnerMenuApiError
            ? reason.status === 409
              ? 'Saved data changed. Reload the workspace before trying again; your unsaved fields stay here.'
              : errorMessage(reason.code)
            : 'We could not complete that request. Try again.',
        );
    },
    [onAccessFailure],
  );
  const load = useCallback(
    async (active: Active) => {
      const generation = ++readGeneration.current;
      const [nextJobs, nextDrafts] = await Promise.all([
        active.client.listJobs(venueId),
        active.client.listDrafts(venueId),
      ]);
      if (!current(active) || generation !== readGeneration.current) return;
      setJobs(nextJobs);
      setDrafts(nextDrafts);
      setLoaded(true);
    },
    [venueId, current],
  );
  useEffect(() => {
    void actorId;
    const controller = new AbortController();
    const active = {
      controller,
      client: createOwnerMenuClient({
        baseUrl: apiBase,
        getToken: getAccessToken,
        signal: controller.signal,
      }),
    };
    runtime.current = active;
    void load(active).catch((reason) => {
      if (current(active)) failure(reason);
    });
    return () => {
      controller.abort();
      if (runtime.current === active) runtime.current = null;
    };
  }, [actorId, apiBase, getAccessToken, load, current, failure]);
  useEffect(() => {
    setView(section === 'menu' ? 'list' : 'overview');
    setEditing(null);
    setPendingPhoto(null);
  }, [section, navigation, setView]);

  // Private images use authenticated byte reads, never bearer tokens in image URLs.
  useEffect(() => {
    const active = runtime.current;
    const id = editing?.form.photoId;
    let objectUrl: string | null = null;
    let disposed = false;
    setPhotoUrl(null);
    if (pendingPhoto) {
      objectUrl = URL.createObjectURL(pendingPhoto);
      setPhotoUrl(objectUrl);
    } else if (active && id && editing)
      void active.client
        .readDraftPhoto(venueId, editing.id, id)
        .then((blob) => {
          if (disposed || !current(active)) return;
          objectUrl = URL.createObjectURL(blob);
          setPhotoUrl(objectUrl);
        })
        .catch((reason) => {
          if (!disposed && current(active)) failure(reason);
        });
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [pendingPhoto, editing?.form.photoId, editing?.id, venueId, current, failure]);
  const dirty = Boolean(
    editing && (JSON.stringify(editing.form) !== editing.saved || pendingPhoto),
  );
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const run = async (work: (active: Active) => Promise<void>) => {
    const active = runtime.current;
    if (!active || running.current) return;
    running.current = true;
    readGeneration.current++;
    setBusy(true);
    setError(null);
    setNotice('');
    try {
      await work(active);
      return current(active);
    } catch (reason) {
      if (current(active)) failure(reason);
      return false;
    } finally {
      running.current = false;
      if (current(active)) setBusy(false);
    }
  };
  const reload = () => void run((active) => load(active));
  useEffect(() => {
    if (view !== 'processing') return;
    const active = runtime.current;
    if (!active) return;
    let reading = false;
    const timer = window.setInterval(() => {
      if (!reading && !running.current && current(active)) {
        reading = true;
        void load(active)
          .catch((reason) => {
            if (current(active)) failure(reason);
          })
          .finally(() => {
            reading = false;
          });
      }
    }, 5000);
    return () => window.clearInterval(timer);
  }, [view, load, current, failure]);
  useEffect(() => {
    const selected = jobs.filter((job) => processingIds.includes(job.id));
    if (
      view === 'processing' &&
      selected.length &&
      selected.every((job) => !['queued', 'running'].includes(job.status))
    ) {
      setView('list');
      setNotice('Processing status updated. Review the saved dishes and any failed sources below.');
    }
  }, [view, jobs, processingIds, setView]);
  const editManual = (draft?: DishDraft) => {
    const form = draft ? dishFromManualDraft(draft) : emptyManualDish();
    setEditing({
      id: draft?.id ?? crypto.randomUUID(),
      draft: draft ?? null,
      form,
      saved: JSON.stringify(form),
    });
    setPendingPhoto(null);
    setView('edit');
  };
  const nextSource = (next?: MenuSource) => {
    selection.current = null;
    setUploads([]);
    if (next === 'manual') editManual();
    else setView(next === 'upload' ? 'photo' : (next ?? 'list'));
  };
  const importUrl = (url: string) =>
    void run(async (active) => {
      const generation = viewGeneration.current;
      if (urlAttempt.current?.url !== url) urlAttempt.current = { url, key: newIdempotencyKey() };
      const group = await active.client.submitMenuUrl(venueId, {
        url,
        idempotencyKey: urlAttempt.current.key,
      });
      if (current(active)) setProcessingIds(group.jobs.map((job) => job.id));
      await load(active);
      if (current(active)) {
        urlAttempt.current = null;
        if (generation === viewGeneration.current) {
          setView('processing');
        }
      }
    });
  const uploadFiles = (files: File[], retry = false) =>
    void run(async (active) => {
      files = files.map(typedMenuFile);
      if (
        files.some((file) => !['application/pdf', 'image/jpeg', 'image/png'].includes(file.type))
      ) {
        setError('Choose a PDF, JPEG or PNG menu source.');
        return;
      }
      if (!retry)
        selection.current = {
          files,
          groupKey: newIdempotencyKey(),
          fileKeys: files.map(() => newIdempotencyKey()),
        };
      const selected = selection.current;
      if (!selected) return;
      const rows: MenuUpload[] = selected.files.map((file, index) => ({
        id: String(index),
        name: file.name,
        size: file.size,
        kind: file.type === 'application/pdf' ? 'pdf' : 'image',
        status: 'uploading',
      }));
      setUploads(rows);
      try {
        const hashes = await Promise.all(selected.files.map(sha256Hex));
        const group = await active.client.createUploadGroup(venueId, {
          idempotencyKey: selected.groupKey,
          files: selected.files.map((file, index) => ({
            sourceType: file.type === 'application/pdf' ? 'pdf' : 'photo',
            sourceHash: hashes[index]!,
          })),
        });
        selected.groupId = group.id;
        if (current(active)) setProcessingIds(group.jobs.map((job) => job.id));
        for (const [index, file] of selected.files.entries()) {
          await active.client.uploadGroupFile(
            venueId,
            group.id,
            index,
            file,
            selected.fileKeys[index]!,
          );
          if (!current(active)) return;
          rows[index] = { ...rows[index]!, status: 'uploaded' };
          setUploads([...rows]);
        }
        await load(active);
      } catch (reason) {
        if (current(active))
          setUploads(
            rows.map((row) => (row.status === 'uploaded' ? row : { ...row, status: 'failed' })),
          );
        throw reason;
      }
    });
  const openDraft = (draft: DishDraft) => {
    if (draft.origin === 'manual') {
      editManual(draft);
      return;
    }
    if (!draft.job_id) return;
    void run(async (active) => {
      const generation = viewGeneration.current;
      const session = await active.client.openReviewSession(
        venueId,
        draft.job_id!,
        command('review-session', draft.job_id),
      );
      const item = session.items.find(
        (value) => value.candidate.candidate_id === draft.candidate_id,
      );
      if (!item) throw new Error('candidate missing');
      if (!current(active) || generation !== viewGeneration.current) return;
      const form = dishFromReviewItem(session.extractionResult.extraction_id, item);
      setEditing({ id: draft.id, draft, form, saved: JSON.stringify(form), session });
      setPendingPhoto(null);
      setView('edit');
    });
  };
  const reviseFiles = async (files: File[]) => {
    const selected = selection.current;
    const generation = viewGeneration.current;
    if (busy || !selected) return;
    const cancelled = await run(async (active) => {
      if (selected.groupId)
        await active.client.cancelGroup(
          venueId,
          selected.groupId,
          command('cancel-group', selected.groupId),
        );
      await load(active);
    });
    if (!cancelled || generation !== viewGeneration.current) return;
    selection.current = null;
    setUploads([]);
    if (files.length) uploadFiles(files);
  };
  const saveDish = () =>
    void run(async (active) => {
      if (!editing) return;
      if (editing.form.origin === 'manual') {
        let saved = editing.draft;
        const input = manualSaveCommand(editing.form, saved?.draft_version ?? 0, newCommandId());
        input.commandId = command('dish', [editing.id, input.expectedVersion, input.fields]);
        saved = await active.client.saveManualDraft(venueId, editing.id, input);
        if (!current(active)) return;
        let form = dishFromManualDraft(saved);
        setEditing({ ...editing, draft: saved, form, saved: JSON.stringify(form) });
        if (pendingPhoto) {
          if (photoAttempt.current?.file !== pendingPhoto)
            photoAttempt.current = { file: pendingPhoto, key: newIdempotencyKey() };
          const photo = await active.client.uploadDraftPhoto(
            venueId,
            editing.id,
            pendingPhoto,
            photoAttempt.current.key,
          );
          form = { ...form, photoId: photo.id };
          const attach = manualSaveCommand(
            form,
            saved.draft_version!,
            command('attach-photo', [editing.id, saved.draft_version, photo.id]),
          );
          saved = await active.client.saveManualDraft(venueId, editing.id, attach);
          if (!current(active)) return;
          form = dishFromManualDraft(saved);
          setPendingPhoto(null);
          setEditing({ ...editing, draft: saved, form, saved: JSON.stringify(form) });
        }
      } else if (editing.session && editing.form.source) {
        const session = editing.session;
        const item = session.items.find(
          (value) => value.candidate.candidate_id === editing.form.source?.candidateId,
        );
        if (!item) return;
        const corrected = reviewCorrection(item, editing.form);
        if (corrected) {
          const input = {
            expectedVersion: item.review.version,
            action: 'correct' as const,
            corrected,
          };
          const updated = await active.client.reviewCandidate(
            venueId,
            session.extractionResult.extraction_id,
            item.candidate.candidate_id,
            {
              ...input,
              commandId: command('correction', [
                session.extractionResult.extraction_id,
                item.candidate.candidate_id,
                input,
              ]),
            },
          );
          if (!current(active)) return;
          const form = dishFromReviewItem(session.extractionResult.extraction_id, updated);
          setEditing({
            ...editing,
            form,
            saved: JSON.stringify(form),
            session: {
              ...session,
              items: session.items.map((value) =>
                value.candidate.candidate_id === updated.candidate.candidate_id ? updated : value,
              ),
            },
          });
        }
      }
      await load(active);
      if (current(active)) setNotice('Draft saved. This has not approved or published your menu.');
    });

  if (!loaded)
    return renderShell(
      <section>
        <h1>Opening your menu workspace</h1>
        <p role={error ? 'alert' : 'status'}>{error ?? 'Loading saved sources and dishes…'}</p>
        {error && <Button onClick={reload}>Try again</Button>}
      </section>,
    );
  const activeJobs = jobs.filter((job) => ['queued', 'running'].includes(job.status));
  const item = editing?.session?.items.find(
    (value) => value.candidate.candidate_id === editing.form.source?.candidateId,
  );
  const content =
    view === 'sources' ? (
      <ChooseMenuSource onContinue={nextSource} onBack={() => setView('list')} />
    ) : view === 'url' ? (
      <AddMenuLink importing={busy} onImport={importUrl} onBack={() => setView('sources')} />
    ) : view === 'photo' || view === 'pdf' ? (
      <>
        <UploadMenu
          files={uploads}
          onAdd={(files) =>
            selection.current?.groupId
              ? void reviseFiles([...selection.current.files, ...files])
              : uploadFiles(files)
          }
          onReplace={(id, file) => {
            const selected = selection.current;
            if (selected)
              void reviseFiles(
                selected.files.map((old, index) => (String(index) === id ? file : old)),
              );
          }}
          onRemove={(id) => {
            const selected = selection.current;
            if (selected)
              void reviseFiles(selected.files.filter((_, index) => String(index) !== id));
          }}
          onRetry={() => {
            if (selection.current) uploadFiles(selection.current.files, true);
          }}
          onContinue={() => setView('processing')}
          onBack={() => setView('sources')}
        />
      </>
    ) : view === 'processing' ? (
      <>
        <MenuProcessing
          state="processing"
          step={
            jobs
              .filter((job) => processingIds.includes(job.id))
              .some((job) => job.status === 'running')
              ? 'Processing the uploaded source'
              : 'Queued for processing'
          }
          onCancel={() =>
            void run(async (active) => {
              const generation = viewGeneration.current;
              for (const job of jobs.filter(
                (job) =>
                  processingIds.includes(job.id) && ['queued', 'running'].includes(job.status),
              ))
                await active.client.cancelJob(venueId, job.id, command('cancel', job.id));
              await load(active);
              if (current(active) && generation === viewGeneration.current) setView('list');
            })
          }
          onTryAnother={() => setView('sources')}
        />
        <Button onClick={() => setView('list')}>View saved dishes</Button>
      </>
    ) : view === 'edit' && editing ? (
      <>
        <DishEditor
          value={editing.form}
          categories={drafts.map((draft) => draft.category ?? '').filter(Boolean)}
          photo={
            editing.form.origin === 'manual' ? (
              <>
                <div className={`s09-photo${photoUrl ? ' has' : ''}`}>
                  {photoUrl ? (
                    <img src={photoUrl} alt="Private draft dish" />
                  ) : (
                    <span>No photo yet</span>
                  )}
                </div>
                <Btn
                  kind="outlined"
                  size="md"
                  disabled={busy}
                  onClick={() => photoPicker.current?.click()}
                >
                  {photoUrl ? 'Replace photo' : 'Upload photo'}
                </Btn>
                <input
                  id="live-dish-photo"
                  ref={photoPicker}
                  aria-label="Dish photo"
                  className="pp-onboard-hidden-input"
                  type="file"
                  accept="image/jpeg,image/png"
                  disabled={busy}
                  onChange={(event) => {
                    const selectedFile = event.target.files?.[0];
                    const file = selectedFile ? typedMenuFile(selectedFile) : undefined;
                    if (
                      file &&
                      file.size > 0 &&
                      file.size <= 12_000_000 &&
                      ['image/jpeg', 'image/png'].includes(file.type)
                    )
                      setPendingPhoto(file);
                    else if (file) setError('Choose a JPEG or PNG up to 12 MB.');
                  }}
                />
              </>
            ) : undefined
          }
          onChange={(form) => {
            if (!busy) setEditing({ ...editing, form });
          }}
          onSave={saveDish}
          busy={busy}
          error={error}
          evidence={item && editing.session ? evidenceExcerpts(editing.session, item) : []}
          onCancel={() => {
            if (
              !dirty ||
              window.confirm('Leave these unsaved changes? Your saved draft stays available.')
            ) {
              setEditing(null);
              setPendingPhoto(null);
              nextSource();
            }
          }}
        />
      </>
    ) : view === 'publish' && canPublish ? (
      <OwnerPublish
        key={`${actorId}:${venueId}`}
        apiBase={apiBase}
        actorId={actorId}
        venueId={venueId}
        getAccessToken={getAccessToken}
        onAccessFailure={onAccessFailure}
        onBack={() => setView('list')}
        onDone={() => setView('overview')}
      />
    ) : view === 'overview' ? (
      <FirstDashboardContent
        setup={{
          venueId,
          restaurantName,
          detailsStatus: 'unknown',
          menuAdded: loaded ? drafts.length > 0 : null,
          published: null,
        }}
        onOpenStep={(step) => {
          if (step === 'menu') setView('sources');
        }}
      />
    ) : (
      <div className="owner-menu-design stack">
        <div className="pagehead">
          <span className="eyebrow">Menu</span>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h1>Your dishes</h1>
            <Btn kind="primary" size="lg" icon="plus" disabled={busy} onClick={() => editManual()}>
              Add dish
            </Btn>
          </div>
          <p className="lede">
            Edit a dish or add a new one. Your saved drafts stay private until review and
            publication.
          </p>
        </div>
        <div className="owner-workspace-toolbar">
          <Btn kind="outlined" disabled={busy} onClick={() => setView('sources')}>
            Add menu sources
          </Btn>
          <Btn kind="text" disabled={busy} onClick={reload}>
            Reload saved work
          </Btn>
          {canPublish && (
            <Btn kind="outlined" disabled={busy} onClick={() => setView('publish')}>
              Review and publish
            </Btn>
          )}
        </div>
        <p>
          Saving these drafts does not change a live menu. Required confirmations and explicit
          publication stay separate.
        </p>
        <details className="card owner-saved-sources">
          <summary>Saved sources ({jobs.length})</summary>
          {jobs.length === 0 ? (
            <p>No menu sources yet.</p>
          ) : (
            <ul>
              {jobs.map((job) => (
                <li key={job.id}>
                  {job.source_type.toUpperCase()} source — {job.status}; {job.draft_count} dishes.{' '}
                  {['queued', 'running'].includes(job.status) && (
                    <Button
                      disabled={busy}
                      onClick={() => {
                        setProcessingIds([job.id]);
                        setView('processing');
                      }}
                    >
                      View processing
                    </Button>
                  )}
                  {['failed', 'incomplete'].includes(job.status) && (
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void run(async (active) => {
                          await active.client.retryJob(
                            venueId,
                            job.id,
                            command('retry', [job.id, job.attempt_count]),
                          );
                          await load(active);
                        })
                      }
                    >
                      Retry source
                    </Button>
                  )}
                  {['queued', 'running'].includes(job.status) && (
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void run(async (active) => {
                          await active.client.cancelJob(venueId, job.id, command('cancel', job.id));
                          await load(active);
                        })
                      }
                    >
                      Cancel source
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {activeJobs.length > 0 && (
            <p role="status">
              {activeJobs.length} sources are waiting or processing. Reload to check their saved
              status. Other saved dishes remain available.
            </p>
          )}
          {jobs.length === 100 && (
            <p>Showing the latest 100 sources. Earlier saved dish drafts remain listed below.</p>
          )}
        </details>
        <MenuTable>
          {drafts.length === 0 ? (
            <p>No saved dishes yet.</p>
          ) : (
            <>
              {drafts.map((draft) => (
                <div key={draft.id} className="mrow">
                  <span className="thumb">
                    <Icon n="menu" s={24} />
                  </span>
                  <span className="dn">
                    {draft.name ?? 'Untitled dish'}
                    <small>{draft.origin === 'manual' ? 'Manual draft' : 'Extracted draft'}</small>
                  </span>
                  <span className="hidem">{draft.category ?? 'Not set'}</span>
                  <span className="hidem num">
                    {draft.price_amount ?? '—'} {draft.price_currency ?? ''}
                  </span>
                  <span className="lab st">{draft.review_status}</span>
                  <span className="hidem">
                    <span className="lab st">Not connected</span>
                  </span>
                  <Btn
                    kind="outlined"
                    size="md"
                    disabled={busy || !['pending', 'edited'].includes(draft.review_status)}
                    onClick={() => openDraft(draft)}
                    aria-label={`Edit ${draft.name ?? 'untitled dish'}`}
                  >
                    Edit
                  </Btn>
                </div>
              ))}
            </>
          )}
        </MenuTable>
      </div>
    );
  const body = (
    <section
      className={`owner-menu-workspace${view === 'overview' ? ' owner-dashboard-content' : ''}`}
      aria-busy={busy}
    >
      {error && view !== 'edit' && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {content}
    </section>
  );
  return ['sources', 'url', 'photo', 'pdf', 'processing', 'edit', 'publish'].includes(view) ? (
    <OnboardingLayout
      restaurantName={restaurantName}
      // S13 (publish) draws its own Figma card, like Screen 9 (edit).
      bare={['photo', 'pdf', 'edit', 'publish'].includes(view)}
      accountActions={accountActions}
    >
      {error && view !== 'edit' && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {content}
    </OnboardingLayout>
  ) : (
    renderShell(body)
  );
}
