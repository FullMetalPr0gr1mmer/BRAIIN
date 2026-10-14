import type { SocialSectionContent } from '@schemas/sections';
import type { BuiltIn } from './text';

// "Follow the studio" (SocialStrip.astro), per layout (the section's `variant`), verbatim
// from the design. The paper strip (home, contact) has no line and no accent; About's Klein
// band outlines "See the work <em>as it happens</em>" / "شوف الشغل <em>وهو يصير</em>". The
// links are the public identity's socials, never copy.

export const SOCIAL_COPY: {
  paper: BuiltIn<SocialSectionContent, 'tag' | 'heading'>;
  klein: BuiltIn<SocialSectionContent, 'tag' | 'heading' | 'accent' | 'text'>;
} = {
  paper: {
    tag: { en: 'Follow the studio', ar: 'تابع الاستوديو' },
    heading: { en: 'New work goes up here first.', ar: 'الشغل الجديد ينزل هنا أول.' },
  },
  klein: {
    tag: { en: 'Follow the studio', ar: 'تابع الاستوديو' },
    heading: { en: 'See the work as it happens', ar: 'شوف الشغل وهو يصير' },
    accent: { en: { from: 3 }, ar: { from: 2 } },
    text: {
      en: 'Launches, behind the scenes, and new work. It goes up on our channels first.',
      ar: 'الإطلاقات وكواليس العمل والشغل الجديد. كلها تنزل على حساباتنا أول.',
    },
  },
};
