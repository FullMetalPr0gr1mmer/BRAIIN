// One sample value per payload key of the admin's write configs (Admin v2 R2), for the
// tests that drive `toRow` key by key: tests/lib/resourceFields.spec.ts (each key emits
// only the columns its `fields` entry declares) and tests/lib/releaseOffWrites.spec.ts
// (with releases off, every save writes exactly what it wrote before R2).
//
// `toRow` validates or transforms a few keys (a nav href and a redirect target are
// sanitised, a redirect source normalised, a statistic's value derived from its number,
// a body rendered to HTML and timed, a clip split into its columns); those samples are
// valid inputs for that rule. Every other key is copied as it is, so any plain value
// does. Made-up content only: the repository is public.

const DOC = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

const BI = (en: string, ar: string) => ({ en, ar });

const UUID_A = '0f0f0f0f-0000-4000-8000-00000000000a';
const UUID_B = '0f0f0f0f-0000-4000-8000-00000000000b';
const UUID_C = '0f0f0f0f-0000-4000-8000-00000000000c';

/** Keyed by payload key; `SAMPLE_OVERRIDES` replaces a value for one entity type. */
export const SAMPLE: Readonly<Record<string, unknown>> = {
  // shared
  slug: 'sample-slug',
  name: BI('Sample name', 'اسم تجريبي'),
  title: BI('Sample title', 'عنوان تجريبي'),
  status: 'published',
  sortOrder: 7,
  scheduledFor: '2027-01-01T09:00:00.000Z',
  isPlaceholder: false,
  visible: true,
  posterMediaId: UUID_A,
  blurb: BI('A short line', 'سطر قصير'),
  body: {
    en: DOC('One paragraph of sample copy for the reading time.'),
    ar: DOC('فقرة واحدة من نص تجريبي.'),
  },
  clip: { path: '/media/sample-reel.mp4', startS: 2, endS: 6 },
  // services
  heroVideoUid: 'sample-uid',
  category: 'sample-category',
  shortTitle: BI('Short', 'قصير'),
  isTeaser: false,
  disciplineId: UUID_B,
  intro: BI('What it is', 'ما هو'),
  valuePoints: [{ title: BI('Point', 'نقطة'), body: BI('Why', 'لماذا') }],
  deliverables: [BI('A deliverable', 'مخرج')],
  // disciplines
  short: BI('Card line', 'سطر البطاقة'),
  // portfolio
  summary: BI('Summary', 'ملخص'),
  projectType: BI('Brand film', 'فيلم'),
  teaser: BI('Teaser', 'تشويق'),
  lead: BI('Lead', 'مقدمة'),
  goal: BI('Goal', 'هدف'),
  result: BI('Result', 'نتيجة'),
  scope: [BI('Scope item', 'بند')],
  keywords: ['sample'],
  results: [{ value: '12', label: BI('Label', 'تسمية') }],
  sectorId: UUID_B,
  clientId: UUID_C,
  year: 2026,
  isFeatured: true,
  preview: { path: '/media/sample-reel.mp4', startS: 1, endS: 4 },
  nextPortfolioId: UUID_C,
  serviceIds: [UUID_A, UUID_B],
  media: [{ role: 'gallery', kind: 'image', mediaId: UUID_A }],
  // service cases
  serviceId: UUID_A,
  portfolioId: UUID_B,
  context: BI('Where they were', 'أين كانوا'),
  problems: [{ title: BI('Problem', 'مشكلة') }],
  // testimonials
  quote: BI('A sample quote', 'اقتباس تجريبي'),
  authorName: BI('Sample Person', 'شخص تجريبي'),
  authorRole: BI('Director', 'مدير'),
  avatarMediaId: UUID_C,
  placements: ['home'],
  consentObtainedAt: '2026-01-02T03:04:05.000Z',
  consentReference: 'sample-ref',
  // blog
  excerpt: BI('Excerpt', 'مقتطف'),
  authorId: UUID_A,
  categoryId: UUID_B,
  coverImageUrl: 'https://images.example.test/cover.jpg',
  // pages, sections
  navVisible: false,
  pageId: UUID_A,
  type: 'richText',
  content: { heading: BI('Heading', 'عنوان') },
  // navigation
  location: 'header',
  parentId: UUID_C,
  label: BI('Services', 'الخدمات'),
  href: '/services',
  isKey: true,
  // team
  bio: BI('Bio', 'نبذة'),
  avatarUrl: 'https://images.example.test/a.jpg',
  profileUserId: UUID_C,
  role: BI('Designer', 'مصمم'),
  linkedinUrl: 'https://linkedin.com/in/sample',
  isLeadership: true,
  portraitMediaId: UUID_B,
  // statistics
  value: '12.5+',
  valueNumeric: 12.5,
  valueSuffix: '+',
  placementLabels: { home: BI('Projects', 'مشاريع') },
  // certifications
  issuer: BI('Issuer', 'جهة'),
  logoUrl: 'https://images.example.test/logo.png',
  // clients
  logoMediaId: UUID_A,
  websiteUrl: 'https://client.example.test',
  showInMarquee: true,
  // themes
  tokens: { '--bs-klein': '#0024BC' },
  isActive: true,
  // redirects
  sourcePath: '/old-page/',
  targetPath: '/new-page',
  // media (not release-managed; recorded so the off-path proof covers every config)
  kind: 'image',
  provider: 'external',
  storagePath: 'https://images.example.test/x.jpg',
  displayName: 'x.jpg',
  folder: 'samples',
  alt: BI('Alt', 'بديل'),
  tags: ['sample'],
  width: 640,
  height: 480,
  mimeType: 'image/jpeg',
  sizeBytes: 1024,
  streamUid: 'sample-stream',
  // AI style-finder (not release-managed)
  prompt: BI('Prompt', 'سؤال'),
  helpText: BI('Help', 'مساعدة'),
  inputType: 'single',
  options: [{ value: 'a', label: BI('A', 'أ') }],
  description: BI('Description', 'وصف'),
  traits: ['bold'],
  imageUrl: 'https://images.example.test/style.jpg',
  // singletons: site_profile
  brandName: BI('Sample Studio', 'استوديو تجريبي'),
  legalName: BI('Sample Studio LLC', 'استوديو تجريبي ذ.م.م'),
  contactEmail: 'hello@example.test',
  // the FAQ (Admin v2 U7)
  question: BI('A sample question?', 'سؤال تجريبي؟'),
  answer: BI('A sample answer.', 'إجابة تجريبية.'),
  whatsappE164: '+966500000000',
  whatsappDisplay: '050 000 0000',
  addressLocality: BI('Riyadh', 'الرياض'),
  addressCountry: 'SA',
  foundedYear: 2020,
  socials: [{ network: 'instagram', handle: '@sample', url: 'https://instagram.com/sample' }],
  acceptingApplications: true,
  // singletons: seo_defaults
  titleTemplate: BI('%s | Sample', '%s | تجريبي'),
  defaultTitle: BI('Sample', 'تجريبي'),
  defaultDescription: BI('Sample description', 'وصف تجريبي'),
  defaultOgImage: '/og/sample.jpg',
  organization: { name: 'Sample' },
  robotsDirectives: 'index,follow',
  // entity SEO
  entityType: 'service',
  entityId: UUID_A,
  metaTitle: BI('Meta title', 'عنوان'),
  metaDescription: BI('Meta description', 'وصف'),
  ogImage: '/og/service.jpg',
  canonicalOverride: 'https://example.test/services/sample',
  robots: 'index,follow',
  schemaType: 'Service',
};

/** Where one entity type needs its own value for a shared key. */
export const SAMPLE_OVERRIDES: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  // A redirect's `status` is its HTTP code, not a content status.
  redirect: { status: 301 },
  // A theme's name is plain text.
  custom_theme: { name: 'Sample theme' },
  // The public identity's location is bilingual text; a nav item's is its menu.
  site_profile: { location: BI('Riyadh, Saudi Arabia', 'الرياض، السعودية') },
};

/** The sample for one payload key of one entity type. */
export function sampleOf(entity: string, key: string): unknown {
  const own = SAMPLE_OVERRIDES[entity];
  if (own && key in own) return own[key];
  if (!(key in SAMPLE)) throw new Error(`no sample for ${entity}.${key}`);
  return SAMPLE[key];
}

/** Every sample, with one entity type's overrides applied. */
export function samplesFor(entity: string): Record<string, unknown> {
  return { ...SAMPLE, ...(SAMPLE_OVERRIDES[entity] ?? {}) };
}

/** A frozen clock for `publishStamp` (the published_at a save stamps). */
export const SAMPLE_NOW = new Date('2026-06-01T08:00:00.000Z');
