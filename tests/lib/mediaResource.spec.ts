import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { MediaUpdateSchema, MediaWriteSchema } from '@schemas/admin';
import {
  decodeMediaMeta,
  encodeMediaMeta,
  MEDIA_META_LIMITS,
  MEDIA_META_MAX_LENGTH,
  MediaDisplayNameSchema,
  MediaReplaceMetaSchema,
  MediaUploadMetaSchema,
  MEDIA_MAX_ASPECT,
  parseStorageKey,
} from '@schemas/media';
import { mediaResource } from '@/lib/admin/resources/media';
import { translateWriteError } from '@/lib/admin/crud';
import { readMediaMeta } from '@/lib/admin/mediaUpload';
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

  it('every valid set of details fits the header, in the costliest script, and reads back', () => {
    // A BMP character past U+07FF is three bytes of UTF-8, the most any accepted UTF-16 unit
    // costs (Arabic takes two; a quote is escaped into two). Each field at the schema's maximum.
    for (const ch of ['中', 'ش', '"']) {
      const fill = (n: number) => ch.repeat(n);
      const meta = {
        alt: { en: fill(MEDIA_META_LIMITS.alt), ar: fill(MEDIA_META_LIMITS.alt) },
        displayName: fill(MEDIA_META_LIMITS.displayName),
        tags: Array.from({ length: MEDIA_META_LIMITS.tags }, () => fill(MEDIA_META_LIMITS.tag)),
        folder: fill(MEDIA_META_LIMITS.folder),
      };
      expect(MediaUploadMetaSchema.safeParse(meta).success, ch).toBe(true);
      const header = encodeMediaMeta(meta);
      expect(header.length, ch).toBeLessThanOrEqual(MEDIA_META_MAX_LENGTH);
      expect(header).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(decodeMediaMeta(header), ch).toEqual(meta);
      // ...and those maxima are the schema's: one unit more is refused, field by field.
      const over = (patch: Record<string, unknown>) =>
        MediaUploadMetaSchema.safeParse({ ...meta, ...patch }).success;
      expect(over({ alt: { ...meta.alt, en: fill(MEDIA_META_LIMITS.alt + 1) } })).toBe(false);
      expect(over({ displayName: fill(MEDIA_META_LIMITS.displayName + 1) })).toBe(false);
      expect(over({ tags: [...meta.tags, 'x'] })).toBe(false);
      expect(over({ tags: [fill(MEDIA_META_LIMITS.tag + 1)] })).toBe(false);
      expect(over({ folder: fill(MEDIA_META_LIMITS.folder + 1) })).toBe(false);
    }
  });

  it('details hold no control character or lone surrogate (what bounds the header)', () => {
    const base = { alt: { en: 'x', ar: 'س' } };
    for (const bad of ['\u0001', '\u0085', '\u2028', '\ud800', '\n']) {
      const label = JSON.stringify(bad);
      expect(MediaUploadMetaSchema.safeParse({ ...base, tags: [`a${bad}b`] }).success, label).toBe(
        false,
      );
      expect(MediaUploadMetaSchema.safeParse({ ...base, folder: `a${bad}b` }).success, label).toBe(
        false,
      );
      expect(MediaUploadMetaSchema.safeParse({ alt: { en: `a${bad}b`, ar: 'س' } }).success).toBe(
        false,
      );
    }
    // An emoji (a surrogate PAIR) is fine.
    expect(MediaUploadMetaSchema.safeParse({ ...base, tags: ['🎬 reel'] }).success).toBe(true);
  });

  it('a header past the ceiling is refused as too long, not as unreadable', () => {
    const request = (value: string) =>
      new Request('https://admin.example.test/', { headers: { 'x-media-meta': value } });
    expect(() => readMediaMeta(request('A'.repeat(MEDIA_META_MAX_LENGTH + 1)))).toThrow(/too long/);
    expect(() => readMediaMeta(request('%%%'))).toThrow(/could not be read/);
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
      // Thinner than MEDIA_MAX_ASPECT, either way round: no listed width renders it.
      `${TENANT}/33333333-3333-4333-8333-333333333333_2000x2.webp`,
      `${TENANT}/33333333-3333-4333-8333-333333333333_2000x19.webp`,
      `${TENANT}/33333333-3333-4333-8333-333333333333_19x2000.webp`,
      `${TENANT}/33333333-3333-4333-8333-333333333333_101x1.webp`,
    ]) {
      expect(parseStorageKey(bad), bad).toBeNull();
    }
    for (const [w, h] of [
      [2000, 20],
      [20, 2000],
      [100, 1],
      [2560, 26],
    ]) {
      const key = `${TENANT}/33333333-3333-4333-8333-333333333333_${w}x${h}.webp`;
      expect(parseStorageKey(key), key).toMatchObject({ width: w, height: h });
    }
  });

  it("0045's CHECK bounds the aspect where the parser does", () => {
    const sql = readFileSync('supabase/migrations/0045_media_uploads.sql', 'utf8');
    const bound = /greatest\(width, height\) <= least\(width, height\) \* (\d+)/.exec(sql)?.[1];
    expect(Number(bound)).toBe(MEDIA_MAX_ASPECT);
  });
});

describe('the display name: the schema and 0045 refuse the same characters', () => {
  // The CHECK names its characters instead of a locale's [[:cntrl:]] (which, in a UTF-8
  // database, may also take C1 controls or U+2028/U+2029). Its bracket expression is read
  // from the migration and run here as the same class, so the two rules cannot drift apart.
  const sql = readFileSync('supabase/migrations/0045_media_uploads.sql', 'utf8');
  const cls = /display_name !~ '(\[[^']+\])'/.exec(sql)?.[1];
  const refusedByDb = new RegExp(cls ?? '(?!)', 'u');

  it('the migration names its characters', () => {
    expect(cls).toBe(String.raw`[\u0001-\u001f\u007f-\u009f\u2028\u2029/\\]`);
  });

  it('a name the schema admits, the database admits; what it refuses, the database refuses', () => {
    const probes = [
      '\u0001',
      '\u0009',
      '\u001f',
      '\u007f',
      '\u0085',
      '\u009f',
      '\u00a0',
      '\u200f',
      '\u2028',
      '\u2029',
      '/',
      '\\',
      'ش',
      ' ',
      '.',
    ];
    for (const probe of probes) {
      const name = `a${probe}b.jpg`;
      expect(MediaDisplayNameSchema.safeParse(name).success, JSON.stringify(probe)).toBe(
        !refusedByDb.test(name),
      );
    }
  });

  it('a refusal by either 0045 constraint says what is at fault, not "a constraint"', () => {
    const check = translateWriteError(
      {
        code: '23514',
        message:
          'new row for relation "media_assets" violates check constraint "media_assets_display_name"',
      },
      'media_assets',
      'write',
      mediaResource.constraintFields,
    );
    // The generic form has no file-name field (the upload dialog sends it), so the message
    // names it (tests/lib/adminResources.spec.ts holds mapped fields to the form's).
    expect(check).toMatchObject({ status: 422, field: undefined });
    expect(check.message).toMatch(/file.s name/);
    const twice = translateWriteError(
      {
        code: '23505',
        message: 'duplicate key value violates unique constraint "media_assets_storage_object_key"',
      },
      'media_assets',
      'write',
      mediaResource.constraintFields,
    );
    expect(twice).toMatchObject({ status: 422, field: 'storagePath' });
  });
});
