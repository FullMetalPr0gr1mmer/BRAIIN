import type { ProofSectionContent } from '@schemas/sections';
import { STATISTICS_COPY } from './statistics';
import { TESTIMONIALS_COPY } from './testimonials';
import type { BuiltIn } from './text';

// Our Work's white proof band (ProofBand.astro): the numbers' tag above the quotes. Both
// halves are the shared components, so their built-in copy is theirs (the statistics `proof`
// layout and the testimonials carousel); this names it under the `proof` type's own fields,
// for the page editor.

export const PROOF_COPY: BuiltIn<
  ProofSectionContent,
  'statsTag' | 'quotesTag' | 'quotesHeading' | 'quotesAccent'
> = {
  statsTag: STATISTICS_COPY.proof.tag,
  quotesTag: TESTIMONIALS_COPY.tag,
  quotesHeading: TESTIMONIALS_COPY.heading,
  quotesAccent: TESTIMONIALS_COPY.accent,
};
