// Field descriptors for the generic admin table + form islands.
//
// One data-driven description per resource instead of sixteen bespoke React forms. The
// alternative — a hand-written editor per entity — is where bilingual fields quietly
// become monolingual ones: someone adds a `title` input, ships it, and the Arabic half
// is missing until CI's `meta_*_ar` gate or a reader notices. Here "bilingual" is a
// FIELD KIND, so both inputs appear together or neither does.
//
// This file is presentation only. Nothing here is a security boundary: the server
// re-validates every field against `packages/schemas/admin.ts`, and a field omitted
// here simply cannot be edited in the UI — it does not become writable by other means.

// Zod-free on purpose (see the module header) — this file ships in the admin client bundle.
import { SECTION_TYPES } from '@schemas/sectionTypes';

export type FieldKind =
  | 'text'
  | 'slug'
  | 'bilingual' // {en, ar} — both required
  | 'prose' // {en, ar?} — multiline, AR may lag
  | 'textarea' // plain multiline string (no locale split)
  | 'richtext' // locale-keyed Tiptap
  | 'select'
  | 'checkbox'
  | 'number'
  | 'url'
  | 'datetime'
  | 'tags'
  | 'json'
  // UI v2 (PR3): composite and referencing kinds
  | 'relation' // one row of another resource, by id (a <select> loaded from its API)
  | 'multiRelation' // an ORDERED list of ids of another resource
  | 'multiSelect' // several of `options`, as a string array
  | 'media' // one media asset id, chosen in a <dialog> picker
  | 'repeater' // an array of objects, each edited with `itemFields`
  // Round 3: a fixed-shape object ({value, label} — the proof band's rating line), edited
  // with `itemFields` like one repeater item; omitted from the payload while all blank
  | 'object'
  | 'clip' // a video clip: a Stream UID or a /media/*.mp4 path, plus a ≤30s window
  | 'sectionContent' // page_sections.content, typed by the sibling `type` field
  | 'upload'; // a file sent to `upload.endpoint`; the field holds the returned id

/**
 * One filter of a relation's options query: a value means "equals", `{ neq }` means "is
 * not" — e.g. `{ status: { neq: 'archived' } }` keeps archived rows out of a picker.
 */
export type RelationFilterValue = string | { readonly neq: string };

/** Where a relation field loads its options from. */
export interface RelationDef {
  /** Admin API resource slug: options load from GET /api/admin/<resource>. */
  resource: string;
  /** Row key shown as the option label; a {en, ar} value shows its English. */
  labelKey: string;
  /** Options-query filters: { location: 'header' } (equals), { status: { neq: 'archived' } }. */
  filter?: Readonly<Record<string, RelationFilterValue>>;
}

/**
 * The options query of a relation field. Equality goes as `column=value`, "is not" as
 * `column.neq=value` — the list endpoint (resource.ts) accepts both for `status` and the
 * resource's filterableColumns, and ignores any other key. Hiding a row from the picker
 * never drops it from a record that already links it: the stored id stays selected
 * (RelationField keeps ids the list does not contain).
 */
export function relationParams(relation: RelationDef, limit: number): URLSearchParams {
  const params = new URLSearchParams({ limit: String(limit) });
  for (const [column, value] of Object.entries(relation.filter ?? {})) {
    if (typeof value === 'string') params.set(column, value);
    else params.set(`${column}.neq`, value.neq);
  }
  return params;
}

export interface FieldDef {
  /** camelCase name sent to the API. */
  name: string;
  label: string;
  kind: FieldKind;
  /** Row key returned by the API. Defaults to snake_case(name). */
  column?: string;
  options?: readonly { value: string; label: string }[];
  help?: string;
  required?: boolean;
  /**
   * An all-blank bilingual/prose value is sent as `null` ("none") instead of
   * `{en:'', ar:''}`. Opt-in, and only for fields whose schema AND column accept null
   * (site_profile's legal name / city): most bilingual columns are NOT NULL, and a null
   * there would turn every blank save into a 422.
   */
  nullable?: boolean;
  /** `relation` / `multiRelation`: the resource the ids point at. */
  relation?: RelationDef;
  /** `repeater`: the fields of one item; `object`: the fields of the object. */
  itemFields?: readonly FieldDef[];
  /** `repeater` / `multiRelation` / `multiSelect`: the most items the schema accepts. */
  maxItems?: number;
  /** `sectionContent`: the sibling field holding the section type (default 'type'). */
  typeField?: string;
  /** `upload`: where the file is POSTed (multipart) and what it may be. */
  upload?: { endpoint: string; accept: string };
  /**
   * `clip`: offer only a site file (/media/….mp4) — for tables with no Stream-uid column
   * yet (disciplines, services: 0028). Stream arrives with KAN-20.
   */
  pathOnly?: boolean;
  /**
   * The value a NEW record's form starts with — must equal the create schema's default, or
   * the form shows one thing (an unticked box) while the server stores another.
   */
  defaultValue?: unknown;
}

export interface ColumnDef {
  key: string;
  label: string;
  kind?: 'status' | 'date' | 'bilingual' | 'text' | 'boolean';
}

export interface ResourceUi {
  /** URL segment for both /admin/<slug> and /api/admin/<slug>. */
  slug: string;
  title: string;
  singular: string;
  columns: readonly ColumnDef[];
  fields: readonly FieldDef[];
  /** Exposes the publish/schedule controls and the status filter. */
  hasStatus?: boolean;
  /** Exposes drag-free up/down reordering (POSTs to <slug>/reorder). */
  reorder?: boolean;
}

const STATUS_FIELD: FieldDef = {
  name: 'status',
  label: 'Status',
  kind: 'select',
  options: [
    { value: 'draft', label: 'Draft' },
    { value: 'scheduled', label: 'Scheduled' },
    { value: 'published', label: 'Published' },
    { value: 'archived', label: 'Archived' },
  ],
  help: 'Publishing and scheduling need the publish capability; archiving is Admin-only.',
};

const SCHEDULED_FIELD: FieldDef = {
  name: 'scheduledFor',
  label: 'Scheduled for',
  kind: 'datetime',
  help: 'With status “Scheduled”, the row goes live automatically once this time passes.',
};

const SORT_FIELD: FieldDef = { name: 'sortOrder', label: 'Sort order', kind: 'number' };

/** Design-delivery sample content (UI v2). Refused on publish; production also refuses it in the DB. */
const PLACEHOLDER_FIELD: FieldDef = {
  name: 'isPlaceholder',
  label: 'Placeholder (design sample)',
  kind: 'checkbox',
  help: 'Sample content from the design delivery. It cannot be published or shown until you replace it and untick this.',
};

/** Pickers hide archived rows; a record that already links one keeps the link. */
const NOT_ARCHIVED = { status: { neq: 'archived' } } as const;

/** A window of the showreel in the preview_* columns (0022/0028): a site file, no Stream. */
const showreelClip = (label: string, help: string): FieldDef => ({
  name: 'clip',
  // The API returns the clip derived from the preview_* columns under `preview`.
  column: 'preview',
  label,
  kind: 'clip',
  pathOnly: true,
  help,
});

/** A list of short bilingual phrases stored as [{en, ar}] (the item fields ARE the pair). */
const bilingualList = (name: string, label: string, maxItems: number, help?: string): FieldDef => ({
  name,
  label,
  kind: 'repeater',
  maxItems,
  ...(help ? { help } : {}),
  itemFields: [
    { name: 'en', label: 'English', kind: 'text', required: true },
    { name: 'ar', label: 'Arabic', kind: 'text', required: true },
  ],
});

/** snake_case default for a field's row key. */
export function columnOf(field: FieldDef): string {
  return field.column ?? field.name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

export const RESOURCE_UI: Record<string, ResourceUi> = {
  services: {
    slug: 'services',
    title: 'Services',
    singular: 'Service',
    hasStatus: true,
    reorder: true,
    columns: [
      { key: 'title', label: 'Title', kind: 'bilingual' },
      { key: 'slug', label: 'Slug' },
      { key: 'status', label: 'Status', kind: 'status' },
      { key: 'sort_order', label: 'Order' },
      { key: 'updated_at', label: 'Updated', kind: 'date' },
    ],
    fields: [
      {
        name: 'slug',
        label: 'Slug',
        kind: 'slug',
        required: true,
        help: 'The page address: /services/<slug>.',
      },
      { name: 'title', label: 'Service name', kind: 'bilingual', required: true },
      {
        name: 'disciplineId',
        label: 'Discipline',
        kind: 'relation',
        relation: { resource: 'disciplines', labelKey: 'name', filter: NOT_ARCHIVED },
        help: 'The group it is listed under (home cards, /services, the inquiry forms). Required to publish.',
      },
      {
        name: 'blurb',
        label: 'Tagline',
        kind: 'prose',
        help: 'The tagline shown under the service name. Also the page’s meta description and search text.',
      },
      {
        name: 'intro',
        label: 'Intro (the “What it is” heading)',
        kind: 'bilingual',
        nullable: true,
        help: 'One sentence, e.g. “A logo is a promise you repeat thousands of times, so we make it count.”',
      },
      { name: 'body', label: 'What it is (body)', kind: 'richtext' },
      {
        name: 'valuePoints',
        label: 'Value we add',
        kind: 'repeater',
        maxItems: 6,
        help: 'The “Why it’s worth it” cards. The design shows three.',
        itemFields: [
          { name: 'title', label: 'Title', kind: 'bilingual', required: true },
          { name: 'text', label: 'Text', kind: 'bilingual', required: true },
        ],
      },
      bilingualList('deliverables', 'What you get', 12, 'The checklist, one line each.'),
      {
        name: 'posterMediaId',
        label: 'Poster',
        kind: 'media',
        help: 'The still behind the hero clip, and the service’s image in the Services explorer.',
      },
      showreelClip(
        'Hero clip',
        'The window of the showreel the page opens with, also played on its explorer row. At most 30 seconds.',
      ),
      {
        name: 'shortTitle',
        label: 'Short title (chips)',
        kind: 'bilingual',
        nullable: true,
        help: 'Shown on filter chips and skill tags where the full title is too long (e.g. “SEO / GEO / AEO”). Empty = the title.',
      },
      {
        name: 'heroVideoUid',
        label: 'Hero video (Cloudflare Stream UID)',
        kind: 'text',
        help: 'Not used yet: the page plays the hero clip above until Stream is provisioned (KAN-20).',
      },
      { name: 'category', label: 'Category', kind: 'text' },
      {
        name: 'isTeaser',
        label: 'Coming-soon teaser',
        kind: 'checkbox',
        help: 'Published + teaser shows a “Coming soon” note: not a fifth status.',
      },
      SORT_FIELD,
      STATUS_FIELD,
      SCHEDULED_FIELD,
    ],
  },

  disciplines: {
    slug: 'disciplines',
    title: 'Disciplines',
    singular: 'Discipline',
    hasStatus: true,
    reorder: true,
    columns: [
      { key: 'name', label: 'Name', kind: 'bilingual' },
      { key: 'slug', label: 'Slug' },
      { key: 'status', label: 'Status', kind: 'status' },
      { key: 'sort_order', label: 'Order' },
      { key: 'updated_at', label: 'Updated', kind: 'date' },
    ],
    fields: [
      {
        name: 'slug',
        label: 'Slug',
        kind: 'slug',
        required: true,
        help: 'Its anchor on the Services page: /services#<slug>. At most 64 characters.',
      },
      { name: 'name', label: 'Name', kind: 'bilingual', required: true },
      {
        name: 'short',
        label: 'Card line',
        kind: 'bilingual',
        nullable: true,
        help: 'One line on the discipline card, e.g. “The mark, the system, and everything it touches.”',
      },
      {
        name: 'blurb',
        label: 'Description',
        kind: 'bilingual',
        nullable: true,
        help: 'The paragraph at the top of its panel in the Services explorer.',
      },
      { name: 'posterMediaId', label: 'Poster', kind: 'media', help: 'The card image.' },
      showreelClip(
        'Card clip',
        'The window of the showreel the card plays on hover. At most 30 seconds.',
      ),
      SORT_FIELD,
      {
        ...STATUS_FIELD,
        help: 'Archiving a discipline hides every one of its services from the site. Archiving is Admin-only.',
      },
      SCHEDULED_FIELD,
    ],
  },

  'service-cases': {
    slug: 'service-cases',
    title: 'Service case studies',
    singular: 'Service case study',
    hasStatus: true,
    columns: [
      { key: 'title', label: 'Title', kind: 'bilingual' },
      { key: 'is_placeholder', label: 'Placeholder', kind: 'boolean' },
      { key: 'status', label: 'Status', kind: 'status' },
      { key: 'updated_at', label: 'Updated', kind: 'date' },
    ],
    fields: [
      {
        name: 'serviceId',
        label: 'Service',
        kind: 'relation',
        required: true,
        relation: { resource: 'services', labelKey: 'title', filter: NOT_ARCHIVED },
        help: 'The service page this block appears on. One per service.',
      },
      {
        name: 'portfolioId',
        label: 'Project',
        kind: 'relation',
        relation: { resource: 'portfolio', labelKey: 'title', filter: NOT_ARCHIVED },
        help: 'The case study it links to. Its client and industry are the block’s chips; a client not cleared for disclosure shows as “Confidential client”.',
      },
      { name: 'title', label: 'Title', kind: 'bilingual', required: true },
      {
        name: 'context',
        label: 'Where they were',
        kind: 'bilingual',
        nullable: true,
        help: 'The situation before the work, a sentence or two.',
      },
      {
        name: 'problems',
        label: 'The problem, and what we did',
        kind: 'repeater',
        maxItems: 6,
        help: 'The design shows three rows.',
        itemFields: [
          { name: 'problem', label: 'The problem', kind: 'bilingual', required: true },
          { name: 'solution', label: 'What we did', kind: 'bilingual', required: true },
        ],
      },
      {
        name: 'results',
        label: 'Results',
        kind: 'repeater',
        maxItems: 4,
        help: 'Figures only when they are real. A placeholder figure (XX) cannot be published.',
        itemFields: [
          { name: 'value', label: 'Figure', kind: 'text', required: true, help: 'e.g. 4, +27%' },
          { name: 'label', label: 'What it measures', kind: 'bilingual', required: true },
        ],
      },
      PLACEHOLDER_FIELD,
      STATUS_FIELD,
      SCHEDULED_FIELD,
    ],
  },

  blog: {
    slug: 'blog',
    title: 'Blog',
    singular: 'Post',
    hasStatus: true,
    columns: [
      { key: 'title', label: 'Title', kind: 'bilingual' },
      { key: 'slug', label: 'Slug' },
      { key: 'status', label: 'Status', kind: 'status' },
      { key: 'published_at', label: 'Published', kind: 'date' },
      { key: 'updated_at', label: 'Updated', kind: 'date' },
    ],
    fields: [
      { name: 'slug', label: 'Slug', kind: 'slug', required: true },
      { name: 'title', label: 'Title', kind: 'bilingual', required: true },
      { name: 'excerpt', label: 'Excerpt', kind: 'prose' },
      { name: 'body', label: 'Body', kind: 'richtext' },
      {
        name: 'authorId',
        label: 'Author (team member id)',
        kind: 'text',
        help: 'Required to publish — E-E-A-T forbids anonymous authorship.',
      },
      { name: 'categoryId', label: 'Category id', kind: 'text' },
      { name: 'coverImageUrl', label: 'Cover image URL', kind: 'url' },
      STATUS_FIELD,
      SCHEDULED_FIELD,
    ],
  },

  portfolio: {
    slug: 'portfolio',
    title: 'Our Work',
    singular: 'Case study',
    hasStatus: true,
    reorder: true,
    columns: [
      { key: 'title', label: 'Title', kind: 'bilingual' },
      { key: 'project_type', label: 'Type', kind: 'bilingual' },
      { key: 'year', label: 'Year' },
      { key: 'is_featured', label: 'Featured', kind: 'boolean' },
      { key: 'is_placeholder', label: 'Placeholder', kind: 'boolean' },
      { key: 'status', label: 'Status', kind: 'status' },
      { key: 'updated_at', label: 'Updated', kind: 'date' },
    ],
    fields: [
      {
        name: 'slug',
        label: 'Slug',
        kind: 'slug',
        required: true,
        help: 'The case study’s address: /portfolio/<slug>. “all” is reserved.',
      },
      { name: 'title', label: 'Project name', kind: 'bilingual', required: true },
      {
        name: 'projectType',
        label: 'Project type',
        kind: 'bilingual',
        nullable: true,
        help: 'Shown on the card and in the title band — “Brand film”, “Rebrand”. Required to publish.',
      },
      {
        name: 'teaser',
        label: 'Card blurb',
        kind: 'bilingual',
        nullable: true,
        help: 'One line under the project on Our Work and All projects. Empty = the overview.',
      },
      {
        name: 'sectorId',
        label: 'Industry',
        kind: 'relation',
        relation: { resource: 'sectors', labelKey: 'name' },
      },
      {
        name: 'clientId',
        label: 'Client',
        kind: 'relation',
        relation: { resource: 'clients', labelKey: 'name' },
        help: 'A client not yet cleared for disclosure (not visible) shows as “Confidential client”.',
      },
      { name: 'year', label: 'Year', kind: 'number' },
      {
        name: 'serviceIds',
        label: 'Services',
        kind: 'multiRelation',
        relation: { resource: 'services', labelKey: 'title', filter: NOT_ARCHIVED },
        maxItems: 20,
        help: 'In the order the case study lists them; they are also its catalogue filters. Archived services are not offered; one already listed stays until you remove it.',
      },
      {
        name: 'isFeatured',
        label: 'Featured',
        kind: 'checkbox',
        help: 'Featured projects lead Our Work and Selected work on the home page.',
      },
      {
        name: 'posterMediaId',
        label: 'Poster',
        kind: 'media',
        help: 'The card image. Needs alt text in English and Arabic to publish.',
      },
      {
        name: 'preview',
        label: 'Card hover clip',
        kind: 'clip',
        help: 'A short window of a video, played while the card is hovered (never on touch).',
      },
      {
        name: 'lead',
        label: 'Lead',
        kind: 'bilingual',
        nullable: true,
        help: 'The case study’s opening line.',
      },
      { name: 'summary', label: 'Overview', kind: 'prose' },
      { name: 'goal', label: 'The goal', kind: 'bilingual', nullable: true },
      { name: 'result', label: 'The result', kind: 'bilingual', nullable: true },
      bilingualList('scope', 'Scope', 10, 'What the studio did, one line each.'),
      bilingualList('keywords', 'Keywords', 6, 'The chips under the title.'),
      {
        name: 'results',
        label: 'Result cards',
        kind: 'repeater',
        maxItems: 4,
        help: 'Figures only when they are real — a placeholder figure (XX) cannot be published.',
        itemFields: [
          { name: 'value', label: 'Figure', kind: 'text', required: true, help: 'e.g. 3.2M, +40%' },
          { name: 'label', label: 'What it measures', kind: 'bilingual', required: true },
        ],
      },
      {
        name: 'media',
        label: 'Case-study media',
        kind: 'repeater',
        maxItems: 40,
        help: 'One hero and one final film at most; breakdown items need their kind. Saved with the case study in one step.',
        itemFields: [
          {
            name: 'role',
            label: 'Where it appears',
            kind: 'select',
            required: true,
            options: [
              { value: 'hero', label: 'Hero banner' },
              { value: 'final', label: 'Final film' },
              { value: 'breakdown', label: 'Breakdown' },
              { value: 'gallery', label: 'Gallery' },
            ],
          },
          {
            name: 'kind',
            label: 'Kind',
            kind: 'select',
            required: true,
            options: [
              { value: 'image', label: 'Image' },
              { value: 'video', label: 'Video' },
            ],
          },
          { name: 'mediaId', label: 'Image (a video’s poster)', kind: 'media' },
          { name: 'clip', label: 'Video', kind: 'clip' },
          { name: 'durationLabel', label: 'Duration shown (m:ss)', kind: 'text' },
          { name: 'caption', label: 'Caption', kind: 'bilingual' },
          {
            name: 'breakdownKind',
            label: 'Breakdown kind',
            kind: 'select',
            options: [
              { value: 'sketch', label: 'Sketch' },
              { value: 'bts', label: 'Behind the scenes' },
              { value: 'process', label: 'Process' },
            ],
          },
          {
            name: 'layout',
            label: 'Layout',
            kind: 'select',
            options: [
              { value: 'half', label: 'Half width' },
              { value: 'wide', label: 'Wide' },
              { value: 'third', label: 'One third' },
            ],
          },
        ],
      },
      { name: 'body', label: 'Body', kind: 'richtext' },
      {
        name: 'nextPortfolioId',
        label: 'Next project',
        kind: 'relation',
        relation: { resource: 'portfolio', labelKey: 'title' },
        help: 'Empty = the next project in catalogue order.',
      },
      PLACEHOLDER_FIELD,
      SORT_FIELD,
      STATUS_FIELD,
      SCHEDULED_FIELD,
    ],
  },

  sectors: {
    slug: 'sectors',
    title: 'Sectors',
    singular: 'Sector',
    reorder: true,
    columns: [
      { key: 'name', label: 'Name', kind: 'bilingual' },
      { key: 'slug', label: 'Slug' },
      { key: 'visible', label: 'Visible', kind: 'boolean' },
    ],
    fields: [
      {
        name: 'slug',
        label: 'Slug',
        kind: 'slug',
        required: true,
        help: 'Used in filter links: /portfolio/all?sector=<slug>.',
      },
      { name: 'name', label: 'Name', kind: 'bilingual', required: true },
      { name: 'visible', label: 'Visible', kind: 'checkbox', defaultValue: true },
      SORT_FIELD,
    ],
  },

  clients: {
    slug: 'clients',
    title: 'Clients',
    singular: 'Client',
    reorder: true,
    columns: [
      { key: 'name', label: 'Name', kind: 'bilingual' },
      { key: 'visible', label: 'Cleared (visible)', kind: 'boolean' },
      { key: 'show_in_marquee', label: 'Marquee', kind: 'boolean' },
      { key: 'is_placeholder', label: 'Placeholder', kind: 'boolean' },
    ],
    fields: [
      { name: 'slug', label: 'Slug', kind: 'slug', required: true },
      { name: 'name', label: 'Name', kind: 'bilingual', required: true },
      {
        name: 'visible',
        label: 'Cleared for disclosure (visible)',
        kind: 'checkbox',
        help: 'Tick only once the client has agreed to be named. Until then the site shows “Confidential client”.',
      },
      {
        name: 'showInMarquee',
        label: 'Show in the clients marquee',
        kind: 'checkbox',
      },
      { name: 'logoMediaId', label: 'Logo', kind: 'media' },
      { name: 'websiteUrl', label: 'Website', kind: 'url', help: 'https only.' },
      PLACEHOLDER_FIELD,
      SORT_FIELD,
    ],
  },

  testimonials: {
    slug: 'testimonials',
    title: 'Testimonials',
    singular: 'Quote',
    hasStatus: true,
    reorder: true,
    columns: [
      { key: 'author_name', label: 'Author', kind: 'bilingual' },
      { key: 'slug', label: 'Slug' },
      { key: 'is_placeholder', label: 'Placeholder', kind: 'boolean' },
      { key: 'status', label: 'Status', kind: 'status' },
    ],
    fields: [
      { name: 'slug', label: 'Slug', kind: 'slug', required: true },
      {
        name: 'quote',
        label: 'Quote',
        kind: 'bilingual',
        required: true,
        help: 'At most 600 characters per language.',
      },
      { name: 'authorName', label: 'Author', kind: 'bilingual', required: true },
      {
        name: 'authorRole',
        label: 'Title, company',
        kind: 'bilingual',
        nullable: true,
        help: 'Written as it should appear: “Marketing Director, Company”.',
      },
      {
        name: 'placements',
        label: 'Shown on',
        kind: 'multiSelect',
        options: [
          { value: 'home', label: 'Home' },
          { value: 'work', label: 'Our Work' },
        ],
      },
      {
        name: 'portfolioId',
        label: 'Case study',
        kind: 'relation',
        relation: { resource: 'portfolio', labelKey: 'title' },
        help: 'Shown on that case study. One published quote per case study.',
      },
      {
        name: 'clientId',
        label: 'Client',
        kind: 'relation',
        relation: { resource: 'clients', labelKey: 'name' },
      },
      { name: 'avatarMediaId', label: 'Photo', kind: 'media' },
      {
        name: 'consentObtainedAt',
        label: 'Consent obtained',
        kind: 'datetime',
        help: 'When the person agreed to be quoted. Required to publish or schedule — the database refuses otherwise.',
      },
      {
        name: 'consentReference',
        label: 'Consent record',
        kind: 'text',
        help: 'Where the consent is kept (an email, ticket or document id). Never shown on the site.',
      },
      PLACEHOLDER_FIELD,
      SORT_FIELD,
      STATUS_FIELD,
      SCHEDULED_FIELD,
    ],
  },

  pages: {
    slug: 'pages',
    title: 'Pages',
    singular: 'Page',
    hasStatus: true,
    columns: [
      { key: 'title', label: 'Title', kind: 'bilingual' },
      { key: 'slug', label: 'Slug' },
      { key: 'status', label: 'Status', kind: 'status' },
      { key: 'nav_visible', label: 'In nav', kind: 'boolean' },
      { key: 'updated_at', label: 'Updated', kind: 'date' },
    ],
    fields: [
      { name: 'slug', label: 'Slug', kind: 'slug', required: true },
      { name: 'title', label: 'Title', kind: 'bilingual', required: true },
      { name: 'navVisible', label: 'Show in navigation', kind: 'checkbox', defaultValue: true },
      STATUS_FIELD,
      SCHEDULED_FIELD,
    ],
  },

  sections: {
    slug: 'sections',
    title: 'Page sections',
    singular: 'Section',
    reorder: true,
    columns: [
      { key: 'type', label: 'Type' },
      { key: 'visible', label: 'Visible', kind: 'boolean' },
      { key: 'sort_order', label: 'Order' },
      { key: 'updated_at', label: 'Updated', kind: 'date' },
    ],
    fields: [
      {
        name: 'pageId',
        label: 'Page',
        kind: 'relation',
        required: true,
        relation: { resource: 'pages', labelKey: 'title' },
      },
      {
        name: 'type',
        label: 'Section type',
        kind: 'select',
        required: true,
        // The canonical list (packages/schemas/sections.ts) — the server rejects anything else.
        options: SECTION_TYPES.map((t) => ({ value: t, label: t })),
      },
      {
        name: 'content',
        label: 'Content',
        kind: 'sectionContent',
        typeField: 'type',
        help: 'Optional per-type overrides of the built-in copy, validated against the section type on save.',
      },
      { name: 'visible', label: 'Visible', kind: 'checkbox' },
      {
        name: 'isPlaceholder',
        label: 'Design placeholder',
        kind: 'checkbox',
        help: 'Seeded demo content. In production a placeholder cannot be made visible — replace the copy, then untick.',
      },
      SORT_FIELD,
    ],
  },

  navigation: {
    slug: 'navigation',
    title: 'Navigation',
    singular: 'Nav item',
    reorder: true,
    columns: [
      { key: 'label', label: 'Label', kind: 'bilingual' },
      { key: 'href', label: 'Link' },
      { key: 'location', label: 'Location' },
      { key: 'visible', label: 'Visible', kind: 'boolean' },
      { key: 'is_key', label: 'Key link', kind: 'boolean' },
    ],
    fields: [
      {
        name: 'location',
        label: 'Location',
        kind: 'select',
        options: [
          { value: 'header', label: 'Header' },
          { value: 'footer', label: 'Footer' },
        ],
        required: true,
      },
      { name: 'label', label: 'Label', kind: 'bilingual', required: true },
      { name: 'href', label: 'Link', kind: 'text', required: true },
      { name: 'parentId', label: 'Parent item id', kind: 'text' },
      { name: 'visible', label: 'Visible', kind: 'checkbox' },
      {
        name: 'isKey',
        label: 'Key link (stays in the header bar on phones)',
        kind: 'checkbox',
        help: 'At <=900px the header shows only this link; the rest move into the menu. One per menu — untick the current key link before ticking another.',
      },
      SORT_FIELD,
    ],
  },

  categories: {
    slug: 'categories',
    title: 'Categories',
    singular: 'Category',
    columns: [
      { key: 'name', label: 'Name', kind: 'bilingual' },
      { key: 'slug', label: 'Slug' },
    ],
    fields: [
      { name: 'slug', label: 'Slug', kind: 'slug', required: true },
      { name: 'name', label: 'Name', kind: 'bilingual', required: true },
    ],
  },

  team: {
    slug: 'team',
    title: 'Team & authors',
    singular: 'Team member',
    hasStatus: true,
    reorder: true,
    columns: [
      { key: 'name', label: 'Name', kind: 'bilingual' },
      { key: 'role', label: 'Title', kind: 'bilingual' },
      { key: 'is_leadership', label: 'Leadership', kind: 'boolean' },
      { key: 'status', label: 'Status', kind: 'status' },
    ],
    fields: [
      { name: 'slug', label: 'Slug', kind: 'slug', required: true },
      { name: 'name', label: 'Name', kind: 'bilingual', required: true },
      { name: 'role', label: 'Job title', kind: 'bilingual', nullable: true },
      {
        name: 'isLeadership',
        label: 'Leadership',
        kind: 'checkbox',
        help: 'Shown in the About page leadership slider.',
      },
      { name: 'portraitMediaId', label: 'Portrait', kind: 'media' },
      {
        name: 'linkedinUrl',
        label: 'LinkedIn',
        kind: 'url',
        help: 'https://linkedin.com/in/… — the slider links it only when set.',
      },
      { name: 'bio', label: 'Bio', kind: 'prose' },
      { name: 'avatarUrl', label: 'Avatar URL', kind: 'url' },
      PLACEHOLDER_FIELD,
      SORT_FIELD,
      STATUS_FIELD,
    ],
  },

  certifications: {
    slug: 'certifications',
    title: 'Certifications',
    singular: 'Certification',
    hasStatus: true,
    reorder: true,
    columns: [
      { key: 'name', label: 'Name', kind: 'bilingual' },
      { key: 'year', label: 'Year' },
      { key: 'status', label: 'Status', kind: 'status' },
    ],
    fields: [
      { name: 'slug', label: 'Slug', kind: 'slug', required: true },
      { name: 'name', label: 'Name', kind: 'bilingual', required: true },
      { name: 'issuer', label: 'Issuer', kind: 'prose' },
      { name: 'year', label: 'Year', kind: 'number' },
      { name: 'logoUrl', label: 'Logo URL', kind: 'url' },
      SORT_FIELD,
      STATUS_FIELD,
    ],
  },

  statistics: {
    slug: 'statistics',
    title: 'Statistics',
    singular: 'Statistic',
    hasStatus: true,
    reorder: true,
    columns: [
      { key: 'label', label: 'Label', kind: 'bilingual' },
      { key: 'value', label: 'Value' },
      { key: 'is_placeholder', label: 'Placeholder', kind: 'boolean' },
      { key: 'status', label: 'Status', kind: 'status' },
    ],
    fields: [
      { name: 'slug', label: 'Slug', kind: 'slug', required: true },
      { name: 'label', label: 'Label', kind: 'bilingual', required: true },
      {
        name: 'valueNumeric',
        label: 'Number',
        kind: 'number',
        help: 'The number the band counts up to. With a number, the displayed value is the number plus its suffix.',
      },
      {
        name: 'valueSuffix',
        label: 'Suffix',
        kind: 'text',
        help: '“+”, “%”, “x” — at most 4 characters.',
      },
      {
        name: 'value',
        label: 'Displayed value (no number)',
        kind: 'text',
        help: 'Only for a value that is not a plain number. With a number above, this is derived.',
      },
      {
        name: 'placements',
        label: 'Shown on',
        kind: 'multiSelect',
        options: [
          { value: 'home', label: 'Home' },
          { value: 'about', label: 'About' },
          { value: 'work', label: 'Our Work' },
          { value: 'services', label: 'Services page' },
        ],
      },
      {
        name: 'placementLabels',
        label: 'Label on a specific page',
        kind: 'repeater',
        maxItems: 4,
        help: 'Where a page words it differently (“Projects delivered across the region” on About).',
        itemFields: [
          {
            name: 'placement',
            label: 'Page',
            kind: 'select',
            required: true,
            options: [
              { value: 'home', label: 'Home' },
              { value: 'about', label: 'About' },
              { value: 'work', label: 'Our Work' },
              { value: 'services', label: 'Services page' },
            ],
          },
          { name: 'label', label: 'Label', kind: 'bilingual', required: true },
        ],
      },
      PLACEHOLDER_FIELD,
      SORT_FIELD,
      STATUS_FIELD,
    ],
  },

  redirects: {
    slug: 'redirects',
    title: 'Redirects',
    singular: 'Redirect',
    columns: [
      { key: 'source_path', label: 'From' },
      { key: 'target_path', label: 'To' },
      { key: 'status', label: 'Code' },
    ],
    fields: [
      { name: 'sourcePath', label: 'From (site-relative)', kind: 'text', required: true },
      { name: 'targetPath', label: 'To', kind: 'text', required: true },
      {
        name: 'status',
        label: 'HTTP status',
        kind: 'select',
        options: [
          { value: '301', label: '301 — permanent' },
          { value: '302', label: '302 — temporary' },
          { value: '308', label: '308 — permanent, method-preserving' },
        ],
      },
    ],
  },

  media: {
    slug: 'media',
    title: 'Media library',
    singular: 'Asset',
    columns: [
      { key: 'storage_path', label: 'Path' },
      { key: 'kind', label: 'Kind' },
      { key: 'alt', label: 'Alt text', kind: 'bilingual' },
      { key: 'created_at', label: 'Added', kind: 'date' },
    ],
    fields: [
      {
        name: 'kind',
        label: 'Kind',
        kind: 'select',
        options: [
          { value: 'image', label: 'Image' },
          { value: 'video', label: 'Video' },
          { value: 'audio', label: 'Audio' },
          { value: 'pdf', label: 'PDF' },
        ],
        required: true,
      },
      { name: 'storagePath', label: 'Storage path', kind: 'text', required: true },
      { name: 'folder', label: 'Folder', kind: 'text' },
      {
        name: 'alt',
        label: 'Alt text',
        kind: 'bilingual',
        help: 'Required for images — WCAG 2.2 AA is a definition-of-done gate.',
      },
      { name: 'tags', label: 'Tags', kind: 'tags' },
      { name: 'width', label: 'Width (px)', kind: 'number' },
      { name: 'height', label: 'Height (px)', kind: 'number' },
      { name: 'streamUid', label: 'Cloudflare Stream UID', kind: 'text' },
    ],
  },

  themes: {
    slug: 'themes',
    title: 'Themes',
    singular: 'Theme',
    columns: [
      { key: 'name', label: 'Name' },
      { key: 'is_active', label: 'Active', kind: 'boolean' },
      { key: 'updated_at', label: 'Updated', kind: 'date' },
    ],
    fields: [
      { name: 'name', label: 'Name', kind: 'text', required: true },
      {
        name: 'tokens',
        label: 'Tokens (JSON)',
        kind: 'json',
        help: 'CSS custom properties only: keys must start with “--”, values may not contain ; { } < >.',
      },
      { name: 'isActive', label: 'Active theme', kind: 'checkbox' },
    ],
  },

  'ai-questions': {
    slug: 'ai-questions',
    title: 'Style-Finder questions',
    singular: 'Question',
    hasStatus: true,
    reorder: true,
    columns: [
      { key: 'prompt', label: 'Prompt', kind: 'bilingual' },
      { key: 'input_type', label: 'Input' },
      { key: 'status', label: 'Status', kind: 'status' },
    ],
    fields: [
      { name: 'slug', label: 'Slug', kind: 'slug', required: true },
      { name: 'prompt', label: 'Prompt', kind: 'bilingual', required: true },
      { name: 'helpText', label: 'Help text', kind: 'prose' },
      {
        name: 'inputType',
        label: 'Input type',
        kind: 'select',
        options: [
          { value: 'single', label: 'Single choice' },
          { value: 'multi', label: 'Multiple choice' },
          { value: 'scale', label: 'Scale' },
          { value: 'text', label: 'Free text' },
        ],
      },
      { name: 'options', label: 'Options (JSON)', kind: 'json' },
      SORT_FIELD,
      STATUS_FIELD,
    ],
  },

  'ai-styles': {
    slug: 'ai-styles',
    title: 'Style-Finder styles',
    singular: 'Style',
    hasStatus: true,
    reorder: true,
    columns: [
      { key: 'name', label: 'Name', kind: 'bilingual' },
      { key: 'slug', label: 'Slug' },
      { key: 'status', label: 'Status', kind: 'status' },
    ],
    fields: [
      { name: 'slug', label: 'Slug', kind: 'slug', required: true },
      { name: 'name', label: 'Name', kind: 'bilingual', required: true },
      { name: 'description', label: 'Description', kind: 'prose' },
      { name: 'traits', label: 'Traits (JSON)', kind: 'json' },
      { name: 'imageUrl', label: 'Image URL', kind: 'url' },
      SORT_FIELD,
      STATUS_FIELD,
    ],
  },
};

export function uiFor(slug: string): ResourceUi {
  const ui = RESOURCE_UI[slug];
  if (!ui) throw new Error(`No admin UI schema for resource '${slug}'`);
  return ui;
}

// ── Singleton config surfaces ───────────────────────────────────────────────────
// One row per tenant, edited through GET/PATCH rather than a collection. Same field
// descriptors, so `SingletonForm` and `ResourceForm` render identical controls and a
// bilingual field cannot end up half-implemented on one of the two paths.

export interface SingletonUi {
  endpoint: string;
  title: string;
  fields: readonly FieldDef[];
}

export const SINGLETON_UI: Record<string, SingletonUi> = {
  seo: {
    endpoint: '/api/admin/seo-defaults',
    title: 'Global SEO defaults',
    fields: [
      {
        name: 'titleTemplate',
        label: 'Title template',
        kind: 'bilingual',
        column: 'title_template',
        help: 'Use %s for the page title and %brand% for the studio name (from Public identity), e.g. “%brand% | %s”. Left empty, the site uses exactly that format.',
      },
      {
        name: 'defaultTitle',
        label: 'Default title',
        kind: 'bilingual',
        column: 'default_title',
        help: 'Only for a page with no title of its own — a page’s own title always wins.',
      },
      {
        name: 'defaultDescription',
        label: 'Default description',
        kind: 'bilingual',
        column: 'default_description',
      },
      {
        name: 'defaultOgImage',
        label: 'Default OG image',
        kind: 'url',
        column: 'default_og_image',
      },
      {
        name: 'organization',
        label: 'Organization JSON-LD',
        kind: 'json',
        help: 'Deprecated — no longer read by the site. The Organization schema is built from Settings → Public identity (brand, email, location, socials).',
      },
      {
        name: 'robotsDirectives',
        label: 'Robots directives',
        kind: 'text',
        column: 'robots_directives',
      },
    ],
  },

  profile: {
    endpoint: '/api/admin/site-profile',
    title: 'Public identity',
    fields: [
      {
        name: 'brandName',
        label: 'Brand name',
        kind: 'bilingual',
        column: 'brand_name',
        required: true,
        help: 'Shown in the header, footer, page titles and Organization JSON-LD on every page.',
      },
      {
        name: 'legalName',
        label: 'Registered legal name',
        kind: 'bilingual',
        column: 'legal_name',
        nullable: true,
        help: 'The data controller named in the privacy notice and terms. Leave empty to use the brand name.',
      },
      {
        name: 'contactEmail',
        label: 'Contact email',
        kind: 'text',
        column: 'contact_email',
        required: true,
      },
      {
        name: 'whatsappE164',
        label: 'WhatsApp number (E.164)',
        kind: 'text',
        column: 'whatsapp_e164',
        help: 'e.g. +9665XXXXXXXX. Leave empty and the WhatsApp contact card is not shown.',
      },
      {
        name: 'whatsappDisplay',
        label: 'WhatsApp number as displayed',
        kind: 'text',
        column: 'whatsapp_display',
      },
      {
        name: 'location',
        label: 'Location',
        kind: 'bilingual',
        required: true,
        help: 'Footer copy, e.g. “Jeddah, Saudi Arabia”.',
      },
      {
        name: 'addressLocality',
        label: 'City (structured data)',
        kind: 'bilingual',
        column: 'address_locality',
        nullable: true,
      },
      {
        name: 'addressCountry',
        label: 'Country code',
        kind: 'text',
        column: 'address_country',
        help: 'ISO 3166-1 alpha-2, e.g. SA.',
      },
      { name: 'foundedYear', label: 'Founded (year)', kind: 'number', column: 'founded_year' },
      {
        name: 'socials',
        label: 'Social links (JSON)',
        kind: 'json',
        help: '[{"network":"instagram","handle":"@…","url":"https://instagram.com/…"}] — each link must point at its own network.',
      },
      {
        name: 'acceptingApplications',
        label: 'Accepting job applications',
        kind: 'checkbox',
        column: 'accepting_applications',
        help: 'Admin only — opens the public application form on /join.',
      },
    ],
  },

  settings: {
    endpoint: '/api/admin/settings',
    title: 'General settings',
    fields: [
      {
        name: 'identity',
        label: 'Technical identity keys (JSON)',
        kind: 'json',
        help: 'Server-side keys only (e.g. notify_lead_url). The public brand, contact details and socials live in “Public identity” above.',
      },
      {
        name: 'retention',
        label: 'Retention horizons (JSON)',
        kind: 'json',
        help: 'raw_telemetry_days is capped at 90 — the PDPL promise may be shortened, never extended.',
      },
    ],
  },

  integrations: {
    endpoint: '/api/admin/integrations',
    title: 'Integrations',
    fields: [
      {
        name: 'ga4',
        label: 'GA4 (JSON)',
        kind: 'json',
        help: 'Secondary analytics; consent-gated.',
      },
      {
        name: 'searchConsole',
        label: 'Search Console (JSON)',
        kind: 'json',
        column: 'search_console',
      },
      { name: 'calendly', label: 'Calendly (JSON)', kind: 'json' },
      { name: 'recaptcha', label: 'reCAPTCHA (JSON)', kind: 'json' },
    ],
  },

  'ai-config': {
    endpoint: '/api/admin/ai-config',
    title: 'Style-Finder results & logic',
    fields: [
      { name: 'enabled', label: 'Enabled', kind: 'checkbox' },
      { name: 'model', label: 'Model', kind: 'text' },
      {
        name: 'dailyUsdCap',
        label: 'Daily spend cap (USD)',
        kind: 'number',
        column: 'daily_usd_cap',
        help: 'The hard ceiling. Capped at 1000 by the schema so a stray zero cannot lift it.',
      },
      {
        name: 'perIpHourlyLimit',
        label: 'Per-IP hourly limit',
        kind: 'number',
        column: 'per_ip_hourly_limit',
      },
      {
        name: 'perSessionHourlyLimit',
        label: 'Per-session hourly limit',
        kind: 'number',
        column: 'per_session_hourly_limit',
      },
      { name: 'systemPrompt', label: 'System prompt', kind: 'textarea', column: 'system_prompt' },
      { name: 'scoring', label: 'Scoring (JSON)', kind: 'json' },
    ],
  },
};

export function singletonFor(key: string): SingletonUi {
  const ui = SINGLETON_UI[key];
  if (!ui) throw new Error(`No admin UI schema for singleton '${key}'`);
  return ui;
}
