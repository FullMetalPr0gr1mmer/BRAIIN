-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 0127 — Section appearance (Admin v2 E9). Forward-only and EXPAND only. The number is a
-- placeholder: it is assigned at merge (scripts/renumber-migration.mjs). Depends on 0001
-- (public.page_sections and page_sections_write: app.can_write_content(), Admin and Content
-- Creator), 0016 (anon's table-level SELECT on page_sections behind the published-page fence),
-- 0038 (app.release_entities), 0061 (public.page_sections_unlocked) and 0115 (E1: the
-- page_section registry row with `label`, restated here).
--
-- The design is the README's E9 row ("background/spacing/reveal variants, editable anchors
-- (slug rules, unique per page); contrast pairs + visual baselines"); what was built and every
-- departure is docs/admin-v2/as-built/E9.md. The code map is packages/schemas/sectionAppearance.ts,
-- and tests/lib/sectionAppearance.spec.ts holds every list below equal to it.
--
--   1. Four nullable columns on public.page_sections, each a closed bucket; null is the
--      section's own look, so every existing row renders as before:
--        background  mist | ink | klein, on the Text block and the Gallery only;
--        spacing     compact | roomy, on the Text block, the Gallery and the Video only;
--        reveal      fade | rise, on every kind but the ones that open a page (the hero, the
--                    Story, Who we are, the Page head, Our Work's banner) and the Slogan;
--        anchor      the section's editable anchor: lower-case words joined by single hyphens,
--                    1 to 40 characters, never an id the site's code renders (by name, by
--                    prefix or by ending).
--      Which kind takes which choice is in the CHECKs, so a write that reaches the table around
--      the Worker (a staff token on the API) is held to it too. The Worker says it first, on the
--      field, and also refuses an anchor on a section whose component names its own, one a
--      discipline's slug holds, and a duplicate (src/lib/admin/resources/sections.ts).
--   2. UNIQUE (tenant_id, page_id, anchor), DEFERRABLE INITIALLY DEFERRED: an anchor names one
--      section of its page (null anchors never conflict). Deferred, so a release that moves an
--      anchor from one section to another applies (apply_release writes item by item in one
--      transaction; the constraint is checked at its commit).
--   3. The release registry's page_section row restated with the four columns appended (0115's
--      row otherwise word for word), so a release stages and publishes them like any other
--      column. src/lib/release/registry.ts derives the same list from the resource config.
--   4. public.page_sections_unlocked (0061: a password page's sections, read as the service
--      role for a visitor who typed the password) restated to return the four columns too, so
--      an unlocked page renders what a public one would. Its return type changes, so it is
--      dropped and created in this transaction, with 0061's grants restated.
--
-- No grant or policy changes: staff write the columns under page_sections_write (Admin and
-- Content Creator, the `pages.write` row of §5) and the table's grants, as every other column;
-- anon reads them with the row (0016), which the public render needs: they are presentation,
-- not private. The Sales boundary (C10a, U7, H13) is untouched.
--
-- Rule 5 (the deployed Worker between this push and the deploy): no reader's shape breaks. The
-- deployed admin and loaders select explicit columns that do not name these; the deployed
-- password page calls page_sections_unlocked and parses its rows with PageSectionRowSchema,
-- which drops a key it does not know (not .strict()); the preview mirror (R8) does the same.
-- A staged change made by the deployed Worker carries none of the four keys, which the restated
-- row simply allows.
--
-- Production as of 2026-11-04: PostgreSQL 17.6, one tenant; main holds every migration through
-- 0123 (E11). Releases stay off (app.release_tenants empty). CLAUDE.md §3 (Pillar 1), §5, §6,
-- §8 (Section engine), §9.
-- ─────────────────────────────────────────────────────────────────────────────────────────

-- A busy table fails the push instead of queueing behind it: the push is retried later.
set local lock_timeout = '5s';

-- ═══ 1. The four columns and their CHECKs ═════════════════════════════════════════════════
alter table public.page_sections
  add column if not exists background text,
  add column if not exists spacing text,
  add column if not exists reveal text,
  add column if not exists anchor text;

alter table public.page_sections drop constraint if exists page_sections_background_bucket;
alter table public.page_sections
  add constraint page_sections_background_bucket
    check (background is null
           or (background in ('mist', 'ink', 'klein')
               and type in ('textBlock', 'gallery')));

alter table public.page_sections drop constraint if exists page_sections_spacing_bucket;
alter table public.page_sections
  add constraint page_sections_spacing_bucket
    check (spacing is null
           or (spacing in ('compact', 'roomy')
               and type in ('textBlock', 'gallery', 'video')));

alter table public.page_sections drop constraint if exists page_sections_reveal_bucket;
alter table public.page_sections
  add constraint page_sections_reveal_bucket
    check (reveal is null
           or (reveal in ('fade', 'rise')
               and type not in ('hero', 'aboutStory', 'aboutWho', 'pageHead', 'workHero',
                                'slogan')));

alter table public.page_sections drop constraint if exists page_sections_anchor_shape;
alter table public.page_sections
  add constraint page_sections_anchor_shape
    check (anchor is null
           or (char_length(anchor) between 1 and 40
               and anchor ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
               and anchor <> all (array[
                 'about', 'apply', 'apply-form', 'apply-lead', 'apply-status', 'case',
                 'catalog-count', 'categories', 'clients', 'consent-banner', 'contact',
                 'contact-form', 'contact-status', 'content', 'faq', 'home-contact-cta',
                 'inquiry', 'main', 'numbers', 'projects', 'quotes', 'search-form',
                 'search-input', 'search-results', 'selected-work', 'services', 'team',
                 'team-track', 'testimonials', 'title', 'top', 'what', 'who'
               ]::text[])
               and anchor !~ '^(af|cf|cs|pv|site-footer|svc|tm)-'
               and anchor !~ '-(error|h|heading)$'));

comment on column public.page_sections.background is
  'Admin v2 E9: the section''s background, mist | ink | klein (Text block and Gallery only); null is its own.';
comment on column public.page_sections.spacing is
  'Admin v2 E9: the section''s spacing, compact | roomy (Text block, Gallery, Video only); null is its own.';
comment on column public.page_sections.reveal is
  'Admin v2 E9: the section''s reveal, fade | rise (never on a kind that opens a page, nor the Slogan); null is none. The render also ignores it on the first two sections a page shows.';
comment on column public.page_sections.anchor is
  'Admin v2 E9: the section''s editable anchor (#anchor): lower-case words joined by single hyphens, 1 to 40 characters, never an id the site''s code renders; unique on its page. Null is none.';

-- ═══ 2. One anchor, one section of its page ═══════════════════════════════════════════════
alter table public.page_sections drop constraint if exists page_sections_anchor_unique;
alter table public.page_sections
  add constraint page_sections_anchor_unique unique (tenant_id, page_id, anchor)
    deferrable initially deferred;

-- ═══ 3. The release registry: page_section with the four columns ══════════════════════════
-- 0115's row word for word, `background`, `spacing`, `reveal` and `anchor` appended.
insert into app.release_entities
  (entity_type, table_name, key_column, area, author_roles, delete_roles, columns,
   deferred_columns, unique_flags, exempt_columns, apply_order, has_status, publish_flag)
values
  ('page_section', 'page_sections', 'id', 'pages', '{admin,content_creator}', '{admin}',
   '{page_id,type,content,style,visible,sort_order,is_placeholder,label,background,spacing,reveal,anchor}',
   '{}', '{}', '{}', 90, false, 'visible')
on conflict (entity_type) do update
  set table_name = excluded.table_name,
      key_column = excluded.key_column,
      area = excluded.area,
      author_roles = excluded.author_roles,
      delete_roles = excluded.delete_roles,
      columns = excluded.columns,
      deferred_columns = excluded.deferred_columns,
      unique_flags = excluded.unique_flags,
      exempt_columns = excluded.exempt_columns,
      apply_order = excluded.apply_order,
      has_status = excluded.has_status,
      publish_flag = excluded.publish_flag;

-- ═══ 4. A password page's sections, with their appearance ═════════════════════════════════
-- 0061's function word for word, the four columns added to what it returns (a new return type,
-- so it is dropped and created; nothing depends on it in the database). Service role only.
drop function if exists public.page_sections_unlocked(uuid, uuid);
create function public.page_sections_unlocked(p_tenant uuid, p_page_id uuid)
returns table (type text, content jsonb, visible boolean, sort_order int,
               background text, spacing text, reveal text, anchor text)
  language sql stable security definer set search_path = '' as $$
  select s.type, s.content, s.visible, s.sort_order,
         s.background, s.spacing, s.reveal, s.anchor
    from public.page_sections s
    join public.pages p on p.tenant_id = s.tenant_id and p.id = s.page_id
   where s.tenant_id = p_tenant
     and s.page_id = p_page_id
     and s.visible
     and p.status = 'published'
   order by s.sort_order, s.id
$$;
revoke all on function public.page_sections_unlocked(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.page_sections_unlocked(uuid, uuid) to service_role;

-- ═══ Postconditions ═══════════════════════════════════════════════════════════════════════
do $$
declare
  v_columns text[];
begin
  if (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'page_sections'
         and column_name in ('background', 'spacing', 'reveal', 'anchor')
         and data_type = 'text' and is_nullable = 'YES') <> 4 then
    raise exception 'E9: page_sections lacks its four nullable text columns';
  end if;
  if (select count(*) from pg_constraint
       where conrelid = 'public.page_sections'::regclass
         and conname in ('page_sections_background_bucket', 'page_sections_spacing_bucket',
                         'page_sections_reveal_bucket', 'page_sections_anchor_shape')
         and contype = 'c' and convalidated) <> 4 then
    raise exception 'E9: page_sections lacks its four validated CHECKs';
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.page_sections'::regclass
                    and conname = 'page_sections_anchor_unique' and contype = 'u'
                    and condeferrable and condeferred) then
    raise exception 'E9: page_sections_anchor_unique is not a deferred UNIQUE';
  end if;
  select columns into v_columns from app.release_entities where entity_type = 'page_section';
  if v_columns is null or not (v_columns @> array['background', 'spacing', 'reveal', 'anchor', 'label']) then
    raise exception 'E9: the page_section registry row does not carry the appearance columns';
  end if;
  if has_function_privilege('anon', 'public.page_sections_unlocked(uuid, uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.page_sections_unlocked(uuid, uuid)', 'execute')
     or not has_function_privilege('service_role', 'public.page_sections_unlocked(uuid, uuid)', 'execute') then
    raise exception 'E9: page_sections_unlocked is not the service role''s alone';
  end if;
  if not exists (select 1 from pg_proc
                  where oid = 'public.page_sections_unlocked(uuid, uuid)'::regprocedure
                    and prosecdef and proconfig @> array['search_path=""']) then
    raise exception 'E9: page_sections_unlocked lost its definer or its pinned search_path';
  end if;
end
$$;
