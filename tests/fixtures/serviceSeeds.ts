import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ServiceDetailRow, ServiceRow } from '@schemas/content';
import type { Discipline } from '@/lib/data/disciplines';

// The Round 2 catalogue exactly as the seeds carry it (supabase/seed-data/08-disciplines.json
// and 10-services.json — the mockup's 5 disciplines × 28 services), turned into the row
// shapes the public loaders return. Tests built on it follow the real data rather than a
// hand-copied list that could drift from it.

interface SeedRef {
  $ref: { table: string; by: { slug: string } };
}
interface SeedDiscipline {
  slug: string;
  name: { en: string; ar: string };
  short: { en: string; ar: string } | null;
  blurb: { en: string; ar: string } | null;
  sort_order: number;
}
interface SeedService {
  slug: string;
  title: { en: string; ar: string };
  short_title?: { en: string; ar: string } | null;
  blurb: { en: string; ar?: string } | null;
  intro: { en: string; ar: string } | null;
  body: { en?: unknown; ar?: unknown } | null;
  body_html: { en: string; ar?: string } | null;
  value_points: ServiceRow['value_points'];
  deliverables: ServiceRow['deliverables'];
  discipline_id: SeedRef;
  preview_video_path: string | null;
  preview_start_s: number | null;
  preview_end_s: number | null;
  sort_order: number;
}

const seed = <T>(file: string): T[] =>
  (
    JSON.parse(readFileSync(join(process.cwd(), 'supabase', 'seed-data', file), 'utf8')) as {
      blocks: { rows: T[] }[];
    }
  ).blocks[0]!.rows;

export const SEED_DISCIPLINES = seed<SeedDiscipline>('08-disciplines.json');
export const SEED_SERVICES = seed<SeedService>('10-services.json');

const uuid = (prefix: string, n: number) =>
  `${prefix}000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const disciplineId = (slug: string) =>
  uuid('0d', SEED_DISCIPLINES.findIndex((d) => d.slug === slug) + 1);
export const serviceId = (slug: string) =>
  uuid('5e', SEED_SERVICES.findIndex((s) => s.slug === slug) + 1);

/** A seeded service as getPublishedServices returns it (no poster: the stills are not loaded). */
export function seedServiceRow(s: SeedService): ServiceRow {
  return {
    id: serviceId(s.slug),
    slug: s.slug,
    title: s.title,
    short_title: s.short_title ?? null,
    blurb: s.blurb,
    body_html: s.body_html,
    hero_video_uid: null,
    category: null,
    is_teaser: false,
    sort_order: s.sort_order,
    updated_at: '2026-09-27T08:00:00Z',
    discipline_id: disciplineId(s.discipline_id.$ref.by.slug),
    intro: s.intro,
    value_points: s.value_points,
    deliverables: s.deliverables,
    preview_video_path: s.preview_video_path,
    preview_start_s: s.preview_start_s,
    preview_end_s: s.preview_end_s,
    poster: null,
  };
}

/** A seeded service as getServiceBySlug returns it: + its Tiptap body and discipline. */
export function seedServiceDetailRow(slug: string): ServiceDetailRow {
  const s = SEED_SERVICES.find((x) => x.slug === slug);
  if (!s) throw new Error(`no seeded service ${slug}`);
  const d = SEED_DISCIPLINES.find((x) => x.slug === s.discipline_id.$ref.by.slug)!;
  return {
    ...seedServiceRow(s),
    body: s.body,
    discipline: { slug: d.slug, name: d.name, sort_order: d.sort_order },
  };
}

export const seedServiceRows = (): ServiceRow[] => SEED_SERVICES.map(seedServiceRow);

/** The published disciplines with their services, as getPublishedDisciplines returns them. */
export function seedDisciplines(): Discipline[] {
  const rows = seedServiceRows();
  return SEED_DISCIPLINES.map((d) => ({
    id: disciplineId(d.slug),
    slug: d.slug,
    name: d.name,
    short: d.short,
    blurb: d.blurb,
    sortOrder: d.sort_order,
    updatedAt: null,
    poster: null,
    clip: { path: '/media/showreel.mp4', startS: 5.9, endS: 7.9 },
    services: rows
      .filter((r) => r.discipline_id === disciplineId(d.slug))
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((r) => ({
        id: r.id,
        slug: r.slug,
        title: r.title,
        label: r.short_title ?? r.title,
        tagline: r.blurb,
        intro: r.intro,
        disciplineId: r.discipline_id,
        sortOrder: r.sort_order,
        updatedAt: r.updated_at,
        poster: null,
        clip: null,
      })),
  }));
}
