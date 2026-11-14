// FE-06 S07: the browser-side checks for the menu link and the menu files (Amr's S07 handoff, URL
// and Files). The screens send nothing themselves; the caller imports the link and uploads the
// files, and the server makes the final decision (for example the 10-page PDF limit, which the
// browser cannot count).

// The link must be a web address starting with http:// or https:// and naming a host with a dot
// (S07 URL handoff, section 4). The tick shows the format only; whether the page can be read is
// the server's answer.
export function isMenuUrl(raw: string): boolean {
  const value = raw.trim();
  if (!/^https?:\/\//i.test(value) || /\s/.test(value)) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.hostname.includes('.') &&
      !url.hostname.startsWith('.') &&
      !url.hostname.endsWith('.')
    );
  } catch {
    return false;
  }
}

// JPEG or PNG images, or a PDF: up to 5 images or 1 PDF, 12 MB per file (S07 Files handoff,
// section 1).
export const MENU_IMAGE_TYPES = ['image/jpeg', 'image/png'] as const;
export const MENU_PDF_TYPE = 'application/pdf';
export const MENU_FILE_ACCEPT = [
  ...MENU_IMAGE_TYPES,
  MENU_PDF_TYPE,
  '.jpg',
  '.jpeg',
  '.png',
  '.pdf',
];
export const MAX_MENU_FILE_BYTES = 12_000_000;
export const MAX_MENU_IMAGES = 5;

export type MenuFileKind = 'image' | 'pdf';

export const FILE_NOT_SUPPORTED = 'File not supported';
export const FILE_TOO_LARGE = 'This file is too large. Choose a file that is 12 MB or smaller.';
// No frame shows the count rule being broken; this follows the helper text. Flagged in the PR.
export const TOO_MANY_FILES = 'Upload up to 5 images or 1 PDF.';

// Some browsers leave the type empty for a dropped file; the name's ending decides then.
export function menuFileKind(file: Pick<File, 'name' | 'type'>): MenuFileKind | undefined {
  const type = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  if ((MENU_IMAGE_TYPES as readonly string[]).includes(type)) return 'image';
  if (type === MENU_PDF_TYPE) return 'pdf';
  if (type) return undefined;
  if (/\.(jpe?g|png)$/.test(name)) return 'image';
  if (name.endsWith('.pdf')) return 'pdf';
  return undefined;
}

export type MenuFileCheck = { accepted: File[]; problem?: string };

// Checks newly chosen files against the ones already on the screen. Files that break a rule are
// not uploaded and the first problem is shown; the others are still added.
export function checkMenuFiles(
  existing: readonly MenuFileKind[],
  incoming: readonly File[],
): MenuFileCheck {
  const kinds = [...existing];
  const accepted: File[] = [];
  let problem: string | undefined;
  for (const file of incoming) {
    const kind = menuFileKind(file);
    const issue = !kind
      ? FILE_NOT_SUPPORTED
      : file.size > MAX_MENU_FILE_BYTES
        ? FILE_TOO_LARGE
        : fitsWith(kinds, kind)
          ? undefined
          : TOO_MANY_FILES;
    if (issue || !kind) {
      problem ??= issue;
      continue;
    }
    kinds.push(kind);
    accepted.push(file);
  }
  return problem ? { accepted, problem } : { accepted };
}

// One PDF on its own, or up to five images.
function fitsWith(kinds: readonly MenuFileKind[], kind: MenuFileKind): boolean {
  if (kinds.length === 0) return true;
  if (kind === 'pdf' || kinds.includes('pdf')) return false;
  return kinds.length < MAX_MENU_IMAGES;
}

// "15 KB", "2.4 MB": decimal units, as the 12 MB limit is stated.
export function formatFileSize(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1_000)} KB`;
  const megabytes = bytes / 1_000_000;
  return `${megabytes < 10 ? megabytes.toFixed(1) : Math.round(megabytes)} MB`;
}
