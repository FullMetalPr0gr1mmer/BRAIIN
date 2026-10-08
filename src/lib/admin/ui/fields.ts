import type { FieldDef, RelationDef } from './types';

// The field helpers every editor shares: the relation options query, the row key of a
// field, and the descriptors several entities repeat (status, schedule, order, the
// placeholder flag, the showreel clip, a list of bilingual lines).

/**
 * The options query of a relation field. Equality goes as `column=value`, "is not" as
 * `column.neq=value` — the list endpoint (resource.ts) accepts both for `status` and the
 * resource's filterableColumns, and ignores any other key. Hiding a row from the picker
 * never drops it from a record that already links it: the stored id stays selected
 * (RelationField keeps ids the list does not contain).
 */
export function relationParams(relation: RelationDef, limit: number): URLSearchParams {
  const params = new URLSearchParams({ limit: String(limit) });
  for (const [column, value] of Object.entries(relation.filter ?? {})) {
    if (typeof value === 'string') params.set(column, value);
    else params.set(`${column}.neq`, value.neq);
  }
  return params;
}

/** snake_case default for a field's row key. */
export function columnOf(field: FieldDef): string {
  return field.column ?? field.name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

export const STATUS_FIELD: FieldDef = {
  name: 'status',
  label: 'Status',
  kind: 'select',
  options: [
    { value: 'draft', label: 'Draft' },
    { value: 'scheduled', label: 'Scheduled' },
    { value: 'published', label: 'Published' },
    { value: 'archived', label: 'Archived' },
  ],
  help: 'Publishing and scheduling need the publish capability; archiving is Admin-only.',
};

export const SCHEDULED_FIELD: FieldDef = {
  name: 'scheduledFor',
  label: 'Scheduled for',
  kind: 'datetime',
  help: 'With status “Scheduled”, the row goes live automatically once this time passes.',
};

export const SORT_FIELD: FieldDef = { name: 'sortOrder', label: 'Sort order', kind: 'number' };

/** Design-delivery sample content (UI v2). Refused on publish; production also refuses it in the DB. */
export const PLACEHOLDER_FIELD: FieldDef = {
  name: 'isPlaceholder',
  label: 'Placeholder (design sample)',
  kind: 'checkbox',
  help: 'Sample content from the design delivery. It cannot be published or shown until you replace it and untick this.',
};

/** Pickers hide archived rows; a record that already links one keeps the link. */
export const NOT_ARCHIVED = { status: { neq: 'archived' } } as const;

/** A window of the showreel in the preview_* columns (0022/0028): a site file, no Stream. */
export const showreelClip = (label: string, help: string): FieldDef => ({
  name: 'clip',
  // The API returns the clip derived from the preview_* columns under `preview`.
  column: 'preview',
  label,
  kind: 'clip',
  pathOnly: true,
  help,
});

/** A list of short bilingual phrases stored as [{en, ar}] (the item fields ARE the pair). */
export const bilingualList = (
  name: string,
  label: string,
  maxItems: number,
  help?: string,
): FieldDef => ({
  name,
  label,
  kind: 'repeater',
  maxItems,
  ...(help ? { help } : {}),
  itemFields: [
    { name: 'en', label: 'English', kind: 'text', required: true },
    { name: 'ar', label: 'Arabic', kind: 'text', required: true },
  ],
});
