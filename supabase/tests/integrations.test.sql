-- pgTAP: integrations, typed (Admin v2 U11, migration 0105_integrations.sql, its contract
-- U11c, 0110_integrations_contract.sql, and U15's anon read of the GA4 id, 0113_ga4.sql;
-- CLAUDE.md §5 "Integrations"). Run with `supabase test db`.
--
--   • the catalog: RLS forced, the exact policy set, the helper answers settings.integrations
--     for every role, the table's columns (the four legacy jsonb boxes are gone since the
--     contract), the grants by column (anon reads the Search Console code, the GA4 id and the
--     tenant, nothing else; staff hold the three typed values, the key, the version and
--     updated_at, never DELETE, nor UPDATE the key, the version or the stamps), and the table
--     stays out of the release registry (immediate, P-3);
--   • Admin and SEO read, add and change the row (the version moves, the actor is stamped;
--     a statement naming a legacy box is refused, 42703: there is nothing left to write);
--   • Content Creator, Developer and Sales read nothing and change nothing (RLS: since U11
--     the staff read is Admin + SEO, not every CMS role);
--   • anon reads the launch tenant's Search Console code and GA4 id (0113) and nothing else of
--     the row (42501 on any other column), never another tenant's row, and writes nothing;
--   • another tenant's Admin reads and writes none of this tenant's row;
--   • stale tokens (a demoted SEO, a deactivated Admin, a locked SEO) read and write nothing,
--     their own tenant's row included (the RESTRICTIVE live check);
--   • the CHECKs refuse what is not a public identifier of the right shape (23514);
--   • the service role reads and writes past RLS (the cron and the backups' role);
--   • the guides 0105 puts reach a new tenant (H11's catalog seeds it), the counts a floor.
--
-- T1 is created older than any seeded tenant, so inside this transaction it is the launch
-- tenant anon resolves to (app.default_tenant_id()).

begin;
select plan(47);

-- ── fixtures (as the migration role) ─────────────────────────────────────────
insert into public.tenants (id, name, created_at) values
  ('11100000-0000-0000-0000-000000000001', 'U11 one', '2000-01-01T00:00:00Z'),
  ('11100000-0000-0000-0000-0000000000ff', 'U11 two', '2000-01-02T00:00:00Z');
insert into auth.users (id, email) values
  ('11100000-0000-0000-0000-0000000000a1', 'u11-admin@example.test'),
  ('11100000-0000-0000-0000-0000000000e1', 'u11-seo@example.test'),
  ('11100000-0000-0000-0000-0000000000c1', 'u11-creator@example.test'),
  ('11100000-0000-0000-0000-0000000000d1', 'u11-developer@example.test'),
  ('11100000-0000-0000-0000-0000000000b1', 'u11-sales@example.test'),
  ('11100000-0000-0000-0000-0000000000e2', 'u11-demoted@example.test'),
  ('11100000-0000-0000-0000-0000000000a3', 'u11-inactive@example.test'),
  ('11100000-0000-0000-0000-0000000000e4', 'u11-locked@example.test'),
  ('11100000-0000-0000-0000-0000000000f1', 'u11-other@example.test');
insert into public.profiles (id, tenant_id, role, is_active, locked_until) values
  ('11100000-0000-0000-0000-0000000000a1', '11100000-0000-0000-0000-000000000001', 'admin', true, null),
  ('11100000-0000-0000-0000-0000000000e1', '11100000-0000-0000-0000-000000000001', 'seo', true, null),
  ('11100000-0000-0000-0000-0000000000c1', '11100000-0000-0000-0000-000000000001', 'content_creator', true, null),
  ('11100000-0000-0000-0000-0000000000d1', '11100000-0000-0000-0000-000000000001', 'developer', true, null),
  ('11100000-0000-0000-0000-0000000000b1', '11100000-0000-0000-0000-000000000001', 'sales', true, null),
  -- Stale: each token below still says seo or admin.
  ('11100000-0000-0000-0000-0000000000e2', '11100000-0000-0000-0000-000000000001', 'content_creator', true, null),
  ('11100000-0000-0000-0000-0000000000a3', '11100000-0000-0000-0000-000000000001', 'admin', false, null),
  ('11100000-0000-0000-0000-0000000000e4', '11100000-0000-0000-0000-000000000001', 'seo', true,
   now() + interval '10 minutes'),
  ('11100000-0000-0000-0000-0000000000f1', '11100000-0000-0000-0000-0000000000ff', 'admin', true, null);
-- The other tenant's row, with a code anon must never see.
insert into public.site_integrations (tenant_id, search_console_token, ga4_measurement_id)
  values ('11100000-0000-0000-0000-0000000000ff', 'OtherTenantCode_22', 'G-OTHER22');

create function _as(p_sub text, p_role text, p_tid text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    case when p_role is null then ''
         else jsonb_build_object(
                'sub', p_sub,
                'app_metadata', jsonb_build_object('role', p_role, 'tenant_id', p_tid))::text end,
    true
  )
$$;
create function _rows(p_sql text) returns int language plpgsql as $f$
declare
  n int;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return n;
end $f$;
-- T1's rows as the CURRENT role (and T2's, below).
create function _seen() returns int language sql as $$
  select count(*)::int from public.site_integrations where tenant_id = '11100000-0000-0000-0000-000000000001'
$$;
-- The SQLSTATE a statement raises ('' when it runs), in a subtransaction it rolls back.
create function _state(p_sql text) returns text language plpgsql as $f$
begin
  begin
    execute p_sql;
    raise exception using errcode = 'P0004', message = 'ran';
  exception
    when sqlstate 'P0004' then return '';
    when others then return sqlstate;
  end;
end $f$;
grant execute on function _as(text, text, text), _rows(text), _seen(), _state(text)
  to anon, authenticated, service_role;

-- ── 1. The catalog ───────────────────────────────────────────────────────────
select ok((select relrowsecurity and relforcerowsecurity from pg_class
            where oid = 'public.site_integrations'::regclass),
  'site_integrations is ENABLE + FORCE row level security');
select is(
  (select string_agg(format('%s %s %s %s', policyname, cmd, permissive, roles), ', '
                     order by policyname collate "C")
     from pg_policies where schemaname = 'public' and tablename = 'site_integrations'),
  'site_integrations_insert INSERT PERMISSIVE {authenticated}, '
  || 'site_integrations_live ALL RESTRICTIVE {authenticated}, '
  || 'site_integrations_public_read SELECT PERMISSIVE {anon}, '
  || 'site_integrations_read SELECT PERMISSIVE {authenticated}, '
  || 'site_integrations_update UPDATE PERMISSIVE {authenticated}',
  'the policies: the JWT layer for Admin + SEO, the RESTRICTIVE live check, the anon read');
select is(
  (select string_agg(r, ',' order by r) from unnest(enum_range(null::public.app_role)::text[]) as r
    where app.role_manages_integrations(r)),
  'admin,seo', 'app.role_manages_integrations answers settings.integrations for every role');
select is(
  (select string_agg(a.attname::text, ',' order by a.attname::text collate "C")
     from pg_attribute a
    where a.attrelid = 'public.site_integrations'::regclass and a.attnum > 0 and not a.attisdropped
      and has_column_privilege('anon', a.attrelid, a.attnum, 'select')),
  'ga4_measurement_id,search_console_token,tenant_id',
  'anon may read the Search Console code, the GA4 id (0113) and the tenant, no other column');
select is(
  (select string_agg(a.attname::text, ',' order by a.attname::text collate "C")
     from pg_attribute a
    where a.attrelid = 'public.site_integrations'::regclass and a.attnum > 0 and not a.attisdropped),
  'calendly_url,ga4_measurement_id,search_console_token,tenant_id,updated_at,updated_by,version',
  'the table holds the three typed values, the key, the version and the stamps: the legacy jsonb is gone (U11c)');
select is(
  (select string_agg(p.priv || ':' || (
            select string_agg(a.attname::text, ',' order by a.attname::text collate "C")
              from pg_attribute a
             where a.attrelid = 'public.site_integrations'::regclass and a.attnum > 0
               and not a.attisdropped
               and has_column_privilege('authenticated', a.attrelid, a.attnum, p.priv)),
          '; ' order by p.ord)
     from (values (1, 'select'), (2, 'insert'), (3, 'update')) as p(ord, priv)),
  'select:calendly_url,ga4_measurement_id,search_console_token,tenant_id,updated_at,version; '
  || 'insert:calendly_url,ga4_measurement_id,search_console_token,tenant_id; '
  || 'update:calendly_url,ga4_measurement_id,search_console_token',
  'staff hold the typed values, the key, the version and updated_at, column by column, and nothing else');
select ok(
  not has_table_privilege('authenticated', 'public.site_integrations', 'delete, truncate, references, trigger')
  and not has_column_privilege('authenticated', 'public.site_integrations', 'tenant_id', 'update')
  and not has_column_privilege('authenticated', 'public.site_integrations', 'version', 'update')
  and not has_column_privilege('authenticated', 'public.site_integrations', 'updated_at', 'update')
  and not has_column_privilege('authenticated', 'public.site_integrations', 'updated_by', 'update')
  and not has_any_column_privilege('anon', 'public.site_integrations', 'insert, update'),
  'staff never DELETE the row nor UPDATE its key, version or stamps; anon writes nothing');
select ok(not exists (select 1 from app.release_entities where table_name = 'site_integrations'),
  'site_integrations is not in the release registry (immediate, P-3)');

-- ── 2. Admin and SEO read, add and change ─────────────────────────────────────
set local role authenticated;
select _as('11100000-0000-0000-0000-0000000000a1', 'admin', '11100000-0000-0000-0000-000000000001');
select lives_ok(
  $$ insert into public.site_integrations (tenant_id, ga4_measurement_id, search_console_token)
     values ('11100000-0000-0000-0000-000000000001', 'G-ABC123XYZ', 'FirstCode_abcdef0123') $$,
  'admin adds the row on the first save');
-- Read as the migration role: staff hold no SELECT on updated_by (the screen never shows it).
reset role;
select is((select updated_by::text from public.site_integrations
            where tenant_id = '11100000-0000-0000-0000-000000000001'),
  '11100000-0000-0000-0000-0000000000a1', 'the actor is stamped from the token');
set local role authenticated;
select _as('11100000-0000-0000-0000-0000000000e1', 'seo', '11100000-0000-0000-0000-000000000001');
select is(_seen(), 1, 'seo reads it');
select is(_rows($$ update public.site_integrations
                   set search_console_token = 'SecondCode_abcdef012',
                       calendly_url = 'https://calendly.com/studio/30min'
                   where tenant_id = '11100000-0000-0000-0000-000000000001' and version = 1 $$),
  1, 'seo changes it at the version it read');
select is((select version from public.site_integrations
            where tenant_id = '11100000-0000-0000-0000-000000000001'),
  2, 'the version moves (tg_bump_version)');
select is(_rows($$ update public.site_integrations set calendly_url = null
                   where tenant_id = '11100000-0000-0000-0000-000000000001' and version = 1 $$),
  0, 'a save at a stale version changes nothing (the route answers 409)');
select is(_state($$ insert into public.site_integrations (tenant_id)
                    values ('11100000-0000-0000-0000-000000000001') $$),
  '23505', 'a second first save is the primary key''s refusal (the route answers 409), not RLS''s');
select _as('11100000-0000-0000-0000-0000000000a1', 'admin', '11100000-0000-0000-0000-000000000001');
select is(_state($$ update public.site_integrations set recaptcha = '{"secret": "x"}'::jsonb
                    where tenant_id = '11100000-0000-0000-0000-000000000001' $$)
          || '/' || _state($$ select search_console from public.site_integrations $$),
  '42703/42703', 'an admin token can neither write nor read a legacy box: the contract dropped them (U11c)');

-- ── 3. Content Creator, Developer and Sales: nothing ─────────────────────────
select _as('11100000-0000-0000-0000-0000000000c1', 'content_creator', '11100000-0000-0000-0000-000000000001');
select is(_seen(), 0, 'content_creator reads nothing (since U11 the staff read is Admin + SEO)');
select is(_rows($$ update public.site_integrations set ga4_measurement_id = null
                   where tenant_id = '11100000-0000-0000-0000-000000000001' $$),
  0, 'content_creator changes nothing');
-- Its own tenant's id: the tenant predicate passes, so only the role checks can refuse it (an
-- RLS pass would reach the existing row's key, 23505).
select is(_state($$ insert into public.site_integrations (tenant_id)
                    values ('11100000-0000-0000-0000-000000000001') $$),
  '42501', 'content_creator cannot add a row (WITH CHECK, before the key)');
select _as('11100000-0000-0000-0000-0000000000d1', 'developer', '11100000-0000-0000-0000-000000000001');
select is(_seen(), 0, 'developer reads nothing');
select is(_rows($$ update public.site_integrations set ga4_measurement_id = null
                   where tenant_id = '11100000-0000-0000-0000-000000000001' $$),
  0, 'developer changes nothing');
select is(_state($$ insert into public.site_integrations (tenant_id)
                    values ('11100000-0000-0000-0000-000000000001') $$),
  '42501', 'developer cannot add a row (WITH CHECK, before the key)');
select _as('11100000-0000-0000-0000-0000000000b1', 'sales', '11100000-0000-0000-0000-000000000001');
select is(_seen() + _rows($$ update public.site_integrations set calendly_url = null $$),
  0, 'a sales token reads and changes nothing');

-- ── 4. anon: the launch tenant's code, and nothing else ───────────────────────
reset role;
set local role anon;
select _as(null, null, null);
select is((select search_console_token from public.site_integrations),
  'SecondCode_abcdef012', 'anon reads the launch tenant''s Search Console code');
select is((select count(*)::int from public.site_integrations), 1,
  'anon reads one row: never another tenant''s');
select is((select ga4_measurement_id from public.site_integrations), 'G-ABC123XYZ',
  'anon reads the launch tenant''s GA4 id (0113: the page that loads GA4 carries it)');
select is(_state($$ select calendly_url from public.site_integrations $$),
  '42501', 'anon cannot read the Calendly link');
select is(_state($$ select version, updated_at from public.site_integrations $$),
  '42501', 'anon cannot read the version or the stamps');
select is(_state($$ select * from public.site_integrations $$),
  '42501', 'anon cannot read the whole row');
select is(_state($$ update public.site_integrations set search_console_token = 'AnonCode_abcdef0123' $$),
  '42501', 'anon cannot change the code');
select is(_state($$ insert into public.site_integrations (tenant_id) values (gen_random_uuid()) $$)
          || '/' || _state($$ delete from public.site_integrations $$),
  '42501/42501', 'anon cannot add or delete a row');

-- ── 5. Another tenant's Admin ──────────────────────────────────────────────────
reset role;
set local role authenticated;
select _as('11100000-0000-0000-0000-0000000000f1', 'admin', '11100000-0000-0000-0000-0000000000ff');
select is(_seen(), 0, 'other_tenant reads none of this tenant''s row');
select is((select count(*)::int from public.site_integrations
            where tenant_id = '11100000-0000-0000-0000-0000000000ff'), 1,
  'and reads its own (the comparison is not of nothing)');
select is(_rows($$ update public.site_integrations set search_console_token = 'Hijacked_abcdef0123'
                   where tenant_id = '11100000-0000-0000-0000-000000000001' $$),
  0, 'other_tenant changes none of this tenant''s row');
select is(_state($$ insert into public.site_integrations (tenant_id)
                    values ('11100000-0000-0000-0000-000000000001') $$),
  '42501', 'other_tenant cannot add a row naming this tenant (WITH CHECK, before the key)');

-- ── 6. Stale tokens: nothing, their own tenant included ───────────────────────
select _as('11100000-0000-0000-0000-0000000000e2', 'seo', '11100000-0000-0000-0000-000000000001');
select is(_seen(), 0, 'a demoted seo token (profile content_creator) reads nothing');
select is(_rows($$ update public.site_integrations set search_console_token = 'Stale_abcdef012345'
                   where tenant_id = '11100000-0000-0000-0000-000000000001' $$),
  0, 'and changes nothing');
select is(_state($$ insert into public.site_integrations (tenant_id)
                    values ('11100000-0000-0000-0000-000000000001') $$),
  '42501', 'and is refused an insert by the live check, before the key (a live seo gets 23505 above)');
select _as('11100000-0000-0000-0000-0000000000a3', 'admin', '11100000-0000-0000-0000-000000000001');
select is(_seen() + _rows($$ update public.site_integrations set ga4_measurement_id = null $$),
  0, 'a deactivated admin reads and changes nothing');
select _as('11100000-0000-0000-0000-0000000000e4', 'seo', '11100000-0000-0000-0000-000000000001');
select is(_seen() + _rows($$ update public.site_integrations set ga4_measurement_id = null $$),
  0, 'a locked seo reads and changes nothing');

-- ── 7. The CHECKs: public identifiers of the right shape only ──────────────────
reset role;
select _as(null, null, null);
select is(
  (select string_agg(_state(format(
            'update public.site_integrations set %I = %L where tenant_id = %L',
            v.col, v.val, '11100000-0000-0000-0000-000000000001')), ',')
     from (values
       ('ga4_measurement_id', 'g-abc1234'),
       ('ga4_measurement_id', 'UA-123456-1'),
       ('ga4_measurement_id', 'G-ABC'),
       ('search_console_token', 'abc"def<ghi>jkl'),
       ('search_console_token', 'has a space in it'),
       ('search_console_token', 'short'),
       ('search_console_token', repeat('a', 101)),
       ('calendly_url', 'http://calendly.com/studio'),
       ('calendly_url', 'https://evil.example/studio'),
       ('calendly_url', 'https://calendly.com.evil.example/studio'),
       ('calendly_url', 'https://calendly.com/studio?x=1'),
       ('calendly_url', 'https://calendly.com/a/b/c/d'),
       ('calendly_url', 'https://calendly.com/' || repeat('a', 190))) as v(col, val)),
  '23514,23514,23514,23514,23514,23514,23514,23514,23514,23514,23514,23514,23514',
  'every malformed id, code or link is refused by a CHECK');
select is(
  (select string_agg(_state(format(
            'update public.site_integrations set %I = %L where tenant_id = %L',
            v.col, v.val, '11100000-0000-0000-0000-000000000001')), ',')
     from (values
       ('ga4_measurement_id', 'G-ABC123XYZ'),
       ('ga4_measurement_id', null),
       ('search_console_token', 'aZ09_-aZ09_-aZ09_-aZ09_-aZ09_-aZ09_-aZ09_'),
       ('calendly_url', 'https://calendly.com/studio'),
       ('calendly_url', 'https://calendly.com/studio/30min/'),
       ('calendly_url', null)) as v(col, val)),
  ',,,,,', 'a well-formed id, code and link, and null, are accepted');

-- ── 8. The service role ──────────────────────────────────────────────────────────
set local role service_role;
select is(_rows($$ update public.site_integrations set ga4_measurement_id = 'G-SERVICE1'
                   where tenant_id = '11100000-0000-0000-0000-0000000000ff' $$)
          + (select count(*)::int from public.site_integrations
              where tenant_id in ('11100000-0000-0000-0000-000000000001', '11100000-0000-0000-0000-0000000000ff')),
  3, 'the service role reads every row and writes past RLS');
reset role;

-- ── 9. The guides reach a new tenant (H11's catalog seeds it) ──────────────────────
select is(
  (select string_agg(h.slug || ' ' || h.sort_order, ', ' order by h.slug)
     from public.help_articles h
    where h.tenant_id = '11100000-0000-0000-0000-000000000001'
      and h.slug in ('integrations', 'forms-and-spam')),
  'forms-and-spam 85, integrations 62', 'the two new guides, in their places');
select ok(
  (select '/admin/settings/notifications' = any (h.screens) from public.help_articles h
    where h.tenant_id = '11100000-0000-0000-0000-000000000001' and h.slug = 'your-account'),
  'your-account names the bell''s settings screen');
select is(
  (select caps::text from public.help_articles
    where tenant_id = '11100000-0000-0000-0000-000000000001' and slug = 'integrations')
  || ' ' ||
  (select caps::text from public.help_articles
    where tenant_id = '11100000-0000-0000-0000-000000000001' and slug = 'forms-and-spam'),
  '{settings.integrations} {settings.general}', 'each guide is for the roles that open its screen');
select ok(
  (select count(*) from public.help_articles where tenant_id = '11100000-0000-0000-0000-000000000001') >= 21,
  'the tenant holds the whole set (a floor, H11 rule 3)');

select * from finish();
rollback;
