import { describe, it, expect } from 'vitest';
import { CSRF_HEADER_NAME, csrfHeaderToken, isSameOrigin, isSameSiteGet } from '@/lib/http/csrf';

describe('isSameOrigin (same-origin CSRF check)', () => {
  it('allows a matching origin/host', () => {
    expect(isSameOrigin('https://braiinstation.com', 'braiinstation.com')).toBe(true);
    expect(isSameOrigin('http://localhost:9000', 'localhost:9000')).toBe(true);
  });

  it('rejects a cross-origin request', () => {
    expect(isSameOrigin('https://evil.example', 'braiinstation.com')).toBe(false);
    expect(isSameOrigin('https://braiinstation.com.evil.example', 'braiinstation.com')).toBe(false);
  });

  it('allows when Origin is absent (same-site nav / non-CORS)', () => {
    expect(isSameOrigin(null, 'braiinstation.com')).toBe(true);
    expect(isSameOrigin('https://x', null)).toBe(true);
  });

  it('rejects a malformed Origin', () => {
    expect(isSameOrigin('not a url', 'braiinstation.com')).toBe(false);
  });
});

describe('csrfHeaderToken: whether a request carries a token header (F7 review)', () => {
  const request = (headers: Record<string, string>) =>
    new Request('https://braiinstation.com/api/admin/leads', { method: 'POST', headers });

  it('is the header when it holds a token', () => {
    expect(csrfHeaderToken(request({ [CSRF_HEADER_NAME]: 'abc' }))).toBe('abc');
  });

  it('is null with no header, an empty one, or one of spaces (Headers trims them)', () => {
    expect(csrfHeaderToken(request({}))).toBeNull();
    expect(csrfHeaderToken(request({ [CSRF_HEADER_NAME]: '' }))).toBeNull();
    expect(csrfHeaderToken(request({ [CSRF_HEADER_NAME]: '   ' }))).toBeNull();
  });
});

describe('isSameSiteGet: a costly GET comes from this site (U13 review)', () => {
  const at = (headers: Record<string, string>) =>
    isSameSiteGet(new Request('https://admin.example.test/api/admin/audit/export', { headers }));

  it('allows this origin, a typed address and a request that says nothing', () => {
    expect(at({ 'sec-fetch-site': 'same-origin' })).toBe(true);
    expect(at({ 'sec-fetch-site': 'none' })).toBe(true);
    expect(at({ referer: 'https://admin.example.test/admin/audit?kind=leads' })).toBe(true);
    expect(at({ origin: 'https://admin.example.test' })).toBe(true);
    expect(at({})).toBe(true);
  });

  it('refuses another site, by any of the three headers', () => {
    expect(at({ 'sec-fetch-site': 'cross-site' })).toBe(false);
    expect(at({ 'sec-fetch-site': 'same-site' })).toBe(false);
    expect(at({ origin: 'https://evil.example' })).toBe(false);
    expect(at({ referer: 'https://evil.example/page' })).toBe(false);
    expect(at({ referer: 'not a url' })).toBe(false);
    expect(at({ 'sec-fetch-site': 'same-origin', referer: 'https://evil.example/' })).toBe(false);
  });
});
