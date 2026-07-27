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
  | 'json';

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
      { key: 'is_teaser', label: 'Teaser', kind: 'boolean' },
      { key: 'updated_at', label: 'Updated', kind: 'date' },
    ],
    fields: [
      { name: 'slug', label: 'Slug', kind: 'slug', required: true },
      { name: 'title', label: 'Title', kind: 'bilingual', required: true },
      { name: 'blurb', label: 'Blurb', kind: 'prose' },
      { name: 'body', label: 'Body', kind: 'richtext' },
      {
        name: 'heroVideoUid',
        label: 'Hero video (Cloudflare Stream UID)',
        kind: 'text',
        help: 'Video is Stream-only; the poster frame becomes the page’s LCP image.',
      },
      { name: 'category', label: 'Category', kind: 'text' },
      {
        name: 'isTeaser',
        label: 'Coming-soon teaser',
        kind: 'checkbox',
        help: 'Published + teaser is how Gaming launches — not a fifth status.',
      },
      SORT_FIELD,
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
    title: 'Portfolio',
    singular: 'Case study',
    hasStatus: true,
    reorder: true,
    columns: [
      { key: 'title', label: 'Title', kind: 'bilingual' },
      { key: 'slug', label: 'Slug' },
      { key: 'status', label: 'Status', kind: 'status' },
      { key: 'updated_at', label: 'Updated', kind: 'date' },
    ],
    fields: [
      { name: 'slug', label: 'Slug', kind: 'slug', required: true },
      { name: 'title', label: 'Title', kind: 'bilingual', required: true },
      { name: 'summary', label: 'Summary', kind: 'prose' },
      { name: 'body', label: 'Body', kind: 'richtext' },
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
      { name: 'navVisible', label: 'Show in navigation', kind: 'checkbox' },
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
      { name: 'pageId', label: 'Page id', kind: 'text', required: true },
      {
        name: 'type',
        label: 'Section type',
        kind: 'text',
        required: true,
        help: 'Must match a component in src/components/sections.',
      },
      { name: 'content', label: 'Content (JSON)', kind: 'json' },
      {
        name: 'style',
        label: 'Style (JSON)',
        kind: 'json',
        help: 'CSS custom properties only — the strict CSP has no unsafe-inline.',
      },
      { name: 'visible', label: 'Visible', kind: 'checkbox' },
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
      { key: 'slug', label: 'Slug' },
      { key: 'status', label: 'Status', kind: 'status' },
    ],
    fields: [
      { name: 'slug', label: 'Slug', kind: 'slug', required: true },
      { name: 'name', label: 'Name', kind: 'bilingual', required: true },
      { name: 'bio', label: 'Bio', kind: 'prose' },
      { name: 'avatarUrl', label: 'Avatar URL', kind: 'url' },
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
      { key: 'status', label: 'Status', kind: 'status' },
    ],
    fields: [
      { name: 'slug', label: 'Slug', kind: 'slug', required: true },
      { name: 'label', label: 'Label', kind: 'bilingual', required: true },
      {
        name: 'value',
        label: 'Value',
        kind: 'text',
        required: true,
        help: 'A display string — “150+”, “98%”, “3x” all survive verbatim.',
      },
      SORT_FIELD,
      STATUS_FIELD,
    ],
  },

  'partner-logos': {
    slug: 'partner-logos',
    title: 'Partner logos',
    singular: 'Partner logo',
    reorder: true,
    columns: [
      { key: 'name', label: 'Name' },
      { key: 'logo_url', label: 'Logo' },
      { key: 'visible', label: 'Visible', kind: 'boolean' },
    ],
    fields: [
      { name: 'name', label: 'Name', kind: 'text', required: true },
      { name: 'logoUrl', label: 'Logo URL', kind: 'url', required: true },
      { name: 'scale', label: 'Scale', kind: 'number' },
      { name: 'offsetY', label: 'Vertical offset', kind: 'number' },
      { name: 'visible', label: 'Visible', kind: 'checkbox' },
      SORT_FIELD,
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
        help: 'Use %s for the page title, e.g. “%s | Braiin Station”.',
      },
      { name: 'defaultTitle', label: 'Default title', kind: 'bilingual', column: 'default_title' },
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
        help: 'Feeds the sitewide Organization schema. Validated by the seo-ci gate.',
      },
      {
        name: 'robotsDirectives',
        label: 'Robots directives',
        kind: 'text',
        column: 'robots_directives',
      },
    ],
  },

  settings: {
    endpoint: '/api/admin/settings',
    title: 'General settings',
    fields: [
      {
        name: 'identity',
        label: 'Identity (JSON)',
        kind: 'json',
        help: 'Site name, footer copy, contact details, social handles.',
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
