import type { ImageMetadata } from 'astro';
import { StaticMediaKeySchema } from '@schemas/media';

// Build-time stills — the showreel frames the design uses for posters, galleries and
// portraits (src/assets/media/stills/…). They are ESM images, so <Picture> processes them
// like the logo: real AVIF/WebP derivatives through /_image, explicit width/height.
//
// A `static` media_assets row stores a KEY of this registry (`stills/work/p0.jpg`), never
// a path or URL: the key is looked up here, and an unknown key resolves to null — the
// image is simply not rendered (fail closed), rather than becoming a request for whatever
// the database says. MediaWriteSchema and the media resource reject unknown keys on write.

const FILES = import.meta.glob<ImageMetadata>(
  '/src/assets/media/stills/**/*.{jpg,jpeg,png,webp,avif}',
  { eager: true, import: 'default' },
);

const ROOT = '/src/assets/media/';

/** Registry key → image, e.g. `stills/project/g01.jpg`. */
export const STATIC_MEDIA: ReadonlyMap<string, ImageMetadata> = new Map(
  Object.entries(FILES).map(([path, image]) => [path.slice(ROOT.length), image]),
);

/** Every registered key, sorted (the admin picker and the seed test use it). */
export const STATIC_MEDIA_KEYS: readonly string[] = [...STATIC_MEDIA.keys()].sort();

export function isStaticMediaKey(key: string): boolean {
  return StaticMediaKeySchema.safeParse(key).success && STATIC_MEDIA.has(key);
}

/** The image for a registry key, or null for anything that is not one. */
export function staticImage(key: string): ImageMetadata | null {
  return isStaticMediaKey(key) ? (STATIC_MEDIA.get(key) ?? null) : null;
}
