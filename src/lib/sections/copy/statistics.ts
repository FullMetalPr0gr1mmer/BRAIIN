import type { StatisticsSectionContent } from '@schemas/sections';
import type { BuiltIn } from './text';

// The `statistics` section's built-in copy, per layout (its `variant`), verbatim from the
// design. The numbers come from the statistics table, never from here.
//   cards     the pre-UI-v2 grid (Statistics.astro): its heading only
//   band      home "In numbers" (StatBand.astro): "The work, <em>counted</em>" / "الشغل <em>بالأرقام</em>"
//   reach     About "Our reach" (StatBand.astro): "Campaigns that run <em>end to end</em>"
//   proof     Our Work's tag above the numbers (StatBand.astro; the `proof` section reuses it)
//   services  the Services page proof band (ServicesProof.astro, services.html `s.line`):
//             "…<em>Zero handoffs.</em>" / "…<em>بدون تسليم لأحد.</em>", from the fifth word.
//             Its rating line has NO built-in copy: it is a claim, so it exists only where
//             authored (the seeded row is flagged is_placeholder for it).

type Copy<Field extends keyof StatisticsSectionContent> = BuiltIn<StatisticsSectionContent, Field>;

export const STATISTICS_COPY: {
  cards: Copy<'heading'>;
  band: Copy<'tag' | 'heading' | 'accent' | 'text'>;
  reach: Copy<'tag' | 'heading' | 'accent' | 'text'>;
  proof: Copy<'tag'>;
  services: Copy<'line' | 'lineAccent'>;
} = {
  cards: {
    heading: { en: 'By the numbers', ar: 'بالأرقام' },
  },
  band: {
    tag: { en: 'In numbers', ar: 'بالأرقام' },
    heading: { en: 'The work, counted', ar: 'الشغل بالأرقام' },
    accent: { en: { from: 2 }, ar: { from: 1 } },
    text: {
      en: 'Every number here is a brief someone trusted us with, and a result they could measure.',
      ar: 'كل رقم هنا بريف أحد وثق فينا فيه، ونتيجة قدر يقيسها.',
    },
  },
  reach: {
    tag: { en: 'Our reach', ar: 'نطاق تأثيرنا' },
    heading: { en: 'Campaigns that run end to end', ar: 'حملات متكاملة من البداية للنهاية' },
    accent: { en: { from: 3 }, ar: { from: 2 } },
    text: {
      en: 'We started with minds built to plan, make, and run integrated campaigns. From brand strategy and production to media and live events, we build communication that feels new, for clients who expect it to deliver.',
      ar: 'انطلقنا بعقول مبنية للتخطيط والتنفيذ وإدارة الحملات المتكاملة. من استراتيجية العلامة والإنتاج إلى الإعلام والفعاليات الحيّة، نبني تواصلاً يبدو جديداً، لعملاء يتوقعون منه نتائج.',
    },
  },
  proof: {
    tag: { en: 'In numbers', ar: 'بالأرقام' },
  },
  services: {
    line: {
      en: 'Five disciplines. One team. Zero handoffs.',
      ar: 'خمسة تخصصات. فريق واحد. بدون تسليم لأحد.',
    },
    lineAccent: { en: { from: 4 }, ar: { from: 4 } },
  },
};
