// The P0 event allowlist (S3-TRK-01.1). Any other name is dropped locally and nothing is sent: no
// events for search, toasts, chips, placeholders or the Portion control.
export const P0_EVENT_NAMES = [
  'menu_viewed',
  'dish_viewed',
  'dish_detail_opened',
  'dish_activity_checkpoint',
  'dish_compared',
  'dish_saved',
  'dish_unsaved',
  'shortlist_viewed',
] as const;

export type P0EventName = (typeof P0_EVENT_NAMES)[number];

// dish_detail_closed exists in observation.v2 but joins only if adopted for P0 (open decision 3).
const allowed = new Set<string>(P0_EVENT_NAMES);

export function isAllowedEvent(name: string): name is P0EventName {
  return allowed.has(name);
}
