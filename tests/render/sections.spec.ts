import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { beforeAll, describe, expect, test, vi } from 'vitest';
import type { Locale } from '@schemas/primitives';
import SectionRenderer from '@/components/SectionRenderer.astro';
import Hello from '@/components/sections/Hello.astro';
import {
  DEFAULT_ABOUT_SECTIONS,
  DEFAULT_CATALOG_SECTIONS,
  DEFAULT_CONTACT_SECTIONS,
  DEFAULT_HOME_SECTIONS,
  DEFAULT_WORK_SECTIONS,
  ensureContactInquiry,
  homeHeroCtaHref,
  withHeroPreset,
  withHomeData,
  withHomeIntro,
  workIntroLinkHref,
  type SectionData,
} from '@/lib/sections/types';
import { withLeaders } from '@/lib/sections/about';
import { withContactData } from '@/lib/sections/contact';
import { composeJoinPage } from '@/lib/sections/join';
import { SERVICE_HELLO_LEAD, serviceHelloHeading } from '@/lib/sections/hello';
import { composeServicesPage } from '@/lib/services/servicesPage';
import {
  CARDS,
  CERTIFICATIONS,
  DISCIPLINES,
  IDENTITY,
  LEADERS,
  STATS,
  TEAM,
  TESTIMONIALS,
} from './fixtures';

// The public sections, rendered to the byte (Admin v2 F6). Every case renders through
// SectionRenderer — the path a page takes — in both languages, and the output is held to a
// snapshot. The snapshot was written by the components as they stood BEFORE F6 moved
// their built-in copy into src/lib/sections/copy/, so this file is the proof that the move
// changed no served byte; after F6 it is the tripwire for any later change to a section's
// markup or copy (an intended change updates the snapshot in the same commit, `-u`).
//
// The cases are the pages' default compositions as their routes compose them (the
// built-in copy), then one case per section type with every content field authored (the
// override path), then the variants and route data the pages do not reach. Data the
// sections load themselves comes from tests/render/fixtures.ts.

vi.mock('@/lib/data/disciplines', async (importOriginal) => {
  const f = await import('./fixtures');
  return {
    ...(await importOriginal<object>()),
    getPublishedDisciplines: async () => f.DISCIPLINES,
  };
});
vi.mock('@/lib/data/portfolio', async (importOriginal) => {
  const f = await import('./fixtures');
  return {
    ...(await importOriginal<object>()),
    getPortfolioCards: async (opts: { featuredOnly?: boolean } = {}) =>
      opts.featuredOnly ? f.CARDS.filter((c) => c.isFeatured) : f.CARDS,
  };
});
vi.mock('@/lib/data/taxonomy', async (importOriginal) => {
  const f = await import('./fixtures');
  return {
    ...(await importOriginal<object>()),
    getMarqueeClients: async () => f.CLIENTS,
    getTestimonials: async (opts: { limit?: number } = {}) =>
      f.TESTIMONIALS.slice(0, opts.limit ?? 8),
  };
});
vi.mock('@/lib/data/statistics', async (importOriginal) => {
  const f = await import('./fixtures');
  return {
    ...(await importOriginal<object>()),
    getPublishedStatistics: async () => f.STATS,
  };
});
vi.mock('@/lib/data/team', async (importOriginal) => {
  const f = await import('./fixtures');
  return {
    ...(await importOriginal<object>()),
    getPublishedTeam: async () => f.TEAM,
    getLeadership: async () => f.LEADERS,
  };
});
vi.mock('@/lib/data/certifications', async (importOriginal) => {
  const f = await import('./fixtures');
  return {
    ...(await importOriginal<object>()),
    getPublishedCertifications: async () => f.CERTIFICATIONS,
  };
});
vi.mock('@/lib/data/sectionMedia', async (importOriginal) => {
  const f = await import('./fixtures');
  return {
    ...(await importOriginal<object>()),
    getSectionImage: async (id: string | undefined) => (id === f.POSTER.id ? f.POSTER : null),
    getSectionImages: async (ids: readonly string[]) =>
      new Map(ids.filter((id) => id === f.POSTER.id).map((id) => [id, f.POSTER])),
  };
});

const LOCALES: readonly Locale[] = ['en', 'ar'];

let container: AstroContainer;
beforeAll(async () => {
  container = await AstroContainer.create();
});

// The checkout's own path reaches the output through dev-mode URLs: image sources
// (`/@fs/<root>/…`, URL-encoded inside `/_image?href=`) and component scripts. It is the one
// thing that differs between machines, and between Windows (`/@fs/C:/…`) and Linux
// (`/@fs/home/…`), so it is replaced before the comparison.
const ROOT = process.cwd().replace(/\\/g, '/').replace(/\/$/, '');
const FS = `/@fs/${ROOT.replace(/^\//, '')}`;
const SWAPS: readonly (readonly [string, string])[] = [
  [encodeURIComponent(FS), `${encodeURIComponent('/@fs/')}<root>`],
  [FS, '/@fs/<root>'],
  [ROOT, '<root>'],
];
const normalise = (html: string): string =>
  SWAPS.reduce((out, [from, to]) => out.split(from).join(to), html);

const renderSections = async (sections: SectionData[], locale: Locale): Promise<string> => {
  const html = await container.renderToString(SectionRenderer, {
    props: { locale, sections },
    locals: { identity: Promise.resolve(IDENTITY) } as App.Locals,
  });
  // SectionBoundary swallows a failing section into an empty placeholder: a snapshot of
  // that would hold a broken render as the truth.
  expect(html).not.toContain('section-error');
  return normalise(html);
};

const t = (en: string, ar: string) => ({ en, ar });
const featured = CARDS.filter((c) => c.isFeatured);

/** The pages' default compositions, composed as their routes compose them. */
const PAGES: Record<string, SectionData[]> = {
  home: withHomeData(withHomeIntro(DEFAULT_HOME_SECTIONS), {
    featured,
    ctaHref: homeHeroCtaHref(DEFAULT_HOME_SECTIONS, featured.length),
    disciplines: DISCIPLINES,
  }),
  about: withLeaders(DEFAULT_ABOUT_SECTIONS, LEADERS),
  contact: withContactData(
    ensureContactInquiry(withHeroPreset(DEFAULT_CONTACT_SECTIONS, 'contact')),
    { groups: DISCIPLINES },
  ),
  services: composeServicesPage([], DISCIPLINES),
  join: composeJoinPage([], null),
  work: DEFAULT_WORK_SECTIONS.map((s) =>
    s.type === 'workHero'
      ? { ...s, data: { cards: CARDS } }
      : s.type === 'workIntro'
        ? {
            ...s,
            data: {
              linkHref: workIntroLinkHref(DEFAULT_WORK_SECTIONS, featured.length, CARDS.length),
            },
          }
        : s.type === 'projectGrid'
          ? { ...s, data: { cards: CARDS, selection: {} } }
          : s,
  ),
  catalog: DEFAULT_CATALOG_SECTIONS.map((s) =>
    s.type === 'pageHead'
      ? { ...s, data: { count: CARDS.length } }
      : s.type === 'projectCatalog'
        ? { ...s, data: { cards: CARDS, selection: {} } }
        : s,
  ),
};

/** Every content field authored — the override path of each section type. */
const AUTHORED: Record<string, SectionData[]> = {
  hero: [
    {
      type: 'hero',
      props: {
        headline: t('Authored hero headline here', 'عنوان رئيسي مكتوب هنا'),
        accentFromEn: 2,
        accentFromAr: 1,
        sub: t('An authored sub line.', 'سطر فرعي مكتوب.'),
        ctaLabel: t('Authored CTA', 'زر مكتوب'),
      },
    },
  ],
  servicesOverview: [
    {
      type: 'servicesOverview',
      props: {
        tag: t('Authored tag', 'وسم مكتوب'),
        heading: t('Authored discipline heading', 'عنوان التخصصات المكتوب'),
        accent: { en: { from: 1 }, ar: { from: 1 } },
        sub: t('Authored sub.', 'فرعي مكتوب.'),
        hint: t('Authored hint', 'تلميح مكتوب'),
        allLabel: t('Authored all', 'الكل مكتوب'),
      },
      data: { mode: 'home', disciplines: DISCIPLINES },
    },
  ],
  cta: [
    {
      type: 'cta',
      props: {
        tag: t('Authored tag', 'وسم مكتوب'),
        heading: t('Authored lead heading', 'عنوان مكتوب للطلب'),
        accent: { en: { from: 1 }, ar: { from: 1 } },
        text: t('Authored text.', 'نص مكتوب.'),
        buttonLabel: t('Authored button', 'زر مكتوب'),
        buttonHref: '/services',
      },
    },
  ],
  social: [
    {
      type: 'social',
      props: {
        variant: 'klein',
        tag: t('Authored tag', 'وسم مكتوب'),
        heading: t('Authored social heading', 'عنوان اجتماعي مكتوب'),
        accent: { en: { from: 1 }, ar: { from: 1 } },
        text: t('Authored line.', 'سطر مكتوب.'),
        links: [{ label: 'Instagram', user: '@sample', href: 'https://instagram.com/sample' }],
      },
    },
  ],
  aboutStory: [
    {
      type: 'aboutStory',
      props: {
        heading: t('About %brand% authored', 'عن %brand% مكتوب'),
        lead: t('Authored lead.', 'مقدمة مكتوبة.'),
        missionTitle: t('Authored mission title', 'عنوان الرسالة المكتوب'),
        mission: t('Authored mission.', 'رسالة مكتوبة.'),
        visionTitle: t('Authored vision title', 'عنوان الرؤية المكتوب'),
        vision: t('Authored vision.', 'رؤية مكتوبة.'),
      },
    },
  ],
  statistics: [
    {
      type: 'statistics',
      props: {
        variant: 'band',
        placement: 'home',
        tag: t('Authored tag', 'وسم مكتوب'),
        heading: t('Authored numbers heading', 'عنوان الأرقام المكتوب'),
        accent: { en: { from: 1 }, ar: { from: 1 } },
        text: t('Authored text.', 'نص مكتوب.'),
      },
    },
  ],
  clientsMarquee: [
    {
      type: 'clientsMarquee',
      props: {
        tag: t('Authored tag', 'وسم مكتوب'),
        heading: t('Authored clients heading.', 'عنوان العملاء المكتوب.'),
        note: t('Authored note', 'ملاحظة مكتوبة'),
      },
    },
  ],
  aboutIntro: [
    {
      type: 'aboutIntro',
      props: {
        tag: t('Authored tag', 'وسم مكتوب'),
        heading: t('Authored heading', 'عنوان مكتوب'),
        lead: t('Authored lead.', 'مقدمة مكتوبة.'),
        columns: [{ title: t('Column', 'عمود'), body: t('Column body.', 'نص العمود.') }],
      },
    },
  ],
  slogan: [
    {
      type: 'slogan',
      props: {
        text: t('An authored slogan line here.', 'شعار مكتوب هنا.'),
        accentFromEn: 1,
        accentFromAr: 1,
      },
    },
  ],
  contact: [
    {
      type: 'contact',
      props: { heading: t('Authored pre', 'قبل مكتوب'), accent: t('authored accent', 'لكنة') },
      data: { groups: DISCIPLINES },
    },
  ],
  contactInquiry: [
    {
      type: 'contactInquiry',
      props: {
        tag: t('Authored tag', 'وسم مكتوب'),
        heading: t('Authored inquiry heading', 'عنوان الطلب المكتوب'),
        accent: { en: { from: 1 }, ar: { from: 1 } },
        lead: t('Authored lead.', 'مقدمة مكتوبة.'),
        note: t('Authored note.', 'ملاحظة مكتوبة.'),
        successMessage: t('Authored success.', 'نجاح مكتوب.'),
        submitLabel: t('Authored submit', 'إرسال مكتوب'),
      },
      data: { groups: DISCIPLINES },
    },
  ],
  contactChannels: [
    {
      type: 'contactChannels',
      props: {
        tag: t('Authored tag', 'وسم مكتوب'),
        heading: t('Authored channels heading', 'عنوان القنوات المكتوب'),
        accent: { en: { from: 1 }, ar: { from: 1 } },
        lead: t('Authored lead.', 'مقدمة مكتوبة.'),
        emailLabel: t('Authored email', 'بريد مكتوب'),
        emailNote: t('Authored email note.', 'ملاحظة البريد.'),
        whatsappLabel: t('Authored WhatsApp', 'واتساب مكتوب'),
        whatsappNote: t('Authored WhatsApp note.', 'ملاحظة واتساب.'),
      },
    },
  ],
  faq: [
    {
      type: 'faq',
      props: {
        tag: t('Authored tag', 'وسم مكتوب'),
        heading: t('Authored FAQ heading', 'عنوان الأسئلة المكتوب'),
        accent: { en: { from: 1 }, ar: { from: 1 } },
      },
    },
  ],
  selectedWork: [
    {
      type: 'selectedWork',
      props: {
        tag: t('Authored tag', 'وسم مكتوب'),
        heading: t('Authored work heading.', 'عنوان الأعمال المكتوب.'),
        accent: { en: { from: 1 }, ar: { from: 1 } },
        lines: [
          { text: t('Line one.', 'السطر الأول.') },
          { text: t('Line two.', 'السطر الثاني.') },
        ],
        featuredSlug: 'third-light',
        featuredLinkLabel: t('Authored link', 'رابط مكتوب'),
        button: { label: t('Authored button', 'زر مكتوب'), href: '/portfolio/all' },
      },
      data: { cards: featured },
    },
  ],
  testimonials: [
    {
      type: 'testimonials',
      props: {
        variant: 'light',
        placement: 'work',
        tag: t('Authored tag', 'وسم مكتوب'),
        heading: t('Authored quotes heading', 'عنوان الآراء المكتوب'),
        accent: { en: { from: 1 }, ar: { from: 1 } },
        intervalMs: 9000,
        limit: 2,
      },
    },
  ],
  aboutWho: [
    {
      type: 'aboutWho',
      props: {
        tag: t('Authored tag', 'وسم مكتوب'),
        heading: t('Authored who heading here', 'عنوان من نحن المكتوب'),
        accent: { en: { from: 1 }, ar: { from: 1 } },
        lead: t('Authored lead.', 'مقدمة مكتوبة.'),
        paragraphs: [{ title: t('Title.', 'عنوان.'), body: t('Body.', 'نص.') }],
      },
    },
  ],
  leadership: [
    {
      type: 'leadership',
      props: {
        tag: t('Authored tag', 'وسم مكتوب'),
        heading: t('Authored leaders heading', 'عنوان القادة المكتوب'),
        accent: { en: { from: 1 }, ar: { from: 1 } },
        text: t('Authored text.', 'نص مكتوب.'),
      },
      data: { leaders: LEADERS },
    },
  ],
  workHero: [{ type: 'workHero', props: { tag: t('Authored tag', 'وسم مكتوب') } }],
  proof: [
    {
      type: 'proof',
      props: {
        statsTag: t('Authored stats tag', 'وسم الأرقام المكتوب'),
        quotesTag: t('Authored quotes tag', 'وسم الآراء المكتوب'),
        quotesHeading: t('Authored quotes heading', 'عنوان الآراء المكتوب'),
        quotesAccent: { en: { from: 1 }, ar: { from: 1 } },
        quotesLimit: 1,
        staticNumbers: true,
        minItems: 2,
      },
    },
  ],
  workIntro: [
    {
      type: 'workIntro',
      props: {
        text: t('An authored intro statement.', 'جملة تمهيدية مكتوبة.'),
        linkLabel: t('Authored link', 'رابط مكتوب'),
        media: [{ mediaId: '00000000-0000-4000-8000-0000000000a1' }],
      },
      data: { linkHref: '/portfolio/all' },
    },
  ],
  projectGrid: [
    {
      type: 'projectGrid',
      props: { tag: t('Authored tag', 'وسم مكتوب'), heading: t('Authored grid', 'شبكة مكتوبة') },
      data: { cards: CARDS, selection: { sector: 'retail' } },
    },
  ],
  pageHead: [
    {
      type: 'pageHead',
      props: {
        heading: t('Authored page head', 'رأس صفحة مكتوب'),
        accent: { en: { from: 1 }, ar: { from: 1 } },
        lead: t('Authored lead.', 'مقدمة مكتوبة.'),
        backLabel: t('Authored back', 'رجوع مكتوب'),
        backHref: '/services',
      },
    },
  ],
  hello: [
    {
      type: 'hello',
      props: {
        tag: t('Authored tag', 'وسم مكتوب'),
        heading: t('Authored hello heading', 'عنوان الترحيب المكتوب'),
        accent: { en: { from: 1 }, ar: { from: 1 } },
        lead: t('Authored lead.', 'مقدمة مكتوبة.'),
        points: [{ text: t('Point one', 'النقطة الأولى') }],
      },
      data: { groups: DISCIPLINES },
    },
  ],
  serviceExplorer: [
    {
      type: 'serviceExplorer',
      props: {
        inquireLabel: t('Ask', 'اسأل'),
        startLabel: t('Begin {discipline} work', 'ابدأ عمل {discipline}'),
      },
      data: { disciplines: DISCIPLINES, inquiryHref: '/contact#inquiry', standalone: true },
    },
  ],
  joinWhy: [
    {
      type: 'joinWhy',
      props: {
        tag: t('Authored %brand% tag', 'وسم %brand% مكتوب'),
        heading: t('Authored why heading', 'عنوان لماذا المكتوب'),
        accent: { en: { from: 1 }, ar: { from: 1 } },
        lead: t('Authored lead.', 'مقدمة مكتوبة.'),
        items: [{ heading: t('Reason', 'سبب'), text: t('Reason text.', 'نص السبب.') }],
      },
    },
  ],
  joinSteps: [
    {
      type: 'joinSteps',
      props: {
        tag: t('Authored tag', 'وسم مكتوب'),
        heading: t('Authored steps heading', 'عنوان الخطوات المكتوب'),
        accent: { en: { from: 1 }, ar: { from: 1 } },
        lead: t('Authored lead.', 'مقدمة مكتوبة.'),
        items: [
          {
            heading: t('Step', 'خطوة'),
            text: t('Step text.', 'نص الخطوة.'),
            time: t('Now', 'الآن'),
          },
        ],
      },
    },
  ],
  joinApply: [
    {
      type: 'joinApply',
      props: {
        tag: t('Authored tag', 'وسم مكتوب'),
        heading: t('Authored apply heading', 'عنوان التقديم المكتوب'),
        accent: { en: { from: 1 }, ar: { from: 1 } },
        lead: t('Authored lead.', 'مقدمة مكتوبة.'),
        groupAbout: t('About', 'عنك'),
        groupRole: t('Role', 'الدور'),
        groupWork: t('Work', 'العمل'),
        note: t('Authored note.', 'ملاحظة مكتوبة.'),
        successMessage: t('Authored success.', 'نجاح مكتوب.'),
      },
      data: { answer: 'ok' },
    },
  ],
};

/** Built-in copy the default compositions do not reach: other variants, modes, route data. */
const VARIANTS: Record<string, SectionData[]> = {
  'hero service page': [
    {
      type: 'hero',
      props: { headline: t('Logo Design', 'تصميم الشعار') },
      data: {
        banner: true,
        ctaHref: '#case',
        clip: { start: 1, end: 2 },
        noSub: true,
        crumb: {
          items: [
            { label: t('Services', 'الخدمات'), href: '/services' },
            { label: 'Branding', href: '/services#branding' },
          ],
        },
        skipLink: {
          kicker: t('Been here before?', 'زرتنا قبل؟'),
          label: t('Skip to the inquiry', 'انتقل للطلب مباشرة'),
          href: '#inquiry',
        },
      },
    },
  ],
  'hero built-in, no intro': [{ type: 'hero' }],
  'servicesOverview fallback cards': [
    { type: 'servicesOverview', data: { mode: 'page', disciplines: [] } },
  ],
  'social paper, authored heading without accent': [
    { type: 'social', props: { heading: t('Authored paper heading', 'عنوان ورقي مكتوب') } },
  ],
  'statistics cards': [
    { type: 'statistics' },
    { type: 'statistics', props: { heading: t('Authored cards', 'بطاقات مكتوبة') } },
  ],
  'statistics reach, authored': [
    {
      type: 'statistics',
      props: {
        variant: 'reach',
        placement: 'about',
        tag: t('Authored tag', 'وسم مكتوب'),
        heading: t('Authored reach heading', 'عنوان النطاق المكتوب'),
        text: t('Authored text.', 'نص مكتوب.'),
      },
    },
  ],
  'statistics proof': [
    { type: 'statistics', props: { variant: 'proof', placement: 'work' } },
    {
      type: 'statistics',
      props: { variant: 'proof', placement: 'work', tag: t('Authored tag', 'وسم مكتوب') },
    },
  ],
  'statistics services, authored': [
    {
      type: 'statistics',
      props: {
        variant: 'services',
        placement: 'services',
        line: t('An authored statement line.', 'جملة مكتوبة هنا.'),
        lineAccent: { en: { from: 1 }, ar: { from: 1 } },
        rating: { value: '4.0 / 5', label: t('sample rating', 'تقييم تجريبي') },
        staticNumbers: true,
        minItems: 1,
      },
    },
  ],
  'team and certifications': [
    { type: 'team', props: { members: TEAM } },
    { type: 'team', props: { members: [] } },
    { type: 'certifications', props: { items: CERTIFICATIONS } },
  ],
  'aboutStory and aboutIntro built-in': [{ type: 'aboutStory' }, { type: 'aboutIntro' }],
  'testimonials klein built-in': [{ type: 'testimonials', data: { items: TESTIMONIALS } }],
  'statistics band built-in': [
    { type: 'statistics', props: { variant: 'band', placement: 'home' }, data: { items: STATS } },
  ],
  'workIntro without a link': [{ type: 'workIntro', data: { linkHref: null } }],
  'pageHead built-in without a count': [{ type: 'pageHead' }],
  'serviceExplorer fallback panels': [{ type: 'serviceExplorer', data: { disciplines: [] } }],
  'join with an answer': composeJoinPage([], 'closed'),
};

describe('pages, as their routes compose them', () => {
  for (const [name, sections] of Object.entries(PAGES)) {
    for (const locale of LOCALES) {
      test(`${name} (${locale})`, async () => {
        expect(await renderSections(sections, locale)).toMatchSnapshot();
      });
    }
  }
});

describe('every content field authored', () => {
  for (const [name, sections] of Object.entries(AUTHORED)) {
    for (const locale of LOCALES) {
      test(`${name} (${locale})`, async () => {
        expect(await renderSections(sections, locale)).toMatchSnapshot();
      });
    }
  }
});

describe('variants, modes and route data', () => {
  for (const [name, sections] of Object.entries(VARIANTS)) {
    for (const locale of LOCALES) {
      test(`${name} (${locale})`, async () => {
        expect(await renderSections(sections, locale)).toMatchSnapshot();
      });
    }
  }
});

describe('Hello rendered directly, as a service page does', () => {
  for (const locale of LOCALES) {
    test(`service page (${locale})`, async () => {
      const html = await container.renderToString(Hello, {
        props: {
          locale,
          groups: DISCIPLINES,
          selected: 'logo',
          headingOverride: serviceHelloHeading(
            locale === 'ar' ? 'تصميم الشعار' : 'Logo Design',
            locale,
          ),
          leadOverride: SERVICE_HELLO_LEAD[locale],
        },
        locals: { identity: Promise.resolve(IDENTITY) } as App.Locals,
      });
      expect(normalise(html)).toMatchSnapshot();
    });
  }
});
