import type { CtaSectionContent } from '@schemas/sections';
import type { BuiltIn } from './text';

// The closing call to action's built-in copy (LeadBand.astro, the `cta` type: Our Work, All
// projects and the case study). "Your idea could be <em>next</em>" / "فكرتك ممكن تكون
// <em>التالية</em>". The button's target (`/contact#inquiry`) and the studio email are not
// copy: the first is a link, the second the public identity.

export const CTA_COPY: BuiltIn<
  CtaSectionContent,
  'tag' | 'heading' | 'accent' | 'text' | 'buttonLabel'
> = {
  tag: { en: 'Start a project', ar: 'ابدأ مشروعك' },
  heading: { en: 'Your idea could be next', ar: 'فكرتك ممكن تكون التالية' },
  accent: { en: { from: 4 }, ar: { from: 3 } },
  text: {
    en: "Tell us what you're making. You'll hear back within one business day with our questions, a rough range, and a time to talk.",
    ar: 'قل لنا وش تصنع. يوصلك رد خلال يوم عمل واحد فيه أسئلتنا، ونطاق سعري مبدئي، وموعد للمكالمة.',
  },
  buttonLabel: { en: 'Start an inquiry', ar: 'ابدأ طلبك' },
};
