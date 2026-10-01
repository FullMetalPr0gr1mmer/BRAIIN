import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { checkPublicLimits, ipLimitValue, limitKey } from '@/lib/http/publicRateLimit';

// The public write limiter (EXC-004) — what it counts and how it answers. The endpoint
// suites (tests/api/apply.spec.ts, tests/api/contactLimit.spec.ts) prove each caller's
// fail-closed / fail-open choice; this file proves the shared part.

describe('ipLimitValue — what one visitor is', () => {
  it('counts an IPv4 address as itself', () => {
    expect(ipLimitValue('203.0.113.5')).toBe('203.0.113.5');
    expect(ipLimitValue(' 203.0.113.5 ')).toBe('203.0.113.5');
  });

  it('counts IPv6 by its /64, however the address is written', () => {
    const net = '2001:db8:abcd:12::/64';
    expect(ipLimitValue('2001:db8:abcd:12:1:2:3:4')).toBe(net);
    expect(ipLimitValue('2001:DB8:ABCD:0012:ffff:ffff:ffff:ffff')).toBe(net);
    expect(ipLimitValue('2001:db8:abcd:12::1')).toBe(net);
    expect(ipLimitValue('2001:0db8:abcd:0012:0000:0000:0000:0009')).toBe(net);
    expect(ipLimitValue('2001:db8::')).toBe('2001:db8:0:0::/64');
    expect(ipLimitValue('::1')).toBe('0:0:0:0::/64');
    // Two addresses of the same /64 are ONE visitor; of the next /64, another.
    expect(ipLimitValue('2001:db8:abcd:13::1')).not.toBe(net);
  });

  it('counts an IPv4-mapped IPv6 address as its IPv4', () => {
    expect(ipLimitValue('::ffff:203.0.113.5')).toBe('203.0.113.5');
    expect(ipLimitValue('0:0:0:0:0:ffff:203.0.113.5')).toBe('203.0.113.5');
  });

  it('counts the unparseable as given, and no address as one shared key', () => {
    expect(ipLimitValue('2001:db8::1::2')).toBe('2001:db8::1::2');
    expect(ipLimitValue('not:an:address')).toBe('not:an:address');
    expect(ipLimitValue(null)).toBe('unknown');
    expect(ipLimitValue('')).toBe('unknown');
  });
});

describe('limitKey', () => {
  it('is a 64-hex HMAC, the same for the same value however it is cased', async () => {
    const a = await limitKey('root', 'apply:email', 'Noura@Example.com ');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await limitKey('root', 'apply:email', 'noura@example.com')).toBe(a);
  });

  it('differs by scope and by key, so one window never counts for another', async () => {
    const a = await limitKey('root', 'apply:email', 'noura@example.com');
    expect(await limitKey('root', 'contact:email', 'noura@example.com')).not.toBe(a);
    expect(await limitKey('other-root', 'apply:email', 'noura@example.com')).not.toBe(a);
  });
});

describe('checkPublicLimits', () => {
  function sb(answers: unknown[]): { client: SupabaseClient; calls: number } {
    const state = { calls: 0 };
    const client = {
      rpc: async () => {
        const a = answers[state.calls++];
        if (a instanceof Error) throw a;
        return a === 'error'
          ? { data: null, error: { message: 'down' } }
          : { data: a, error: null };
      },
    } as unknown as SupabaseClient;
    return {
      client,
      get calls() {
        return state.calls;
      },
    };
  }
  const rules = [
    { scope: 'apply:ip', value: '203.0.113.5', max: 5, windowSeconds: 3600 },
    { scope: 'apply:email', value: 'a@b.co', max: 3, windowSeconds: 86_400 },
  ];

  it('ok under every limit; limited when any is over — and every rule is still counted', async () => {
    const under = sb([1, 1]);
    expect(await checkPublicLimits(under.client, 't', 'root', rules)).toBe('ok');
    const over = sb([6, 1]);
    expect(await checkPublicLimits(over.client, 't', 'root', rules)).toBe('limited');
    expect(over.calls).toBe(2);
  });

  it('the count AT the limit passes; one more is over', async () => {
    expect(await checkPublicLimits(sb([5, 3]).client, 't', 'root', rules)).toBe('ok');
    expect(await checkPublicLimits(sb([5, 4]).client, 't', 'root', rules)).toBe('limited');
  });

  it('unavailable when the counter errors, answers a non-number, or throws', async () => {
    expect(await checkPublicLimits(sb(['error']).client, 't', 'root', rules)).toBe('unavailable');
    expect(await checkPublicLimits(sb(['7']).client, 't', 'root', rules)).toBe('unavailable');
    expect(await checkPublicLimits(sb([new Error('x')]).client, 't', 'root', rules)).toBe(
      'unavailable',
    );
  });
});
