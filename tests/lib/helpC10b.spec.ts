import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HelpArticleSeedSchema, type HelpArticleRow } from '@schemas/help';
import { ROLES } from '@/lib/auth/types';
import { ROLE_CAPS } from '@/lib/authz/matrix';
import { mayRead } from '@/lib/admin/help';
import { visibleNav } from '@/lib/admin/nav';
import { PII_REVEAL_LIMITS } from '@/lib/admin/rateLimit';
import { CONTACT_REVEAL_OP } from '@/lib/crm/contactReveal';
import { helpSet, readMigrations } from '../fixtures/helpSet';

// The guides Admin v2 C10b puts through H11's catalog (the Sales contacts migration):
// `the-sales-role` and `roles-and-access` again, because Sales now also works the contacts
// behind the leads and the follow-up tasks. Each is held to the revision the migrations
// before it leave, to the blocks it changes (and only those), to its filed copy, and to the
// code behind what it says.

const FILES = readMigrations();
const MIGRATION = FILES.find((f) => /^\d{4}_crm_sales_contacts\.sql$/.test(f.name));
const AT = MIGRATION ? FILES.indexOf(MIGRATION) : FILES.length;
const BEFORE = helpSet(FILES.slice(0, AT));
const AFTER = helpSet(FILES.slice(0, AT + 1));

const parse = (set: typeof AFTER, slug: string): HelpArticleRow =>
  HelpArticleSeedSchema.parse(set.set.find((g) => g.slug === slug));
const flat = (g: HelpArticleRow, lang: 'en' | 'ar') =>
  g.body[lang].flatMap((b) => (Array.isArray(b.x) ? b.x : [b.x]));
const words = (g: HelpArticleRow, lang: 'en' | 'ar') => flat(g, lang).join('\n');
const source = (path: string) => readFileSync(path, 'utf8');

describe('the guides the Sales contacts migration puts (Admin v2 C10b)', () => {
  it('puts exactly two, each at the revision the migrations before it leave', () => {
    expect(MIGRATION, 'the Sales contacts migration').toBeDefined();
    expect(AFTER.edits.filter((e) => e.file === MIGRATION!.name)).toEqual([
      {
        file: MIGRATION!.name,
        op: 'put',
        slug: 'the-sales-role',
        revision: BEFORE.revisions.get('the-sales-role')!,
      },
      {
        file: MIGRATION!.name,
        op: 'put',
        slug: 'roles-and-access',
        revision: BEFORE.revisions.get('roles-and-access')!,
      },
    ]);
    for (const slug of ['the-sales-role', 'roles-and-access'])
      expect(AFTER.revisions.get(slug), slug).toBe(BEFORE.revisions.get(slug)! + 1);
    const mine = ['the-sales-role', 'roles-and-access'];
    const others = (set: typeof AFTER.set) => set.filter((g) => !mine.includes(g.slug));
    expect(others(AFTER.set)).toEqual(others(BEFORE.set));
  });

  it('the Sales guide literal is its file in docs/admin-v2/guides, byte for byte', () => {
    const literal = [
      ...MIGRATION!.sql.matchAll(
        /^select app\.put_help_guide\(\$guide\$\r?\n([\s\S]*?)\r?\n\$guide\$::jsonb, \d+\);/gm,
      ),
    ]
      .map((m) => m[1]!)
      .find((l) => (JSON.parse(l) as { slug: string }).slug === 'the-sales-role');
    expect(literal).toBe(
      readFileSync('docs/admin-v2/guides/the-sales-role.json', 'utf8').replace(/\r?\n$/, ''),
    );
  });
});

describe('the-sales-role: contacts and tasks, one person at a time, no erasure', () => {
  const before = () => parse(BEFORE, 'the-sales-role');
  const after = () => parse(AFTER, 'the-sales-role');

  it('keeps its place, titles, caps, tags and screens and its block kinds; three minutes now', () => {
    const keep = (g: HelpArticleRow) => [
      g.sort_order,
      g.title,
      g.title_ar,
      g.caps,
      g.tags,
      g.screens,
    ];
    expect(keep(after())).toEqual(keep(before()));
    expect(after().minutes).toBe(3);
    for (const lang of ['en', 'ar'] as const) {
      expect(
        after().body[lang].map((b) => b.t),
        lang,
      ).toEqual(before().body[lang].map((b) => b.t));
      // Two lines more (Contacts, Tasks); the bell-settings line, the notes line, the dashboard
      // line, the export line and the "cannot change content" line stay word for word.
      expect(flat(after(), lang), lang).toHaveLength(flat(before(), lang).length + 2);
      const kept = flat(before(), lang).filter((line) => flat(after(), lang).includes(line));
      expect(kept.length, lang).toBe(flat(before(), lang).length - 3);
    }
  });

  it('says what the code does: contacts and tasks, the shared reveal limit, a confirm counts', () => {
    const en = words(after(), 'en');
    expect(en).toContain('works leads, the contacts behind them and follow-up tasks');
    expect(ROLE_CAPS.sales['crm.contacts']).toBe('full');
    expect(ROLE_CAPS.sales['crm.tasks']).toBe('full');
    expect(en).toContain(
      "Reveal one lead's contact details, budget and timeline at a time, or one contact's e-mails and phones.",
    );
    expect(en).toContain(
      `up to ${PII_REVEAL_LIMITS.perUser} an hour for each person and ${PII_REVEAL_LIMITS.perTenant} an hour for the whole team, leads and contacts together`,
    );
    // One limiter for both reveals (the contact reveal claims the lead reveal's key).
    expect(CONTACT_REVEAL_OP).toBe('pii-reveal');
    expect(source('src/lib/crm/reveal.ts')).toContain("'pii-reveal'");
    expect(en).toContain('Confirming a match counts as a reveal');
    expect(source('src/pages/api/admin/crm/contacts/[id]/links.ts')).toContain(
      'claimPrivilegedOp(auth, CONTACT_REVEAL_OP, PII_REVEAL_LIMITS)',
    );
    // The screens it names are the ones Sales' menu now offers.
    expect(en).toContain('Open Contacts');
    expect(en).toContain('Plan follow-up tasks in Tasks');
    const crm = visibleNav('sales')
      .find((g) => g.title === 'CRM')
      ?.links.map((l) => l.label);
    expect(crm).toEqual(['Leads', 'Contacts', 'Tasks']);
  });

  it('says what Sales still cannot do: erase a lead, a contact, a channel or a contact note', () => {
    const en = words(after(), 'en');
    expect(en).toContain(
      "Erase a lead or a contact, remove a contact's e-mail or phone, delete a contact's note, or receive a new lead's contact details in a notification.",
    );
    expect(ROLE_CAPS.sales['crm.erase']).toBe('none');
    expect(source('src/pages/api/admin/crm/contacts/[id]/notes/[noteId].ts')).toContain(
      "cap: 'crm.erase'",
    );
    // (C10b review, C10B-SEC-2) A removal is crm.erase's in the Worker and in the door.
    expect(source('src/pages/api/admin/crm/contacts/[id].ts')).toContain(
      "(input.channels.remove?.length ?? 0) > 0 && can(auth.role, 'crm.erase') !== 'full'",
    );
    expect(source('supabase/migrations/0136_crm_sales_contacts.sql')).toContain(
      'if cardinality(v_remove) > 0 and not app.crm_eraser_ok(p_tenant, p_actor) then',
    );
    expect(ROLE_CAPS.sales['export.csv']).toBe('none');
    expect(en).toContain('the Export CSV button does not show');
  });

  it('says the same in Arabic, the screen names kept in English as the admin shows them', () => {
    const ar = words(after(), 'ar');
    expect(ar).toContain('وجهات الاتصال التي تقف خلفهم ومهام المتابعة');
    expect(ar).toContain('يفتح Contacts');
    expect(ar).toContain('في Tasks');
    expect(ar).toContain('محو عميل محتمل أو جهة اتصال');
    expect(ar).toContain('إزالة بريد إلكتروني أو رقم هاتف من جهة اتصال');
    expect(ar).toContain('يُحتسب تأكيد التطابق كشفًا');
    expect(ar).toContain(`${PII_REVEAL_LIMITS.perUser} مرة`);
    expect(ar).toContain(`${PII_REVEAL_LIMITS.perTenant} مرة`);
    // P-12: no em or en dash in the new words.
    for (const lang of ['en', 'ar'] as const) expect(words(after(), lang)).not.toMatch(/[–—]/);
  });

  it('is still for the lead workers (leads.manage): Admin, Developer and Sales', () => {
    expect(ROLES.filter((r) => mayRead(r, after().caps))).toEqual(['admin', 'developer', 'sales']);
  });
});

describe('roles-and-access: the Sales line, and nothing else', () => {
  const before = () => parse(BEFORE, 'roles-and-access');
  const after = () => parse(AFTER, 'roles-and-access');

  it('changes only the fifth item of the list, in both languages', () => {
    const { body: b0, ...rest0 } = before();
    const { body: b1, ...rest1 } = after();
    expect(rest1).toEqual(rest0);
    for (const lang of ['en', 'ar'] as const) {
      expect(b1[lang].length, lang).toBe(b0[lang].length);
      b1[lang].forEach((block, i) => {
        if (i !== 1) expect(block, `${lang} ${i}`).toEqual(b0[lang][i]);
      });
      const list0 = b0[lang][1]!.x as string[];
      const list1 = b1[lang][1]!.x as string[];
      expect(list1.slice(0, 4), lang).toEqual(list0.slice(0, 4));
      expect(list1[4], lang).not.toBe(list0[4]);
    }
  });

  it('names the contacts, the tasks, one person at a time and no erasing', () => {
    expect(words(after(), 'en')).toContain(
      "Sales: works leads, the contacts behind them and follow-up tasks, reveals one person's contact details at a time, and reads the dashboard and the website stats. No content, settings, exports, erasing, job applications, logs or people.",
    );
    expect(words(after(), 'ar')).toContain('ولا تصدير ولا محو');
    // Developer's line is unchanged: it holds no crm.* (owner default O-7).
    expect(ROLE_CAPS.developer['crm.contacts']).toBe('none');
    expect(ROLE_CAPS.developer['crm.tasks']).toBe('none');
  });
});
