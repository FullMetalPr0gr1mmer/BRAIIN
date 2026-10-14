import type { JoinWhySectionContent } from '@schemas/sections';
import type { BuiltIn } from './text';

// "Why {brand}" (JoinWhy.astro): join.html's j.whyTag / j.whyH / j.whyP and WHY, verbatim
// (its Saudi-voice Arabic included, owner decision 6), with ONE exception: the stale
// "Fourteen crafts" (j.whyP and the first reason) is rewritten to the five disciplines, as
// Round 2 did everywhere else (docs/design-port-2026-09.md J-6, for owner review). The
// studio is named through `%brand%`, filled from the public identity.
// "Work that <em>leaves the building</em>" / "شغل <em>يطلع للعالم</em>"

export const JOIN_WHY_COPY: BuiltIn<
  JoinWhySectionContent,
  'tag' | 'heading' | 'accent' | 'lead' | 'items'
> = {
  tag: { en: 'Why %brand%', ar: 'ليش %brand%' },
  heading: { en: 'Work that leaves the building', ar: 'شغل يطلع للعالم' },
  accent: { en: { from: 2 }, ar: { from: 1 } },
  lead: {
    // Rewritten (J-6): the mockup's "Fourteen crafts sit in the same room here." /
    // "أربع عشرة حرفة في نفس المكان."
    en: "Five disciplines and 28 services sit in the same room here. You'll work next to people who do what you don't, on briefs that end up in the real world.",
    ar: 'خمسة تخصصات و٢٨ خدمة في نفس المكان. بتشتغل جنب ناس يسوون اللي ما تسويه، على بريفات تنتهي في الواقع.',
  },
  items: [
    {
      // Rewritten (J-6): the mockup's "Fourteen crafts, one room" / "أربع عشرة حرفة، غرفة واحدة".
      heading: { en: 'Five disciplines, one room', ar: 'خمسة تخصصات، غرفة واحدة' },
      text: {
        en: 'Designers, filmmakers, writers and developers on the same floor. You pick up what the others know.',
        ar: 'مصممون وصنّاع أفلام وكتّاب ومطوّرون في نفس المكان. تتعلّم اللي يعرفه غيرك.',
      },
    },
    {
      heading: { en: 'Real briefs, early', ar: 'بريفات حقيقية من البداية' },
      text: {
        en: "No months of shadowing. You work on projects that actually ship, with people who've shipped plenty.",
        ar: 'بدون شهور من المراقبة. تشتغل على مشاريع تطلع فعلاً، مع ناس طلّعوا كثير.',
      },
    },
    {
      heading: { en: 'Native in any language', ar: 'أصليّ بأي لغة' },
      text: {
        en: 'Arabic, English and more, each one written and designed as itself, never as a translation.',
        ar: 'العربية والإنجليزية وغيرها، كل لغة تُكتب وتُصمَّم بلغتها، مو كترجمة.',
      },
    },
    {
      heading: { en: 'Room to grow', ar: 'مساحة للنمو' },
      text: {
        en: 'Feedback from leads in your craft, and a path forward you can actually see.',
        ar: 'ملاحظات من قادة في حرفتك، وطريق واضح للتطور تقدر تشوفه.',
      },
    },
  ],
};
