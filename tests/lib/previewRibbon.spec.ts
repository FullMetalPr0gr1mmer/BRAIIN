import { describe, expect, it } from 'vitest';
import { PASS } from '@/lib/http/visibility';
import { PREVIEW_COPY } from '@/lib/preview/report';
import {
  escapeHtml,
  injectRibbon,
  PREVIEW_STYLESHEET,
  renderRibbon,
  ribbonLines,
  VISIBILITY_COPY,
} from '@/lib/preview/ribbon';
import { markPreviewSection } from '@/lib/sections/previewMarker';

// The preview's ribbon and section marker (Admin v2 R9): the verdict's words (P-12), what
// visitors get for the page, escaped markup spliced after <body>, and the marker on a
// section's own first element.

const ok = (over: Record<string, unknown> = {}) => ({
  state: 'ok' as const,
  pending: 0,
  invalid: [],
  notPreviewed: [],
  samples: 0,
  ...over,
});

describe('the ribbon’s lines', () => {
  it('counts the pending changes', () => {
    expect(ribbonLines({ verdict: ok(), gate: PASS }).lead).toBe(PREVIEW_COPY.ok.none);
    expect(ribbonLines({ verdict: ok({ pending: 1 }), gate: PASS }).lead).toBe(PREVIEW_COPY.ok.one);
    expect(ribbonLines({ verdict: ok({ pending: 7 }), gate: PASS }).lead).toBe(
      'Preview. Not live yet. 7 unpublished changes.',
    );
  });

  it('lists what could not be shown, design samples going live, and what is not previewed, once each', () => {
    const { notes } = ribbonLines({
      verdict: ok({
        pending: 3,
        invalid: [{ draftId: 'd', entityType: 'service', entityId: 'e', reason: 'invalid' }],
        samples: 2,
        notPreviewed: ['rpc:search_content', 'rpc:search_suggest', 'redirect'],
      }),
      gate: { action: 'noindex' },
    });
    expect(notes).toEqual([
      PREVIEW_COPY.invalid.one,
      PREVIEW_COPY.samples.other.replace('{n}', '2'),
      PREVIEW_COPY.notPreviewed.search,
      PREVIEW_COPY.notPreviewed.redirect,
      VISIBILITY_COPY.noindex,
    ]);
  });

  it('an untrusted render leads with the warning and every reason', () => {
    const { lead, notes } = ribbonLines({
      verdict: { state: 'untrusted', reasons: ['anon-lookup', 'truncated'] },
      gate: { action: 'hide', to: null },
    });
    expect(lead).toBe(PREVIEW_COPY.untrusted);
    expect(notes).toEqual([
      PREVIEW_COPY.reasons['anon-lookup'],
      PREVIEW_COPY.reasons.truncated,
      VISIBILITY_COPY.hide,
    ]);
  });

  it('keeps the copy rules: no em or en dash', () => {
    const all = [
      ...Object.values(VISIBILITY_COPY),
      PREVIEW_COPY.locked,
      ...Object.values(PREVIEW_COPY.samples),
    ];
    for (const text of all) expect(text).not.toMatch(/[–—]/);
  });
});

describe('the ribbon’s markup', () => {
  const ribbon = renderRibbon({
    verdict: { state: 'untrusted', reasons: ['no-reads'] },
    gate: PASS,
    self: '/admin/preview/about?x="><script>',
    twin: '/ar/about',
    twinLocale: 'ar',
  });

  it('is an English, left-to-right landmark with the twin and a reload link, all escaped', () => {
    expect(ribbon).toMatch(/^<aside class="pv-ribbon" data-pv-ribbon data-state="untrusted"/);
    expect(ribbon).toContain('aria-label="Preview status" lang="en" dir="ltr"');
    expect(ribbon).toContain('<a href="/admin/preview/ar/about" lang="ar" dir="rtl">العربية</a>');
    expect(ribbon).toContain('href="/admin/preview/about?x=&quot;&gt;&lt;script&gt;"');
    expect(ribbon).not.toContain('<script');
    expect(ribbon).not.toMatch(/style=/);
  });

  it('escapes the five characters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    );
  });

  it('is spliced after <body …> and the sheet before </head>, once', () => {
    const html = '<html><head><title>t</title></head><body class="x"><main>m</main></body></html>';
    expect(injectRibbon(html, '<aside>R</aside>')).toBe(
      `<html><head><title>t</title>${PREVIEW_STYLESHEET}</head><body class="x"><aside>R</aside><main>m</main></body></html>`,
    );
    expect(injectRibbon('<p>bare</p>', '<aside>R</aside>')).toBe(
      `<aside>R</aside>${PREVIEW_STYLESHEET}<p>bare</p>`,
    );
  });
});

describe('the section marker', () => {
  it('goes on the first element of the section, never a script or style', () => {
    expect(markPreviewSection('<style>x</style>\n<section class="a">', 'default-1')).toBe(
      '<style>x</style>\n<section data-pv-section="default-1" class="a">',
    );
    expect(markPreviewSection('<script>1</script><div>', 'abc')).toBe(
      '<script>1</script><div data-pv-section="abc">',
    );
  });

  it('leaves the markup alone for an id that is not a plain token, or no element', () => {
    expect(markPreviewSection('<section>', '"><x')).toBe('<section>');
    expect(markPreviewSection('text only', 'abc')).toBe('text only');
  });
});
