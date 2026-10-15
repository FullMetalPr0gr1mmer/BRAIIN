import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ROLE_CAPS, type Capability } from '@/lib/authz/matrix';
import { ROLES } from '@/lib/auth/types';
import { RESOURCES } from '@/lib/admin/resources';
import { ENTITY_SEO } from '@/lib/admin/entitySeo';
import { siteProfileSingleton } from '@/lib/admin/singletons/siteProfile';
import { seoDefaultsSingleton } from '@/lib/admin/singletons/seoDefaults';
import { CONTENT_AREAS, RELEASE_ENTITY_META } from '@/lib/release/areas';
import {
  RELEASE_REGISTRY,
  registryByTable,
  registryEntry,
  type RegistryEntry,
} from '@/lib/release/registry';
import { RELEASE_ENTITY_TYPES, type ReleaseEntityType } from '@schemas/release';
import {
  RELEASE_LEDGER_SQL,
  foldRegistry,
  registryInserts,
  registryRows,
} from '../fixtures/releaseRegistry';

// The TypeScript release registry equals app.release_entities (Admin v2 R2).
//
// src/lib/release/registry.ts mirrors the SQL registry row for row; the apply (R4) refuses
// a column outside the SQL allowlist with 22023, so a drift between the two would surface
// as a failed publish in production. This reads EVERY migration's registry rows (a later
// one replacing an earlier one for the same type) and fails on any type, table, key, area,
// order, flag or column that differs: a slice whose migration adds a registry row (U7's
// FAQ, U14's page visibility, E3, E5, E8) must add its TypeScript entry with it.

const sorted = (list: readonly string[]) => [...list].sort();
const holders = (cap: Capability) => ROLES.filter((role) => ROLE_CAPS[role][cap] === 'full').sort();
const entries = Object.values(RELEASE_REGISTRY);
const rows = registryRows();

describe('the TypeScript registry has exactly the SQL registry types', () => {
  it('the same types as app.release_entities and RELEASE_ENTITY_TYPES', () => {
    expect(sorted(Object.keys(RELEASE_REGISTRY))).toEqual(sorted(rows.map((r) => r.entityType)));
    expect(sorted(Object.keys(RELEASE_REGISTRY))).toEqual(sorted(RELEASE_ENTITY_TYPES));
    expect(sorted(Object.keys(RELEASE_ENTITY_META))).toEqual(sorted(RELEASE_ENTITY_TYPES));
  });

  it('each entry is keyed by its own type, and found by its table', () => {
    for (const [type, entry] of Object.entries(RELEASE_REGISTRY)) {
      expect(entry.entityType).toBe(type);
      expect(registryEntry(type as ReleaseEntityType)).toBe(entry);
      expect(registryByTable(entry.table)).toBe(entry);
    }
    expect(registryByTable('media_assets')).toBeUndefined();
    expect(registryByTable('ai_questions')).toBeUndefined();
  });
});

for (const row of rows) {
  describe(row.entityType, () => {
    const entry = RELEASE_REGISTRY[row.entityType as ReleaseEntityType];

    it('table, key, area, apply order, status and go-live flag equal the SQL row', () => {
      expect(entry.table).toBe(row.table);
      expect(entry.key).toBe(row.keyColumn);
      expect(entry.area).toBe(row.area);
      expect(entry.applyOrder).toBe(row.applyOrder);
      expect(entry.hasStatus).toBe(row.hasStatus);
      expect(entry.publishFlag).toBe(row.publishFlag);
    });

    it('the writable allowlist equals the SQL columns', () => {
      expect(sorted(entry.columns)).toEqual(sorted(row.columns));
    });

    it('deferred columns, unique flags and immediate (exempt) columns equal the SQL row', () => {
      expect(sorted(entry.deferredColumns)).toEqual(sorted(row.deferredColumns));
      expect(sorted(entry.uniqueFlags)).toEqual(sorted(row.uniqueFlags));
      expect(sorted(entry.immediateColumns)).toEqual(sorted(row.exemptColumns));
    });

    it('its author capability is held by exactly the SQL author roles', () => {
      expect(holders(entry.authorCaps[0]!)).toEqual(sorted(row.authorRoles));
    });

    it('its remove capability is held by exactly the SQL delete roles', () => {
      expect(entry.removeCap === null ? [] : holders(entry.removeCap)).toEqual(
        sorted(row.deleteRoles),
      );
    });
  });
}

/** The capability the entity's editor requires to write, wherever its config lives. */
function editorWriteCap(entry: RegistryEntry): Capability {
  if (entry.resource) return entry.resource.writeCap;
  if (entry.singleton) return entry.singleton.writeCap;
  return entry.entitySeo!.writeCap;
}

describe('each entry is bound to the config its editor uses', () => {
  it('resources by `entity`; the singletons and entity SEO by their modules', () => {
    for (const entry of entries) {
      if (entry.kind === 'resource') {
        expect(entry.resource!.entity).toBe(entry.entityType);
        expect(Object.values(RESOURCES)).toContain(entry.resource);
      }
    }
    expect(RELEASE_REGISTRY.site_profile.singleton).toBe(siteProfileSingleton);
    expect(RELEASE_REGISTRY.seo_defaults.singleton).toBe(seoDefaultsSingleton);
    expect(RELEASE_REGISTRY.entity_seo.entitySeo).toBe(ENTITY_SEO);
  });

  it('every resource config of a registry type is in the registry, and only those', () => {
    const bound = new Set(entries.map((e) => e.resource).filter(Boolean));
    const unbound = Object.values(RESOURCES)
      .filter((config) => !bound.has(config))
      .map((config) => config.entity)
      .sort();
    // Immediate by decision (P-3): media (binaries and metadata) and the deferred quiz.
    expect(unbound).toEqual(['ai_question', 'ai_style', 'media_asset']);
  });

  it('the first author capability is the write capability its editor requires', () => {
    for (const entry of entries) expect(entry.authorCaps[0]).toBe(editorWriteCap(entry));
  });

  it('content areas need content.publish too; the others their own capability only', () => {
    for (const entry of entries) {
      if (CONTENT_AREAS.includes(entry.area)) {
        expect(entry.authorCaps).toEqual([editorWriteCap(entry), 'content.publish']);
      } else {
        expect(entry.authorCaps).toEqual([editorWriteCap(entry)]);
      }
    }
  });

  it('a resource is removed with the capability its DELETE route requires', () => {
    for (const entry of entries) {
      if (entry.kind !== 'resource') {
        expect(entry.removeCap).toBeNull();
        continue;
      }
      expect(entry.removeCap).toBe(entry.resource!.deleteCap ?? 'content.archiveDelete');
    }
  });

  it('read capabilities are the editor’s own', () => {
    for (const entry of entries) {
      const config = entry.resource ?? entry.singleton;
      if (config) {
        expect(entry.readCaps).toEqual(config.readCaps ?? [config.writeCap]);
      }
    }
    expect(RELEASE_REGISTRY.entity_seo.readAccess).toEqual(['full', 'view']);
  });

  it('`fields` is the bound config’s own map', () => {
    for (const entry of entries) {
      const own = entry.resource?.fields ?? entry.singleton?.fields ?? entry.entitySeo?.fields;
      expect(entry.fields).toBe(own);
    }
  });

  it('child keys are the config’s (portfolio: its services and media)', () => {
    for (const entry of entries) {
      expect(entry.childKeys).toEqual(entry.resource?.childKeys ?? []);
    }
    expect(RELEASE_REGISTRY.portfolio.childRowKeys).toEqual({
      serviceIds: 'service_ids',
      media: 'media',
    });
  });
});

describe('cache tags and labels', () => {
  const SAMPLE_ROW = {
    id: '0f0f0f0f-0000-4000-8000-00000000000a',
    slug: 'sample',
    name: { en: 'Sample', ar: 'عينة' },
    title: { en: 'Sample', ar: 'عينة' },
    label: { en: 'Sample', ar: 'عينة' },
    author_name: { en: 'Sample', ar: 'عينة' },
    type: 'richText',
    entity_type: 'service',
    source_path: '/old',
    target_path: '/new',
  };
  const UNTAGGED = ['entity_seo', 'page_section', 'redirect'];

  it('every type tags its own row, except the three whose tags R7 resolves or never needs', () => {
    for (const entry of entries) {
      const tags = entry.entityTags(SAMPLE_ROW);
      if (UNTAGGED.includes(entry.entityType)) expect(tags, entry.entityType).toEqual([]);
      else expect(tags.length, entry.entityType).toBeGreaterThan(0);
      for (const tag of tags) expect(tag).toMatch(/^[a-z_]+:[a-z0-9_-]+$/);
    }
    expect(RELEASE_REGISTRY.page_section.tagParent).toEqual({
      entityType: 'page',
      column: 'page_id',
    });
    expect(RELEASE_REGISTRY.entity_seo.tagTarget).toBe(true);
  });

  it('slugged rows tag their own page as well as the collection', () => {
    expect(RELEASE_REGISTRY.service.entityTags(SAMPLE_ROW)).toEqual([
      'service:sample',
      'services:all',
    ]);
    expect(RELEASE_REGISTRY.portfolio.entityTags(SAMPLE_ROW)).toEqual([
      'portfolio:sample',
      'portfolio:all',
    ]);
    expect(RELEASE_REGISTRY.blog_post.entityTags(SAMPLE_ROW)).toEqual(['blog:sample', 'blog:all']);
    expect(RELEASE_REGISTRY.page.entityTags(SAMPLE_ROW)).toEqual(['page:sample']);
    expect(RELEASE_REGISTRY.service.entityTags(null)).toEqual(['services:all']);
    expect(RELEASE_REGISTRY.discipline.entityTags(null)).toEqual([
      'disciplines:all',
      'services:all',
    ]);
    expect(RELEASE_REGISTRY.site_profile.entityTags(null)).toEqual(['site:identity']);
    expect(RELEASE_REGISTRY.nav_item.entityTags(null)).toEqual(['nav:all']);
  });

  it('every type has a label, from the row or a fallback', () => {
    for (const entry of entries) {
      expect(entry.label(SAMPLE_ROW).en.length, entry.entityType).toBeGreaterThan(0);
      expect(entry.label({}).en.length, entry.entityType).toBeGreaterThan(0);
    }
    expect(RELEASE_REGISTRY.service.label(SAMPLE_ROW)).toEqual({ en: 'Sample', ar: 'عينة' });
    expect(RELEASE_REGISTRY.redirect.label(SAMPLE_ROW)).toEqual({ en: '/old → /new' });
  });
});

describe('apply order', () => {
  // Every `*_id` column a release may write, and what it points at: another registry type
  // (applied before it, or a self-reference set in the deferred second pass), or a table
  // outside the registry (immediate, so it exists before any release). A new link column
  // fails here until it is classified.
  const LINKS: Record<string, ReleaseEntityType | 'outside'> = {
    'services.discipline_id': 'discipline',
    'service_cases.service_id': 'service',
    'service_cases.portfolio_id': 'portfolio',
    'portfolio.sector_id': 'sector',
    'portfolio.client_id': 'client',
    'portfolio.next_portfolio_id': 'portfolio',
    'testimonials.client_id': 'client',
    'testimonials.portfolio_id': 'portfolio',
    'blog_posts.author_id': 'team_member',
    'blog_posts.category_id': 'category',
    'page_sections.page_id': 'page',
    'navigation.parent_id': 'nav_item',
    // A target of any of four types: entity_seo applies after every one of them.
    'entity_seo.entity_id': 'outside',
    // media_assets and profiles are not release-managed.
    'services.poster_media_id': 'outside',
    'disciplines.poster_media_id': 'outside',
    'portfolio.poster_media_id': 'outside',
    'clients.logo_media_id': 'outside',
    'testimonials.avatar_media_id': 'outside',
    'team_members.portrait_media_id': 'outside',
    'team_members.profile_user_id': 'outside',
  };

  it('every link column is classified', () => {
    const links = entries.flatMap((e) =>
      e.columns.filter((c) => c.endsWith('_id')).map((c) => `${e.table}.${c}`),
    );
    expect(sorted(links)).toEqual(sorted(Object.keys(LINKS)));
  });

  it('a row applies after what it points at; a self-reference is deferred', () => {
    for (const [link, target] of Object.entries(LINKS)) {
      if (target === 'outside') continue;
      const [table, column] = link.split('.') as [string, string];
      const from = registryByTable(table)!;
      const to = RELEASE_REGISTRY[target];
      if (from === to) expect(from.deferredColumns, link).toContain(column);
      else expect(from.applyOrder, link).toBeGreaterThan(to.applyOrder);
    }
  });

  it('entity SEO applies after each type it can describe', () => {
    for (const target of ['service', 'blog_post', 'portfolio', 'page'] as const) {
      expect(RELEASE_REGISTRY.entity_seo.applyOrder).toBeGreaterThan(
        RELEASE_REGISTRY[target].applyOrder,
      );
    }
    expect(ENTITY_SEO.LookupSchema.shape.entityType.options.sort()).toEqual(
      ['blog_post', 'page', 'portfolio', 'service'].sort(),
    );
  });
});

describe('the registry stays on the server', () => {
  // Walks the real import graph (R2 review L6): from every hydrated island and client
  // script, through relative, aliased and dynamic imports in either quote style, the
  // registry and the overlay are never reached. Type-only imports are erased by the
  // compiler and not followed.
  const ROOT = process.cwd().replaceAll(String.fromCharCode(92), '/');
  const EXTENSIONS = ['', '.ts', '.tsx', '.mjs', '.js', '.astro', '/index.ts', '/index.tsx'];
  const ALIASES: Record<string, string> = {
    '@/': 'src/',
    '@schemas/': 'packages/schemas/',
    '@consent/': 'packages/consent/',
  };

  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = `${dir}/${name}`;
      return statSync(path).isDirectory() ? files(path) : [path];
    });
  }

  /** The module specifiers a source imports at runtime (static, side-effect, dynamic). */
  function specifiers(source: string): string[] {
    const out: string[] = [];
    const patterns = [
      /\b(?:import|export)\s+(?!type\b)(?:[^'"`;]*?\s)?from\s*(['"])([^'"]+)\1/g,
      /\bimport\s*(['"])([^'"]+)\1/g,
      /\bimport\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g,
    ];
    for (const pattern of patterns) for (const m of source.matchAll(pattern)) out.push(m[2]!);
    return out;
  }

  function resolve(from: string, spec: string): string | null {
    const clean = spec.replace(/\?.*$/, '');
    let base: string | null = null;
    for (const [alias, dir] of Object.entries(ALIASES)) {
      if (clean.startsWith(alias)) base = `${ROOT}/${dir}${clean.slice(alias.length)}`;
    }
    if (clean.startsWith('.')) {
      const parts = `${from.slice(0, from.lastIndexOf('/'))}/${clean}`.split('/');
      const stack: string[] = [];
      for (const part of parts) {
        if (part === '..') stack.pop();
        else if (part !== '.') stack.push(part);
      }
      base = stack.join('/');
    }
    if (base === null) return null; // a package
    for (const ext of EXTENSIONS) {
      const path = base + ext;
      try {
        if (statSync(path).isFile()) return path;
      } catch {
        // try the next extension
      }
    }
    return null;
  }

  /** Every file reachable from the roots; an .astro root contributes its <script> blocks. */
  function reach(roots: readonly string[]): Set<string> {
    const seen = new Set<string>();
    const queue = [...roots];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      let source = readFileSync(file, 'utf8');
      if (file.endsWith('.astro')) {
        source = [...source.matchAll(/<script(?![^>]*is:inline)[^>]*>([\s\S]*?)<\/script>/g)]
          .map((m) => m[1])
          .join('\n');
      }
      for (const spec of specifiers(source)) {
        const target = resolve(file, spec);
        if (target) queue.push(target);
      }
    }
    return seen;
  }

  const FORBIDDEN = [`${ROOT}/src/lib/release/registry.ts`, `${ROOT}/src/lib/release/overlay.ts`];

  it('reads imports in every form the build follows', () => {
    const src = [
      `import x from "../lib/release/registry";`,
      `import './side-effect';`,
      `export { y } from '@/lib/release/overlay';`,
      'const lazy = () => import(`./lazy`);',
      `const other = import("@schemas/release");`,
      `import type { T } from '@/lib/release/registry';`,
    ].join('\n');
    expect(specifiers(src).sort()).toEqual(
      [
        '../lib/release/registry',
        './side-effect',
        '@/lib/release/overlay',
        './lazy',
        '@schemas/release',
      ].sort(),
    );
  });

  it('follows the graph (caps.ts reaches areas.ts and the role matrix)', () => {
    const seen = reach([`${ROOT}/src/lib/release/caps.ts`]);
    expect(seen).toContain(`${ROOT}/src/lib/release/areas.ts`);
    expect(seen).toContain(`${ROOT}/src/lib/authz/matrix.ts`);
    // and that the walk would see the registry where it is imported
    expect(reach([`${ROOT}/src/lib/release/registry.ts`])).toContain(
      `${ROOT}/src/lib/admin/resources/services.ts`,
    );
  });

  it('no island, component or client script reaches the registry or the overlay', () => {
    const roots = [
      ...files(`${ROOT}/src/components`).filter((f) => /\.(tsx|ts|astro)$/.test(f)),
      ...files(`${ROOT}/src/lib/admin/client`),
      ...files(`${ROOT}/src/pages`).filter((f) => f.endsWith('.astro')),
      ...files(`${ROOT}/src/layouts`).filter((f) => f.endsWith('.astro')),
    ];
    expect(roots.some((f) => /islands\/AdminResourceForm\.tsx$/.test(f))).toBe(true);
    const seen = reach(roots);
    expect(seen.size).toBeGreaterThan(roots.length);
    expect(FORBIDDEN.filter((f) => seen.has(f))).toEqual([]);
  });

  it('areas.ts and caps.ts import nothing server-side (an island may import them)', () => {
    const allowed = new Set([
      '@/lib/authz/matrix',
      '@/lib/auth/types',
      '@schemas/release',
      './areas',
    ]);
    for (const file of ['areas.ts', 'caps.ts']) {
      const source = readFileSync(`${ROOT}/src/lib/release/${file}`, 'utf8');
      const all = [...source.matchAll(/from\s*(['"])([^'"]+)\1/g)].map((m) => m[2]!);
      expect(
        all.filter((i) => !allowed.has(i)),
        file,
      ).toEqual([]);
      expect(
        specifiers(source).filter((i) => !allowed.has(i)),
        file,
      ).toEqual([]);
    }
  });
});

describe('the registry fixture reads every registry write, or fails', () => {
  const HEAD =
    'insert into app.release_entities\n  (entity_type, table_name, key_column, area, author_roles, delete_roles, columns,\n   deferred_columns, unique_flags, exempt_columns, apply_order, has_status, publish_flag)\nvalues\n';
  const row = (type: string, order: number) =>
    `  ('${type}', '${type}s', 'id', 'pages', '{admin}', '{}', '{a,b}', '{}', '{}', '{}', ${order}, false, null)`;
  const insert = (rows: string[], conflict = 'do nothing') =>
    `${HEAD}${rows.join(',\n')}\non conflict (entity_type) ${conflict};`;

  it('0038 parses into exactly its twenty value tuples', () => {
    const [only, ...rest] = registryInserts(RELEASE_LEDGER_SQL, '0038');
    expect(rest).toEqual([]);
    expect(only!.rows).toHaveLength(20);
    expect(only!.onConflict).toBe('nothing');
  });

  it('`do nothing` keeps the first row; `do update` replaces it', () => {
    const first = { file: 'a', sql: insert([row('x', 10)]) };
    const ignored = { file: 'b', sql: insert([row('x', 20)]) };
    const replaced = {
      file: 'c',
      sql: insert([row('x', 30)], 'do update set apply_order = excluded.apply_order'),
    };
    expect(foldRegistry([first, ignored]).map((r) => r.applyOrder)).toEqual([10]);
    expect(foldRegistry([first, ignored, replaced]).map((r) => r.applyOrder)).toEqual([30]);
  });

  it('refuses a registry write it cannot read', () => {
    const refused = [
      "update app.release_entities set columns = '{a}' where entity_type = 'x';",
      "delete from app.release_entities where entity_type = 'x';",
      'truncate app.release_entities;',
      'alter table app.release_entities add column note text;',
      insert([row('x', 10).replace("'{}', '{}', '{}', 10", "NULL, '{}', '{}', 10")]),
      insert([row('x', 10).replace("'{a,b}'", "ARRAY['a','b']")]),
      insert([row('x', 10).replace("'{a,b}'", "'{a,b}'::text[]")]),
      insert([row('x', 10)]).replace('entity_type, table_name', 'table_name, entity_type'),
      `${HEAD}${row('x', 10)};`,
    ];
    for (const sql of refused) expect(() => foldRegistry([{ file: 'z', sql }]), sql).toThrow();
  });

  it('allows the registry’s own RLS switches', () => {
    const sql =
      'alter table app.release_entities enable row level security;\nalter table app.release_entities force row level security;';
    expect(foldRegistry([{ file: 'z', sql }])).toEqual([]);
  });
});
