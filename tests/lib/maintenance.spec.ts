import { describe, it, expect } from 'vitest';
import { getMaintenanceState, clientIp, maintenanceResponse } from '@/lib/http/maintenance';

// Fake KV: only `get` is exercised by this module.
const kv = (value: string | null) =>
  ({ SESSION: { get: async () => value } }) as unknown as Parameters<typeof getMaintenanceState>[0];

const NONCE = 'dGVzdC1ub25jZS0xMjM0';

describe('getMaintenanceState', () => {
  it('is inactive when the KV key is absent', async () => {
    expect(await getMaintenanceState(kv(null))).toEqual({ active: false, allowlist: [] });
  });

  it('is inactive when there is no KV binding at all (pre-provisioning)', async () => {
    expect(await getMaintenanceState({})).toEqual({ active: false, allowlist: [] });
  });

  it('reads the active flag and allowlist', async () => {
    const state = await getMaintenanceState(
      kv(JSON.stringify({ active: true, allowlist: ['1.2.3.4'] })),
    );
    expect(state).toEqual({ active: true, allowlist: ['1.2.3.4'] });
  });

  it('requires active === true exactly — no truthy coercion', async () => {
    for (const active of ['true', 1, 'yes', {}]) {
      expect((await getMaintenanceState(kv(JSON.stringify({ active })))).active).toBe(false);
    }
  });

  it('FAILS OPEN on malformed JSON — a KV blip must not 503 the whole site', async () => {
    expect(await getMaintenanceState(kv('{{{not json'))).toEqual({ active: false, allowlist: [] });
  });

  it('coerces a non-array allowlist to [] rather than throwing', async () => {
    const state = await getMaintenanceState(
      kv(JSON.stringify({ active: true, allowlist: 'nope' })),
    );
    expect(state).toEqual({ active: true, allowlist: [] });
  });
});

describe('clientIp', () => {
  const req = (headers: Record<string, string>) => new Request('https://x.com/', { headers });

  it('prefers cf-connecting-ip (the only header Cloudflare sets itself)', () => {
    expect(clientIp(req({ 'cf-connecting-ip': '9.9.9.9', 'x-forwarded-for': '1.1.1.1' }))).toBe(
      '9.9.9.9',
    );
  });

  it('falls back to the first x-forwarded-for entry', () => {
    expect(clientIp(req({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2' }))).toBe('1.1.1.1');
  });

  it('returns null when neither header is present', () => {
    expect(clientIp(req({}))).toBeNull();
  });

  it('returns null for an empty x-forwarded-for — a spoofed blank is not an allowlist match', () => {
    // The middleware requires `ip !== null && allowlist.includes(ip)`, so a null here
    // means "not allowlisted" and the 503 stands. Fail closed on the allowlist.
    expect(clientIp(req({ 'x-forwarded-for': '' }))).toBeNull();
  });
});

describe('maintenanceResponse', () => {
  const res = () => maintenanceResponse(NONCE);

  it('is a 503 with Retry-After', () => {
    expect(res().status).toBe(503);
    expect(Number(res().headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('is never cached — the 503 must not stick in the edge cache', () => {
    expect(res().headers.get('cache-control')).toBe('no-store');
  });

  it('is HTML', () => {
    expect(res().headers.get('content-type')).toContain('text/html');
  });

  it('carries NO inline style attributes — the strict CSP would blank the page', async () => {
    // Regression guard. This page used inline `style=` on <body>, <main> and <h1>. It
    // survived review only because the maintenance branch returned before the CSP was
    // applied; once headers cover every path, inline styles are dead pixels.
    const html = await res().text();
    expect(html).not.toMatch(/\sstyle=/);
  });

  it('carries its styles in a nonced <style> block matching the request nonce', async () => {
    const html = await res().text();
    expect(html).toContain(`<style nonce="${NONCE}">`);
  });

  it('does not break out of the nonce attribute if handed a quote', async () => {
    const html = await maintenanceResponse('abc"><script>alert(1)</script>').text();
    expect(html).not.toContain('<script>');
  });
});
