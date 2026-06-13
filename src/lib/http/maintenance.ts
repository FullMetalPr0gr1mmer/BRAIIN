// Maintenance-mode + IP-allowlist as a Worker-level PRE-CACHE check (CLAUDE.md
// Pillar 1): a 503 is returned before the edge-cache lookup, so it coexists with
// the long-`s-maxage` Tier-A cache without a purge. `/admin` and `/api` are exempt.
// Source of truth is `site_settings` (flag + allowlist), snapshotted into KV.

export interface MaintenanceState {
  active: boolean;
  allowlist: readonly string[];
}

const KV_KEY = 'site:maintenance';

export async function getMaintenanceState(env: {
  SESSION?: KVNamespace;
}): Promise<MaintenanceState> {
  try {
    const raw = await env.SESSION?.get(KV_KEY);
    if (!raw) return { active: false, allowlist: [] };
    const parsed = JSON.parse(raw) as Partial<MaintenanceState>;
    return {
      active: parsed.active === true,
      allowlist: Array.isArray(parsed.allowlist) ? parsed.allowlist : [],
    };
  } catch {
    // Fail OPEN for maintenance (never lock the whole site out on a KV blip).
    return { active: false, allowlist: [] };
  }
}

export function clientIp(request: Request): string | null {
  const cf = request.headers.get('cf-connecting-ip');
  if (cf) return cf;
  const xff = request.headers.get('x-forwarded-for');
  return xff ? (xff.split(',')[0]?.trim() ?? null) : null;
}

export function maintenanceResponse(): Response {
  const html =
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Down for maintenance</title></head>' +
    '<body style="font-family:system-ui,Segoe UI,Roboto,sans-serif;background:#0b0b0f;color:#e8e8ea;' +
    'display:grid;place-items:center;min-height:100vh;margin:0">' +
    '<main style="text-align:center;padding:2rem"><h1 style="margin:0 0 .5rem">Back shortly</h1>' +
    '<p style="opacity:.7">Braiin Station is undergoing scheduled maintenance.</p></main></body></html>';
  return new Response(html, {
    status: 503,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'retry-after': '3600',
      'cache-control': 'no-store',
    },
  });
}
