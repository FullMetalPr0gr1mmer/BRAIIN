import type { Accent } from '@schemas/media';
import type { Locale } from '@schemas/primitives';
import {
  TEMPLATE_COPY_KEYS,
  templateCopyKeySchema,
  type TemplateCopyKey,
  type TemplateKind,
} from '@schemas/templateCopy';
import { SERVICE_PAGE_COPY, VALUE_ACCENT, type ServicePageCopy } from '@/lib/services/pageCopy';
import {
  BREAKDOWN_ACCENT,
  CASE_PAGE_COPY,
  GALLERY_ACCENT,
  type CasePageCopy,
} from '@/lib/portfolio/pageCopy';

// The template pages' words as a page renders them (Admin v2 E3): the built-in words (the
// code's, src/lib/services/pageCopy.ts and src/lib/portfolio/pageCopy.ts) with the stored
// differences (`public.template_copy`, packages/schemas/templateCopy.ts) laid over them, key by
// key. Pure and never throwing: a stored key that does not parse (written around the Worker, or
// left by an older catalogue) costs that key its built-in words, never the page, and a key the
// catalogue does not know is ignored. With nothing stored every word is the built-in one, so the
// page renders the bytes it did before E3 (tests/render/templatePages.spec.ts).
//
// An accented heading: words stored for it take the accent stored beside them (none stored: no
// accent); the built-in words take the built-in accent, unless an accent alone is stored, which
// then colours the built-in words (F5b's rule for an accent kept without its heading).

type Row = Record<string, unknown>;

/** The service page's words in both languages, and its one accented heading's accent. */
export interface ServiceCopy {
  en: ServicePageCopy;
  ar: ServicePageCopy;
  valueAccent: Accent | undefined;
}

/** The case study's words in both languages, and its two accented headings' accents. */
export interface CaseCopy {
  en: CasePageCopy;
  ar: CasePageCopy;
  breakdownAccent: Accent | undefined;
  galleryAccent: Accent | undefined;
}

/** Each key of a stored map that parses on its own; everything else is dropped. */
export function parseStoredCopy(kind: TemplateKind, stored: unknown): Row {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
  const out: Row = {};
  const keys = TEMPLATE_COPY_KEYS[kind] as Readonly<Record<string, TemplateCopyKey>>;
  for (const [key, value] of Object.entries(stored as Row)) {
    const def = keys[key];
    if (!def) continue;
    const parsed = templateCopyKeySchema(def).safeParse(value);
    if (parsed.success) out[key] = parsed.data;
  }
  return out;
}

/** The words of one template: the built-in ones per language, each stored line over its key. */
function overlay<C extends object>(
  kind: TemplateKind,
  map: Row,
  builtIn: Record<Locale, C>,
): Record<Locale, C> {
  const en: Row = { ...(builtIn.en as Row) };
  const ar: Row = { ...(builtIn.ar as Row) };
  const keys = TEMPLATE_COPY_KEYS[kind] as Readonly<Record<string, TemplateCopyKey>>;
  for (const [key, def] of Object.entries(keys)) {
    if (def.kind !== 'text') continue;
    const line = map[key] as { en: string; ar: string } | undefined;
    if (!line) continue;
    en[key] = line.en;
    ar[key] = line.ar;
  }
  return { en: en as C, ar: ar as C };
}

/** An accent key's accent, by the rule above. */
function accentOf(
  map: Row,
  accentKey: string,
  heading: string,
  builtIn: Accent,
): Accent | undefined {
  const stored = map[accentKey] as Accent | undefined;
  if (stored) return stored;
  return map[heading] ? undefined : builtIn;
}

/** The service page template's words, from its stored map (`template_copy.service`). */
export function serviceCopyFrom(stored: unknown): ServiceCopy {
  const map = parseStoredCopy('service', stored);
  return {
    ...overlay('service', map, SERVICE_PAGE_COPY),
    valueAccent: accentOf(map, 'valueHeadingAccent', 'valueHeading', VALUE_ACCENT),
  };
}

/** The project page template's words, from its stored map (`template_copy.project`). */
export function caseCopyFrom(stored: unknown): CaseCopy {
  const map = parseStoredCopy('project', stored);
  return {
    ...overlay('project', map, CASE_PAGE_COPY),
    breakdownAccent: accentOf(map, 'breakdownHeadingAccent', 'breakdownHeading', BREAKDOWN_ACCENT),
    galleryAccent: accentOf(map, 'galleryHeadingAccent', 'galleryHeading', GALLERY_ACCENT),
  };
}

/** The built-in words of both templates (no row): what a page renders when nothing is stored. */
export const BUILT_IN_SERVICE_COPY: ServiceCopy = serviceCopyFrom(null);
export const BUILT_IN_CASE_COPY: CaseCopy = caseCopyFrom(null);

/**
 * One template's built-in words in the catalogue's shape, key by key: a text key's `{en, ar}`,
 * an accent key's accent. What the editor shows under a blank field (handed to the island as
 * props, so the words never ride in the admin bundle) and what its specs hold the keys to.
 */
export function builtInTemplateCopy(kind: TemplateKind): Row {
  const words: Record<Locale, object> = kind === 'service' ? SERVICE_PAGE_COPY : CASE_PAGE_COPY;
  const accents: Record<string, Accent> =
    kind === 'service'
      ? { valueHeadingAccent: VALUE_ACCENT }
      : { breakdownHeadingAccent: BREAKDOWN_ACCENT, galleryHeadingAccent: GALLERY_ACCENT };
  const out: Row = {};
  const keys = TEMPLATE_COPY_KEYS[kind] as Readonly<Record<string, TemplateCopyKey>>;
  for (const [key, def] of Object.entries(keys)) {
    if (def.kind === 'accent') {
      out[key] = accents[key];
      continue;
    }
    out[key] = {
      en: (words.en as Row)[key],
      ar: (words.ar as Row)[key],
    };
  }
  return out;
}
