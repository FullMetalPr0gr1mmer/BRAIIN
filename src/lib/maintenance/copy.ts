import type { Locale } from '@schemas/primitives';
import type { Bilingual } from '@schemas/maintenance';

// The maintenance page's built-in words (Admin v2 U9b): the prototype's headline and message
// (`opsMaintenanceCard`, verbatim, owner item for approval), shown when the admin leaves the
// boxes empty, and the page's own small words in both languages.
//
// The prototype's single message ends "Reach us on email or WhatsApp in the meantime.", which
// is untrue on a page with no buttons, or no WhatsApp number (P-12: copy must be true), so the
// message has three forms and the page shows the one that matches its buttons.

export const DEFAULT_TITLE: Bilingual = {
  en: "We're making something new.",
  ar: 'نجهّز شي جديد.',
};

export const DEFAULT_MESSAGE = {
  /** The buttons are on, with both email and WhatsApp (the prototype's words). */
  emailAndWhatsapp: {
    en: 'The site is down for a short while. Reach us on email or WhatsApp in the meantime.',
    ar: 'الموقع متوقف لفترة قصيرة. تواصل معنا بالإيميل أو واتساب في هذي الأثناء.',
  },
  /** The buttons are on, and no WhatsApp number is set: email only. */
  email: {
    en: 'The site is down for a short while. Reach us on email in the meantime.',
    ar: 'الموقع متوقف لفترة قصيرة. تواصل معنا بالإيميل في هذي الأثناء.',
  },
  /** No buttons. */
  none: {
    en: 'The site is down for a short while. Please come back soon.',
    ar: 'الموقع متوقف لفترة قصيرة. نراك قريبًا.',
  },
} as const satisfies Record<string, Bilingual>;

/** The page's own words. */
export const PAGE_WORDS: Record<
  Locale,
  { emailUs: string; whatsapp: string; backOn: (date: string) => string }
> = {
  en: {
    emailUs: 'Email us',
    whatsapp: 'WhatsApp',
    backOn: (date) => `Back on ${date}`,
  },
  ar: {
    emailUs: 'راسلنا',
    whatsapp: 'واتساب',
    backOn: (date) => `نعود في ${date}`,
  },
};

/** Gregorian month names, ours (never Intl's words, whose spelling varies between builds). */
export const MONTH_WORDS: Record<Locale, readonly string[]> = {
  en: [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ],
  ar: [
    'يناير',
    'فبراير',
    'مارس',
    'أبريل',
    'مايو',
    'يونيو',
    'يوليو',
    'أغسطس',
    'سبتمبر',
    'أكتوبر',
    'نوفمبر',
    'ديسمبر',
  ],
};
