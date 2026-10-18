import { UPTIME_MONITOR_API_KEY, UPTIME_MONITOR_IDS } from 'astro:env/server';
import { PUBLIC_SITE_URL } from 'astro:env/client';
import type { UptimeProvider } from './types';
import { uptimeRobot } from './uptimeRobot';

export * from './types';

// The uptime monitor seam (Admin v2 G2). An external monitor watches the site from outside
// Cloudflare (CLAUDE.md §10, owner item O-20); the Worker only READS what it saw, with a
// read-only key held as a Worker secret (UPTIME_MONITOR_API_KEY). One adapter today,
// UptimeRobot (decision D1); a swap is one file implementing UptimeProvider.
//
// No key, no provider: every screen says "Not set up" and the score leaves uptime out. The
// key goes to the monitor's own API and nowhere else, and never into a log line, an error
// or a response.

export interface UptimeConfig {
  key: string | undefined;
  ids: string | undefined;
  siteUrl: string;
}

/** The deployment's configuration (the key is deployment-wide, decision D8). */
export function uptimeConfig(): UptimeConfig {
  return { key: UPTIME_MONITOR_API_KEY, ids: UPTIME_MONITOR_IDS, siteUrl: PUBLIC_SITE_URL };
}

/** The monitor's reader, or null when no key is set ("Not set up"). */
export function uptimeProvider(config: UptimeConfig = uptimeConfig()): UptimeProvider | null {
  const key = config.key?.trim();
  if (!key) return null;
  return uptimeRobot({ key, ids: config.ids, siteUrl: config.siteUrl });
}
