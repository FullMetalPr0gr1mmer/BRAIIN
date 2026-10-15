import type { FieldErrors } from '@/lib/admin/fieldErrors';
import type { FieldDef } from '@/lib/admin/uiSchema';

// What every field component of the kit takes (Admin v2 F5a). FormField.tsx is the one
// switch over the kinds and hands each component these.

export interface FieldComponentProps {
  field: FieldDef;
  value: unknown;
  onChange: (name: string, value: unknown) => void;
  /** Keeps element ids unique: `f`, or a repeater item's `f-<name>-<index>`. */
  idPrefix: string;
  /** Element id → message, from mapIssues (src/lib/admin/fieldErrors.ts). */
  errors?: FieldErrors | undefined;
  /** F5b: the value this field shows when nothing is stored (sectionContent built-ins). */
  builtIn?: unknown;
}
