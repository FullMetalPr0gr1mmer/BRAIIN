import type { FieldError } from '@/components/admin/kit/ErrorSummary';
import { AdminApiError, describeError } from './client';
import { SECTION_UI } from './sectionUi';
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

/** Every field a section type's content can hold, by name (for a `sectionContent` path). */
function sectionField(name: string): FieldDef | undefined {
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

/** Follows a path through the declared fields to the element it names. */
function resolve(
  parts: readonly string[],
  fields: readonly FieldDef[],
  idPrefix: string,
): Resolved {
  const [head, ...rest] = parts;
  const field = fields.find((f) => f.name === head);
  if (!field || head === undefined) return { id: null, name: '' };
  const id = `${idPrefix}-${field.name}`;

  if (BILINGUAL.has(field.kind) || (field.kind === 'chips' && field.chips?.bilingual)) {
    const lang = rest[0] === 'en' || rest[0] === 'ar' ? rest[0] : 'en';
    const named = rest[0] === 'en' || rest[0] === 'ar';
    return {
      id: `${id}-${lang}`,
      name: named ? `${field.label} (${LANGUAGE[lang]})` : field.label,
    };
  }

  if (field.kind === 'repeater') {
    const index = Number(rest[0]);
    if (!Number.isInteger(index) || index < 0 || rest.length < 2) {
      return { id: null, name: field.label };
    }
    const inner = resolve(rest.slice(1), field.itemFields ?? [], `${id}-${index}`);
    return {
      id: inner.id,
      name: inner.name
        ? `${field.label} ${index + 1}, ${inner.name}`
        : `${field.label} ${index + 1}`,
    };
  }

  if (field.kind === 'object') {
    if (rest.length === 0) return { id: null, name: field.label };
    const inner = resolve(rest, field.itemFields ?? [], id);
    return { id: inner.id, name: inner.name ? `${field.label}, ${inner.name}` : field.label };
  }

  if (field.kind === 'sectionContent') {
    const sub = rest[0] === undefined ? undefined : sectionField(rest[0]);
    if (!sub) return { id: null, name: field.label };
    const inner = resolve(rest, [sub], id);
    return { id: inner.id, name: inner.name ? `${field.label}, ${inner.name}` : field.label };
  }

  if (field.kind === 'clip') {
    // ClipField's inputs: the source's own box and the window (fields/ClipField.tsx).
    const input = rest[0] === undefined ? undefined : CLIP_INPUTS[rest[0]];
    return { id: input ? `${id}-${input}` : null, name: field.label };
  }

  // A single control (text, select, switch, colour, chips…): an error inside its value
  // (a chip's index, a clip's start) is still that control's.
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
): MappedErrors {
  const byId: Record<string, string> = {};
  const summary: FieldError[] = [];
  for (const issue of issues) {
    const parts = issue.path.split('.').filter((p) => p !== '');
    const { id, name } =
      parts.length > 0 ? resolve(parts, fields, idPrefix) : { id: null, name: '' };
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
export function errorsFromApi(err: unknown, fields: readonly FieldDef[]): MappedErrors | null {
  if (!(err instanceof AdminApiError)) return null;
  const { issues, field } = err.info;
  if (issues && issues.length > 0) return mapIssues(issues, fields);
  if (field) {
    return mapIssues([{ path: field, message: err.info.detail ?? describeError(err) }], fields);
  }
  return null;
}
