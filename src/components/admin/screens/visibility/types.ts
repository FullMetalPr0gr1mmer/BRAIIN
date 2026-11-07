// What GET /api/admin/page-visibility answers (src/lib/admin/pageVisibility.ts), as the
// screen reads it. Type-only imports: the island never loads the server modules.
import type {
  VisibilityPageItem,
  VisibilityPending,
  VisibilitySetting,
  VisibilityTemplateItem,
} from '@/lib/admin/pageVisibility';
import type { EdgeVisibilityStatus } from '@/lib/admin/visibilitySync';

export type { VisibilityPending, VisibilitySetting };
export type VisibilityItem = VisibilityPageItem | VisibilityTemplateItem;
export type VisibilityMode = VisibilitySetting['mode'];

export interface VisibilityList {
  pages: VisibilityPageItem[];
  templates: VisibilityTemplateItem[];
  edge: EdgeVisibilityStatus | null;
  /**
   * Admin v2 R14b: present only while releases are on (the list was read through the release,
   * releaseEvents.ts readsThroughRelease): the screen saves pending changes then.
   */
  draftsInvalid?: string[];
}

export interface VisibilitySaveAnswer {
  setting: VisibilitySetting | null;
  kvSynced: boolean;
  purgeTags: string[];
  /** Admin v2 R14b: a staged save's pending change (release mode only). */
  pending?: VisibilityPending | null;
  staged?: true;
  /** Admin v2 R14e: the password door in release mode, on a page already asking for one live. */
  passwordLive?: boolean;
}
