import type { PublicPortion } from '@peekaplate/contracts';

// Measurements set scale. An optional people count must match the approved
// calibration when present, but never multiplies a measured length.
export function sizeForServing(portion: Pick<PublicPortion, 'physical_size'>, count?: number) {
  const size = portion.physical_size;
  const validCount = count === undefined || (Number.isInteger(count) && count >= 1 && count <= 100);
  return validCount && size?.serving_count === count ? size : undefined;
}

export function approximatePortionLabel(
  count?: number,
  portion?: Pick<PublicPortion, 'physical_size'>,
) {
  const size = sizeForServing(portion ?? {}, count);
  const measurement = size
    ? `Plate size: ${size.plate.width_mm / 10} × ${size.plate.depth_mm / 10} cm · `
    : '';
  return `${count ? `Serves ${count} ${count === 1 ? 'person' : 'people'} · ` : ''}${measurement}Approximate 2.5D preview — not actual size.`;
}
