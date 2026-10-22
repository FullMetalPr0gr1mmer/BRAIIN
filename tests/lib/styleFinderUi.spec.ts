import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AiConfigSchema, AiQuestionWriteSchema } from '@schemas/admin';
import { AI_IP_LIMIT, AI_SESSION_LIMIT } from '@/lib/ai/rateLimit';
import { aiConfigUi } from '@/lib/admin/ui/aiConfig';
import { aiQuestionsUi } from '@/lib/admin/ui/aiQuestions';
import { aiStylesUi } from '@/lib/admin/ui/aiStyles';
import { formToPayload, rowToForm } from '@/lib/admin/formPayload';
import { STYLE_FINDER_CONFIG_NOT_READ, STYLE_FINDER_NOT_LIVE } from '@/lib/admin/styleFinderCopy';

// The Style-Finder screens on the field kit (Admin v2 U8a). The quiz is not live: the
// endpoint is the 501 stub with code-constant limits, and nothing reads ai_config. What the
// screens say about that is held to the code here, so a change to either fails one test.

const field = (fields: readonly { name: string }[], name: string) =>
  fields.find((f) => f.name === name) as (typeof aiConfigUi.fields)[number];

describe('a question’s options are a repeater the schema accepts', () => {
  const options = field(aiQuestionsUi.fields, 'options');

  it('at most 20 items of a short key and its words in both languages', () => {
    expect(options).toMatchObject({ kind: 'repeater', maxItems: 20 });
    expect(options.itemFields?.map((f) => [f.name, f.kind, f.maxLength])).toEqual([
      ['value', 'text', 60],
      ['label', 'bilingual', undefined],
    ]);
    const item = { value: 'x', label: { en: 'x', ar: 'س' } };
    const base = { slug: 'q', prompt: { en: 'Q', ar: 'س' } };
    expect(
      AiQuestionWriteSchema.safeParse({ ...base, options: Array(20).fill(item) }).success,
    ).toBe(true);
    expect(
      AiQuestionWriteSchema.safeParse({ ...base, options: Array(21).fill(item) }).success,
    ).toBe(false);
    expect(
      AiQuestionWriteSchema.safeParse({ ...base, options: [{ ...item, value: 'v'.repeat(61) }] })
        .success,
    ).toBe(false);
  });

  it('a stored question round-trips through the form into a payload the schema takes', () => {
    const row = {
      slug: 'palette',
      prompt: { en: 'Pick a palette', ar: 'اختر لوحة' },
      help_text: null,
      input_type: 'single',
      options: [
        { value: 'warm', label: { en: 'Warm', ar: 'دافئ' } },
        { value: 'cool', label: { en: 'Cool', ar: 'بارد' } },
      ],
      sort_order: 1,
      status: 'draft',
    };
    const payload = formToPayload(rowToForm(row, aiQuestionsUi.fields), aiQuestionsUi.fields);
    expect(payload['options']).toEqual(row.options);
    expect(AiQuestionWriteSchema.safeParse(payload).success).toBe(true);
  });

  it('the list’s Input column is the select field, so it can show the option’s words', () => {
    const input = aiQuestionsUi.columns.find((c) => c.key === 'input_type');
    expect(input).toBeDefined();
    expect(field(aiQuestionsUi.fields, 'inputType')).toMatchObject({ kind: 'select' });
  });
});

describe('Results & logic says what is true today', () => {
  it('the limits’ hints name the stub’s fixed limits', () => {
    expect(field(aiConfigUi.fields, 'perIpHourlyLimit').help).toContain(
      `fixed at ${AI_IP_LIMIT} an hour`,
    );
    expect(field(aiConfigUi.fields, 'perSessionHourlyLimit').help).toContain(
      `fixed at ${AI_SESSION_LIMIT} an hour`,
    );
  });

  it('every number a hint or a cap states is the schema’s ceiling', () => {
    const shape = AiConfigSchema.shape;
    const max = (schema: { maxValue?: number | null; maxLength?: number | null }) =>
      schema.maxValue ?? schema.maxLength;
    const unwrap = (s: unknown) =>
      (s as { unwrap?: () => unknown }).unwrap?.() as {
        maxValue?: number | null;
        maxLength?: number | null;
        unwrap?: () => unknown;
      };
    const cap = unwrap(shape.dailyUsdCap);
    expect(field(aiConfigUi.fields, 'dailyUsdCap').help).toContain(`At most ${max(cap)}`);
    for (const name of ['perIpHourlyLimit', 'perSessionHourlyLimit'] as const) {
      expect(field(aiConfigUi.fields, name).help).toContain(
        `From 1 to ${max(unwrap(shape[name]))}`,
      );
    }
    expect(field(aiConfigUi.fields, 'model').maxLength).toBe(max(unwrap(shape.model)));
    const prompt = unwrap(unwrap(shape.systemPrompt));
    expect(field(aiConfigUi.fields, 'systemPrompt').maxLength).toBe(max(prompt));
  });

  it('every hint about a stored value says nothing reads it yet', () => {
    for (const name of ['enabled', 'dailyUsdCap', 'perIpHourlyLimit', 'perSessionHourlyLimit']) {
      expect(field(aiConfigUi.fields, name).help, name).toMatch(/Not read yet/);
    }
    expect(field(aiConfigUi.fields, 'scoring').label).toBe('Scoring (advanced)');
    expect(field(aiStylesUi.fields, 'traits').label).toBe('Traits (advanced)');
  });
});

describe('the screens’ notes are true of the stub', () => {
  const stub = readFileSync('src/pages/api/ai/style-finder.ts', 'utf8');

  it('the endpoint is still the 501 stub, and nothing outside the admin reads ai_config', () => {
    expect(stub).toMatch(/501/);
    expect(stub).not.toMatch(/ai_config/);
    expect(STYLE_FINDER_NOT_LIVE).toContain('not on the site yet');
    expect(STYLE_FINDER_CONFIG_NOT_READ).toContain('Nothing here is read yet');
  });

  it('each Style-Finder screen shows its note, in plain words (no dash)', () => {
    for (const [page, name] of [
      ['src/pages/admin/ai-questions/index.astro', 'STYLE_FINDER_NOT_LIVE'],
      ['src/pages/admin/ai-styles/index.astro', 'STYLE_FINDER_NOT_LIVE'],
      ['src/pages/admin/ai-config.astro', 'STYLE_FINDER_CONFIG_NOT_READ'],
    ] as const) {
      expect(readFileSync(page, 'utf8'), page).toContain(`{${name}}`);
    }
    for (const words of [STYLE_FINDER_NOT_LIVE, STYLE_FINDER_CONFIG_NOT_READ]) {
      expect(words).not.toMatch(/[–—]/);
    }
  });
});
