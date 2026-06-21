import { describe, it, expect } from 'vitest';
import { isSameOrigin } from '@/lib/http/csrf';

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
