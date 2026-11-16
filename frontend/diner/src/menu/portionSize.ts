import type { PublicPortion } from '@peekaplate/contracts';

// A serving count selects a calibration; it never multiplies a measured length.
export function sizeForServing(portion: Pick<PublicPortion, 'physical_size'>, count?: number) {
  const size = portion.physical_size;
  return Number.isInteger(count) && count! >= 1 && count! <= 100 && size?.serving_count === count
    ? size
    : undefined;
}

export function approximatePortionLabel(count?: number) {
  return `${count ? `Serves ${count} ${count === 1 ? 'person' : 'people'} · ` : ''}Approximate 2.5D preview — not actual size.`;
}
