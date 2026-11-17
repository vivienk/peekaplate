import {
  type PlateCalibration,
  PlateCalibrationSchema,
  parseServingDimensions,
} from '@peekaplate/contracts';
import { sha256Hex } from './api';

export type CalibrationPhoto = Pick<
  PlateCalibration,
  'source_sha256' | 'source_width_px' | 'source_height_px'
> & { photoId: string; url: string };

export function calibrationMatchesPhoto(
  calibration: PlateCalibration | null | undefined,
  photo: CalibrationPhoto | undefined,
): boolean {
  return Boolean(
    calibration &&
      photo &&
      calibration.source_sha256 === photo.source_sha256 &&
      calibration.source_width_px === photo.source_width_px &&
      calibration.source_height_px === photo.source_height_px,
  );
}

export function confirmedPhotoCalibration(
  servingSize: string,
  photo: CalibrationPhoto | undefined,
  boundary: PlateCalibration['boundary'],
): PlateCalibration | undefined {
  const dimensions = parseServingDimensions(servingSize);
  if (!photo || !dimensions) return undefined;
  const result = PlateCalibrationSchema.safeParse({
    ...dimensions,
    source_sha256: photo.source_sha256,
    source_width_px: photo.source_width_px,
    source_height_px: photo.source_height_px,
    boundary,
    confirmed: true,
  });
  return result.success ? result.data : undefined;
}

// The caller owns the authenticated original Blob and its object URL. No preview bytes are used.
export async function readCalibrationPhoto(
  blob: Blob,
  photoId: string,
  url: string,
  signal: AbortSignal,
): Promise<CalibrationPhoto> {
  signal.throwIfAborted();
  const image = new Image();
  let abort: (() => void) | undefined;
  try {
    const decoded = new Promise<{ width: number; height: number }>((resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      image.onload = () => {
        const width = image.naturalWidth;
        const height = image.naturalHeight;
        if (!width || !height || width * height > 24_000_000)
          reject(new Error('Original photo dimensions unavailable'));
        else resolve({ width, height });
      };
      image.onerror = () => reject(new Error('Original photo could not be decoded'));
      image.src = url;
    });
    const [sha256, { width, height }] = await Promise.all([sha256Hex(blob), decoded]);
    signal.throwIfAborted();
    return {
      photoId,
      url,
      source_sha256: sha256,
      source_width_px: width,
      source_height_px: height,
    };
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
    image.onload = null;
    image.onerror = null;
    image.removeAttribute('src');
  }
}
