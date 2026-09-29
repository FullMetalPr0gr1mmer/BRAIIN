// Generates supabase/seeds/round2-cutover.sql — the Round 2 production data move (runbook
// §6d) — from the SAME seed data as production.sql (supabase/seed-data/*.json), so the
// copy, discipline, poster, clip and links it writes into the rows the seed skips can never
// drift from what fresh databases get.
//
//   node scripts/round2-cutover.mjs               write the file
//   node scripts/round2-cutover.mjs --check       exit 1 if the committed file is stale
//   node scripts/round2-cutover.mjs --step <name> print one step (for psql -f / db query)
//
// Steps, in the order the runbook runs them (§6d), each self-contained:
//   preflight  read-only; BEFORE the 0028 push. Review every result.
//   renames    plan step 2 — one transaction: four compare-and-set renames (slug + current
//              EN title, target slug absent, exactly one row each — a re-run fails loudly)
//              and the six archives; asserts the exact slug sets, else rolls back.
//   rehearse   plan step 3 — production.sql inside BEGIN … ROLLBACK, listing every row it
//              would insert (or touch), each marked as this round's or NOT. Writes nothing.
//   content    plan step 4 — one transaction, after production.sql: the 8 kept/renamed
//              services get the new copy, discipline, poster, clip and sort_order; the 12
//              sample projects' services are rebuilt; crafts = 28; header Services → /services.
//   samples    plan step 5 — one transaction: the owner's override for testimonials and
//              service_cases (audit-logged by 0027's trigger), then the 9 sample quotes, the
//              28 cases and the 4 Services-page stats go live; asserts the end state.
//   verify     plan step 6 — read-only JSON of the same facts, for the report.
//
// Every assertion compares EXACT slug sets (never counts) inside the step's own
// transaction: a mismatch raises, and the step rolls back whole.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate, literal, loadBlocks, TENANT_ID } from './gen-seeds.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const OUTPUT = join(ROOT, 'supabase', 'seeds', 'round2-cutover.sql');

// ── Production facts (not seed data) ───────────────────────────────────────────────
/** Renamed in place, keeping the id (entity_seo, content_versions and links survive). */
export const RENAMES = [
  // §6b applied the round-1 copy ("Animations" → "Animation"); either is a known state.
  { from: 'animations', to: 'animation', titles: ['Animation', 'Animations'] },
  { from: 'videography', to: 'photo-video', titles: ['Videography'] },
  { from: 'montage', to: 'video-editing', titles: ['Montage'] },
  { from: 'music', to: 'music-vo-sfx', titles: ['Music'] },
];
/** Kept as they are (slug), re-filed and re-copied in step 4. */
export const KEPT = ['motion-graphics', 'advertising', 'social-media', 'seo-geo-aeo'];
/** Retired (archived, restorable): the design has no page for them. */
export const ARCHIVE = [
  'branding',
  'photography',
  'event-planning',
  'web-development',
  'merchandise',
  'gaming',
];
/** Archived in round 1 (§6c content step) — outside every set below. */
export const PRE_ARCHIVED = ['test-service'];
export const OVERRIDE_REASON =
  'Owner decision 2026-09-27: show the design samples until real content replaces them';
export const OVERRIDE_TABLES = ['testimonials', 'service_cases'];

const T = literal(TENANT_ID);
const cSort = (a) => [...a].sort(); // code-unit order = `collate "C"` for these ASCII slugs
const arr = (values) => `array[${values.map((v) => literal(v)).join(', ')}]::text[]`;
const inList = (values) => `(${values.map((v) => literal(v)).join(', ')})`;
const refSlug = (v) => v?.$ref?.by?.slug;

// ── Seed data ───────────────────────────────────────────────────────────────────────
function seedFacts(blocks = loadBlocks()) {
  const rowsOf = (table) => blocks.filter((b) => b.table === table).flatMap((b) => b.rows);
  const services = rowsOf('services');
  const serviceSlugs = services.map((r) => r.slug);
  const existing = [...RENAMES.map((r) => r.to), ...KEPT];
  for (const slug of existing) {
    if (!serviceSlugs.includes(slug)) throw new Error(`seed has no service ${slug}`);
  }
  const links = new Map();
  for (const r of rowsOf('portfolio_services')) {
    const p = refSlug(r.portfolio_id);
    links.set(p, [
      ...(links.get(p) ?? []),
      { service: refSlug(r.service_id), order: r.sort_order },
    ]);
  }
  const crafts = rowsOf('statistics').find((r) => r.slug === 'crafts');
  const headerServices = rowsOf('navigation').find(
    (r) => r.location === 'header' && r.href === '/services',
  );
  if (!crafts || !headerServices) throw new Error('seed lacks crafts or the header Services link');
  const servicesPageSections = rowsOf('page_sections').filter(
    (r) => refSlug(r.page_id) === 'services' && r.__placeholder,
  );
  return {
    disciplines: rowsOf('disciplines').map((r) => r.slug),
    services,
    serviceSlugs,
    existing,
    links,
    crafts,
    headerServices,
    quotes: rowsOf('testimonials')
      .filter((r) => r.__placeholder)
      .map((r) => r.slug),
    cases: rowsOf('service_cases').map((r) => refSlug(r.service_id)),
    servicesStats: rowsOf('statistics')
      .filter((r) => String(r.placements).includes('services') && r.__placeholder)
      .map((r) => r.slug),
    servicesPageSections,
  };
}

/** A DO block that raises unless `got` (an SQL expression) equals `want` (a literal). */
function assertEq(step, what, got, want) {
  return (
    `do $$\ndeclare v_got text;\nbegin\n  select (${got})::text into v_got;\n` +
    `  if v_got is distinct from ${literal(want)} then\n` +
    `    raise exception 'round2 %: % — expected %, got %', ${literal(step)}, ${literal(what)}, ${literal(want)}, coalesce(v_got, 'null');\n` +
    `  end if;\nend $$;`
  );
}

/**
 * Published counters that render nowhere (`cardinality(placements) = 0`) — the pre-0023
 * legacy rows. Read by the preflight (review) and the verify step (must be empty after
 * runbook §6e), as `[]` rather than null so the JSON reads the same either way.
 */
const unplacedPublished = () =>
  `(select coalesce(json_agg(json_build_object('slug', slug, 'value', value, 'is_placeholder', is_placeholder) order by slug), '[]')
     from public.statistics where tenant_id = ${T} and status = 'published' and cardinality(placements) = 0)`;

/** `string_agg` of slugs in "C" order — the canonical text of an exact slug set. */
const slugSet = (from, where) =>
  `select string_agg(slug::text, ',' order by slug::text collate "C") from ${from} where ${where}`;
const slugText = (values) => cSort(values).join(',');

// ── Steps ───────────────────────────────────────────────────────────────────────────

function preflight(f) {
  const old8 = [...RENAMES.map((r) => r.from), ...KEPT];
  return `-- Read-only. Run BEFORE the 0028 push and review every key of the result:
--   services            the current catalogue: the renames' compare-and-set needs each
--                       renamed slug still titled as RENAMES says (else stop and ask)
--   entity_seo_8        an old canonical_override or a "Videography" meta title would outlive
--                       the rename — clear or rewrite it in step 4 after review
--   sections_authored   servicesOverview / aboutIntro / faq content that is not {}: authored
--                       copy wins over the new code defaults
--   fourteen            SEO text still saying "fourteen" / "أربع عشرة"
--   stats               the legacy "services" counter (14) and crafts — is either published?
--   unplaced_published  every published counter with NO placement (pre-0023 rows: the
--                       legacy services 14 / projects 150+ / years 8) — rendered nowhere,
--                       unflagged, invisible to the dashboard. Archived by runbook §6e.
--   overrides           the round-1 overrides (portfolio, statistics, team_members, clients,
--                       page_sections) should all still exist
--   sample_projects     the 12 projects whose services step 4 rebuilds
select json_build_object(
  'services', (select json_agg(json_build_object('slug', slug, 'en', title ->> 'en', 'status', status) order by sort_order)
                 from public.services where tenant_id = ${T}),
  'entity_seo_8', (select coalesce(json_agg(json_build_object('slug', s.slug, 'meta_title', e.meta_title,
                     'meta_description', e.meta_description, 'canonical', e.canonical_override)), '[]')
                     from public.entity_seo e join public.services s on s.id = e.entity_id
                    where e.entity_type = 'service' and s.tenant_id = ${T} and s.slug in ${inList(old8)}),
  'sections_authored', (select coalesce(json_agg(json_build_object('page', p.slug, 'type', ps.type, 'content', ps.content)), '[]')
                          from public.page_sections ps join public.pages p on p.id = ps.page_id
                         where ps.tenant_id = ${T} and ps.type in ('servicesOverview', 'aboutIntro', 'faq')
                           and ps.content <> '{}'::jsonb),
  'fourteen', (select coalesce(json_agg(x), '[]') from (
                 select 'seo_defaults' as source, null::uuid as id from public.seo_defaults
                  where tenant_id = ${T} and (to_jsonb(seo_defaults)::text ilike '%fourteen%' or to_jsonb(seo_defaults)::text like '%أربع عشرة%')
                 union all
                 select 'entity_seo:' || entity_type, entity_id from public.entity_seo
                  where tenant_id = ${T} and ((meta_title::text || meta_description::text) ilike '%fourteen%'
                        or (meta_title::text || meta_description::text) like '%أربع عشرة%')) x),
  'stats', (select json_agg(json_build_object('slug', slug, 'value', value, 'status', status, 'placements', placements))
              from public.statistics where tenant_id = ${T} and (slug in ('services', 'crafts') or value = '14')),
  'unplaced_published', ${unplacedPublished()},
  'overrides', (select coalesce(json_agg(table_name order by table_name), '[]') from app.placeholder_live_override where tenant_id = ${T}),
  'sample_projects', (select json_agg(json_build_object('slug', slug, 'status', status, 'placeholder', is_placeholder) order by sort_order)
                        from public.portfolio where tenant_id = ${T} and slug in ${inList([...f.links.keys()])}),
  'header_nav', (select json_agg(json_build_object('label', label ->> 'en', 'href', href) order by sort_order)
                   from public.navigation where tenant_id = ${T} and location = 'header')
) as round2_preflight;`;
}

function renames() {
  const all = [...RENAMES.flatMap((r) => [r.from, r.to]), ...ARCHIVE, ...KEPT];
  const stmts = RENAMES.map(
    (r) =>
      `  update public.services set slug = ${literal(r.to)}\n` +
      `   where tenant_id = ${T} and slug = ${literal(r.from)}\n` +
      `     and title ->> 'en' in ${inList(r.titles)}\n` +
      `     and not exists (select 1 from public.services where tenant_id = ${T} and slug = ${literal(r.to)});\n` +
      `  get diagnostics n = row_count;\n` +
      `  if n <> 1 then\n` +
      `    raise exception 'round2 renames: % → % matched % rows (expected 1: slug %, titled ${r.titles.join(' or ')}, and no % yet)', ${literal(r.from)}, ${literal(r.to)}, n, ${literal(r.from)}, ${literal(r.to)};\n` +
      `  end if;`,
  );
  return `-- Plan step 2, after the 0028 push. One transaction.
begin;

do $$
begin
  if to_regclass('public.disciplines') is null then
    raise exception 'round2 renames: migration 0028 is not applied — push it first (§6d step 1)';
  end if;
end $$;

-- Renames in place: the id is kept, so entity_seo, content_versions and every link survive.
do $$
declare n int;
begin
${stmts.join('\n')}
end $$;

-- Retired: archived, restorable from the admin (a restore wins over the 301 map).
update public.services set status = 'archived'
 where tenant_id = ${T} and slug in ${inList(ARCHIVE)} and status <> 'archived';

${assertEq(
  'renames',
  'the renamed slugs exist and the old ones are gone',
  slugSet(
    'public.services',
    `tenant_id = ${T} and slug in ${inList(RENAMES.flatMap((r) => [r.from, r.to]))}`,
  ),
  slugText(RENAMES.map((r) => r.to)),
)}
${assertEq(
  'renames',
  'archived services (outside test-service) are exactly the six',
  slugSet(
    'public.services',
    `tenant_id = ${T} and status = 'archived' and slug not in ${inList(PRE_ARCHIVED)}`,
  ),
  slugText(ARCHIVE),
)}
${assertEq(
  'renames',
  'the kept and renamed services are still published',
  slugSet(
    'public.services',
    `tenant_id = ${T} and status = 'published' and slug in ${inList(all)}`,
  ),
  slugText([...RENAMES.map((r) => r.to), ...KEPT]),
)}

commit;`;
}

/** SQL naming a seeded row by its conflict key — the rehearsal's listing. */
function keyExpr(table, alias = 'x') {
  const a = alias;
  switch (table) {
    case 'tenants':
      return `${a}.id::text`;
    case 'site_settings':
    case 'site_profile':
      return `${a}.tenant_id::text`;
    case 'navigation':
      return `${a}.location || ' ' || ${a}.href`;
    case 'media_assets':
      return `${a}.storage_path`;
    case 'partner_logos':
      return `${a}.name`;
    case 'portfolio_services':
      return `(select slug::text from public.portfolio p where p.id = ${a}.portfolio_id) || ' → ' || (select slug::text from public.services s where s.id = ${a}.service_id)`;
    case 'portfolio_media':
      return `(select slug::text from public.portfolio p where p.id = ${a}.portfolio_id) || ' ' || ${a}.role || ' #' || ${a}.sort_order`;
    case 'page_sections':
      return `(select slug::text from public.pages p where p.id = ${a}.page_id) || '/' || ${a}.type`;
    case 'service_cases':
      return `(select slug::text from public.services s where s.id = ${a}.service_id)`;
    default:
      return `${a}.slug::text`;
  }
}

/** The same key, computed from a seed row — for "is this one of this round's rows". */
function keyOfRow(table, row) {
  switch (table) {
    case 'media_assets':
      return row.storage_path;
    case 'page_sections':
      return `${refSlug(row.page_id)}/${row.type}`;
    case 'service_cases':
      return refSlug(row.service_id);
    default:
      return row.slug;
  }
}

/** Rows production.sql is EXPECTED to insert this round (after the step-2 renames). */
function thisRound(f, blocks) {
  const keys = [];
  for (const b of blocks) {
    for (const row of b.rows) {
      const mine =
        b.table === 'disciplines' ||
        b.table === 'service_cases' ||
        (b.table === 'media_assets' && String(row.storage_path).startsWith('stills/services/')) ||
        (b.table === 'services' && !f.existing.includes(row.slug)) ||
        (b.table === 'statistics' && String(row.placements).includes('services')) ||
        (b.table === 'pages' && row.slug === 'services') ||
        (b.table === 'page_sections' && refSlug(row.page_id) === 'services');
      if (mine) keys.push([b.table, keyOfRow(b.table, row)]);
    }
  }
  return keys;
}

function rehearse(f, blocks) {
  const full = generate('production', blocks);
  const start = full.indexOf('\nbegin;\n');
  const end = full.lastIndexOf('\ncommit;');
  if (start < 0 || end < 0) throw new Error('production.sql lost its begin/commit');
  const body = full.slice(start + '\nbegin;\n'.length, end).trim();
  const tables = [...new Set(blocks.map((b) => b.table))];
  const touched = tables
    .map(
      (t) =>
        `  select ${literal(t)}::text as tbl, ${keyExpr(t)} as key from public.${t} x\n` +
        `   where x.xmin::text = (txid_current() % 4294967296)::text`,
    )
    .join('\n  union all\n');
  const expected = thisRound(f, blocks)
    .map(([t, k]) => `(${literal(t)}, ${literal(k)})`)
    .join(',\n    ');
  return `-- Plan step 3, AFTER the renames (else the 8 kept services would list as new).
-- production.sql, statement for statement, inside a transaction that ROLLS BACK: nothing is
-- written. The listing shows every row it would insert (or touch), this_round = false
-- first. Anything with this_round = false is a row an editor deleted since the last run, or
-- content from outside this round: STOP, and apply a delta seed instead
-- (node scripts/gen-seeds.mjs --only <this round's files>). When every row reads true, run
-- the real thing: psql "$PROD_DB_URL" -v ON_ERROR_STOP=1 -f supabase/seeds/production.sql
begin;

${body}

select (x.tbl, x.key) in (
    ${expected}
  ) as this_round, x.tbl, x.key
  from (
${touched}
  ) x
 order by this_round, x.tbl, x.key;

rollback;`;
}

function content(f) {
  const byslug = new Map(f.services.map((r) => [r.slug, r]));
  const updates = f.existing.map((slug) => {
    const r = byslug.get(slug);
    const sets = [
      ['title', r.title],
      ['blurb', r.blurb],
      ['intro', r.intro],
      ['body', r.body],
      ['body_html', r.body_html],
      ['value_points', r.value_points],
      ['deliverables', r.deliverables],
      ['discipline_id', r.discipline_id],
      ['poster_media_id', r.poster_media_id],
      ['preview_video_path', r.preview_video_path],
      ['preview_start_s', r.preview_start_s],
      ['preview_end_s', r.preview_end_s],
      ['sort_order', r.sort_order],
      ...(r.short_title ? [['short_title', r.short_title]] : []),
    ];
    return (
      `update public.services set\n` +
      sets.map(([c, v]) => `       ${c} = ${literal(v)}`).join(',\n') +
      `\n where tenant_id = ${T} and slug = ${literal(slug)};`
    );
  });
  const filed = f.existing
    .map((slug) => byslug.get(slug))
    .sort((a, b) => (a.slug < b.slug ? -1 : 1))
    .map((r) => `${r.slug}:${refSlug(r.discipline_id)}:${r.sort_order}`)
    .join(',');
  const projects = [...f.links.keys()];
  const linkRows = projects.flatMap((p) =>
    f.links
      .get(p)
      .map(
        (l) =>
          `  (${T}, (select id from public.portfolio where tenant_id = ${T} and slug = ${literal(p)}),\n` +
          `   (select id from public.services where tenant_id = ${T} and slug = ${literal(l.service)}), ${l.order})`,
      ),
  );
  const linkText = cSort(projects)
    .map(
      (p) =>
        `${p}=${f.links
          .get(p)
          .map((l) => l.service)
          .join(',')}`,
    )
    .join('|');
  const c = f.crafts;
  return `-- Plan step 4, AFTER production.sql. One transaction: the rows the seed skips.
begin;

do $$
begin
  if (select count(*) from public.disciplines where tenant_id = ${T} and slug in ${inList(f.disciplines)}) <> ${f.disciplines.length} then
    raise exception 'round2 content: the disciplines are missing — apply production.sql first (§6d step 3)';
  end if;
end $$;

-- The 8 kept or renamed services: the new copy, discipline, poster, clip and sort_order
-- (the seed skipped them — they already existed), so they do not interleave with the new 20.
${updates.join('\n')}

-- The 12 sample projects' services, rebuilt by slug (the seed only fills an empty set).
delete from public.portfolio_services ps
 using public.portfolio p
 where p.id = ps.portfolio_id and p.tenant_id = ${T} and p.slug in ${inList(projects)};
insert into public.portfolio_services (tenant_id, portfolio_id, service_id, sort_order) values
${linkRows.join(',\n')};

-- Crafts → 28: value and value_numeric together (statistics_value_consistent).
update public.statistics
   set value = ${literal(c.value)}, value_numeric = ${literal(c.value_numeric)}, value_suffix = null,
       label = ${literal(c.label)}
 where tenant_id = ${T} and slug = 'crafts';

-- Header Services → the Services page.
update public.navigation set href = '/services'
 where tenant_id = ${T} and location = 'header' and href = '/#services';

${assertEq(
  'content',
  'the kept and renamed services are filed and ordered (slug:discipline:sort)',
  `select string_agg(s.slug::text || ':' || d.slug::text || ':' || s.sort_order, ',' order by s.slug::text collate "C")
     from public.services s join public.disciplines d on d.id = s.discipline_id
    where s.tenant_id = ${T} and s.slug in ${inList(f.existing)}`,
  filed,
)}
${assertEq(
  'content',
  'published services are exactly the 28, each filed under a discipline',
  slugSet(
    'public.services',
    `tenant_id = ${T} and status = 'published' and discipline_id is not null`,
  ),
  slugText(f.serviceSlugs),
)}
${assertEq(
  'content',
  'no published service is outside a discipline',
  `select count(*) from public.services where tenant_id = ${T} and status = 'published' and discipline_id is null`,
  '0',
)}
${assertEq(
  'content',
  "the sample projects' services, in order",
  `select string_agg(x.slug || '=' || x.svcs, '|' order by x.slug collate "C") from (
     select p.slug::text as slug, string_agg(s.slug::text, ',' order by ps.sort_order) as svcs
       from public.portfolio p
       join public.portfolio_services ps on ps.portfolio_id = p.id
       join public.services s on s.id = ps.service_id
      where p.tenant_id = ${T} and p.slug in ${inList(projects)}
      group by p.slug) x`,
  linkText,
)}
${assertEq(
  'content',
  'crafts reads 28 (value and value_numeric)',
  `select value || '/' || trim_scale(value_numeric)::text from public.statistics where tenant_id = ${T} and slug = 'crafts'`,
  `${c.value}/${c.value_numeric}`,
)}
${assertEq(
  'content',
  'the header links Services to /services, once',
  `select count(*) filter (where href = '/services') || '/' || count(*) filter (where href = '/#services')
     from public.navigation where tenant_id = ${T} and location = 'header'`,
  '1/0',
)}

commit;`;
}

function samples(f) {
  const sections = f.servicesPageSections;
  const sectionSql = sections.length
    ? `-- The Services page's sample sections (the proof band's rating line …).
update public.page_sections set visible = true
 where tenant_id = ${T} and is_placeholder and not visible and id in ${inList(sections.map((r) => r.id))};

${assertEq(
  'samples',
  "the Services page's sample sections are visible",
  `select string_agg(id::text, ',' order by id::text collate "C") from public.page_sections where tenant_id = ${T} and visible and id in ${inList(sections.map((r) => r.id))}`,
  slugText(sections.map((r) => r.id)),
)}
`
    : `-- (No Services-page sample sections in the seed data yet — nothing to show there.)
`;
  return `-- Plan step 5. One transaction: the owner's override (0027/0028 — audit-logged by the
-- override table's trigger), then the design samples go live with their flag still set, so
-- the dashboard keeps listing them as "Placeholder content is live" until replaced
-- (§6c: make real, then revoke).
begin;

do $$
begin
  if (select count(*) from public.service_cases where tenant_id = ${T}) = 0 then
    raise exception 'round2 samples: no service cases — apply production.sql first (§6d step 3)';
  end if;
end $$;

insert into app.placeholder_live_override (tenant_id, table_name, reason)
select t.id, x.table_name, ${literal(OVERRIDE_REASON)}
  from public.tenants t
  cross join (values ${OVERRIDE_TABLES.map((t) => `(${literal(t)})`).join(', ')}) as x(table_name)
 where t.id = ${T}
on conflict (tenant_id, table_name) do nothing;

-- The sample quotes (seeded, flagged; consent-or-sample since 0028).
update public.testimonials set status = 'published', published_at = coalesce(published_at, now())
 where tenant_id = ${T} and is_placeholder and status = 'draft' and slug in ${inList(f.quotes)};

-- The service case blocks.
update public.service_cases c set status = 'published', published_at = coalesce(c.published_at, now())
  from public.services s
 where s.id = c.service_id and c.tenant_id = ${T} and c.is_placeholder and c.status = 'draft'
   and s.slug in ${inList(f.cases)};

-- The Services page's sample counters.
update public.statistics set status = 'published'
 where tenant_id = ${T} and is_placeholder and status = 'draft' and slug in ${inList(f.servicesStats)};

${sectionSql}
${assertEq(
  'samples',
  'the override names testimonials and service_cases, each with its audit row',
  `select count(*) from app.placeholder_live_override o
     where o.tenant_id = ${T} and o.table_name in ${inList(OVERRIDE_TABLES)}
       and exists (select 1 from public.audit_log a where a.tenant_id = ${T}
                    and a.entity_type = 'placeholder_override' and a.action = 'placeholder_override.grant'
                    and a.entity_id = o.table_name)`,
  String(OVERRIDE_TABLES.length),
)}
${assertEq(
  'samples',
  'published disciplines are exactly the five',
  slugSet('public.disciplines', `tenant_id = ${T} and status = 'published'`),
  slugText(f.disciplines),
)}
${assertEq(
  'samples',
  'published services are exactly the 28',
  slugSet('public.services', `tenant_id = ${T} and status = 'published'`),
  slugText(f.serviceSlugs),
)}
${assertEq(
  'samples',
  'archived services (outside test-service) are exactly the six',
  slugSet(
    'public.services',
    `tenant_id = ${T} and status = 'archived' and slug not in ${inList(PRE_ARCHIVED)}`,
  ),
  slugText(ARCHIVE),
)}
${assertEq(
  'samples',
  'live case blocks are exactly the 28 services',
  `select string_agg(s.slug::text, ',' order by s.slug::text collate "C")
     from public.service_cases c join public.services s on s.id = c.service_id
    where c.tenant_id = ${T} and c.status = 'published'`,
  slugText(f.cases),
)}
${assertEq(
  'samples',
  'live quotes are exactly the nine samples',
  slugSet('public.testimonials', `tenant_id = ${T} and status = 'published'`),
  slugText(f.quotes),
)}
${assertEq(
  'samples',
  'live Services-page stats are exactly the four samples',
  slugSet(
    'public.statistics',
    `tenant_id = ${T} and status = 'published' and placements @> array['services']`,
  ),
  slugText(f.servicesStats),
)}
${assertEq(
  'samples',
  'crafts still reads 28',
  `select value from public.statistics where tenant_id = ${T} and slug = 'crafts'`,
  f.crafts.value,
)}

commit;`;
}

function verify() {
  return `-- Plan step 6. Read-only: the facts steps 2–5 asserted, as one JSON for the report.
select json_build_object(
  'disciplines', (select json_agg(slug order by sort_order) from public.disciplines where tenant_id = ${T} and status = 'published'),
  'services', (select json_agg(json_build_object('slug', s.slug, 'discipline', d.slug) order by s.sort_order)
                 from public.services s left join public.disciplines d on d.id = s.discipline_id
                where s.tenant_id = ${T} and s.status = 'published'),
  'services_archived', (select json_agg(slug order by slug) from public.services where tenant_id = ${T} and status = 'archived'),
  'cases_live', (select count(*) from public.service_cases where tenant_id = ${T} and status = 'published'),
  'quotes_live', (select json_agg(slug order by sort_order) from public.testimonials where tenant_id = ${T} and status = 'published'),
  'services_stats_live', (select json_agg(value order by sort_order) from public.statistics
                            where tenant_id = ${T} and status = 'published' and placements @> array['services']),
  'crafts', (select value from public.statistics where tenant_id = ${T} and slug = 'crafts'),
  'header_nav', (select json_agg(href order by sort_order) from public.navigation where tenant_id = ${T} and location = 'header'),
  'overrides', (select json_agg(table_name order by table_name) from app.placeholder_live_override where tenant_id = ${T}),
  'override_grants', (select json_agg(entity_id order by created_at) from public.audit_log
                        where tenant_id = ${T} and entity_type = 'placeholder_override' and action = 'placeholder_override.grant'),
  'placeholder_live', (select json_agg(json_build_object('type', entity_type, 'slug', slug) order by entity_type, slug)
                         from public.dashboard_attention where kind = 'placeholder_live'
                          and entity_type in ('testimonial', 'service_case', 'statistic')),
  'unplaced_published', ${unplacedPublished()}
) as round2_verify;

-- Round 3 (runbook §6e): no published counter may render nowhere. Raised AFTER the JSON
-- above has printed, so the report still shows what is wrong.
do $$
declare v_bad text;
begin
  select string_agg(slug::text || '=' || value, ',' order by slug::text collate "C") into v_bad
    from public.statistics where tenant_id = ${T} and status = 'published' and cardinality(placements) = 0;
  if v_bad is not null then
    raise exception 'round2 verify: published counters with no placement (run runbook §6e): %', v_bad;
  end if;
end $$;`;
}

// ── The file ────────────────────────────────────────────────────────────────────────

export const STEPS = ['preflight', 'renames', 'rehearse', 'content', 'samples', 'verify'];
const marker = (name) => `-- ════════ step: ${name} ════════`;

export function generateCutover(blocks = loadBlocks()) {
  const f = seedFacts(blocks);
  const body = {
    preflight: preflight(f),
    renames: renames(),
    rehearse: rehearse(f, blocks),
    content: content(f),
    samples: samples(f),
    verify: verify(),
  };
  const sections = STEPS.map((s) => `${marker(s)}\n${body[s]}\n${marker(`${s} end`)}`);
  return (
    `-- GENERATED by scripts/round2-cutover.mjs from supabase/seed-data/*.json — DO NOT EDIT.\n` +
    `-- Change the JSON, then run \`npm run seed:gen\` (regenerates this file with the seeds).\n` +
    `--\n` +
    `-- Round 2 production cut-over (docs/launch-runbook.md §6d). NOT one script: each step\n` +
    `-- runs on its own, in order, with the push and production.sql between them. Print one:\n` +
    `--   node scripts/round2-cutover.mjs --step <${STEPS.join('|')}>\n` +
    `-- and run it as the owner: psql "$PROD_DB_URL" -v ON_ERROR_STOP=1 -f <that file>.\n` +
    `-- Run whole by mistake, it stops safely: step 4 refuses before production.sql, and a\n` +
    `-- second run of the renames fails loudly.\n\n` +
    `${sections.join('\n\n')}\n`
  );
}

/** One step's SQL (without its markers). */
export function stepSql(name, text = generateCutover()) {
  const open = `${marker(name)}\n`;
  const start = text.indexOf(open);
  const end = text.indexOf(`\n${marker(`${name} end`)}`);
  if (!STEPS.includes(name) || start < 0 || end < 0) throw new Error(`no step ${name}`);
  return `${text.slice(start + open.length, end)}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const sql = generateCutover();
  const step = process.argv.indexOf('--step');
  if (step !== -1) {
    process.stdout.write(stepSql(process.argv[step + 1] ?? '', sql));
  } else if (process.argv.includes('--check')) {
    const current = existsSync(OUTPUT) ? readFileSync(OUTPUT, 'utf8') : '';
    if (current !== sql) {
      console.error(`  ✘ ${OUTPUT} is stale — run \`npm run seed:gen\``);
      process.exit(1);
    }
  } else {
    writeFileSync(OUTPUT, sql);
    console.log(`  ✓ wrote ${OUTPUT}`);
  }
}
