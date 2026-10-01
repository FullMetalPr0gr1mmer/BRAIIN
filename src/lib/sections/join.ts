import type { Locale } from '@schemas/primitives';
import type { Accent } from '@schemas/media';
import { APPLY_STATUSES, type ApplyStatus } from '@schemas/application';
import { DEFAULT_JOIN_SECTIONS, ensureJoinApply, withHeroPreset, type SectionData } from './types';

// The Join page (/join, /ar/join): the built-in copy of its three bands, the route's cache
// entities, the no-JS answer (`?status=`) and the composition the route renders. Pure, so
// the copy, the accent ranges and the route guarantees are unit-tested
// (tests/lib/joinPage.spec.ts).
//
// The copy is the mockup's (join.html: I18N, WHY, STEPS), verbatim — its Saudi-voice
// Arabic included (owner decision 6) — with ONE exception: the stale "Fourteen crafts"
// (j.whyP and the first reason) is rewritten to the five disciplines, as Round 2 did
// everywhere else (docs/design-port-2026-09.md J-6, for owner review). The studio is named
// through `%brand%`, filled from the public identity, so a rename is a CMS edit.

/** What a publish of the page must purge. The brand in the consent text and the
    `accepting_applications` switch are the public identity — `site:identity`, which every
    Tier-A page already carries. */
export const JOIN_CACHE_ENTITIES = ['page:join'] as const;

/** The token the copy names the studio by (as About's): replaced with the brand. */
export const BRAND_TOKEN = '%brand%';

/** `%brand%` → the brand, in defaults and authored copy alike. */
export function withBrand(text: string, brand: string): string {
  return text.replaceAll(BRAND_TOKEN, brand);
}

export interface JoinItem {
  heading: string;
  text: string;
}
export interface JoinStep extends JoinItem {
  /** The step's time label ("Within two weeks"). */
  time: string;
}

interface JoinBandCopy<Item> {
  tag: string;
  heading: string;
  lead: string;
  items: readonly Item[];
}

/** "Why {brand}" — j.whyTag / j.whyH / j.whyP and WHY. */
export const JOIN_WHY_COPY: Record<Locale, JoinBandCopy<JoinItem>> & { accent: Accent } = {
  en: {
    tag: 'Why %brand%',
    heading: 'Work that leaves the building',
    // Rewritten (J-6): the mockup's "Fourteen crafts sit in the same room here."
    lead: "Five disciplines and 28 services sit in the same room here. You'll work next to people who do what you don't, on briefs that end up in the real world.",
    items: [
      {
        // Rewritten (J-6): the mockup's "Fourteen crafts, one room".
        heading: 'Five disciplines, one room',
        text: 'Designers, filmmakers, writers and developers on the same floor. You pick up what the others know.',
      },
      {
        heading: 'Real briefs, early',
        text: "No months of shadowing. You work on projects that actually ship, with people who've shipped plenty.",
      },
      {
        heading: 'Native in any language',
        text: 'Arabic, English and more, each one written and designed as itself, never as a translation.',
      },
      {
        heading: 'Room to grow',
        text: 'Feedback from leads in your craft, and a path forward you can actually see.',
      },
    ],
  },
  ar: {
    tag: 'ليش %brand%',
    heading: 'شغل يطلع للعالم',
    // Rewritten (J-6): the mockup's "أربع عشرة حرفة في نفس المكان."
    lead: 'خمسة تخصصات و٢٨ خدمة في نفس المكان. بتشتغل جنب ناس يسوون اللي ما تسويه، على بريفات تنتهي في الواقع.',
    items: [
      {
        // Rewritten (J-6): the mockup's "أربع عشرة حرفة، غرفة واحدة".
        heading: 'خمسة تخصصات، غرفة واحدة',
        text: 'مصممون وصنّاع أفلام وكتّاب ومطوّرون في نفس المكان. تتعلّم اللي يعرفه غيرك.',
      },
      {
        heading: 'بريفات حقيقية من البداية',
        text: 'بدون شهور من المراقبة. تشتغل على مشاريع تطلع فعلاً، مع ناس طلّعوا كثير.',
      },
      {
        heading: 'أصليّ بأي لغة',
        text: 'العربية والإنجليزية وغيرها، كل لغة تُكتب وتُصمَّم بلغتها، مو كترجمة.',
      },
      {
        heading: 'مساحة للنمو',
        text: 'ملاحظات من قادة في حرفتك، وطريق واضح للتطور تقدر تشوفه.',
      },
    ],
  },
  // "Work that <em>leaves the building</em>" / "شغل <em>يطلع للعالم</em>"
  accent: { en: { from: 2 }, ar: { from: 1 } },
};

/** "How it works" — j.stepsTag / j.stepsH / j.stepsP and STEPS. */
export const JOIN_STEPS_COPY: Record<Locale, JoinBandCopy<JoinStep>> & { accent: Accent } = {
  en: {
    tag: 'How it works',
    heading: 'From application to first brief',
    lead: "Four steps, and you'll hear from us at every one of them.",
    items: [
      {
        heading: 'Apply',
        time: 'Day one',
        text: 'Send your portfolio and a few details. Five minutes, no cover letter.',
      },
      {
        heading: 'Portfolio review',
        time: 'Within two weeks',
        text: 'A lead from your craft looks at the work itself, not just the CV.',
      },
      {
        heading: 'Conversation',
        time: 'About 45 minutes',
        text: "A call with the people you'd work with. Bring your questions too.",
      },
      {
        heading: 'A short brief',
        time: 'A few days',
        text: 'A small, real-world task so both sides see how working together feels.',
      },
    ],
  },
  ar: {
    tag: 'كيف تمشي العملية',
    heading: 'من التقديم إلى أول بريف',
    lead: 'أربع خطوات، وبتسمع منا في كل وحدة منها.',
    items: [
      {
        heading: 'قدّم',
        time: 'اليوم الأول',
        text: 'أرسل أعمالك وبعض التفاصيل. خمس دقائق، بدون خطاب تقديم.',
      },
      {
        heading: 'مراجعة الأعمال',
        time: 'خلال أسبوعين',
        text: 'قائد من نفس حرفتك يراجع الشغل نفسه، مو بس السيرة الذاتية.',
      },
      {
        heading: 'محادثة',
        time: 'حوالي ٤٥ دقيقة',
        text: 'مكالمة مع الناس اللي بتشتغل معهم. وجهّز أسئلتك أنت بعد.',
      },
      {
        heading: 'بريف قصير',
        time: 'أيام قليلة',
        text: 'مهمة صغيرة واقعية عشان الطرفين يشوفون كيف يكون الشغل مع بعض.',
      },
    ],
  },
  // "From application to <em>first brief</em>" / "من التقديم إلى <em>أول بريف</em>"
  accent: { en: { from: 3 }, ar: { from: 3 } },
};

export interface JoinApplyCopy {
  tag: string;
  heading: string;
  lead: string;
  groups: { about: string; role: string; work: string };
  note: string;
  ok: string;
}

/** The application band — j.applyTag / j.applyH / j.applyP, j.g1–3, j.note and j.ok. */
export const JOIN_APPLY_COPY: Record<Locale, JoinApplyCopy> & { accent: Accent } = {
  en: {
    tag: 'Application',
    heading: 'Show us what you make',
    lead: 'A portfolio tells us more than a CV. Send both if you have them.',
    groups: { about: 'About you', role: 'The role', work: 'Your work' },
    note: 'We reply to every application within two weeks, even when the answer is not yet.',
    ok: "Application received. We'll review your work and reply within two weeks.",
  },
  ar: {
    tag: 'التقديم',
    heading: 'ورّنا وش تصنع',
    lead: 'أعمالك تقول لنا أكثر من السيرة الذاتية. أرسل الاثنين إذا عندك.',
    groups: { about: 'عنك', role: 'الوظيفة', work: 'أعمالك' },
    note: 'نرد على كل طلب خلال أسبوعين، حتى لو كان الجواب: مو الحين.',
    ok: 'وصلنا طلبك. بنراجع أعمالك ونرد عليك خلال أسبوعين.',
  },
  // "Show us what you <em>make</em>" / "ورّنا وش <em>تصنع</em>"
  accent: { en: { from: 4 }, ar: { from: 2 } },
};

/** The application band's anchor — the hero's "Apply now" and the no-JS answer's `#apply`. */
export const APPLY_ANCHOR = '#apply';

/**
 * The no-JS answer. A plain form post to /api/apply is answered with a 303 to
 * `/join?status=<status>#apply`; the page then renders that status in the form's status
 * region, server-side. `present` is true for ANY `status` parameter, valid or not: the
 * route serves every such request `private, no-store` (only the bare URL is Tier A), so a
 * crafted query can never fill the edge cache. `status` is the parameter only when it is
 * one of the endpoint's answers — anything else renders the plain page.
 */
export interface JoinAnswer {
  present: boolean;
  status: ApplyStatus | null;
}

export function joinAnswer(params: URLSearchParams): JoinAnswer {
  if (!params.has('status')) return { present: false, status: null };
  const raw = params.get('status') ?? '';
  const known = (APPLY_STATUSES as readonly string[]).includes(raw);
  return { present: true, status: known ? (raw as ApplyStatus) : null };
}

/**
 * The route's own data, handed to the application band as `data` (never CMS content): the
 * no-JS answer it renders in the form's status region.
 */
export function withJoinData(
  sections: readonly SectionData[],
  data: { answer: ApplyStatus | null },
): SectionData[] {
  return sections.map((s) =>
    s.type === 'joinApply' ? { ...s, data: { ...s.data, answer: data.answer } } : s,
  );
}

/**
 * The composed page (pure): the authored composition, else DEFAULT_JOIN_SECTIONS, with the
 * route's guarantees — the join banner hero (withHeroPreset), the application band always
 * on the page (ensureJoinApply) — and its data.
 */
export function composeJoinPage(
  authored: readonly SectionData[],
  answer: ApplyStatus | null,
): SectionData[] {
  const composition = authored.length > 0 ? authored : DEFAULT_JOIN_SECTIONS;
  return withJoinData(ensureJoinApply(withHeroPreset(composition, 'join')), { answer });
}

/** The first section a visitor will actually see. */
export function firstVisibleType(sections: readonly SectionData[]): string | undefined {
  return sections.find((s) => s.visible !== false)?.type;
}

/** Whether a visible section of this type is on the page. */
export function shown(sections: readonly SectionData[], type: string): boolean {
  return sections.some((s) => s.type === type && s.visible !== false);
}
