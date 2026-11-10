import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Admin v2 C8 (0134) restates four of C5's functions (0131): the orphan rule (a task keeps an
// auto-contact), the nightly run (the tasks' purge and its count), and the two person-erasure
// doors (the tasks counted). The migration says each is C5's copy plus the lines marked
// `-- C8`; this holds it to that, so a later edit to the copy (or a fix to C5's function that
// the copy would silently undo) fails here instead of in production.

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations');
const read = (file: string) => readFileSync(join(MIGRATIONS, file), 'utf8').replace(/\r\n/g, '\n');
const C5 = read('0131_crm_contacts.sql');
const C8 = read('0134_crm_tasks.sql');

/** One `create or replace function <name>(` up to `end` (`end $$;` or a SQL body's `$$;`). */
function fn(sql: string, name: string, end: string): string {
  const start = sql.indexOf(`create or replace function ${name}(`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const stop = sql.indexOf(end, start);
  expect(stop, name).toBeGreaterThan(start);
  return sql.slice(start, stop + end.length);
}

/** The copy without the lines C8 added. */
const withoutC8 = (text: string) =>
  text
    .split('\n')
    .filter((line) => !/ {2}-- C8$/.test(line))
    .join('\n');

const RESTATED: readonly [string, string, RegExp][] = [
  ['app.crm_contact_is_orphan', '$$;', /public\.crm_tasks tk/],
  ['app.run_retention', 'end $$;', /app\.purge_crm_tasks\(\)/],
  ['public.crm_erase_preview', 'end $$;', /'tasks', \(select count/],
  ['public.crm_erase_person', 'end $$;', /'tasks', v_tasks/],
];

describe('0134 restates C5’s functions with its marked lines only', () => {
  for (const [name, end, change] of RESTATED) {
    it(`${name}: 0131’s text plus the -- C8 lines`, () => {
      const before = fn(C5, name, end);
      const after = fn(C8, name, end);
      expect(after).toMatch(change);
      expect(withoutC8(after)).toBe(before);
      expect(after.split('\n').filter((l) => / {2}-- C8$/.test(l)).length).toBeGreaterThan(0);
    });
  }

  it('the erasure doors still check the actor live before anything else', () => {
    for (const name of ['public.crm_erase_preview', 'public.crm_erase_person']) {
      const after = fn(C8, name, 'end $$;');
      expect(after.indexOf('app.crm_eraser_ok(p_tenant, p_actor)'), name).toBeGreaterThan(0);
      expect(after.indexOf('app.crm_eraser_ok(p_tenant, p_actor)'), name).toBeLessThan(
        after.indexOf('crm_tasks'),
      );
    }
  });

  it('the task readers and writers are SECURITY INVOKER, never definers', () => {
    for (const name of [
      'public.crm_tasks_grouped',
      'public.crm_task_create',
      'public.crm_task_update',
      'public.crm_task_delete',
    ]) {
      const head = fn(C8, name, 'as $$');
      expect(head, name).toMatch(/security invoker/);
      expect(head, name).not.toMatch(/security definer/);
    }
  });
});
