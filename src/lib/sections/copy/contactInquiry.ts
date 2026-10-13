import type { ContactInquirySectionContent } from '@schemas/sections';
import { CONTACT_FORM_COPY } from '@/lib/forms/contactCopy';
import type { BuiltIn } from './text';

// The contact page's inquiry band (ContactInquiry.astro), the design's copy verbatim
// (c.inqTag / c.inqH / c.inqP). The accent is a word range: "Tell us what you're
// <em>making</em>" / "قل لنا وش <em>تصنع</em>". `note`, `successMessage` and `submitLabel`
// reach the form, whose own words are their built-in values (the full form's, from
// src/lib/forms/contactCopy.ts): named here so the page editor can show them, never copied.

const { en: FORM_EN, ar: FORM_AR } = CONTACT_FORM_COPY;

export const CONTACT_INQUIRY_COPY: BuiltIn<
  ContactInquirySectionContent,
  'tag' | 'heading' | 'accent' | 'lead' | 'note' | 'successMessage' | 'submitLabel'
> = {
  tag: { en: 'Project inquiry', ar: 'طلب مشروع' },
  heading: { en: "Tell us what you're making", ar: 'قل لنا وش تصنع' },
  accent: { en: { from: 4 }, ar: { from: 3 } },
  lead: {
    en: 'The more you give us here, the more useful our first reply is. Budget range and deadline help most.',
    ar: 'كل ما أعطيتنا تفاصيل أكثر هنا، صار ردنا الأول أنفع. الميزانية والموعد النهائي هما الأكثر فائدة.',
  },
  note: { en: FORM_EN.note, ar: FORM_AR.note },
  successMessage: { en: FORM_EN.ok, ar: FORM_AR.ok },
  submitLabel: { en: FORM_EN.submit, ar: FORM_AR.submit },
};
