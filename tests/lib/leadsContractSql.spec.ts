import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The leads contract's migration (Admin v2 C14b), the order of its statements where the order
// is the point. pgTAP runs after every migration, on a database that never held the dropped
// columns, so it cannot plant what this file must handle; the PGlite replay in the as-built
// did (a runner that does not bypass row security, a mirrored notes field, a moved band). The
// shape that behaviour depends on is pinned here. The file is found by name, not by number:
// the merge train renumbers it.

const DIR = join(process.cwd(), 'supabase', 'migrations');
const FILE = readdirSync(DIR).find((f) => /^\d{4}_crm_leads_contract\.sql$/.test(f));
const SQL = FILE ? readFileSync(join(DIR, FILE), 'utf8').replace(/--[^\n]*/g, '') : '';

const at = (statement: RegExp): number => {
  const match = statement.exec(SQL);
  expect(match, String(statement)).not.toBeNull();
  return match!.index;
};

describe('the leads contract migration', () => {
  it('exists, once', () => {
    expect(FILE).toBeDefined();
  });

  it('refuses a runner that does not bypass row security before it locks or counts anything', () => {
    // leads, lead_stages and the settings force row security: a runner bound by it reads no
    // row, every precondition would count 0, and the columns would be dropped unread.
    const guard = at(
      /if not coalesce\(\(select r\.rolsuper or r\.rolbypassrls from pg_roles r\s+where r\.rolname = current_user\), false\) then\s+raise exception/,
    );
    expect(guard).toBeLessThan(at(/lock table public\.crm_settings in access exclusive mode/));
    expect(guard).toBeLessThan(at(/select count\(\*\) into n_bands/));
  });

  it('rewrites every lead still holding the notes field or a band before the columns go', () => {
    // DROP COLUMN only hides a column; a row keeps the bytes until it is next written.
    const rewrite = at(
      /update public\.leads\s+set internal_notes = null, timeline_band = null\s+where internal_notes is not null or timeline_band is not null;/,
    );
    // After the AFTER phase lost the mirror (or clearing the field would delete the notes it
    // mirrored) and before the drop.
    expect(rewrite).toBeGreaterThan(at(/create or replace function app\.tg_lead_timeline\(\)/));
    expect(rewrite).toBeLessThan(at(/alter table public\.leads\s+drop column status,/));
  });

  it('makes that rewrite no edit, and switches the BEFORE phase back on', () => {
    const rewrite = at(/update public\.leads\s+set internal_notes = null/);
    const off = at(/alter table public\.leads disable trigger leads_pipeline;/);
    const on = at(/alter table public\.leads enable trigger leads_pipeline;/);
    expect(off).toBeLessThan(rewrite);
    expect(on).toBeGreaterThan(rewrite);
    expect(on).toBeLessThan(at(/alter table public\.leads\s+drop column status,/));
    // Only that one trigger, by name, and only once each way.
    expect(SQL.match(/disable trigger/g)).toHaveLength(1);
    expect(SQL.match(/enable trigger/g)).toHaveLength(1);
    // The postconditions refuse a trigger on leads left switched off.
    expect(at(/t\.tgenabled::text <> 'O'/)).toBeGreaterThan(on);
  });
});
