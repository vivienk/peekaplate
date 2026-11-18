// Read dimensions from the exact approved bytes; never resize or regenerate owner branding.
export function logoDimensions(input: Uint8Array, contentType: string) {
  const bytes = Buffer.from(input);
  if (contentType === 'image/png') return { ...pngDimensions(bytes), extension: 'png' };
  if (
    contentType !== 'image/jpeg' ||
    bytes.length < 4 ||
    bytes.length > 12_000_000 ||
    bytes.readUInt16BE(0) !== 0xffd8 ||
    bytes.readUInt16BE(bytes.length - 2) !== 0xffd9
  )
    throw new Error('Invalid owner logo');
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset++] !== 0xff) break;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) break;
    if (
      [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
        marker!,
      )
    ) {
      if (length < 8) break;
      const height = bytes.readUInt16BE(offset + 3),
        width = bytes.readUInt16BE(offset + 5);
      if (!width || !height || width > 16384 || height > 16384) break;
      return { width, height, extension: 'jpg' };
    }
    offset += length;
  }
  throw new Error('Invalid owner logo');
}

function pngDimensions(bytes: Buffer) {
  if (
    bytes.length < 45 ||
    bytes.length > 12_000_000 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.toString('ascii', 12, 16) !== 'IHDR' ||
    bytes.readUInt32BE(8) !== 13
  )
    throw new Error('Invalid owner logo');
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20);
  if (!width || !height || width > 16384 || height > 16384) throw new Error('Invalid owner logo');
  let offset = 8,
    hasData = false,
    ended = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) break;
    const chunk = bytes.toString('ascii', offset + 4, offset + 8);
    if (chunk === 'IDAT') hasData = true;
    offset += length + 12;
    if (chunk === 'IEND') {
      ended = length === 0 && offset === bytes.length;
      break;
    }
  }
  if (!hasData || !ended) throw new Error('Invalid owner logo');
  return { width, height };
}
