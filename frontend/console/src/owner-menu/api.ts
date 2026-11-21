// FE-06.2: the owner menu workspace API (docs/owner-menu-workspace.md) for Screens 6–9. Every
// call carries the staff bearer token; the server checks owner/editor membership of the venue.
// Requests are validated with the shared contracts before they are sent, and review-session
// responses are parsed, so a malformed body never reaches the screens. The client holds no
// state: commands and idempotency keys come from the caller, so a retry can reuse them exactly.
import {
  type ApproveDishDraftRequest,
  ApproveDishDraftRequestSchema,
  type ApproveDraftPhoto,
  ApproveDraftPhotoSchema,
  type ApproveMenuRevision,
  ApproveMenuRevisionSchema,
  CreateMenuUploadGroupSchema,
  DishRevisionSchema,
  type ExtractionReviewSessionResponse,
  ExtractionReviewSessionResponseSchema,
  MenuApprovalSchema,
  MenuPublicationSchema,
  MenuUrlIntakeSchema,
  OwnerDishFieldsSchema,
  PhotoVerificationStatusSchema,
  PreparedMenuPreviewSchema,
  PreparedMenusSchema,
  type PublishMenu,
  PublishMenuSchema,
  RestaurantProfileResponseSchema,
  RestaurantSetupSchema,
  type ReviewCandidateCommand,
  ReviewCandidateCommandSchema,
  type ReviewCandidateItemResponse,
  ReviewCandidateItemResponseSchema,
  type SaveOwnerDishDraft,
  SaveOwnerDishDraftSchema,
  type SaveRestaurantProfile,
  SaveRestaurantProfileSchema,
  type SetDraftRemoval,
  SetDraftRemovalSchema,
  type VerifyDishDraft,
  VerifyDishDraftSchema,
} from '@peekaplate/contracts';
import { readWorkspaceApiBase } from '../owner/workspace-api';

export type SourceType = 'pdf' | 'photo';

// A menu ingestion job as the API returns it (backend MenuIngestionJobRow). Only the fields the
// screens read are typed; the rest are kept as-is.
export type MenuJob = {
  id: string;
  source_type: 'url' | 'pdf' | 'photo' | 'text';
  status: 'queued' | 'running' | 'complete' | 'incomplete' | 'failed' | 'cancelled';
  attempt_count: number;
  max_attempts: number;
  error_code: string | null;
  draft_count: number;
  upload_group_id?: string | null;
  upload_index?: number | null;
  source_uploaded?: boolean;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

export type UploadGroup = { id: string; jobs: MenuJob[]; ready?: boolean };

// A dish draft (backend DishDraftRow). Extracted drafts are corrected through the review API;
// only manual drafts are saved with PUT /drafts/:draftId.
export type DishDraft = {
  removed_at?: string | null;
  removal_version?: number;
  id: string;
  job_id: string | null;
  draft_id: string;
  candidate_id?: string | null;
  name: string | null;
  description: string | null;
  category: string | null;
  price_text?: string | null;
  price_amount: string | null;
  price_currency: string | null;
  ingredients: unknown[] | null;
  source_text: string | null;
  review_warnings: string[];
  review_status: 'pending' | 'accepted' | 'rejected' | 'edited' | 'superseded';
  origin?: 'extracted' | 'manual';
  draft_version?: number;
  verification_status?: 'not_verified' | 'verified';
  manual_fields?: unknown;
};

export type DraftPhoto = {
  id: string;
  draftId: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  verificationStatus: 'not_verified' | 'verified' | 'rejected';
  storageKey: string;
};

export class OwnerMenuApiError extends Error {
  constructor(
    readonly status: number,
    // The server's error code ("version_conflict", "forbidden", ...), or "network" / "invalid_response".
    readonly code: string,
  ) {
    super(`Owner menu request failed: ${status} ${code}`);
    this.name = 'OwnerMenuApiError';
  }

  // 409s a screen resolves by reloading (stale version) rather than by retrying the same command.
  get isConflict(): boolean {
    return this.status === 409;
  }

  // Worth offering Retry: network failures, rate limits and server errors.
  get isRetryable(): boolean {
    return (
      this.code === 'network' ||
      this.code === 'timeout' ||
      this.status === 429 ||
      this.status >= 500
    );
  }
}

export type OwnerMenuClientOptions = {
  // The staging/local API origin, e.g. https://peekaplate-api-staging.vxkong.workers.dev
  baseUrl: string;
  // The signed-in staff session's access token (S4-FE-04); called per request so a refresh applies.
  getToken: () => string | null | Promise<string | null>;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  // A request with no answer by then fails as "timeout", so a screen never waits forever.
  timeoutMs?: number;
  // File and photo uploads carry up to 12 MB, so they get longer.
  uploadTimeoutMs?: number;
};

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,128}$/;
export const MAX_FILE_BYTES = 12_000_000;

export function newCommandId(): string {
  return crypto.randomUUID();
}

// A stable key for one logical upload or URL submission; reuse it when retrying that submission.
export function newIdempotencyKey(): string {
  return crypto.randomUUID().replaceAll('-', '');
}

// Lowercase SHA-256 hex of the file's exact bytes, as the upload manifest requires.
export async function sha256Hex(data: Blob | ArrayBuffer): Promise<string> {
  const bytes = data instanceof Blob ? await data.arrayBuffer() : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Response guards: the API returns {key: value}; anything else is treated as invalid_response.
function field(body: unknown, key: string): unknown {
  if (typeof body !== 'object' || body === null || !(key in body)) throw new Error(key);
  return (body as Record<string, unknown>)[key];
}
function withId<T>(value: unknown): T {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof (value as { id?: unknown }).id !== 'string'
  )
    throw new Error('id');
  return value as T;
}
function list<T>(value: unknown, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new Error('list');
  return value.map(parse);
}
const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const nullableText = (value: unknown) => value === null || typeof value === 'string';
const job = (value: unknown): MenuJob => {
  const row = withId<MenuJob>(value);
  if (
    !['url', 'pdf', 'photo', 'text'].includes(row.source_type) ||
    !['queued', 'running', 'complete', 'incomplete', 'failed', 'cancelled'].includes(row.status) ||
    !count(row.attempt_count) ||
    !count(row.max_attempts) ||
    !count(row.draft_count) ||
    !nullableText(row.error_code) ||
    typeof row.created_at !== 'string' ||
    !nullableText(row.started_at) ||
    !nullableText(row.finished_at)
  )
    throw new Error('job');
  return row;
};
const draft = (value: unknown): DishDraft => {
  const row = withId<DishDraft>(value);
  if (
    typeof row.draft_id !== 'string' ||
    !nullableText(row.job_id) ||
    !['pending', 'accepted', 'rejected', 'edited', 'superseded'].includes(row.review_status) ||
    ![
      row.name,
      row.category,
      row.description,
      row.price_amount,
      row.price_currency,
      row.source_text,
    ].every(nullableText) ||
    !(row.ingredients === null || Array.isArray(row.ingredients)) ||
    !Array.isArray(row.review_warnings) ||
    !row.review_warnings.every((x) => typeof x === 'string') ||
    !count(row.draft_version)
  )
    throw new Error('draft');
  if (row.origin === 'manual') OwnerDishFieldsSchema.parse(row.manual_fields);
  return row;
};
const parsePhoto = (value: unknown): DraftPhoto => {
  const row = withId<DraftPhoto>(value);
  if (
    typeof row.draftId !== 'string' ||
    !['image/jpeg', 'image/png'].includes(row.contentType) ||
    !count(row.sizeBytes) ||
    row.sizeBytes > MAX_FILE_BYTES ||
    !/^[a-f0-9]{64}$/.test(row.sha256) ||
    !PhotoVerificationStatusSchema.safeParse(row.verificationStatus).success ||
    typeof row.storageKey !== 'string'
  )
    throw new Error('photo');
  return row;
};
const group = (body: unknown): UploadGroup => {
  const value = withId<UploadGroup>(field(body, 'group'));
  list(value.jobs, job);
  return value;
};

export function createOwnerMenuClient(options: OwnerMenuClientOptions) {
  const base = readWorkspaceApiBase(options.baseUrl);
  if (!base) throw new OwnerMenuApiError(0, 'invalid_api_origin');
  const send = options.fetch ?? ((input, init) => fetch(input, init));

  const venuePath = (venueId: string, path: string) =>
    `${base}/venues/${encodeURIComponent(venueId)}${path}`;

  async function request<T>(
    url: string,
    init: {
      method: string;
      body?: BodyInit;
      headers?: Record<string, string>;
      upload?: boolean;
      blob?: boolean;
    },
    parse: (body: unknown) => T,
  ): Promise<T> {
    const token = await options.getToken();
    if (options.signal?.aborted) throw new OwnerMenuApiError(0, 'aborted');
    if (!token) throw new OwnerMenuApiError(401, 'unauthorized');
    const limit = init.upload
      ? (options.uploadTimeoutMs ?? 120_000)
      : (options.timeoutMs ?? 30_000);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, limit);
    let response: Response;
    let body: unknown = null;
    try {
      try {
        response = await send(url, {
          method: init.method,
          headers: { Authorization: `Bearer ${token}`, ...init.headers },
          ...(init.body === undefined ? {} : { body: init.body }),
          // The API never needs cookies; the bearer token is the only credential.
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
          signal: options.signal
            ? AbortSignal.any([controller.signal, options.signal])
            : controller.signal,
        });
      } catch {
        throw new OwnerMenuApiError(
          0,
          timedOut ? 'timeout' : options.signal?.aborted ? 'aborted' : 'network',
        );
      }
      try {
        body = init.blob && response.ok ? await response.blob() : await response.json();
      } catch {
        if (timedOut) throw new OwnerMenuApiError(0, 'timeout');
        body = null;
      }
    } finally {
      clearTimeout(timer);
    }
    if (options.signal?.aborted) throw new OwnerMenuApiError(0, 'aborted');
    if (!response.ok) {
      const code =
        typeof body === 'object' &&
        body !== null &&
        typeof (body as { error?: unknown }).error === 'string'
          ? (body as { error: string }).error
          : 'http_error';
      throw new OwnerMenuApiError(response.status, code);
    }
    try {
      return parse(body);
    } catch {
      throw new OwnerMenuApiError(response.status, 'invalid_response');
    }
  }

  const json = (method: string, body: unknown) => ({
    method,
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });

  return {
    async setDraftRemoval(venueId: string, draftId: string, input: SetDraftRemoval) {
      return request(
        venuePath(venueId, `/drafts/${encodeURIComponent(draftId)}/removal`),
        json('POST', SetDraftRemovalSchema.parse(input)),
        (body) => {
          const value = draft(field(body, 'draft'));
          if (
            value.id !== draftId ||
            Boolean(value.removed_at) !== input.removed ||
            value.removal_version !== input.expectedRemovalVersion + 1
          )
            throw new Error('removal scope');
          return value;
        },
      );
    },
    async readProfile(venueId: string) {
      return request(
        venuePath(venueId, '/profile'),
        { method: 'GET' },
        (body) => RestaurantProfileResponseSchema.parse(body).profile,
      );
    },
    async saveProfile(venueId: string, input: SaveRestaurantProfile) {
      return request(
        venuePath(venueId, '/profile'),
        json('PUT', SaveRestaurantProfileSchema.parse(input)),
        (body) => RestaurantProfileResponseSchema.parse(body).profile,
      );
    },
    async readSetup(venueId: string) {
      return request(venuePath(venueId, '/setup'), { method: 'GET' }, (body) => {
        const setup = RestaurantSetupSchema.parse(body);
        if (setup.venueId !== venueId) throw new Error('setup scope');
        return setup;
      });
    },
    async uploadProfilePhoto(venueId: string, file: Blob, idempotencyKey: string) {
      if (
        !IDEMPOTENCY_KEY.test(idempotencyKey) ||
        !['image/jpeg', 'image/png'].includes(file.type) ||
        !file.size ||
        file.size > MAX_FILE_BYTES
      )
        throw new OwnerMenuApiError(0, 'invalid_request');
      return request(
        venuePath(venueId, '/profile/photos'),
        {
          method: 'POST',
          upload: true,
          body: file,
          headers: { 'Content-Type': file.type, 'Idempotency-Key': idempotencyKey },
        },
        (body) => withId<{ id: string }>(body),
      );
    },
    async readProfilePhoto(venueId: string, photoId: string) {
      return request(
        venuePath(venueId, `/profile/photos/${encodeURIComponent(photoId)}`),
        { method: 'GET', blob: true },
        (body) => {
          if (
            !(body instanceof Blob) ||
            !['image/jpeg', 'image/png'].includes(body.type) ||
            !body.size ||
            body.size > MAX_FILE_BYTES
          )
            throw new Error('profile photo');
          return body;
        },
      );
    },
    async listPreparedMenus(venueId: string) {
      return request(
        venuePath(venueId, '/prepared-menus'),
        { method: 'GET' },
        (body) => PreparedMenusSchema.parse(body).menus,
      );
    },
    // Part A: turn the owner's verified dishes into a prepared menu for S13 (never publishes).
    async prepareMenu(venueId: string) {
      return request(venuePath(venueId, '/prepared-menus/prepare'), { method: 'POST' }, (body) => {
        const menuRevisionId = field(body, 'menuRevisionId');
        const completeDishes = field(body, 'completeDishes');
        if (typeof menuRevisionId !== 'string' || typeof completeDishes !== 'number')
          throw new Error('prepared menu');
        return { menuRevisionId, completeDishes };
      });
    },
    async previewPreparedMenu(venueId: string, menuId: string, revisionId: string) {
      return request(
        venuePath(
          venueId,
          `/prepared-menus/${encodeURIComponent(menuId)}/${encodeURIComponent(revisionId)}`,
        ),
        { method: 'GET' },
        (body) => PreparedMenuPreviewSchema.parse(body),
      );
    },
    async readPreparedPreviewAsset(
      venueId: string,
      menuId: string,
      revisionId: string,
      assetUrl: string,
    ) {
      const url = new URL(assetUrl);
      const prefix = `/public/prepared-assets/${venueId}/`;
      const asset = url.pathname.slice(prefix.length).split('/');
      if (
        url.origin !== base ||
        !url.pathname.startsWith(prefix) ||
        url.search ||
        url.hash ||
        url.username ||
        url.password ||
        asset.length !== 2
      )
        throw new OwnerMenuApiError(0, 'invalid_request');
      return request(
        venuePath(
          venueId,
          `/prepared-menus/${encodeURIComponent(menuId)}/${encodeURIComponent(revisionId)}/assets/${encodeURIComponent(asset[0]!)}/${encodeURIComponent(asset[1]!)}`,
        ),
        { method: 'GET', blob: true },
        (body) => {
          if (
            !(body instanceof Blob) ||
            !['image/png', 'image/jpeg'].includes(body.type) ||
            !body.size ||
            body.size > MAX_FILE_BYTES
          )
            throw new Error('prepared photo');
          return body;
        },
      );
    },
    async approveMenu(venueId: string, menuId: string, input: ApproveMenuRevision) {
      return request(
        venuePath(venueId, `/menus/${encodeURIComponent(menuId)}/approvals`),
        json('POST', ApproveMenuRevisionSchema.parse(input)),
        (body) => MenuApprovalSchema.parse(body),
      );
    },
    async publishMenu(venueId: string, menuId: string, input: PublishMenu) {
      return request(
        venuePath(venueId, `/menus/${encodeURIComponent(menuId)}/publications`),
        json('POST', PublishMenuSchema.parse(input)),
        (body) => MenuPublicationSchema.parse(body),
      );
    },
    async dinerLink(venueId: string, menuId: string): Promise<string> {
      return request(
        venuePath(venueId, `/menus/${encodeURIComponent(menuId)}/diner-link`),
        { method: 'GET' },
        (body) => {
          const value = field(body, 'url');
          const path = field(body, 'path');
          if (typeof value !== 'string' || typeof path !== 'string') throw new Error('link');
          const url = new URL(value);
          if (
            url.origin !== 'https://routing-staging.peekaplate-diner-staging.pages.dev' ||
            url.pathname !== path ||
            !/^\/diner\/[a-z0-9][a-z0-9_-]{0,63}$/.test(path) ||
            url.search ||
            url.hash ||
            url.username ||
            url.password
          )
            throw new Error('link');
          return url.href;
        },
      );
    },
    // Generated 2.5D artifacts remain private and needs-review; these methods never publish.
    async generateDraftPortion(venueId: string, draftId: string, photoId: string) {
      return request(
        venuePath(
          venueId,
          `/drafts/${encodeURIComponent(draftId)}/photos/${encodeURIComponent(photoId)}/portion`,
        ),
        { method: 'POST', upload: true },
        (body) => {
          const record = field(body, 'portionReview') as Record<string, unknown>;
          if (
            !record ||
            !['needs_review', 'failed'].includes(String(record.status)) ||
            record.dish_id !== draftId ||
            record.draft_revision_id !== photoId
          )
            throw new Error('portion review identity');
          return {
            status: record.status as 'needs_review' | 'failed',
            approved: record.approved === true,
          };
        },
      );
    },
    async approveDraftPortion(venueId: string, draftId: string, photoId: string) {
      return request(
        venuePath(
          venueId,
          `/drafts/${encodeURIComponent(draftId)}/photos/${encodeURIComponent(photoId)}/portion/approve`,
        ),
        { method: 'POST' },
        (body) => {
          if (field(body, 'approved') !== true) throw new Error('portion approval');
          return true;
        },
      );
    },
    async readDraftPortionImage(venueId: string, draftId: string, photoId: string): Promise<Blob> {
      return request(
        venuePath(
          venueId,
          `/drafts/${encodeURIComponent(draftId)}/photos/${encodeURIComponent(photoId)}/portion/image`,
        ),
        { method: 'GET', blob: true },
        (body) => {
          if (
            !(body instanceof Blob) ||
            body.size === 0 ||
            body.size > 180_000 ||
            body.type !== 'image/webp'
          )
            throw new Error('portion image');
          return body;
        },
      );
    },
    // Existing private-photo endpoint; retrieve bytes with the same actor-bound request boundary.
    async readDraftPhoto(venueId: string, draftId: string, photoId: string): Promise<Blob> {
      return request(
        venuePath(
          venueId,
          `/drafts/${encodeURIComponent(draftId)}/photos/${encodeURIComponent(photoId)}`,
        ),
        { method: 'GET', blob: true },
        (body) => {
          if (
            !(body instanceof Blob) ||
            !['image/jpeg', 'image/png'].includes(body.type) ||
            body.size === 0 ||
            body.size > MAX_FILE_BYTES
          )
            throw new Error('photo');
          return body;
        },
      );
    },
    // S06/S07: declare one PDF or one to five photos by type and hash before sending any bytes.
    async createUploadGroup(
      venueId: string,
      input: { idempotencyKey: string; files: { sourceType: SourceType; sourceHash: string }[] },
    ): Promise<UploadGroup> {
      const payload = CreateMenuUploadGroupSchema.parse(input);
      return request(venuePath(venueId, '/menus/upload-groups'), json('POST', payload), group);
    },

    // Sends one file's raw bytes into its manifest slot. Repeating the final file's PUT with the same
    // key repairs a failed dispatch, so callers retry with the same idempotencyKey.
    async uploadGroupFile(
      venueId: string,
      groupId: string,
      index: number,
      file: Blob,
      idempotencyKey: string,
    ): Promise<UploadGroup> {
      if (!IDEMPOTENCY_KEY.test(idempotencyKey)) throw new OwnerMenuApiError(0, 'invalid_request');
      if (file.size > MAX_FILE_BYTES) throw new OwnerMenuApiError(0, 'file_too_large');
      return request(
        venuePath(venueId, `/menus/upload-groups/${encodeURIComponent(groupId)}/files/${index}`),
        {
          method: 'PUT',
          upload: true,
          body: file,
          headers: {
            'Content-Type': file.type || 'application/octet-stream',
            'Idempotency-Key': idempotencyKey,
          },
        },
        group,
      );
    },

    // S07 URL entry. An HTML page that is not one menu file returns menu_file_link_required.
    async submitMenuUrl(
      venueId: string,
      input: { url: string; idempotencyKey: string },
    ): Promise<UploadGroup> {
      const payload = MenuUrlIntakeSchema.parse(input);
      return request(venuePath(venueId, '/menus/url'), json('POST', payload), group);
    },

    // S08 processing and resume: the stored state of every job in the group (at most 100).
    async verifyDraft(
      venueId: string,
      draftId: string,
      input: VerifyDishDraft,
    ): Promise<DishDraft> {
      return request(
        venuePath(venueId, `/drafts/${encodeURIComponent(draftId)}/verify`),
        json('POST', VerifyDishDraftSchema.parse(input)),
        (body) => {
          const row = draft(field(body, 'draft'));
          if (
            row.id !== draftId ||
            row.verification_status !== (input.verified ? 'verified' : 'not_verified')
          )
            throw new Error('verification scope');
          return row;
        },
      );
    },
    async approveDraftPhoto(
      venueId: string,
      draftId: string,
      photoId: string,
      input: ApproveDraftPhoto,
    ): Promise<DraftPhoto> {
      return request(
        venuePath(
          venueId,
          `/drafts/${encodeURIComponent(draftId)}/photos/${encodeURIComponent(photoId)}/approve`,
        ),
        json('POST', ApproveDraftPhotoSchema.parse(input)),
        (body) => {
          const photo = parsePhoto(field(body, 'photo'));
          if (
            photo.id !== photoId ||
            photo.draftId !== draftId ||
            photo.verificationStatus !== 'verified'
          )
            throw new Error('photo scope');
          return photo;
        },
      );
    },
    async listJobs(venueId: string, groupId?: string): Promise<MenuJob[]> {
      return request(
        `${venuePath(venueId, '/menus/jobs')}${groupId ? `?groupId=${encodeURIComponent(groupId)}` : ''}`,
        { method: 'GET' },
        (body) => list(field(body, 'jobs'), job),
      );
    },

    async cancelGroup(venueId: string, groupId: string, commandId: string): Promise<UploadGroup> {
      return request(
        venuePath(venueId, `/menus/upload-groups/${encodeURIComponent(groupId)}/cancel`),
        json('POST', { commandId }),
        group,
      );
    },

    async cancelJob(venueId: string, jobId: string, commandId: string): Promise<MenuJob> {
      return request(
        venuePath(venueId, `/menus/jobs/${encodeURIComponent(jobId)}/cancel`),
        json('POST', { commandId }),
        (body) => {
          const row = job(field(body, 'job'));
          if (row.id !== jobId) throw new Error('job scope');
          return row;
        },
      );
    },

    async retryJob(venueId: string, jobId: string, commandId: string): Promise<MenuJob> {
      return request(
        venuePath(venueId, `/menus/jobs/${encodeURIComponent(jobId)}/retry`),
        json('POST', { commandId }),
        (body) => {
          const row = job(field(body, 'job'));
          if (row.id !== jobId) throw new Error('job scope');
          return row;
        },
      );
    },

    // Screen 9 for an extracted menu: the verified review session with each candidate's original,
    // current review and effective values. Blocks (409/422) when the stored artifact is missing.
    async openReviewSession(
      venueId: string,
      jobId: string,
      commandId: string,
    ): Promise<ExtractionReviewSessionResponse> {
      return request(
        venuePath(venueId, `/menus/jobs/${encodeURIComponent(jobId)}/review-session`),
        json('POST', { commandId }),
        (body) => {
          const session = ExtractionReviewSessionResponseSchema.parse(body);
          if (session.venueId !== venueId) throw new Error('review scope');
          return session;
        },
      );
    },

    // Saves an owner correction to one extracted candidate (optimistic expectedVersion).
    async reviewCandidate(
      venueId: string,
      extractionId: string,
      candidateId: string,
      command: ReviewCandidateCommand,
    ): Promise<ReviewCandidateItemResponse> {
      const payload = ReviewCandidateCommandSchema.parse(command);
      return request(
        venuePath(
          venueId,
          `/extractions/${encodeURIComponent(extractionId)}/candidates/${encodeURIComponent(candidateId)}/review`,
        ),
        json('POST', payload),
        (body) => {
          const item = ReviewCandidateItemResponseSchema.parse(body);
          if (
            item.candidate.candidate_id !== candidateId ||
            item.review.extractionId !== extractionId
          )
            throw new Error('candidate scope');
          return item;
        },
      );
    },

    async listDrafts(venueId: string, filter: { jobId?: string } = {}): Promise<DishDraft[]> {
      const query = filter.jobId ? `?jobId=${encodeURIComponent(filter.jobId)}` : '';
      return request(`${venuePath(venueId, '/drafts')}${query}`, { method: 'GET' }, (body) =>
        list(field(body, 'drafts'), draft),
      );
    },

    async getDraft(venueId: string, draftId: string): Promise<DishDraft> {
      return request(
        venuePath(venueId, `/drafts/${encodeURIComponent(draftId)}`),
        { method: 'GET' },
        (body) => {
          const row = draft(field(body, 'draft'));
          if (row.id !== draftId) throw new Error('draft scope');
          return row;
        },
      );
    },

    // Manual Add Dish: replaces the full field snapshot; expectedVersion is the draft_version read.
    async saveManualDraft(
      venueId: string,
      draftId: string,
      input: SaveOwnerDishDraft,
    ): Promise<DishDraft> {
      const payload = SaveOwnerDishDraftSchema.parse(input);
      return request(
        venuePath(venueId, `/drafts/${encodeURIComponent(draftId)}`),
        json('PUT', payload),
        (body) => {
          const row = draft(field(body, 'draft'));
          if (row.id !== draftId) throw new Error('draft scope');
          return row;
        },
      );
    },

    // A private JPEG/PNG for a manual draft; save the returned id in the next draft version.
    async uploadDraftPhoto(
      venueId: string,
      draftId: string,
      photo: Blob,
      idempotencyKey: string,
    ): Promise<DraftPhoto> {
      if (!['image/jpeg', 'image/png'].includes(photo.type))
        throw new OwnerMenuApiError(0, 'unsupported_media_type');
      if (photo.size > MAX_FILE_BYTES) throw new OwnerMenuApiError(0, 'file_too_large');
      if (photo.size === 0) throw new OwnerMenuApiError(0, 'invalid_request');
      if (!IDEMPOTENCY_KEY.test(idempotencyKey)) throw new OwnerMenuApiError(0, 'invalid_request');
      return request(
        venuePath(venueId, `/drafts/${encodeURIComponent(draftId)}/photos`),
        {
          method: 'POST',
          upload: true,
          body: photo,
          headers: { 'Content-Type': photo.type, 'Idempotency-Key': idempotencyKey },
        },
        (body) => {
          const row = parsePhoto(field(body, 'photo'));
          if (row.draftId !== draftId) throw new Error('photo scope');
          return row;
        },
      );
    },

    // Creates an approved revision; separate from the verification badge and menu publication.
    async approveDraft(
      venueId: string,
      draftId: string,
      input: ApproveDishDraftRequest,
    ): Promise<unknown> {
      const payload = ApproveDishDraftRequestSchema.parse(input);
      return request(
        venuePath(venueId, `/drafts/${encodeURIComponent(draftId)}/approve`),
        json('POST', payload),
        (body) => {
          const row = draft(field(body, 'draft'));
          const revision = DishRevisionSchema.parse(field(body, 'publishedRevision'));
          if (row.id !== draftId) throw new Error('approval');
          return { draft: row, publishedRevision: revision };
        },
      );
    },
  };
}

export type OwnerMenuClient = ReturnType<typeof createOwnerMenuClient>;
