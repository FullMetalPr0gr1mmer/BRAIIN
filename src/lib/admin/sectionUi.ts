import type { SectionType } from '@schemas/sectionTypes';
import type { FieldDef } from './uiSchema';

// The typed editor for `page_sections.content` — one field list per section type,
// mirroring packages/schemas/sections.ts (SECTION_CONTENT_SCHEMAS). Zod-free: this ships
// in the admin client bundle; the server validates every save against the real schema.
//
// Every content key is an OPTIONAL override of the section's built-in copy, so the
// editor never sends an empty value: a bilingual pair left blank, an empty list or an
// unset number is simply omitted (formPayload.ts), and the section keeps its default.
// tests/lib/sectionUi.spec.ts holds this list and the schemas together — a field here the
// schema does not know, or a schema key with no editor and no reason, fails CI.
//
// Keys deliberately left to "Advanced (JSON)":
//   hero.intro — the logo plate is a ROUTE decision (withHomeIntro); an unticked box
//   would read as `intro: false` and silently switch it off on home.

const tag: FieldDef = {
  name: 'tag',
  label: 'Tag (small label above the heading)',
  kind: 'bilingual',
};
const heading: FieldDef = { name: 'heading', label: 'Heading', kind: 'bilingual' };
const accentHelp = 'Word number (0 = first) where the accent colour starts.';

export const SECTION_UI: Partial<Record<SectionType, readonly FieldDef[]>> = {
  hero: [
    {
      name: 'headline',
      label: 'Headline',
      kind: 'bilingual',
      help: 'At most 10 words of 14 characters each — the entrance animation has that many steps.',
    },
    { name: 'accentFromEn', label: 'Accent from word (English)', kind: 'number', help: accentHelp },
    { name: 'accentFromAr', label: 'Accent from word (Arabic)', kind: 'number', help: accentHelp },
    { name: 'sub', label: 'Sub-line', kind: 'bilingual' },
    { name: 'ctaLabel', label: 'Button label', kind: 'bilingual' },
    {
      name: 'videoUid',
      label: 'Loop video (Cloudflare Stream UID)',
      kind: 'text',
      help: 'Leave empty to keep the site loop.',
    },
  ],
  aboutIntro: [
    tag,
    heading,
    { name: 'lead', label: 'Lead', kind: 'bilingual' },
    {
      name: 'columns',
      label: 'Columns',
      kind: 'repeater',
      maxItems: 6,
      itemFields: [
        { name: 'title', label: 'Title', kind: 'bilingual', required: true },
        { name: 'body', label: 'Body', kind: 'bilingual', required: true },
      ],
    },
  ],
  slogan: [
    { name: 'text', label: 'Slogan', kind: 'bilingual' },
    { name: 'accentFromEn', label: 'Accent from word (English)', kind: 'number', help: accentHelp },
    { name: 'accentFromAr', label: 'Accent from word (Arabic)', kind: 'number', help: accentHelp },
  ],
  clientsMarquee: [tag, heading, { name: 'note', label: 'Note', kind: 'bilingual' }],
  servicesOverview: [tag, heading, { name: 'sub', label: 'Sub-line', kind: 'bilingual' }],
  contact: [heading, { name: 'accent', label: 'Accent (highlighted words)', kind: 'bilingual' }],
  social: [
    tag,
    heading,
    {
      name: 'links',
      label: 'Links (replace the Public identity socials on this section only)',
      kind: 'repeater',
      maxItems: 8,
      itemFields: [
        { name: 'label', label: 'Network name', kind: 'text', required: true },
        { name: 'user', label: 'Handle', kind: 'text', required: true },
        { name: 'href', label: 'Link (https)', kind: 'url', required: true },
      ],
    },
  ],
  cta: [
    tag,
    heading,
    { name: 'text', label: 'Text', kind: 'bilingual' },
    { name: 'buttonLabel', label: 'Button label', kind: 'bilingual' },
    {
      name: 'buttonHref',
      label: 'Button link',
      kind: 'text',
      help: 'A page of this site (/contact#inquiry) or an #anchor. Default: the contact form.',
    },
  ],
  statistics: [
    {
      name: 'variant',
      label: 'Layout',
      kind: 'select',
      options: [
        { value: 'cards', label: 'Cards (the original grid)' },
        { value: 'band', label: 'Band (home, on black)' },
        { value: 'reach', label: 'Reach (about, on white)' },
        { value: 'proof', label: 'Proof (Our Work, on white)' },
      ],
    },
    {
      name: 'placement',
      label: 'Page (which counters, which labels)',
      kind: 'select',
      options: [
        { value: 'home', label: 'Home' },
        { value: 'about', label: 'About' },
        { value: 'work', label: 'Our Work' },
      ],
      help: 'Shows the statistics marked for this page, each with its label for this page.',
    },
    { ...tag, label: 'Tag (small label above the heading; Band, Reach and Proof only)' },
    heading,
    { name: 'text', label: 'Text beside the heading (Band and Reach only)', kind: 'bilingual' },
    {
      name: 'staticNumbers',
      label: 'Show the numbers without counting up (Band, Reach and Proof only)',
      kind: 'checkbox',
    },
    {
      name: 'minItems',
      label: 'Hide when fewer counters than',
      kind: 'number',
      help: 'Default 2 for Band, Reach and Proof (a band with a single number reads as broken), 1 for Cards.',
    },
  ],
  aboutStory: [
    heading,
    { name: 'lead', label: 'Lead', kind: 'bilingual' },
    { name: 'missionTitle', label: 'Mission title', kind: 'bilingual' },
    { name: 'mission', label: 'Mission', kind: 'bilingual' },
    { name: 'visionTitle', label: 'Vision title', kind: 'bilingual' },
    { name: 'vision', label: 'Vision', kind: 'bilingual' },
  ],
  // UI v2 PR10 — Our Work and All projects (projectCatalog is table-backed: no editor)
  workHero: [
    { ...tag, label: 'Caption tag ("Latest project")' },
    {
      name: 'projectSlug',
      label: 'Pinned project (slug)',
      kind: 'text',
      help: 'Leave empty to show the latest project (newest year, then catalogue order).',
    },
  ],
  proof: [
    { name: 'statsTag', label: 'Numbers tag ("In numbers")', kind: 'bilingual' },
    { name: 'quotesTag', label: 'Testimonials tag', kind: 'bilingual' },
    { name: 'quotesHeading', label: 'Testimonials heading', kind: 'bilingual' },
    {
      name: 'quotesLimit',
      label: 'Most quotes shown',
      kind: 'number',
      help: 'Up to 8. Shows the published testimonials marked for Our Work.',
    },
    {
      name: 'staticNumbers',
      label: 'Show the numbers without counting up',
      kind: 'checkbox',
    },
    {
      name: 'minItems',
      label: 'Hide the numbers when fewer counters than',
      kind: 'number',
      help: 'Default 2. Shows the statistics marked for Our Work.',
    },
  ],
  workIntro: [
    { name: 'text', label: 'Statement', kind: 'bilingual' },
    { name: 'linkLabel', label: 'Link label ("See the projects")', kind: 'bilingual' },
    {
      name: 'media',
      label: 'Frames (the first is the tall one)',
      kind: 'repeater',
      maxItems: 2,
      itemFields: [
        { name: 'mediaId', label: 'Image', kind: 'media', required: true },
        { name: 'clip', label: 'Loop (optional)', kind: 'clip' },
      ],
    },
  ],
  projectGrid: [
    { ...tag, label: 'Tag ("Featured work")' },
    { ...heading, label: 'Heading ("Projects")' },
  ],
  pageHead: [
    heading,
    { name: 'lead', label: 'Lead', kind: 'bilingual' },
    { name: 'backLabel', label: 'Back link label', kind: 'bilingual' },
    {
      name: 'backHref',
      label: 'Back link',
      kind: 'text',
      help: 'A page of this site, e.g. /portfolio. Default: Our Work.',
    },
  ],
};

/** Content keys an editor must set through "Advanced (JSON)" — see the header. */
export const SECTION_ADVANCED_ONLY: Partial<Record<SectionType, readonly string[]>> = {
  hero: ['intro'],
  // A per-locale word range ({en: {from, to}, ar: {…}}) — no typed field kind for it yet.
  statistics: ['accent'],
  cta: ['accent'],
  proof: ['quotesAccent'],
  pageHead: ['accent'],
};

/** The fields for one section type, or null when it takes no content (table-backed). */
export function sectionFields(type: unknown): readonly FieldDef[] | null {
  return typeof type === 'string' && type in SECTION_UI
    ? (SECTION_UI[type as SectionType] ?? null)
    : null;
}
