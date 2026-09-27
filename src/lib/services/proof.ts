import type { Locale } from '@schemas/primitives';
import type { Accent } from '@schemas/media';

// The Services page proof band (the `statistics` section's `services` variant, Round 2):
// its built-in statement, verbatim from services.html `s.line`, and the accent's word
// range — "…<em>Zero handoffs.</em>" / "…<em>بدون تسليم لأحد.</em>", from the fifth word.
// The rating line has NO built-in copy: it is a claim, so it exists only where authored
// (ServicesProof.astro).
export const SERVICES_PROOF_COPY: Record<Locale, { line: string }> & { accent: Accent } = {
  en: { line: 'Five disciplines. One team. Zero handoffs.' },
  ar: { line: 'خمسة تخصصات. فريق واحد. بدون تسليم لأحد.' },
  accent: { en: { from: 4 }, ar: { from: 4 } },
};
