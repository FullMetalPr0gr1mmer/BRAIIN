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
