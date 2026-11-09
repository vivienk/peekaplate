// Event ID helpers (S3-TRK-01.1, decision 1). The layer makes every ID the same way; the screens
// decide when a new one starts and keep it: exposure_id per dish_viewed (sent back as
// from_exposure_id), opening_id per displayed detail (reused for its checkpoints), comparison_id
// per comparison (kept across Replace). Lowercase UUIDs, as observation.v2 expects.
const uuid = (): string => crypto.randomUUID();

export const newExposureId = uuid;
export const newOpeningId = uuid;
export const newComparisonId = uuid;
