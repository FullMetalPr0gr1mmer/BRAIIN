import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Admin v2 C5 (0131) restates three functions whose bodies other slices own. The migration
// says each changes in one place only; this holds it to that, so a later edit to the copy
// cannot slip a second change in unseen: app.tg_lead_pipeline (0113) gains the two link
// columns in c_derived, crm_ingest_lead (0091) gains the fail-open link at its end, and
// crm_erase_lead (0041) still checks the actor live before anything else.

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations');
const read = (file: string) => readFileSync(join(MIGRATIONS, file), 'utf8').replace(/\r\n/g, '\n');

/** The text of one `create or replace function <name>(` up to its closing `end $$;`. */
function fn(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function ${name}(`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf('end $$;', start);
  return sql.slice(start, end + 'end $$;'.length);
}

const C5 = read('0131_crm_contacts.sql');

describe('0131 restates what it must, and nothing more', () => {
  it('app.tg_lead_pipeline: 0113 with the link derived', () => {
    const before = fn(read('0113_crm_leads_contract.sql'), 'app.tg_lead_pipeline');
    const after = fn(C5, 'app.tg_lead_pipeline');
    const derivedBefore = `'crm_indexed_at', 'search_text', 'updated_at', 'updated_by'];`;
    expect(before).toContain(derivedBefore);
    expect(after).toBe(
      before.replace(
        derivedBefore,
        `'crm_indexed_at', 'search_text', 'updated_at', 'updated_by',\n` +
          `    -- (C5) The contact link, set by the link and cleared when its contact goes.\n` +
          `    'contact_id', 'contact_link'];`,
      ),
    );
  });

  it('crm_ingest_lead: 0091 with the link after the insert, its errors caught', () => {
    const before = fn(read('0091_crm_settings.sql'), 'public.crm_ingest_lead');
    const after = fn(C5, 'public.crm_ingest_lead');
    const tail = '  on conflict (id) do nothing;\n  return v_id;\nend $$;';
    expect(before.endsWith(tail)).toBe(true);
    const head = before.slice(0, -tail.length);
    expect(after.startsWith(head + '  on conflict (id) do nothing;\n')).toBe(true);
    const added = after.slice(head.length);
    // The link is inside a block that catches every error, and the lead id is returned.
    expect(added).toMatch(
      /if found then\s+begin[\s\S]*perform app\.crm_link_lead_core\(p_tenant, v_id\);\s+exception when others then\s+raise warning '[^']*%[^']*', sqlstate;\s+end;\s+end if;\s+return v_id;\s+end \$\$;$/,
    );
    // The warning names a code, never a value.
    expect(added).not.toMatch(/sqlerrm|p_lead/);
  });

  it('crm_erase_lead: the actor is still checked live before the lead is read', () => {
    const after = fn(C5, 'public.crm_erase_lead');
    expect(after.indexOf('app.crm_eraser_ok(p_tenant, p_actor)')).toBeGreaterThan(0);
    expect(after.indexOf('app.crm_eraser_ok(p_tenant, p_actor)')).toBeLessThan(
      after.indexOf('from public.leads l'),
    );
  });
});
