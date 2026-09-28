import type { Locale } from '@schemas/primitives';
import type { Accent } from '@schemas/media';

// "Say hello" (Round 2) — the inquiry block closing /services and every service page. Its
// built-in copy, verbatim from the mockups (services.html / service.html `h.*`, and the
// service page's `v.helloH` / `v.helloP`), and the heading a service page passes in.
// Pure, so the copy and the accent word ranges are unit-tested.

export interface HelloCopy {
  tag: string;
  heading: string;
  lead: string;
  points: readonly [string, string, string];
}

export const HELLO_COPY: Record<Locale, HelloCopy> & { accent: Accent } = {
  en: {
    tag: 'Project inquiry',
    heading: 'Say hello',
    lead: 'Big idea or small fix, tell us where you want to go. The more you share, the more useful our first reply is.',
    points: [
      'A reply within one business day',
      'A fixed price once the scope is agreed',
      'One team from the first sketch to launch',
    ],
  },
  ar: {
    tag: 'طلب مشروع',
    heading: 'قل هلا',
    lead: 'فكرة كبيرة أو تعديل بسيط، قل لنا وين تبي توصل. كل ما شاركتنا أكثر، صار ردنا الأول أنفع.',
    points: [
      'رد خلال يوم عمل واحد',
      'سعر ثابت بعد الاتفاق على النطاق',
      'فريق واحد من أول رسمة إلى الإطلاق',
    ],
  },
  // "Say <em>hello</em>" / "قل <em>هلا</em>"
  accent: { en: { from: 1 }, ar: { from: 1 } },
};

/** A heading handed to Hello in place of its own — already in the page's language. */
export interface HelloHeading {
  text: string;
  /** Which words carry the accent (a word range per locale), e.g. the service's name. */
  accent?: Accent | undefined;
}

// v.helloH: "Let's talk <em>{s}</em>" / "خلّنا نتكلم عن <em>{s}</em>" — the accent runs from
// the first word of the service's name to the end.
const LETS_TALK: Record<Locale, string> = { en: "Let's talk", ar: 'خلّنا نتكلم عن' };

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/** The service page's heading: "Let's talk *Logo Design*" (S4 passes it as headingOverride). */
export function serviceHelloHeading(service: string, locale: Locale): HelloHeading {
  const lead = LETS_TALK[locale];
  const range = { from: words(lead) };
  return {
    text: `${lead} ${service.trim()}`,
    accent: locale === 'ar' ? { ar: range } : { en: range },
  };
}

/** The service page's lead line (v.helloP), for Hello's leadOverride. */
export const SERVICE_HELLO_LEAD: Record<Locale, string> = {
  en: "Tell us what you need and where it has to show up. You'll hear back within one business day with our questions and a rough range.",
  ar: 'قل لنا وش تحتاج ووين لازم يظهر. يوصلك رد خلال يوم عمل واحد فيه أسئلتنا ونطاق سعري مبدئي.',
};
