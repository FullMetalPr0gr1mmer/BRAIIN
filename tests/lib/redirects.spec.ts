import { describe, it, expect } from 'vitest';
import { lookupRedirect } from '@/lib/http/redirects';

const kv = (value: string | null) =>
  ({ SESSION: { get: async () => value } }) as unknown as Parameters<typeof lookupRedirect>[1];

const map = (m: Record<string, unknown>) => kv(JSON.stringify(m));

describe('lookupRedirect', () => {
  it('returns null when no rule matches', async () => {
    expect(await lookupRedirect('/nope', map({ '/old': { to: '/new', status: 301 } }))).toBeNull();
  });

  it('returns null when the KV key is absent or unbound (pre-provisioning)', async () => {
    expect(await lookupRedirect('/old', kv(null))).toBeNull();
    expect(await lookupRedirect('/old', {})).toBeNull();
  });

  it('returns the matching rule', async () => {
    const rule = await lookupRedirect('/old', map({ '/old': { to: '/new', status: 301 } }));
    expect(rule).toEqual({ to: '/new', status: 301 });
  });

  it('preserves 302 and 308 (real status codes, per Pillar 3 — not meta-refresh)', async () => {
    for (const status of [302, 308] as const) {
      const rule = await lookupRedirect('/old', map({ '/old': { to: '/new', status } }));
      expect(rule?.status).toBe(status);
    }
  });

  it('defaults an unknown/absent status to a permanent 301', async () => {
    for (const status of [307, 200, 'bogus', undefined]) {
      const rule = await lookupRedirect('/old', map({ '/old': { to: '/new', status } }));
      expect(rule?.status).toBe(301);
    }
  });

  it('rejects a rule with a non-string target rather than redirecting to undefined', async () => {
    expect(await lookupRedirect('/old', map({ '/old': { status: 301 } }))).toBeNull();
    expect(await lookupRedirect('/old', map({ '/old': { to: 42, status: 301 } }))).toBeNull();
  });

  it('survives malformed KV JSON without throwing (fails open to no redirect)', async () => {
    expect(await lookupRedirect('/old', kv('{{{'))).toBeNull();
  });

  it('matches the pathname exactly — no prefix or partial matching', async () => {
    const rules = map({ '/old': { to: '/new', status: 301 } });
    expect(await lookupRedirect('/old/child', rules)).toBeNull();
    expect(await lookupRedirect('/older', rules)).toBeNull();
    expect(await lookupRedirect('/old', rules)).not.toBeNull();
  });

  it('does not resolve inherited Object.prototype keys as redirect rules', async () => {
    // `map[pathname]` on a JSON.parse result: a request for /constructor or /toString
    // must not find a "rule" on the prototype chain and redirect to garbage.
    for (const path of ['/constructor', '/toString', '/__proto__', '/valueOf']) {
      expect(await lookupRedirect(path, map({ '/old': { to: '/new', status: 301 } }))).toBeNull();
    }
  });
});
