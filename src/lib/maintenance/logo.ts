import { getImage } from 'astro:assets';
import logo from '@/assets/braiin-logo-white.png';

// The maintenance page's logo (Admin v2 U9b): the white logo through the same-origin `/_image`
// at a listed width (264, TRANSFORM_WIDTHS), which the pre-cache check exempts, so it loads
// while the site is down. One promise per isolate: the URL is the same for every request, and
// a failure is no logo, never a broken page.

let memo: Promise<string | null> | undefined;

export function maintenanceLogoSrc(): Promise<string | null> {
  memo ??= getImage({ src: logo, width: 264, format: 'webp' })
    .then((image) => image.src)
    .catch(() => null);
  return memo;
}
