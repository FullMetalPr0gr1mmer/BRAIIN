import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { ServiceWriteSchema, StatisticWriteSchema } from '@schemas/admin';
import { LocalizedProseSchema, LocalizedTextSchema } from '@schemas/content';
import { SECTION_CONTENT_SCHEMAS } from '@schemas/sections';
import { LocalizedDocSchema, TiptapDocSchema } from '@schemas/tiptap';
import { formToPayload, rowToForm } from '@/lib/admin/formPayload';
import { serviceResource } from '@/lib/admin/resources/services';
import { statisticResource } from '@/lib/admin/resources/statistics';
import type { FieldDef } from '@/lib/admin/uiSchema';
import { renderTiptapToHtml, tiptapToPlainText } from '@/lib/content/tiptap';
import { splitAccent } from '@/lib/text/accent';
import { nodesOf, scanTree } from './sourceScan';

// Arabic content digits are never transformed (P-12; verification.md "Details the designs
// missed"; Admin v2 F5a). Eastern Arabic digits (U+0660-0669) and their Persian/Urdu forms
// (U+06F0-06F9) typed into an Arabic field must reach the page exactly as typed: through
// the write schemas, the form's payload shaping, the resources' row mapping, the rich-text
// gate and sanitiser, and the accent tokeniser. A "helpful" normalisation anywhere (NFKC,
// a digit map) would silently rewrite an author's figures, so a source scan refuses one.
// The render side is tests/render/arabicDigits.spec.ts; the round trip through a real
// editor and database is tests/admin/fields.e2e.ts.

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩'; // U+0660-0669
const EXTENDED = '۰۱۲۳۴۵۶۷۸۹'; // U+06F0-06F9
const AR = `سنة ${ARABIC_INDIC} و ${EXTENDED} فقط`;
const EN = 'Year 0123456789';
const pair = { en: EN, ar: AR };

const codePoints = (s: string) => [...s].map((c) => c.codePointAt(0)!.toString(16));

describe('the code points under test', () => {
  it('are the two Arabic digit ranges, whole', () => {
    expect(codePoints(ARABIC_INDIC)).toEqual(
      Array.from({ length: 10 }, (_, i) => (0x660 + i).toString(16)),
    );
    expect(codePoints(EXTENDED)).toEqual(
      Array.from({ length: 10 }, (_, i) => (0x6f0 + i).toString(16)),
    );
  });
});

describe('the write schemas parse Arabic digits as identity', () => {
  it('LocalizedTextSchema and LocalizedProseSchema', () => {
    expect(LocalizedTextSchema.parse(pair)).toEqual(pair);
    expect(LocalizedProseSchema.parse(pair)).toEqual(pair);
  });

  it('a section content schema (statistics: heading, line, rating)', () => {
    const content = {
      heading: pair,
      line: pair,
      rating: { value: `${ARABIC_INDIC.slice(0, 1)}٫${ARABIC_INDIC.slice(9)} / ٥`, label: pair },
    };
    expect(SECTION_CONTENT_SCHEMAS.statistics!.parse(content)).toEqual(content);
  });

  it('the services and statistics create schemas', () => {
    const service = ServiceWriteSchema.parse({
      slug: 'logo',
      title: pair,
      blurb: pair,
      intro: pair,
      valuePoints: [{ title: pair, text: pair }],
      deliverables: [pair],
    });
    expect(service.title).toEqual(pair);
    expect(service.blurb).toEqual(pair);
    expect(service.valuePoints[0]).toEqual({ title: pair, text: pair });
    expect(service.deliverables[0]).toEqual(pair);

    const statistic = StatisticWriteSchema.parse({
      slug: 'years',
      label: pair,
      value: `${ARABIC_INDIC}+`,
    });
    expect(statistic.label).toEqual(pair);
    expect(statistic.value).toBe(`${ARABIC_INDIC}+`);
  });
});

describe('the form keeps them: rowToForm → formToPayload is identity', () => {
  const FIELDS: FieldDef[] = [
    { name: 'title', label: 'Title', kind: 'bilingual', required: true },
    { name: 'blurb', label: 'Tagline', kind: 'prose' },
    {
      name: 'valuePoints',
      label: 'Value we add',
      kind: 'repeater',
      itemFields: [
        { name: 'title', label: 'Title', kind: 'bilingual', required: true },
        { name: 'text', label: 'Text', kind: 'bilingual', required: true },
      ],
    },
    { name: 'tags', label: 'Tags', kind: 'tags' },
    { name: 'keywords', label: 'Keywords', kind: 'chips', chips: { bilingual: true } },
  ];

  it('bilingual, prose, repeater items and chips', () => {
    const row = {
      title: pair,
      blurb: pair,
      value_points: [{ title: pair, text: pair }],
      tags: [ARABIC_INDIC, EXTENDED],
      keywords: { en: [EN], ar: [ARABIC_INDIC, EXTENDED, AR] },
    };
    const payload = formToPayload(rowToForm(row, FIELDS), FIELDS);
    expect(payload).toEqual({
      title: pair,
      blurb: pair,
      valuePoints: [{ title: pair, text: pair }],
      tags: [ARABIC_INDIC, EXTENDED],
      keywords: { en: [EN], ar: [ARABIC_INDIC, EXTENDED, AR] },
    });
  });

  // F5b adds the `link` kind; its label is a bilingual pair shaped like the above.
});

describe('the resources map them to columns unchanged', () => {
  it('services toRow', () => {
    const row = serviceResource.toRow({
      slug: 'logo',
      title: pair,
      blurb: pair,
      intro: pair,
      valuePoints: [{ title: pair, text: pair }],
      deliverables: [pair],
    });
    expect(row['title']).toEqual(pair);
    expect(row['blurb']).toEqual(pair);
    expect(row['intro']).toEqual(pair);
    expect(row['value_points']).toEqual([{ title: pair, text: pair }]);
    expect(row['deliverables']).toEqual([pair]);
  });

  it('statistics toRow (free text kept; a number is the code’s, not the author’s)', () => {
    const row = statisticResource.toRow({ slug: 'years', label: pair, value: `${EXTENDED}+` });
    expect(row['label']).toEqual(pair);
    expect(row['value']).toBe(`${EXTENDED}+`);
  });
});

describe('rich text: the write gate and the render sanitiser keep them', () => {
  const doc = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: AR },
          { type: 'text', text: ` ${EXTENDED}`, marks: [{ type: 'bold' }] },
        ],
      },
    ],
  };

  it('TiptapDocSchema and LocalizedDocSchema parse as identity', () => {
    expect(TiptapDocSchema.parse(doc)).toEqual(doc);
    expect(LocalizedDocSchema.parse({ en: doc, ar: doc })).toEqual({ en: doc, ar: doc });
  });

  it('renderTiptapToHtml and tiptapToPlainText keep every digit', () => {
    const html = renderTiptapToHtml(doc);
    expect(html).toBe(`<p>${AR}<strong> ${EXTENDED}</strong></p>`);
    expect(tiptapToPlainText(doc)).toBe(`${AR} ${EXTENDED}`);
  });
});

describe('the accent tokeniser counts the same words', () => {
  it('a run of Arabic digits is one word, as Western digits are', () => {
    const text = `الأرقام ${ARABIC_INDIC} و ${EXTENDED}`;
    const western = 'digits 0123456789 and 0123456789';
    const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
    expect(words(text)).toBe(words(western));
    // Accent the digits (word 1): the run comes back whole, the text unchanged.
    const runs = splitAccent(text, { from: 1, to: 2 });
    expect(runs.map((r) => r.text).join('')).toBe(text);
    expect(runs.filter((r) => r.accent).map((r) => r.text)).toEqual([ARABIC_INDIC]);
    const end = splitAccent(text, { from: 3 });
    expect(end.filter((r) => r.accent).map((r) => r.text)).toEqual([EXTENDED]);
  });
});

// ---- The source scan --------------------------------------------------------------------

/**
 * Files allowed to fold text, each with what the fold feeds. None of them changes a value
 * that is stored or shown: each derives a lookup key and keeps the original as given.
 */
const ALLOWED: Record<string, string> = {
  'src/lib/crm/normalize.ts':
    'NFKC and Arabic-to-Western digits for the phone blind index only; the value is stored as given',
  'src/lib/crm/leadQuery.ts':
    'reads a searched term as a phone number (digits of either script) for the blind-index lookup',
  'src/lib/admin/palette.ts':
    'NFKD folds the command palette’s query and labels for matching; nothing is stored or shown',
};

/** U+0660-0669, U+06F0-06F9, as characters or as \u escapes in a regex. */
const ARABIC_DIGIT = /[٠-٩۰-۹]|\\u06[6fF][0-9a-fA-F]/;

interface Finding {
  path: string;
  what: string;
}

function findings(): Finding[] {
  const out: Finding[] = [];
  for (const file of [...scanTree('src'), ...scanTree('packages')]) {
    if (!file.ast) {
      // An .astro page or a stylesheet, read as words: a call in its script is still text.
      continue;
    }
    for (const node of nodesOf(file.ast)) {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'normalize'
      ) {
        out.push({ path: file.path, what: `.normalize(): ${node.getText().slice(0, 60)}` });
      }
      if (ts.isStringLiteralLike(node) && /^NFK?[CD]$/.test(node.text)) {
        out.push({ path: file.path, what: `the form "${node.text}"` });
      }
      if (ts.isRegularExpressionLiteral(node) && ARABIC_DIGIT.test(node.text)) {
        out.push({ path: file.path, what: `a regex over Arabic digits: ${node.text}` });
      }
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'RegExp' &&
        ARABIC_DIGIT.test(node.getText())
      ) {
        out.push({ path: file.path, what: `a RegExp over Arabic digits` });
      }
    }
  }
  return out;
}

/** .astro files are read whole (sourceScan.ts): their code may not fold either. */
function astroFindings(): Finding[] {
  return [...scanTree('src')]
    .filter((file) => file.path.endsWith('.astro'))
    .filter(
      (file) => file.names.has('normalize') || file.names.has('NFKC') || file.names.has('NFKD'),
    )
    .map((file) => ({ path: file.path, what: 'normalize / NFKC / NFKD' }));
}

describe('no code path folds Arabic digits (source scan)', () => {
  it('refuses .normalize(), NFKC/NFKD and digit regexes outside the allow-list', () => {
    const found = [...findings(), ...astroFindings()];
    const outside = found.filter((f) => !(f.path in ALLOWED));
    expect(outside, JSON.stringify(outside, null, 2)).toEqual([]);
  });

  it('every allow-listed file still needs its place (a stale entry is removed)', () => {
    const found = new Set(findings().map((f) => f.path));
    for (const path of Object.keys(ALLOWED)) expect(found.has(path), path).toBe(true);
  });

  it('would catch a fold: the scanner sees each shape it refuses', async () => {
    const { scanSource } = await import('./sourceScan');
    const sample = scanSource(
      'src/x.ts',
      [
        "const a = s.normalize('NFKC');",
        'const b = s.replace(/[٠-٩]/g, (d) => d);',
        "const c = s.replace(new RegExp('[\\u0660-\\u0669]', 'g'), '');",
      ].join('\n'),
    );
    const kinds: string[] = [];
    for (const node of nodesOf(sample.ast!)) {
      if (ts.isCallExpression(node) && node.getText().includes('.normalize(')) kinds.push('call');
      if (ts.isStringLiteralLike(node) && node.text === 'NFKC') kinds.push('form');
      if (ts.isRegularExpressionLiteral(node) && ARABIC_DIGIT.test(node.text)) kinds.push('regex');
      if (ts.isNewExpression(node) && ARABIC_DIGIT.test(node.getText())) kinds.push('RegExp');
    }
    expect(kinds).toEqual(expect.arrayContaining(['call', 'form', 'regex', 'RegExp']));
  });
});
