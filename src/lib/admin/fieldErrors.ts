import type { FieldError } from '@/components/admin/kit/ErrorSummary';
import { AdminApiError, describeError } from './client';
import { repeaterKeptIndexes, type SectionContentState } from './formPayload';
import { SECTION_UI, sectionFields } from './sectionUi';
import type { FieldDef } from './uiSchema';

// The API's validation errors on the form (Admin v2 F5a, ui.md §2.6). The kernel
// (src/lib/admin/route.ts) answers a refused body with `issues: [{path, message}]`, the
// path the Zod path joined with dots, in the payload's own keys: the field names
// (formToPayload sends `field.name`), then a language, an item index or a sub-field. The
// form's element ids follow the same keys (FormField: `f-<name>`, `-en`/`-ar`; a repeater
// item `-<index>`, a sub-field `-<name>`), so a path IS an id once its dots are dashes.
//
// mapIssues walks the declared fields along the path to find the element that exists (a
// bilingual pair's whole-object error lands on its English input; a rich-text error deep
// in its document lands on the editor of that language) and to name it in words for the
// ErrorSummary: "Service name (Arabic): Required".

/** Inline messages, keyed by the element id they belong to. */
export type FieldErrors = Readonly<Record<string, string>>;

export interface ApiIssue {
  path: string;
  message: string;
}

export interface MappedErrors {
  byId: FieldErrors;
  summary: FieldError[];
}

/** `'items.2.title.en'` → `'f-items-2-title-en'`: the element id a path names. */
export function issueToFieldId(path: string, idPrefix = 'f'): string {
  const parts = path.split('.').filter((p) => p !== '');
  return [idPrefix, ...parts].join('-');
}

const LANGUAGE: Record<string, string> = { en: 'English', ar: 'Arabic' };
const BILINGUAL = new Set(['bilingual', 'prose', 'richtext']);
const CLIP_INPUTS: Record<string, string> = {
  streamUid: 'uid',
  path: 'path',
  startS: 'start',
  endS: 'end',
};

/** Every field a section type's content can hold: its type's, else any type's by name. */
function sectionField(name: string, type: unknown): FieldDef | undefined {
  const own = sectionFields(type)?.find((f) => f.name === name);
  if (own) return own;
  for (const fields of Object.values(SECTION_UI)) {
    const found = fields?.find((f) => f.name === name);
    if (found) return found;
  }
  return undefined;
}

interface Resolved {
  /** The element id, or null when the path names nothing on the form. */
  id: string | null;
  /** The field's name in words: "Value we add 2, Title (Arabic)". */
  name: string;
}

type Row = Record<string, unknown>;
const asRow = (v: unknown): Row | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : undefined;

/**
 * Follows a path through the declared fields to the element it names. `values` is the form
 * state the request was built from, when the caller has it: a repeater's untouched blank
 * items are not sent (formPayload.ts), so the server's item index is the PAYLOAD's and is
 * mapped back to the form's; and section content is read with its own type's fields.
 * A path that ends on a field of several controls, or goes deeper than the form knows,
 * names that field's group (FieldShell's fieldset carries the id).
 */
function resolve(
  parts: readonly string[],
  fields: readonly FieldDef[],
  idPrefix: string,
  values: Row | undefined,
): Resolved {
  const [head, ...rest] = parts;
  const field = fields.find((f) => f.name === head);
  if (!field || head === undefined) return { id: null, name: '' };
  const id = `${idPrefix}-${field.name}`;
  const value = values?.[field.name];

  if (BILINGUAL.has(field.kind) || (field.kind === 'chips' && field.chips?.bilingual)) {
    const lang = rest[0] === 'en' || rest[0] === 'ar' ? rest[0] : null;
    return lang
      ? { id: `${id}-${lang}`, name: `${field.label} (${LANGUAGE[lang]})` }
      : { id, name: field.label };
  }

  if (field.kind === 'repeater') {
    const sent = Number(rest[0]);
    if (rest[0] === undefined || !Number.isInteger(sent) || sent < 0) {
      return { id, name: field.label };
    }
    const kept = Array.isArray(value) ? repeaterKeptIndexes(value, field) : [];
    const index = kept[sent] ?? sent;
    const itemName = `${field.label} ${index + 1}`;
    if (rest.length < 2) return { id, name: itemName };
    const item = Array.isArray(value) ? asRow(value[index]) : undefined;
    const inner = resolve(rest.slice(1), field.itemFields ?? [], `${id}-${index}`, item);
    return {
      id: inner.id ?? id,
      name: inner.name ? `${itemName}, ${inner.name}` : itemName,
    };
  }

  if (field.kind === 'object') {
    if (rest.length === 0) return { id, name: field.label };
    const inner = resolve(rest, field.itemFields ?? [], id, asRow(value));
    return {
      id: inner.id ?? id,
      name: inner.name ? `${field.label}, ${inner.name}` : field.label,
    };
  }

  if (field.kind === 'sectionContent') {
    const type = values?.[field.typeField ?? 'type'];
    const sub = rest[0] === undefined ? undefined : sectionField(rest[0], type);
    if (!sub) return { id, name: field.label };
    const state = asRow(value) as Partial<SectionContentState> | undefined;
    const inner = resolve(rest, [sub], id, asRow(state?.values));
    return {
      id: inner.id ?? id,
      name: inner.name ? `${field.label}, ${inner.name}` : field.label,
    };
  }

  if (field.kind === 'clip') {
    // ClipField's inputs: the source's own box and the window (fields/ClipField.tsx).
    const input = rest[0] === undefined ? undefined : CLIP_INPUTS[rest[0]];
    return { id: input ? `${id}-${input}` : id, name: field.label };
  }

  // A single control (text, select, switch, colour, chips…): an error inside its value
  // (a chip's index) is still that control's.
  return { id, name: field.label };
}

/**
 * Issues → inline messages by element id, and the ErrorSummary's list (each linked to
 * its field, named by its label and language). A path that names no declared field (the
 * whole body, a column the form does not show) is listed without a link.
 */
export function mapIssues(
  issues: readonly ApiIssue[],
  fields: readonly FieldDef[],
  idPrefix = 'f',
  /** The form state the request was built from (see resolve): optional, but more exact. */
  values?: Readonly<Record<string, unknown>>,
): MappedErrors {
  const byId: Record<string, string> = {};
  const summary: FieldError[] = [];
  for (const issue of issues) {
    const parts = issue.path.split('.').filter((p) => p !== '');
    const { id, name } =
      parts.length > 0 ? resolve(parts, fields, idPrefix, values) : { id: null, name: '' };
    if (id) {
      byId[id] ??= issue.message;
      summary.push({ id, message: `${name}: ${issue.message}` });
    } else {
      summary.push({
        message: name
          ? `${name}: ${issue.message}`
          : parts.length > 0
            ? `${issue.path}: ${issue.message}`
            : issue.message,
      });
    }
  }
  return { byId, summary };
}

/**
 * A refused save → the form's errors, or null when the error is not about fields (a 403,
 * a 409, the network): the caller says that in words instead. Reads the kernel's
 * `issues`, or the one `field` a mapped constraint names (a duplicate slug).
 */
export function errorsFromApi(
  err: unknown,
  fields: readonly FieldDef[],
  values?: Readonly<Record<string, unknown>>,
): MappedErrors | null {
  if (!(err instanceof AdminApiError)) return null;
  const { issues, field } = err.info;
  if (issues && issues.length > 0) return mapIssues(issues, fields, 'f', values);
  if (field) {
    return mapIssues(
      [{ path: field, message: err.info.detail ?? describeError(err) }],
      fields,
      'f',
      values,
    );
  }
  return null;
}

/** A number or date-and-time box whose text the browser could not read (validity.badInput). */
export interface UnreadableControl {
  id: string;
  type: string;
  /** The field's label (FormField puts it on the input as data-label). */
  label: string;
}

/**
 * The form's own errors for boxes the browser could not read: such a box reports '' to
 * script, which the payload would send as "no value" (EditorForm refuses the save).
 */
export function badInputErrors(controls: readonly UnreadableControl[]): MappedErrors {
  const byId: Record<string, string> = {};
  const summary: FieldError[] = [];
  for (const control of controls) {
    const message =
      control.type === 'number'
        ? 'Enter a number, or clear the box.'
        : 'Enter the whole date and time, or clear it.';
    byId[control.id] = message;
    summary.push({ id: control.id, message: `${control.label || 'A field'}: ${message}` });
  }
  return { byId, summary };
}
