// Ordering rules for the saved list (S3-DIN-02.1): newest saved first. Both functions return the
// same array when nothing changes, so callers can tell a no-op from a real change.

// Saving puts a dish first; saving an already saved dish leaves it where it is.
export function addNewest(dishIds: readonly string[], dishId: string): readonly string[] {
  return dishIds.includes(dishId) ? dishIds : [dishId, ...dishIds];
}

export function withoutDish(dishIds: readonly string[], dishId: string): readonly string[] {
  return dishIds.includes(dishId) ? dishIds.filter((id) => id !== dishId) : dishIds;
}
