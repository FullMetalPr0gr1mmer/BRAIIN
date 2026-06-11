// Request-time lookup for the v1 redirects/canonical module (CLAUDE.md Pillar 3).
// Redirects are authored in the `redirects` table (SEO/Admin), then snapshotted to
// KV as a JSON map keyed by source pathname. Returns null when no rule matches.
// The 301/canonical MODULE ships in v1; this is only its edge lookup.

export interface RedirectRule {
  to: string;
  status: 301 | 302 | 308;
}

const KV_KEY = 'site:redirects';

export async function lookupRedirect(
  pathname: string,
  env: { SESSION?: KVNamespace },
): Promise<RedirectRule | null> {
  try {
    const raw = await env.SESSION?.get(KV_KEY);
    if (!raw) return null;
    const map = JSON.parse(raw) as Record<string, RedirectRule>;
    const rule = map[pathname];
    if (!rule || typeof rule.to !== 'string') return null;
    const status = rule.status === 302 || rule.status === 308 ? rule.status : 301;
    return { to: rule.to, status };
  } catch {
    return null;
  }
}
