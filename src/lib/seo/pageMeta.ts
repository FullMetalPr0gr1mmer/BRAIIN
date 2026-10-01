import type { Locale } from '@schemas/primitives';

// Code defaults for the head of the section-composed routes: the page title (the brand is
// added by the title template, never written here) and the meta description. They are
// FALLBACKS — the SEO role overrides either per page in the CMS (`entity_seo` on the
// page's row), and resolveSeo() ranks an override above these.
//
// `%brand%` is substituted from the public identity, so a rename never leaves a stale
// name in a description. English is the UI v2 mockup's own <title>/<meta> copy. The
// mockup ships no Arabic metadata; the Arabic below is assembled from the mockup's Arabic
// page copy (hero, "why us", about) and awaits owner review.
//
// Contact deliberately omits the mockup's "or WhatsApp": the WhatsApp card only renders
// once a real number exists (site_profile.whatsapp_e164), and a description promising a
// channel the page does not offer is a false claim in a search result.

export interface PageMeta {
  title: string;
  description: string;
}

export type MetaRoute =
  'home' | 'about' | 'contact' | 'notFound' | 'portfolio' | 'portfolioAll' | 'services' | 'join';

export const PAGE_META: Record<MetaRoute, Record<Locale, PageMeta>> = {
  home: {
    en: {
      title: 'Creative work that performs',
      description:
        '%brand% is a creative studio in Jeddah working in any language. Identity, film, sound, events, merch, web. Five disciplines, one studio.',
    },
    ar: {
      title: 'شغل إبداعي يحقّق نتائج',
      description:
        '%brand% استوديو إبداعي في جدة يشتغل بأي لغة. الهوية والإنتاج والصوت والفعاليات والمنتجات والويب: خمسة تخصصات، استوديو واحد.',
    },
  },
  about: {
    en: {
      title: 'About',
      description:
        '%brand% was born in Jeddah to move ideas from the brain into the real world. Meet the studio and the team behind it.',
    },
    ar: {
      title: 'من نحن',
      description:
        'وُلدنا في جدة لننقل الأفكار من الدماغ إلى أرض الواقع. تعرّف على %brand% والفريق الذي يقف خلفه.',
    },
  },
  contact: {
    en: {
      title: 'Contact us',
      description:
        'Start a project with %brand%. Send an inquiry, reach us by email, and read the questions we get every week.',
    },
    ar: {
      title: 'تواصل معنا',
      description:
        'ابدأ مشروعك مع %brand%. أرسل طلبك، أو تواصل معنا عبر البريد الإلكتروني، واطّلع على الأسئلة التي تصلنا كل أسبوع.',
    },
  },
  notFound: {
    en: { title: 'Not found', description: '' },
    ar: { title: 'غير موجود', description: '' },
  },
  // UI v2 PR10. English: work.html / projects.html <title> + <meta> verbatim (brand as
  // %brand%). Arabic: ours, from the pages' Arabic copy — owner review.
  portfolio: {
    en: {
      title: 'Our Work',
      description:
        'Selected projects from %brand%, a creative studio in Jeddah. Brand films, identities, campaigns, events, and more.',
    },
    ar: {
      title: 'أعمالنا',
      description:
        'مشاريع مختارة من %brand%، استوديو إبداعي في جدة: أفلام للعلامات، وهويات، وحملات، وفعاليات، وأكثر.',
    },
  },
  portfolioAll: {
    en: {
      title: 'All projects',
      description: 'Every %brand% project, filterable by service, sector, client and year.',
    },
    ar: {
      title: 'كل المشاريع',
      description: 'كل مشاريع %brand%، مع فلترة حسب الخدمة والقطاع والعميل والسنة.',
    },
  },
  // Round 2. English: services.html <title> + <meta> verbatim. Arabic: ours — the title is
  // the Arabic menu label (nav.services), the description the English one in the page's own
  // Arabic words (s.sub, s.catP) — owner review.
  services: {
    en: {
      title: 'Services',
      description:
        'Branding, production, marketing, website development, and events and exhibitions. Five disciplines and one team in Jeddah, from the first sketch to launch.',
    },
    ar: {
      title: 'الخدمات',
      description:
        'الهوية البصرية، والإنتاج، والتسويق، وتطوير المواقع، والفعاليات والمعارض. خمسة تخصصات وفريق واحد في جدة، من أول رسمة إلى الإطلاق.',
    },
  },
  // Join. English: join.html's <title> ("Join us") and <meta>, less its "See open roles": the
  // page lists no roles, and a description promising them is a false claim in a search
  // result (as Contact's WhatsApp) — the rest is the page's own words (step 1). Arabic: ours
  // — the title is the page's Arabic name (seed-data/20-pages.json), the description the
  // same words from the page's Arabic copy — owner review.
  join: {
    en: {
      title: 'Join us',
      description:
        'Join %brand%, a creative studio in Jeddah. Send your portfolio and a few details: five minutes, no cover letter.',
    },
    ar: {
      title: 'انضم إلينا',
      description:
        'انضم إلى %brand%، استوديو إبداعي في جدة. أرسل أعمالك وبعض التفاصيل: خمس دقائق، بدون خطاب تقديم.',
    },
  },
};

// UI v2 PR11 — the case study (not a section-composed route, so outside PAGE_META). Its
// own title is "<name> | <type>" (src/lib/portfolio/casePage.ts); this description is the
// fallback for a project with no teaser or summary in the page's language. English:
// project.html's static <meta> verbatim (brand as %brand%). Arabic: ours, in the page's
// own words (البريف، نطاق العمل) — owner review.
export const CASE_STUDY_META: Record<Locale, PageMeta> = {
  en: {
    title: 'Case study',
    description: 'A %brand% case study: the brief, the scope, the result, and how it was made.',
  },
  ar: {
    title: 'دراسة حالة',
    description: 'دراسة حالة من %brand%: البريف، ونطاق العمل، والنتيجة، وكيف انصنع الشغل.',
  },
};

// Round 2 — a service page (/services/[slug]; not section-composed, so outside PAGE_META).
// Its own title is "<service> | <discipline>" (src/lib/services/page.ts) and its
// description the service's tagline; this is the fallback for a service with no tagline
// in the page's language. English: service.html's static <meta> verbatim. Arabic: ours, in
// the page's own words (القيمة اللي نضيفها، دراسة حالة) — owner review.
export const SERVICE_PAGE_META: Record<Locale, PageMeta> = {
  en: {
    title: 'Service',
    description: 'What the service is, the value we add, and a client problem we solved with it.',
  },
  ar: {
    title: 'الخدمة',
    description: 'وش هي الخدمة، والقيمة اللي نضيفها، ومشكلة عميل حلّيناها فيها.',
  },
};
