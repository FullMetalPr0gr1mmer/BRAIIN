// The Forms editor's model (Admin v2 E8): pure, Zod-free (it ships in the admin client bundle),
// over the stored config of ONE form (`form_settings.inquiry` or `.application`), which holds
// only what differs from the built-in form (packages/schemas/forms.ts). Every change goes
// through `normalise`, so what is saved stays the smallest difference: a label equal to the
// built-in one, or blank in both languages, is no override; "shown" is stored only when off,
// "required" only when on; an order equal to the built-in one is not stored. The server parses
// the result with the strict schema (FormSettingsWriteSchema), so nothing here is trusted.

export type Bilingual = { en: string; ar: string };
type Row = Record<string, unknown>;

/** One field as the editor knows it (built server-side from the code, passed as a prop). */
export interface FieldMeta {
  key: string;
  /** The built-in label the visitor reads now. */
  label: Bilingual;
  /** May be hidden or required (the pipeline's fields may only be relabelled). */
  optional: boolean;
  /** The Join form's group (about, role, work); none for the inquiry form. */
  group?: string | undefined;
  /** Where the field is asked, when not every place asks it ("Contact and services pages"). */
  where?: string | undefined;
}

/** One field's editable state. */
export interface FieldState {
  label: Bilingual;
  visible: boolean;
  required: boolean;
}

const isRecord = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v);

/** The stored form from the save's value (a JSON string, as the kit loads a json field). */
export function parseStored(value: unknown): Row {
  if (isRecord(value)) return value;
  if (typeof value !== 'string' || value.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** The form as the save carries it: the kit's json field takes text. */
export function serialise(config: Row): string {
  return JSON.stringify(config, null, 2);
}

const bilingualOf = (v: unknown): Bilingual | null =>
  isRecord(v) && typeof v['en'] === 'string' && typeof v['ar'] === 'string'
    ? { en: v['en'], ar: v['ar'] }
    : null;

/** A field's state: the stored override over the built-in field. */
export function fieldState(config: Row, meta: FieldMeta): FieldState {
  const fields = isRecord(config['fields']) ? config['fields'] : {};
  const o = isRecord(fields[meta.key]) ? (fields[meta.key] as Row) : {};
  return {
    label: bilingualOf(o['label']) ?? { en: '', ar: '' },
    visible: !meta.optional || o['visible'] !== false,
    required: !meta.optional || (o['visible'] !== false && o['required'] === true),
  };
}

/** A bilingual override, or none: blank in both languages, or the built-in words. */
function copyOverride(value: Bilingual, builtIn: Bilingual): Bilingual | null {
  const en = value.en.trim();
  const ar = value.ar.trim();
  if (en === '' && ar === '') return null;
  if (en === builtIn.en && ar === builtIn.ar) return null;
  return { en: value.en, ar: value.ar };
}

/** One field changed: the config with the field's override as small as it can be. */
export function withField(config: Row, meta: FieldMeta, next: FieldState): Row {
  const fields: Row = isRecord(config['fields']) ? { ...config['fields'] } : {};
  const o: Row = {};
  const label = copyOverride(next.label, meta.label);
  if (label) o['label'] = label;
  if (meta.optional) {
    if (!next.visible) o['visible'] = false;
    else if (next.required) o['required'] = true;
  }
  if (Object.keys(o).length > 0) fields[meta.key] = o;
  else delete fields[meta.key];
  return withPart(config, 'fields', Object.keys(fields).length > 0 ? fields : null);
}

/** A top-level part set, or removed when null. */
export function withPart(config: Row, key: string, value: unknown): Row {
  const out: Row = { ...config };
  if (value === null || value === undefined) delete out[key];
  else out[key] = value;
  return out;
}

/** The button text, or the built-in one. */
export function withButton(config: Row, value: Bilingual, builtIn: Bilingual): Row {
  return withPart(config, 'button', copyOverride(value, builtIn));
}

/** A copy part of a keyed map (`budgets`, `consent`): set, or removed with the map when empty. */
export function withKeyedCopy(
  config: Row,
  part: 'budgets' | 'consent',
  key: string,
  value: Bilingual,
  builtIn: Bilingual,
): Row {
  const map: Row = isRecord(config[part]) ? { ...config[part] } : {};
  const o = copyOverride(value, builtIn);
  if (o) map[key] = o;
  else delete map[key];
  return withPart(config, part, Object.keys(map).length > 0 ? map : null);
}

/** A keyed copy's stored words, or blank. */
export function keyedCopy(config: Row, part: 'budgets' | 'consent', key: string): Bilingual {
  const map = isRecord(config[part]) ? config[part] : {};
  return bilingualOf(map[key]) ?? { en: '', ar: '' };
}

/** The stored button, or blank. */
export function buttonCopy(config: Row): Bilingual {
  return bilingualOf(config['button']) ?? { en: '', ar: '' };
}

/** A list in the stored order when it is a whole permutation of `builtIn`, else as built. */
function orderOrBuiltIn(stored: unknown, builtIn: readonly string[]): string[] {
  if (
    Array.isArray(stored) &&
    stored.length === builtIn.length &&
    new Set(stored).size === stored.length &&
    stored.every((k) => typeof k === 'string' && builtIn.includes(k))
  ) {
    return stored as string[];
  }
  return [...builtIn];
}

/**
 * The fields' order: the inquiry form's one list (`order`), or one group's of the Join form
 * (`order.<group>`).
 */
export function orderOf(config: Row, builtIn: readonly string[], group?: string): string[] {
  const stored = group
    ? isRecord(config['order'])
      ? (config['order'] as Row)[group]
      : undefined
    : config['order'];
  return orderOrBuiltIn(stored, builtIn);
}

/** One field moved up (-1) or down (+1) in its list; the ends stay put. */
export function moved(order: readonly string[], key: string, step: -1 | 1): string[] {
  const out = [...order];
  const at = out.indexOf(key);
  const to = at + step;
  if (at < 0 || to < 0 || to >= out.length) return out;
  [out[at], out[to]] = [out[to]!, out[at]!];
  return out;
}

/** The config with a new order (stored only when it differs from the built-in one). */
export function withOrder(
  config: Row,
  order: readonly string[],
  builtIn: readonly string[],
  group?: string,
): Row {
  const same = order.length === builtIn.length && order.every((k, i) => k === builtIn[i]);
  if (!group) return withPart(config, 'order', same ? null : [...order]);
  const groups: Row = isRecord(config['order']) ? { ...config['order'] } : {};
  if (same) delete groups[group];
  else groups[group] = [...order];
  return withPart(config, 'order', Object.keys(groups).length > 0 ? groups : null);
}

/** A half-written pair (one language filled, the other blank): the server refuses it. */
export function halfWritten(value: Bilingual): boolean {
  return (value.en.trim() === '') !== (value.ar.trim() === '');
}

/** A JSON value as text with every object's keys sorted: equal values, equal text. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Whether the config rewords either Join consent line. */
export function rewordsConsent(config: Row): boolean {
  const map = isRecord(config['consent']) ? config['consent'] : {};
  return Object.keys(map).length > 0;
}

/**
 * What the next version is counted against: the live lines in release mode (the read carries
 * them as `live_consent`, since the row it holds is the pending change and the database counts
 * a rewording once, when the change is published), else the saved config, which is live.
 */
export function consentBase(saved: Row, liveConsent: unknown): Row {
  return liveConsent === undefined ? saved : { consent: liveConsent };
}

/**
 * The consent version a reworded form will post once this config is saved (or, in release
 * mode, published, with `savedConfig` from consentBase): the notice's date,
 * plus `.r<N>` (N the database's count of rewordings, one more when the saved lines change).
 */
export function nextConsentVersion(
  notice: string,
  savedRevision: number,
  savedConfig: Row,
  config: Row,
): string {
  if (!rewordsConsent(config)) return notice;
  // Compared as the database compares jsonb (`is distinct from`): by value, whatever the keys'
  // order (jsonb stores them shortest first, so a loaded row's order is not the editor's).
  const changed =
    canonical(savedConfig['consent'] ?? null) !== canonical(config['consent'] ?? null);
  const revision = savedRevision + (changed ? 1 : 0);
  return revision > 0 ? `${notice}.r${revision}` : notice;
}
