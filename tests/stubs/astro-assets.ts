// `astro:assets` is a virtual module that only exists inside the Astro build (Admin v2 U10:
// the share-image helper, src/lib/seo/shareImage.ts, reaches the head loader, which many unit
// specs import). This stub answers `getImage` with the URL shape Astro's endpoint builds
// (`/_image?href=…&w=…&f=…`), deterministically, so a spec can assert a share image's URL.
// The render project (vitest.render.config.ts) uses Astro's real module.

interface ImageSource {
  src: string;
  width: number;
  height: number;
  format?: string;
}

export async function getImage(options: {
  src: ImageSource | string;
  width?: number;
  format?: string;
}): Promise<{ src: string; attributes: Record<string, unknown> }> {
  const href = typeof options.src === 'string' ? options.src : options.src.src;
  const params = new URLSearchParams({ href });
  if (options.width !== undefined) params.set('w', String(options.width));
  if (options.format !== undefined) params.set('f', options.format);
  return { src: `/_image?${params.toString()}`, attributes: {} };
}
