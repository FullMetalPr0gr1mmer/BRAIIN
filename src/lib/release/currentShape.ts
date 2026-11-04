import { upgradeThemeSettings } from '@theme/shapes';

// Stored values in today's shape, for COMPARING only (Admin v2 E12 code review CR5). SERVER
// ONLY. A later schema can read a stored column in a newer shape that means the same thing: a
// theme's settings saved before E12 are v1 and before E13 v2, which today's save writes as v3 at
// the brand's shapes, type and fonts. A pending change is derived by today's `toRow`, so it
// always holds the new shape, while a live row, a change's base, a ledger image or a history
// snapshot can still hold the old one. Every release-lane comparison of a stored value with a
// derived one (or of two stored images) reads both through here, so the same meaning is the
// same value:
//   • a pending change's no-op check (overlay.ts `dropNoOps`: equal to live and to its base);
//   • a version's field list (versions.ts `versionDetail`: before and after);
//   • a restore's columns that moved (revert.ts) and its round trip (rowPayload.ts).
// Never what is WRITTEN or RECORDED: a base keeps the stored value as it was, because
// apply_release (0051) compares a base with the live column, typed, and an upgraded base would
// be a conflict there. The conflict checks (overlay.ts `conflicts`) compare a base with live as
// stored for the same reason, so the admin shows the conflict the database will find.

type Row = Record<string, unknown>;

/** Per registry entity, the stored columns a later schema reads in a newer shape. */
export const UPGRADED_COLUMNS: Readonly<
  Record<string, Readonly<Record<string, (stored: unknown) => unknown>>>
> = {
  custom_theme: { settings: upgradeThemeSettings },
};

/** One stored column's value in today's shape (anything not upgraded, as it is). */
export function columnInCurrentShape(entityType: string, column: string, value: unknown): unknown {
  const upgrade = UPGRADED_COLUMNS[entityType]?.[column];
  return upgrade ? upgrade(value) : value;
}

/**
 * A stored row (or image, or base) with each upgraded column in today's shape: a copy when one
 * changes, the same object otherwise. For comparing only, never for writing (above).
 */
export function inCurrentShape<T extends Readonly<Row> | null | undefined>(
  entityType: string,
  row: T,
): T {
  const upgrades = UPGRADED_COLUMNS[entityType];
  if (!upgrades || !row) return row;
  let out: Row | null = null;
  for (const [column, upgrade] of Object.entries(upgrades)) {
    if (!(column in row)) continue;
    const next = upgrade(row[column]);
    if (next === row[column]) continue;
    out ??= { ...row };
    out[column] = next;
  }
  return (out ?? row) as T;
}
