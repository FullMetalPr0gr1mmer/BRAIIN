import { APPLY_STATUSES, type ApplyStatus } from '@schemas/application';
import { DEFAULT_JOIN_SECTIONS, ensureJoinApply, withHeroPreset, type SectionData } from './types';

// The Join page (/join, /ar/join): the route's cache entities, the no-JS answer
// (`?status=`) and the composition the route renders. Pure, so the route guarantees are
// unit-tested (tests/lib/joinPage.spec.ts).
//
// The built-in copy of its three bands is src/lib/sections/copy/joinWhy.ts, joinSteps.ts
// and joinApply.ts: the mockup's (join.html: I18N, WHY, STEPS), verbatim, its Saudi-voice
// Arabic included (owner decision 6), with the one J-6 rewrite those files mark. The studio
// is named through `%brand%`, filled from the public identity, so a rename is a CMS edit.

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
