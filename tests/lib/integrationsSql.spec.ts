import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CALENDLY_URL,
  CALENDLY_URL_MAX,
  GA4_ID,
  GSC_TOKEN,
  INTEGRATION_MESSAGES,
} from '@schemas/integrations';
import { CALENDLY_FIELD, GA4_FIELD, SEARCH_CONSOLE_FIELD } from '@/lib/admin/ui/integrations';
import { INTEGRATION_COLUMNS, INTEGRATION_DEFAULTS } from '@/lib/admin/integrations/load';

// The integrations' two layers say the same thing (Admin v2 U11): each Zod pattern is the
// regular expression of its column's CHECK, read from the newest migration that defines the
// constraint, so a value the Worker accepts is never a 23514 at the database, and one the
// database refuses never reaches it. The editor's fields name the columns the route reads.

const DIR = join(process.cwd(), 'supabase', 'migrations');
const MIGRATIONS = readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((name) => ({ name, sql: readFileSync(join(DIR, name), 'utf8').replace(/--[^\n]*/g, '') }));

/** The body of the newest `add constraint <name> check (...)`, its parentheses balanced. */
function check(name: string): string {
  for (const { sql } of [...MIGRATIONS].reverse()) {
    const at = sql.indexOf(`add constraint ${name}`);
    if (at === -1) continue;
    const open = sql.indexOf('check (', at) + 'check '.length;
    let depth = 0;
    for (let i = open; i < sql.length; i++) {
      if (sql[i] === '(') depth++;
      if (sql[i] === ')' && --depth === 0) return sql.slice(open + 1, i);
    }
  }
  throw new Error(`no migration adds ${name}`);
}

/** The one `~ '…'` pattern of a CHECK, as PostgreSQL reads it. */
const pattern = (body: string) => {
  const found = [...body.matchAll(/~ '((?:[^']|'')*)'/g)].map((m) => m[1]!.replace(/''/g, "'"));
  expect(found).toHaveLength(1);
  return found[0]!;
};

/** A JavaScript regex's source as POSIX/ARE text: JS escapes `/`, PostgreSQL need not. */
const posix = (re: RegExp) => re.source.replace(/\\\//g, '/');

describe('the CHECKs and the schema hold the same patterns', () => {
  it('the GA4 measurement id', () => {
    expect(pattern(check('site_integrations_ga4_shape'))).toBe(posix(GA4_ID));
    expect(GA4_ID.flags).toBe('');
  });

  it('the Search Console code', () => {
    expect(pattern(check('site_integrations_gsc_shape'))).toBe(posix(GSC_TOKEN));
    expect(GSC_TOKEN.flags).toBe('');
  });

  it('the Calendly link, and its length', () => {
    const body = check('site_integrations_calendly_shape');
    expect(pattern(body)).toBe(posix(CALENDLY_URL));
    expect(body).toContain(`char_length(calendly_url) <= ${CALENDLY_URL_MAX}`);
    expect(CALENDLY_FIELD.maxLength).toBe(CALENDLY_URL_MAX);
  });

  it('each CHECK lets null through: a blank box clears the setting', () => {
    for (const [name, column] of [
      ['site_integrations_ga4_shape', 'ga4_measurement_id'],
      ['site_integrations_gsc_shape', 'search_console_token'],
      ['site_integrations_calendly_shape', 'calendly_url'],
    ] as const) {
      expect(check(name)).toMatch(new RegExp(`^${column} is null\\s+or\\b`));
    }
  });
});

describe('the editor and the route name the same columns', () => {
  it('each field saves its column, which the route reads and defaults', () => {
    for (const field of [GA4_FIELD, SEARCH_CONSOLE_FIELD, CALENDLY_FIELD]) {
      expect(INTEGRATION_COLUMNS.split(',')).toContain(field.column);
      expect(INTEGRATION_DEFAULTS).toHaveProperty(field.column!, null);
    }
    // Never the legacy jsonb boxes (the contract step after U11's deploy revokes them).
    for (const legacy of ['ga4', 'search_console', 'calendly', 'recaptcha']) {
      expect(INTEGRATION_COLUMNS.split(',')).not.toContain(legacy);
    }
  });

  it('every refusal is said plainly: no dash (P-12)', () => {
    for (const message of Object.values(INTEGRATION_MESSAGES)) {
      expect(message).not.toMatch(/[–—]/);
    }
  });
});

// The row is not "public identifiers only" yet (U11 review): until the contract step, a
// small migration of its own right after U11's deploy, the legacy jsonb boxes stay readable
// and writable by Admin and SEO tokens through the API, and a shape cannot tell a pasted key
// from a code. The three places that state the row say so, and the Search Console field tells
// the person its code is public.
describe('the legacy jsonb residual is stated, never denied', () => {
  const flat = (text: string) => text.replace(/\s+/g, ' ');
  const claude = readFileSync('CLAUDE.md', 'utf8')
    .split('\n')
    .find((line) => line.startsWith('- **U11, integrations'));
  const deviations = /- \*\*Integrations\*\*:\n((?: {2,}.*\n)+)/.exec(
    readFileSync('docs/admin-v2/deviations.md', 'utf8'),
  )?.[1];
  const migration = MIGRATIONS.find((m) => /^\d{4}_integrations\.sql$/.test(m.name));
  const header = migration
    ? readFileSync(join(DIR, migration.name), 'utf8').split('\nset local lock_timeout')[0]
    : undefined;

  it.each([
    ['CLAUDE.md', claude],
    ['the deviations register', deviations],
    ['the migration header', header],
  ])('%s names the residual and the contract step', (_name, text) => {
    expect(text).toBeDefined();
    const said = flat(text!);
    expect(said).not.toMatch(
      /no secret fits|no secret, no markup|holds (typed )?public identifiers only/,
    );
    expect(said).toMatch(/Admin and SEO tokens/);
    expect(said).toContain('contract step');
    expect(said).toContain('not tied to U15 or O-18');
  });

  it('the Search Console field says its code is published, which anon reads', () => {
    expect(SEARCH_CONSOLE_FIELD.help).toContain(
      'The code is published on the home page, where anyone can read it, so paste nothing secret here.',
    );
    expect(migration?.sql).toMatch(
      /grant select \(tenant_id, search_console_token\) on public\.site_integrations to anon;/,
    );
  });
});
