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
    heading,
    { name: 'text', label: 'Text', kind: 'bilingual' },
    { name: 'buttonLabel', label: 'Button label', kind: 'bilingual' },
  ],
  aboutStory: [
    heading,
    { name: 'lead', label: 'Lead', kind: 'bilingual' },
    { name: 'missionTitle', label: 'Mission title', kind: 'bilingual' },
    { name: 'mission', label: 'Mission', kind: 'bilingual' },
    { name: 'visionTitle', label: 'Vision title', kind: 'bilingual' },
    { name: 'vision', label: 'Vision', kind: 'bilingual' },
  ],
};

/** Content keys an editor must set through "Advanced (JSON)" — see the header. */
export const SECTION_ADVANCED_ONLY: Partial<Record<SectionType, readonly string[]>> = {
  hero: ['intro'],
};

/** The fields for one section type, or null when it takes no content (table-backed). */
export function sectionFields(type: unknown): readonly FieldDef[] | null {
  return typeof type === 'string' && type in SECTION_UI
    ? (SECTION_UI[type as SectionType] ?? null)
    : null;
}
