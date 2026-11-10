import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ATTRIBUTION_KEYS, NUMERIC_TLD_SOURCE, PHONE_LIKE_SOURCE } from '@/lib/crm/attribution';

// Lead attribution's SQL (Admin v2 C13, migration 0132; HELD for O-11), read as text.
//
// 1. crm_ingest_lead is restated whole by every slice that changes it, so two held PRs that
//    each restate it from an older body (C13 from 0091 with the attribution keys, C5 from 0091
//    with the contact link at arrival) silently drop each other's change, whichever applies
//    last (C13 review S2). The LAST definition must carry both: the attribution keys, and, once
//    a migration defines C5's link (app.crm_link_lead_core), the call to it. The PR that merges
//    second restates the function from the other's body (C13 as-built, merge step 4).
// 2. The CHECKs are the database's half of the Worker's cleaners (src/lib/crm/attribution.ts):
//    the same phone and IP-address patterns, so a value the Worker keeps is never refused by
//    the database for a reason the Worker did not know (and the reverse).

const DIR = join(process.cwd(), 'supabase', 'migrations');
const FILES = readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const read = (file: string) => readFileSync(join(DIR, file), 'utf8');

/** The body of the LAST `create or replace function public.crm_ingest_lead` in the migrations. */
function lastIngestBody(): { file: string; body: string } {
  const definition =
    /create or replace function public\.crm_ingest_lead\([\s\S]*?\$\$([\s\S]*?)\$\$/g;
  let last = { file: '', body: '' };
  for (const file of FILES) {
    for (const m of read(file).matchAll(definition)) last = { file, body: m[1]! };
  }
  return last;
}

/** The SQL keys of the attribution (the channel was there before C13). */
const COLUMNS = ATTRIBUTION_KEYS.filter((k) => k !== 'channel');

describe('crm_ingest_lead, its last definition (C13 review S2)', () => {
  const { file, body } = lastIngestBody();

  it('is found', () => {
    expect(file).not.toBe('');
    expect(body.length).toBeGreaterThan(500);
  });

  it('accepts and inserts every attribution key', () => {
    const allowList = /\bk not in \(([^)]*)\)/.exec(body)?.[1] ?? '';
    const insert = /insert into public\.leads \(([^)]*)\)/.exec(body)?.[1] ?? '';
    expect(allowList, file).not.toBe('');
    expect(insert, file).not.toBe('');
    for (const key of COLUMNS) {
      expect(allowList, `${file}: allow-list ${key}`).toContain(`'${key}'`);
      expect(insert, `${file}: insert ${key}`).toMatch(new RegExp(`\\b${key}\\b`));
    }
  });

  it('keeps the contact link at arrival once a migration defines it (C5)', () => {
    const linkDefined = FILES.some((f) =>
      /create or replace function app\.crm_link_lead_core\s*\(/.test(read(f)),
    );
    if (linkDefined) {
      expect(body, `${file} drops C5's link`).toMatch(/perform app\.crm_link_lead_core\(/);
    } else {
      expect(body).not.toMatch(/crm_link_lead_core/);
    }
  });
});

describe('the CHECKs carry the Worker’s patterns (C13 review S3)', () => {
  const sql = read(FILES.find((f) => /_crm_lead_attribution\.sql$/.test(f))!);
  const check = (name: string) => {
    const m = new RegExp(`add constraint ${name} check \\(([\\s\\S]*?)\\);`).exec(sql);
    expect(m, name).not.toBeNull();
    return m![1]!;
  };

  it('the path: no percent-escape, no @, no phone number', () => {
    const c = check('leads_landing_path_shape');
    expect(c).toContain("landing_path ~ '^/[^?#%[:space:]]{0,199}$'");
    expect(c).toContain("landing_path !~ '@'");
    expect(c).toContain(`landing_path !~ '${PHONE_LIKE_SOURCE}'`);
  });

  it('the tags: no phone number, in each of the three', () => {
    const c = check('leads_utm_shape');
    for (const tag of ['utm_source', 'utm_medium', 'utm_campaign']) {
      expect(c, tag).toContain(`${tag} !~ '${PHONE_LIKE_SOURCE}'`);
    }
  });

  it('the referrer host: never an IP address', () => {
    expect(check('leads_referrer_host_shape')).toContain(
      `referrer_host !~ '${NUMERIC_TLD_SOURCE}'`,
    );
  });
});
