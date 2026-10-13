// The one remote image source `/_image` may fetch: this build's public Supabase Storage
// bucket `media`, where editors' uploads live (Admin v2 U3, owner decision A5).
//
// WHY IT IS DERIVED FROM THE BUILD ENVIRONMENT. Astro's image endpoint fetches a remote
// `href` only when `image.remotePatterns` (or `image.domains`) allows it, and refuses any
// redirect that leaves the pattern (node_modules/@astrojs/cloudflare/dist/utils/
// image-binding-transform.js). Each environment has its own Supabase project (CI's local
// stack on 127.0.0.1:54321, staging, production), and PUBLIC_SUPABASE_URL is inlined at
// build time, so the pattern is computed from that same value: exactly one protocol, host,
// port and the bucket's public path, never a wildcard host. A pattern that drifted from
// the URL the code builds would leave every uploaded image refused (a broken picture, not
// a CSP violation: pages only ever reference same-origin `/_image`).
//
// `astro build` refuses to run without a usable PUBLIC_SUPABASE_URL (the integration
// below throws); `astro dev`, `astro check` and `astro sync` only warn, with no pattern.
//
// The value is resolved the way scripts/check-site-url.mjs resolves PUBLIC_SITE_URL, the
// order Vite's env loading gives a production build: the shell first, then the .env files.

import { existsSync, readFileSync } from 'node:fs';

/** The bucket uploads land in (packages/schemas/media.ts MEDIA_BUCKET). */
export const MEDIA_BUCKET = 'media';

const ENV_FILES = ['.env.production.local', '.env.production', '.env.local', '.env'];

/**
 * A build variable from the shell, else the first .env file that sets it.
 * @param {string} name
 * @param {{ env?: Record<string, string | undefined>, files?: string[] }} [options]
 * @returns {string}
 */
export function readBuildEnv(name, { env = process.env, files = ENV_FILES } = {}) {
  const fromShell = env[name];
  if (typeof fromShell === 'string' && fromShell.trim() !== '') return fromShell.trim();
  for (const file of files) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(new RegExp(`^${name}=(.*)$`));
      if (m) return (m[1] ?? '').trim().replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  return '';
}

/**
 * The remote pattern for one Supabase project's public `media` bucket, or null when the URL
 * is not an absolute http(s) origin.
 * @param {string} supabaseUrl
 * @returns {{ protocol: string, hostname: string, port?: string, pathname: string }[] | null}
 */
export function mediaRemotePatterns(supabaseUrl) {
  let url;
  try {
    url = new URL(supabaseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  /** @type {{ protocol: string, hostname: string, port?: string, pathname: string }} */
  const pattern = {
    protocol: url.protocol.slice(0, -1),
    hostname: url.hostname,
    pathname: `/storage/v1/object/public/${MEDIA_BUCKET}/**`,
  };
  if (url.port) pattern.port = url.port;
  return [pattern];
}

/**
 * The Astro integration that sets `image.remotePatterns` from PUBLIC_SUPABASE_URL.
 * @param {{ env?: Record<string, string | undefined>, files?: string[] }} [options]
 * @returns {import('astro').AstroIntegration}
 */
export function mediaRemotePatternsIntegration(options = {}) {
  return {
    name: 'braiin:media-remote-patterns',
    hooks: {
      'astro:config:setup': ({ command, updateConfig, logger }) => {
        const raw = readBuildEnv('PUBLIC_SUPABASE_URL', options);
        const remotePatterns = raw ? mediaRemotePatterns(raw) : null;
        if (!remotePatterns) {
          const reason = raw
            ? 'PUBLIC_SUPABASE_URL is not an absolute http(s) URL'
            : 'PUBLIC_SUPABASE_URL is not set';
          if (command === 'build') {
            throw new Error(
              `${reason}: uploaded images (the public media bucket) need it for image.remotePatterns.`,
            );
          }
          logger.warn(`${reason}; uploaded images will not render through /_image.`);
          return;
        }
        updateConfig({ image: { remotePatterns } });
      },
    },
  };
}
