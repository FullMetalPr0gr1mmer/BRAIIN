-- pgTAP: site health v2's readings (0067, Admin v2 G2): public.health_probes, its stamps
-- trigger, its grants and RLS. Run with `supabase test db`.
--
--   • who reads: Admin and Developer read their tenant's three rows (siteHealth.view,
--     app.role_site_health); Content Creator and SEO read none; anon is refused by the grant
--     layer; another tenant's Admin reads its own rows and none of this tenant's. A token
--     still saying admin for a profile now seo reads them until it expires (decision D4: no
--     live check on this non-personal table; the stale-token gap, documented).
--   • who writes: no staff role inserts, updates or deletes (no privilege); the service role
--     inserts and updates, and cannot delete (rows go with their tenant).
--   • the trigger: state_since set on insert, kept on an update that keeps the state, moved
--     when the state changes, and moved when the probe goes stale (its sixth failed read in a
--     row) even if the state stays `unknown` (a probe never read); a supplied state_since or
--     updated_at is ignored.
--   • the CHECKs (kind, state, facts an object of at most 16 KB), the key, the tenant's
--     cascade, and the grants as the migration's postconditions state them.
--   • the guides: every tenant holds the rewritten site health guide, and the set's count is
--     0061's.
--
-- Fixtures are two tenants of this file's own; every count is scoped to them.

begin;
select plan(46);

-- ── fixtures (as the migration role) ─────────────────────────────────────────
insert into public.tenants (id, name) values
  ('67000000-0000-0000-0000-000000000001', 'G2 one'),
  ('67000000-0000-0000-0000-0000000000ff', 'G2 two');

create function _as(p_role text, p_tid text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    case when p_role is null then ''
         else jsonb_build_object(
                'sub', '67000000-0000-0000-0000-0000000000a1',
                'app_metadata', jsonb_build_object('role', p_role, 'tenant_id', p_tid))::text end,
    true
  )
$$;

-- Rows the CURRENT role sees of a tenant.
create function _seen(p_tid uuid) returns int language sql as $$
  select count(*)::int from public.health_probes where tenant_id = p_tid
$$;

-- A row as the migration role (RLS bypassed), for the trigger's checks.
create function _probe(p_tid uuid, p_kind text) returns public.health_probes
  language sql security definer as $$
  select * from public.health_probes where tenant_id = p_tid and kind = p_kind
$$;

-- Three rows per tenant, written as the cron writes them: the service role.
set local role service_role;
select lives_ok($$
  insert into public.health_probes (tenant_id, kind, state, facts, read_ok, failures, checked_at, ok_at,
                                    state_since, updated_at)
  values ('67000000-0000-0000-0000-000000000001', 'uptime', 'ok', '{"ratio30": 99.98}', true, 0,
          now(), now(), '2000-01-01T00:00:00Z', '2000-01-01T00:00:00Z'),
         ('67000000-0000-0000-0000-000000000001', 'domain', 'ok', '{"apex": "example.com"}', true, 0,
          now(), now(), default, default),
         ('67000000-0000-0000-0000-000000000001', 'certificate', 'info', '{}', true, 0,
          now(), now(), default, default),
         ('67000000-0000-0000-0000-0000000000ff', 'uptime', 'off', '{}', false, 0, now(), null, default, default),
         ('67000000-0000-0000-0000-0000000000ff', 'domain', 'info', '{}', true, 0, now(), now(), default, default),
         ('67000000-0000-0000-0000-0000000000ff', 'certificate', 'info', '{}', true, 0, now(), now(), default, default)
$$, 'the service role inserts the readings');
select lives_ok($$
  update public.health_probes set failures = 1, read_ok = false
   where tenant_id = '67000000-0000-0000-0000-0000000000ff' and kind = 'domain'
$$, 'the service role updates a reading');
select throws_ok($$ delete from public.health_probes where tenant_id = '67000000-0000-0000-0000-0000000000ff' $$,
  '42501', 'permission denied for table health_probes', 'the service role deletes nothing (rows go with the tenant)');
select throws_ok($$ truncate public.health_probes $$,
  '42501', null, 'nor truncates the table');
reset role;

-- ── 1. the stamps trigger (as the migration role) ────────────────────────────
select is((_probe('67000000-0000-0000-0000-000000000001', 'uptime')).state_since, now(),
  'state_since is set on insert, whatever the writer sent');
select is((_probe('67000000-0000-0000-0000-000000000001', 'uptime')).updated_at, now(),
  'and so is updated_at');
-- Age the row with the trigger off, so a kept and a moved state_since differ from now().
alter table public.health_probes disable trigger health_probes_stamps;
update public.health_probes set state_since = '2001-01-01T00:00:00Z', updated_at = '2001-01-01T00:00:00Z'
 where tenant_id = '67000000-0000-0000-0000-000000000001' and kind = 'uptime';
alter table public.health_probes enable trigger health_probes_stamps;
set local role service_role;
update public.health_probes
   set failures = 2, state_since = '1999-01-01T00:00:00Z', updated_at = '1999-01-01T00:00:00Z'
 where tenant_id = '67000000-0000-0000-0000-000000000001' and kind = 'uptime';
reset role;
select is((_probe('67000000-0000-0000-0000-000000000001', 'uptime')).state_since,
  '2001-01-01T00:00:00Z'::timestamptz,
  'an update that keeps the state keeps state_since, ignoring the one supplied');
select is((_probe('67000000-0000-0000-0000-000000000001', 'uptime')).updated_at, now(),
  'and updated_at is the database''s now, not the one supplied');
set local role service_role;
update public.health_probes set state = 'fail'
 where tenant_id = '67000000-0000-0000-0000-000000000001' and kind = 'uptime';
reset role;
select is((_probe('67000000-0000-0000-0000-000000000001', 'uptime')).state_since, now(),
  'a change of state moves state_since');

-- A probe never read is `unknown` from its first failure; its sixth failure (stale: the
-- bell's "has not answered" item) must still move state_since, or the item's `since` would
-- be the first failure and a person who opened the bell in between would get no dot.
alter table public.health_probes disable trigger health_probes_stamps;
update public.health_probes
   set state = 'unknown', facts = '{}', read_ok = false, failures = 4,
       state_since = '2001-01-01T00:00:00Z'
 where tenant_id = '67000000-0000-0000-0000-000000000001' and kind = 'certificate';
alter table public.health_probes enable trigger health_probes_stamps;
set local role service_role;
update public.health_probes set failures = 5
 where tenant_id = '67000000-0000-0000-0000-000000000001' and kind = 'certificate';
reset role;
select is((_probe('67000000-0000-0000-0000-000000000001', 'certificate')).state_since,
  '2001-01-01T00:00:00Z'::timestamptz,
  'a fifth failure that keeps the state keeps state_since');
set local role service_role;
update public.health_probes set failures = 6
 where tenant_id = '67000000-0000-0000-0000-000000000001' and kind = 'certificate';
reset role;
select is((_probe('67000000-0000-0000-0000-000000000001', 'certificate')).state_since, now(),
  'the sixth failure in a row (stale) moves state_since, though the state stays unknown');
alter table public.health_probes disable trigger health_probes_stamps;
update public.health_probes set state_since = '2001-01-01T00:00:00Z'
 where tenant_id = '67000000-0000-0000-0000-000000000001' and kind = 'certificate';
alter table public.health_probes enable trigger health_probes_stamps;
set local role service_role;
update public.health_probes set failures = 7
 where tenant_id = '67000000-0000-0000-0000-000000000001' and kind = 'certificate';
reset role;
select is((_probe('67000000-0000-0000-0000-000000000001', 'certificate')).state_since,
  '2001-01-01T00:00:00Z'::timestamptz,
  'and a seventh, still stale, keeps it');

-- ── 2. the rules ─────────────────────────────────────────────────────────────
set local role service_role;
select throws_ok($$ insert into public.health_probes (tenant_id, kind, state)
                    values ('67000000-0000-0000-0000-0000000000ff', 'ping', 'ok') $$,
  '23514', null, 'an unknown kind is refused');
select throws_ok($$ update public.health_probes set state = 'down'
                     where tenant_id = '67000000-0000-0000-0000-0000000000ff' and kind = 'uptime' $$,
  '23514', null, 'an unknown state is refused');
select throws_ok($$ update public.health_probes set facts = '[1, 2]'
                     where tenant_id = '67000000-0000-0000-0000-0000000000ff' and kind = 'uptime' $$,
  '23514', null, 'facts that are not an object are refused');
select throws_ok($$ update public.health_probes set facts = jsonb_build_object('x', repeat('a', 16400))
                     where tenant_id = '67000000-0000-0000-0000-0000000000ff' and kind = 'uptime' $$,
  '23514', null, 'facts over 16 KB are refused');
select throws_ok($$ update public.health_probes set failures = -1
                     where tenant_id = '67000000-0000-0000-0000-0000000000ff' and kind = 'uptime' $$,
  '23514', null, 'a negative failure count is refused');
select throws_ok($$ insert into public.health_probes (tenant_id, kind, state)
                    values ('67000000-0000-0000-0000-0000000000ff', 'uptime', 'ok') $$,
  '23505', null, 'one row per tenant and probe');
reset role;

-- ── 3. reads (RLS, the grant layer) ──────────────────────────────────────────
set local role anon;
select _as(null, null);
select throws_ok($$ select count(*) from public.health_probes $$,
  '42501', null, 'anon cannot read health_probes (no privilege)');
select throws_ok($$ insert into public.health_probes (tenant_id, kind, state)
                    values ('67000000-0000-0000-0000-000000000001', 'uptime', 'ok') $$,
  '42501', null, 'nor write it');

set local role authenticated;
select _as('admin', '67000000-0000-0000-0000-000000000001');
select is(_seen('67000000-0000-0000-0000-000000000001'), 3, 'admin reads its tenant''s three rows');
select is(_seen('67000000-0000-0000-0000-0000000000ff'), 0, 'and none of another tenant''s');
select _as('developer', '67000000-0000-0000-0000-000000000001');
select is(_seen('67000000-0000-0000-0000-000000000001'), 3, 'developer reads its tenant''s three rows');
select is(_seen('67000000-0000-0000-0000-0000000000ff'), 0, 'and none of another tenant''s');
select _as('content_creator', '67000000-0000-0000-0000-000000000001');
select is(_seen('67000000-0000-0000-0000-000000000001'), 0, 'content_creator reads no rows');
select _as('seo', '67000000-0000-0000-0000-000000000001');
select is(_seen('67000000-0000-0000-0000-000000000001'), 0, 'seo reads no rows');
select _as('admin', '67000000-0000-0000-0000-0000000000ff');
select is(_seen('67000000-0000-0000-0000-0000000000ff'), 3, 'another tenant''s admin reads its own three rows');
select is(_seen('67000000-0000-0000-0000-000000000001'), 0, 'and none of this tenant''s');

-- Writes: no staff role holds a write privilege, whatever its role.
select _as('admin', '67000000-0000-0000-0000-000000000001');
select throws_ok($$ insert into public.health_probes (tenant_id, kind, state)
                    values ('67000000-0000-0000-0000-000000000001', 'uptime', 'ok') $$,
  '42501', 'permission denied for table health_probes', 'admin inserts no reading');
select throws_ok($$ update public.health_probes set state = 'ok'
                     where tenant_id = '67000000-0000-0000-0000-000000000001' $$,
  '42501', 'permission denied for table health_probes', 'nor updates one');
select throws_ok($$ delete from public.health_probes
                     where tenant_id = '67000000-0000-0000-0000-000000000001' $$,
  '42501', 'permission denied for table health_probes', 'nor deletes one');
select _as('developer', '67000000-0000-0000-0000-000000000001');
select throws_ok($$ update public.health_probes set state = 'ok'
                     where tenant_id = '67000000-0000-0000-0000-000000000001' $$,
  '42501', 'permission denied for table health_probes', 'developer updates no reading');
select _as('content_creator', '67000000-0000-0000-0000-000000000001');
select throws_ok($$ insert into public.health_probes (tenant_id, kind, state)
                    values ('67000000-0000-0000-0000-000000000001', 'domain', 'ok') $$,
  '42501', 'permission denied for table health_probes', 'content_creator inserts no reading');
select _as('seo', '67000000-0000-0000-0000-000000000001');
select throws_ok($$ delete from public.health_probes
                     where tenant_id = '67000000-0000-0000-0000-000000000001' $$,
  '42501', 'permission denied for table health_probes', 'seo deletes no reading');
select _as('admin', '67000000-0000-0000-0000-0000000000ff');
select throws_ok($$ update public.health_probes set state = 'ok'
                     where tenant_id = '67000000-0000-0000-0000-000000000001' $$,
  '42501', 'permission denied for table health_probes', 'another tenant''s admin writes nothing here');

-- The stale-token gap, documented (D4): the policy reads the token's role, as
-- rollup_daily_vitals' does (0052), so an Admin demoted to SEO a minute ago still reads the
-- readings until the token expires (at most its own lifetime: a role change revokes the
-- person's sessions since U12a). Public facts about the site, nothing personal. If D4 flips
-- to a RESTRICTIVE live check, this becomes "reads 0" for demoted, deactivated and locked.
reset role;
insert into auth.users (id, email) values ('67000000-0000-0000-0000-0000000000a1', 'g2@example.test');
insert into public.profiles (id, tenant_id, role, is_active)
  values ('67000000-0000-0000-0000-0000000000a1', '67000000-0000-0000-0000-000000000001', 'seo', true);
set local role authenticated;
select _as('admin', '67000000-0000-0000-0000-000000000001');
select is(_seen('67000000-0000-0000-0000-000000000001'), 3,
  'a demoted Admin whose token still says admin reads the readings until it expires (D4)');
reset role;

-- ── 4. the cascade (undone inside the function) ─────────────────────────────
-- Deletes the second tenant, counts its readings left, then raises so the block's
-- subtransaction undoes the delete; the count survives in the variable.
create function _cascade() returns int language plpgsql as $$
declare
  n int;
begin
  begin
    delete from public.tenants where id = '67000000-0000-0000-0000-0000000000ff';
    select count(*)::int into n from public.health_probes
     where tenant_id = '67000000-0000-0000-0000-0000000000ff';
    raise exception 'undo the delete';
  exception when raise_exception then
    return n;
  end;
end $$;
select is(_cascade(), 0, 'a tenant''s readings go with it');
select is((select count(*)::int from public.health_probes
            where tenant_id = '67000000-0000-0000-0000-0000000000ff'), 3,
  '(and the delete was undone)');

-- ── 5. grants and catalog (as the migration's postconditions, proven on this stack) ──
select is(
  (select coalesce(string_agg(format('%s %s', w.who, p.priv), ', ' order by w.who, p.priv), '')
     from (values ('public', array[]::text[]), ('anon', array[]::text[]),
                  ('authenticated', array['select']),
                  ('service_role', array['select', 'insert', 'update'])) as w(who, allowed)
     cross join (values ('select'), ('insert'), ('update'), ('delete'), ('truncate'),
                        ('references'), ('trigger')) as p(priv)
    where has_table_privilege(w.who, 'public.health_probes', p.priv)
          is distinct from (p.priv = any (w.allowed))),
  '', 'health_probes: staff SELECT, the service role SELECT INSERT UPDATE, PUBLIC and anon nothing');
select is(
  (select coalesce(string_agg(w.who, ', ' order by w.who), '')
     from (values ('public'), ('anon'), ('authenticated'), ('service_role')) as w(who)
    where current_setting('server_version_num')::int >= 170000
      and has_table_privilege(w.who, 'public.health_probes', 'maintain')),
  '', 'and nobody MAINTAINs it (PostgreSQL 17 and later)');
select is(
  (select coalesce(string_agg(format('%s %s', w.who, p.priv), ', ' order by w.who, p.priv), '')
     from (values ('public'), ('anon'), ('authenticated')) as w(who)
     cross join (values ('select'), ('insert'), ('update'), ('references')) as p(priv)
    where has_any_column_privilege(w.who, 'public.health_probes', p.priv)
          and not (w.who = 'authenticated' and p.priv = 'select')),
  '', 'and no column grant widens it');
select is(
  (select coalesce(string_agg(format('%s %s %s %s', policyname, cmd, permissive, roles), '; '
                              order by policyname), '')
     from pg_policies where schemaname = 'public' and tablename = 'health_probes'),
  'health_probes_read SELECT PERMISSIVE {authenticated}', 'one read policy, for staff');
select ok((select relrowsecurity and relforcerowsecurity from pg_class
            where oid = 'public.health_probes'::regclass),
  'row level security is enabled and forced');
select is(
  (select coalesce(string_agg(w.who, ', ' order by w.who), '')
     from (values ('public'), ('anon'), ('authenticated'), ('service_role')) as w(who)
    where has_function_privilege(w.who, 'app.tg_health_probe_stamps()', 'execute')
       or has_function_privilege(w.who, 'app.help_article_set()', 'execute')),
  '', 'no API role executes the stamps function or reads the help set');

-- ── 6. the guides ────────────────────────────────────────────────────────────
select is((select count(*)::int from jsonb_array_elements(app.help_article_set())), 15,
  'the set holds 0061''s fifteen guides');
select is(
  (select count(*)::int from public.tenants t
    where t.id in ('67000000-0000-0000-0000-000000000001', '67000000-0000-0000-0000-0000000000ff')
      and exists (select 1 from public.help_articles h
                   where h.tenant_id = t.id and h.slug = 'site-health-and-logs'
                     and h.body -> 'en' -> 1 -> 'x' ->> 2 like 'The Uptime card%')),
  2, 'every tenant holds the rewritten site health guide');

select * from finish();
rollback;
