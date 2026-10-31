import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  APPLICATION_FIELDS,
  APPLICATION_OPTIONAL_FIELDS,
  ApplicationConfigSchema,
  FORM_COPY_FORBIDDEN,
  INQUIRY_FIELDS,
  INQUIRY_OPTIONAL_FIELDS,
  InquiryConfigSchema,
} from '@schemas/forms';
import { BUDGET_BANDS } from '@schemas/lead';
import { RECRUITMENT_POLICY_VERSION } from '@consent/recruitment';
import {
  consentBase,
  fieldState,
  moved,
  nextConsentVersion,
  oneLine,
  orderOf,
  parseStored,
  serialise,
  withButton,
  withField,
  withKeyedCopy,
  withOrder,
  type FieldMeta,
} from '@/lib/admin/forms/editor';
import { editorPropsFor } from '@/lib/admin/forms/editorProps';
import { INQUIRY_LABELS } from '@/lib/forms/config';
import { projectedConsentRevision } from '@/lib/forms/revision';
import { pageButtonsFrom } from '@/lib/admin/forms/pageButtons';

// The Forms editor's model (Admin v2 E8, src/lib/admin/forms/editor.ts) and its props
// (editorProps.ts): what the island saves is the smallest difference from the built-in form,
// and always a value the strict schema accepts.

const BI = (en: string, ar: string) => ({ en, ar });
const inquiry = editorPropsFor('inquiry');
const join = editorPropsFor('join');
const meta = (key: string, props = inquiry): FieldMeta => props.fields.find((f) => f.key === key)!;

describe('the props come from the code', () => {
  it('every field, in the built-in order, optional exactly where the schema says', () => {
    expect(inquiry.fields.map((f) => f.key)).toEqual([...INQUIRY_FIELDS]);
    expect(inquiry.fields.filter((f) => f.optional).map((f) => f.key)).toEqual([
      ...INQUIRY_OPTIONAL_FIELDS,
    ]);
    expect(join.fields.map((f) => f.key)).toEqual([...APPLICATION_FIELDS]);
    expect(join.fields.filter((f) => f.optional).map((f) => f.key)).toEqual([
      ...APPLICATION_OPTIONAL_FIELDS,
    ]);
    expect(meta('phone').label).toEqual(INQUIRY_LABELS.phone);
    expect(meta('phone').where).toBe('Asked on the services pages');
    expect(meta('name').where).toBeUndefined();
    expect(inquiry.budgets!.map((b) => b.key)).toEqual([...BUDGET_BANDS]);
    expect(join.notice).toBe(RECRUITMENT_POLICY_VERSION);
    expect(join.groups!.map((g) => g.id)).toEqual(['about', 'role', 'work']);
  });
});

describe('a change is saved as the smallest difference', () => {
  it('a label equal to the built-in one, or blank, is no override', () => {
    const phone = meta('phone');
    const state = fieldState({}, phone);
    expect(withField({}, phone, { ...state, label: phone.label })).toEqual({});
    expect(withField({}, phone, { ...state, label: BI('  ', '') })).toEqual({});
    const relabelled = withField({}, phone, { ...state, label: BI('Mobile', 'الجوال') });
    expect(relabelled).toEqual({ fields: { phone: { label: BI('Mobile', 'الجوال') } } });
    expect(InquiryConfigSchema.safeParse(relabelled).success).toBe(true);
  });

  it('"shown" is stored only off, "required" only on, and hiding clears required', () => {
    const phone = meta('phone');
    const required = withField({}, phone, { ...fieldState({}, phone), required: true });
    expect(required).toEqual({ fields: { phone: { required: true } } });
    const hidden = withField(required, phone, {
      ...fieldState(required, phone),
      visible: false,
      required: true,
    });
    expect(hidden).toEqual({ fields: { phone: { visible: false } } });
    expect(InquiryConfigSchema.safeParse(hidden).success).toBe(true);
    const back = withField(hidden, phone, { ...fieldState(hidden, phone), visible: true });
    expect(back).toEqual({});
  });

  it('a pipeline field can only be relabelled: its switches are never stored', () => {
    const name = meta('name');
    expect(fieldState({}, name)).toEqual({ label: BI('', ''), visible: true, required: true });
    expect(withField({}, name, { label: BI('', ''), visible: false, required: false })).toEqual({});
  });

  it('an order is stored only when it differs, and moves stop at the ends', () => {
    const order = orderOf({}, INQUIRY_FIELDS);
    expect(moved(order, 'name', -1)).toEqual(order);
    const swapped = moved(order, 'name', 1);
    expect(swapped.slice(0, 2)).toEqual(['email', 'name']);
    const config = withOrder({}, swapped, INQUIRY_FIELDS);
    expect(InquiryConfigSchema.safeParse(config).success).toBe(true);
    expect(orderOf(config, INQUIRY_FIELDS)).toEqual(swapped);
    expect(withOrder(config, [...INQUIRY_FIELDS], INQUIRY_FIELDS)).toEqual({});
    // A stored order that is not a whole permutation reads as built.
    expect(orderOf({ order: ['name'] }, INQUIRY_FIELDS)).toEqual([...INQUIRY_FIELDS]);
  });

  it("the Join form's order is per group", () => {
    const work = join.fields.filter((f) => f.group === 'work').map((f) => f.key);
    const config = withOrder({}, moved(work, 'cv', -1), work, 'work');
    expect(ApplicationConfigSchema.safeParse(config).success).toBe(true);
    expect(orderOf(config, work, 'work')).toEqual(['portfolio', 'cv', 'linkedin', 'message']);
    expect(withOrder(config, work, work, 'work')).toEqual({});
  });

  it('the button, a budget and a consent line', () => {
    let config = withButton({}, BI('Go', 'اذهب'), inquiry.button);
    config = withKeyedCopy(
      config,
      'budgets',
      'lt_25k',
      BI('Small', 'صغير'),
      inquiry.budgets![0]!.label,
    );
    expect(InquiryConfigSchema.safeParse(config).success).toBe(true);
    expect(withButton(config, inquiry.button, inquiry.button)).not.toHaveProperty('button');
    const consent = withKeyedCopy(
      {},
      'consent',
      'application',
      BI('Yes', 'نعم'),
      join.consent!.application,
    );
    expect(ApplicationConfigSchema.safeParse(consent).success).toBe(true);
  });
});

describe('the stored value round-trips as the kit carries it (json text)', () => {
  it('parses what it serialises, and anything unreadable as nothing', () => {
    const config = { fields: { phone: { required: true } } };
    expect(parseStored(serialise(config))).toEqual(config);
    expect(parseStored('{oops')).toEqual({});
    expect(parseStored('[1]')).toEqual({});
    expect(parseStored(undefined)).toEqual({});
  });
});

describe('the consent version the screen promises', () => {
  const lines = { application: BI('I agree', 'أوافق') };
  it('is the notice until the lines are reworded, then .r<N>, one more for a new wording', () => {
    expect(nextConsentVersion('2026-10-04', 0, {}, {})).toBe('2026-10-04');
    expect(nextConsentVersion('2026-10-04', 0, {}, { consent: lines })).toBe('2026-10-04.r1');
    expect(nextConsentVersion('2026-10-04', 1, { consent: lines }, { consent: lines })).toBe(
      '2026-10-04.r1',
    );
  });

  it('in release mode counts against the live lines, not the staged ones (consentBase)', () => {
    // A first rewording staged: the row read holds it, the live revision is 0 and live has none.
    const staged = { consent: lines };
    expect(nextConsentVersion('2026-10-04', 0, consentBase(staged, null), staged)).toBe(
      '2026-10-04.r1',
    );
    // Against the staged config alone it would say the notice: the bug this guards.
    expect(nextConsentVersion('2026-10-04', 0, staged, staged)).toBe('2026-10-04');
    // Staging the live lines back: nothing changes on publish.
    expect(nextConsentVersion('2026-10-04', 2, consentBase(staged, lines), staged)).toBe(
      '2026-10-04.r2',
    );
    // Live mode (no live_consent on the row): the saved config is live.
    expect(consentBase(staged, undefined)).toBe(staged);
  });

  it('compares the wording by value, as jsonb does, not by key order', () => {
    const stored = { consent: { application: { ar: 'أوافق', en: 'I agree' } } };
    expect(nextConsentVersion('2026-10-04', 2, stored, { consent: lines })).toBe('2026-10-04.r2');
  });

  it('counts with the one rule the preview uses (CR5): revision.ts, no copy of it here', () => {
    const source = readFileSync('src/lib/admin/forms/editor.ts', 'utf8');
    expect(source).toContain("from '@/lib/forms/revision'");
    expect(source).not.toMatch(/export function canonical/);
    const other = { application: BI('Yes', 'نعم') };
    for (const [revision, saved, next] of [
      [0, {}, { consent: lines }],
      [2, { consent: lines }, { consent: lines }],
      [2, { consent: lines }, { consent: other }],
      [5, { consent: { application: { ar: 'أوافق', en: 'I agree' } } }, { consent: lines }],
    ] as const) {
      const projected = projectedConsentRevision(
        { consent_revision: revision, application: saved },
        { application: next },
      );
      expect(nextConsentVersion('2026-10-04', revision, saved, next)).toBe(
        `2026-10-04.r${projected}`,
      );
    }
  });
});

describe('a consent line stays one paragraph (CR4)', () => {
  it('a typed or pasted line break, or any other control character, becomes a space', () => {
    expect(oneLine('I agree\nto this')).toBe('I agree to this');
    expect(oneLine('one\r\ntwo\r\n\nthree\tfour')).toBe('one two three four');
    expect(oneLine('أوافق\nعلى هذا')).toBe('أوافق على هذا');
    expect(oneLine('plain words')).toBe('plain words');
  });

  it('removes every character the schema refuses for being a control (FORM_COPY_FORBIDDEN)', () => {
    for (let code = 0; code <= 0x9f; code += 1) {
      const ch = String.fromCharCode(code);
      if (ch === '<' || ch === '>' || !FORM_COPY_FORBIDDEN.test(ch)) continue;
      expect(FORM_COPY_FORBIDDEN.test(oneLine(`a${ch}b`)), `U+${code.toString(16)}`).toBe(false);
    }
  });
});

describe('the pages whose own button text wins (CR3)', () => {
  const pages = [
    { id: 'p1', slug: 'contact', title: { en: 'Contact', ar: 'تواصل' } },
    { id: 'p2', slug: 'campaign', title: null },
  ];
  it('names each page with a shown inquiry band that sets its button, in either language', () => {
    expect(
      pageButtonsFrom(
        [
          { page_id: 'p1', visible: true, submit: { en: 'Send it', ar: 'أرسلها' } },
          { page_id: 'p2', visible: true, submit: { en: '', ar: 'أرسل' } },
        ],
        pages,
      ),
    ).toEqual([
      { page: 'Contact', en: 'Send it', ar: 'أرسلها' },
      { page: 'campaign', en: '', ar: 'أرسل' },
    ]);
  });
  it('none for a band without its own text, a blank one, or a hidden band', () => {
    expect(
      pageButtonsFrom(
        [
          { page_id: 'p1', visible: true, submit: null },
          { page_id: 'p2', visible: false, submit: { en: 'Go', ar: 'انطلق' } },
          { page_id: 'p2', visible: true, submit: { en: ' ', ar: '' } },
        ],
        pages,
      ),
    ).toEqual([]);
  });
});
