import type { DashboardLayout, QuickItem, WidgetId } from '@schemas/dashboard';
import type { Role } from '@/lib/auth/types';
import type { LayoutSource } from '@/lib/admin/dashboard/layout';
import type { IconName } from '@/lib/admin/icons';

// What the dashboard's island receives (Admin v2 U1), built on the server from ROLE_CAPS, so
// no capability matrix ships to the browser: the widgets and the library actions the role may
// use, as lists of ids, and, for an Admin, the same per role for the presets.

export interface WidgetEntry {
  id: WidgetId;
  label: string;
  description: string;
}

export interface LibraryEntry {
  id: string;
  label: string;
  icon: IconName;
}

export interface RoleEntry {
  role: Role;
  label: string;
  widgets: WidgetId[];
  /** The library ids the role may use. */
  library: string[];
}

export interface DashboardIslandProps {
  /** The preferences were read, so saves have a version to send. */
  editable: boolean;
  /** The preferences row's version (0: no row yet). */
  version: number;
  /** The layout on the board (resolved: only what the role may see). */
  layout: DashboardLayout;
  /** Where it came from: the person's own, the role's preset, the code's default. */
  source: LayoutSource;
  /** The person chose their quick actions (README U1 D8). */
  storedQuickSet: boolean;
  /** The widgets the role may have, in the registry's order. */
  catalog: WidgetEntry[];
  quick: {
    /** The quick actions on the board, as stored (library ids and the person's own links). */
    items: QuickItem[];
    library: LibraryEntry[];
    /** The role's default list (ids), for "Reset to default"'s preview. */
    defaults: string[];
  };
  notesShown: boolean;
  quickShown: boolean;
  /** Admin only (users.manage): every role, for "Save as the default for a role". */
  presets: RoleEntry[] | null;
}
