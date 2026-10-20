import { defineAdminRoute } from '@/lib/admin/route';
import { loadRealtime } from '@/lib/admin/stats/realtime';

// Realtime as JSON (Admin v2 G1b): what the Realtime tab's island asks for once a minute
// while the tab is visible and not paused. `analytics.read`, which §5 grants to all four
// roles; no input; `no-store` (defineAdminRoute). One read of the minute rollup through
// public.realtime_summary (migration 0071), never the raw events (Pillar 4).

export const prerender = false;

export const GET = defineAdminRoute({
  cap: 'analytics.read',
  handler: async ({ auth, sb }) => loadRealtime(sb, auth),
});
