import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../index';
import type { MenuIngestionJobRow } from './repository';
import { MAX_MENU_UPLOAD_BYTES, readMenuUpload, storeAndDispatchUpload } from './upload';

const venue = '00000000-0000-4000-8000-000000000001';
const id = '00000000-0000-4000-8000-000000000002';
const request = (body: Uint8Array | string = '%PDF-1.7 synthetic') =>
  new Request('https://test/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/pdf', 'Idempotency-Key': 'synthetic-upload-001' },
    body: body as BodyInit,
  });

describe('owner source upload', () => {
  it('hashes the actual bytes and validates format and streaming size', async () => {
    const upload = await readMenuUpload(request());
    expect(upload.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(upload.sourceType).toBe('pdf');
    await expect(readMenuUpload(request('not a PDF'))).rejects.toMatchObject({
      code: 'invalid_upload_format',
    });
    await expect(
      readMenuUpload(request(new Uint8Array(MAX_MENU_UPLOAD_BYTES + 1))),
    ).rejects.toMatchObject({ code: 'body_too_large' });
  });
  it('stores the job-scoped bytes before dispatch, and never dispatches after storage failure', async () => {
    const upload = await readMenuUpload(request());
    const job = {
      id,
      tenant_id: venue,
      source_hash: upload.sourceHash,
      source_storage_key: `menu-ingestion/sources/${venue}/${id}/source`,
    } as MenuIngestionJobRow;
    const order: string[] = [];
    const put = vi.fn(async () => {
      order.push('stored');
    });
    const send = vi.fn(async () => {
      order.push('queued');
    });
    await storeAndDispatchUpload(venue, upload, async () => job, { put }, { send });
    expect(order).toEqual(['stored', 'queued']);
    send.mockClear();
    await expect(
      storeAndDispatchUpload(
        venue,
        upload,
        async () => job,
        {
          put: async () => {
            throw new Error('storage failure');
          },
        },
        { send },
      ),
    ).rejects.toThrow('storage failure');
    expect(send).not.toHaveBeenCalled();
    await expect(
      storeAndDispatchUpload(
        venue,
        upload,
        async () => ({ ...job, tenant_id: id }),
        { put },
        { send },
      ),
    ).rejects.toMatchObject({ code: 'upload_scope_mismatch' });
    expect(send).not.toHaveBeenCalled();
  });
  it('rejects unauthorized uploads and remains disabled in production', async () => {
    const verify = vi.fn(async () => id);
    const authorizeVenue = vi.fn(async () => {
      throw new Error('forbidden');
    });
    const app = createApp({ verify, authorizeVenue, execute: vi.fn() });
    const url = `https://test/venues/${venue}/menus/uploads`;
    expect((await app.request(url, { method: 'POST' }, { APP_ENV: 'production' })).status).toBe(
      404,
    );
    expect((await app.request(url, { method: 'POST' }, { APP_ENV: 'staging' })).status).toBe(401);
    expect(verify).not.toHaveBeenCalled();
    const storage = { put: vi.fn() };
    await app.request(
      url,
      { method: 'POST', headers: { Authorization: 'Bearer test' }, body: '%PDF-test' },
      { APP_ENV: 'staging', INGESTION_REPORTS_BUCKET: storage },
    );
    expect(authorizeVenue).toHaveBeenCalledOnce();
    expect(storage.put).not.toHaveBeenCalled();
  });
});
