import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProjectTemplateCopySchema,
  ServiceTemplateCopySchema,
  TEMPLATE_COPY_KEYS,
  TEMPLATE_COPY_TEXT_MAX,
  TEMPLATE_KINDS,
  TemplateCopyWriteSchema,
  templateCopyLine,
  type TemplateCopyKey,
} from '@schemas/templateCopy';
import { SERVICE_PAGE_COPY, VALUE_ACCENT } from '@/lib/services/pageCopy';
import { BREAKDOWN_ACCENT, CASE_PAGE_COPY, GALLERY_ACCENT } from '@/lib/portfolio/pageCopy';
import {
  BUILT_IN_CASE_COPY,
  BUILT_IN_SERVICE_COPY,
  builtInTemplateCopy,
  caseCopyFrom,
  parseStoredCopy,
  serviceCopyFrom,
} from '@/lib/templates/copy';

// The template pages' shared text (Admin v2 E3, `public.template_copy`): the write schema the
// singleton kernel validates with (the SQL CHECK app.template_copy_ok is its twin, held to the
// same keys by tests/lib/templateCopySql.spec.ts and proven in
// supabase/tests/template_copy.test.sql), the key-by-key resolver every template page renders
// through, and the one public reader, which never throws.

const BI = (en: string, ar: string) => ({ en, ar });
const LINE = BI('Read the story', 'اقرأ القصة');
const entries = (kind: 'service' | 'project') =>
  Object.entries(TEMPLATE_COPY_KEYS[kind]) as [string, TemplateCopyKey][];

describe('the catalogue', () => {
  it('two templates; every text key within the SQL bound; every accent names a text key of its own template', () => {
    expect([...TEMPLATE_KINDS]).toEqual(['service', 'project']);
    for (const kind of TEMPLATE_KINDS) {
      for (const [key, def] of entries(kind)) {
        if (def.kind === 'text') {
          expect(def.max, key).toBeGreaterThan(0);
          expect(def.max, key).toBeLessThanOrEqual(TEMPLATE_COPY_TEXT_MAX);
        } else {
          expect(TEMPLATE_COPY_KEYS[kind], key).toHaveProperty(def.of);
          expect(key, key).toBe(`${def.of}Accent`);
        }
      }
    }
  });

  it('is the built-in words, key for key, but "Confidential client" (shared with the Our Work cards)', () => {
    const textKeys = (kind: 'service' | 'project') =>
      entries(kind)
        .filter(([, def]) => def.kind === 'text')
        .map(([key]) => key)
        .sort();
    const builtIn = (words: object) =>
      Object.keys(words)
        .filter((key) => key !== 'confidential')
        .sort();
    expect(textKeys('service')).toEqual(builtIn(SERVICE_PAGE_COPY.en));
    expect(textKeys('service')).toEqual(builtIn(SERVICE_PAGE_COPY.ar));
    expect(textKeys('project')).toEqual(builtIn(CASE_PAGE_COPY.en));
    expect(textKeys('project')).toEqual(builtIn(CASE_PAGE_COPY.ar));
  });

  it('the built-in words pass their own schema in both languages (each fits its cap)', () => {
    for (const kind of TEMPLATE_KINDS) {
      const builtIn = builtInTemplateCopy(kind);
      expect(Object.keys(builtIn), kind).toEqual(Object.keys(TEMPLATE_COPY_KEYS[kind]));
      const schema = kind === 'service' ? ServiceTemplateCopySchema : ProjectTemplateCopySchema;
      const parsed = schema.safeParse(builtIn);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    }
    expect(builtInTemplateCopy('service')['valueHeadingAccent']).toEqual(VALUE_ACCENT);
    expect(builtInTemplateCopy('project')['breakdownHeadingAccent']).toEqual(BREAKDOWN_ACCENT);
    expect(builtInTemplateCopy('project')['galleryHeadingAccent']).toEqual(GALLERY_ACCENT);
  });
});

describe('the write schema (the CHECK app.template_copy_ok is its twin)', () => {
  it('takes either template, or both, with the version; nothing else', () => {
    expect(TemplateCopyWriteSchema.parse({ service: { seeCase: LINE }, version: 1 })).toEqual({
      service: { seeCase: LINE },
      version: 1,
    });
    expect(
      TemplateCopyWriteSchema.safeParse({ service: {}, project: {}, version: 0 }).success,
    ).toBe(true);
    expect(TemplateCopyWriteSchema.safeParse({ service: {} }).success).toBe(false);
    expect(
      TemplateCopyWriteSchema.safeParse({ service: {}, version: 1, tenant_id: 'x' }).success,
    ).toBe(false);
    expect(TemplateCopyWriteSchema.safeParse({ blog: {}, version: 1 }).success).toBe(false);
  });

  it('a closed catalogue: a key of the other template, or of none, is refused', () => {
    expect(ServiceTemplateCopySchema.safeParse({ nextProject: LINE }).success).toBe(false);
    expect(ProjectTemplateCopySchema.safeParse({ seeCase: LINE }).success).toBe(false);
    expect(ServiceTemplateCopySchema.safeParse({ confidential: LINE }).success).toBe(false);
    expect(ServiceTemplateCopySchema.safeParse({ __proto__x: LINE }).success).toBe(false);
  });

  it('Arabic is required like English; each half is trimmed, then must not be empty', () => {
    const line = templateCopyLine(40);
    expect(line.parse(BI('  Read it ', ' اقرأ '))).toEqual(BI('Read it', 'اقرأ'));
    for (const bad of [{ en: 'Read' }, { ar: 'اقرأ' }, BI('Read', '   '), BI('', 'اقرأ'), {}]) {
      expect(line.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(line.safeParse({ ...LINE, fr: 'Lire' }).success).toBe(false);
  });

  it('plain text: no angle bracket, no line break, no C0 or C1 control character', () => {
    const line = templateCopyLine(40);
    for (const bad of [
      '<b>Read</b>',
      'a > b',
      'one\ntwo',
      'tab\there',
      'nul\u0000',
      'c1\u0085',
      'del\u007f',
    ]) {
      expect(line.safeParse(BI(bad, 'اقرأ')).success, JSON.stringify(bad)).toBe(false);
      expect(line.safeParse(BI('Read', `${bad}اقرأ`)).success, JSON.stringify(bad)).toBe(false);
    }
    // Quotes, ampersands and braces are words (Astro escapes text; {c} is a placeholder).
    expect(line.safeParse(BI(`Tom & Jerry's "{c}"`, 'اقرأ')).success).toBe(true);
  });

  it('each key holds its own cap, in characters, per language', () => {
    for (const kind of TEMPLATE_KINDS) {
      const schema = kind === 'service' ? ServiceTemplateCopySchema : ProjectTemplateCopySchema;
      for (const [key, def] of entries(kind)) {
        if (def.kind !== 'text') continue;
        const ok = (en: string, ar: string) => schema.safeParse({ [key]: BI(en, ar) }).success;
        expect(ok('a'.repeat(def.max), 'ب'.repeat(def.max)), key).toBe(true);
        expect(ok('a'.repeat(def.max + 1), 'ب'), key).toBe(false);
        expect(ok('a', 'ب'.repeat(def.max + 1)), key).toBe(false);
      }
    }
  });

  it('an accent is a word range per language, never markup, `to` after `from`', () => {
    const ok = (accent: unknown) =>
      ServiceTemplateCopySchema.safeParse({ valueHeadingAccent: accent }).success;
    expect(ok({ en: { from: 1, to: 3 } })).toBe(true);
    expect(ok({ ar: { from: 0 } })).toBe(true);
    expect(ok({})).toBe(true);
    expect(ok({ en: { from: 3, to: 2 } })).toBe(false);
    expect(ok({ en: { from: 1, colour: 'red' } })).toBe(false);
    expect(ok({ fr: { from: 1 } })).toBe(false);
    expect(ok('<em>worth it</em>')).toBe(false);
  });
});

describe('the resolver: the built-in words with the stored ones laid over, key by key', () => {
  it('nothing stored is every built-in word and accent, in both languages', () => {
    for (const stored of [null, undefined, {}, [], 'text', 7]) {
      expect(serviceCopyFrom(stored)).toEqual(BUILT_IN_SERVICE_COPY);
      expect(caseCopyFrom(stored)).toEqual(BUILT_IN_CASE_COPY);
    }
    expect(BUILT_IN_SERVICE_COPY.en).toEqual(SERVICE_PAGE_COPY.en);
    expect(BUILT_IN_SERVICE_COPY.ar).toEqual(SERVICE_PAGE_COPY.ar);
    expect(BUILT_IN_SERVICE_COPY.valueAccent).toEqual(VALUE_ACCENT);
    expect(BUILT_IN_CASE_COPY.en).toEqual(CASE_PAGE_COPY.en);
    expect(BUILT_IN_CASE_COPY.ar).toEqual(CASE_PAGE_COPY.ar);
    expect(BUILT_IN_CASE_COPY.breakdownAccent).toEqual(BREAKDOWN_ACCENT);
    expect(BUILT_IN_CASE_COPY.galleryAccent).toEqual(GALLERY_ACCENT);
  });

  it('a stored line replaces that key in both languages and nothing else', () => {
    const copy = serviceCopyFrom({ seeCase: LINE });
    expect(copy.en).toEqual({ ...SERVICE_PAGE_COPY.en, seeCase: LINE.en });
    expect(copy.ar).toEqual({ ...SERVICE_PAGE_COPY.ar, seeCase: LINE.ar });
    expect(copy.valueAccent).toEqual(VALUE_ACCENT);
  });

  it('a bad key costs that key its built-in words, never the page; unknown keys are ignored', () => {
    const stored = {
      seeCase: LINE,
      skip: { en: '<script>x</script>', ar: 'ب' },
      get: { en: 'Only English' },
      confidential: LINE,
      nope: LINE,
      fab: BI('a'.repeat(41), 'ب'),
    };
    expect(parseStoredCopy('service', stored)).toEqual({ seeCase: LINE });
    const copy = serviceCopyFrom(stored);
    expect(copy.en.seeCase).toBe(LINE.en);
    expect(copy.en.skip).toBe(SERVICE_PAGE_COPY.en.skip);
    expect(copy.en.get).toBe(SERVICE_PAGE_COPY.en.get);
    expect(copy.en.confidential).toBe(SERVICE_PAGE_COPY.en.confidential);
    expect(copy.en.fab).toBe(SERVICE_PAGE_COPY.en.fab);
  });

  it('an accented heading: stored words take the stored accent, else none', () => {
    const heading = BI('Why it matters to you', 'ليش يهمك');
    expect(serviceCopyFrom({ valueHeading: heading }).valueAccent).toBeUndefined();
    expect(
      serviceCopyFrom({ valueHeading: heading, valueHeadingAccent: { en: { from: 3 } } })
        .valueAccent,
    ).toEqual({ en: { from: 3 } });
  });

  it('an accent stored alone colours the built-in heading (F5b)', () => {
    expect(serviceCopyFrom({ valueHeadingAccent: { ar: { from: 0 } } }).valueAccent).toEqual({
      ar: { from: 0 },
    });
    const copy = caseCopyFrom({ galleryHeadingAccent: { en: { from: 0, to: 1 } } });
    expect(copy.galleryAccent).toEqual({ en: { from: 0, to: 1 } });
    expect(copy.breakdownAccent).toEqual(BREAKDOWN_ACCENT);
    expect(copy.en.galleryHeading).toBe(CASE_PAGE_COPY.en.galleryHeading);
  });

  it('the project template reads only its own keys', () => {
    const copy = caseCopyFrom({ nextProject: BI('Up next', 'التالي'), seeCase: LINE });
    expect(copy.en.nextProject).toBe('Up next');
    expect(copy.ar.nextProject).toBe('التالي');
    expect(copy.en).not.toHaveProperty('seeCase');
  });
});

// ── The public reader (src/lib/data/templateCopy.ts) ─────────────────────────────────────────
const state = vi.hoisted(() => ({
  configured: true,
  row: null as Record<string, unknown> | null,
  error: null as { code: string; message: string } | null,
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
        maybeSingle: async () => ({ data: state.error ? null : state.row, error: state.error }),
      };
      return chain;
    },
  }),
}));

const { getCaseCopy, getServiceCopy, TEMPLATE_COPY_PUBLIC_COLUMNS } =
  await import('@/lib/data/templateCopy');

describe('the public reader never throws and falls back to the built-in words', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    Object.assign(state, { configured: true, row: null, error: null, throws: false, calls: [] });
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    error.mockRestore();
  });

  it('reads anon’s two columns of the tenant’s one row (RLS fences the tenant)', async () => {
    state.row = { service: { seeCase: LINE }, project: {} };
    const copy = await getServiceCopy();
    expect(state.calls).toEqual(['from template_copy', `select ${TEMPLATE_COPY_PUBLIC_COLUMNS}`]);
    expect(TEMPLATE_COPY_PUBLIC_COLUMNS).toBe('service,project');
    expect(copy.en.seeCase).toBe(LINE.en);
    expect(await getCaseCopy()).toEqual(BUILT_IN_CASE_COPY);
  });

  it('no row, no database, a failed read and a thrown read are the built-in words', async () => {
    expect(await getServiceCopy()).toBe(BUILT_IN_SERVICE_COPY);
    state.error = { code: '42501', message: 'permission denied' };
    expect(await getServiceCopy()).toBe(BUILT_IN_SERVICE_COPY);
    expect(await getCaseCopy()).toBe(BUILT_IN_CASE_COPY);
    state.error = null;
    state.throws = true;
    expect(await getServiceCopy()).toBe(BUILT_IN_SERVICE_COPY);
    state.throws = false;
    state.configured = false;
    state.calls = [];
    expect(await getCaseCopy()).toBe(BUILT_IN_CASE_COPY);
    expect(state.calls).toEqual([]);
  });
});
