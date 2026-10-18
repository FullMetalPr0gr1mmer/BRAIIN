import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACTIVITY_KINDS } from '@schemas/audit';
import { RELEASE_ENTITY_TYPES } from '@schemas/release';
import {
  actionsOfKind,
  changedFields,
  describe as describeRow,
  hasLabel,
  KERNEL_ENTITIES,
  KERNEL_SAVES,
  KERNEL_VERBS,
  KIND_BADGE,
  KIND_CHIPS,
  kindFilter,
  MAX_FIELDS,
  prefixesOfKind,
  sentence,
  SINGLETON_ENTITIES,
  type ActivityRow,
} from '@/lib/admin/auditLabels';
import { DENIED_TITLE_TYPES, hasTitleSource } from '@/lib/admin/auditTitles';
import { RESOURCES } from '@/lib/admin/resources';
import { RESOURCE_UI } from '@/lib/admin/ui';

// The activity log's words (Admin v2 U13, src/lib/admin/auditLabels.ts). Held to the code
// that writes the log: every action written in src/ and in the migrations has an entry (a
// new action without words fails here, so the log never shows a raw key); the kinds the
// chips filter on are disjoint; every resource has a noun; the copy keeps the client's rules
// (README P-12: no em or en dash, the brand never spelled, CLAUDE.md §1); and a row shows
// field NAMES, never values, whatever its detail holds.

const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

function walk(dir: string): string[] {
  return (readdirSync(join(ROOT, dir), { recursive: true, encoding: 'utf8' }) as string[])
    .map((f) => f.replaceAll('\\', '/'))
    .filter((f) => /\.(ts|tsx|astro)$/.test(f))
    .map((f) => `${dir}/${f}`);
}

/** An action key: plain words joined by dots (the registry's own shape). */
const ACTION = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/**
 * Every action a file passes as `action:` (writeAudit, the route kernel's audit(), the
 * service role's writeAuthAudit), as string literals: a ternary's two sides included, a
 * template's (the kernel's `${config.entity}.create`) left to the kernel's own check below.
 */
function actionsWrittenIn(source: string): string[] {
  const out: string[] = [];
  for (const line of source.split('\n')) {
    const m = /(?:^|[\s{,(])action:\s*(.*)$/.exec(line);
    if (!m) continue;
    for (const lit of (m[1] ?? '').matchAll(/'([^'\\]*)'/g)) {
      if (ACTION.test(lit[1] ?? '')) out.push(lit[1]!);
    }
  }
  return out;
}

const SRC_ACTIONS = [
  ...new Set(walk('src').flatMap((file) => actionsWrittenIn(read(file)))),
].sort();

/** The literal actions the migrations insert into audit_log themselves (definers, triggers). */
const SQL_ACTIONS = (() => {
  const out = new Set<string>();
  for (const file of readdirSync(join(ROOT, 'supabase/migrations')).filter((f) =>
    f.endsWith('.sql'),
  )) {
    const sql = read(`supabase/migrations/${file}`).replace(/--[^\n]*/g, '');
    for (const m of sql.matchAll(/insert\s+into\s+public\.audit_log\b([\s\S]*?);/gi)) {
      for (const lit of (m[1] ?? '').matchAll(/'([^']*)'/g)) {
        if (ACTION.test(lit[1] ?? '')) out.add(lit[1]!);
      }
    }
  }
  return [...out].sort();
})();

/** The entities the per-tenant settings rows audit under (singletonRoutes' configs). */
const SINGLETONS_IN_CODE = [
  ...new Set(
    walk('src')
      .map(read)
      .filter((source) => /\bsingletonRoutes\(|\bSingletonConfig\b/.test(source))
      .flatMap((source) => [...source.matchAll(/\bentity:\s*'([a-z_]+)'/g)].map((m) => m[1]!)),
  ),
].sort();

const row = (action: string, extra: Partial<ActivityRow> = {}): ActivityRow => ({
  id: 1,
  actor_id: null,
  actor_role: null,
  action,
  entity_type: null,
  entity_id: null,
  detail: {},
  created_at: '2026-10-15T09:00:00Z',
  ...extra,
});

describe('every action the admin writes has words', () => {
  it('finds the actions it checks (the scan is not vacuous)', () => {
    expect(SRC_ACTIONS).toEqual(
      expect.arrayContaining([
        'lead.view_pii',
        'export.csv.attempt',
        'maintenance.enable',
        'maintenance.disable',
        'user.deactivate',
        'user.update',
        'auth.password_reset_requested',
        'export.activity.outcome',
      ]),
    );
    expect(SRC_ACTIONS.length).toBeGreaterThan(40);
    expect(SQL_ACTIONS).toEqual(
      expect.arrayContaining([
        'profile.update',
        'placeholder_override.grant',
        'placeholder_override.revoke',
      ]),
    );
  });

  it.each(SRC_ACTIONS)('src: %s', (action) => {
    expect(hasLabel(action)).toBe(true);
  });

  it.each(SQL_ACTIONS)('migrations: %s', (action) => {
    expect(hasLabel(action)).toBe(true);
  });

  it('the resource kernel: every entity, every verb', () => {
    const entities = Object.values(RESOURCES).map((config) => config.entity);
    expect([...KERNEL_ENTITIES.keys()].sort()).toEqual([...new Set(entities)].sort());
    for (const entity of entities) {
      for (const verb of KERNEL_VERBS) expect(hasLabel(`${entity}.${verb}`), entity).toBe(true);
    }
    // The kernel writes exactly these (src/lib/admin/resource.ts, and its staged branch,
    // src/lib/release/staged.ts, Admin v2 R3).
    const kernel = read('src/lib/admin/resource.ts') + read('src/lib/release/staged.ts');
    const written = [...kernel.matchAll(/action:\s*`\$\{config\.entity\}\.([a-z_]+)`/g)].map(
      (m) => m[1],
    );
    expect([...new Set(written)].sort()).toEqual([...KERNEL_VERBS].sort());
  });

  it('the settings rows: every singleton the code configures', () => {
    expect(SINGLETONS_IN_CODE.length).toBeGreaterThanOrEqual(5);
    expect([...SINGLETON_ENTITIES].sort()).toEqual(SINGLETONS_IN_CODE);
    for (const entity of SINGLETONS_IN_CODE)
      expect(hasLabel(`${entity}.update`), entity).toBe(true);
    expect(read('src/lib/admin/singleton.ts')).toMatch(/action:\s*`\$\{config\.entity\}\.update`/);
  });

  it('a release (R4 writes release.publish) is a publish, known by its prefix', () => {
    expect(hasLabel('release.publish')).toBe(true);
    const d = describeRow(row('release.publish', { detail: { number: 15 } }));
    expect([d.kind, sentence(d)]).toEqual(['publishing', 'Published version 15']);
    expect(sentence(describeRow(row('release.rollback')))).toBe('Published a version');
  });
});

describe('the kinds', () => {
  const fixed = Object.fromEntries(
    [...ACTIVITY_KINDS, 'other' as const].map((kind) => [kind, actionsOfKind(kind)]),
  );

  it('are disjoint: no action has two kinds, and a save is told apart by its status only', () => {
    const all = Object.values(fixed).flat();
    expect(new Set(all).size).toBe(all.length);
    for (const save of KERNEL_SAVES) expect(all).not.toContain(save);
    for (const kind of [...ACTIVITY_KINDS, 'other' as const]) {
      for (const prefix of prefixesOfKind(kind)) {
        const others = all.filter((a) => a.startsWith(prefix));
        expect(others, prefix).toEqual([]);
      }
    }
  });

  it('follow the brief: leads, users and settings by their families; applications under All', () => {
    expect(fixed['leads']).toEqual(
      expect.arrayContaining(['lead.view_pii', 'crm.erase.outcome', 'export.csv.attempt']),
    );
    expect(fixed['users']).toEqual(
      expect.arrayContaining(['user.invite', 'profile.update', 'auth.login']),
    );
    expect(fixed['settings']).toEqual(
      expect.arrayContaining([
        'site_profile.update',
        'maintenance.enable',
        'logs.clear',
        'export.backup.attempt',
        'export.activity.outcome',
      ]),
    );
    expect(fixed['edits']).toEqual(
      expect.arrayContaining(['entity_seo.update', 'page.visibility', 'service.delete']),
    );
    expect(fixed['other']).toEqual(
      expect.arrayContaining(['application.view', 'application.cv_download']),
    );
    for (const action of fixed['other'] ?? []) expect(action).toMatch(/^application\./);
  });

  it('each chip names a kind, in the prototype’s order, and each kind has a badge', () => {
    expect(KIND_CHIPS.map((c) => c.kind)).toEqual([...ACTIVITY_KINDS]);
    expect(KIND_CHIPS.map((c) => c.label)).toEqual([
      'Edits',
      'Publishing',
      'Leads',
      'Users',
      'Settings',
    ]);
    for (const kind of [...ACTIVITY_KINDS, 'other' as const]) {
      expect(KIND_BADGE[kind].label.length).toBeGreaterThan(0);
    }
  });

  it('a save is a publish when it moved the item to published or scheduled', () => {
    const cases: [Record<string, unknown>, string, string][] = [
      [{ fields: ['title'] }, 'edits', 'Updated the service'],
      [{ status: 'published', previousStatus: 'draft' }, 'publishing', 'Published the service'],
      [{ status: 'scheduled', previousStatus: 'draft' }, 'publishing', 'Scheduled the service'],
      [{ status: 'archived', previousStatus: 'published' }, 'edits', 'Archived the service'],
      [{ status: 'draft', previousStatus: 'published' }, 'edits', 'Unpublished the service'],
      [{ status: 'draft', previousStatus: 'archived' }, 'edits', 'Restored the service'],
    ];
    for (const [detail, kind, words] of cases) {
      const d = describeRow(row('service.update', { entity_type: 'service', detail }));
      expect([d.kind, sentence(d)], JSON.stringify(detail)).toEqual([kind, words]);
    }
    const created = describeRow(row('blog_post.create', { detail: { status: 'published' } }));
    expect([created.kind, sentence(created)]).toEqual(['publishing', 'Published the post']);
    const drafted = describeRow(row('blog_post.create', { detail: { status: 'draft' } }));
    expect([drafted.kind, sentence(drafted)]).toEqual(['edits', 'Added the post']);
  });

  it('a pending change (releases on, Admin v2 R3) is an edit until it is published', () => {
    const cases: [string, Record<string, unknown>, string][] = [
      [
        'service.draft_save',
        { op: 'update', fields: ['title'] },
        'Saved unpublished changes to the service',
      ],
      [
        'service.draft_save',
        { op: 'create', status: 'published' },
        'Saved unpublished changes to the service',
      ],
      [
        'service.draft_save',
        { op: 'delete', replaced: [] },
        'Saved an unpublished removal of the service',
      ],
      [
        'service.draft_save',
        { op: 'reorder', count: 3 },
        'Saved an unpublished new order for Services',
      ],
      [
        'service.draft_discard',
        { op: 'update', reason: 'no-op' },
        'Threw away unpublished changes to the service',
      ],
    ];
    for (const [action, detail, words] of cases) {
      const d = describeRow(row(action, { entity_type: 'service', detail }));
      expect([d.kind, sentence(d)], JSON.stringify(detail)).toEqual(['edits', words]);
    }
  });

  it('every release-managed type: its pending changes saved, thrown away and settled (R3b)', () => {
    // The draft endpoints and the staged singletons write `${type}.draft_*` by template, which
    // the literal scan above cannot see, so every type is checked here.
    for (const type of RELEASE_ENTITY_TYPES) {
      for (const verb of ['draft_save', 'draft_discard', 'draft_resolve']) {
        expect(hasLabel(`${type}.${verb}`), `${type}.${verb}`).toBe(true);
        expect(describeRow(row(`${type}.${verb}`)).kind, `${type}.${verb}`).toBe('edits');
      }
    }
    const cases: [string, Partial<ActivityRow>, string][] = [
      [
        'site_profile.draft_save',
        { entity_type: 'site_profile', detail: { op: 'update', fields: ['brand_name'] } },
        'Saved unpublished changes to the public identity',
      ],
      [
        'seo_defaults.draft_discard',
        { entity_type: 'seo_defaults', detail: { op: 'update', reason: 'no-op' } },
        'Threw away unpublished changes to the global SEO defaults',
      ],
      [
        'entity_seo.draft_save',
        { entity_type: 'entity_seo', detail: { op: 'create', target: 'service' } },
        'Saved unpublished changes to the search details of the service',
      ],
      [
        'service.draft_resolve',
        { entity_type: 'service', detail: { keepMine: ['title'], useLive: [] } },
        'Settled a conflict on the service',
      ],
      [
        'drafts.discard_bulk',
        { detail: { count: 3, scope: 'mine', types: ['service'], draftIds: [] } },
        'Threw away several unpublished changes',
      ],
    ];
    for (const [action, extra, words] of cases) {
      expect(sentence(describeRow(row(action, extra))), action).toBe(words);
    }
    // Entity SEO's pending change is titled by its target, as its save is.
    const seo = describeRow(
      row('entity_seo.draft_save', {
        entity_type: 'entity_seo',
        entity_id: '11111111-1111-4111-8111-111111111111',
        detail: { op: 'update', target: 'service' },
      }),
    );
    expect(seo.titleRef).toEqual({ type: 'service', id: '11111111-1111-4111-8111-111111111111' });
  });

  it('the intake switch is a setting, in words that say which way it went (R3b)', () => {
    const open = describeRow(row('site_profile.intake', { detail: { open: true } }));
    const closed = describeRow(row('site_profile.intake', { detail: { open: false } }));
    expect([open.kind, sentence(open)]).toEqual(['settings', 'Opened job applications']);
    expect([closed.kind, sentence(closed)]).toEqual(['settings', 'Closed job applications']);
    expect(SRC_ACTIONS).toEqual(
      expect.arrayContaining([
        'site_profile.intake',
        'drafts.discard_bulk',
        'entity_seo.draft_save',
        'entity_seo.draft_discard',
      ]),
    );
  });

  it('every resource whose saves carry a status reads the stored row on a PATCH, so a move is known', () => {
    for (const config of Object.values(RESOURCES)) {
      if (!config.statusOf) continue;
      expect(
        Boolean(config.assertPublishable || config.assertWritable),
        `${config.entity} has a status but no publish or write rule`,
      ).toBe(true);
    }
  });
});

describe('the chips’ SQL', () => {
  it('uses only plain keys, so nothing in the filter needs quoting', () => {
    for (const kind of ACTIVITY_KINDS) {
      const filter = kindFilter(kind);
      for (const list of filter.matchAll(/action\.in\.\(([^)]*)\)/g)) {
        for (const action of (list[1] ?? '').split(',')) expect(action).toMatch(ACTION);
      }
      expect(filter).not.toMatch(/["'\s]/);
    }
  });

  it('Publishing: its fixed actions, releases, and the kernel’s saves with a publishing status', () => {
    const filter = kindFilter('publishing');
    expect(filter).toContain('action.like.release.*');
    expect(filter).toContain(
      `and(action.in.(${KERNEL_SAVES.join(',')}),detail->>status.in.(published,scheduled))`,
    );
    expect(KERNEL_SAVES).toEqual(expect.arrayContaining(['service.update', 'portfolio.create']));
  });

  it('Edits: the kernel’s saves with no status or another one, and the edits that are not saves', () => {
    const filter = kindFilter('edits');
    expect(filter).toContain(
      `and(action.in.(${KERNEL_SAVES.join(',')}),or(detail->>status.is.null,detail->>status.not.in.(published,scheduled)))`,
    );
    expect(filter).toMatch(/^action\.in\.\([^)]*media_asset\.upload[^)]*\)/);
  });

  it('Leads, Users and Settings: exactly their actions', () => {
    for (const kind of ['leads', 'users', 'settings'] as const) {
      expect(kindFilter(kind)).toBe(`action.in.(${actionsOfKind(kind).join(',')})`);
    }
  });
});

describe('the words', () => {
  const samples: ActivityRow[] = [];
  for (const action of [...SRC_ACTIONS, ...SQL_ACTIONS]) {
    for (const detail of [
      {},
      { status: 'ok' },
      { status: 'failed' },
      { status: 'partial' },
      { navVisible: false },
      { target: 'service' },
    ]) {
      samples.push(row(action, { detail }));
    }
  }
  for (const entity of KERNEL_ENTITIES.keys()) {
    for (const verb of KERNEL_VERBS) samples.push(row(`${entity}.${verb}`));
  }

  it('keep the client’s copy rules: no em or en dash, the brand never spelled', () => {
    for (const sample of samples) {
      const text = sentence(describeRow(sample), 'A title');
      expect(text, sample.action).not.toMatch(/[–—]/);
      expect(text.toLowerCase(), sample.action).not.toMatch(/braii?n|statii?on/);
      expect(text, sample.action).toMatch(/^[A-Z]/);
    }
  });

  it('name every resource by its editor’s own word', () => {
    for (const [slug, config] of Object.entries(RESOURCES)) {
      const singular = RESOURCE_UI[slug]?.singular;
      expect(singular, slug).toBeTruthy();
      expect(KERNEL_ENTITIES.get(config.entity)?.noun).toBe(
        `the ${singular!.charAt(0).toLowerCase()}${singular!.slice(1)}`,
      );
    }
  });

  it('an action the registry does not know reads as its words, or not at all', () => {
    const known = describeRow(row('lead.frobnicate'));
    expect([known.kind, sentence(known)]).toEqual(['other', 'Did lead frobnicate']);
    for (const action of ['<script>alert(1)</script>', 'x'.repeat(300), 'Lead.View', '']) {
      const d = describeRow(row(action));
      expect(sentence(d)).toBe('Did something the log cannot describe');
      expect(d.kind).toBe('other');
    }
  });

  it('a row whose detail is not an object still reads', () => {
    for (const detail of [null, 'text', 3, ['fields']]) {
      expect(() => describeRow(row('service.update', { detail }))).not.toThrow();
    }
  });
});

describe('the changed fields: names, never values', () => {
  it('names the editor’s labels, else the column in words; leaves out what it cannot read', () => {
    expect(
      changedFields({
        entity_type: 'service',
        detail: { fields: ['title', 'body_html', 'published_at', 'Bad Key', 42, 'x;drop'] },
      }),
    ).toEqual(['Service name', 'Published at']);
    expect(
      changedFields({ entity_type: 'lead', detail: { fields: ['stage_id', 'value_sar'] } }),
    ).toEqual(['Stage', 'Value (SAR)']);
  });

  it('never shows a value, whatever the detail holds', () => {
    const d = describeRow(
      row('lead.update', {
        entity_type: 'lead',
        detail: { email: 'sara@acme.example', fields: ['tags'], status: 'sara@acme.example' },
      }),
    );
    expect(JSON.stringify(d)).not.toContain('sara@acme.example');
    expect(d.fields).toEqual(['Tags']);
  });

  it('a long list ends "and N more"', () => {
    const fields = Array.from({ length: 20 }, (_, i) => `field_${i}`);
    const out = changedFields({ entity_type: null, detail: { fields } });
    expect(out).toHaveLength(MAX_FIELDS);
    expect(out.at(-1)).toBe(`and ${20 - (MAX_FIELDS - 1)} more`);
  });
});

describe('titles: allowlisted types only, never people or their data', () => {
  it('no denied type can be titled', () => {
    for (const type of DENIED_TITLE_TYPES) expect(hasTitleSource(type), type).toBe(false);
  });

  it('a lead, a note, an application or a profile row asks for no title', () => {
    const rows: ActivityRow[] = [
      row('lead.view_pii', {
        entity_type: 'lead',
        entity_id: '11111111-1111-4111-8111-111111111111',
      }),
      row('lead.update', {
        entity_type: 'lead',
        entity_id: '11111111-1111-4111-8111-111111111111',
      }),
      row('application.view', {
        entity_type: 'application',
        entity_id: '11111111-1111-4111-8111-111111111111',
      }),
      row('user.update', {
        entity_type: 'profile',
        entity_id: '11111111-1111-4111-8111-111111111111',
      }),
      row('profile.update', {
        entity_type: 'profile',
        entity_id: '11111111-1111-4111-8111-111111111111',
      }),
      // A forged row naming a lead under a titled action, and entity SEO aimed at a lead.
      row('service.update', {
        entity_type: 'lead',
        entity_id: '11111111-1111-4111-8111-111111111111',
      }),
      row('entity_seo.update', {
        entity_type: 'entity_seo',
        entity_id: '11111111-1111-4111-8111-111111111111',
        detail: { target: 'lead' },
      }),
    ];
    for (const r of rows) expect(describeRow(r).titleRef, r.action).toBeNull();
  });

  it('content is titled; entity SEO titles its target; a deleted item is not', () => {
    const id = '22222222-2222-4222-8222-222222222222';
    expect(
      describeRow(row('service.update', { entity_type: 'service', entity_id: id })).titleRef,
    ).toEqual({
      type: 'service',
      id,
    });
    expect(
      describeRow(
        row('entity_seo.update', {
          entity_type: 'entity_seo',
          entity_id: id,
          detail: { target: 'blog_post' },
        }),
      ).titleRef,
    ).toEqual({ type: 'blog_post', id });
    expect(
      describeRow(row('service.delete', { entity_type: 'service', entity_id: id })).titleRef,
    ).toBeNull();
  });
});
