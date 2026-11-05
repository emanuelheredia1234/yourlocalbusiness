// Before the app posts a file through a connected account, it must be in the account's storage (the server
// reads it there): ensureUploaded saves it now if needed and waits for that one file. Instagram takes JPEG
// only: ensureJpegVariant keeps a JPEG original, and otherwise needs a browser to convert.
import { describe, expect, it, vi } from 'vitest';
import { putBlob } from '@/lib/storage';
import { createMediaSync, ensureJpegVariant, ensureUploaded, jpegVariantId } from './media';

function fakeClient() {
  const stored = new Map<string, Blob>();
  const upload = vi.fn(async (path: string, body: Blob) => {
    stored.set(path, body);
    return { error: null };
  });
  const client = {
    storage: {
      from: () => ({
        upload,
        download: async (path: string) => ({ data: stored.get(path) ?? null, error: stored.has(path) ? null : { message: 'not found' } }),
        remove: async () => ({ error: null }),
        list: async () => ({ data: [], error: null }),
      }),
    },
  };
  return { client, stored, upload };
}

describe('ensureUploaded', () => {
  it('is false when signed out', async () => {
    expect(await ensureUploaded('media_none', 50)).toBe(false);
  });

  it('saves the file to the account and waits for it', async () => {
    const { client, stored, upload } = fakeClient();
    const sync = createMediaSync(client, 'user_1');
    sync.start();
    await putBlob('media_up', new Blob(['abc'], { type: 'image/png' }));
    expect(await ensureUploaded('media_up', 5000)).toBe(true);
    expect(stored.has('user_1/media_up')).toBe(true);
    expect(upload).toHaveBeenCalled();
    expect(await ensureUploaded('bad/id', 50)).toBe(false);
    sync.dispose();
    // the account's sync is gone (signed out): nothing to post from
    expect(await ensureUploaded('media_up', 50)).toBe(false);
  });
});

describe('ensureJpegVariant', () => {
  it('keeps a JPEG as it is, and names the copy of anything else', async () => {
    expect(await ensureJpegVariant('media_jpg', 'image/jpeg')).toBe('media_jpg');
    await putBlob('media_j2', new Blob(['x'], { type: 'image/jpeg' }));
    expect(await ensureJpegVariant('media_j2')).toBe('media_j2');
    expect(jpegVariantId('media_png')).toBe('media_png-jpg');
    // no browser here to convert: null (the confirm then says nothing was sent)
    await putBlob('media_png', new Blob(['x'], { type: 'image/png' }));
    expect(await ensureJpegVariant('media_png', 'image/png')).toBeNull();
    // a copy made earlier is used
    await putBlob('media_png-jpg', new Blob(['y'], { type: 'image/jpeg' }));
    expect(await ensureJpegVariant('media_png', 'image/png')).toBe('media_png-jpg');
  });
});
