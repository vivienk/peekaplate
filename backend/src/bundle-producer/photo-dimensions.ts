import { logoDimensions } from './logo-image';

const EXIF_HEADER = Buffer.from('Exif\0\0');
const XMP_HEADERS = [
  Buffer.from('http://ns.adobe.com/xap/1.0/\0'),
  Buffer.from('http://ns.adobe.com/xmp/extension/\0'),
];
const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);
const TIFF_TYPE_BYTES = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4];
const ALTERNATE_PNG_ORIENTATION = new Set([
  'exif',
  'Raw profile type exif',
  'XML:com.adobe.xmp',
  'xmp',
]);

// Calibration alone needs the same oriented dimensions as ImageOps.exif_transpose.
// The existing photo validator supplies format, byte-size, and raw-dimension bounds.
export function calibratedPhotoDimensions(
  input: Uint8Array,
  contentType: string,
): { width: number; height: number } {
  if (input.byteLength > 12_000_000) invalidMetadata();
  const { width, height } = logoDimensions(input, contentType);
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const orientation = contentType === 'image/png' ? pngOrientation(bytes) : jpegOrientation(bytes);
  return orientation >= 5 ? { width: height, height: width } : { width, height };
}

function invalidMetadata(): never {
  throw new Error('Invalid calibration photo metadata');
}

function requireRange(bytes: Buffer, offset: number, length: number) {
  if (offset < 0 || length < 0 || offset > bytes.length - length) invalidMetadata();
}

function jpegOrientation(bytes: Buffer) {
  let offset = 2;
  let orientation: number | undefined;
  let frames = 0;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) invalidMetadata();
    while (bytes[offset] === 0xff) offset++;
    requireRange(bytes, offset, 1);
    const marker = bytes.readUInt8(offset++);
    if (marker === 0xd9) {
      if (offset !== bytes.length || frames !== 1) invalidMetadata();
      return orientation ?? 1;
    }
    if (marker === 0x01) continue;
    if (marker === 0 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) invalidMetadata();
    requireRange(bytes, offset, 2);
    const length = bytes.readUInt16BE(offset);
    if (length < 2) invalidMetadata();
    requireRange(bytes, offset, length);
    if (marker === 0xda) {
      if (frames !== 1) invalidMetadata();
      return orientation ?? 1;
    }
    if (SOF_MARKERS.has(marker) && ++frames !== 1) invalidMetadata();
    if (marker === 0xe1) {
      const payload = bytes.subarray(offset + 2, offset + length);
      // Pillow can fall back to XMP orientation. Do not guess without parsing XML.
      if (XMP_HEADERS.some((header) => payload.subarray(0, header.length).equals(header))) {
        invalidMetadata();
      }
      const prefixLength = Math.min(4, payload.length);
      if (
        prefixLength > 0 &&
        payload.subarray(0, prefixLength).equals(EXIF_HEADER.subarray(0, prefixLength))
      ) {
        if (!payload.subarray(0, 6).equals(EXIF_HEADER) || orientation !== undefined) {
          invalidMetadata();
        }
        orientation = tiffOrientation(payload.subarray(6));
      }
    }
    offset += length;
  }
  return invalidMetadata();
}

function pngOrientation(bytes: Buffer) {
  let orientation: number | undefined;
  let headers = 0;
  let offset = 8;
  while (offset < bytes.length) {
    requireRange(bytes, offset, 12);
    const length = bytes.readUInt32BE(offset);
    requireRange(bytes, offset + 8, length + 4);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    const payload = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR' && (++headers !== 1 || offset !== 8)) invalidMetadata();
    if (type === 'eXIf') {
      if (orientation !== undefined) invalidMetadata();
      orientation = tiffOrientation(payload);
    }
    if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
      // Reject alternate EXIF/XMP carriers without decompressing untrusted text.
      const keyword = payload.subarray(0, 80);
      const end = keyword.indexOf(0);
      if (
        ALTERNATE_PNG_ORIENTATION.has(
          keyword.subarray(0, end < 0 ? keyword.length : end).toString('latin1'),
        )
      ) {
        invalidMetadata();
      }
    }
    offset += length + 12;
  }
  if (headers !== 1) invalidMetadata();
  return orientation ?? 1;
}

function tiffOrientation(bytes: Buffer) {
  requireRange(bytes, 0, 8);
  const byteOrder = bytes.toString('latin1', 0, 2);
  if (byteOrder !== 'II' && byteOrder !== 'MM') invalidMetadata();
  const little = byteOrder === 'II';
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(2, little) !== 42) invalidMetadata();
  const firstIfd = view.getUint32(4, little);
  if (firstIfd < 8) invalidMetadata();
  let offset = firstIfd;
  let orientation: number | undefined;
  const directories: { start: number; end: number }[] = [];
  // Ordinary EXIF has IFD0 and optionally a thumbnail IFD. Bound the chain and
  // reject cycles/overlap; only IFD0 orientation can affect the source image.
  while (offset !== 0) {
    if (directories.length >= 16 || offset < 8 || offset % 2 !== 0) invalidMetadata();
    requireRange(bytes, offset, 2);
    const count = view.getUint16(offset, little);
    const end = offset + 2 + count * 12 + 4;
    requireRange(bytes, offset, end - offset);
    if (directories.some((directory) => offset < directory.end && end > directory.start)) {
      invalidMetadata();
    }
    directories.push({ start: offset, end });
    for (let index = 0; index < count; index++) {
      const entry = offset + 2 + index * 12;
      const tag = view.getUint16(entry, little);
      const type = view.getUint16(entry + 2, little);
      const values = view.getUint32(entry + 4, little);
      const unitBytes = TIFF_TYPE_BYTES[type];
      if (!unitBytes) invalidMetadata();
      const valueBytes = values * unitBytes;
      if (valueBytes > 4) {
        const valueOffset = view.getUint32(entry + 8, little);
        requireRange(bytes, valueOffset, valueBytes);
        if (valueOffset < 8 || (valueOffset < end && valueOffset + valueBytes > offset)) {
          invalidMetadata();
        }
      }
      if (tag === 0x0112 && offset === firstIfd) {
        if (orientation !== undefined || type !== 3 || values !== 1) invalidMetadata();
        orientation = view.getUint16(entry + 8, little);
        if (orientation < 1 || orientation > 8) invalidMetadata();
      }
    }
    offset = view.getUint32(end - 4, little);
  }
  return orientation ?? 1;
}
