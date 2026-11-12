// FE-06.2: the owner menu workspace API (docs/owner-menu-workspace.md) for Screens 6–9. Every
// call carries the staff bearer token; the server checks owner/editor membership of the venue.
// Requests are validated with the shared contracts before they are sent, and review-session
// responses are parsed, so a malformed body never reaches the screens. The client holds no
// state: commands and idempotency keys come from the caller, so a retry can reuse them exactly.
import {
  type ApproveDishDraftRequest,
  ApproveDishDraftRequestSchema,
  CreateMenuUploadGroupSchema,
  type ExtractionReviewSessionResponse,
  ExtractionReviewSessionResponseSchema,
  MenuUrlIntakeSchema,
  type ReviewCandidateCommand,
  ReviewCandidateCommandSchema,
  type ReviewCandidateItemResponse,
  ReviewCandidateItemResponseSchema,
  type SaveOwnerDishDraft,
  SaveOwnerDishDraftSchema,
} from '@peekaplate/contracts';

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
  manual_fields?: unknown;
};

export type DraftPhoto = { id: string; draft_id: string; content_type: string; size_bytes: number };

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
  getToken: () => string | Promise<string>;
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
function listWithIds<T>(value: unknown): T[] {
  if (!Array.isArray(value)) throw new Error('list');
  return value.map((item) => withId<T>(item));
}
const group = (body: unknown): UploadGroup => {
  const value = withId<UploadGroup>(field(body, 'group'));
  listWithIds<MenuJob>(value.jobs);
  return value;
};

export function createOwnerMenuClient(options: OwnerMenuClientOptions) {
  const base = options.baseUrl.replace(/\/+$/, '');
  const send = options.fetch ?? ((input, init) => fetch(input, init));

  const venuePath = (venueId: string, path: string) =>
    `${base}/venues/${encodeURIComponent(venueId)}${path}`;

  async function request<T>(
    url: string,
    init: { method: string; body?: BodyInit; headers?: Record<string, string>; upload?: boolean },
    parse: (body: unknown) => T,
  ): Promise<T> {
    const token = await options.getToken();
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
          signal: controller.signal,
        });
      } catch {
        throw new OwnerMenuApiError(0, timedOut ? 'timeout' : 'network');
      }
      try {
        body = await response.json();
      } catch {
        if (timedOut) throw new OwnerMenuApiError(0, 'timeout');
        body = null;
      }
    } finally {
      clearTimeout(timer);
    }
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
    async listJobs(venueId: string, groupId: string): Promise<MenuJob[]> {
      return request(
        `${venuePath(venueId, '/menus/jobs')}?groupId=${encodeURIComponent(groupId)}`,
        { method: 'GET' },
        (body) => listWithIds<MenuJob>(field(body, 'jobs')),
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
        (body) => withId<MenuJob>(field(body, 'job')),
      );
    },

    async retryJob(venueId: string, jobId: string, commandId: string): Promise<MenuJob> {
      return request(
        venuePath(venueId, `/menus/jobs/${encodeURIComponent(jobId)}/retry`),
        json('POST', { commandId }),
        (body) => withId<MenuJob>(field(body, 'job')),
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
        (body) => ExtractionReviewSessionResponseSchema.parse(body),
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
        (body) => ReviewCandidateItemResponseSchema.parse(body),
      );
    },

    async listDrafts(venueId: string, filter: { jobId?: string } = {}): Promise<DishDraft[]> {
      const query = filter.jobId ? `?jobId=${encodeURIComponent(filter.jobId)}` : '';
      return request(`${venuePath(venueId, '/drafts')}${query}`, { method: 'GET' }, (body) =>
        listWithIds<DishDraft>(field(body, 'drafts')),
      );
    },

    async getDraft(venueId: string, draftId: string): Promise<DishDraft> {
      return request(
        venuePath(venueId, `/drafts/${encodeURIComponent(draftId)}`),
        { method: 'GET' },
        (body) => withId<DishDraft>(field(body, 'draft')),
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
        (body) => withId<DishDraft>(field(body, 'draft')),
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
      if (!IDEMPOTENCY_KEY.test(idempotencyKey)) throw new OwnerMenuApiError(0, 'invalid_request');
      return request(
        venuePath(venueId, `/drafts/${encodeURIComponent(draftId)}/photos`),
        {
          method: 'POST',
          upload: true,
          body: photo,
          headers: { 'Content-Type': photo.type, 'Idempotency-Key': idempotencyKey },
        },
        (body) => withId<DraftPhoto>(field(body, 'photo')),
      );
    },

    // Owner verification. Creates an approved revision; it never publishes the menu.
    async approveDraft(
      venueId: string,
      draftId: string,
      input: ApproveDishDraftRequest,
    ): Promise<unknown> {
      const payload = ApproveDishDraftRequestSchema.parse(input);
      return request(
        venuePath(venueId, `/drafts/${encodeURIComponent(draftId)}/approve`),
        json('POST', payload),
        (body) => body,
      );
    },
  };
}

export type OwnerMenuClient = ReturnType<typeof createOwnerMenuClient>;
