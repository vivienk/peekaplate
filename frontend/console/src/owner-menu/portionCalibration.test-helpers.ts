import type { PlateCalibration } from '@peekaplate/contracts';

export const calibrationPhotoId = '11111111-1111-4111-8111-111111111111';
export const confirmedCalibration: PlateCalibration = {
  shape: 'round',
  width_mm: 280,
  depth_mm: 280,
  source_sha256: 'a'.repeat(64),
  source_width_px: 640,
  source_height_px: 480,
  boundary: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
  confirmed: true,
};
