import type { HeroSectionContent } from '@schemas/sections';
import type { LocalizedText } from '@schemas/content';
import type { BuiltIn } from './text';

// The hero's built-in copy (Hero.astro). `default` is what any hero renders with no content
// (the home hero); the others are the page presets' copy (withHeroPreset in
// src/lib/sections/types.ts, whose layout half stays there), each verbatim from its mockup.
// The accent counts words of the built-in headline: "Creative work that <em>performs</em>*"
// (the footnote mark stays white) / "شغل إبداعي <em>يحقّق نتائج</em>*".

type HeroCopy = BuiltIn<
  HeroSectionContent,
  'headline' | 'accentFromEn' | 'accentFromAr' | 'sub' | 'ctaLabel'
>;

export const HERO_COPY = {
  default: {
    headline: { en: 'Creative work that performs*', ar: 'شغل إبداعي يحقّق نتائج*' },
    accentFromEn: 3,
    accentFromAr: 2,
    sub: { en: 'From the brain to the real world.', ar: 'من الدماغ إلى أرض الواقع.' },
    ctaLabel: { en: 'See our work', ar: 'شوف أعمالنا' },
  },
  contact: {
    headline: { en: "Let's make it happen", ar: 'خلّنا نحقّقها' },
    accentFromEn: 3,
    accentFromAr: 1,
    sub: {
      en: "Strategy, creative, and production under one roof. Tell us where you want to go, and we'll take it from there.",
      ar: 'استراتيجية وإبداع وإنتاج تحت سقف واحد. قل لنا وين تبي توصل، والباقي علينا.',
    },
    ctaLabel: { en: 'Start your project', ar: 'ابدأ مشروعك' },
  },
  // Round 2: /services — services.html `s.h1` / `s.sub` / `s.cta`, verbatim.
  // "Ideas, made <em>real</em>" / "أفكار، صارت <em>حقيقة</em>": the accent is the third word.
  services: {
    headline: { en: 'Ideas, made real', ar: 'أفكار، صارت حقيقة' },
    accentFromEn: 2,
    accentFromAr: 2,
    sub: {
      en: 'Branding, production, marketing, websites, and events. One team takes your idea from the first sketch to the day it goes live.',
      ar: 'هوية، وإنتاج، وتسويق، ومواقع، وفعاليات. فريق واحد ياخذ فكرتك من أول رسمة إلى يوم إطلاقها.',
    },
    ctaLabel: { en: 'Explore our services', ar: 'استكشف خدماتنا' },
  },
  // Join (/join): join.html `j.h1` / `j.sub` / `j.cta`, verbatim. "Join the <em>station</em>"
  // / "انضم إلى <em>المحطة</em>": the accent is the third word in both.
  join: {
    headline: { en: 'Join the station', ar: 'انضم إلى المحطة' },
    accentFromEn: 2,
    accentFromAr: 2,
    sub: {
      en: 'For people who can take an idea out of their head and make it real.',
      ar: 'للناس اللي يقدرون يطلّعون الفكرة من راسهم ويخلّونها حقيقة.',
    },
    ctaLabel: { en: 'Apply now', ar: 'قدّم الآن' },
  },
} as const satisfies Record<'default' | 'contact' | 'services' | 'join', HeroCopy>;

/** Text no content field overrides. */
export const HERO_LABELS = {
  /** The cue under a full-height hero. */
  scroll: { en: 'Scroll', ar: 'انزل' },
  /** The service page crumb's accessible name. */
  crumb: { en: 'Breadcrumb', ar: 'مسار التنقل' },
  /** The services preset's line under the CTA (route data): its `<b>` run is split, never injected. */
  servicesAltLink: {
    en: 'Know what you need? <b>Skip to the inquiry</b>',
    ar: 'عارف وش تحتاج؟ <b>انتقل للطلب مباشرة</b>',
  },
} as const satisfies Record<string, LocalizedText>;
