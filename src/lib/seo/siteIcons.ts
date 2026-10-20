import { getImage } from 'astro:assets';
import type { Locale } from '@schemas/primitives';
import type { SiteIcons } from '@/lib/data/siteProfile';
import type { ImageRef } from '@/lib/media/resolve';

// The site's icons in the head and the manifest (Admin v2 U9): an uploaded square picture,
// sent as PNG through the same-origin `/_image` at exactly the sizes the `/_image` guard's
// icon rule admits (ICON_WIDTHS, src/lib/http/imageGuard.ts; tests/lib/imageGuard.spec.ts
// holds these to it). Nothing renders while no icon is set: the head is then the one served
// before U9, byte for byte (tests/render/seoHead.spec.ts).

/** The favicon's sizes: the browser tab (32) and the larger one Android and others ask for. */
export const FAVICON_SIZES = [32, 192] as const;
/** The home-screen icon iOS reads. */
export const APPLE_TOUCH_SIZE = 180;
/** The manifest's icons. */
export const MANIFEST_ICON_SIZES = [192, 512] as const;

export interface IconLink {
  href: string;
  size: number;
}

/** A square PNG of the icon at `size` px, or null when the picture is smaller than that. */
export async function iconUrl(ref: ImageRef, size: number): Promise<string | null> {
  if (ref.width < size || ref.height < size) return null;
  const image = await getImage({ src: ref.src, width: size, height: size, format: 'png' });
  return image.src;
}

async function linksOf(ref: ImageRef | null, sizes: readonly number[]): Promise<IconLink[]> {
  if (!ref) return [];
  const out: IconLink[] = [];
  for (const size of sizes) {
    const href = await iconUrl(ref, size);
    if (href) out.push({ href, size });
  }
  return out;
}

export interface HeadIcons {
  favicons: IconLink[];
  appleTouch: IconLink | null;
  /** The manifest of the page's language, linked only when an app icon is set. */
  manifest: string | null;
}

/** The head's icon links for the page's language. */
export async function headIcons(icons: SiteIcons, locale: Locale): Promise<HeadIcons> {
  const [favicons, apple] = await Promise.all([
    linksOf(icons.favicon, FAVICON_SIZES),
    linksOf(icons.appIcon, [APPLE_TOUCH_SIZE]),
  ]);
  return {
    favicons,
    appleTouch: apple[0] ?? null,
    manifest: icons.appIcon ? (locale === 'ar' ? '/ar/manifest.webmanifest' : '/manifest.webmanifest') : null,
  };
}

/** The manifest's icons, from the app icon only. */
export async function manifestIcons(
  icons: SiteIcons,
): Promise<{ src: string; sizes: string; type: 'image/png' }[]> {
  const links = await linksOf(icons.appIcon, MANIFEST_ICON_SIZES);
  return links.map((l) => ({ src: l.href, sizes: `${l.size}x${l.size}`, type: 'image/png' }));
}
