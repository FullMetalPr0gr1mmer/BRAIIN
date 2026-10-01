import type { Locale } from '@schemas/primitives';
import type { ApplyStatus } from '@schemas/application';

// The Join application form's own words (src/components/ApplicationForm.astro) — code, not
// content: the labels name the ApplicationInputSchema fields, and every outcome the endpoint
// can answer needs a message in both languages (tests/lib/applicationForm.spec.ts holds this
// table to APPLY_STATUSES).
//
// The labels, placeholders and the CV dropzone are the mockup's (join.html I18N), verbatim —
// its Saudi-voice Arabic included (owner decision 6), with the CV rules made exact: "PDF or
// Word (.docx)", because a .doc is refused (owner decision J2, design-port J-3). The
// validation and system copy the mockup lacks is ours, in MSA for Arabic (UI v2 decision 6),
// and listed for owner review in the Join report.

/** The status region's message for each outcome, plus the transient "Sending…". */
export type ApplyStatusCopy = Record<ApplyStatus | 'sending', string>;

export interface ApplyFormCopy {
  name: string;
  namePh: string;
  email: string;
  emailPh: string;
  phone: string;
  phonePh: string;
  city: string;
  cityPh: string;
  role: string;
  rolePh: string;
  experience: string;
  workType: string;
  availability: string;
  /** The empty first option of each select. */
  pick: string;
  skills: string;
  portfolio: string;
  portfolioPh: string;
  linkedin: string;
  linkedinPh: string;
  optional: string;
  cvTitle: string;
  cvHint: string;
  /** The dropzone's line for a file it will not send (too large, or not a PDF or .docx). */
  cvBad: string;
  cvRemove: string;
  /** The unit after a chosen file's size. */
  kb: string;
  mb: string;
  message: string;
  messagePh: string;
  submit: string;
  /** Appended (visually hidden) to the privacy link, which opens a new tab. */
  newTab: string;
  errors: {
    required: string;
    email: string;
    url: string;
    tooLong: string;
    invalid: string;
    consent: string;
  };
  status: Omit<ApplyStatusCopy, 'ok'>;
}

export const APPLY_FORM_COPY: Record<Locale, ApplyFormCopy> = {
  en: {
    name: 'Full name',
    namePh: 'Your full name',
    email: 'Email',
    emailPh: 'you@email.com',
    phone: 'Phone',
    phonePh: '+966 5X XXX XXXX',
    city: 'City',
    cityPh: 'Jeddah, Riyadh, anywhere',
    role: "Role you're interested in",
    rolePh: 'Motion designer, copywriter, producer',
    experience: 'Experience',
    workType: "How you'd like to work",
    availability: 'When could you start?',
    pick: 'Choose one',
    skills: 'Crafts you work in',
    portfolio: 'Portfolio link',
    portfolioPh: 'https://behance.net/yourname',
    linkedin: 'LinkedIn',
    linkedinPh: 'https://linkedin.com/in/yourname',
    optional: 'optional',
    cvTitle: 'Drop your CV here, or click to browse',
    cvHint: 'PDF or Word (.docx), up to 10 MB',
    cvBad: "That file won't work. Use a PDF or Word (.docx) file under 10 MB.",
    cvRemove: 'Remove',
    kb: 'KB',
    mb: 'MB',
    message: "The piece you're proudest of, and why",
    messagePh:
      "Link it or describe it. Tell us what you did on it and what you'd do differently now.",
    submit: 'Send application',
    newTab: '(opens in a new tab)',
    errors: {
      required: 'This field is required.',
      email: 'Enter a valid email address, like you@email.com.',
      url: 'Enter a full link that starts with https://',
      tooLong: 'This is longer than we can accept.',
      invalid: 'Please check this field.',
      consent: 'Tick this box so we can keep and review your application.',
    },
    status: {
      sending: 'Sending…',
      invalid:
        'Some answers are missing or need another look. Please check the form and try again.',
      too_large: 'That file is too large. Your CV can be up to 10 MB.',
      bad_type: "That file won't work. Use a PDF or Word (.docx) file under 10 MB.",
      rate_limited: 'Too many attempts. Please wait a little and try again.',
      unavailable: "We can't receive applications at the moment. Please try again later.",
      closed: "We're not taking applications right now. Check back soon.",
      error: 'Something went wrong. Please try again.',
    },
  },
  ar: {
    name: 'الاسم الكامل',
    namePh: 'اسمك الكامل',
    email: 'البريد الإلكتروني',
    emailPh: 'you@email.com',
    phone: 'الجوال',
    phonePh: '+966 5X XXX XXXX',
    city: 'المدينة',
    cityPh: 'جدة، الرياض، أي مكان',
    role: 'الوظيفة اللي تهمّك',
    rolePh: 'مصمم موشن، كاتب محتوى، منتج',
    experience: 'الخبرة',
    workType: 'كيف تحب تشتغل',
    availability: 'متى تقدر تبدأ؟',
    pick: 'اختر واحداً',
    skills: 'الحِرف اللي تشتغل فيها',
    portfolio: 'رابط أعمالك',
    portfolioPh: 'https://behance.net/yourname',
    linkedin: 'لينكدإن',
    linkedinPh: 'https://linkedin.com/in/yourname',
    optional: 'اختياري',
    cvTitle: 'اسحب سيرتك الذاتية هنا، أو اضغط للاختيار',
    // U+200F keeps "(.docx)" on the Arabic side of "Word" (the brief's copy).
    cvHint: 'PDF أو Word ‏(.docx)، حتى ١٠ ميجابايت',
    cvBad: 'هذا الملف ما ينفع. استخدم ملف PDF أو Word ‏(.docx) أقل من ١٠ ميجابايت.',
    cvRemove: 'إزالة',
    kb: 'كيلوبايت',
    mb: 'ميجابايت',
    message: 'العمل اللي تفتخر فيه أكثر، وليش',
    messagePh: 'حط رابطه أو وصفه. قل لنا وش كان دورك فيه ووش بتسوي بشكل مختلف الحين.',
    submit: 'أرسل الطلب',
    newTab: '(يفتح في علامة تبويب جديدة)',
    errors: {
      required: 'هذا الحقل مطلوب.',
      email: 'أدخل بريدًا إلكترونيًا صحيحًا، مثل you@email.com.',
      url: 'أدخل رابطًا كاملًا يبدأ بـ https://',
      tooLong: 'النص أطول من الحد المسموح.',
      invalid: 'يرجى مراجعة هذا الحقل.',
      consent: 'يرجى تحديد هذا المربع لنحتفظ بطلبك ونراجعه.',
    },
    status: {
      sending: 'جارٍ الإرسال…',
      invalid: 'بعض الإجابات ناقصة أو تحتاج إلى مراجعة. يرجى مراجعة النموذج والمحاولة مرة أخرى.',
      too_large: 'حجم الملف أكبر من المسموح. يمكن أن يصل حجم سيرتك الذاتية إلى ١٠ ميجابايت.',
      bad_type: 'لا يمكن قبول هذا الملف. استخدم ملف PDF أو Word ‏(.docx) أقل من ١٠ ميجابايت.',
      rate_limited: 'محاولات كثيرة. يرجى الانتظار قليلًا ثم المحاولة مرة أخرى.',
      unavailable: 'لا يمكننا استقبال الطلبات في الوقت الحالي. يرجى المحاولة لاحقًا.',
      closed: 'لا نستقبل طلبات التوظيف حاليًا. عُد إلينا قريبًا.',
      error: 'حدث خطأ ما. حاول مرة أخرى.',
    },
  },
};

/** The message for an outcome; `ok` is the band's own confirmation (CMS-overridable). */
export function applyStatusText(
  copy: ApplyFormCopy,
  status: ApplyStatus | 'sending',
  okMessage: string,
): string {
  return status === 'ok' ? okMessage : copy.status[status];
}
