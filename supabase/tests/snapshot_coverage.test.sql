-- pgTAP: history covers every release-managed table, and names its release (migration
-- 0038, Admin v2 R1).
--
-- The release registry (app.release_entities) is the list of tables a release may change.
-- Every one of them must snapshot into content_versions under its entity type (the two
-- singletons keyed by the tenant), except team_members, which keeps no history until the
-- owner decides history redaction (owner item O-12, PDPL: a snapshot would keep staff
-- names and bios after an edit or removal, with no erasure path); every column it holds
-- must be classified (writable, immediate, or system), and a snapshot carries a release_id
-- only while the release token of THIS transaction is valid. Writes run as content_creator, seo and developer; a write
-- by another tenant cannot borrow a release (tenant-fenced key). The per-role access rows
-- for the ledger itself are rls_releases.test.sql; history's write lockdown is
-- content_versions_writes.test.sql (0032).
--
-- A failure in the first three assertions after a migration adds a table or a column to a
-- registry table means that migration must also classify it in app.release_entities and
-- give the table its snapshot trigger (releases.md §1.3, the registry contract).
--
-- Run with `supabase test db`. CLAUDE.md §3 (Pillar 1), §8, §9.

begin;
select plan(21);

-- ── 1. The catalog ─────────────────────────────────────────────────────────────────
select is(
  (select coalesce(string_agg(e.entity_type, ', ' order by e.entity_type), '')
     from app.release_entities e
    where e.entity_type <> 'team_member'   -- O-12, below
      and not exists (
      select 1
        from pg_trigger tg
        join pg_proc f on f.oid = tg.tgfoid
       where tg.tgrelid = format('public.%I', e.table_name)::regclass
         and not tg.tgisinternal
         and f.proname = case e.key_column when 'id' then 'tg_snapshot_version'
                                           else 'tg_snapshot_singleton' end
         -- AFTER, FOR EACH ROW, on INSERT and UPDATE.
         and tg.tgtype & 1 = 1 and tg.tgtype & 2 = 0
         and tg.tgtype & 4 = 4 and tg.tgtype & 16 = 16
         and tg.tgnargs = 1
         and tg.tgargs = convert_to(e.entity_type, 'UTF8') || '\x00'::bytea)),
  '',
  'every registry table but team_members snapshots under its entity type (singletons by tenant)');

select is(
  (select coalesce(string_agg(tg.tgname, ', ' order by tg.tgname), '')
     from pg_trigger tg
     join pg_proc f on f.oid = tg.tgfoid
    where tg.tgrelid = 'public.team_members'::regclass
      and f.proname in ('tg_snapshot_version', 'tg_snapshot_singleton')),
  '',
  'team_members keeps no history until owner item O-12 (PDPL: no erasure path for staff names and bios)');

select is(
  (select coalesce(string_agg(format('%s.%s', e.table_name, c.col), ', '
                              order by e.table_name, c.col), '')
     from app.release_entities e
     cross join lateral unnest(e.columns || e.exempt_columns) as c(col)
    where not exists (
      select 1 from pg_attribute a
       where a.attrelid = format('public.%I', e.table_name)::regclass
         and a.attname = c.col and a.attnum > 0 and not a.attisdropped)),
  '',
  'every column the registry names exists in its table');

select is(
  (select coalesce(string_agg(format('%s.%s', e.table_name, a.attname), ', '
                              order by e.table_name, a.attname), '')
     from app.release_entities e
     join pg_attribute a on a.attrelid = format('public.%I', e.table_name)::regclass
                        and a.attnum > 0 and not a.attisdropped
    where not (a.attname::text = any (
            e.columns || e.exempt_columns
            || array['id', 'tenant_id', 'version', 'created_at', 'updated_at', 'created_by',
                     'updated_by', 'published_at', 'scheduled_for', 'search_en', 'search_ar']))),
  '',
  'every column of a registry table is classified: writable, immediate, or system');

select is(
  (select coalesce(string_agg(e.table_name, ', ' order by e.table_name), '')
     from app.release_entities e
     join pg_class c on c.oid = format('public.%I', e.table_name)::regclass
    where not (c.relrowsecurity and c.relforcerowsecurity)
       or not exists (select 1 from pg_attribute a
                       where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped)
       or not exists (select 1 from pg_attribute a
                       where a.attrelid = c.oid and a.attname = 'version' and not a.attisdropped)),
  '',
  'every registry table is RLS enabled + forced and carries tenant_id and version');

select ok(
  (select bool_and(f.prosecdef
                   and exists (select 1 from unnest(f.proconfig) c where c like 'search_path=%'))
     from pg_proc f
    where f.oid in ('app.tg_snapshot_version()'::regprocedure,
                    'app.tg_snapshot_singleton()'::regprocedure))
  and (select count(distinct proowner) from pg_proc
        where oid in ('app.tg_snapshot_version()'::regprocedure,
                      'app.tg_snapshot_singleton()'::regprocedure)) = 1,
  'both snapshot triggers are SECURITY DEFINER with a pinned search_path, under one owner');

select is(
  (select coalesce(string_agg(r || ' ' || f, ', ' order by r, f), '')
     from unnest(array['anon', 'authenticated', 'service_role']::name[]) as r
     cross join unnest(array['app.release_token_valid()', 'app.current_release_id()',
                             'app.releases_enabled(uuid)', 'app.tg_snapshot_version()',
                             'app.tg_snapshot_singleton()', 'app.tg_draft_lock()']) as f
    where has_function_privilege(r, f, 'execute')),
  '',
  'no API role can call the token, flag or trigger functions');

-- ── 2. Fixtures (as the migration role) ────────────────────────────────────────────
insert into public.tenants (id, name) values
  ('38100000-0000-0000-0000-00000000000a', 'HistRelA'),
  ('38100000-0000-0000-0000-00000000000b', 'HistRelB');
insert into public.content_releases (id, tenant_id, status) values
  ('38100000-0000-0000-0000-0000000001a1', '38100000-0000-0000-0000-00000000000a', 'applying');
insert into public.navigation (id, tenant_id, location, label, href) values
  ('38100000-0000-0000-0000-0000000000e1', '38100000-0000-0000-0000-00000000000a', 'header',
   '{"en":"History","ar":"السجل"}', '/pg-history');
insert into public.site_profile (tenant_id, brand_name, contact_email, location) values
  ('38100000-0000-0000-0000-00000000000a', '{"en":"Studio","ar":"استوديو"}',
   'hello@example.com', '{"en":"Riyadh","ar":"الرياض"}');

create function _as(p_role text, p_sub text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    json_build_object(
      'sub', p_sub,
      'app_metadata', json_build_object(
        'role', p_role, 'tenant_id', '38100000-0000-0000-0000-00000000000a')
    )::text,
    true)
$$;

-- The release a navigation snapshot recorded, by version ('-' for none).
create function _nav_release(p_version int) returns text language sql as $$
  select coalesce(release_id::text, '-') from public.content_versions
   where entity_type = 'nav_item' and entity_id = '38100000-0000-0000-0000-0000000000e1'
     and version = p_version
$$;

create function _rename_nav(p_label text) returns void language sql as $$
  update public.navigation set label = jsonb_build_object('en', p_label, 'ar', 'تجربة')
   where id = '38100000-0000-0000-0000-0000000000e1'
$$;

-- ── 3. The release token ────────────────────────────────────────────────────────────
select is(app.release_token_valid(), false, 'no token outside a release');
select set_config('app.release_id', '38100000-0000-0000-0000-0000000001a1', true);
select set_config('app.release_apply', pg_current_xact_id()::text, true);
select is(app.release_token_valid(), true, 'the token is valid in the transaction that set it');
select set_config('app.release_apply', '1', true);
select is(app.release_token_valid(), false, 'a token naming another transaction is not');
select set_config('app.release_apply', '', true);

-- ── 4. A snapshot names its release only inside one ────────────────────────────────
set local role authenticated;
select _as('content_creator', '38100000-0000-0000-0000-0000000000c1');
select _rename_nav('Edited');                                    -- version 2, no release
reset role;
select set_config('app.release_apply', pg_current_xact_id()::text, true);
set local role authenticated;
select _rename_nav('Released');                                  -- version 3, in the release
reset role;
select set_config('app.release_apply', '1', true);
set local role authenticated;
select _rename_nav('Stale token');                               -- version 4, no release
reset role;

select is(_nav_release(2), '-', 'a staff edit outside a release records no release');
select is(_nav_release(3), '38100000-0000-0000-0000-0000000001a1',
  'an edit inside a release records that release');
select is(_nav_release(4), '-', 'a token from another transaction records no release');

select set_config('app.release_apply', pg_current_xact_id()::text, true);
select set_config('app.release_id', 'not-a-release', true);
set local role authenticated;
select throws_ok($$ select _rename_nav('Broken') $$, '22023', 'a release is applying without its id',
  'inside a release, a write whose release id is unreadable fails instead of losing it');
reset role;
select set_config('app.release_apply', '', true);
select set_config('app.release_id', '', true);

-- ── 5. The tables 0038 brought into history ─────────────────────────────────────────
set local role authenticated;
select _as('developer', '38100000-0000-0000-0000-0000000000d1');
update public.site_profile set founded_year = 2020
 where tenant_id = '38100000-0000-0000-0000-00000000000a';
insert into public.custom_themes (tenant_id, name)
values ('38100000-0000-0000-0000-00000000000a', 'pgTAP history theme');
select _as('seo', '38100000-0000-0000-0000-0000000000e5');
insert into public.seo_defaults (tenant_id) values ('38100000-0000-0000-0000-00000000000a');
insert into public.redirects (tenant_id, source_path, target_path)
values ('38100000-0000-0000-0000-00000000000a', '/pg-history-old', '/pg-history');
select _as('content_creator', '38100000-0000-0000-0000-0000000000c1');
insert into public.categories (tenant_id, slug, name)
values ('38100000-0000-0000-0000-00000000000a', 'pg-history', '{"en":"History","ar":"السجل"}');
insert into public.team_members (tenant_id, slug, name)
values ('38100000-0000-0000-0000-00000000000a', 'pg-history', '{"en":"Ada","ar":"آدا"}');
insert into public.statistics (tenant_id, slug, label, value)
values ('38100000-0000-0000-0000-00000000000a', 'pg-history', '{"en":"Years","ar":"سنوات"}', '10');
insert into public.certifications (tenant_id, slug, name)
values ('38100000-0000-0000-0000-00000000000a', 'pg-history', '{"en":"ISO","ar":"أيزو"}');
reset role;

select is(
  (select entity_id::text || ' v' || version || ' by ' || created_by::text
     from public.content_versions
    where entity_type = 'site_profile' and tenant_id = '38100000-0000-0000-0000-00000000000a'
    order by version desc limit 1),
  '38100000-0000-0000-0000-00000000000a v2 by 38100000-0000-0000-0000-0000000000d1',
  'a site_profile edit is snapshotted, keyed by the tenant, attributed to the developer');
select is(
  (select count(*)::int from public.content_versions
    where entity_type = 'seo_defaults' and entity_id = '38100000-0000-0000-0000-00000000000a'
      and created_by = '38100000-0000-0000-0000-0000000000e5'),
  1, 'the first save of seo_defaults is snapshotted, keyed by the tenant');
select is(
  (select count(*)::int from public.content_versions v
     join public.redirects r on r.id = v.entity_id
    where v.entity_type = 'redirect' and r.source_path = '/pg-history-old'
      and v.created_by = '38100000-0000-0000-0000-0000000000e5'),
  1, 'a redirect saved by seo is snapshotted');
select is(
  (select count(*)::int from public.content_versions
    where entity_type = 'custom_theme' and tenant_id = '38100000-0000-0000-0000-00000000000a'
      and created_by = '38100000-0000-0000-0000-0000000000d1'),
  1, 'a theme saved by the developer is snapshotted');
select is(
  (select string_agg(entity_type, ',' order by entity_type) from public.content_versions
    where tenant_id = '38100000-0000-0000-0000-00000000000a'
      and created_by = '38100000-0000-0000-0000-0000000000c1'
      and entity_type in ('category', 'statistic', 'certification')),
  'category,certification,statistic',
  'categories, statistics and certifications are snapshotted');
select is(
  (select count(*)::int from public.content_versions
    where tenant_id = '38100000-0000-0000-0000-00000000000a' and entity_type = 'team_member'),
  0, 'a team member saved by the content creator leaves no history row (O-12)');

-- ── 6. A snapshot cannot borrow another tenant's release ───────────────────────────
select throws_ok(
  $$ insert into public.content_versions (tenant_id, entity_type, entity_id, version, snapshot, release_id)
     values ('38100000-0000-0000-0000-00000000000b', 'nav_item', gen_random_uuid(), 1, '{}',
             '38100000-0000-0000-0000-0000000001a1') $$,
  '23503', null, 'a history row can only name a release of its own tenant');

select * from finish();
rollback;
