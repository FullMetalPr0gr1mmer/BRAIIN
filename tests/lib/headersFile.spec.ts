import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { ASSET_CSP, STATIC_SECURITY_HEADERS } from '@/lib/http/securityHeaders';

// public/_headers — the security headers of every static file (CLAUDE.md §2, amendment
// 2026-10). Workers Static Assets serves dist/client without running the Worker, so this
// file is the ONLY layer those responses get; a drift from the constants the middleware
// and the Worker backstop use would be invisible until someone curled a stylesheet.
//
// The parse follows the stricter of the two readers. The adapter treats every unindented,
// non-comment line as a path (`headers.js`, when it decides whether to add `/_astro/*`
// immutable caching) while wrangler trims every line — so a header line that lost its
// indent reads fine to wrangler and as a broken rule to the adapter.

const FILE = 'public/_headers';
const lines = readFileSync(FILE, 'utf8')
  .split(/\r?\n/)
  .filter((line) => line.trim() !== '' && !line.trim().startsWith('#'));

const isPath = (line: string) => !/^\s/.test(line);

describe('public/_headers', () => {
  it('has exactly one rule, `/*`, and every other line is an indented `Name: value`', () => {
    const paths = lines.filter(isPath);
    expect(paths).toEqual(['/*']);
    for (const line of paths) expect(line).toMatch(/^\/\S*$/);
    for (const line of lines.filter((l) => !isPath(l))) {
      expect(line, line).toMatch(/^\s+[A-Za-z-]+:\s*\S/);
    }
  });

  it('never sets or detaches Cache-Control (it would cancel the adapter’s /_astro immutable rule)', () => {
    for (const line of lines) {
      expect(line, line).not.toMatch(/cache-control/i);
      expect(line.trim().startsWith('!'), line).toBe(false);
    }
  });

  it('carries exactly STATIC_SECURITY_HEADERS plus ASSET_CSP', () => {
    const headers = Object.fromEntries(
      lines
        .filter((l) => !isPath(l))
        .map((l) => {
          const at = l.indexOf(':');
          return [l.slice(0, at).trim().toLowerCase(), l.slice(at + 1).trim()];
        }),
    );
    const expected = {
      ...Object.fromEntries(
        Object.entries(STATIC_SECURITY_HEADERS).map(([k, v]) => [k.toLowerCase(), v]),
      ),
      'content-security-policy': ASSET_CSP,
    };
    expect(headers).toEqual(expected);
  });

  it('stays inside the platform limits (100 rules, 2,000 characters a line)', () => {
    expect(lines.filter(isPath).length).toBeLessThanOrEqual(100);
    for (const line of readFileSync(FILE, 'utf8').split(/\r?\n/)) {
      expect(line.length).toBeLessThanOrEqual(2000);
    }
  });

  it('ASSET_CSP admits no inline code', () => {
    expect(ASSET_CSP).not.toContain('unsafe-inline');
  });
});
