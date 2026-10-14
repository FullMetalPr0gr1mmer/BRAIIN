import type { JoinApplySectionContent } from '@schemas/sections';
import type { BuiltIn } from './text';

// The application band (JoinApply.astro): join.html's j.applyTag / j.applyH / j.applyP, the
// form's group titles j.g1–3, j.note and j.ok, verbatim. The form's own fields, options,
// consent wording and messages are not section copy (src/lib/forms/applicationCopy.ts).
// "Show us what you <em>make</em>" / "ورّنا وش <em>تصنع</em>"

export const JOIN_APPLY_COPY: BuiltIn<
  JoinApplySectionContent,
  | 'tag'
  | 'heading'
  | 'accent'
  | 'lead'
  | 'groupAbout'
  | 'groupRole'
  | 'groupWork'
  | 'note'
  | 'successMessage'
> = {
  tag: { en: 'Application', ar: 'التقديم' },
  heading: { en: 'Show us what you make', ar: 'ورّنا وش تصنع' },
  accent: { en: { from: 4 }, ar: { from: 2 } },
  lead: {
    en: 'A portfolio tells us more than a CV. Send both if you have them.',
    ar: 'أعمالك تقول لنا أكثر من السيرة الذاتية. أرسل الاثنين إذا عندك.',
  },
  groupAbout: { en: 'About you', ar: 'عنك' },
  groupRole: { en: 'The role', ar: 'الوظيفة' },
  groupWork: { en: 'Your work', ar: 'أعمالك' },
  note: {
    en: 'We reply to every application within two weeks, even when the answer is not yet.',
    ar: 'نرد على كل طلب خلال أسبوعين، حتى لو كان الجواب: مو الحين.',
  },
  successMessage: {
    en: "Application received. We'll review your work and reply within two weeks.",
    ar: 'وصلنا طلبك. بنراجع أعمالك ونرد عليك خلال أسبوعين.',
  },
};
