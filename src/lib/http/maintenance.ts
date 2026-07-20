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

/**
 * The 503 page. Takes the request's CSP nonce because this response now carries the same
 * strict CSP as every other one, and that CSP has no 'unsafe-inline' — the previous
 * version styled itself with inline `style=` attributes, which the policy blocks. It only
 * escaped notice because the maintenance branch returned before headers were applied.
 * Styles therefore live in a single nonced <style> block.
 */
export function maintenanceResponse(nonce: string): Response {
  // Allowlist the base64 alphabet rather than stripping "dangerous" characters. A
  // denylist here is wrong twice over: this string lands in an HTML attribute AND in the
  // CSP header, so `>`, spaces and `;` all break something even with quotes removed.
  // generateNonce() only ever emits base64, so this is belt-and-braces — but the belt
  // has to actually be a belt.
  const safeNonce = nonce.replace(/[^A-Za-z0-9+/=]/g, '');
  const html =
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Down for maintenance</title>' +
    `<style nonce="${safeNonce}">` +
    'body{font-family:system-ui,Segoe UI,Roboto,sans-serif;background:#0b0b0f;color:#e8e8ea;' +
    'display:grid;place-items:center;min-height:100vh;margin:0}' +
    'main{text-align:center;padding:2rem}h1{margin:0 0 .5rem}p{opacity:.7}' +
    '</style></head>' +
    '<body><main><h1>Back shortly</h1>' +
    '<p>Braiin Station is undergoing scheduled maintenance.</p></main></body></html>';
  return new Response(html, {
    status: 503,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'retry-after': '3600',
      'cache-control': 'no-store',
    },
  });
}
