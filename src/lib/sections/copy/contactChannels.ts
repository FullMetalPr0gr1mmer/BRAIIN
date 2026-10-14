import type { ContactChannelsSectionContent } from '@schemas/sections';
import type { BuiltIn } from './text';

// "Talk to us" (ContactChannels.astro), the design's copy verbatim (c.touchTag / c.touchH /
// c.touchP and the card copy): "Talk to <em>us</em>" / "كلّمنا <em>مباشرة</em>". The address
// and the number are the public identity, never copy.

export const CONTACT_CHANNELS_COPY: BuiltIn<
  ContactChannelsSectionContent,
  | 'tag'
  | 'heading'
  | 'accent'
  | 'lead'
  | 'emailLabel'
  | 'emailNote'
  | 'whatsappLabel'
  | 'whatsappNote'
> = {
  tag: { en: 'Stay in touch', ar: 'ابقَ على تواصل' },
  heading: { en: 'Talk to us', ar: 'كلّمنا مباشرة' },
  accent: { en: { from: 2 }, ar: { from: 1 } },
  lead: {
    en: "No form, no gatekeeping. Write to us directly and you'll get a person, not a ticket number.",
    ar: 'بدون نماذج ولا وسطاء. اكتب لنا مباشرة ويردّ عليك إنسان، مو رقم تذكرة.',
  },
  emailLabel: { en: 'Email', ar: 'البريد الإلكتروني' },
  emailNote: {
    en: 'Best for briefs, scopes, and anything with attachments.',
    ar: 'الأنسب للبريفات والنطاقات وأي شيء فيه مرفقات.',
  },
  whatsappLabel: { en: 'WhatsApp', ar: 'واتساب' },
  whatsappNote: {
    en: 'Fastest for quick questions and timing checks.',
    ar: 'الأسرع للأسئلة القصيرة والاستفسار عن المواعيد.',
  },
};
