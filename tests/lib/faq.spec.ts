import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FAQ_LIMITS,
  FaqItemRowSchema,
  FaqItemUpdateSchema,
  FaqItemWriteSchema,
  FaqTextSchema,
} from '@schemas/faq';

// The FAQ (Admin v2 U7, migration 0070): the write schema the admin API validates with
// (the database CHECK app.faq_text_ok states the same rules, proven in
// supabase/tests/rls_faq_items.test.sql) and the ONE public loader, getFaq, that feeds the
// Contact page's band and its FAQPage JSON-LD (tests/lib/contactPage.spec.ts holds the route
// to one read).

const BI = (en: string, ar: string) => ({ en, ar });
const Q = BI('What does a full brand identity include?', 'وش تشمل الهوية البصرية الكاملة؟');
const A = BI('The logo system, colours and type.', 'نظام الشعار والألوان والخطوط.');

describe('the FAQ write schema (and its CHECK twin, app.faq_text_ok)', () => {
  it('takes a bilingual question and answer; a new item is a draft at place 0', () => {
    const parsed = FaqItemWriteSchema.parse({ question: Q, answer: A });
    expect(parsed).toEqual({ question: Q, answer: A, status: 'draft', sortOrder: 0 });
  });

  it('trims each language, then refuses an empty one', () => {
    expect(
      FaqItemWriteSchema.parse({ question: BI('  Q?  ', ' س؟ '), answer: A }).question,
    ).toEqual(BI('Q?', 'س؟'));
    for (const question of [BI('', 'س'), BI('Q', '   '), { en: 'Q' }, { ar: 'س' }]) {
      expect(
        FaqItemWriteSchema.safeParse({ question, answer: A }).success,
        JSON.stringify(question),
      ).toBe(false);
    }
  });

  it('holds the limits: a question 200 characters, an answer 1200, per language', () => {
    expect(FAQ_LIMITS).toEqual({ question: 200, answer: 1200 });
    const ok = (question: object, answer: object) =>
      FaqItemWriteSchema.safeParse({ question, answer }).success;
    expect(ok(BI('q'.repeat(200), 'س'.repeat(200)), A)).toBe(true);
    expect(ok(BI('q'.repeat(201), 'س'), A)).toBe(false);
    expect(ok(BI('q', 'س'.repeat(201)), A)).toBe(false);
    expect(ok(Q, BI('a'.repeat(1200), 'ج'.repeat(1200)))).toBe(true);
    expect(ok(Q, BI('a'.repeat(1201), 'ج'))).toBe(false);
  });

  it('one paragraph: a line break or any other control character is refused', () => {
    // The band's HTML folds a newline the FAQPage JSON-LD would keep: the two would differ.
    for (const bad of ['line one\nline two', 'tab\there', 'cr\rhere', 'nul\u0000', 'c1\u0085']) {
      expect(FaqTextSchema(200).safeParse(BI(bad, 'س')).success, JSON.stringify(bad)).toBe(false);
      expect(FaqTextSchema(200).safeParse(BI('Q', `${bad}س`)).success, JSON.stringify(bad)).toBe(
        false,
      );
    }
  });

  it('plain text: angle brackets are words here (rendered as text, escaped in the JSON-LD)', () => {
    expect(FaqTextSchema(200).safeParse(BI('Is <b> bold?', 'هل <b> عريض؟')).success).toBe(true);
  });

  it('exactly English and Arabic: an extra language or a non-string is refused', () => {
    expect(FaqTextSchema(200).safeParse({ ...Q, fr: 'Q' }).success).toBe(false);
    expect(FaqTextSchema(200).safeParse({ en: 1, ar: 'س' }).success).toBe(false);
    expect(FaqTextSchema(200).safeParse('Q').success).toBe(false);
  });

  it('an update names its version and may carry any one field', () => {
    expect(FaqItemUpdateSchema.safeParse({ answer: A }).success).toBe(false);
    expect(FaqItemUpdateSchema.parse({ answer: A, version: 3 })).toEqual({ answer: A, version: 3 });
    expect(FaqItemUpdateSchema.parse({ status: 'published', version: 1 })).toEqual({
      status: 'published',
      version: 1,
    });
  });

  it('the public row schema is not strict: a column added later is ignored, never a dropped row', () => {
    const row = { id: '5eedfa00-0000-4000-8000-000000000001', question: Q, answer: A };
    expect(FaqItemRowSchema.parse({ ...row, sort_order: 10, status: 'published' })).toEqual({
      ...row,
      sort_order: 10,
    });
  });

  it('the migration states the same rules as a CHECK (the limits and the control range)', () => {
    const sql = readFileSync('supabase/migrations/0070_faq_items.sql', 'utf8');
    expect(sql).toContain('check (app.faq_text_ok(question, 200))');
    expect(sql).toContain('check (app.faq_text_ok(answer, 1200))');
    expect(sql).toContain("v.x ~ '[\\u0001-\\u001F\\u007F-\\u009F]'");
  });
});

// ── the loader ───────────────────────────────────────────────────────────────────────────

const state = vi.hoisted(() => ({
  configured: true,
  rows: [] as unknown[],
  error: null as { code: string } | null,
  throws: false,
  calls: [] as string[],
}));

vi.mock('@/lib/supabase/client', () => ({ supabaseConfigured: () => state.configured }));
vi.mock('@/lib/data/source', () => ({
  contentClient: () => ({
    from: (table: string) => {
      state.calls.push(`from ${table}`);
      if (state.throws) throw new Error('network down');
      const chain = {
        select: (cols: string) => (state.calls.push(`select ${cols}`), chain),
        eq: (col: string, val: unknown) => (state.calls.push(`eq ${col}=${String(val)}`), chain),
        order: (col: string, opts: { ascending: boolean }) => (
          state.calls.push(`order ${col} ${opts.ascending ? 'asc' : 'desc'}`),
          chain
        ),
        limit: async (n: number) => {
          state.calls.push(`limit ${n}`);
          return { data: state.error ? null : state.rows, error: state.error };
        },
      };
      return chain;
    },
  }),
}));

const { getFaq, FAQ_MAX_ITEMS } = await import('@/lib/data/faq');

const row = (n: number, extra: object = {}) => ({
  id: `5eedfa00-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`,
  question: BI(`Question ${n}?`, `سؤال ${n}؟`),
  answer: BI(`Answer ${n}.`, `إجابة ${n}.`),
  sort_order: n * 10,
  ...extra,
});

describe('getFaq: the one read behind the band and the FAQPage', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    Object.assign(state, { configured: true, rows: [], error: null, throws: false, calls: [] });
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it('reads published rows only, in the editors’ order, at most 50, anon’s columns', async () => {
    state.rows = [row(1), row(2)];
    await getFaq('en');
    expect(state.calls).toEqual([
      'from faq_items',
      'select id,question,answer,sort_order',
      'eq status=published',
      'order sort_order asc',
      `limit ${FAQ_MAX_ITEMS}`,
    ]);
    expect(FAQ_MAX_ITEMS).toBe(50);
  });

  it('answers the reader’s language, in the order read', async () => {
    state.rows = [row(1), row(2)];
    expect(await getFaq('en')).toEqual([
      { question: 'Question 1?', answer: 'Answer 1.' },
      { question: 'Question 2?', answer: 'Answer 2.' },
    ]);
    expect(await getFaq('ar')).toEqual([
      { question: 'سؤال 1؟', answer: 'إجابة 1.' },
      { question: 'سؤال 2؟', answer: 'إجابة 2.' },
    ]);
  });

  it('a malformed row is dropped (and logged), the rest still shown', async () => {
    state.rows = [row(1), { ...row(2), question: { en: 'Only English' } }, row(3)];
    expect((await getFaq('en')).map((e) => e.question)).toEqual(['Question 1?', 'Question 3?']);
  });

  it('a failed read answers [] and logs its code: no band and no FAQPage, never one alone', async () => {
    state.error = { code: '42P01' };
    expect(await getFaq('en')).toEqual([]);
    expect(String(warn.mock.calls[0]?.[0])).toContain('faq_items load failed (code=42P01)');
  });

  it('a thrown read answers [] too', async () => {
    state.throws = true;
    expect(await getFaq('ar')).toEqual([]);
    expect(String(warn.mock.calls[0]?.[0])).toContain('faq_items load failed');
  });

  it('with no database configured, there is no FAQ and nothing is read', async () => {
    state.configured = false;
    expect(await getFaq('en')).toEqual([]);
    expect(state.calls).toEqual([]);
  });
});
