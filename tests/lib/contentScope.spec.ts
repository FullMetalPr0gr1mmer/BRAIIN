import { setTimeout as sleep } from 'node:timers/promises';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { contentClient, withContentSource, type ContentSource } from '@/lib/data/source';
import { anonClient } from '@/lib/supabase/client';

// The preview's AsyncLocalStorage scope in the content seam (Admin v2 R8, src/lib/data/
// source.ts). The static rules of the seam are tests/lib/contentSource.spec.ts; this file
// drives the scope itself: what a lookup returns inside and outside it, that two requests
// interleaved over awaits, timers and Promise.all never see each other's client, and the
// tripwire that marks a preview whose render looked the client up without its scope.

/** A source with a stand-in client, counting the lost-scope lookups it was told about. */
function fakeSource(name: string): ContentSource & { label: SupabaseClient; anon: number } {
  const label = { name } as unknown as SupabaseClient;
  const source = {
    label,
    anon: 0,
    client: () => label,
    noteAnonLookup() {
      source.anon += 1;
    },
  };
  return source;
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('contentClient() outside a scope', () => {
  it('is the anon client, the same memoised instance', () => {
    expect(contentClient()).toBe(anonClient());
    expect(contentClient()).toBe(contentClient());
  });
});

describe('withContentSource()', () => {
  it("gives the scope's client to every lookup inside it, through awaits and timers", async () => {
    const source = fakeSource('a');
    const seen = await withContentSource(source, async () => {
      const first = contentClient();
      await tick();
      const second = contentClient();
      await sleep(5);
      const third = contentClient();
      const [fourth, fifth] = await Promise.all([
        (async () => {
          await sleep(1);
          return contentClient();
        })(),
        Promise.resolve().then(() => contentClient()),
      ]);
      return [first, second, third, fourth, fifth];
    });
    for (const client of seen) expect(client).toBe(source.label);
    expect(source.anon).toBe(0);
    expect(contentClient()).toBe(anonClient());
  });

  it('returns what fn returns, and leaves the scope when it settles', async () => {
    const source = fakeSource('b');
    await expect(withContentSource(source, async () => 42)).resolves.toBe(42);
    // Closed: a public lookup now trips nothing.
    contentClient();
    expect(source.anon).toBe(0);
  });

  it('never crosses two concurrent scopes, nor a public lookup interleaved with them', async () => {
    const a = fakeSource('a');
    const b = fakeSource('b');
    const log: string[] = [];
    const run = (source: ReturnType<typeof fakeSource>, delays: number[]) =>
      withContentSource(source, async () => {
        for (const ms of delays) {
          await sleep(ms);
          const client = contentClient() as unknown as { name: string };
          log.push(`${(source.label as unknown as { name: string }).name}:${client.name}`);
        }
      });
    let publicClient: SupabaseClient | null = null;
    const publicRequest = (async () => {
      await sleep(3);
      publicClient = contentClient();
    })();
    await Promise.all([run(a, [1, 6, 2, 0]), run(b, [4, 0, 3, 5]), publicRequest]);
    expect(log.sort()).toEqual(['a:a', 'a:a', 'a:a', 'a:a', 'b:b', 'b:b', 'b:b', 'b:b']);
    // The public request got the anon client (and, being scope-less while two previews
    // were open, tripped both: D1's documented false positive).
    expect(publicClient).toBe(anonClient());
    expect(a.anon).toBe(1);
    expect(b.anon).toBe(1);
  });

  it('refuses a nested scope, and the same source opened twice', async () => {
    const outer = fakeSource('outer');
    await withContentSource(outer, async () => {
      await expect(withContentSource(fakeSource('inner'), async () => 1)).rejects.toThrow(
        /already open/,
      );
      // Still the outer scope's client after the refusal.
      expect(contentClient()).toBe(outer.label);
    });
    const twice = fakeSource('twice');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const first = withContentSource(twice, () => gate);
    await expect(withContentSource(twice, async () => 1)).rejects.toThrow(/already serves/);
    release();
    await first;
  });

  it('marks every open scope when a lookup finds no store while one is open', async () => {
    const source = fakeSource('lost');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const open = withContentSource(source, () => gate);
    // A lookup outside the scope's async chain (a lost scope, or another request).
    expect(contentClient()).toBe(anonClient());
    expect(contentClient()).toBe(anonClient());
    expect(source.anon).toBe(2);
    release();
    await open;
    contentClient();
    expect(source.anon).toBe(2);
  });

  it('leaves the open set when fn throws', async () => {
    const source = fakeSource('throws');
    await expect(
      withContentSource(source, async () => {
        await tick();
        throw new Error('render failed');
      }),
    ).rejects.toThrow('render failed');
    contentClient();
    expect(source.anon).toBe(0);
    // And the same source can open a scope again.
    await expect(withContentSource(source, async () => 'again')).resolves.toBe('again');
  });
});
