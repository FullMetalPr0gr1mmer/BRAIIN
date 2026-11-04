import { FONT_SCRIPTS, type FontFamily } from '@theme/fonts';
import { heroFile, matchWeight, type FamilyFaces, type FallbackFace } from '@theme/fontFaces';

// The rules every family of the font catalogue must pass (Admin v2 E13; CLAUDE.md §6;
// docs/fonts.md "The catalogue"), as one pure function over a catalogue, so the spec can run it
// on the real one (no problem) and on families built to break each rule (that rule's problem).
// The numbers a family carries (its size-adjust and overrides) are measured, and only their
// shape (a percentage) is checked here: docs/fonts.md 2b and 2c say how to measure them, and
// the layout-shift and consent-banner e2e suites and the themed Lighthouse run measure the result.

/** KB as the font budgets count it (fonts.spec.ts, lighthouserc: 180 KB = 184,320 B). */
export const KB = 1024;
export const HERO_BUDGET = { latin: 35 * KB, arabic: 45 * KB } as const;
export const ROUTE_BUDGET = 180 * KB;
/** The weights a theme sets headings in (E12: Extra bold, Bold): each must be a real face. */
export const HEADING_WEIGHTS = [800, 700] as const;
/** The local fonts the fallbacks were measured on, per platform (docs/fonts.md 2b, 2c). */
const ARIAL = /^Arial/;
const LINUX = /^(Liberation ?Sans|DejaVu ?Sans)/;

// The characters each string the renderer writes may hold (E13 security review L1). The faces
// are written unchanged into /styles/theme.css, which the releases preview also puts in
// BaseLayout's nonced `<style>`: no string may close a quote, a descriptor, the rule or the
// element. The `:root` rule's guard is the token patterns; this is the faces' guard, run over
// the very table the renderer reads (fontCatalogue.spec.ts), so a family with any other
// character cannot ship.
/** A family's name, a fallback family's name, a local() font's name: quoted by the renderer. */
export const FACE_NAME = /^[A-Za-z0-9 -]+$/;
/** A unicode-range: U+hex or U+hex-hex, comma separated. */
export const UNICODE_RANGE =
  /^U\+[0-9A-Fa-f]{1,6}(?:-[0-9A-Fa-f]{1,6})?(?:, ?U\+[0-9A-Fa-f]{1,6}(?:-[0-9A-Fa-f]{1,6})?)*$/;
/** size-adjust, the three overrides and a variable font's pinned width (font-stretch). */
export const PERCENT = /^[0-9]+(?:\.[0-9]+)?%$/;

export interface CatalogueInput {
  families: readonly FontFamily[];
  faces: Readonly<Record<string, FamilyFaces | undefined>>;
  /** A file's size in bytes, or null when it does not exist. */
  sizeOf: (file: string) => number | null;
  /** The weights the public stylesheets paint text at (fontCatalogue.spec.ts reads them). */
  siteWeights: readonly number[];
}

const families = (stack: string) => stack.split(',').map((s) => s.trim().replace(/'/g, ''));

const weightsOf = (faces: FamilyFaces) => faces.web.map((f) => f.weight);
const isVariable = (faces: FamilyFaces) => faces.web.some((f) => typeof f.weight !== 'number');

/** Every rule a family breaks, in words ([] for none). */
export function catalogueProblems(input: CatalogueInput): string[] {
  const out: string[] = [];
  const ids = new Set<string>();
  for (const script of FONT_SCRIPTS) {
    const brands = input.families.filter((f) => f.script === script && f.brand);
    if (brands.length !== 1) out.push(`${script}: ${brands.length} brand families, not one`);
  }
  for (const family of input.families) {
    const say = (what: string) => out.push(`${family.id}: ${what}`);
    if (ids.has(family.id)) say('the id is taken');
    ids.add(family.id);
    if (!/^[a-z][a-z-]*$/.test(family.id)) say('the id is not lower case letters and hyphens');
    if (!family.licence.name.trim() || !family.licence.notice.trim()) say('no licence');
    if (!/^[A-Za-z0-9 ',-]+$/.test(family.stack)) say('the stack holds other characters');
    if (!FACE_NAME.test(family.name)) say('the name holds other characters');
    const faces = input.faces[family.id];
    if (!faces) {
      say('no faces');
      continue;
    }

    // Web faces: self-hosted woff2, swap (the renderer writes it), within the budgets.
    if (faces.web.length === 0) say('no web face');
    for (const face of faces.web) {
      if (!/^\/fonts\/[a-z0-9-]+\.woff2$/.test(face.file)) say(`${face.file} is not under /fonts/`);
      else if (input.sizeOf(face.file) === null) say(`${face.file} does not exist`);
      if (!face.unicodeRange.trim()) say(`${face.file} has no unicode-range`);
      else if (!UNICODE_RANGE.test(face.unicodeRange)) {
        say(`${face.file}: the unicode-range is not a list of U+ ranges`);
      }
      if (face.stretch !== undefined && !PERCENT.test(face.stretch)) {
        say(`${face.file}: the stretch is not a percentage`);
      }
    }

    // Fallback faces: every string the renderer writes, to its descriptor's characters.
    for (const face of faces.fallbacks) {
      const at = `the ${face.family} ${face.weight ?? 400} ${face.subset} fallback`;
      if (!FACE_NAME.test(face.family)) say(`${at}: the family holds other characters`);
      if (face.local.length === 0) say(`${at} names no local font`);
      for (const local of face.local) {
        if (!FACE_NAME.test(local)) say(`${at}: a local font name holds other characters`);
      }
      const numbers = [
        face.sizeAdjust,
        face.ascentOverride,
        face.descentOverride,
        face.lineGapOverride,
      ];
      if (!numbers.every((n) => PERCENT.test(n))) {
        say(`${at}: a size or override is not a percentage`);
      }
      if (face.unicodeRange !== undefined && !UNICODE_RANGE.test(face.unicodeRange)) {
        say(`${at}: the unicode-range is not a list of U+ ranges`);
      }
    }
    const own = faces.web.filter((f) => f.subset === family.script);
    if (own.length === 0) say(`no ${family.script} web face`);
    if (family.script === 'arabic' && !faces.web.some((f) => f.subset === 'latin')) {
      say('an Arabic family has no Latin subset for the Latin words in Arabic copy');
    }

    // The headings a theme offers are real faces (never synthetic bold).
    for (const weight of HEADING_WEIGHTS) {
      const real = own.some((f) =>
        typeof f.weight === 'number'
          ? f.weight === weight
          : weight >= f.weight[0] && weight <= f.weight[1],
      );
      if (!real) say(`no real ${weight} face`);
    }

    // Hero files: within the hero budget, at every heading weight a route names.
    const budget = HERO_BUDGET[family.script];
    for (const weight of [600, 700, 800]) {
      if (own.length === 0) break;
      const file = heroFile(family, weight, faces);
      const size = input.sizeOf(file);
      if (size !== null && size > budget) say(`the hero file ${file} is ${size} B, over ${budget}`);
    }

    // The stack: the family, then its fallback families, each declared.
    const named = families(family.stack);
    const fallbackFamilies = [...new Set(faces.fallbacks.map((f) => f.family))];
    if (named[0] !== family.name) say(`the stack does not start with ${family.name}`);
    if (named.slice(1, 1 + fallbackFamilies.length).join('|') !== fallbackFamilies.join('|')) {
      say('the stack does not name its fallback families right after the family');
    }

    // Fallbacks: per weight, per script for an Arabic family, and on both platforms.
    const weights = isVariable(faces)
      ? [...new Set(input.siteWeights)].sort((a, b) => a - b)
      : [...new Set(weightsOf(faces) as number[])].sort((a, b) => a - b);
    const scripts =
      family.script === 'arabic' ? (['latin', 'arabic'] as const) : (['latin'] as const);
    for (const weight of weights) {
      for (const subset of scripts) {
        const at = faces.fallbacks.filter(
          (f) => (f.weight ?? 400) === weight && f.subset === subset,
        );
        const on = (platform: RegExp) =>
          at.some((f: FallbackFace) => f.local.some((l) => platform.test(l)));
        if (!on(ARIAL)) say(`no Arial fallback at ${weight} for ${subset}`);
        if (!on(LINUX)) say(`no Linux fallback at ${weight} for ${subset}`);
      }
    }
    for (const face of faces.fallbacks) {
      if (face.subset === 'arabic' && !face.unicodeRange) {
        say(`the ${face.family} ${face.weight ?? 400} Arabic fallback has no unicode-range`);
      }
      if (face.subset === 'arabic' && face.local.some((l) => /^Liberation/.test(l))) {
        say(`the ${face.family} Arabic fallback names Liberation Sans, which has no Arabic`);
      }
    }
    // A static family's site weights resolve to its own faces in the fallback too: every
    // weight the site paints matches the same weight in both.
    if (!isVariable(faces)) {
      const fallbackWeights = [...new Set(faces.fallbacks.map((f) => f.weight ?? 400))];
      for (const weight of input.siteWeights) {
        const web = matchWeight(weight, weightsOf(faces));
        const fb = matchWeight(weight, fallbackWeights);
        if (web !== fb) say(`${weight} renders at ${web} but its fallback at ${fb}`);
      }
    }
  }

  // Every route within the font budget. A route is set in its page's family (the public
  // stylesheets name no family but through the two stacks: fontCatalogue.spec.ts): an English
  // route can load every file of its Latin family; an Arabic route every file of its Arabic
  // family and of any family its stack names (Almarai's names Archivo, after its fallbacks).
  const bytes = (f: FontFamily) =>
    (input.faces[f.id]?.web ?? []).reduce((sum, face) => sum + (input.sizeOf(face.file) ?? 0), 0);
  for (const family of input.families) {
    const also =
      family.script === 'arabic'
        ? input.families.filter((f) => f !== family && families(family.stack).includes(f.name))
        : [];
    const total = bytes(family) + also.reduce((sum, f) => sum + bytes(f), 0);
    if (total > ROUTE_BUDGET) {
      out.push(`${family.id}: a route set in it loads ${total} B, over ${ROUTE_BUDGET}`);
    }
  }
  return out;
}
