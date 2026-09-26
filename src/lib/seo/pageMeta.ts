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

export type MetaRoute = 'home' | 'about' | 'contact' | 'notFound';

export const PAGE_META: Record<MetaRoute, Record<Locale, PageMeta>> = {
  home: {
    en: {
      title: 'Creative work that performs',
      description:
        '%brand% is a creative studio in Jeddah working in any language. Identity, film, sound, events, merch, web. Fourteen crafts, one studio.',
    },
    ar: {
      title: 'شغل إبداعي يحقّق نتائج',
      description:
        '%brand% استوديو إبداعي في جدة يشتغل بأي لغة. الهوية والإنتاج والصوت والفعاليات والمنتجات والويب: أربع عشرة حرفة في استوديو واحد.',
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
};
