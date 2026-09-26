import { columnOf, type FieldDef } from '@/lib/admin/uiSchema';
import { sectionFields } from '@/lib/admin/sectionUi';

// Form state <-> API payload for the admin ResourceForm / SingletonForm. Kept apart from
// the React field components so it can be unit-tested in node — a regression here does
// not fail loudly, it makes a form impossible to save (tests/lib/formPayload.spec.ts).
//
// Two shaping rules live here:
//   • top-level fields map to COLUMNS (snake_case) and keep their value semantics — a
//     blank optional string is null, a blank nullable bilingual pair is null;
//   • values INSIDE a jsonb object (repeater items, section content) are OPTIONAL
//     OVERRIDES keyed by field name: a blank one is omitted altogether, so the object
//     never carries a half-empty override the schema would reject.

type Row = Record<string, unknown>;

/** Form state of a `sectionContent` field: the typed values, or the Advanced JSON text. */
export interface SectionContentState {
  values: Row;
  /** Non-null while the editor is in "Advanced (JSON)" mode. */
  json: string | null;
}

/** Form state of a `clip` field. */
export interface ClipState {
  source: '' | 'stream' | 'path';
  streamUid: string;
  path: string;
  startS: string;
  endS: string;
}

const isBlank = (v: unknown): boolean =>
  v === undefined ||
  v === null ||
  (typeof v === 'string' && v.trim() === '') ||
  (Array.isArray(v) && v.length === 0);

const allBlank = (record: unknown): boolean =>
  typeof record !== 'object' ||
  record === null ||
  Object.values(record as Row).every((v) => typeof v !== 'string' || v.trim() === '');

const toStringOrEmpty = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

// ── row → form ────────────────────────────────────────────────────────────────

/** A jsonb object (keyed by field NAME) → form state, recursively. */
export function objectToForm(obj: unknown, fields: readonly FieldDef[]): Row {
  const source = (obj && typeof obj === 'object' ? obj : {}) as Row;
  const out: Row = {};
  for (const field of fields) out[field.name] = valueToForm(source[field.name], field, source);
  return out;
}

function valueToForm(raw: unknown, field: FieldDef, siblings: Row): unknown {
  switch (field.kind) {
    case 'json':
      return JSON.stringify(raw ?? {}, null, 2);
    case 'datetime':
      return typeof raw === 'string' ? raw.slice(0, 16) : (raw ?? null);
    case 'relation':
    case 'media':
    case 'upload':
      return toStringOrEmpty(raw);
    case 'multiRelation':
    case 'multiSelect':
      return Array.isArray(raw) ? raw.map(String) : [];
    case 'repeater':
      return Array.isArray(raw)
        ? raw.map((item) => objectToForm(item, field.itemFields ?? []))
        : [];
    case 'clip': {
      const c = (raw && typeof raw === 'object' ? raw : {}) as Row;
      const state: ClipState = {
        source: c['streamUid'] ? 'stream' : c['path'] ? 'path' : '',
        streamUid: toStringOrEmpty(c['streamUid']),
        path: toStringOrEmpty(c['path']),
        startS: toStringOrEmpty(c['startS']),
        endS: toStringOrEmpty(c['endS']),
      };
      return state;
    }
    case 'sectionContent': {
      const typed = sectionFields(siblings[field.typeField ?? 'type']);
      const state: SectionContentState = typed
        ? { values: objectToForm(raw, typed), json: null }
        : // A type with no editor (or none chosen yet) edits as JSON.
          { values: {}, json: JSON.stringify(raw ?? {}, null, 2) };
      return state;
    }
    default:
      return raw ?? null;
  }
}

/** API row (snake_case) → form state (camelCase), limited to declared fields. */
export function rowToForm(row: Row, fields: readonly FieldDef[]): Row {
  // Siblings are looked up by field name (a sectionContent field reads `type`).
  const byName: Row = {};
  for (const field of fields) byName[field.name] = row[columnOf(field)];
  const out: Row = {};
  for (const field of fields) out[field.name] = valueToForm(row[columnOf(field)], field, byName);
  return out;
}

// ── form → payload ────────────────────────────────────────────────────────────

function parseJson(text: string, label: string): unknown {
  // Rejected here rather than posted: the server would answer 400 "body must be valid
  // JSON" for the WHOLE request, which points at the wrong thing — the request was
  // fine, one textarea was not.
  try {
    return JSON.parse(text || '{}');
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

function clipToPayload(state: unknown, label: string): Row | null {
  const c = (state ?? {}) as Partial<ClipState>;
  if (!c.source) return null;
  const out: Row = {};
  if (c.source === 'stream') {
    if (!c.streamUid?.trim())
      throw new Error(`${label}: enter the Stream UID, or choose no video.`);
    out['streamUid'] = c.streamUid.trim();
  } else {
    if (!c.path?.trim()) throw new Error(`${label}: enter the /media/… path, or choose no video.`);
    out['path'] = c.path.trim();
  }
  // The window is both-or-neither (the schema says so too); a half window is a mistake.
  const start = c.startS?.trim() ?? '';
  const end = c.endS?.trim() ?? '';
  if ((start === '') !== (end === '')) {
    throw new Error(`${label}: give both a start and an end, or neither.`);
  }
  if (start !== '') {
    out['startS'] = Number(start);
    out['endS'] = Number(end);
  }
  return out;
}

/** One value inside a jsonb object; `undefined` means "omit the key". */
function overrideToPayload(value: unknown, field: FieldDef, siblings: Row): unknown {
  switch (field.kind) {
    case 'bilingual':
    case 'prose':
      return allBlank(value) ? undefined : value;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    case 'checkbox':
      return value === true ? true : undefined;
    case 'repeater': {
      const items = repeaterToPayload(value, field);
      return items.length > 0 ? items : undefined;
    }
    default: {
      const shaped = valueToPayload(value, field, siblings);
      return isBlank(shaped) ? undefined : shaped;
    }
  }
}

/** Form state of a jsonb object → the object, with blank overrides omitted. */
export function objectToPayload(values: Row, fields: readonly FieldDef[]): Row {
  const out: Row = {};
  for (const field of fields) {
    const shaped = overrideToPayload(values[field.name], field, values);
    if (shaped !== undefined) out[field.name] = shaped;
  }
  return out;
}

function repeaterToPayload(value: unknown, field: FieldDef): Row[] {
  const items = Array.isArray(value) ? (value as Row[]) : [];
  return items
    .map((item) => objectToPayload(item, field.itemFields ?? []))
    .filter((item) => Object.keys(item).length > 0); // an untouched new row is not an item
}

function valueToPayload(value: unknown, field: FieldDef, siblings: Row): unknown {
  switch (field.kind) {
    case 'json':
      return typeof value === 'string' ? parseJson(value, field.label) : (value ?? {});
    case 'datetime':
      return value ? new Date(String(value)).toISOString() : null;
    case 'relation':
    case 'media':
    case 'upload':
      return isBlank(value) ? null : String(value);
    case 'multiRelation':
    case 'multiSelect':
      return Array.isArray(value)
        ? [...new Set((value as unknown[]).map(String).filter((v) => v.trim() !== ''))]
        : [];
    case 'repeater':
      return repeaterToPayload(value, field);
    case 'clip':
      return clipToPayload(value, field.label);
    case 'sectionContent': {
      const state = (value ?? { values: {}, json: '{}' }) as SectionContentState;
      if (state.json !== null) return parseJson(state.json, field.label);
      const typed = sectionFields(siblings[field.typeField ?? 'type']);
      return typed ? objectToPayload(state.values, typed) : {};
    }
    default:
      return value;
  }
}

/** Form state → API payload. Throws on malformed JSON so the field can be blamed. */
export function formToPayload(values: Row, fields: readonly FieldDef[]): Row {
  const out: Row = {};
  for (const field of fields) {
    const value = values[field.name];
    if (value === undefined) continue;

    // An unset <select> means "leave it alone", not "set it to empty".
    if (field.kind === 'select' && !value) continue;

    // A NULLABLE bilingual pair left entirely blank means "none" (site_profile's legal
    // name), not `{en:'', ar:''}` — which the server would reject for being half-present.
    // Opt-in: every other bilingual field keeps sending its object, because most of those
    // columns are NOT NULL (seo_defaults' title template, for one) and a null would make
    // a blank save fail. A HALF-filled pair is still sent as-is so the server can say
    // which language is missing.
    if (
      (field.kind === 'bilingual' || field.kind === 'prose') &&
      field.nullable === true &&
      allBlank(value)
    ) {
      out[field.name] = null;
      continue;
    }

    if (
      typeof value === 'string' &&
      value.trim() === '' &&
      !['relation', 'media', 'upload', 'json'].includes(field.kind)
    ) {
      out[field.name] = field.required ? '' : null;
      continue;
    }

    if (field.kind === 'select') {
      // `redirects.status` is the one numeric <select>; option values are always strings.
      out[field.name] = /^\d+$/.test(String(value)) ? Number(value) : value;
      continue;
    }
    out[field.name] = valueToPayload(value, field, values);
  }
  return out;
}
