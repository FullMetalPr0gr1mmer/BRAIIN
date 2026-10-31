import { columnOf, type FieldDef } from '@/lib/admin/uiSchema';
import { contentKeysOf, sectionFields } from '@/lib/admin/sectionUi';
import { clampToRange, cleanChips, normalizeHex } from '@/lib/admin/fieldValues';
import { accentWords, clampAccent } from '@/lib/admin/accentWords';
import { isHttpsHref, isSiteHref } from '@/lib/admin/linkables';
import { docHasWords } from '@/lib/admin/docWords';
import type { AccentRange } from '@/lib/text/accent';

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
  /**
   * Stored keys the typed editor does not edit (hero.intro is JSON-only on purpose), kept
   * so a typed save does not silently delete them — but only while the section keeps the
   * type they were stored under (`extraType`); a key of another type is not carried over.
   */
  extra?: Row;
  extraType?: string;
  /**
   * The section's built-in copy (F5b, AV-23), when the screen knows it: what the fields
   * show under anything stored, and what `omitBuiltIn` drops from the payload, so the
   * row only ever holds what DIFFERS from the words the page already renders. The field
   * writes it into the state with the first change it makes, so a form nobody touched is
   * not marked dirty by it.
   */
  builtIn?: Row;
  /** Keys the type reads only together (F6's `together`): stored whole or not at all. */
  together?: readonly (readonly string[])[];
}

/**
 * Form state of an `accent` field (F5b): a word range per language, `from: null` meaning
 * "no highlight". The same state for both ways of storing it — a range (AccentSchema) or
 * two "from word N to the end" numbers (the hero's accentFromEn / accentFromAr) — so the
 * field draws one control set and only the payload differs.
 */
export interface AccentFormState {
  en: { from: number | null; to: number | null };
  ar: { from: number | null; to: number | null };
  /**
   * What was stored when the form loaded, per language, with the text it counted then
   * (F5b review H1, L5). A half the editor has not changed, over a text that has not
   * changed either, is saved EXACTLY as stored: an accent stored without its heading (it
   * colours the built-in or a preset's words) has no words here to be held inside, and a
   * save that only toggles `visible` must not rewrite a highlight nobody touched. Only
   * present when something was stored.
   */
  loaded?: { en: LoadedAccentHalf; ar: LoadedAccentHalf };
}

/** One language of an accent as loaded: its range and the words it was stored over. */
export interface LoadedAccentHalf {
  from: number | null;
  to: number | null;
  /** The sibling text as stored ('' when the heading was not stored). */
  text: string;
}

/** Form state of a `link` field (F5b): the label in both languages and where it goes. */
export interface LinkFormState {
  label: { en: string; ar: string };
  href: string;
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

// ── accents and links (F5b) ───────────────────────────────────────────────────

const numberOrNull = (raw: unknown): number | null => {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
};

/** A stored range → the half of an accent's form state it fills. */
const rangeToForm = (raw: unknown): { from: number | null; to: number | null } => {
  const range = (raw && typeof raw === 'object' ? raw : {}) as Row;
  return { from: numberOrNull(range['from']), to: numberOrNull(range['to']) };
};

const NO_ACCENT: AccentFormState = { en: { from: null, to: null }, ar: { from: null, to: null } };

/** Whatever an accent field holds, as its form state (what it loaded with included). */
export function accentState(value: unknown): AccentFormState {
  const state = (value && typeof value === 'object' ? value : {}) as Partial<AccentFormState>;
  return {
    en: { ...NO_ACCENT.en, ...(state.en ?? {}) },
    ar: { ...NO_ACCENT.ar, ...(state.ar ?? {}) },
    ...(state.loaded ? { loaded: state.loaded } : {}),
  };
}

/** A stored accent → its form state, remembering what was stored and over which words. */
function loadedAccent(
  halves: Pick<AccentFormState, 'en' | 'ar'>,
  text: { en: string; ar: string },
): AccentFormState {
  if (halves.en.from === null && halves.ar.from === null) return halves;
  return {
    ...halves,
    loaded: { en: { ...halves.en, text: text.en }, ar: { ...halves.ar, text: text.ar } },
  };
}

/** The text an accent highlights, per language: its sibling bilingual field's value. */
export function accentText(field: FieldDef, siblings: Row): { en: string; ar: string } {
  const raw = (siblings[field.accent?.of ?? ''] ?? {}) as Row;
  return {
    en: typeof raw['en'] === 'string' ? raw['en'] : '',
    ar: typeof raw['ar'] === 'string' ? raw['ar'] : '',
  };
}

/**
 * An accent's ranges as the schema takes them, each held inside the words its heading
 * still has (ui.md §10: the range clamps when the text shrinks). A language with no
 * highlight, or whose heading is now empty, is simply absent. The one exception is a half
 * exactly as it loaded, over the text it loaded with: that is passed through untouched
 * (AccentFormState.loaded), so a save never drops or moves a highlight nobody changed.
 */
export function accentToRanges(
  value: unknown,
  field: FieldDef,
  siblings: Row,
): { en?: AccentRange; ar?: AccentRange } {
  const state = accentState(value);
  const text = accentText(field, siblings);
  const out: { en?: AccentRange; ar?: AccentRange } = {};
  for (const lang of ['en', 'ar'] as const) {
    const half = state[lang];
    if (half.from === null) continue;
    const was = state.loaded?.[lang];
    if (was && was.from === half.from && was.to === half.to && was.text === text[lang]) {
      out[lang] = { from: half.from, ...(half.to === null ? {} : { to: half.to }) };
      continue;
    }
    const held = clampAccent(
      { from: half.from, ...(half.to === null ? {} : { to: half.to }) },
      accentWords(text[lang]).length,
    );
    if (held) out[lang] = held;
  }
  return out;
}

/**
 * The keys an accent field writes INTO ITS PARENT, for `mode: 'from'` (the hero's and the
 * slogan band's accentFromEn / accentFromAr): one number per language, "from word N to
 * the end". `undefined` for a language with no highlight, so the key is omitted and the
 * section keeps its built-in accent.
 */
export function accentFromKeys(value: unknown, field: FieldDef, siblings: Row): Row {
  const accent = field.accent;
  if (accent?.mode !== 'from') return {};
  const ranges = accentToRanges(value, field, siblings);
  const out: Row = {};
  if (ranges.en) out[accent.keys.en] = ranges.en.from;
  if (ranges.ar) out[accent.keys.ar] = ranges.ar.from;
  return out;
}

/** Whatever a link field holds, as its form state. */
export function linkState(value: unknown): LinkFormState {
  const state = (value && typeof value === 'object' ? value : {}) as Row;
  const label = (state['label'] && typeof state['label'] === 'object' ? state['label'] : {}) as Row;
  return {
    label: {
      en: typeof label['en'] === 'string' ? label['en'] : '',
      ar: typeof label['ar'] === 'string' ? label['ar'] : '',
    },
    href: typeof state['href'] === 'string' ? state['href'] : '',
  };
}

/** True for a link with no label in either language and nowhere to go. */
export function linkIsBlank(value: unknown): boolean {
  const link = linkState(value);
  return link.href.trim() === '' && link.label.en.trim() === '' && link.label.ar.trim() === '';
}

/** Whether a link field would accept this href: a site path, or https where it may. */
export function linkHrefOk(href: string, field: FieldDef): boolean {
  return isSiteHref(href) || (field.link?.external === true && isHttpsHref(href));
}

/**
 * A link as the schema takes it: `{label, href}`, each part omitted while it is blank, so
 * a link with only a label keeps the built-in target and one with only a target keeps the
 * built-in words. A HALF-filled label is sent as typed, for the server to name.
 */
function linkToPayload(value: unknown): Row | null {
  const link = linkState(value);
  const out: Row = {};
  if (link.label.en.trim() !== '' || link.label.ar.trim() !== '') {
    out['label'] = { en: link.label.en, ar: link.label.ar };
  }
  if (link.href.trim() !== '') out['href'] = link.href.trim();
  return Object.keys(out).length > 0 ? out : null;
}

// ── row → form ────────────────────────────────────────────────────────────────

/** A jsonb object (keyed by field NAME) → form state, recursively. */
export function objectToForm(obj: unknown, fields: readonly FieldDef[]): Row {
  const source = (obj && typeof obj === 'object' ? obj : {}) as Row;
  const out: Row = {};
  for (const field of fields) {
    // A switch with a default shows it when the item does not say (Admin v2 U9: a social
    // account stored before "Show on the site" existed is shown, as the server reads it).
    const raw =
      field.kind === 'checkbox' &&
      source[field.name] === undefined &&
      field.defaultValue !== undefined
        ? field.defaultValue
        : source[field.name];
    out[field.name] = valueToForm(raw, field, source);
  }
  return out;
}

/** A new repeater item: blank, but for the switches whose default is on (Admin v2 U9). */
export function newItem(fields: readonly FieldDef[]): Row {
  return Object.fromEntries(
    fields
      .filter((field) => field.kind === 'checkbox' && field.defaultValue !== undefined)
      .map((field) => [field.name, field.defaultValue]),
  );
}

function valueToForm(raw: unknown, field: FieldDef, siblings: Row): unknown {
  switch (field.kind) {
    case 'json':
      return JSON.stringify(raw ?? {}, null, 2);
    case 'datetime': {
      if (typeof raw !== 'string' || raw.trim() === '') return raw ?? null;
      const d = new Date(raw);
      if (Number.isNaN(d.getTime())) return raw.slice(0, 16);
      // <input type="datetime-local"> shows LOCAL wall-clock time and the save path reads
      // it back as local (new Date(value).toISOString()). Slicing the UTC string instead
      // moved a scheduled time earlier by the browser's offset on every save (Riyadh: 3h).
      return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    }
    case 'relation':
    case 'media':
    case 'upload':
      return toStringOrEmpty(raw);
    case 'multiRelation':
    case 'multiSelect':
      return Array.isArray(raw) ? raw.map(String) : [];
    // A gallery's items are a repeater's (U6): each shaped by the field's item fields.
    case 'repeater':
    case 'gallery':
      return Array.isArray(raw)
        ? raw.map((item) => objectToForm(item, field.itemFields ?? []))
        : [];
    case 'object':
      return objectToForm(raw, field.itemFields ?? []);
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
    case 'sectionContent':
      return sectionStateFromObject(raw, siblings[field.typeField ?? 'type']);
    // F5b. An accent shows as a word range per language, wherever it is stored: its own
    // key (AccentSchema) or the two numbers beside it (the hero's accentFromEn / Ar).
    case 'accent': {
      const accent = field.accent;
      const text = accentText(field, siblings);
      if (accent?.mode === 'from') {
        return loadedAccent(
          {
            en: { from: numberOrNull(siblings[accent.keys.en]), to: null },
            ar: { from: numberOrNull(siblings[accent.keys.ar]), to: null },
          },
          text,
        );
      }
      const stored = (raw && typeof raw === 'object' ? raw : {}) as Row;
      return loadedAccent({ en: rangeToForm(stored['en']), ar: rangeToForm(stored['ar']) }, text);
    }
    case 'link':
      return linkState(raw);
    case 'slugRelation':
      return Array.isArray(raw) ? raw.map(String) : [];
    // F5a. A colour shows as stored, uppercased when it is one; a slider's number as a
    // number; chips as their strings (a bilingual set as two lists).
    case 'color':
      return normalizeHex(raw) ?? toStringOrEmpty(raw);
    case 'range': {
      if (raw === null || raw === undefined || raw === '') return null;
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    }
    case 'chips':
      if (field.chips?.bilingual) {
        const pair = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Row;
        return raw === null || raw === undefined
          ? null
          : { en: cleanChips(pair['en']), ar: cleanChips(pair['ar']) };
      }
      return Array.isArray(raw) ? raw.map(String) : (raw ?? null);
    default:
      return raw ?? null;
  }
}

/** True for a bilingual chip set with no chip in either language. */
const noChips = (value: unknown): boolean => {
  const pair = (value && typeof value === 'object' ? value : {}) as Row;
  return cleanChips(pair['en']).length === 0 && cleanChips(pair['ar']).length === 0;
};

/**
 * Stored section content → editor state for a section of `type`.
 *   typed editor  the typed values, plus the stored keys it has no field for (`extra`,
 *                 e.g. hero.intro) so a typed save does not delete them;
 *   no editor     (a table-backed type, or none chosen) — nothing stored shows the
 *                 "nothing to override" note (json null); leftover non-empty content
 *                 stays visible as JSON so it can be seen and cleared.
 */
export function sectionStateFromObject(obj: unknown, type: unknown): SectionContentState {
  const stored = (obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {}) as Row;
  const typed = sectionFields(type);
  if (!typed) {
    const empty = Object.keys(stored).length === 0 && !Array.isArray(obj);
    return { values: {}, json: empty ? null : JSON.stringify(obj ?? {}, null, 2) };
  }
  // An accent that writes two numbers covers those KEYS, not one of its own name (F5b):
  // left out, they would fall into `extra` and be written back over "no highlight".
  const edited = new Set(
    typed.flatMap((f) =>
      f.kind === 'accent' && f.accent?.mode === 'from'
        ? [f.name, f.accent.keys.en, f.accent.keys.ar]
        : [f.name],
    ),
  );
  return {
    values: objectToForm(stored, typed),
    json: null,
    extra: Object.fromEntries(Object.entries(stored).filter(([k]) => !edited.has(k))),
    extraType: String(type),
  };
}

/** Typed editor → Advanced (JSON): everything that would be saved, extras included. */
export function enterAdvanced(state: SectionContentState, type: unknown): SectionContentState {
  const typed = sectionFields(type) ?? [];
  // What would be SAVED, so the box shows the row, not the words the page renders anyway.
  const stored = sectionContentPayload(state, type, typed);
  return { ...state, json: JSON.stringify(stored, null, 2) };
}

/**
 * Advanced (JSON) → typed editor, carrying the JSON edits back (leaving the mode used to
 * drop them). Throws when the JSON is not an object, so the caller can stay in Advanced
 * mode and say why instead of losing the text.
 */
export function leaveAdvanced(state: SectionContentState, type: unknown): SectionContentState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(state.json || '{}');
  } catch {
    parsed = undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      'Fix the JSON (it must be one {…} object) before switching back to the fields.',
    );
  }
  return {
    ...sectionStateFromObject(parsed, type),
    // The built-in copy is the screen's, not the JSON's: it survives the round trip.
    ...(state.builtIn ? { builtIn: state.builtIn } : {}),
    ...(state.together ? { together: state.together } : {}),
  };
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

/** Deep value equality, for comparing a saved value with its built-in (F5b). */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => sameValue(item, b[index]));
  }
  if (typeof a !== 'object') return false;
  const left = a as Row;
  const right = b as Row;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (!sameValue(left[key], right[key])) return false;
  }
  return true;
}

/**
 * A section's values as the editor SEES them (F5b review M4): each field's own value
 * once the editor has written something into it, else the built-in copy it is prefilled
 * with. `own` names the fields holding the editor's own words. The field draws these and
 * the save sends these, so an accent is counted against the heading on screen (its own or
 * the built-in) and the page keeps the highlight the form shows. Text fields are settled
 * first, because an accent's own words depend on the heading it counts.
 */
export function shownSectionValues(
  values: Row,
  fields: readonly FieldDef[],
  builtIn: Row | undefined,
): { values: Row; own: Set<string> } {
  const shown: Row = { ...values };
  const own = new Set<string>();
  const builtInForm = builtIn ? objectToForm(builtIn, fields) : undefined;
  const isAccent = (f: FieldDef) => f.kind === 'accent';
  for (const field of [...fields.filter((f) => !isAccent(f)), ...fields.filter(isAccent)]) {
    const written = objectToPayload({ ...shown, [field.name]: values[field.name] }, [field]);
    if (Object.keys(written).length > 0) {
      own.add(field.name);
      shown[field.name] = values[field.name];
    } else if (builtInForm && contentKeysOf(field).some((key) => key in builtIn!)) {
      shown[field.name] = builtInForm[field.name];
    }
  }
  return { values: shown, own };
}

/** What a typed section editor saves: its shown values, less what the built-in says. */
function sectionContentPayload(
  state: SectionContentState,
  type: unknown,
  typed: readonly FieldDef[],
): Row {
  const { values } = shownSectionValues(state.values, typed, state.builtIn);
  const shaped = { ...sectionExtra(state, type), ...objectToPayload(values, typed) };
  return omitBuiltIn(shaped, state.builtIn, typed, state.together ?? []);
}

/**
 * A group member missing from the content, taken from the built-in so the group is stored
 * whole; an accent is held to the words of the heading it will be stored with.
 */
function builtInMember(
  key: string,
  content: Row,
  builtIn: Row,
  fields: readonly FieldDef[],
): unknown {
  const value = builtIn[key];
  const accent = fields.find((f) => f.kind === 'accent' && contentKeysOf(f).includes(key));
  if (!accent?.accent) return value;
  const text = accentText(accent, {
    [accent.accent.of]: content[accent.accent.of] ?? builtIn[accent.accent.of],
  });
  if (accent.accent.mode === 'from') {
    const lang = key === accent.accent.keys.en ? 'en' : 'ar';
    const from = numberOrNull(value);
    return from === null ? undefined : clampAccent({ from }, accentWords(text[lang]).length)?.from;
  }
  const ranges = (value && typeof value === 'object' ? value : {}) as Row;
  const out: Row = {};
  for (const lang of ['en', 'ar'] as const) {
    const range = rangeToForm(ranges[lang]);
    if (range.from === null) continue;
    const held = clampAccent(
      { from: range.from, ...(range.to === null ? {} : { to: range.to }) },
      accentWords(text[lang]).length,
    );
    if (held) out[lang] = held;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Section content as DIFFERENCES from the built-in copy (F5b, ui.md §2.6
 * "sectionContent"): a key whose value is what the section already renders is not stored
 * at all, so the built-in stays the source and a later change to it reaches every page
 * that never overrode it. F6 proved `content: {}` renders the built-in, so public HTML
 * does not change — stored content only shrinks.
 *
 * `together` are the key groups the type reads only as a whole (an accent counts the
 * words of its own heading, so a stored accent without its heading would highlight the
 * built-in's words): when any key of a group is kept, every key of it is kept with it,
 * taken from the built-in when the content lacks it.
 */
export function omitBuiltIn(
  content: Row,
  builtIn: Row | undefined,
  fields: readonly FieldDef[],
  together: readonly (readonly string[])[] = [],
): Row {
  if (!builtIn) return content;
  // By the KEYS the fields write, not their names: an accent stored as two numbers
  // (accentFromEn / accentFromAr) has no key of its own name (F5b review L6).
  const edited = new Set(fields.flatMap(contentKeysOf));
  const differs = (key: string): boolean =>
    // A key no field edits (hero.intro, carried in `extra`) is never dropped: nothing in
    // the form could have put the built-in there, so it was stored on purpose.
    !edited.has(key) || !sameValue(content[key], builtIn[key]);
  const keep = new Set(Object.keys(content).filter(differs));
  const filled: Row = {};
  for (const group of together) {
    if (group.some((key) => keep.has(key))) {
      for (const key of group) {
        if (key in content) keep.add(key);
        else if (key in builtIn) {
          // A member the content lacks comes from the built-in, so what is stored is
          // what the form showed (F5b review M4); an accent is held to the new words.
          const member = builtInMember(key, content, builtIn, fields);
          if (member !== undefined) filled[key] = member;
        }
      }
    }
  }
  const out: Row = {};
  for (const [key, value] of Object.entries(content)) {
    if (keep.has(key)) out[key] = value;
  }
  return { ...out, ...filled };
}

/** The untouched stored keys to keep on save: only under the type they belong to. */
export function sectionExtra(state: SectionContentState, type: unknown): Row {
  return state.extra && state.extraType === String(type) ? state.extra : {};
}

/** One value inside a jsonb object; `undefined` means "omit the key". */
function overrideToPayload(value: unknown, field: FieldDef, siblings: Row): unknown {
  switch (field.kind) {
    case 'bilingual':
    case 'prose':
      return allBlank(value) ? undefined : value;
    // Admin v2 E10 (a Text block's body). An editor typed in and emptied holds a document with
    // one empty paragraph, which the section schema refuses ("write some text"): with no words
    // in either language the key is omitted, so a body cleared, or touched and left empty,
    // saves as no body rather than leaving the form unsaveable.
    case 'richtext': {
      const pair = (typeof value === 'object' && value !== null ? value : {}) as Row;
      return docHasWords(pair['en']) || docHasWords(pair['ar']) ? value : undefined;
    }
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    case 'checkbox':
      // A switch that is ON by default (Admin v2 U9: a social account's "Show on the site")
      // is sent only when turned off; one off by default only when turned on. Either way an
      // untouched item stays untouched (repeaterToPayload drops it).
      if (field.defaultValue === true) return value === false ? false : undefined;
      return value === true ? true : undefined;
    case 'repeater': {
      const items = repeaterToPayload(value, field);
      return items.length > 0 ? items : undefined;
    }
    case 'chips':
    case 'tags': {
      if (field.chips?.bilingual)
        return noChips(value) ? undefined : valueToPayload(value, field, siblings);
      const chips = cleanChips(value);
      return chips.length > 0 ? chips : undefined;
    }
    // F5b. An accent that writes its own key keeps it off while nothing is highlighted;
    // one that writes two numbers is spread into the parent by objectToPayload instead.
    case 'accent': {
      if (field.accent?.mode === 'from') return undefined;
      const ranges = accentToRanges(value, field, siblings);
      return Object.keys(ranges).length > 0 ? ranges : undefined;
    }
    case 'link':
      return linkIsBlank(value) ? undefined : (linkToPayload(value) ?? undefined);
    case 'slugRelation': {
      const slugs = cleanChips(value);
      return slugs.length > 0 ? slugs : undefined;
    }
    case 'object': {
      // Blank → the KEY is omitted (an untouched rating editor saves no `rating`, which
      // a strict schema needs); a half-filled object is sent as-is so the server can say
      // which part is missing.
      const shaped = objectToPayload((value ?? {}) as Row, field.itemFields ?? []);
      return Object.keys(shaped).length > 0 ? shaped : undefined;
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
    // An accent stored as two numbers writes its parent's own keys, not one of its own
    // (AccentDef mode 'from'): the one field kind whose payload is a spread.
    if (field.kind === 'accent' && field.accent?.mode === 'from') {
      Object.assign(out, accentFromKeys(values[field.name], field, values));
      continue;
    }
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

/**
 * Which form items a repeater sends, in order: entry k is the form index of the payload's
 * item k (untouched blank items are left out above). fieldErrors.ts maps the server's item
 * index back through it, so an error lands on the item the editor wrote.
 */
export function repeaterKeptIndexes(value: unknown, field: FieldDef): number[] {
  const items = Array.isArray(value) ? (value as Row[]) : [];
  const kept: number[] = [];
  items.forEach((item, index) => {
    if (Object.keys(objectToPayload(item, field.itemFields ?? [])).length > 0) kept.push(index);
  });
  return kept;
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
    case 'gallery':
      return repeaterToPayload(value, field);
    case 'object':
      return objectToPayload((value ?? {}) as Row, field.itemFields ?? []);
    case 'clip':
      return clipToPayload(value, field.label);
    // F5b. At the top level an accent writes the ranges themselves; `mode: 'from'` is a
    // section-content shape only (formToPayload spreads it, as objectToPayload does).
    case 'accent': {
      const ranges = accentToRanges(value, field, siblings);
      return Object.keys(ranges).length > 0 ? ranges : null;
    }
    case 'link':
      return linkToPayload(value);
    case 'slugRelation':
      return cleanChips(value);
    // F5a. An invalid colour is sent as typed (trimmed), so the server's refusal names the
    // field; a slider's number is held to its range (the step is the slider's to keep, on
    // the values the editor moves: a stored one nobody touched is not snapped, F5b L5).
    case 'color':
      return normalizeHex(value) ?? (isBlank(value) ? null : String(value).trim());
    case 'range':
      if (value === null || value === undefined || value === '') return null;
      return field.range ? clampToRange(value, field.range) : Number(value);
    case 'chips':
    case 'tags': {
      if (field.chips?.bilingual) {
        if (value === null || value === undefined) return null;
        const pair = (typeof value === 'object' ? value : {}) as Row;
        return { en: cleanChips(pair['en']), ar: cleanChips(pair['ar']) };
      }
      return Array.isArray(value) ? cleanChips(value) : value;
    }
    case 'sectionContent': {
      const state = (value ?? { values: {}, json: '{}' }) as SectionContentState;
      if (state.json !== null) return parseJson(state.json, field.label);
      const type = siblings[field.typeField ?? 'type'];
      const typed = sectionFields(type);
      if (!typed) return {};
      return sectionContentPayload(state, type, typed);
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

    // An accent stored as two numbers writes those two keys (objectToPayload above).
    if (field.kind === 'accent' && field.accent?.mode === 'from') {
      Object.assign(out, accentFromKeys(value, field, values));
      continue;
    }

    // Content is shaped by its type; with no type chosen ("—" = leave the type alone) the
    // content is left alone too — never wiped to {} or sent past per-type validation.
    if (field.kind === 'sectionContent' && isBlank(values[field.typeField ?? 'type'])) continue;

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
