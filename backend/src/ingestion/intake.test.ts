import { describe, expect, it } from 'vitest';
import { validateMenuPdf, validateUploadSelection } from './intake';
import { menuPdfFixture } from './pdf-fixture';
import { readMenuUpload } from './upload';

const photo = () => ({ sourceType: 'photo' as const, sourceHash: 'a'.repeat(64) });
const pdf = () => ({ sourceType: 'pdf' as const, sourceHash: 'b'.repeat(64) });
describe('one owner upload selection', () => {
  it('allows five images or one PDF; rejects empty, mixed and oversized selections', () => {
    expect(() => validateUploadSelection(Array.from({ length: 5 }, photo))).not.toThrow();
    expect(() => validateUploadSelection([pdf()])).not.toThrow();
    for (const files of [[], Array.from({ length: 6 }, photo), [photo(), pdf()], [pdf(), pdf()]]) {
      expect(() => validateUploadSelection(files)).toThrow('invalid_upload_selection');
    }
  });
  it('accepts ten real PDF pages and rejects eleven pages or a corrupt PDF', async () => {
    for (const pages of [1, 10, 11]) {
      const upload = await readMenuUpload(
        new Request('https://test/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/pdf', 'Idempotency-Key': 'test-upload-key-123' },
          body: menuPdfFixture(pages) as BodyInit,
        }),
      );
      if (pages === 11)
        await expect(validateMenuPdf(upload)).rejects.toMatchObject({ code: 'pdf_page_limit' });
      else await expect(validateMenuPdf(upload)).resolves.toBeUndefined();
    }
    const corrupt = await readMenuUpload(
      new Request('https://test/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/pdf', 'Idempotency-Key': 'test-upload-key-123' },
        body: '%PDF-1.7 broken',
      }),
    );
    await expect(validateMenuPdf(corrupt)).rejects.toMatchObject({ code: 'invalid_pdf' });
  });
});
