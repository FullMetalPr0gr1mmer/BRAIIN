import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contentClient } from '@/lib/data/source';
import { anonClient } from '@/lib/supabase/client';

// The content seam (src/lib/data/source.ts): every public content loader gets its Supabase
// client from contentClient(), so the releases preview (R8, docs/admin-v2/releases.md §6.3)
// has ONE place to swap in its overlay. A loader that reached the anon client another way
// would render live rows inside a preview and could not be caught by looking at the page.
//
// Today the seam is a pass-through: contentClient() is the anon client, the same instance,
// so every public query (and with it Tier A output, caching and RLS) is what it was.

const ROOT = process.cwd();

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(ts|tsx|astro|js|mjs)$/.test(name) ? [path] : [];
  });
}

/** Blanks comments (a comment may name anonClient freely): the rules apply to code. */
function code(text: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  return text
    .replace(/\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->/g, blank)
    .replace(
      /(^|[^:])(\/\/[^\n]*)/gm,
      (_m, before: string, comment: string) => before + blank(comment),
    );
}

const files = walk(join(ROOT, 'src')).map((path) => ({
  path: relative(ROOT, path).split(sep).join('/'),
  code: code(readFileSync(path, 'utf8')),
}));
const dataFiles = files.filter((f) => f.path.startsWith('src/lib/data/'));

/** The only files that may name anonClient, and why. Exact: a stale entry fails too. */
const ANON_CLIENT_ALLOWED: Record<string, string> = {
  'src/lib/supabase/client.ts': 'defines it',
  'src/lib/data/source.ts': 'the seam: contentClient() returns it',
};

/**
 * The modules under src/lib/data/ that query as the SERVICE ROLE instead, and why. None of
 * them reads public content: each writes (or finds the tenant a write lands in) with the
 * tenant resolved server-side, so none belongs behind the seam. Exact, like the list above.
 */
const SERVICE_ROLE_SINKS: Record<string, string> = {
  'src/lib/data/leads.ts': "the contact form's lead write (the submit-contact-form path)",
  'src/lib/data/systemLog.ts': 'the system_logs sink, written for anonymous callers too',
  'src/lib/data/telemetry.ts': 'the analytics event, web vitals and search query sinks',
  'src/lib/data/tenant.ts': 'the anon tenant fence: which tenant a public write lands in',
};

describe('contentClient()', () => {
  it('is the anon client, the same memoised instance', () => {
    expect(contentClient()).toBe(anonClient());
    expect(contentClient()).toBe(contentClient());
  });
});

describe('the content seam', () => {
  it('is the only way to the anon client: no other file in src/ names anonClient', () => {
    const naming = files
      .filter((f) => /\banonClient\b/.test(f.code))
      .map((f) => f.path)
      .sort();
    expect(naming).toEqual(Object.keys(ANON_CLIENT_ALLOWED).sort());
  });

  it('carries every query under src/lib/data/ except the named service-role sinks', () => {
    const loaders = dataFiles.filter(
      (f) => /\.(?:from|rpc)\(\s*['"`]/.test(f.code) && !(f.path in SERVICE_ROLE_SINKS),
    );
    const bypassing = loaders.filter((f) => !/\bcontentClient\(\)/.test(f.code));
    expect(bypassing.map((f) => f.path)).toEqual([]);
    // Not vacuous: the 15 public loaders the seam landed with are all in that list.
    expect(loaders.length).toBeGreaterThanOrEqual(15);
  });

  it('leaves the service role under src/lib/data/ to the named sinks only', () => {
    const serviceRole = dataFiles
      .filter((f) => /\bserviceClient\b/.test(f.code))
      .map((f) => f.path)
      .sort();
    expect(serviceRole).toEqual(Object.keys(SERVICE_ROLE_SINKS).sort());
  });
});
