import { z } from 'zod';

// The help centre (Admin v2 U16): short guides for the admin, stored in `help_articles`
// (migration 0046) as typed blocks, never HTML. The same rules hold in three places: the
// table's CHECK constraints (app.help_body_ok, app.help_text_ok, app.help_keys_ok), this
// schema (what the Worker accepts when it reads a row), and the article set the migrations
// seed (tests/lib/helpCentre.spec.ts reads it as the last restatement of
// app.help_article_set() before H11's catalog, 0069, plus every app.put_help_guide and
// app.drop_help_guide since, and holds every article to HelpArticleSeedSchema).
//
// A block is one of four kinds, the client's prototype set (its GUIDES in screens_setup.js):
//   p    a paragraph            { t: 'p',   x: text }
//   h    a heading              { t: 'h',   x: text }
//   ol   a numbered list        { t: 'ol',  x: [text, …] }
//   tip  a highlighted tip      { t: 'tip', x: text }
// Text is plain: it is rendered as React and Astro text nodes, which escape everything, and
// it may not hold `<` or `>` at all, so no markup is ever stored, whatever renders it next.

export const HELP_LIMITS = {
  /** A title or a heading, in characters. */
  title: 120,
  /** A paragraph or a tip. */
  text: 1200,
  /** One item of a numbered list. */
  item: 600,
  /** Blocks in one language of one article. */
  blocks: 40,
  /** Items in one numbered list. */
  items: 12,
  tags: 6,
  screens: 16,
  caps: 12,
  minutes: 30,
  slug: 64,
  /** A search, as the public search caps it (CLAUDE.md §3, the search endpoint). */
  query: 64,
} as const;

/** A slug: lower-case words joined by single hyphens. */
export const HELP_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** A tag key, shown as a badge and used to find related guides. */
export const HELP_TAG = /^[a-z][a-z0-9-]{0,23}$/;
/** An admin screen an article belongs to: `/admin` or a path below it, lower case. */
export const HELP_SCREEN = /^\/admin(?:\/[a-z0-9-]+)*$/;
/** A capability's name as ROLE_CAPS spells it (`leads.manage`, `siteHealth.view`). */
export const HELP_CAP = /^[a-z][a-zA-Z]*\.[a-z][a-zA-Z]*$/;

/** The characters no help text may hold: markup and C0/C1 control characters. */
export const HELP_FORBIDDEN = /[<>\u0000-\u001f\u007f-\u009f]/;

const plain = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => /\S/.test(s), 'empty')
    .refine((s) => !HELP_FORBIDDEN.test(s), 'no markup or control characters');

const unique = (list: readonly string[]) => new Set(list).size === list.length;

export const HelpBlockSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('p'), x: plain(HELP_LIMITS.text) }).strict(),
  z.object({ t: z.literal('h'), x: plain(HELP_LIMITS.title) }).strict(),
  z
    .object({
      t: z.literal('ol'),
      x: z.array(plain(HELP_LIMITS.item)).min(1).max(HELP_LIMITS.items),
    })
    .strict(),
  z.object({ t: z.literal('tip'), x: plain(HELP_LIMITS.text) }).strict(),
]);
export type HelpBlock = z.infer<typeof HelpBlockSchema>;

const HelpBlocksSchema = z.array(HelpBlockSchema).min(1).max(HELP_LIMITS.blocks);

/** An article's body: locale-keyed (CLAUDE.md §8, an array → one JSONB keyed by locale). */
export const HelpBodySchema = z.object({ en: HelpBlocksSchema, ar: HelpBlocksSchema }).strict();
export type HelpBody = z.infer<typeof HelpBodySchema>;

/** What a list needs: everything but the body. Read leniently (a row's `id` is dropped). */
export const HelpEntrySchema = z.object({
  slug: z.string().max(HELP_LIMITS.slug).regex(HELP_SLUG),
  title: plain(HELP_LIMITS.title),
  title_ar: plain(HELP_LIMITS.title),
  minutes: z.number().int().min(1).max(HELP_LIMITS.minutes),
  tags: z.array(z.string().regex(HELP_TAG)).max(HELP_LIMITS.tags).refine(unique, 'repeated'),
  screens: z
    .array(z.string().max(120).regex(HELP_SCREEN))
    .min(1)
    .max(HELP_LIMITS.screens)
    .refine(unique, 'repeated'),
  caps: z
    .array(z.string().max(64).regex(HELP_CAP))
    .max(HELP_LIMITS.caps)
    .refine(unique, 'repeated'),
  sort_order: z.number().int(),
});
export type HelpEntryRow = z.infer<typeof HelpEntrySchema>;

/** A whole article as a row holds it. */
export const HelpArticleSchema = HelpEntrySchema.extend({ body: HelpBodySchema });
export type HelpArticleRow = z.infer<typeof HelpArticleSchema>;

/** An article of the set a migration seeds: strict, so a misspelt key fails the test. */
export const HelpArticleSeedSchema = HelpArticleSchema.strict();

/** GET /api/admin/help: the guides, and the screen the drawer was opened on. */
export const HelpIndexQuerySchema = z.object({ screen: z.string().max(200).optional() });

/** GET /api/admin/help/search. Longer input is cut, as the header search does. */
export const HelpSearchQuerySchema = z.object({
  q: z
    .string()
    .max(HELP_LIMITS.query * 2)
    .default(''),
});

/** GET /api/admin/help/article. */
export const HelpArticleQuerySchema = z.object({
  slug: z.string().max(HELP_LIMITS.slug).regex(HELP_SLUG),
});
