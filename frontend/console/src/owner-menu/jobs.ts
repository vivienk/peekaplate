// FE-06.2: one processing state for Screen 8 from the stored job states of an upload group. It
// reports counts only: the API gives no provider progress, so there is no percentage or timer.
import type { MenuJob } from './api';

export type MenuProcessingPhase =
  // Some files still have to be sent before extraction can start.
  | 'uploading'
  // Every file is in and at least one job is still queued or running.
  | 'processing'
  // Every job finished with dishes to review.
  | 'ready'
  // Finished, but at least one job is incomplete or failed while others produced dishes.
  | 'partial'
  // Finished with no dishes to review.
  | 'empty'
  // Every unfinished job failed (offer Retry or manual entry).
  | 'failed'
  // The owner cancelled the whole menu.
  | 'cancelled';

export type MenuProcessingState = {
  phase: MenuProcessingPhase;
  total: number;
  uploaded: number;
  finished: number;
  draftCount: number;
  // Jobs that can be retried (failed or incomplete, attempts left).
  retryable: string[];
  // Jobs whose dishes can be reviewed (complete or incomplete with drafts).
  reviewable: string[];
  errorCodes: string[];
};

const FINISHED = new Set<MenuJob['status']>(['complete', 'incomplete', 'failed', 'cancelled']);

export function menuProcessingState(jobs: readonly MenuJob[]): MenuProcessingState {
  const ordered = [...jobs].sort((a, b) => (a.upload_index ?? 0) - (b.upload_index ?? 0));
  const live = ordered.filter((job) => job.status !== 'cancelled');
  const uploaded = live.filter((job) => job.source_uploaded !== false).length;
  const finished = ordered.filter((job) => FINISHED.has(job.status)).length;
  const draftCount = live.reduce((sum, job) => sum + Math.max(0, job.draft_count), 0);
  const reviewable = live
    .filter(
      (job) => (job.status === 'complete' || job.status === 'incomplete') && job.draft_count > 0,
    )
    .map((job) => job.id);
  const retryable = live
    .filter(
      (job) =>
        (job.status === 'failed' || job.status === 'incomplete') &&
        job.attempt_count < job.max_attempts,
    )
    .map((job) => job.id);
  const errorCodes = [...new Set(live.flatMap((job) => (job.error_code ? [job.error_code] : [])))];

  let phase: MenuProcessingPhase;
  if (ordered.length > 0 && live.length === 0) phase = 'cancelled';
  else if (uploaded < live.length) phase = 'uploading';
  else if (live.some((job) => !FINISHED.has(job.status))) phase = 'processing';
  else if (live.every((job) => job.status === 'failed')) phase = 'failed';
  else if (draftCount === 0) phase = 'empty';
  else if (live.some((job) => job.status !== 'complete')) phase = 'partial';
  else phase = 'ready';

  return {
    phase,
    total: live.length,
    uploaded,
    finished,
    draftCount,
    retryable,
    reviewable,
    errorCodes,
  };
}

// Screen copy for the API's error codes. Unknown codes fall back to a generic message rather
// than showing the raw code.
const ERROR_COPY: Record<string, string> = {
  menu_file_link_required:
    'That page is not a single menu file. Paste a direct link to the PDF or image instead.',
  pdf_page_limit: 'This PDF has more than 10 pages. Upload a shorter PDF or a few photos.',
  invalid_pdf: 'This PDF could not be read. Try another file or add the dishes by hand.',
  file_too_large: 'Each file must be 12 MB or smaller.',
  unsupported_media_type: 'Use a PDF, or JPEG/PNG photos.',
  invalid_upload_selection: 'Choose one PDF, or one to five photos.',
  forbidden: 'You do not have permission to edit this restaurant’s menu.',
  unauthorized: 'Your session has ended. Sign in again to continue.',
  version_conflict: 'This dish changed somewhere else. Reload it to see the latest version.',
  network: 'You appear to be offline. Check your connection and try again.',
  timeout: 'The server did not answer in time. Check the job status, then try again.',
};

export function errorMessage(code: string): string {
  return ERROR_COPY[code] ?? 'Something went wrong. Try again, or add the dishes by hand.';
}
