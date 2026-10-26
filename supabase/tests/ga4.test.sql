-- pgTAP: the GA4 measurement id reaches the public pages (Admin v2 U15, migration
-- 0112_ga4.sql: anon's column grant on site_integrations.ga4_measurement_id). Run with
-- `supabase test db`.
--
--   • the catalog: anon reads exactly three columns of the row (the tenant, U11's Search
--     Console code and, new, the GA4 id), holds no table privilege and writes nothing; PUBLIC
--     holds nothing; staff still read the id (the Integrations screen);
--   • anon reads the launch tenant's id and never another tenant's row, through the column
--     only (42501 on every other column and on the whole row), and cannot change it;
--   • the staff layers are 0105's, unchanged by the grant: Admin and SEO read the id, Content
--     Creator, Developer and Sales read no row, another tenant's Admin reads none of this
--     tenant's, and a stale token (a demoted SEO) reads nothing;
--   • the service role reads every tenant's (the backups' and the cron's role).
--
-- T1 is created older than any seeded tenant, so inside this transaction it is the launch
-- tenant anon resolves to (app.default_tenant_id()).

begin;
select plan(19);

-- ── fixtures (as the migration role) ─────────────────────────────────────────
insert into public.tenants (id, name, created_at) values
  ('15100000-0000-0000-0000-000000000001', 'U15 one', '2000-01-01T00:00:00Z'),
  ('15100000-0000-0000-0000-0000000000ff', 'U15 two', '2000-01-02T00:00:00Z');
insert into auth.users (id, email) values
  ('15100000-0000-0000-0000-0000000000a1', 'u15-admin@example.test'),
  ('15100000-0000-0000-0000-0000000000e1', 'u15-seo@example.test'),
  ('15100000-0000-0000-0000-0000000000c1', 'u15-creator@example.test'),
  ('15100000-0000-0000-0000-0000000000d1', 'u15-developer@example.test'),
  ('15100000-0000-0000-0000-0000000000b1', 'u15-sales@example.test'),
  ('15100000-0000-0000-0000-0000000000e2', 'u15-demoted@example.test'),
  ('15100000-0000-0000-0000-0000000000f1', 'u15-other@example.test');
insert into public.profiles (id, tenant_id, role, is_active, locked_until) values
  ('15100000-0000-0000-0000-0000000000a1', '15100000-0000-0000-0000-000000000001', 'admin', true, null),
  ('15100000-0000-0000-0000-0000000000e1', '15100000-0000-0000-0000-000000000001', 'seo', true, null),
  ('15100000-0000-0000-0000-0000000000c1', '15100000-0000-0000-0000-000000000001', 'content_creator', true, null),
  ('15100000-0000-0000-0000-0000000000d1', '15100000-0000-0000-0000-000000000001', 'developer', true, null),
  ('15100000-0000-0000-0000-0000000000b1', '15100000-0000-0000-0000-000000000001', 'sales', true, null),
  -- Stale: the token below still says seo.
  ('15100000-0000-0000-0000-0000000000e2', '15100000-0000-0000-0000-000000000001', 'content_creator', true, null),
  ('15100000-0000-0000-0000-0000000000f1', '15100000-0000-0000-0000-0000000000ff', 'admin', true, null);
insert into public.site_integrations (tenant_id, ga4_measurement_id, search_console_token) values
  ('15100000-0000-0000-0000-000000000001', 'G-LAUNCH1', 'LaunchCode_0123456'),
  ('15100000-0000-0000-0000-0000000000ff', 'G-OTHER22', 'OtherCode_01234567');

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
-- The launch tenant's GA4 ids the CURRENT role reads (a count, so a refused read is 0).
create function _ids() returns int language sql as $$
  select count(ga4_measurement_id)::int from public.site_integrations
   where tenant_id = '15100000-0000-0000-0000-000000000001'
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
grant execute on function _as(text, text, text), _ids(), _state(text)
  to anon, authenticated, service_role;

-- ── 1. The catalog ───────────────────────────────────────────────────────────
select is(
  (select string_agg(a.attname::text, ',' order by a.attname::text collate "C")
     from pg_attribute a
    where a.attrelid = 'public.site_integrations'::regclass and a.attnum > 0 and not a.attisdropped
      and has_column_privilege('anon', a.attrelid, a.attnum, 'select')),
  'ga4_measurement_id,search_console_token,tenant_id',
  'anon may read the GA4 id beside the Search Console code and the tenant, no other column');
select ok(
  not has_table_privilege('anon', 'public.site_integrations',
                          'select, insert, update, delete, truncate, references, trigger')
  and not has_any_column_privilege('anon', 'public.site_integrations', 'insert, update, references')
  and not has_any_column_privilege('public', 'public.site_integrations',
                                   'select, insert, update, references'),
  'anon holds no table privilege and writes no column; PUBLIC holds nothing');
select ok(
  has_column_privilege('authenticated', 'public.site_integrations', 'ga4_measurement_id', 'select')
  and not has_table_privilege('authenticated', 'public.site_integrations', 'select, delete'),
  'staff still read the GA4 id by column (the Integrations screen), and never table-wide');

-- ── 2. anon: the launch tenant's id, through its column only ──────────────────
set local role anon;
select _as(null, null, null);
select is((select ga4_measurement_id from public.site_integrations), 'G-LAUNCH1',
  'anon reads the launch tenant''s GA4 id');
select is((select count(*)::int from public.site_integrations), 1,
  'anon reads one row: never another tenant''s');
select is((select count(*)::int from public.site_integrations where ga4_measurement_id = 'G-OTHER22'), 0,
  'anon never sees the other tenant''s id, even when it asks for it');
select is(_state($$ select calendly_url from public.site_integrations $$)
          || '/' || _state($$ select version from public.site_integrations $$)
          || '/' || _state($$ select * from public.site_integrations $$),
  '42501/42501/42501', 'anon reads no other column of the row, nor the whole row');
select is(_state($$ update public.site_integrations set ga4_measurement_id = 'G-ANONSET1' $$),
  '42501', 'anon cannot change the id');

-- ── 3. The staff layers, unchanged by the grant ───────────────────────────────
reset role;
set local role authenticated;
select _as('15100000-0000-0000-0000-0000000000a1', 'admin', '15100000-0000-0000-0000-000000000001');
select is(_ids(), 1, 'admin reads the id');
select _as('15100000-0000-0000-0000-0000000000e1', 'seo', '15100000-0000-0000-0000-000000000001');
select is(_ids(), 1, 'seo reads the id');
select _as('15100000-0000-0000-0000-0000000000c1', 'content_creator', '15100000-0000-0000-0000-000000000001');
select is(_ids(), 0, 'content_creator reads no row (settings.integrations is Admin + SEO)');
select _as('15100000-0000-0000-0000-0000000000d1', 'developer', '15100000-0000-0000-0000-000000000001');
select is(_ids(), 0, 'developer reads no row');
select _as('15100000-0000-0000-0000-0000000000b1', 'sales', '15100000-0000-0000-0000-000000000001');
select is(_ids(), 0, 'a sales token reads no row: what anon reads of it, Sales does not need');
select _as('15100000-0000-0000-0000-0000000000f1', 'admin', '15100000-0000-0000-0000-0000000000ff');
select is(_ids(), 0, 'other_tenant reads none of this tenant''s row');
select is((select ga4_measurement_id from public.site_integrations
            where tenant_id = '15100000-0000-0000-0000-0000000000ff'), 'G-OTHER22',
  'and reads its own (the comparison is not of nothing)');
select _as('15100000-0000-0000-0000-0000000000e2', 'seo', '15100000-0000-0000-0000-000000000001');
select is(_ids(), 0, 'a demoted seo token (profile content_creator) reads nothing (the live check)');

-- ── 4. The service role, and a cleared id ──────────────────────────────────────
reset role;
set local role service_role;
select is((select count(*)::int from public.site_integrations
            where tenant_id in ('15100000-0000-0000-0000-000000000001',
                                '15100000-0000-0000-0000-0000000000ff')), 2,
  'the service role reads every tenant''s row');
update public.site_integrations set ga4_measurement_id = null
 where tenant_id = '15100000-0000-0000-0000-000000000001';
reset role;
set local role anon;
select _as(null, null, null);
select is((select ga4_measurement_id from public.site_integrations), null,
  'a cleared id is no id for anon (no GA4), never another tenant''s');
select is((select count(*)::int from public.site_integrations), 1,
  'and anon still reads the one launch row');
reset role;

select * from finish();
rollback;
