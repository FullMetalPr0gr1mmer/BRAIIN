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
  // Round 2: the discipline cards (the disciplines themselves are under Disciplines).
  servicesOverview: [
    tag,
    heading,
    { name: 'sub', label: 'Sub-line', kind: 'bilingual' },
    {
      name: 'hint',
      label: 'Line under the cards',
      kind: 'bilingual',
      help: 'Default: "Open one to see every service inside it" (home) / "Tap a discipline to open it" (Services page).',
    },
    {
      name: 'allLabel',
      label: '"All services" button label (home only)',
      kind: 'bilingual',
    },
  ],
  contact: [heading, { name: 'accent', label: 'Accent (highlighted words)', kind: 'bilingual' }],
  social: [
    {
      name: 'variant',
      label: 'Layout',
      kind: 'select',
      options: [
        { value: 'paper', label: 'Paper (home, contact)' },
        { value: 'klein', label: 'Klein band (about)' },
      ],
    },
    tag,
    heading,
    { name: 'text', label: 'Text beside the heading (Klein band only)', kind: 'bilingual' },
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
        { value: 'services', label: 'Services proof (Services page: a statement, a rating line)' },
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
        { value: 'services', label: 'Services page' },
      ],
      help: 'Shows the statistics marked for this page, each with its label for this page.',
    },
    { ...tag, label: 'Tag (small label above the heading; Band, Reach and Proof only)' },
    heading,
    { name: 'text', label: 'Text beside the heading (Band and Reach only)', kind: 'bilingual' },
    {
      name: 'line',
      label: 'Statement beside the numbers (Services proof only)',
      kind: 'bilingual',
      help: 'Default: "Five disciplines. One team. Zero handoffs."',
    },
    {
      name: 'rating',
      label: 'Rating line under the statement (Services proof only)',
      kind: 'object',
      itemFields: [
        { name: 'value', label: 'Rating as shown ("4.8 / 5")', kind: 'text', required: true },
        { name: 'label', label: 'Label after it', kind: 'bilingual', required: true },
      ],
      help: 'Text only, never structured data; leave both blank to drop the line. The design sample (4.9 / 5) cannot go live: replace it with a real, sourced rating before unticking "Placeholder".',
    },
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
  selectedWork: [
    tag,
    heading,
    {
      name: 'lines',
      label: 'Numbered lines beside the heading',
      kind: 'repeater',
      maxItems: 3,
      itemFields: [{ name: 'text', label: 'Line', kind: 'bilingual', required: true }],
    },
    {
      name: 'featuredSlug',
      label: 'Featured project (slug)',
      kind: 'slug',
      help: 'Optional. One of the projects marked Featured; default: the first featured project by sort order.',
    },
    { name: 'featuredLinkLabel', label: 'Featured project link label', kind: 'bilingual' },
  ],
  testimonials: [
    {
      name: 'variant',
      label: 'Layout',
      kind: 'select',
      options: [
        { value: 'klein', label: 'Klein band (home)' },
        { value: 'light', label: 'Light (on white)' },
      ],
    },
    {
      name: 'placement',
      label: 'Page (which quotes)',
      kind: 'select',
      options: [
        { value: 'home', label: 'Home' },
        { value: 'work', label: 'Our Work' },
      ],
      help: 'Shows the published testimonials marked for this page. None published → the section hides.',
    },
    tag,
    heading,
    { name: 'limit', label: 'At most this many quotes (1–8)', kind: 'number' },
  ],
  // UI v2 PR9 (contact)
  contactInquiry: [
    tag,
    heading,
    { name: 'lead', label: 'Lead', kind: 'bilingual' },
    { name: 'note', label: 'Note beside the send button', kind: 'bilingual' },
    {
      name: 'successMessage',
      label: 'Confirmation after sending',
      kind: 'bilingual',
      help: 'Replaces the form once the inquiry has been received.',
    },
    { name: 'submitLabel', label: 'Send button label', kind: 'bilingual' },
  ],
  contactChannels: [
    tag,
    heading,
    { name: 'lead', label: 'Lead', kind: 'bilingual' },
    { name: 'emailLabel', label: 'Email card label', kind: 'bilingual' },
    { name: 'emailNote', label: 'Email card note', kind: 'bilingual' },
    {
      name: 'whatsappLabel',
      label: 'WhatsApp card label',
      kind: 'bilingual',
      help: 'The WhatsApp card shows only once a number is set under Settings → Public identity.',
    },
    { name: 'whatsappNote', label: 'WhatsApp card note', kind: 'bilingual' },
  ],
  faq: [tag, heading],
  // Round 2: "Say hello" — the inquiry block closing the services pages. The form itself is
  // code (its fields are the LeadInputSchema contract).
  hello: [
    tag,
    heading,
    { name: 'lead', label: 'Lead', kind: 'bilingual' },
    {
      name: 'points',
      label: 'Points beside the form',
      kind: 'repeater',
      maxItems: 3,
      itemFields: [{ name: 'text', label: 'Point', kind: 'bilingual', required: true }],
    },
  ],
  // Round 2: the /services explorer. The disciplines and their services are under
  // Disciplines and Services; only the two labels around them are content.
  serviceExplorer: [
    { name: 'inquireLabel', label: 'Pill beside each service ("Inquire")', kind: 'bilingual' },
    {
      name: 'startLabel',
      label: 'Button closing each panel',
      kind: 'bilingual',
      help: 'Write {discipline} where the name goes, in both languages. Default: "Start your {discipline} project".',
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
  aboutWho: [
    tag,
    {
      ...heading,
      label: 'Heading (the page title)',
      help: 'At most 16 words of 24 characters each — the entrance animation has that many steps.',
    },
    { name: 'lead', label: 'Lead', kind: 'bilingual' },
    {
      name: 'paragraphs',
      label: 'Paragraphs',
      kind: 'repeater',
      maxItems: 6,
      itemFields: [
        { name: 'title', label: 'Opening words (bold)', kind: 'bilingual', required: true },
        { name: 'body', label: 'Text', kind: 'bilingual', required: true },
      ],
    },
    {
      name: 'mediaId',
      label: 'Poster image',
      kind: 'media',
      help: 'The page’s largest image. Leave empty for a text-only section.',
    },
    { name: 'clip', label: 'Clip over the poster (plays while on screen)', kind: 'clip' },
  ],
  leadership: [tag, heading, { name: 'text', label: 'Text beside the heading', kind: 'bilingual' }],
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
  // Round 2: the Services proof's statement accent is the same kind of range. (Round 3
  // gave the rating line a typed `object` field; there is still no accent kind.)
  statistics: ['accent', 'lineAccent'],
  // UI v2 PR7: the accent range as above; the card picks (a list of featured-project slugs)
  // and the closing button ({label, href}) have no typed field kind yet either — both fall
  // back to the design's defaults when unset. The carousel interval is a design constant.
  selectedWork: ['accent', 'cardSlugs', 'button'],
  testimonials: ['accent', 'intervalMs'],
  social: ['accent'],
  aboutWho: ['accent'],
  leadership: ['accent'],
  cta: ['accent'],
  proof: ['quotesAccent'],
  pageHead: ['accent'],
  // UI v2 PR9: the accent word ranges, as above. The FAQ's questions are code-owned (they
  // are also its JSON-LD), so the faq section's only content is its heading.
  contactInquiry: ['accent'],
  contactChannels: ['accent'],
  faq: ['accent'],
  // Round 2: the accent word ranges, as above.
  servicesOverview: ['accent'],
  hello: ['accent'],
};

/** The fields for one section type, or null when it takes no content (table-backed). */
export function sectionFields(type: unknown): readonly FieldDef[] | null {
  return typeof type === 'string' && type in SECTION_UI
    ? (SECTION_UI[type as SectionType] ?? null)
    : null;
}
