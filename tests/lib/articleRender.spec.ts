import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { renderTiptapToHtml, tiptapToPlainText } from '@/lib/content/tiptap';
import { SEED_SERVICES } from '../fixtures/serviceSeeds';
import {
  ARTICLE_CASES,
  INVALID_CASES,
  LONG_ARTICLE,
  randomCorpus,
} from '../fixtures/articleCorpus';

// An article body renders to the same bytes before and after H15 (blog posts, services,
// projects). The snapshots below were written by the renderer as it stood BEFORE H15 (zod's
// recursive parse, then the allowlist walk on its output) and committed before any change to
// it: every body here, the seeds', a long real article, every node and mark the renderer has
// ever taken and a seeded random corpus, must still render exactly that. A hash stands in for a
// long render; the short ones are written out.

const sha = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);
const fingerprint = (html: string) => `${html.length}:${sha(html)}`;

describe('an article body renders as it did before H15 (byte for byte)', () => {
  it('every kind of node and mark', () => {
    const out = Object.fromEntries(
      Object.entries(ARTICLE_CASES).map(([name, body]) => [name, renderTiptapToHtml(body)]),
    );
    expect(out).toMatchSnapshot();
  });

  it('bodies it refuses render nothing', () => {
    for (const [name, body] of Object.entries(INVALID_CASES)) {
      expect(renderTiptapToHtml(body), name).toBe('');
    }
  });

  it("the seeds' service bodies, both languages", () => {
    const out = Object.fromEntries(
      SEED_SERVICES.flatMap((s) => [
        [`${s.slug}.en`, fingerprint(renderTiptapToHtml(s.body?.en))],
        [`${s.slug}.ar`, fingerprint(renderTiptapToHtml(s.body?.ar))],
      ]),
    );
    expect(out).toMatchSnapshot();
  });

  it('a long real article', () => {
    expect(fingerprint(renderTiptapToHtml(LONG_ARTICLE))).toMatchSnapshot();
    expect(fingerprint(tiptapToPlainText(LONG_ARTICLE))).toMatchSnapshot();
  });

  it('a seeded random corpus of 400 documents', () => {
    const corpus = randomCorpus(400);
    const rendered = corpus.map((body) => renderTiptapToHtml(body));
    // The corpus holds both: bodies that render and bodies refused whole.
    expect(rendered.filter((html) => html === '').length).toBeGreaterThan(20);
    expect(rendered.filter((html) => html !== '').length).toBeGreaterThan(200);
    expect(rendered.map(fingerprint)).toMatchSnapshot();
    expect(corpus.map((body) => fingerprint(tiptapToPlainText(body)))).toMatchSnapshot();
  });

  it('plain text and reading time over every case', () => {
    const out = Object.fromEntries(
      Object.entries({ ...ARTICLE_CASES, ...INVALID_CASES }).map(([name, body]) => [
        name,
        tiptapToPlainText(body),
      ]),
    );
    expect(out).toMatchSnapshot();
  });
});
