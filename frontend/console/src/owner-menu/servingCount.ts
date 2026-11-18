// Pure form adapters shared by the authenticated editor and synthetic review demos.
// The narrow contract import keeps live report/auth schema modules out of demo bundles.
import {
  type PlateCalibration,
  parseServingCountInput,
  resolveServingCount,
} from '@peekaplate/contracts/portion';

// An explicit count, including null, is authoritative. Bare legacy numbers are recovered only
// without calibration: an older calibrated "28" may have meant centimetres, not people.
export function servingCountText(
  count: number | null | undefined,
  legacy: string | null | undefined,
  calibration?: PlateCalibration | null,
): string {
  const resolved = resolveServingCount(count, legacy, calibration);
  return resolved == null ? '' : String(resolved);
}

export function servingCountValue(value: string): number | null {
  if (!value.trim()) return null;
  const count = parseServingCountInput(value);
  if (count === undefined)
    throw new Error('Serving size must be a whole number of people from 1 to 100.');
  return count;
}
