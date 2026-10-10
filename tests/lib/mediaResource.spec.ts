import { describe, it, expect } from 'vitest';
import { MediaUpdateSchema, MediaWriteSchema } from '@schemas/admin';
import {
  decodeMediaMeta,
  encodeMediaMeta,
  MediaReplaceMetaSchema,
  MediaUploadMetaSchema,
  parseStorageKey,
} from '@schemas/media';
import { mediaResource } from '@/lib/admin/resources/media';
import type { AuthContext } from '@/lib/auth/types';

// Admin v2 U3: an uploaded image's row is written by the upload and replace routes only.
// The generic media routes may not create one, nor change its file (the form restates every
// field, so an unchanged value must still pass). The upload's details travel in one header.

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEY = `${TENANT}/33333333-3333-4333-8333-333333333333_640x480.webp`;
const auth: AuthContext = {
  userId: '11111111-1111-4111-8111-111111111111',
  tenantId: TENANT,
  role: 'admin',
  isActive: true,
  email: 'a@example.test',
};

/** The stored row the resource re-reads (its file columns). */
function storedClient(row: Record<string, unknown>) {
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'eq']) b[m] = () => b;
  b['maybeSingle'] = async () => ({ data: row, error: null });
  return { from: () => b } as never;
}

const UPLOADED = {
  id: '22222222-2222-4222-8222-222222222222',
  provider: 'storage',
  storage_path: KEY,
  kind: 'image',
  width: 640,
  height: 480,
  mime_type: 'image/webp',
  size_bytes: 1234,
  stream_uid: null,
};

async function write(changed: Record<string, unknown>, stored = UPLOADED) {
  const sb = storedClient(stored);
  return mediaResource.assertWritable!({ ...stored, ...changed }, { auth, sb, changed });
}

describe('the generic media routes and uploaded images', () => {
  it('the schemas refuse provider "storage" (created by uploading, never by hand)', () => {
    const typed = { kind: 'image', provider: 'storage', storagePath: KEY };
    expect(MediaWriteSchema.safeParse(typed).success).toBe(false);
    expect(MediaUpdateSchema.safeParse({ provider: 'storage', version: 1 }).success).toBe(false);
  });

  it('the full form restating an uploaded image unchanged is accepted', async () => {
    await expect(
      write({
        kind: 'image',
        storage_path: KEY,
        width: 640,
        height: 480,
        stream_uid: '',
        folder: 'reel',
      }),
    ).resolves.toBeUndefined();
  });

  it('changing its file through the form is refused (replace instead)', async () => {
    const other = `${TENANT}/44444444-4444-4444-8444-444444444444_640x480.webp`;
    await expect(write({ storage_path: other })).rejects.toMatchObject({
      field: 'storagePath',
    });
    await expect(write({ width: 641 })).rejects.toMatchObject({ field: 'width' });
    await expect(write({ provider: 'static', storage_path: 'stills/work/p0.jpg' })).rejects.toThrow(
      /Replace/,
    );
  });

  it('turning another asset into an uploaded image is refused', async () => {
    await expect(
      write({ provider: 'storage' }, { ...UPLOADED, provider: 'external' }),
    ).rejects.toMatchObject({ field: 'provider' });
  });

  it('a thumbnail for an uploaded image goes through /_image', () => {
    const row = mediaResource.fromRow!({ provider: 'storage', storage_path: KEY });
    expect(String(row['thumb_url'])).toMatch(/^\/_image\?href=https%3A%2F%2F/);
    expect(mediaResource.fromRow!({ provider: 'external', storage_path: 'x' })['thumb_url']).toBe(
      null,
    );
  });
});

describe('the upload details header and the object key', () => {
  it('round-trips Arabic through the header', () => {
    const meta = { alt: { en: 'A rider', ar: 'راكب عند الغروب' }, tags: ['ريل'] };
    const header = encodeMediaMeta(meta);
    expect(header).toMatch(/^[\x21-\x7e]+$/); // a header value: printable ASCII only
    expect(MediaUploadMetaSchema.parse(decodeMediaMeta(header))).toEqual({ ...meta });
  });

  it('refuses what is not readable, too long, or not the contract', () => {
    expect(decodeMediaMeta(null)).toBeUndefined();
    expect(decodeMediaMeta('%E0%A4%A')).toBeUndefined();
    expect(decodeMediaMeta('x'.repeat(8193))).toBeUndefined();
    expect(MediaUploadMetaSchema.safeParse({ alt: { en: 'x', ar: ' ' } }).success).toBe(false);
    expect(
      MediaUploadMetaSchema.safeParse({ alt: { en: 'x', ar: 'س' }, displayName: '../etc' }).success,
    ).toBe(false);
    expect(MediaReplaceMetaSchema.safeParse({ version: 0 }).success).toBe(false);
    expect(MediaReplaceMetaSchema.safeParse({ version: 2, alt: {} }).success).toBe(false);
  });

  it('parses exactly the keys the upload writes', () => {
    expect(parseStorageKey(KEY)).toEqual({
      tenantId: TENANT,
      objectId: '33333333-3333-4333-8333-333333333333',
      width: 640,
      height: 480,
    });
    for (const bad of [
      `${TENANT}/33333333-3333-4333-8333-333333333333_640x480.jpg`,
      `${TENANT}/33333333-3333-4333-8333-333333333333_3000x2000.webp`,
      `${TENANT}/33333333-3333-4333-8333-333333333333_0640x480.webp`,
      `${TENANT}/../33333333-3333-4333-8333-333333333333_640x480.webp`,
      `x/${TENANT}/33333333-3333-4333-8333-333333333333_640x480.webp`,
      `${TENANT.toUpperCase()}/33333333-3333-4333-8333-333333333333_640x480.webp`,
    ]) {
      expect(parseStorageKey(bad), bad).toBeNull();
    }
  });
});
