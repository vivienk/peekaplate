import { describe, expect, it } from 'vitest';
import { calibratedPhotoDimensions } from './photo-dimensions';

// Synthetic, decodable 80 x 40 images; no owner photo or metadata.
const jpeg = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAoAFADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAT/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCQBHTgAAAAAAAAAAAAAAAAAAAAAAAAAAAH/9k=',
  'base64',
);
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAFAAAAAoCAIAAADmAupWAAAARUlEQVR42u3PQQEAQAQAMC6cEDIJfTE8bA2WPRWXvDhGWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWHjbBylyAXyxnjeSAAAAAElFTkSuQmCC',
  'base64',
);
type Endian = 'II' | 'MM';
type Entry = { tag: number; value: number; type?: number; count?: number };

function tiff(entries: Entry[], endian: Endian = 'II', offset = 8) {
  const result = Buffer.alloc(offset + 2 + entries.length * 12 + 4);
  const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
  const little = endian === 'II';
  result.write(endian);
  view.setUint16(2, 42, little);
  view.setUint32(4, offset, little);
  view.setUint16(offset, entries.length, little);
  entries.forEach(({ tag, value, type = 3, count = 1 }, index) => {
    const start = offset + 2 + index * 12;
    view.setUint16(start, tag, little);
    view.setUint16(start + 2, type, little);
    view.setUint32(start + 4, count, little);
    if (type === 3 && count === 1) view.setUint16(start + 8, value, little);
    else view.setUint32(start + 8, value, little);
  });
  return result;
}

function exif(orientation: number, endian: Endian = 'II') {
  return tiff([{ tag: 0x0112, value: orientation }], endian);
}

function app1(payload: Uint8Array) {
  const header = Buffer.from([0xff, 0xe1, 0, 0]);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

function jpegWith(segments: Uint8Array[], afterFrame = false) {
  const frame = jpeg.indexOf(Buffer.from([0xff, 0xc0]));
  const offset = afterFrame ? frame + 2 + jpeg.readUInt16BE(frame + 2) : 2;
  return Buffer.concat([jpeg.subarray(0, offset), ...segments, jpeg.subarray(offset)]);
}

function jpegExif(metadata: Uint8Array, afterFrame = false) {
  return jpegWith([app1(Buffer.concat([Buffer.from('Exif\0\0'), metadata]))], afterFrame);
}

function pngChunk(type: string, data: Uint8Array) {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length);
  result.write(type, 4);
  result.set(data, 8);
  let crc = 0xffffffff;
  for (const byte of result.subarray(4, result.length - 4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) * 0xedb88320);
  }
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}

function pngWith(chunks: Uint8Array[], afterData = false) {
  const offset = afterData ? png.length - 12 : 33;
  return Buffer.concat([png.subarray(0, offset), ...chunks, png.subarray(offset)]);
}

describe('calibrated photo dimensions', () => {
  it('uses the original dimensions when no EXIF orientation exists', () => {
    for (const [bytes, mime] of [
      [jpeg, 'image/jpeg'],
      [png, 'image/png'],
      [jpegExif(tiff([])), 'image/jpeg'],
      [pngWith([pngChunk('eXIf', tiff([]))]), 'image/png'],
    ] as const) {
      expect(calibratedPhotoDimensions(bytes, mime)).toEqual({ width: 80, height: 40 });
    }
  });

  for (const endian of ['II', 'MM'] as const) {
    for (const orientation of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const expected = orientation >= 5 ? { width: 40, height: 80 } : { width: 80, height: 40 };
      it(`matches EXIF transpose dimensions for JPEG orientation ${orientation}, ${endian}`, () => {
        expect(
          calibratedPhotoDimensions(jpegExif(exif(orientation, endian)), 'image/jpeg'),
        ).toEqual(expected);
      });
      it(`matches EXIF transpose dimensions for PNG orientation ${orientation}, ${endian}`, () => {
        expect(
          calibratedPhotoDimensions(
            pngWith([pngChunk('eXIf', exif(orientation, endian))]),
            'image/png',
          ),
        ).toEqual(expected);
      });
    }
  }

  it('reads JPEG EXIF after SOF and PNG EXIF after image data', () => {
    expect(calibratedPhotoDimensions(jpegExif(exif(6), true), 'image/jpeg')).toEqual({
      width: 40,
      height: 80,
    });
    expect(
      calibratedPhotoDimensions(pngWith([pngChunk('eXIf', exif(8))], true), 'image/png'),
    ).toEqual({
      width: 40,
      height: 80,
    });
  });

  it('uses the TIFF offset, including when the source is a byte-array view', () => {
    const source = jpegExif(tiff([{ tag: 0x0112, value: 6 }], 'MM', 16));
    const padded = Buffer.concat([Buffer.alloc(7, 0xff), source, Buffer.alloc(9, 0xff)]);
    const input = new Uint8Array(padded.buffer, padded.byteOffset + 7, source.length);
    const before = Buffer.from(input);
    expect(calibratedPhotoDimensions(input, 'image/jpeg')).toEqual({ width: 40, height: 80 });
    expect(Buffer.from(input)).toEqual(before);
  });

  it('ignores unrelated JPEG APP1 metadata and does not scan compressed image data', () => {
    const source = jpegWith([app1(Buffer.from('unrelated metadata'))]);
    const sos = source.indexOf(Buffer.from([0xff, 0xda]));
    const dataStart = sos + 2 + source.readUInt16BE(sos + 2);
    const bytes = Buffer.concat([
      source.subarray(0, dataStart),
      app1(Buffer.concat([Buffer.from('Exif\0\0'), exif(6)])),
      source.subarray(dataStart),
    ]);
    expect(calibratedPhotoDimensions(bytes, 'image/jpeg')).toEqual({ width: 80, height: 40 });
  });

  it.each([0, 9, 65535])('rejects an out-of-range orientation (%i)', (orientation) => {
    expect(() => calibratedPhotoDimensions(jpegExif(exif(orientation)), 'image/jpeg')).toThrow();
  });

  it.each([
    { type: 1, count: 1 },
    { type: 4, count: 1 },
    { type: 3, count: 0 },
    { type: 3, count: 2 },
    { type: 3, count: 0xffffffff },
  ])('rejects the wrong orientation type or count (%j)', ({ type, count }) => {
    const metadata = tiff([{ tag: 0x0112, value: 6, type, count }]);
    expect(() => calibratedPhotoDimensions(jpegExif(metadata), 'image/jpeg')).toThrow();
  });

  it('rejects duplicate EXIF carriers or root orientation tags, even when equal', () => {
    const segment = app1(Buffer.concat([Buffer.from('Exif\0\0'), exif(6)]));
    const chunk = pngChunk('eXIf', exif(6));
    const duplicate = tiff([
      { tag: 0x0112, value: 6 },
      { tag: 0x0112, value: 6 },
    ]);
    expect(() => calibratedPhotoDimensions(jpegWith([segment, segment]), 'image/jpeg')).toThrow();
    expect(() => calibratedPhotoDimensions(pngWith([chunk, chunk]), 'image/png')).toThrow();
    expect(() => calibratedPhotoDimensions(jpegExif(duplicate), 'image/jpeg')).toThrow();
  });

  it('rejects truncated TIFF, invalid byte order, BigTIFF, offsets, and directory counts', () => {
    const badOrder = exif(6);
    badOrder.write('ZZ');
    const bigTiff = exif(6);
    bigTiff.writeUInt16LE(43, 2);
    const headerOffset = exif(6);
    headerOffset.writeUInt32LE(2, 4);
    const largeOffset = exif(6);
    largeOffset.writeUInt32LE(0xffffffff, 4);
    const largeCount = exif(6);
    largeCount.writeUInt16LE(65535, 8);
    const badNextIfd = exif(6);
    badNextIfd.writeUInt32LE(0xffffffff, 22);
    const cyclicIfd = exif(6);
    cyclicIfd.writeUInt32LE(8, 22);
    for (const metadata of [
      Buffer.alloc(0),
      exif(6).subarray(0, 7),
      exif(6).subarray(0, 25),
      badOrder,
      bigTiff,
      headerOffset,
      largeOffset,
      largeCount,
      badNextIfd,
      cyclicIfd,
    ]) {
      expect(() => calibratedPhotoDimensions(jpegExif(metadata), 'image/jpeg')).toThrow();
      expect(() =>
        calibratedPhotoDimensions(pngWith([pngChunk('eXIf', metadata)]), 'image/png'),
      ).toThrow();
    }
  });

  it('checks the bounds of TIFF values stored outside the directory', () => {
    const valid = Buffer.concat([
      tiff([
        { tag: 0x010e, type: 2, count: 6, value: 38 },
        { tag: 0x0112, value: 6 },
      ]),
      Buffer.from('photo\0'),
    ]);
    expect(calibratedPhotoDimensions(jpegExif(valid), 'image/jpeg')).toEqual({
      width: 40,
      height: 80,
    });
    for (const offset of [0, 8, 0xffffffff]) {
      const invalid = Buffer.from(valid);
      invalid.writeUInt32LE(offset, 18);
      expect(() => calibratedPhotoDimensions(jpegExif(invalid), 'image/jpeg')).toThrow();
    }
  });

  it('uses the source orientation rather than a different thumbnail orientation', () => {
    const metadata = Buffer.concat([exif(1), exif(6).subarray(8)]);
    metadata.writeUInt32LE(26, 22);
    expect(calibratedPhotoDimensions(jpegExif(metadata), 'image/jpeg')).toEqual({
      width: 80,
      height: 40,
    });
    metadata.writeUInt16LE(6, 18);
    metadata.writeUInt16LE(1, 36);
    expect(calibratedPhotoDimensions(jpegExif(metadata), 'image/jpeg')).toEqual({
      width: 40,
      height: 80,
    });
  });

  it('bounds the linked TIFF directory count', () => {
    const metadata = Buffer.alloc(8 + 17 * 6);
    metadata.write('II');
    metadata.writeUInt16LE(42, 2);
    metadata.writeUInt32LE(8, 4);
    for (let index = 0; index < 16; index++) {
      metadata.writeUInt32LE(8 + (index + 1) * 6, 8 + index * 6 + 2);
    }
    expect(() => calibratedPhotoDimensions(jpegExif(metadata), 'image/jpeg')).toThrow();
  });

  it('rejects malformed JPEG segments after the dimensions frame', () => {
    for (const malformed of [
      Buffer.from([0xff, 0xe1, 0, 1]),
      Buffer.from([0xff, 0xe1, 0xff, 0xff]),
      Buffer.from([0xff, 0]),
      Buffer.from([7, 8, 9]),
      app1(Buffer.from('Exi')),
      app1(Buffer.from('Exif\0')),
      app1(Buffer.from('ExifXX')),
    ]) {
      expect(() => calibratedPhotoDimensions(jpegWith([malformed], true), 'image/jpeg')).toThrow();
    }
  });

  it('rejects competing image dimension headers', () => {
    const frame = jpeg.indexOf(Buffer.from([0xff, 0xc0]));
    const duplicateFrame = jpeg.subarray(frame, frame + 2 + jpeg.readUInt16BE(frame + 2));
    expect(() =>
      calibratedPhotoDimensions(jpegWith([duplicateFrame], true), 'image/jpeg'),
    ).toThrow();
    expect(() => calibratedPhotoDimensions(pngWith([png.subarray(8, 33)]), 'image/png')).toThrow();
  });

  it('fails closed for alternate metadata that Pillow can use for orientation', () => {
    const xmp = app1(Buffer.from('http://ns.adobe.com/xap/1.0/\0<tiff:Orientation>6'));
    expect(() => calibratedPhotoDimensions(jpegWith([xmp]), 'image/jpeg')).toThrow();
    for (const keyword of ['exif', 'Raw profile type exif', 'XML:com.adobe.xmp', 'xmp']) {
      for (const chunk of ['tEXt', 'zTXt', 'iTXt']) {
        const bytes = pngWith([pngChunk(chunk, Buffer.from(`${keyword}\0metadata`))]);
        expect(() => calibratedPhotoDimensions(bytes, 'image/png')).toThrow();
      }
    }
    expect(
      calibratedPhotoDimensions(
        pngWith([pngChunk('tEXt', Buffer.from('Description\0meal'))]),
        'image/png',
      ),
    ).toEqual({ width: 80, height: 40 });
  });

  it('retains the existing supported-format, byte-size, and image-structure bounds', () => {
    for (const mime of [
      'image/webp',
      'image/svg+xml',
      'image/avif',
      'image/jpeg; charset=binary',
    ]) {
      expect(() => calibratedPhotoDimensions(jpeg, mime)).toThrow();
    }
    expect(() => calibratedPhotoDimensions(png.subarray(0, png.length - 1), 'image/png')).toThrow();
    expect(() =>
      calibratedPhotoDimensions(jpeg.subarray(0, jpeg.length - 2), 'image/jpeg'),
    ).toThrow();
    const oversized = Buffer.alloc(12_000_001);
    png.copy(oversized);
    expect(() => calibratedPhotoDimensions(oversized, 'image/png')).toThrow();
  });
});
