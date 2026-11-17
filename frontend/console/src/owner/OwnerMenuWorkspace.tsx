import type {
  ExtractionReviewSessionResponse,
  RestaurantProfile,
  RestaurantSetup,
} from '@peekaplate/contracts';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { AddMenuLink } from '../onboarding/AddMenuLink';
import { ChooseMenuSource, type MenuSource } from '../onboarding/ChooseMenuSource';
import type { RestaurantDetails as Details } from '../onboarding/details';
import { MenuProcessing } from '../onboarding/MenuProcessing';
import { menuFileKind } from '../onboarding/menu-source';
import { OnboardingLayout } from '../onboarding/OnboardingLayout';
import { RestaurantDetails } from '../onboarding/RestaurantDetails';
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
import { errorMessage, menuProcessingState } from '../owner-menu/jobs';
import { Button } from '../ui';
import { FirstDashboardContent } from './FirstDashboard';
import { type MenuSnapshot, menuSnapshot } from './menu-snapshot';
import { OwnerPublish } from './OwnerPublish';
import { draftToReviewDish } from './review/fromDishDraft';
import { ReviewDishes } from './review/MenuReview';
import { initialReview, isMenuReady } from './review/reviewDishes';
import '../onboarding/onboarding.css';
import './review/review.css';
import { useHeadingFocus } from '../onboarding/useHeadingFocus';

type Active = { client: OwnerMenuClient; controller: AbortController };
type Editing = {
  draft: DishDraft | null;
  id: string;
  form: DishForm;
  saved: string;
  session?: ExtractionReviewSessionResponse;
};
type FileSelection = {
  files: File[];
  previewUrls: (string | null)[];
  groupKey: string;
  fileKeys: string[];
  groupId?: string;
};

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
  detailsRequested = false,
  getAccessToken,
  onAccessFailure,
  onDirtyChange,
  renderShell,
  accountActions,
  onSetupChange,
  onMenuChange,
  dishAssistanceEnabled = false,
}: {
  apiBase: string;
  actorId: string;
  venueId: string;
  restaurantName: string;
  canPublish: boolean;
  section: 'overview' | 'menu';
  navigation: number;
  detailsRequested?: boolean;
  getAccessToken: () => Promise<string | null>;
  onAccessFailure: (kind: 'signed_out' | 'denied') => void;
  onDirtyChange: (dirty: boolean) => void;
  renderShell: (content: ReactNode) => ReactNode;
  accountActions: ReactNode;
  onSetupChange?: (setup: RestaurantSetup | null) => void;
  onMenuChange?: (menu: MenuSnapshot | null) => void;
  dishAssistanceEnabled?: boolean;
}) {
  const runtime = useRef<Active | null>(null);
  const running = useRef(false);
  const commands = useRef(new Map<string, string>());
  const selection = useRef<FileSelection | null>(null);
  const clearSelection = useCallback(() => {
    for (const url of selection.current?.previewUrls ?? []) if (url) URL.revokeObjectURL(url);
    selection.current = null;
  }, []);
  const readGeneration = useRef(0);
  const urlAttempt = useRef<{ url: string; key: string } | null>(null);
  const photoAttempt = useRef<{ file: File; key: string } | null>(null);
  const photoPicker = useRef<HTMLInputElement>(null);
  const [jobs, setJobs] = useState<MenuJob[]>([]);
  const [drafts, setDrafts] = useState<DishDraft[]>([]);
  const [reviews, setReviews] = useState<Record<string, ExtractionReviewSessionResponse>>({});
  const [reviewUnavailable, setReviewUnavailable] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [view, setRawView] = useState<
    | 'overview'
    | 'details'
    | 'sources'
    | 'url'
    | 'photo'
    | 'pdf'
    | 'list'
    | 'review'
    | 'edit'
    | 'processing'
    | 'publish'
  >('overview');
  useHeadingFocus(view);
  const viewGeneration = useRef(0);
  const setView = useCallback((next: typeof view) => {
    viewGeneration.current++;
    setRawView(next);
  }, []);
  const [processingIds, setProcessingIds] = useState<string[]>([]);
  const [uploads, setUploads] = useState<MenuUpload[]>([]);
  const [editing, setEditing] = useState<Editing | null>(null);
  const latestEditing = useRef(editing);
  latestEditing.current = editing;
  const [pendingPhoto, setPendingPhoto] = useState<File | null>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [portionReview, setPortionReview] = useState<
    | {
        status: 'processing' | 'needs_review' | 'failed';
        previewUrl?: string;
        message?: string;
        approved?: boolean;
      }
    | undefined
  >(undefined);
  const [portionRetry, setPortionRetry] = useState(0);
  // The dish form (S09) returns to where it was opened: S10 review or S06 source choice
  // (Rania, #213 review). null = opened from the Menu list, which it returns to.
  const [editBack, setEditBack] = useState<'review' | 'sources' | null>(null);
  // S05 opened with Back from S06 stays in onboarding: Save continues to S06 (Rania, #213).
  const [detailsFromSources, setDetailsFromSources] = useState(false);
  // S8: "Complete verification" shows the Menu verified pop-up; Go to dashboard leaves it.
  const [verified, setVerified] = useState(false);
  const [removed, setRemoved] = useState<{
    draft: DishDraft;
    dish: ReturnType<typeof draftToReviewDish>;
    index: number;
  } | null>(null);
  const [details, setDetails] = useState<Details | null>(null);
  const [detailsDirty, setDetailsDirty] = useState(false);
  const [profile, setProfile] = useState<RestaurantProfile | null>(null);
  const [setup, setSetup] = useState<RestaurantSetup | null>(null);
  const [profileUnavailable, setProfileUnavailable] = useState(false);
  const profilePhotoAttempt = useRef<{ file: File; key: string } | null>(null);
  const [detailsPhotoUrl, setDetailsPhotoUrl] = useState<string | null>(null);
  // S9: dishes the owner reviewed in this session, and the state of the "I have reviewed" checkbox.
  const [reviewedIds, setReviewedIds] = useState<ReadonlySet<string>>(new Set());
  const [reviewChecked, setReviewChecked] = useState(false);
  const [licenseChecked, setLicenseChecked] = useState(false);
  const shownName = details?.name || restaurantName;

  const current = useCallback(
    (active: Active) => runtime.current === active && !active.controller.signal.aborted,
    [],
  );
  const command = useCallback((kind: string, value: unknown) => {
    const key = JSON.stringify([kind, value]);
    let id = commands.current.get(key);
    if (!id) {
      id = newCommandId();
      commands.current.set(key, id);
    }
    return id;
  }, []);
  const failure = useCallback(
    (reason: unknown) => {
      if (reason instanceof OwnerMenuApiError && reason.code === 'aborted') return;
      onMenuChange?.(null);
      if (reason instanceof OwnerMenuApiError && (reason.status === 401 || reason.status === 403)) {
        setDrafts([]);
        setReviews({});
        setVerified(false);
        setJobs([]);
        setEditing(null);
        setLoaded(false);
        setProfile(null);
        setDetails(null);
        setSetup(null);
        onSetupChange?.(null);
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
    [onAccessFailure, onSetupChange, onMenuChange],
  );
  const load = useCallback(
    async (active: Active) => {
      const generation = ++readGeneration.current;
      let metadata: [RestaurantProfile | null, RestaurantSetup] | null = null;
      const [profileRead, setupRead] = await Promise.allSettled([
        active.client.readProfile(venueId),
        active.client.readSetup(venueId),
      ]);
      for (const result of [profileRead, setupRead]) {
        if (
          result.status === 'rejected' &&
          result.reason instanceof OwnerMenuApiError &&
          [401, 403].includes(result.reason.status)
        )
          throw result.reason;
      }
      // A profile outage must not hide menu work, but neither request may swallow an auth denial.
      if (profileRead.status === 'fulfilled' && setupRead.status === 'fulfilled')
        metadata = [profileRead.value, setupRead.value];
      if (!current(active) || generation !== readGeneration.current) return;
      // #207: terminal status must not be paired with an earlier draft snapshot.
      const nextJobs = await active.client.listJobs(venueId);
      if (!current(active) || generation !== readGeneration.current) return;
      const nextDrafts = await active.client.listDrafts(venueId);
      const nextReviews: Record<string, ExtractionReviewSessionResponse> = {};
      let unavailable = false;
      for (const jobId of new Set(
        nextDrafts
          .filter(
            (draft) =>
              draft.origin !== 'manual' &&
              draft.review_status !== 'superseded' &&
              draft.review_status !== 'rejected',
          )
          .map((draft) => draft.job_id),
      )) {
        if (!jobId) continue;
        const job = nextJobs.find((item) => item.id === jobId);
        if (job && !['complete', 'incomplete'].includes(job.status)) {
          unavailable = true;
          continue;
        }
        try {
          nextReviews[jobId] = await active.client.openReviewSession(
            venueId,
            jobId,
            command('review-session', jobId),
          );
        } catch (reason) {
          if (
            reason instanceof OwnerMenuApiError &&
            (reason.status === 401 || reason.status === 403)
          )
            throw reason;
          unavailable = true;
        }
        if (!current(active) || generation !== readGeneration.current) return;
      }
      if (!current(active) || generation !== readGeneration.current) return;
      setReviews(nextReviews);
      if (metadata) {
        setProfile(metadata[0]);
        const fields = metadata[0]?.fields;
        setDetails(
          fields
            ? {
                name: fields.name,
                city: fields.city,
                street: fields.street,
                line2: fields.line2,
                phone: fields.phone,
                email: fields.email,
              }
            : null,
        );
      }
      setProfileUnavailable(!metadata);
      setSetup(metadata?.[1] ?? null);
      onSetupChange?.(metadata?.[1] ?? null);
      setReviewUnavailable(unavailable);
      setJobs(nextJobs);
      setDrafts(nextDrafts);
      onMenuChange?.(
        menuSnapshot(
          venueId,
          nextDrafts,
          nextReviews,
          unavailable || nextJobs.some((job) => ['queued', 'running'].includes(job.status)),
        ),
      );
      setLoaded(true);
      return nextDrafts;
    },
    [venueId, current, command, onSetupChange, onMenuChange],
  );
  useEffect(() => {
    void actorId;
    setUploads([]);
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
      clearSelection();
      if (runtime.current === active) runtime.current = null;
    };
  }, [actorId, apiBase, getAccessToken, load, current, failure, clearSelection]);
  useEffect(() => {
    setView(detailsRequested ? 'details' : section === 'menu' ? 'list' : 'overview');
    setEditing(null);
    setPendingPhoto(null);
    setEditBack(null);
    setVerified(false);
  }, [section, navigation, detailsRequested, setView]);

  useEffect(() => {
    const active = runtime.current;
    let disposed = false;
    let url: string | null = null;
    setDetailsPhotoUrl(null);
    if (active && profile?.fields.photoId)
      void active.client
        .readProfilePhoto(venueId, profile.fields.photoId)
        .then((blob) => {
          if (disposed || !current(active)) return;
          url = URL.createObjectURL(blob);
          setDetailsPhotoUrl(url);
        })
        .catch((reason) => {
          if (!disposed && current(active)) failure(reason);
        });
    return () => {
      disposed = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [profile?.fields.photoId, venueId, current, failure]);

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
  // Generate from the saved photo, never an unsaved browser File. The private service
  // keys artifacts to the current draft/photo and does not authorize publication.
  useEffect(() => {
    const active = runtime.current;
    const draftId = editing?.id;
    const photoId = editing?.form.photoId;
    if (view !== 'edit' || !active || !draftId || !photoId || pendingPhoto) {
      setPortionReview(undefined);
      return;
    }
    let disposed = false;
    let previewUrl: string | null = null;
    setPortionReview({ status: 'processing' });
    void active.client
      .generateDraftPortion(venueId, draftId, photoId)
      .then(async (result) => {
        if (disposed || !current(active)) return;
        if (result.status === 'failed') {
          setPortionReview({
            status: 'failed',
            message: 'The 2.5D cutout could not be generated. The original photo is retained.',
          });
          return;
        }
        const blob = await active.client.readDraftPortionImage(venueId, draftId, photoId);
        if (disposed || !current(active)) return;
        previewUrl = URL.createObjectURL(blob);
        setPortionReview({ status: 'needs_review', previewUrl, approved: result.approved });
      })
      .catch(() => {
        if (!disposed && current(active)) {
          setPortionReview({
            status: 'failed',
            message: '2.5D processing is unavailable. The original photo is retained.',
          });
        }
      });
    return () => {
      disposed = true;
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [view, editing?.id, editing?.form.photoId, pendingPhoto, venueId, current, portionRetry]);

  const dirty =
    (view === 'details' && detailsDirty) ||
    Boolean(editing && (JSON.stringify(editing.form) !== editing.saved || pendingPhoto));
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
  const run = async (work: (active: Active) => Promise<unknown>) => {
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
  const selectedJobs = jobs.filter((job) => processingIds.includes(job.id));
  const processing = menuProcessingState(selectedJobs);
  const selectedJobsLoaded =
    processingIds.length > 0 && selectedJobs.length === processingIds.length;
  useEffect(() => {
    if (view !== 'processing' || !selectedJobsLoaded) return;
    if (processing.phase === 'ready' || processing.phase === 'partial') {
      setView('review');
      setNotice(
        processing.phase === 'partial'
          ? 'Some sources could not be read fully. Review the dishes found, add missing dishes, or retry the source from Menu.'
          : 'We read your menu. Review each dish before you verify it.',
      );
    } else if (processing.phase === 'cancelled') {
      setView('list');
      setNotice('Processing cancelled. Previously saved dishes remain available.');
    }
  }, [view, selectedJobsLoaded, processing.phase, setView]);
  const editManual = (draft?: DishDraft) => {
    const form = draft
      ? dishFromManualDraft(draft)
      : { ...emptyManualDish(), priceCurrency: 'USD' };
    setEditing({
      id: draft?.id ?? crypto.randomUUID(),
      draft: draft ?? null,
      form,
      saved: JSON.stringify(form),
    });
    // A saved draft is not evidence of either attestation.
    setReviewChecked(false);
    setLicenseChecked(false);
    setPendingPhoto(null);
    setView('edit');
  };
  const nextSource = (next?: MenuSource) => {
    clearSelection();
    setUploads([]);
    if (next === 'manual') {
      setEditBack('sources');
      editManual();
    } else
      setView(next === 'upload' ? 'photo' : (next ?? (drafts.length > 0 ? 'review' : 'sources')));
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
      if (!retry) {
        clearSelection();
        selection.current = {
          files,
          previewUrls: files.map((file) =>
            file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
          ),
          groupKey: newIdempotencyKey(),
          fileKeys: files.map(() => newIdempotencyKey()),
        };
      }
      const selected = selection.current;
      if (!selected) return;
      const rows: MenuUpload[] = selected.files.map((file, index) => ({
        id: String(index),
        name: file.name,
        size: file.size,
        kind: file.type === 'application/pdf' ? 'pdf' : 'image',
        status: 'uploading',
        previewUrl: selected.previewUrls[index],
      }));
      setUploads(rows);
      try {
        const hashes = await Promise.all(selected.files.map(sha256Hex));
        if (!current(active) || selection.current !== selected) return;
        const group = await active.client.createUploadGroup(venueId, {
          idempotencyKey: selected.groupKey,
          files: selected.files.map((file, index) => ({
            sourceType: file.type === 'application/pdf' ? 'pdf' : 'photo',
            sourceHash: hashes[index]!,
          })),
        });
        if (!current(active) || selection.current !== selected) return;
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
          if (!current(active) || selection.current !== selected) return;
          rows[index] = { ...rows[index]!, status: 'uploaded' };
          setUploads([...rows]);
        }
        await load(active);
      } catch (reason) {
        if (current(active) && selection.current === selected)
          setUploads(
            rows.map((row) => (row.status === 'uploaded' ? row : { ...row, status: 'failed' })),
          );
        if (current(active) && selection.current === selected) throw reason;
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
      setReviewChecked(false);
      setLicenseChecked(false);
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
    if (!cancelled || generation !== viewGeneration.current || selection.current !== selected)
      return;
    clearSelection();
    setUploads([]);
    if (files.length) uploadFiles(files);
  };
  const saveDish = (stayOnEditor = false) =>
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
        let savedForm = editing.form;
        if (pendingPhoto) {
          if (photoAttempt.current?.file !== pendingPhoto)
            photoAttempt.current = { file: pendingPhoto, key: newIdempotencyKey() };
          const photo = await active.client.uploadDraftPhoto(
            venueId,
            editing.id,
            pendingPhoto,
            photoAttempt.current.key,
          );
          if (!current(active)) return;
          savedForm = { ...savedForm, photoId: photo.id };
        }
        const corrected = reviewCorrection(item, savedForm);
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
          setPendingPhoto(null);
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
      if (!current(active)) return;
      // An extracted dish counts as reviewed once it is saved with both boxes ticked.
      if (editing.form.origin === 'extracted' && reviewChecked)
        setReviewedIds((ids) => new Set(ids).add(editing.id));
      setNotice('Draft saved. This has not approved or published your menu.');
      // Explicit 2.5D preparation remains on S09 while the saved photo generates.
      // Normal Continue to review retains the authored S09 -> S10 navigation.
      // A new photo already triggers generation; retry explicitly only for the saved photo.
      if (stayOnEditor && !pendingPhoto && editing.form.photoId)
        setPortionRetry((attempt) => attempt + 1);
      if (!stayOnEditor) {
        setEditing(null);
        setPendingPhoto(null);
        setEditBack(null);
        setView('review');
      }
    });

  const reviewDrafts = drafts.filter(
    (draft) => !draft.removed_at && !['rejected', 'superseded'].includes(draft.review_status),
  );
  const reviewDishes = reviewDrafts.map((draft) => {
    const session = draft.job_id ? reviews[draft.job_id] : undefined;
    const item = session?.items.find(
      (candidate) => candidate.candidate.candidate_id === draft.candidate_id,
    );
    const dish = draftToReviewDish(draft, session?.extractionResult.extraction_id, item);
    return reviewedIds.has(draft.id) ? { ...dish, reviewed: true } : dish;
  });
  const reviewNotice = reviewUnavailable ? (
    <p role="status">
      Some extracted reviews could not be loaded. Other saved dishes remain available. Reload after
      processing or recovery.
    </p>
  ) : null;
  const completeVerification = () =>
    void run(async (active) => {
      const approved = (draft: (typeof reviewDrafts)[number]) =>
        draft.review_status === 'accepted' && draft.verification_status === 'verified';
      if (
        !isMenuReady(reviewDishes) ||
        reviewDrafts.some((draft) => draft.review_status !== 'pending' && !approved(draft))
      )
        return;
      const generation = viewGeneration.current;
      setVerified(false);
      for (const draft of reviewDrafts.filter((item) => !approved(item))) {
        const photoId = reviewDishes.find((dish) => dish.id === draft.id)?.photoId;
        if (photoId)
          await active.client.approveDraftPhoto(venueId, draft.id, photoId, {
            commandId: command('verify-photo', [draft.id, photoId, draft.draft_version]),
          });
        if (!current(active)) return;
        const saved = await active.client.verifyDraft(venueId, draft.id, {
          commandId: command('verify-dish', [draft.id, draft.draft_version]),
          expectedVersion: draft.draft_version!,
          verified: true,
        });
        if (!current(active)) return;
        setDrafts((previous) => previous.map((item) => (item.id === saved.id ? saved : item)));
      }
      const confirmed = await load(active);
      if (!current(active) || generation !== viewGeneration.current) return;
      if (
        !confirmed ||
        confirmed.filter(
          (draft) => !draft.removed_at && !['rejected', 'superseded'].includes(draft.review_status),
        ).length !== reviewDrafts.length ||
        reviewDrafts.some(
          (draft) =>
            !confirmed.some(
              (saved) =>
                !saved.removed_at &&
                saved.id === draft.id &&
                saved.draft_version === draft.draft_version &&
                saved.verification_status === 'verified',
            ),
        )
      )
        throw new OwnerMenuApiError(409, 'version_conflict');
      setVerified(true);
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
    view === 'details' ? (
      <>
        <RestaurantDetails
          onDirtyChange={setDetailsDirty}
          key={`${venueId}:${profile?.version ?? 0}:${navigation}`}
          mode={details && !detailsFromSources ? 'dashboard' : 'onboarding'}
          saved={details ?? undefined}
          savedPhotoUrl={detailsPhotoUrl}
          savedPhotoId={profile?.fields.photoId ?? null}
          saving={busy}
          saveFailed={Boolean(error)}
          onSave={(next, photo) => {
            const editingSaved = details !== null;
            const generation = viewGeneration.current;
            // Back from S06 then Save with nothing changed: continue to S06 without
            // submitting the same details for verification again.
            if (
              detailsFromSources &&
              details &&
              !photo &&
              (Object.keys(next) as (keyof typeof next)[]).every(
                (key) => next[key] === details[key],
              )
            ) {
              setDetailsFromSources(false);
              setView('sources');
              return;
            }
            void run(async (active) => {
              let photoId = profile?.fields.photoId ?? null;
              if (photo) {
                if (profilePhotoAttempt.current?.file !== photo)
                  profilePhotoAttempt.current = { file: photo, key: newIdempotencyKey() };
                photoId = (
                  await active.client.uploadProfilePhoto(
                    venueId,
                    photo,
                    profilePhotoAttempt.current.key,
                  )
                ).id;
              }
              const fields = { ...next, photoId };
              await active.client.saveProfile(venueId, {
                commandId: command('profile', [profile?.version ?? 0, fields]),
                expectedVersion: profile?.version ?? 0,
                fields,
              });
              await load(active);
              if (!current(active)) return;
              setNotice(
                'Restaurant details saved and submitted for team verification. This does not publish your menu.',
              );
              if (viewGeneration.current !== generation) return;
              const continueOnboarding = detailsFromSources || !editingSaved;
              setDetailsFromSources(false);
              setView(continueOnboarding ? 'sources' : 'overview');
            });
          }}
          onLeave={() => {
            setDetailsFromSources(false);
            setView('overview');
          }}
        />
      </>
    ) : view === 'review' ? (
      <>
        {reviewNotice}
        {error && <p role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        <ReviewDishes
          restaurantName={shownName}
          state={{
            ...initialReview(reviewDishes),
            removed: removed ? { dish: removed.dish, index: removed.index } : null,
            notice: removed ? 'removed' : null,
          }}
          onRemoveDish={(id) =>
            void run(async (active) => {
              const draft = reviewDrafts.find((value) => value.id === id);
              const dish = reviewDishes.find((value) => value.id === id);
              if (!draft || !dish) return;
              const input = {
                expectedDraftVersion: draft.draft_version!,
                expectedRemovalVersion: draft.removal_version ?? 0,
                removed: true,
              };
              const saved = await active.client.setDraftRemoval(venueId, id, {
                ...input,
                commandId: command('remove', [id, input]),
              });
              if (!current(active)) return;
              setRemoved({ draft: saved, dish, index: reviewDrafts.indexOf(draft) });
              setVerified(false);
              setDrafts((rows) => rows.map((row) => (row.id === id ? saved : row)));
              await load(active);
            })
          }
          onUndoRemove={() =>
            void run(async (active) => {
              if (!removed) return;
              const draft = removed.draft;
              const input = {
                expectedDraftVersion: draft.draft_version!,
                expectedRemovalVersion: draft.removal_version!,
                removed: false,
              };
              const saved = await active.client.setDraftRemoval(venueId, draft.id, {
                ...input,
                commandId: command('restore', [draft.id, input]),
              });
              if (!current(active)) return;
              setRemoved(null);
              setDrafts((rows) => rows.map((row) => (row.id === draft.id ? saved : row)));
              await load(active);
            })
          }
          completing={busy}
          onAddDish={() => {
            setEditBack('review');
            editManual();
          }}
          onEditDish={(id) => {
            const draft = drafts.find((value) => value.id === id);
            if (!draft) return;
            setEditBack('review');
            openDraft(draft);
          }}
          onCancel={() => setView('sources')}
          onSaveAndExit={() => setView('overview')}
          onCompleteVerification={completeVerification}
          verified={verified}
          onGoToDashboard={() => {
            setVerified(false);
            setView('overview');
          }}
        />
      </>
    ) : view === 'sources' ? (
      <ChooseMenuSource
        onContinue={nextSource}
        onBack={() => {
          if (drafts.length > 0) setView('review');
          else {
            setDetailsFromSources(true);
            setView('details');
          }
        }}
      />
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
          onBack={() => {
            clearSelection();
            setUploads([]);
            setView('sources');
          }}
        />
      </>
    ) : view === 'processing' ? (
      <>
        <MenuProcessing
          secondaryAction={
            <Btn kind="outlined" onClick={() => setView('list')}>
              View saved dishes
            </Btn>
          }
          state={
            selectedJobsLoaded && processing.phase === 'failed'
              ? 'failed'
              : selectedJobsLoaded && processing.phase === 'empty'
                ? 'no-dishes'
                : 'processing'
          }
          failureReason={errorMessage(processing.errorCodes[0] ?? 'extraction_failed')}
          step={
            processing.phase === 'uploading'
              ? 'Waiting for the remaining source files'
              : jobs
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
      </>
    ) : view === 'edit' && editing ? (
      <>
        <DishEditor
          value={editing.form}
          {...(dishAssistanceEnabled && {
            draftDescription: async () => {
              const active = runtime.current;
              const generation = viewGeneration.current;
              if (!active || !current(active)) throw new Error('Workspace unavailable');
              const result = await active.client.assistDish(venueId, editing.id, {
                operation: 'description',
                expectedVersion: editing.draft?.draft_version ?? 0,
                requestId: newCommandId(),
                facts: { description: editing.form.description },
              });
              if (
                !current(active) ||
                generation !== viewGeneration.current ||
                latestEditing.current !== editing ||
                result.operation !== 'description' ||
                result.status !== 'review' ||
                !result.description
              )
                throw new Error('No supported description suggestion');
              return result.description;
            },
            ...(editing.draft && {
              suggestIngredients: async () => {
                const active = runtime.current;
                const generation = viewGeneration.current;
                if (!active || !current(active)) throw new Error('Workspace unavailable');
                const result = await active.client.assistDish(venueId, editing.id, {
                  operation: 'ingredients',
                  expectedVersion: editing.draft!.draft_version ?? 0,
                  requestId: newCommandId(),
                  facts: {},
                });
                if (
                  !current(active) ||
                  generation !== viewGeneration.current ||
                  latestEditing.current !== editing ||
                  result.operation !== 'ingredients'
                )
                  throw new Error('Ingredient suggestion is no longer current');
                return result.ingredients;
              },
            }),
          })}
          photoUrl={photoUrl}
          {...(portionReview ? { portionReview } : {})}
          onGeneratePortion={() => saveDish(true)}
          onApprovePortion={() => {
            const id = editing.id;
            const photoId = editing.form.photoId;
            if (!photoId || pendingPhoto || portionReview?.status !== 'needs_review') return;
            void run(async (active) => {
              await active.client.approveDraftPortion(venueId, id, photoId);
              if (current(active)) {
                setPortionReview((previous) =>
                  previous?.status === 'needs_review' ? { ...previous, approved: true } : previous,
                );
              }
            });
          }}
          existing={Boolean(editing.draft)}
          categories={drafts.map((draft) => draft.category ?? '').filter(Boolean)}
          photo={
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
                  ) {
                    setPendingPhoto(file);
                    setLicenseChecked(false);
                  } else if (file) setError('Choose a JPEG or PNG up to 12 MB.');
                }}
              />
            </>
          }
          onChange={(form) => {
            if (!busy) {
              setEditing({ ...editing, form });
              setReviewChecked(false);
            }
          }}
          onSave={saveDish}
          busy={busy}
          error={error}
          evidence={item && editing.session ? evidenceExcerpts(editing.session, item) : []}
          saveLabel={editBack ? 'Continue to review' : 'Save draft'}
          cancelLabel={editBack ? 'Back' : 'Cancel'}
          reviewConfirmed={reviewChecked}
          onReviewConfirmedChange={setReviewChecked}
          licenseConfirmed={licenseChecked}
          {...((pendingPhoto || editing.form.photoId) && {
            onLicenseConfirmedChange: setLicenseChecked,
          })}
          onCancel={() => {
            if (
              !dirty ||
              window.confirm('Leave these unsaved changes? Your saved draft stays available.')
            ) {
              setEditing(null);
              setPendingPhoto(null);
              if (editBack) {
                const back = editBack;
                setEditBack(null);
                setView(back);
              } else setView(drafts.length > 0 ? 'list' : 'sources');
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
        onDone={() =>
          void run(async (active) => {
            await load(active);
            if (current(active)) setView('overview');
          })
        }
      />
    ) : view === 'overview' ? (
      <FirstDashboardContent
        setup={{
          venueId,
          restaurantName: shownName,
          detailsStatus: setup?.detailsStatus ?? 'unknown',
          menuAdded: setup?.menuAdded ?? (loaded ? reviewDrafts.length > 0 : null),
          published: setup?.published ?? null,
        }}
        onOpenStep={(step) => {
          if (step === 'details') setView('details');
          if (step === 'publish' && canPublish) setView('publish');
          if (step === 'menu') {
            setVerified(false);
            setView(drafts.length > 0 ? 'review' : 'sources');
          }
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
                          const generation = viewGeneration.current;
                          await active.client.retryJob(
                            venueId,
                            job.id,
                            command('retry', [job.id, job.attempt_count]),
                          );
                          await load(active);
                          if (current(active) && generation === viewGeneration.current) {
                            setProcessingIds([job.id]);
                            setView('processing');
                          }
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
              {drafts
                .filter((draft) => !draft.removed_at)
                .map((draft) => {
                  const effective = reviewDishes.find((dish) => dish.id === draft.id);
                  return (
                    <div key={draft.id} className="mrow">
                      <span className="thumb">
                        <Icon n="menu" s={24} />
                      </span>
                      <span className="dn">
                        {effective?.name ?? draft.name ?? 'Untitled dish'}
                        <small>
                          {draft.origin === 'manual' ? 'Manual draft' : 'Extracted draft'}
                        </small>
                      </span>
                      <span className="hidem">
                        {effective?.category ?? draft.category ?? 'Not set'}
                      </span>
                      <span className="hidem num">
                        {effective?.priceAmount ?? draft.price_amount ?? '—'}{' '}
                        {effective?.priceCurrency ?? draft.price_currency ?? ''}
                      </span>
                      <span className="lab st">{draft.review_status}</span>
                      <span className="hidem">
                        <span className="lab st">Review in dish</span>
                      </span>
                      <Btn
                        kind="outlined"
                        size="md"
                        disabled={
                          busy || !['pending', 'edited', 'accepted'].includes(draft.review_status)
                        }
                        onClick={() => openDraft(draft)}
                        aria-label={`Edit ${effective?.name ?? draft.name ?? 'untitled dish'}`}
                      >
                        Edit
                      </Btn>
                    </div>
                  );
                })}
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
      {reviewNotice}
      {profileUnavailable && (
        <p role="status">
          Restaurant details and setup status are temporarily unavailable. Saved menu work remains
          available.
        </p>
      )}
      {content}
    </section>
  );
  if (view === 'review') return content;
  if (view === 'edit' && section === 'menu' && editBack === null) return renderShell(body);
  return ['details', 'sources', 'url', 'photo', 'pdf', 'processing', 'edit', 'publish'].includes(
    view,
  ) ? (
    <OnboardingLayout
      restaurantName={shownName}
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
