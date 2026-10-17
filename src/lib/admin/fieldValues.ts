// The value rules of the field kit's new kinds (Admin v2 F5a): pure, shared by the field
// components (which re-export them: ColorField's normalizeHex, RangeField's clampToStep)
// and formPayload.ts (which shapes what is sent), so the control and the payload can never
// disagree. Unit-tested in tests/lib/formPayload.spec.ts and adminFields.spec.ts.

/** `#RRGGBB` (or `RRGGBB`, any case) as uppercase `#RRGGBB`; null for anything else. */
export function normalizeHex(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  const hex = raw.startsWith('#') ? raw.slice(1) : raw;
  return /^[0-9a-f]{6}$/i.test(hex) ? `#${hex.toUpperCase()}` : null;
}

export interface RangeDef {
  min: number;
  max: number;
  step: number;
}

/** Decimal places of a step (0.1 → 1), so a clamped value carries no float noise. */
function places(step: number): number {
  const text = String(step);
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}

/** A number held inside [min, max] and onto the step grid that starts at min. */
export function clampToStep(value: unknown, range: RangeDef): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return range.min;
  const within = Math.min(range.max, Math.max(range.min, n));
  if (!(range.step > 0)) return within;
  const steps = Math.round((within - range.min) / range.step);
  const snapped = Math.min(range.max, range.min + steps * range.step);
  return Number(snapped.toFixed(places(range.step)));
}

/**
 * A number held inside [min, max] only, NOT moved onto the step grid (F5b review L5). What
 * a save sends and what the field reads out: the slider snaps a value the editor moves
 * (clampToStep), but a stored value nobody touched, such as an interval of 7250 under a
 * 500 step, is valid for the schema and goes back exactly as it came.
 */
export function clampToRange(value: unknown, range: RangeDef): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return range.min;
  return Math.min(range.max, Math.max(range.min, n));
}

/** A chip list as sent: each trimmed, blanks dropped, the first of each duplicate kept. */
export function cleanChips(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const chip = String(item ?? '').trim();
    if (chip !== '' && !out.includes(chip)) out.push(chip);
  }
  return out;
}

/** Splits typed text into chips at commas: `'a, b,'` → `['a', 'b']`, plus what is left. */
export function splitChips(text: string): { chips: string[]; rest: string } {
  const parts = text.split(',');
  const rest = parts.pop() ?? '';
  return { chips: parts.map((p) => p.trim()).filter((p) => p !== ''), rest };
}
