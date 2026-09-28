import type { ServiceRow } from '@/lib/data/services';
import type { Discipline } from '@/lib/data/disciplines';

// The services as the discovery files list them (Round 2). Pure, so the grouping is
// unit-tested without a database.

/**
 * The service lines, grouped by discipline in its order: a `### Branding` heading, then
 * its services in theirs. The list is the sitemap's (getPublishedServices — every page
 * that answers 200); the disciplines only name and order the groups. A service with no
 * published discipline (not yet placed in one) is listed after them under "Other
 * services", and with no disciplines at all (a failed read) the list is flat — a service
 * is never dropped because its group could not be named.
 */
export function llmsServiceLines(
  services: readonly ServiceRow[],
  disciplines: readonly Discipline[],
  site: string,
): string[] {
  const line = (s: ServiceRow) => `- ${s.title.en} — ${site}/services/${s.slug}`;
  if (disciplines.length === 0) return services.map(line);
  const known = new Set(disciplines.map((d) => d.id));
  const groups = disciplines
    .map((d) => ({ name: d.name.en, rows: services.filter((s) => s.discipline_id === d.id) }))
    .filter((g) => g.rows.length > 0);
  const other = services.filter((s) => !s.discipline_id || !known.has(s.discipline_id));
  if (other.length > 0) groups.push({ name: 'Other services', rows: other });
  return groups.flatMap((g, i) => [...(i > 0 ? [''] : []), `### ${g.name}`, ...g.rows.map(line)]);
}
