-- pgTAP: the cache purge ledger and its budget, the minute cron's claim, and the batched read
-- of a publish's check (migration *_release_purge_cron.sql, Admin v2 R7).
--
--   cache_purge_take   the service role only; 1 to 30 tags and a known source; a ledger row per
--                      request; 30,000 tags in 24 hours at most, the over-budget request
--                      refused and not written; rows past 48 hours dropped, rows past 24 not
--                      counted.
--   claim_release_purges  the service role only; the due releases of ONE tenant (the one
--                      waiting longest), oldest first: a failed purge whose next try has come
--                      and fewer than 10 attempts, a release whose after-effects never ran (still
--                      pending, no attempt, two minutes after it went live); never a baseline, a
--                      done purge, an exhausted one, one not yet due, or a release not live; each
--                      leased five minutes, so the next claim takes another tenant's, then none.
--   release_read_rows  CMS staff of their own tenant only: an Admin, a Content Creator, an SEO
--                      and a Developer of tenant A read A's rows alike; a token of tenant B
--                      reads none of A's rows through its own tenant and is refused A's (a
--                      Sales token, no role, anon and the service role are refused too);
--                      registry tables and media_assets
--                      only, columns the table has, keyed by id (tenant_id only for a
--                      singleton the registry keys by its tenant, never services or
--                      media_assets), the ids uuids, 2,000 at most over all the reads; the
--                      caller's rows only, projected, in order; SECURITY INVOKER.
--
-- No row exists in production until releases are switched on (R14) and a zone is set up (O-3).
-- Run with `supabase test db`. CLAUDE.md §2 (the Cache-Tag limits), §3 (Pillars 1 and 4), §9.

begin;
select plan(48);

-- ── Fixtures (as the migration role: RLS bypassed, no claims) ─────────────────────────
insert into public.tenants (id, name) values
  ('71030000-0000-0000-0000-00000000000a', 'PurgeA'),
  ('71030000-0000-0000-0000-00000000000b', 'PurgeB');

-- A: r1 failed and due (the oldest), r2 an orphan (pending, no attempt, live 5 minutes),
-- r3 pending but live only 30 seconds, r4 exhausted, r5 failed and not due yet, r6 a baseline,
-- r7 done, r8 a release that failed (never live). B: r9 failed and due, newer than r1.
insert into public.content_releases (id, tenant_id, number, kind, status, published_at,
                                     purge_status, purge_attempts, purge_next_at, tags) values
  ('71030000-0000-0000-000d-000000000001', '71030000-0000-0000-0000-00000000000a', 1, 'publish',
   'published', now() - interval '1 hour', 'failed', 2, now() - interval '10 minutes',
   '{service:logo,services:all}'),
  ('71030000-0000-0000-000d-000000000002', '71030000-0000-0000-0000-00000000000a', 2, 'publish',
   'published', now() - interval '5 minutes', 'pending', 0, null, '{}'),
  ('71030000-0000-0000-000d-000000000003', '71030000-0000-0000-0000-00000000000a', 3, 'publish',
   'published', now() - interval '30 seconds', 'pending', 0, null, '{}'),
  ('71030000-0000-0000-000d-000000000004', '71030000-0000-0000-0000-00000000000a', 4, 'publish',
   'published', now() - interval '2 hours', 'failed', 10, now() - interval '1 hour', '{service:x}'),
  ('71030000-0000-0000-000d-000000000005', '71030000-0000-0000-0000-00000000000a', 5, 'publish',
   'published', now() - interval '2 hours', 'failed', 3, now() + interval '10 minutes', '{service:y}'),
  ('71030000-0000-0000-000d-000000000006', '71030000-0000-0000-0000-00000000000a', 6, 'baseline',
   'published', now() - interval '1 day', 'pending', 0, null, '{}'),
  ('71030000-0000-0000-000d-000000000007', '71030000-0000-0000-0000-00000000000a', 7, 'publish',
   'published', now() - interval '1 day', 'done', 1, null, '{}'),
  ('71030000-0000-0000-000d-000000000008', '71030000-0000-0000-0000-00000000000a', null, 'publish',
   'failed', null, 'pending', 0, null, '{}'),
  ('71030000-0000-0000-000d-000000000009', '71030000-0000-0000-0000-00000000000b', 1, 'publish',
   'published', now() - interval '1 hour', 'failed', 1, now() - interval '1 minute', '{page:about}');

-- Rows for the batched read: two services in A, one in B; each site's identity (a singleton).
insert into public.site_profile (tenant_id, brand_name, contact_email, location) values
  ('71030000-0000-0000-0000-00000000000a', '{"en":"Purge A","ar":"أ"}', 'a@example.com',
   '{"en":"Riyadh","ar":"الرياض"}'),
  ('71030000-0000-0000-0000-00000000000b', '{"en":"Purge B","ar":"ب"}', 'b@example.com',
   '{"en":"Jeddah","ar":"جدة"}');
insert into public.services (id, tenant_id, slug, title, status) values
  ('71030000-0000-0000-0001-000000000001', '71030000-0000-0000-0000-00000000000a', 'r7-logo',
   '{"en":"Logo","ar":"شعار"}', 'published'),
  ('71030000-0000-0000-0001-000000000002', '71030000-0000-0000-0000-00000000000a', 'r7-motion',
   '{"en":"Motion","ar":"حركة"}', 'draft'),
  ('71030000-0000-0000-0001-000000000009', '71030000-0000-0000-0000-00000000000b', 'r7-theirs',
   '{"en":"Theirs","ar":"لهم"}', 'published');

create function _as(p_role text, p_tid text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    case when p_role is null then ''
         else jsonb_build_object(
                'sub', '71030000-0000-0000-0000-0000000000a1',
                'role', 'authenticated',
                'app_metadata', jsonb_build_object('role', p_role, 'tenant_id', p_tid))::text end,
    true)
$$;
-- The ids of a claim's answer, by their last character, in order.
create function _ids(p jsonb) returns text language sql immutable as $$
  select coalesce(string_agg(right(e ->> 'release_id', 1), ',' order by o), '')
    from jsonb_array_elements(p) with ordinality as x(e, o)
$$;
create temp table _claims (n int, answer jsonb);
grant execute on function _as(text, text), _ids(jsonb) to anon, authenticated, service_role;
grant insert, select on _claims to service_role;
-- One read of tenant A's services, as whoever calls it (section 4's per-role rows).
create temp table _reads (who text, answer jsonb);
create function _read_a() returns jsonb language sql as $$
  select public.release_read_rows('71030000-0000-0000-0000-00000000000a', jsonb_build_array(
    jsonb_build_object('table', 'services', 'columns', jsonb_build_array('id', 'slug'), 'key', 'id',
      'ids', jsonb_build_array('71030000-0000-0000-0001-000000000002',
                               '71030000-0000-0000-0001-000000000001',
                               '71030000-0000-0000-0001-000000000009'))))
$$;
grant insert, select on _reads to authenticated;
grant execute on function _read_a() to authenticated;

-- ── 1. The catalog ───────────────────────────────────────────────────────────────────
select ok(
  (select relrowsecurity and relforcerowsecurity from pg_class
    where oid = 'public.cache_purge_log'::regclass)
  and not exists (select 1 from pg_policies where tablename = 'cache_purge_log'),
  'the ledger is ENABLE + FORCE row level security, with no policy at all');
select ok(
  not has_table_privilege('anon', 'public.cache_purge_log', 'select, insert, update, delete')
  and not has_table_privilege('authenticated', 'public.cache_purge_log', 'select, insert, update, delete')
  and has_table_privilege('service_role', 'public.cache_purge_log', 'select, insert, delete')
  and not has_table_privilege('service_role', 'public.cache_purge_log', 'update, truncate, references, trigger'),
  'only the service role holds the ledger: SELECT, INSERT and DELETE, nothing else');
select ok(
  has_function_privilege('service_role', 'public.cache_purge_take(uuid, int, text)', 'execute')
  and not has_function_privilege('authenticated', 'public.cache_purge_take(uuid, int, text)', 'execute')
  and not has_function_privilege('anon', 'public.cache_purge_take(uuid, int, text)', 'execute')
  and has_function_privilege('service_role', 'public.claim_release_purges(int)', 'execute')
  and not has_function_privilege('authenticated', 'public.claim_release_purges(int)', 'execute')
  and not has_function_privilege('anon', 'public.claim_release_purges(int)', 'execute')
  and has_function_privilege('authenticated', 'public.release_read_rows(uuid, jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.release_read_rows(uuid, jsonb)', 'execute')
  and not has_function_privilege('service_role', 'public.release_read_rows(uuid, jsonb)', 'execute'),
  'the budget and the claim are the service role''s; the read is authenticated''s alone');
select ok(
  (select bool_and(not prosecdef and proconfig @> array['search_path=""'])
     from pg_proc
    where oid in ('public.cache_purge_take(uuid, int, text)'::regprocedure,
                  'public.claim_release_purges(int)'::regprocedure,
                  'public.release_read_rows(uuid, jsonb)'::regprocedure)),
  'all three are SECURITY INVOKER with an empty search_path');

-- ── 2. The budget ────────────────────────────────────────────────────────────────────
set local role authenticated;
select _as('admin', '71030000-0000-0000-0000-00000000000a');
select throws_ok($$ select public.cache_purge_take('71030000-0000-0000-0000-00000000000a', 1, 'release') $$,
  '42501', null, 'staff cannot take from the budget');
select throws_ok($$ select public.claim_release_purges(5) $$,
  '42501', null, 'nor claim a release''s purge');
reset role;
select _as(null, null);

set local role service_role;
select is(public.cache_purge_take('71030000-0000-0000-0000-00000000000a', 3, 'release'), true,
  'the service role takes 3 tags');
select is((select count(*)::int from public.cache_purge_log
            where tenant_id = '71030000-0000-0000-0000-00000000000a' and tag_count = 3
              and source = 'release'), 1,
  'and the request is one ledger row: its tenant, its count, its source');
select throws_ok($$ select public.cache_purge_take('71030000-0000-0000-0000-00000000000a', 31, 'release') $$,
  '22023', null, 'more than 30 tags in one request is refused');
select throws_ok($$ select public.cache_purge_take('71030000-0000-0000-0000-00000000000a', 0, 'release') $$,
  '22023', null, 'no tag at all is refused');
select throws_ok($$ select public.cache_purge_take('71030000-0000-0000-0000-00000000000a', 1, 'someone') $$,
  '22023', null, 'an unknown source is refused');
select throws_ok($$ select public.cache_purge_take(null, 1, 'media') $$,
  '22023', null, 'a request with no tenant is refused');
reset role;

-- The day so far: 29,990 tags 23 hours ago (counted), 30 tags 30 hours ago (kept, not
-- counted) and 30 tags 50 hours ago (dropped by the next take).
insert into public.cache_purge_log (tenant_id, created_at, tag_count, source)
select '71030000-0000-0000-0000-00000000000b', now() - interval '23 hours', 30, 'cron'
  from generate_series(1, 999);
insert into public.cache_purge_log (tenant_id, created_at, tag_count, source) values
  ('71030000-0000-0000-0000-00000000000b', now() - interval '23 hours', 20, 'media'),
  ('71030000-0000-0000-0000-00000000000b', now() - interval '30 hours', 30, 'cron'),
  ('71030000-0000-0000-0000-00000000000b', now() - interval '50 hours', 30, 'cron');
-- 3 (above) + 999 × 30 + 20 = 29,993 counted.
set local role service_role;
select is(public.cache_purge_take('71030000-0000-0000-0000-00000000000a', 7, 'visibility'), true,
  'the budget takes up to 30,000 in 24 hours, whichever tenant spent it (one zone)');
select is(public.cache_purge_take('71030000-0000-0000-0000-00000000000a', 1, 'media'), false,
  'one tag past 30,000 is refused');
reset role;
select is((select count(*)::int from public.cache_purge_log where source = 'media'
             and tenant_id = '71030000-0000-0000-0000-00000000000a'), 0,
  'and the refused request wrote nothing');
select is((select count(*)::int from public.cache_purge_log
            where created_at < now() - interval '48 hours'), 0,
  'rows past 48 hours are dropped');
select is((select count(*)::int from public.cache_purge_log
            where created_at < now() - interval '24 hours'), 1,
  'rows between 24 and 48 hours are kept, and were not counted');

-- ── 3. The claim ─────────────────────────────────────────────────────────────────────
set local role service_role;
insert into _claims select 1, public.claim_release_purges(5);
reset role;
select is(_ids((select answer from _claims where n = 1)), '1,2',
  'the first claim: tenant A (waiting longest), the failed purge due and the orphan, oldest first');
select is((select string_agg(e ->> 'orphan', ',' order by o)
             from _claims, jsonb_array_elements(answer) with ordinality as x(e, o) where n = 1),
  'false,true', 'the release whose after-effects never ran is marked an orphan');
select is((select string_agg(e ->> 'tenant_id', ',' order by o)
             from _claims, jsonb_array_elements(answer) with ordinality as x(e, o) where n = 1),
  '71030000-0000-0000-0000-00000000000a,71030000-0000-0000-0000-00000000000a',
  'both of one tenant');
select is((select (answer -> 0) - 'release_id' - 'tenant_id' from _claims where n = 1),
  '{"tags": ["service:logo", "services:all"], "number": 1, "status": "failed", "attempts": 2, "orphan": false}'::jsonb,
  'an answer carries the number, the tags it owes, its status and its attempts');
select ok(
  (select bool_and(purge_next_at between now() + interval '4 minutes' and now() + interval '6 minutes')
     from public.content_releases
    where id in ('71030000-0000-0000-000d-000000000001', '71030000-0000-0000-000d-000000000002')),
  'each claimed release is leased five minutes ahead');
select is(
  (select string_agg(right(id::text, 1) || ':' || purge_status || ':' || purge_attempts, ','
                      order by id)
     from public.content_releases
    where id in ('71030000-0000-0000-000d-000000000001', '71030000-0000-0000-000d-000000000002')),
  '1:failed:2,2:pending:0',
  'the claim changes no status and counts no attempt (record_release_purge does)');

set local role service_role;
insert into _claims select 2, public.claim_release_purges(5);
insert into _claims select 3, public.claim_release_purges(5);
reset role;
select is(_ids((select answer from _claims where n = 2)), '9',
  'the next claim: A''s are leased, so tenant B''s');
select is((select answer from _claims where n = 3), '[]'::jsonb,
  'then none: never the recent, the exhausted, the not-yet-due, the baseline, the done or the unpublished');

set local role service_role;
select throws_ok($$ select public.claim_release_purges(0) $$, '22023', null,
  'a claim of nothing is refused');
select throws_ok($$ select public.claim_release_purges(21) $$, '22023', null,
  'a claim of more than 20 is refused');
reset role;

-- ── 4. The batched read ──────────────────────────────────────────────────────────────
set local role authenticated;
select _as('content_creator', '71030000-0000-0000-0000-00000000000a');
select is(
  public.release_read_rows('71030000-0000-0000-0000-00000000000a', jsonb_build_array(
    jsonb_build_object('table', 'services', 'columns', jsonb_build_array('id', 'slug'), 'key', 'id',
      'ids', jsonb_build_array('71030000-0000-0000-0001-000000000002',
                               '71030000-0000-0000-0001-000000000001',
                               '71030000-0000-0000-0001-000000000009')),
    jsonb_build_object('table', 'services', 'columns', jsonb_build_array('status'), 'key', 'id',
      'ids', jsonb_build_array('71030000-0000-0000-0001-000000000002')))),
  jsonb_build_array(
    jsonb_build_array(
      jsonb_build_object('id', '71030000-0000-0000-0001-000000000001', 'slug', 'r7-logo'),
      jsonb_build_object('id', '71030000-0000-0000-0001-000000000002', 'slug', 'r7-motion')),
    jsonb_build_array(jsonb_build_object('status', 'draft'))),
  'a Content Creator reads her own site''s rows, projected, one array per read, in order; another site''s id reads nothing');

-- Every CMS role reads its own site alike (app.is_staff() admits the four): the same read as
-- an Admin, an SEO and a Developer of tenant A answers the Content Creator's rows.
select _as('admin', '71030000-0000-0000-0000-00000000000a');
insert into _reads select 'admin', _read_a();
select _as('seo', '71030000-0000-0000-0000-00000000000a');
insert into _reads select 'seo', _read_a();
select _as('developer', '71030000-0000-0000-0000-00000000000a');
insert into _reads select 'developer', _read_a();
select is((select answer from _reads where who = 'admin'), jsonb_build_array(jsonb_build_array(
    jsonb_build_object('id', '71030000-0000-0000-0001-000000000001', 'slug', 'r7-logo'),
    jsonb_build_object('id', '71030000-0000-0000-0001-000000000002', 'slug', 'r7-motion'))),
  'an Admin of the site reads its rows (the draft too), never another site''s');
select is((select answer from _reads where who = 'seo'),
  (select answer from _reads where who = 'admin'), 'an SEO of the site reads the same');
select is((select answer from _reads where who = 'developer'),
  (select answer from _reads where who = 'admin'), 'a Developer of the site reads the same');

-- other_tenant: a token of tenant B reads none of A's rows through its own tenant, and is
-- refused A's tenant (the tenant check), whatever its role.
select _as('admin', '71030000-0000-0000-0000-00000000000b');
select is(
  public.release_read_rows('71030000-0000-0000-0000-00000000000b', jsonb_build_array(
    jsonb_build_object('table', 'services', 'columns', jsonb_build_array('id', 'slug'), 'key', 'id',
      'ids', jsonb_build_array('71030000-0000-0000-0001-000000000001',
                               '71030000-0000-0000-0001-000000000002')))),
  '[[]]'::jsonb, 'an Admin of another site, through its own tenant, reads none of this site''s rows');
select throws_ok($$ select _read_a() $$, '42501', null,
  'and is refused this site''s tenant');
select _as('content_creator', '71030000-0000-0000-0000-00000000000a');
select is(
  (select jsonb_agg(r -> 'tenant_id') from jsonb_array_elements(
     public.release_read_rows('71030000-0000-0000-0000-00000000000a', jsonb_build_array(
       jsonb_build_object('table', 'site_profile', 'columns', jsonb_build_array('*'), 'key', 'tenant_id',
         'ids', jsonb_build_array('71030000-0000-0000-0000-00000000000a',
                                  '71030000-0000-0000-0000-00000000000b')))) -> 0) r),
  '["71030000-0000-0000-0000-00000000000a"]'::jsonb,
  '["*"] by tenant_id reads a singleton''s one row of the caller''s site; another site''s reads nothing');
select throws_ok($$ select public.release_read_rows('71030000-0000-0000-0000-00000000000a',
    '[{"table":"services","columns":["*"],"key":"tenant_id","ids":["71030000-0000-0000-0000-00000000000a"]}]') $$,
  '22023', null, 'tenant_id is no key for a table of many rows a site (services): it would be the whole table');
select throws_ok($$ select public.release_read_rows('71030000-0000-0000-0000-00000000000a',
    '[{"table":"media_assets","columns":["id"],"key":"tenant_id","ids":["71030000-0000-0000-0000-00000000000a"]}]') $$,
  '22023', null, 'nor for media_assets');
select throws_ok(
  format($$ select public.release_read_rows('71030000-0000-0000-0000-00000000000a', %L::jsonb) $$,
         (select jsonb_agg(jsonb_build_object('table', 'services', 'columns', jsonb_build_array('id'),
                  'key', 'id', 'ids', (select jsonb_agg('71030000-0000-0000-0001-000000000001'::text)
                                         from generate_series(1, 500))))
            from generate_series(1, 5))),
  '22023', null, 'more than 2,000 ids over the reads of one request is refused, repeats included');
select throws_ok($$ select public.release_read_rows('71030000-0000-0000-0000-00000000000b',
    '[{"table":"services","columns":["id"],"key":"id","ids":["71030000-0000-0000-0001-000000000009"]}]') $$,
  '42501', null, 'another site''s tenant is refused');
select throws_ok($$ select public.release_read_rows('71030000-0000-0000-0000-00000000000a',
    '[{"table":"leads","columns":["id"],"key":"id","ids":["71030000-0000-0000-0001-000000000001"]}]') $$,
  '22023', null, 'a table that is not the registry''s or media_assets is refused (leads)');
select throws_ok($$ select public.release_read_rows('71030000-0000-0000-0000-00000000000a',
    '[{"table":"services","columns":["id; drop table services"],"key":"id","ids":["71030000-0000-0000-0001-000000000001"]}]') $$,
  '22023', null, 'a column the table does not have (or a statement dressed as one) is refused');
select throws_ok($$ select public.release_read_rows('71030000-0000-0000-0000-00000000000a',
    '[{"table":"services","columns":["id"],"key":"slug","ids":["71030000-0000-0000-0001-000000000001"]}]') $$,
  '22023', null, 'a key other than id or tenant_id is refused');
select throws_ok($$ select public.release_read_rows('71030000-0000-0000-0000-00000000000a',
    '[{"table":"services","columns":["id"],"key":"id","ids":["1 or 1=1"]}]') $$,
  '22023', null, 'an id that is not a uuid is refused');
select throws_ok($$ select public.release_read_rows('71030000-0000-0000-0000-00000000000a',
    '[{"table":"services","columns":["id"],"key":"id","ids":["71030000-0000-0000-0001-000000000001"],"where":"true"}]') $$,
  '22023', null, 'a read with a key it does not know is refused');
select throws_ok(
  format($$ select public.release_read_rows('71030000-0000-0000-0000-00000000000a', %L::jsonb) $$,
         (select jsonb_agg(jsonb_build_object('table', 'services', 'columns', jsonb_build_array('id'),
                  'key', 'id', 'ids', jsonb_build_array('71030000-0000-0000-0001-000000000001')))
            from generate_series(1, 41))),
  '22023', null, 'more than 40 reads in one request is refused');

-- A Sales token is authenticated but not CMS staff: refused before anything is read.
select _as('sales', '71030000-0000-0000-0000-00000000000a');
select throws_ok($$ select public.release_read_rows('71030000-0000-0000-0000-00000000000a',
    '[{"table":"services","columns":["id"],"key":"id","ids":["71030000-0000-0000-0001-000000000001"]}]') $$,
  '42501', null, 'a Sales token is refused (CMS staff only)');
-- A token with no role claim: refused too.
select _as(null, null);
select throws_ok($$ select public.release_read_rows('71030000-0000-0000-0000-00000000000a',
    '[{"table":"services","columns":["id"],"key":"id","ids":["71030000-0000-0000-0001-000000000001"]}]') $$,
  '42501', null, 'a token with no role is refused');
reset role;

set local role anon;
select throws_ok($$ select public.release_read_rows('71030000-0000-0000-0000-00000000000a',
    '[{"table":"services","columns":["id"],"key":"id","ids":["71030000-0000-0000-0001-000000000001"]}]') $$,
  '42501', null, 'anon cannot call it');
reset role;

set local role service_role;
select throws_ok($$ select public.release_read_rows('71030000-0000-0000-0000-00000000000a',
    '[{"table":"services","columns":["id"],"key":"id","ids":["71030000-0000-0000-0001-000000000001"]}]') $$,
  '42501', null, 'nor the service role: it is the publisher''s own read, under RLS');
reset role;

select * from finish();
rollback;
