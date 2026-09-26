import { describe, it, expect } from 'vitest';
import * as R from '@/lib/admin/resources';
import { RESOURCE_UI, SINGLETON_UI, columnOf, type FieldDef } from '@/lib/admin/uiSchema';
import type { ResourceConfig } from '@/lib/admin/resource';

// The admin is data-driven twice over: a UI descriptor (uiSchema.ts) says which fields a
// form edits, a resource config (resources.ts) says which columns the API returns and
// which keys reach SQL. Nothing but these tests keeps the two in step — and a drift is
// silent: a form field whose column the API does not return loads EMPTY, and saving the
// form writes that emptiness back over the real value.

const CONFIG: Record<string, ResourceConfig> = {
  services: R.serviceResource,
  blog: R.postResource,
  portfolio: R.portfolioResource,
  sectors: R.sectorResource,
  clients: R.clientResource,
  testimonials: R.testimonialResource,
  pages: R.pageResource,
  sections: R.sectionResource,
  navigation: R.navigationResource,
  categories: R.categoryResource,
  team: R.teamResource,
  certifications: R.certificationResource,
  statistics: R.statisticResource,
  'partner-logos': R.partnerLogoResource,
  redirects: R.redirectResource,
  media: R.mediaResource,
  themes: R.themeResource,
  'ai-questions': R.aiQuestionResource,
  'ai-styles': R.aiStyleResource,
};

/**
 * The top-level keys a PostgREST select returns: plain columns, and each embed under its
 * alias or table name (`portfolio_media(role,kind)` → `portfolio_media`). Commas inside an
 * embed's parentheses are not separators.
 */
function cols(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of list) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out.map((c) => c.trim().replace(/\(.*$/s, '').split(':')[0]!.trim());
}

/** Keys of the API response: the selected columns, plus whatever fromRow derives from them. */
function returnedKeys(config: ResourceConfig): string[] {
  const selected = cols(config.columns);
  if (!config.fromRow) return selected;
  const stub = Object.fromEntries(
    selected.map((k) => [k, config.columns.includes(`${k}(`) ? [] : null]),
  );
  return [...new Set([...selected, ...Object.keys(config.fromRow(stub))])];
}

describe('every admin resource UI has a resource config', () => {
  it('covers exactly the same slugs', () => {
    expect(new Set(Object.keys(RESOURCE_UI))).toEqual(new Set(Object.keys(CONFIG)));
  });
});

for (const [slug, ui] of Object.entries(RESOURCE_UI)) {
  const config = CONFIG[slug];
  describe(`${slug}`, () => {
    it('returns every column its form edits (else the form loads empty and saves the emptiness)', () => {
      const returned = returnedKeys(config!);
      for (const field of ui.fields) {
        expect(returned, `${slug}.${field.name} → ${columnOf(field)}`).toContain(columnOf(field));
      }
    });

    it('points every mapped constraint at a field its form actually has', () => {
      // A constraint message aimed at a field the form does not render points at nothing.
      const names = ui.fields.map((f) => f.name);
      for (const [constraint, target] of Object.entries(config!.constraintFields ?? {})) {
        if (target.field) expect(names, `${slug}: ${constraint}`).toContain(target.field);
      }
    });

    it('lists every column its table shows', () => {
      const returned = cols(config!.listColumns);
      for (const column of ui.columns) expect(returned, `${slug} list`).toContain(column.key);
    });

    it('maps every form field to a column in toRow (nothing typed is dropped on save)', () => {
      // A payload naming every field once; toRow must emit each field's column. Fields
      // the server derives (e.g. none today) would be listed here explicitly.
      const payload = Object.fromEntries(ui.fields.map((f) => [f.name, sampleFor(f)]));
      // The sample must PASS toRow's own validation (hrefs, redirects): a swallowed throw
      // here once made this check vacuous for exactly the resources that validate.
      let row: Record<string, unknown> = {};
      expect(() => {
        row = config!.toRow(payload);
      }, `${slug}: the sample payload must pass toRow validation`).not.toThrow();
      for (const field of ui.fields) {
        // Child sets are written by `persist` outside toRow (a case study's services and
        // media — one transaction); a composite may flatten into prefixed columns
        // (`preview` → preview_video_path, preview_start_s, …).
        if (config!.childKeys?.includes(field.name)) continue;
        const column = columnOf(field);
        // Only a clip flattens into prefixed columns (preview → preview_video_path, …); every
        // other field needs its exact column (`body_html` must not stand in for `body`).
        const keys = Object.keys(row);
        const written =
          field.kind === 'clip'
            ? keys.some((k) => k.startsWith(`${column}_`))
            : keys.includes(column);
        expect(written, `${slug}.${field.name} → ${column}`).toBe(true);
      }
    });
  });
}

function sampleFor(field: FieldDef): unknown {
  switch (field.kind) {
    case 'bilingual':
    case 'prose':
      return { en: 'x', ar: 'س' };
    case 'checkbox':
      return true;
    case 'number':
      return 1;
    case 'tags':
    case 'multiRelation':
    case 'multiSelect':
    case 'repeater':
      return [];
    case 'json':
    case 'richtext':
    case 'sectionContent':
      return {};
    case 'url':
      return 'https://example.test/x';
    case 'datetime':
      return '2026-01-01T00:00:00.000Z';
    case 'select':
      return field.options?.[0]?.value ?? 'x';
    case 'relation':
    case 'media':
    case 'upload':
      return '11111111-1111-4111-8111-111111111111';
    default:
      // Distinct and site-relative per field: passes sanitizeHref, and a redirect's
      // source and target differ.
      return `/${field.name}`;
  }
}

describe('field descriptors are complete for their kind', () => {
  const all: [string, readonly FieldDef[]][] = [
    ...Object.entries(RESOURCE_UI).map(([k, v]) => [k, v.fields] as [string, readonly FieldDef[]]),
    ...Object.entries(SINGLETON_UI).map(([k, v]) => [k, v.fields] as [string, readonly FieldDef[]]),
  ];
  const walk = (fields: readonly FieldDef[]): FieldDef[] =>
    fields.flatMap((f) => [f, ...walk(f.itemFields ?? [])]);

  for (const [owner, fields] of all) {
    it(`${owner}: relations, repeaters, uploads and selects carry what they need`, () => {
      for (const field of walk(fields)) {
        const where = `${owner}.${field.name}`;
        if (field.kind === 'relation' || field.kind === 'multiRelation') {
          expect(field.relation?.resource, where).toBeTruthy();
          expect(Object.keys(RESOURCE_UI), where).toContain(field.relation!.resource);
        }
        if (field.kind === 'repeater') expect(field.itemFields?.length, where).toBeGreaterThan(0);
        if (field.kind === 'upload')
          expect(field.upload?.endpoint, where).toMatch(/^\/api\/admin\//);
        if (field.kind === 'select' || field.kind === 'multiSelect') {
          expect(field.options?.length, where).toBeGreaterThan(0);
        }
        if (field.kind === 'sectionContent') {
          const typeField = field.typeField ?? 'type';
          expect(
            fields.map((f) => f.name),
            where,
          ).toContain(typeField);
        }
      }
    });
  }
});

describe('named constraints the admin explains', () => {
  it('navigation: a second key link in one menu is blamed on the key-link box', () => {
    expect(R.navigationResource.constraintFields?.['navigation_one_key_per_location']?.field).toBe(
      'isKey',
    );
  });
});
