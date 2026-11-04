import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import type { AstroComponentFactory } from 'astro/runtime/server/index.js';
import { describe, expect, test } from 'vitest';
import type { Locale } from '@schemas/primitives';
import ServicePage from '@/components/service/ServicePage.astro';
import CaseStudyPage from '@/components/case-study/CaseStudyPage.astro';
import type { CaseMedia, CaseStudy, PortfolioCard } from '@/lib/data/portfolio';
import type { ServiceCase } from '@/lib/data/serviceCases';
import type { ServiceDetail } from '@/lib/data/services';
import type { Head } from '@/lib/seo/head';
import {
  BUILT_IN_CASE_COPY,
  BUILT_IN_SERVICE_COPY,
  caseCopyFrom,
  serviceCopyFrom,
} from '@/lib/templates/copy';
import { PUBLIC_SITE_URL } from '../stubs/astro-env-client';
import { CARDS, DISCIPLINES, IDENTITY, POSTER, TESTIMONIALS } from './fixtures';
import { normalise } from './harness';

// The two template pages (Admin v2 E3), rendered whole and to the byte: the service page
// (src/components/service/ServicePage.astro) and the case study
// (src/components/case-study/CaseStudyPage.astro), English and Arabic, each with every band
// its data can show. The snapshot was written by the pages as they stood BEFORE E3 made their
// shared text editable, so it is the proof that a site with no `template_copy` row (every
// key the built-in words) serves the bytes it always did. Invented content, never production.

const scrub = (html: string) => normalise(html).split(PUBLIC_SITE_URL).join('<site>');

async function renderPage(
  component: AstroComponentFactory,
  props: Record<string, unknown>,
): Promise<string> {
  const container = await AstroContainer.create();
  const html = await container.renderToString(component, {
    props,
    request: new Request('https://www.example.test/'),
    locals: { identity: Promise.resolve(IDENTITY) } as App.Locals,
  });
  if (html.includes('section-error')) throw new Error('a part of the page failed to render');
  return scrub(html);
}

const t = (en: string, ar: string) => ({ en, ar });

const HEAD: Head = {
  seo: {
    title: 'Logo Design | Branding',
    description: 'A mark you repeat.',
    entityOgImage: undefined,
    defaultOgImage: undefined,
    canonicalOverride: undefined,
    robots: 'index,follow',
  },
  identity: IDENTITY,
  brand: 'Studio',
};

const branding = DISCIPLINES[0]!;
const SERVICE: ServiceDetail = {
  id: '00000000-0000-4000-8000-000000000101',
  slug: 'logo',
  title: t('Logo Design', 'تصميم الشعار'),
  label: t('Logo Design', 'تصميم الشعار'),
  tagline: t('A mark you repeat.', 'علامة تتكرر.'),
  intro: t('A logo is a promise.', 'الشعار وعد.'),
  disciplineId: branding.id,
  sortOrder: 1,
  updatedAt: null,
  poster: POSTER,
  clip: { uid: null, path: '/media/showreel.mp4', startS: 2, endS: 6 },
  valuePoints: [
    { title: t('One system', 'نظام واحد'), text: t('Every use, one rule.', 'كل استخدام بقاعدة.') },
    { title: t('Made to last', 'يدوم'), text: t('No trend chasing.', 'بلا ملاحقة موضة.') },
  ],
  deliverables: [t('The mark', 'الشعار'), t('A usage sheet', 'دليل الاستخدام')],
  bodyHtml: t('<p>We start from the name.</p>', '<p>نبدأ من الاسم.</p>'),
  discipline: { slug: branding.slug, name: branding.name },
};

const SERVICE_CASE: ServiceCase = {
  id: '00000000-0000-4000-8000-000000000301',
  serviceId: SERVICE.id,
  title: t('A school group rebrand', 'هوية مجموعة مدارس'),
  context: t('Four campuses, four logos.', 'أربعة فروع وأربعة شعارات.'),
  problems: [{ problem: t('Four logos', 'أربعة شعارات'), solution: t('One mark', 'شعار واحد') }],
  results: [{ value: '+27%', label: t('parent recall', 'تذكّر الأهالي') }],
  updatedAt: null,
  project: {
    slug: 'notebook',
    title: t('Notebook', 'دفتر'),
    poster: POSTER,
    sector: { slug: 'education', name: t('Education', 'التعليم'), order: 1 },
    client: null,
    confidentialClient: true,
  },
};

const servicePage = (serviceCase: ServiceCase | null) => ({
  service: SERVICE,
  discipline: branding,
  disciplines: DISCIPLINES,
  serviceCase,
  head: HEAD,
  // No template_copy row: the reader's answer is every key's built-in words.
  copy: BUILT_IN_SERVICE_COPY,
});

const still = (
  kind: CaseMedia['breakdownKind'],
  layout: CaseMedia['layout'],
  en: string,
): CaseMedia => ({
  kind: 'image',
  image: POSTER,
  clip: null,
  durationLabel: null,
  caption: t(en, `ع ${en}`),
  breakdownKind: kind,
  layout,
});

const card = CARDS[0] as PortfolioCard;
const STUDY: CaseStudy = {
  ...card,
  summary: t('A film about a rider.', 'فيلم عن فارس.'),
  bodyHtml: t('<p>Shot in two days.</p>', '<p>صُوّر في يومين.</p>'),
  lead: t('A brand film.', 'فيلم للعلامة.'),
  goal: t('Make the brand feel fast.', 'نخلي العلامة سريعة.'),
  result: t('More visits.', 'زيارات أكثر.'),
  scope: [t('Script', 'النص'), t('Shoot', 'التصوير')],
  keywords: [t('Film', 'فيلم'), t('Motion', 'حركة')],
  results: [{ value: '2x', label: t('watch time', 'مدة المشاهدة') }],
  nextPortfolioId: null,
  hero: { ...still(null, null, 'Hero'), caption: null },
  final: { ...still(null, null, 'Final'), caption: null },
  breakdown: [
    still('sketch', 'half', 'A sketch'),
    still('bts', 'half', 'On set'),
    still('process', 'wide', 'The edit'),
  ],
  gallery: [still(null, null, 'Still one'), still(null, null, 'Still two')],
};

const casePage = {
  study: STUDY,
  next: CARDS[1] ?? null,
  quote: TESTIMONIALS[0] ?? null,
  head: { ...HEAD, seo: { ...HEAD.seo, title: 'The Rider | Brand film' } },
  copy: BUILT_IN_CASE_COPY,
};

const LOCALES: readonly Locale[] = ['en', 'ar'];

describe('the template pages, to the byte, with no template_copy row', () => {
  test.each(LOCALES)('a service page with a case block, %s', async (locale) => {
    expect(
      await renderPage(ServicePage, { locale, page: servicePage(SERVICE_CASE) }),
    ).toMatchSnapshot();
  });
  test.each(LOCALES)('a service page without a case block, %s', async (locale) => {
    expect(await renderPage(ServicePage, { locale, page: servicePage(null) })).toMatchSnapshot();
  });
  test.each(LOCALES)('a case study, %s', async (locale) => {
    expect(await renderPage(CaseStudyPage, { locale, page: casePage })).toMatchSnapshot();
  });
});

// With stored differences, the page changes exactly those words: the render with no row, with
// each old wording swapped for the stored one, is the render with the row, to the byte. An
// accented heading stored with its own accent colours the words it names.
const swapAll = (html: string, swaps: readonly (readonly [string, string])[]) =>
  swaps.reduce((out, [from, to]) => {
    expect(out, `"${from}" is on the page`).toContain(from);
    return out.split(from).join(to);
  }, html);

describe('the template pages with stored shared text', () => {
  test('a service page: the stored lines, the stored accent, {c} for the discipline', async () => {
    const stored = {
      seeCase: t('Read the story', 'اقرأ القصة'),
      fab: t('Ask us', 'اسألنا'),
      valueHeading: t('Why us', 'ليش نحن'),
      valueHeadingAccent: { en: { from: 1 }, ar: { from: 1 } },
      moreTag: t('{c} and more', '{c} وأكثر'),
      helloLeadIn: t('Talk to us about', 'كلمنا عن'),
    };
    const page = { ...servicePage(SERVICE_CASE), copy: serviceCopyFrom(stored) };
    const before = await renderPage(ServicePage, { locale: 'en', page: servicePage(SERVICE_CASE) });
    const after = await renderPage(ServicePage, { locale: 'en', page });
    expect(after).toBe(
      swapAll(before, [
        ['See the case study', 'Read the story'],
        ['Skip to inquiry<', 'Ask us<'],
        ['Why it&#39;s <em>worth it</em>', 'Why <em>us</em>'],
        ['More in Branding', 'Branding and more'],
        ['Let&#39;s talk <em>', 'Talk to us about <em>'],
      ]),
    );
    const arBefore = await renderPage(ServicePage, {
      locale: 'ar',
      page: servicePage(SERVICE_CASE),
    });
    const arAfter = await renderPage(ServicePage, { locale: 'ar', page });
    expect(arAfter).toBe(
      swapAll(arBefore, [
        ['شوف دراسة الحالة', 'اقرأ القصة'],
        ['انتقل للطلب<', 'اسألنا<'],
        ['ليش <em>تستاهل</em>', 'ليش <em>نحن</em>'],
        ['المزيد في الهوية البصرية', 'الهوية البصرية وأكثر'],
        ['خلّنا نتكلم عن <em>', 'كلمنا عن <em>'],
      ]),
    );
  });

  test('a stored heading with no stored accent has no accent; a bad key keeps its built-in words', async () => {
    const page = {
      ...servicePage(null),
      copy: serviceCopyFrom({
        valueHeading: t('Why us', 'ليش نحن'),
        // Written around the Worker: no Arabic, so the key is dropped, never the page.
        valueLead: { en: 'Only English' },
        nonsense: t('x', 'y'),
      }),
    };
    const before = await renderPage(ServicePage, { locale: 'en', page: servicePage(null) });
    const after = await renderPage(ServicePage, { locale: 'en', page });
    expect(after).toBe(swapAll(before, [['Why it&#39;s <em>worth it</em>', 'Why us']]));
  });

  test('a case study: the stored lines and the two accented headings', async () => {
    const page = {
      ...casePage,
      copy: caseCopyFrom({
        breakdownHeading: t('How it was made', 'كيف انصنع'),
        breakdownHeadingAccent: { en: { from: 3 }, ar: { from: 1 } },
        galleryHeading: t('The stills', 'اللقطات'),
        viewerClose: t('Close the image', 'أغلق الصورة'),
        nextProject: t('Up next', 'التالي'),
        sketch: t('Drawing', 'رسم'),
      }),
    };
    const before = await renderPage(CaseStudyPage, { locale: 'en', page: casePage });
    const after = await renderPage(CaseStudyPage, { locale: 'en', page });
    expect(after).toBe(
      swapAll(before, [
        ['From the <em>first sketch</em> to set', 'How it was <em>made</em>'],
        ['Stills from <em>the final</em>', 'The stills'],
        ['aria-label="Close"', 'aria-label="Close the image"'],
        ['Next project', 'Up next'],
        ['>Sketch<', '>Drawing<'],
      ]),
    );
  });
});
