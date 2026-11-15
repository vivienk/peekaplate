import { describe, expect, it } from 'vitest';
import {
  checkMenuFiles,
  FILE_NOT_SUPPORTED,
  FILE_TOO_LARGE,
  formatFileSize,
  isMenuUrl,
  menuFileKind,
  TOO_MANY_FILES,
} from './menu-source';

const file = (name: string, type: string, size = 15_000) =>
  new File([new Uint8Array(1)], name, { type, lastModified: 0 }) as File & { size: number };

// A File whose size is reported as given, without allocating it.
function sized(name: string, type: string, size: number): File {
  const f = file(name, type);
  Object.defineProperty(f, 'size', { value: size });
  return f;
}

describe('S07 menu link check (FE-06)', () => {
  it('accepts http and https addresses with a host', () => {
    expect(isMenuUrl('https://www.emberandstonerestaurant.com/diner-menu')).toBe(true);
    expect(isMenuUrl('  http://ember.example/menu  ')).toBe(true);
  });

  it('rejects addresses without http:// or https://, or without a proper host', () => {
    for (const value of [
      '',
      'htt//ember-stone..menu',
      'www.emberandstone.com',
      'ftp://ember.example/menu',
      'https://localhost/menu',
      'https://ember .example',
      'https://.example',
      'javascript:alert(1)',
    ]) {
      expect(isMenuUrl(value), value).toBe(false);
    }
  });
});

describe('S07 menu file checks (FE-06)', () => {
  it('knows images and PDFs, by type or by name when the type is missing', () => {
    expect(menuFileKind(file('a.jpeg', 'image/jpeg'))).toBe('image');
    expect(menuFileKind(file('a.png', 'image/png'))).toBe('image');
    expect(menuFileKind(file('a.pdf', 'application/pdf'))).toBe('pdf');
    expect(menuFileKind(file('a.PDF', ''))).toBe('pdf');
    expect(menuFileKind(file('a.gif', 'image/gif'))).toBeUndefined();
    expect(menuFileKind(file('a.pdf', 'text/plain'))).toBeUndefined();
  });

  it('turns away unsupported and over-12 MB files and keeps the others', () => {
    const good = file('menu.png', 'image/png');
    expect(checkMenuFiles([], [file('menu.gif', 'image/gif'), good])).toEqual({
      accepted: [good],
      problem: FILE_NOT_SUPPORTED,
    });
    expect(checkMenuFiles([], [sized('big.jpg', 'image/jpeg', 12_000_001)])).toEqual({
      accepted: [],
      problem: FILE_TOO_LARGE,
    });
    expect(
      checkMenuFiles([], [sized('max.jpg', 'image/jpeg', 12_000_000)]).problem,
    ).toBeUndefined();
  });

  it('allows up to five images, or one PDF on its own', () => {
    const images = Array.from({ length: 6 }, (_, i) => file(`p${i}.jpg`, 'image/jpeg'));
    const five = checkMenuFiles([], images);
    expect(five.accepted).toHaveLength(5);
    expect(five.problem).toBe(TOO_MANY_FILES);
    expect(checkMenuFiles(['image'], [file('m.pdf', 'application/pdf')]).problem).toBe(
      TOO_MANY_FILES,
    );
    expect(checkMenuFiles(['pdf'], [file('p.jpg', 'image/jpeg')]).problem).toBe(TOO_MANY_FILES);
    expect(checkMenuFiles([], [file('m.pdf', 'application/pdf')]).problem).toBeUndefined();
  });

  it('shows sizes in decimal units', () => {
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(15_000)).toBe('15 KB');
    expect(formatFileSize(2_400_000)).toBe('2.4 MB');
    expect(formatFileSize(12_000_000)).toBe('12 MB');
  });
});
