import SwitchField from './SwitchField';
import type { FieldComponentProps } from './types';
import type { FieldDef } from '@/lib/admin/uiSchema';

// The status select in release mode (Admin v2 R12; releases.md §7 "Forms in release mode"):
// "Visible on the site" (published, or a draft that is not), and Archived beside it. A status
// is staged with the rest of the change and goes live when it is published, so the person
// chooses whether the item SHOWS, not when: a release is scheduled, never one item
// ("Schedule the release instead", R3a), so the select's Scheduled is gone, and its Scheduled
// for field too (EditorForm). Archiving stays Admin's (content.archiveDelete): the switch is
// offered to every role, as the select's Archived was, and says so; the server refuses it for
// any other role, staged or not.

/** Is this the content lifecycle's status select (STATUS_FIELD, src/lib/admin/ui/fields.ts)? */
export function isLifecycleStatus(field: FieldDef): boolean {
  return (
    field.name === 'status' &&
    field.kind === 'select' &&
    (field.options ?? []).some((option) => option.value === 'published')
  );
}

/** The schedule field a release replaces (SCHEDULED_FIELD). */
export function isItemSchedule(field: FieldDef): boolean {
  return field.name === 'scheduledFor' && field.kind === 'datetime';
}

export const VISIBLE_LABEL = 'Visible on the site';
export const VISIBLE_HINT = 'Shown on the site once this change is published.';
export const ARCHIVED_LABEL = 'Archived';
export const ARCHIVED_HINT = 'Off the site and kept. Only an Admin can archive.';

export default function VisibilityField({
  field,
  value,
  onChange,
  idPrefix,
  errors,
}: FieldComponentProps) {
  const status = typeof value === 'string' ? value : 'draft';
  const archivable = (field.options ?? []).some((option) => option.value === 'archived');
  return (
    <div className="f-visibility" data-field={field.name}>
      <SwitchField
        field={{ name: field.name, label: VISIBLE_LABEL, kind: 'checkbox', help: VISIBLE_HINT }}
        value={status === 'published'}
        onChange={(_, on) => onChange(field.name, on ? 'published' : 'draft')}
        idPrefix={idPrefix}
        errors={errors}
      />
      {archivable && (
        <SwitchField
          field={{
            name: `${field.name}Archived`,
            label: ARCHIVED_LABEL,
            kind: 'checkbox',
            help: ARCHIVED_HINT,
          }}
          value={status === 'archived'}
          onChange={(_, on) => onChange(field.name, on ? 'archived' : 'draft')}
          idPrefix={idPrefix}
        />
      )}
    </div>
  );
}
