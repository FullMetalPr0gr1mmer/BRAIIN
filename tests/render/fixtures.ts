import type { StatisticRow, TeamMemberRow, CertificationRow } from '@schemas/content';
import type { Discipline } from '@/lib/data/disciplines';
import type { PortfolioCard } from '@/lib/data/portfolio';
import type { MarqueeClient, Testimonial } from '@/lib/data/taxonomy';
import type { Leader } from '@/lib/data/team';
import { IDENTITY_FALLBACK, type Identity } from '@/lib/identity/fallback';
import type { ImageRef } from '@/lib/media/resolve';
import { staticImage } from '@/lib/media/static';

// Rows for tests/render/sections.spec.ts: every data-driven band renders something, so the
// copy around the data is in the golden output too. Invented, never production content.

const still = staticImage('stills/project/g01.jpg');
if (!still) throw new Error('fixture still missing: stills/project/g01.jpg');

export const POSTER: ImageRef = {
  id: '00000000-0000-4000-8000-0000000000a1',
  src: still,
  width: still.width,
  height: still.height,
  alt: { en: 'A still from the fixture project', ar: 'لقطة من المشروع التجريبي' },
};

/** The fallback identity with a WhatsApp number, so the channel card renders too. */
export const IDENTITY: Identity = {
  ...IDENTITY_FALLBACK,
  whatsappE164: '+966500000000',
  whatsappDisplay: '+966 50 000 0000',
};

const svc = (slug: string, en: string, ar: string, order: number) => ({
  id: `00000000-0000-4000-8000-0000000001${String(order).padStart(2, '0')}`,
  slug,
  title: { en, ar },
  label: { en, ar },
  tagline: null,
  intro: null,
  disciplineId: null,
  sortOrder: order,
  updatedAt: null,
  poster: null,
  clip: null,
});

export const DISCIPLINES: Discipline[] = [
  {
    id: '00000000-0000-4000-8000-000000000201',
    slug: 'branding',
    name: { en: 'Branding', ar: 'الهوية البصرية' },
    short: { en: 'The mark and the system.', ar: 'الشعار والنظام.' },
    blurb: { en: 'Identity work, end to end.', ar: 'هوية من البداية للنهاية.' },
    sortOrder: 1,
    updatedAt: null,
    poster: null,
    clip: null,
    services: [
      svc('logo', 'Logo Design', 'تصميم الشعار', 1),
      svc('packaging', 'Packaging', 'التغليف', 2),
    ],
  },
  {
    id: '00000000-0000-4000-8000-000000000202',
    slug: 'production',
    name: { en: 'Production', ar: 'الإنتاج' },
    short: { en: 'Film and sound.', ar: 'فيديو وصوت.' },
    blurb: null,
    sortOrder: 2,
    updatedAt: null,
    poster: null,
    clip: null,
    services: [svc('animation', 'Animation', 'الرسوم المتحركة', 3)],
  },
];

const facet = (slug: string, en: string, ar: string, order = 1) => ({
  slug,
  name: { en, ar },
  order,
});

export const CARDS: PortfolioCard[] = [
  {
    id: '00000000-0000-4000-8000-000000000301',
    slug: 'the-rider',
    title: { en: 'The Rider', ar: 'الفارس' },
    projectType: { en: 'Brand film', ar: 'فيلم علامة' },
    blurb: { en: 'A launch film.', ar: 'فيلم إطلاق.' },
    year: 2025,
    isFeatured: true,
    sortOrder: 1,
    updatedAt: null,
    poster: POSTER,
    preview: null,
    sector: facet('retail', 'Retail', 'التجزئة'),
    client: facet('acme', 'Acme', 'أكمي'),
    confidentialClient: false,
    services: [
      {
        slug: 'animation',
        title: { en: 'Animation', ar: 'الرسوم المتحركة' },
        label: { en: 'Animation', ar: 'الرسوم المتحركة' },
        order: 1,
      },
    ],
  },
  {
    id: '00000000-0000-4000-8000-000000000302',
    slug: 'quiet-mark',
    title: { en: 'Quiet Mark', ar: 'علامة هادئة' },
    projectType: null,
    blurb: null,
    year: 2024,
    isFeatured: true,
    sortOrder: 2,
    updatedAt: null,
    poster: null,
    preview: null,
    sector: null,
    client: null,
    confidentialClient: true,
    services: [],
  },
  {
    id: '00000000-0000-4000-8000-000000000303',
    slug: 'third-light',
    title: { en: 'Third Light', ar: 'الضوء الثالث' },
    projectType: { en: 'Identity', ar: 'هوية' },
    blurb: { en: 'A new mark.', ar: 'شعار جديد.' },
    year: 2023,
    isFeatured: true,
    sortOrder: 3,
    updatedAt: null,
    poster: null,
    preview: null,
    sector: facet('food', 'Food', 'الأغذية', 2),
    client: null,
    confidentialClient: false,
    services: [],
  },
];

export const TESTIMONIALS: Testimonial[] = [
  {
    slug: 'quote-one',
    quote: { en: 'They listened first.', ar: 'سمعونا أول.' },
    authorName: { en: 'Sam Example', ar: 'سام مثال' },
    authorRole: { en: 'Head of Brand, Acme', ar: 'رئيس العلامة، أكمي' },
    avatar: null,
  },
  {
    slug: 'quote-two',
    quote: { en: 'On time, every time.', ar: 'في الموعد كل مرة.' },
    authorName: { en: 'Lee Sample', ar: 'لي عينة' },
    authorRole: null,
    avatar: null,
  },
];

const stat = (
  slug: string,
  value: string,
  numeric: number | null,
  suffix: string | null,
  en: string,
  ar: string,
  order: number,
): StatisticRow => ({
  slug,
  label: { en, ar },
  value,
  sort_order: order,
  value_numeric: numeric,
  value_suffix: suffix,
  placements: ['home', 'about', 'work', 'services'],
  placement_labels: {},
});

export const STATS: StatisticRow[] = [
  stat('projects', '250+', 250, '+', 'Projects delivered', 'مشروع منجز', 1),
  stat('clients', '80', 80, null, 'Clients', 'عميل', 2),
  stat('years', 'TBD', null, null, 'Years', 'سنوات', 3),
];

export const CLIENTS: MarqueeClient[] = [
  { slug: 'acme', name: { en: 'Acme', ar: 'أكمي' }, logo: null, websiteUrl: null },
  { slug: 'globex', name: { en: 'Globex', ar: 'جلوبكس' }, logo: null, websiteUrl: null },
];

export const LEADERS: Leader[] = [
  {
    slug: 'first-leader',
    name: { en: 'First Leader', ar: 'القائد الأول' },
    role: { en: 'Founder', ar: 'المؤسس' },
    linkedinUrl: 'https://www.linkedin.com/in/first-leader',
    portrait: null,
    isPlaceholder: false,
  },
  {
    slug: 'second-leader',
    name: { en: 'Second Leader', ar: 'القائد الثاني' },
    role: null,
    linkedinUrl: null,
    portrait: null,
    isPlaceholder: false,
  },
];

export const TEAM: TeamMemberRow[] = [
  {
    slug: 'first-leader',
    name: { en: 'First Leader', ar: 'القائد الأول' },
    bio: { en: 'Leads the studio.', ar: 'يقود الاستوديو.' },
    avatar_url: null,
    sort_order: 1,
    role: { en: 'Founder', ar: 'المؤسس' },
    linkedin_url: null,
    is_leadership: true,
    is_placeholder: false,
    portrait: null,
  },
];

export const CERTIFICATIONS: CertificationRow[] = [
  {
    slug: 'iso-sample',
    name: { en: 'Sample Certification', ar: 'شهادة تجريبية' },
    issuer: { en: 'Sample Body', ar: 'جهة تجريبية' },
    year: 2024,
    logo_url: null,
    sort_order: 1,
  },
];
