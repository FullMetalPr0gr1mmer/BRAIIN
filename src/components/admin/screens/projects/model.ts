// The Projects list's rules (Admin v2 U6, AV-15; the prototype's route('/projects')), pure so
// they are unit-tested (tests/lib/projectEditor.spec.ts): the search over a project's name and
// type in both languages, the chips (All, Featured, one per sector the projects carry, Hidden)
// and what a row says. The list reads every project in one page (a studio's catalogue: at most
// 100 a read, the list endpoint's cap) and filters in the browser, so a search or a chip costs
// no request.

export type Row = Readonly<Record<string, unknown>> & { readonly id: string };

/** A bilingual value's text in one language, '' when it has none. */
export function textIn(value: unknown, lang: 'en' | 'ar'): string {
  if (!value || typeof value !== 'object') return '';
  const text = (value as Record<string, unknown>)[lang];
  return typeof text === 'string' ? text.trim() : '';
}

/** A project's name: its English, else its Arabic, else "Untitled project". */
export function projectName(row: Row): string {
  return textIn(row['title'], 'en') || textIn(row['title'], 'ar') || 'Untitled project';
}

/**
 * Text folded for a search: lower case, accents off, and the Arabic marks the admin's other
 * searches fold (tashkeel, the tatweel, the alef forms, ة as ه, ى as ي), so a search finds a
 * name however it was typed (§8's FTS folds the same letters).
 */
export function fold(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[آأإٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .toLowerCase()
    .trim();
}

/** Whether a project's name or type, in either language, holds the search. */
export function matchesQuery(row: Row, query: string): boolean {
  const needle = fold(query);
  if (!needle) return true;
  const hay = [
    textIn(row['title'], 'en'),
    textIn(row['title'], 'ar'),
    textIn(row['project_type'], 'en'),
    textIn(row['project_type'], 'ar'),
  ]
    .map(fold)
    .join(' ');
  return hay.includes(needle);
}

export interface Chip {
  value: string;
  label: string;
}

/** The list's chips: All, Featured, a chip per sector the projects carry (by name), Hidden. */
export function projectChips(rows: readonly Row[]): Chip[] {
  const sectors = new Map<string, string>();
  for (const row of rows) {
    const id = row['sector_id'];
    if (typeof id === 'string' && !sectors.has(id)) {
      sectors.set(id, textIn(row['sector_name'], 'en') || textIn(row['sector_name'], 'ar'));
    }
  }
  const named = [...sectors]
    .filter(([, name]) => name)
    .sort(([, a], [, b]) => a.localeCompare(b, 'en'));
  return [
    { value: 'all', label: 'All' },
    { value: 'featured', label: 'Featured' },
    ...named.map(([id, name]) => ({ value: `sector:${id}`, label: name })),
    { value: 'hidden', label: 'Hidden' },
  ];
}

/** Whether a row belongs under a chip. Hidden: not on the site (any status but published). */
export function matchesChip(row: Row, chip: string): boolean {
  if (chip === 'all') return true;
  if (chip === 'featured') return row['is_featured'] === true;
  if (chip === 'hidden') return row['status'] !== 'published';
  if (chip.startsWith('sector:')) return row['sector_id'] === chip.slice('sector:'.length);
  return true;
}

/** The rows a search and a chip leave, in the list's order. */
export function filterProjects(rows: readonly Row[], query: string, chip: string): Row[] {
  return rows.filter((row) => matchesChip(row, chip) && matchesQuery(row, query));
}

/** A row's services as their names, in the project's order, unknown ids left out. */
export function serviceNames(row: Row, names: ReadonlyMap<string, string>): string[] {
  const ids = Array.isArray(row['service_ids']) ? (row['service_ids'] as unknown[]) : [];
  return ids.flatMap((id) => {
    const name = names.get(String(id));
    return name ? [name] : [];
  });
}

/** How many projects carry each id of a column (`sector_id`, `client_id`), for Manage tags. */
export function countBy(rows: readonly Row[], column: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of rows) {
    const id = row[column];
    if (typeof id === 'string') out.set(id, (out.get(id) ?? 0) + 1);
  }
  return out;
}

/** "3 projects", "1 project", "No projects". */
export function projectsCount(n: number): string {
  if (n === 0) return 'No projects';
  return n === 1 ? '1 project' : `${n} projects`;
}
