// What GET /api/admin/page-visibility answers (src/lib/admin/pageVisibility.ts), as the
// screen reads it. Type-only imports: the island never loads the server modules.
import type {
  VisibilityPageItem,
  VisibilitySetting,
  VisibilityTemplateItem,
} from '@/lib/admin/pageVisibility';
import type { EdgeVisibilityStatus } from '@/lib/admin/visibilitySync';

export type { VisibilitySetting };
export type VisibilityItem = VisibilityPageItem | VisibilityTemplateItem;
export type VisibilityMode = VisibilitySetting['mode'];

export interface VisibilityList {
  pages: VisibilityPageItem[];
  templates: VisibilityTemplateItem[];
  edge: EdgeVisibilityStatus | null;
}

export interface VisibilitySaveAnswer {
  setting: VisibilitySetting | null;
  kvSynced: boolean;
  purgeTags: string[];
}
