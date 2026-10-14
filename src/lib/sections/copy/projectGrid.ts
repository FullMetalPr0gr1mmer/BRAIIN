import type { ProjectGridSectionContent } from '@schemas/sections';
import type { BuiltIn } from './text';

// Our Work's featured grid (ProjectGrid.astro): its tag and heading. The filter bar's words
// ("Filter by", "Clear filters", "No projects match"…) are not here: they are FILTER_STR
// (src/lib/portfolio/filterText.ts), one copy shared with the in-page filter script, so the
// server and the browser can never word a count differently.

export const PROJECT_GRID_COPY: BuiltIn<ProjectGridSectionContent, 'tag' | 'heading'> = {
  tag: { en: 'Featured work', ar: 'أعمال مختارة' },
  heading: { en: 'Projects', ar: 'المشاريع' },
};
