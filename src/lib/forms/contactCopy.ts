import type { Locale } from '@schemas/primitives';

// The lead form's own words (src/components/ContactForm.astro), as the Join form's are
// APPLY_FORM_COPY (./applicationCopy.ts): code, not section content. The labels name the
// LeadInputSchema fields (./contactPayload.ts), and the budget options are
// BUDGET_BAND_LABELS, the one map the admin and the CSV read too. The design's copy is
// verbatim (its Saudi-voice Arabic); the validation and system copy stays MSA (owner
// decision 6). Admin v2 E8 (forms config) makes these editable, with this table as the
// defaults.
//
// Two lines differ by layout: the home form (`compact`) is "Send message" and, in Arabic, the
// design words its placeholder "builds" where /contact says "makes".
//
// A section around the form may replace three of them from its own content: the note, the
// confirmation and the button (ContactInquiry's `note`, `successMessage`, `submitLabel`).

export interface ContactFormCopy {
  name: string;
  email: string;
  company: string;
  companyPh: string;
  phone: string;
  phonePh: string;
  namePh: string;
  emailPh: string;
  /** /contact and "Say hello". */
  messagePh: string;
  /** The home form. */
  messagePhCompact: string;
  service: string;
  budget: string;
  deadline: string;
  deadlinePh: string;
  message: string;
  note: string;
  chooseService: string;
  chooseBudget: string;
  /** The empty first option of a select the forms config requires: plainly not an answer. */
  chooseOne: string;
  consent: string;
  /** /contact and "Say hello". */
  submit: string;
  /** The home form. */
  submitCompact: string;
  sending: string;
  ok: string;
  invalid: string;
  rateLimited: string;
  /** `{email}` is the public identity's mailbox. */
  unavailable: string;
  error: string;
  errRequired: string;
  errEmail: string;
  errTooLong: string;
  errInvalid: string;
}

export const CONTACT_FORM_COPY: Record<Locale, ContactFormCopy> = {
  en: {
    name: 'Name',
    email: 'Email',
    company: 'Company',
    companyPh: 'Optional',
    phone: 'Phone or WhatsApp',
    phonePh: '+966 5X XXX XXXX',
    namePh: 'Your full name',
    emailPh: 'you@company.com',
    messagePh: 'What are you making, who is it for, and when does it need to be ready?',
    messagePhCompact: 'What are you making, who is it for, and when does it need to be ready?',
    service: 'What do you need?',
    budget: 'Budget range',
    deadline: 'When do you need it?',
    deadlinePh: 'A date, a season, or ASAP',
    message: 'Tell us about the project',
    note: 'We read everything and reply within one business day.',
    chooseService: "Not sure yet, let's talk",
    chooseBudget: 'Prefer to discuss',
    chooseOne: 'Choose one',
    consent: 'I agree to be contacted about my inquiry.',
    submit: 'Send a message',
    submitCompact: 'Send message',
    sending: 'Sending…',
    ok: "Got it. We'll be in touch within one business day.",
    invalid: 'Please correct the marked fields and try again.',
    rateLimited: 'Too many attempts. Please wait a minute and try again.',
    unavailable: 'The form isn’t live yet — please email {email}.',
    error: 'Something went wrong. Please try again.',
    errRequired: 'This field is required.',
    errEmail: 'Enter a valid email address, like name@company.com.',
    errTooLong: 'This is longer than we can accept.',
    errInvalid: 'Please check this field.',
  },
  ar: {
    name: 'الاسم',
    email: 'البريد الإلكتروني',
    company: 'الشركة',
    companyPh: 'اختياري',
    phone: 'الجوال أو واتساب',
    phonePh: '+966 5X XXX XXXX',
    namePh: 'اسمك الكامل',
    emailPh: 'you@company.com',
    messagePh: 'وش تصنع، ولمين، ومتى لازم يكون جاهز؟',
    messagePhCompact: 'وش تبني، ولمين، ومتى لازم يطلع؟',
    service: 'وش تحتاج؟',
    budget: 'نطاق الميزانية',
    deadline: 'متى تحتاجه؟',
    deadlinePh: 'تاريخ، أو موسم، أو في أقرب وقت',
    message: 'احكِ لنا عن المشروع',
    note: 'نقرأ كل رسالة ونرد خلال يوم عمل واحد.',
    chooseService: 'لسه ما قررت، خلّنا نتكلم',
    chooseBudget: 'أفضّل نتناقش فيها',
    chooseOne: 'اختر واحداً',
    consent: 'أوافق على التواصل معي بخصوص طلبي.',
    submit: 'أرسل رسالتك',
    submitCompact: 'أرسل الرسالة',
    sending: 'جارٍ الإرسال…',
    ok: 'وصلتنا. بنتواصل معك خلال يوم عمل واحد.',
    invalid: 'يرجى تصحيح الحقول المشار إليها والمحاولة مرة أخرى.',
    rateLimited: 'محاولات كثيرة. يرجى الانتظار دقيقة ثم المحاولة مرة أخرى.',
    unavailable: 'النموذج غير مُفعّل بعد — راسلنا على {email}.',
    error: 'حدث خطأ ما. حاول مرة أخرى.',
    errRequired: 'هذا الحقل مطلوب.',
    errEmail: 'أدخل بريدًا إلكترونيًا صحيحًا، مثل name@company.com.',
    errTooLong: 'النص أطول من الحد المسموح.',
    errInvalid: 'يرجى مراجعة هذا الحقل.',
  },
};
