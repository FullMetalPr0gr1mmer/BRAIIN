import { describe, it, expect } from 'vitest';
import {
  renderTiptapToHtml,
  sanitizeHref,
  tiptapToPlainText,
  readingMinutes,
} from '@/lib/content/tiptap';

// Sanitiser regression suite. CLAUDE.md Pillar 1: "Tiptap sanitised on write AND render;
// never `set:html` unsanitised."
//
// These are the tests whose failure means stored content can execute in a visitor's
// browser, so they are written as attacks rather than as feature checks.

const doc = (content: unknown[]) => ({ type: 'doc', content });
const text = (value: string, marks?: unknown[]) => ({ type: 'text', text: value, marks });
const para = (content: unknown[]) => ({ type: 'paragraph', content });

describe('renderTiptapToHtml — escaping', () => {
  it('escapes markup in text nodes', () => {
    const html = renderTiptapToHtml(doc([para([text('<script>alert(1)</script>')])]));
    expect(html).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
    expect(html).not.toContain('<script');
  });

  it('escapes quotes and ampersands so attribute context cannot be broken', () => {
    const html = renderTiptapToHtml(doc([para([text(`" onload="alert(1)" &`)])]));
    expect(html).toContain('&quot;');
    expect(html).toContain('&amp;');
    expect(html).not.toContain('onload="');
  });
});

describe('renderTiptapToHtml — node allowlist', () => {
  it('drops an unknown node wrapper but keeps its text', () => {
    // An unknown type must not be "cleaned" into markup — it renders nothing itself.
    const html = renderTiptapToHtml(
      doc([{ type: 'iframeEmbed', attrs: { src: 'https://evil.test' }, content: [text('hi')] }]),
    );
    expect(html).toBe('hi');
    expect(html).not.toContain('iframe');
    expect(html).not.toContain('evil.test');
  });

  it('never emits a style attribute, even when one is authored', () => {
    const html = renderTiptapToHtml(
      doc([
        { type: 'paragraph', attrs: { style: 'position:fixed;inset:0' }, content: [text('x')] },
      ]),
    );
    expect(html).toBe('<p>x</p>');
    expect(html).not.toContain('style');
  });

  it('never emits a class from content', () => {
    const html = renderTiptapToHtml(
      doc([{ type: 'paragraph', attrs: { class: 'admin-nav' }, content: [text('x')] }]),
    );
    expect(html).not.toContain('class=');
  });

  it('clamps headings to h2–h6 so a body cannot emit a second h1', () => {
    expect(
      renderTiptapToHtml(doc([{ type: 'heading', attrs: { level: 1 }, content: [text('T')] }])),
    ).toBe('<h2>T</h2>');
    expect(
      renderTiptapToHtml(doc([{ type: 'heading', attrs: { level: 9 }, content: [text('T')] }])),
    ).toBe('<h2>T</h2>');
    expect(
      renderTiptapToHtml(doc([{ type: 'heading', attrs: { level: 3 }, content: [text('T')] }])),
    ).toBe('<h3>T</h3>');
  });

  it('re-derives the code-block language from an allowlist pattern', () => {
    const bad = renderTiptapToHtml(
      doc([{ type: 'codeBlock', attrs: { language: 'js" onmouseover="x' }, content: [text('a')] }]),
    );
    expect(bad).toBe('<pre><code>a</code></pre>');

    const good = renderTiptapToHtml(
      doc([{ type: 'codeBlock', attrs: { language: 'TypeScript' }, content: [text('a')] }]),
    );
    expect(good).toContain('class="language-typescript"');
  });
});

describe('sanitizeHref — scheme allowlist', () => {
  const rejected = [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    '  javascript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    'vbscript:msgbox(1)',
    'blob:https://example.test/abc',
    'file:///etc/passwd',
    // Protocol-relative: looks relative, is absolute and cross-origin.
    '//evil.example/path',
  ];
  for (const href of rejected) {
    it(`rejects ${JSON.stringify(href)}`, () => {
      expect(sanitizeHref(href)).toBeNull();
    });
  }

  const accepted = [
    'https://example.test/a',
    'http://example.test',
    'mailto:a@b.test',
    'tel:+966500000000',
    '/services',
    '#anchor',
    '?q=1',
  ];
  for (const href of accepted) {
    it(`accepts ${JSON.stringify(href)}`, () => {
      expect(sanitizeHref(href)).toBe(href.trim());
    });
  }

  it('rejects non-strings and absurd lengths', () => {
    expect(sanitizeHref(null)).toBeNull();
    expect(sanitizeHref(42)).toBeNull();
    expect(sanitizeHref(`https://a.test/${'x'.repeat(3000)}`)).toBeNull();
  });
});

describe('renderTiptapToHtml — link marks', () => {
  it('drops a javascript: link but keeps the words', () => {
    const html = renderTiptapToHtml(
      doc([para([text('click', [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }])])]),
    );
    expect(html).toBe('<p>click</p>');
    expect(html).not.toContain('javascript');
  });

  it('emits a fixed rel and never an authored target', () => {
    const html = renderTiptapToHtml(
      doc([
        para([
          text('go', [
            { type: 'link', attrs: { href: 'https://x.test', target: '_blank', rel: 'dofollow' } },
          ]),
        ]),
      ]),
    );
    expect(html).toContain('rel="noopener noreferrer ugc"');
    expect(html).not.toContain('target=');
    expect(html).not.toContain('dofollow');
  });

  it('ignores unknown mark types without losing the text', () => {
    const html = renderTiptapToHtml(doc([para([text('hi', [{ type: 'evilMark' }])])]));
    expect(html).toBe('<p>hi</p>');
  });
});

describe('renderTiptapToHtml — images', () => {
  it('drops an image whose src fails the scheme check', () => {
    const html = renderTiptapToHtml(
      doc([{ type: 'image', attrs: { src: 'data:image/svg+xml,<svg onload=alert(1)>' } }]),
    );
    expect(html).toBe('');
  });

  it('emits width/height when known — CLS budget is zero', () => {
    const html = renderTiptapToHtml(
      doc([{ type: 'image', attrs: { src: '/a.png', alt: 'A', width: 800, height: 600 } }]),
    );
    expect(html).toContain('width="800"');
    expect(html).toContain('height="600"');
    expect(html).toContain('loading="lazy"');
  });

  it('escapes alt text', () => {
    const html = renderTiptapToHtml(
      doc([{ type: 'image', attrs: { src: '/a.png', alt: '" onerror="alert(1)' } }]),
    );
    expect(html).not.toContain('onerror="alert');
    expect(html).toContain('&quot;');
  });
});

describe('renderTiptapToHtml — malformed input', () => {
  it('returns empty string rather than throwing', () => {
    expect(renderTiptapToHtml(null)).toBe('');
    expect(renderTiptapToHtml('not a doc')).toBe('');
    expect(renderTiptapToHtml({ type: 'paragraph' })).toBe('');
    expect(renderTiptapToHtml({ type: 'doc' })).toBe('');
  });
});

describe('derived text helpers', () => {
  it('extracts plain text across nesting', () => {
    const value = tiptapToPlainText(
      doc([
        para([text('Hello')]),
        { type: 'bulletList', content: [{ type: 'listItem', content: [para([text('world')])] }] },
      ]),
    );
    expect(value).toBe('Hello world');
  });

  it('computes reading time with a floor of one minute', () => {
    expect(readingMinutes(doc([para([text('one two three')])]))).toBe(1);
    const long = doc([para([text('word '.repeat(600))])]);
    expect(readingMinutes(long)).toBe(3);
  });
});
