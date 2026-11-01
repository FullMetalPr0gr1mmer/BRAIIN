import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { SECTION_CONTENT_SCHEMAS } from '@schemas/sections';
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
import { RENDERED_SECTION_TYPES } from '@/lib/sections/registry';
import { withContactData } from '@/lib/sections/contact';
import { composeJoinPage } from '@/lib/sections/join';
import { serviceHelloHeading } from '@/lib/sections/hello';
import { SERVICE_PAGE_COPY } from '@/lib/services/pageCopy';
import { composeServicesPage } from '@/lib/services/servicesPage';
import {
  CARDS,
  CERTIFICATIONS,
  DISCIPLINES,
  FAQ,
  LEADERS,
  POSTER,
  STATS,
  TEAM,
  TESTIMONIALS,
} from './fixtures';
import { LOCALES, renderComponent, renderSections } from './harness';
import type { Locale } from '@schemas/primitives';

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
// sections load themselves comes from tests/render/fixtures.ts (tests/render/setup.ts).

const t = (en: string, ar: string) => ({ en, ar });
const featured = CARDS.filter((c) => c.isFeatured);

/**
 * The FAQ is route data in the reader's language (Admin v2 U7: the contact route reads it
 * once, getFaq(locale)). A case names it with this marker, and `inLocale` swaps in the
 * seeded questions of the language being rendered.
 */
const SEEDED_FAQ: readonly never[] = Object.freeze([]);
const inLocale = (sections: SectionData[], locale: Locale): SectionData[] =>
  sections.map((s) =>
    s.data?.['items'] === SEEDED_FAQ ? { ...s, data: { ...s.data, items: FAQ[locale] } } : s,
  );

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
    { groups: DISCIPLINES, faq: SEEDED_FAQ },
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
  // Added after F6 (its own snapshot keys): the Stream loop's UID (no static source then)
  // and the intro plate.
  'hero, a Stream loop and the intro plate': [
    { type: 'hero', props: { videoUid: '0123456789abcdef0123456789abcdef', intro: true } },
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
      data: { items: SEEDED_FAQ },
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
  // Added after F6: the two cards chosen, in the order given.
  'selectedWork, chosen cards': [
    {
      type: 'selectedWork',
      props: { cardSlugs: ['third-light', 'quiet-mark'] },
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
  // Added after F6: About's production branch, the poster (the page's LCP image) in its
  // media frame, with a window of the reel.
  'aboutWho, a poster and a clip': [
    {
      type: 'aboutWho',
      props: { mediaId: POSTER.id, clip: { path: '/media/showreel.mp4', startS: 2, endS: 5 } },
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
  // Added after F6: a pinned project, not the latest (every card given a poster, so the
  // pin is what picks it).
  'workHero, a pinned project': [
    {
      type: 'workHero',
      props: { projectSlug: 'third-light' },
      data: { cards: CARDS.map((c) => ({ ...c, poster: POSTER })) },
    },
  ],
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
  // Admin v2 E10: the three blocks, every field authored. The body is rendered from its
  // Tiptap JSON by the allowlist renderer; the gallery's last id resolves to no picture.
  textBlock: [
    {
      type: 'textBlock',
      props: {
        tag: t('Authored tag', 'وسم مكتوب'),
        heading: t('Authored text block', 'نص مكتوب هنا'),
        accent: { en: { from: 1 }, ar: { from: 1 } },
        body: {
          en: {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [
                  { type: 'text', text: 'A paragraph with ' },
                  { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
                  { type: 'text', text: ' and ' },
                  {
                    type: 'text',
                    text: 'a link',
                    marks: [{ type: 'link', attrs: { href: '/contact#inquiry' } }],
                  },
                  { type: 'text', text: '.' },
                ],
              },
              { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'More' }] },
              {
                type: 'bulletList',
                content: [
                  {
                    type: 'listItem',
                    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'One' }] }],
                  },
                ],
              },
            ],
          },
          ar: {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [
                  { type: 'text', text: 'فقرة فيها ' },
                  { type: 'text', text: 'خط عريض', marks: [{ type: 'bold' }] },
                  { type: 'text', text: ' ١٢٣.' },
                ],
              },
            ],
          },
        },
      },
    },
  ],
  gallery: [
    {
      type: 'gallery',
      props: {
        tag: t('Authored tag', 'وسم مكتوب'),
        heading: t('Authored gallery', 'معرض مكتوب'),
        accent: { en: { from: 1 }, ar: { from: 1 } },
        items: [
          { kind: 'image', mediaId: POSTER.id },
          { kind: 'image', mediaId: POSTER.id },
          { kind: 'image', mediaId: POSTER.id },
          { kind: 'image', mediaId: '00000000-0000-4000-8000-0000000000ff' },
        ],
      },
    },
  ],
  video: [
    {
      type: 'video',
      props: {
        tag: t('Authored tag', 'وسم مكتوب'),
        heading: t('Authored video', 'فيديو مكتوب'),
        accent: { en: { from: 1 }, ar: { from: 1 } },
        lead: t('Authored lead.', 'مقدمة مكتوبة.'),
        mediaId: POSTER.id,
        clip: { path: '/media/showreel.mp4', startS: 14, endS: 15.4 },
      },
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
  // Admin v2 U7: no published question (or a failed read, or a route that does not load
  // the FAQ) renders no band at all; the route omits the FAQPage with it (faqShown).
  'faq with no questions': [{ type: 'faq', data: { items: [] } }],
  'faq on a route that loads none': [{ type: 'faq' }],
  // Admin v2 E10: a block with nothing to show renders nothing; two pictures are halves, one is
  // the full width; a video with only its still and a Stream clip is the still alone.
  'blocks with nothing to show': [
    { type: 'textBlock' },
    { type: 'gallery' },
    { type: 'gallery', props: { items: [{ mediaId: '00000000-0000-4000-8000-0000000000ff' }] } },
    { type: 'video' },
    { type: 'video', props: { clip: { path: '/media/showreel.mp4' } } },
  ],
  'gallery of two, gallery of one': [
    { type: 'gallery', props: { items: [{ mediaId: POSTER.id }, { mediaId: POSTER.id }] } },
    { type: 'gallery', props: { items: [{ mediaId: POSTER.id }] } },
  ],
  'video still only, and a Stream clip': [
    { type: 'video', props: { mediaId: POSTER.id } },
    {
      type: 'video',
      props: { mediaId: POSTER.id, clip: { streamUid: '0123456789abcdef0123456789abcdef' } },
    },
  ],
};

describe('pages, as their routes compose them', () => {
  for (const [name, sections] of Object.entries(PAGES)) {
    for (const locale of LOCALES) {
      test(`${name} (${locale})`, async () => {
        expect(await renderSections(inLocale(sections, locale), locale)).toMatchSnapshot();
      });
    }
  }
});

describe('every content field authored', () => {
  for (const [name, sections] of Object.entries(AUTHORED)) {
    for (const locale of LOCALES) {
      test(`${name} (${locale})`, async () => {
        expect(await renderSections(inLocale(sections, locale), locale)).toMatchSnapshot();
      });
    }
  }
});

describe('variants, modes and route data', () => {
  for (const [name, sections] of Object.entries(VARIANTS)) {
    for (const locale of LOCALES) {
      test(`${name} (${locale})`, async () => {
        expect(await renderSections(inLocale(sections, locale), locale)).toMatchSnapshot();
      });
    }
  }
});

describe('Hello rendered directly, as a service page does', () => {
  for (const locale of LOCALES) {
    test(`service page (${locale})`, async () => {
      const html = await renderComponent(Hello, {
        locale,
        groups: DISCIPLINES,
        selected: 'logo',
        headingOverride: serviceHelloHeading(
          locale === 'ar' ? 'تصميم الشعار' : 'Logo Design',
          locale,
        ),
        leadOverride: SERVICE_PAGE_COPY[locale].helloLead,
      });
      expect(html).toMatchSnapshot();
    });
  }
});

describe('the cases author every content field', () => {
  // CLAUDE.md §9 says the snapshot holds every section type with all its content authored.
  // A field of a type's content schema that no case authors is a branch of its component
  // the snapshot never sees, as About's poster and clip and the hero's Stream loop were.
  const unwrap = (s: z.ZodTypeAny): z.ZodTypeAny =>
    s instanceof z.ZodOptional || s instanceof z.ZodNullable
      ? unwrap(s.unwrap() as z.ZodTypeAny)
      : s instanceof z.ZodEffects
        ? unwrap(s.innerType() as z.ZodTypeAny)
        : s;

  test('every field of every content schema is authored by a case of its type', () => {
    const authored = new Map<string, Set<string>>();
    for (const s of [...Object.values(AUTHORED), ...Object.values(VARIANTS)].flat()) {
      const keys = authored.get(s.type) ?? new Set<string>();
      for (const k of Object.keys(s.props ?? {})) keys.add(k);
      authored.set(s.type, keys);
    }
    const missing: string[] = [];
    for (const type of RENDERED_SECTION_TYPES) {
      const schema = SECTION_CONTENT_SCHEMAS[type];
      const shape = schema ? unwrap(schema) : null;
      if (!(shape instanceof z.ZodObject)) continue;
      for (const field of Object.keys(shape.shape as object)) {
        if (!authored.get(type)?.has(field)) missing.push(`${type}.${field}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
