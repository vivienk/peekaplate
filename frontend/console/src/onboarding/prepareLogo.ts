import { photoError } from './details';
// Decode the owner's JPEG/PNG, preserve the whole logo, and cap storage/transfer size.
// The diner fits this normalized image into its responsive header without distortion.
export async function prepareLogo(file: File): Promise<string> {
  const error = photoError(file);
  if (error) throw new Error(error);
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 1024 / bitmap.width, 512 / bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Image processing unavailable');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL('image/png').split(',')[1];
    if (!data || data.length > 1_333_336) throw new Error('Please choose a smaller logo image');
    return data;
  } finally {
    bitmap.close();
  }
}
