// The `/_image` endpoint this site serves: src/lib/http/imageEndpoint.ts, which runs the H3
// guard on the route itself, hands bundled stills to the Cloudflare adapter's own endpoint,
// and transforms an editor's upload only when the bucket returned a real WebP master
// (Admin v2 U3 review; README H3: "a custom endpoint wraps the adapter").
//
// WHY AN INTEGRATION. With `imageService: 'cloudflare-binding'` the adapter SETS
// `image.endpoint` in its own `astro:config:setup` (dist/utils/image-config.js
// `setImageConfig`), so an `image.endpoint` written in astro.config.mjs is overwritten. Astro
// runs the adapter's hook first (it is put at the head of `integrations`), so an integration
// listed after it has the last word. The service (`image-service-workerd`) is untouched:
// the adapter lock `imageService: 'cloudflare-binding'` (CLAUDE.md §2) still holds.

/** The endpoint module, relative to the project root (Astro resolves it from there). */
export const IMAGE_ENDPOINT_ENTRYPOINT = './src/lib/http/imageEndpoint.ts';

/**
 * @returns {import('astro').AstroIntegration}
 */
export function imageEndpointIntegration() {
  return {
    name: 'braiin:image-endpoint',
    hooks: {
      'astro:config:setup': ({ updateConfig }) => {
        updateConfig({
          image: { endpoint: { route: '/_image', entrypoint: IMAGE_ENDPOINT_ENTRYPOINT } },
        });
      },
    },
  };
}
