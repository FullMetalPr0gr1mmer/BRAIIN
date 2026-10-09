-- pgTAP: the release ledger (migration 0038, Admin v2 R1).
--
-- That staff write no draft yet (R3 grants the writes); who may stage a pending change
-- (content_drafts) once it does, per area and role, with the grant restored inside this
-- rolled-back transaction; that removals and archives are staged only by the roles allowed
-- to make them; the draft lock (a draft's id, version and author are the database's, so a
-- {draftId, draftVersion} a publisher saw never names other content); that a draft claimed
-- by a scheduled release is out of reach of every staff token (RLS and the lock, each on
-- its own); the shape and size caps of a draft; that the site versions (content_releases)
-- and their items are read-only to every API role but the service role, and append-only
-- even for it; the registry and the switch-on flag; and the custom_themes delete gate the
-- registry contract needed. Rows run over admin, content_creator, seo, developer, a `sales`
-- claim (the role arrives with C10; the policies read the role from the claim, so the
-- denial is provable now), anon and other_tenant (CLAUDE.md §9). No definer here relies on
-- app.live_role(), so no stale-token row.
--
-- Run with `supabase test db`. CLAUDE.md §3 (Pillar 1), §8, §9.

begin;
select plan(111);

-- ── Fixtures (as the migration role: RLS bypassed, no claims) ─────────────────────
insert into public.tenants (id, name) values
  ('38000000-0000-0000-0000-00000000000a', 'RelA'),
  ('38000000-0000-0000-0000-00000000000b', 'RelB');

-- Tenant A: the baseline v1 and a scheduled release; tenant B: its own v1.
insert into public.content_releases (id, tenant_id, number, kind, status, published_at) values
  ('38000000-0000-0000-0000-0000000001a1', '38000000-0000-0000-0000-00000000000a', 1,
   'baseline', 'published', now()),
  ('38000000-0000-0000-0000-0000000001b1', '38000000-0000-0000-0000-00000000000b', 1,
   'baseline', 'published', now());
insert into public.content_releases (id, tenant_id, kind, status, scheduled_for, scheduled_by, payload)
values ('38000000-0000-0000-0000-0000000001a2', '38000000-0000-0000-0000-00000000000a',
        'publish', 'scheduled', now() + interval '1 day',
        '38000000-0000-0000-0000-0000000000a1', '[]'::jsonb);

insert into public.content_release_items (tenant_id, release_id, entity_type, entity_id, op, before, after)
values
  ('38000000-0000-0000-0000-00000000000a', '38000000-0000-0000-0000-0000000001a1', 'service',
   gen_random_uuid(), 'update', '{"title":{"en":"Old"}}', '{"title":{"en":"New"}}'),
  ('38000000-0000-0000-0000-00000000000b', '38000000-0000-0000-0000-0000000001b1', 'service',
   gen_random_uuid(), 'update', '{"title":{"en":"Old"}}', '{"title":{"en":"New"}}');

-- Two drafts claimed by the scheduled release, an unclaimed one, and tenant B's. With no
-- role claim the draft lock keeps the ids these name.
insert into public.content_drafts (id, tenant_id, entity_type, entity_id, op, payload, release_id)
values
  ('38000000-0000-0000-0000-000000000d01', '38000000-0000-0000-0000-00000000000a', 'service',
   gen_random_uuid(), 'update', '{"title":{"en":"Claimed"}}', '38000000-0000-0000-0000-0000000001a2'),
  ('38000000-0000-0000-0000-000000000d05', '38000000-0000-0000-0000-00000000000a', 'service',
   gen_random_uuid(), 'update', '{"title":{"en":"Claimed too"}}', '38000000-0000-0000-0000-0000000001a2'),
  ('38000000-0000-0000-0000-000000000d02', '38000000-0000-0000-0000-00000000000a', 'service',
   gen_random_uuid(), 'update', '{"title":{"en":"Free"}}', null),
  ('38000000-0000-0000-0000-000000000d03', '38000000-0000-0000-0000-00000000000b', 'service',
   gen_random_uuid(), 'update', '{"title":{"en":"Theirs"}}', null);

insert into public.custom_themes (id, tenant_id, name) values
  ('38000000-0000-0000-0000-0000000000f7', '38000000-0000-0000-0000-00000000000a', 'pgTAP theme');

-- A staff member of tenant A (or anon when p_role is null).
create function _as(p_role text, p_sub text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    case when p_role is null then ''
         else json_build_object(
                'sub', p_sub,
                'app_metadata', json_build_object(
                  'role', p_role, 'tenant_id', '38000000-0000-0000-0000-00000000000a')
              )::text
    end,
    true)
$$;

-- An Admin of tenant B (the other_tenant row).
create function _as_other() returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    json_build_object(
      'sub', '38000000-0000-0000-0000-0000000000f1',
      'app_metadata', json_build_object(
        'role', 'admin', 'tenant_id', '38000000-0000-0000-0000-00000000000b')
    )::text,
    true)
$$;

-- Stage a change in tenant A.
create function _stage(p_type text, p_op text, p_payload jsonb) returns void language sql as $$
  insert into public.content_drafts (tenant_id, entity_type, entity_id, op, payload)
  values ('38000000-0000-0000-0000-00000000000a', p_type, gen_random_uuid(), p_op, p_payload)
$$;

-- Rows a statement actually affected: a USING filter refuses silently.
create function _touch_draft(p_id uuid) returns int language sql as $$
  with u as (update public.content_drafts set fields = '{title}' where id = p_id returning 1)
  select count(*)::int from u
$$;
create function _discard_draft(p_id uuid) returns int language sql as $$
  with d as (delete from public.content_drafts where id = p_id returning 1)
  select count(*)::int from d
$$;
create function _delete_theme() returns int language sql as $$
  with d as (delete from public.custom_themes
              where id = '38000000-0000-0000-0000-0000000000f7' returning 1)
  select count(*)::int from d
$$;

-- Tenant A's drafts as the database holds them (a definer, so RLS does not filter it).
create function _drafts_in_a() returns int language sql security definer as $$
  select count(*)::int from public.content_drafts
   where tenant_id = '38000000-0000-0000-0000-00000000000a'
$$;

-- A JSON string of p_chars characters that does not compress (pg_column_size caps).
create function _blob(p_chars int) returns text language sql as $$
  select left(string_agg(md5(g::text), ''), p_chars) from generate_series(1, p_chars / 32 + 1) g
$$;

-- ── 0. Staff write no draft until R3 grants it ──────────────────────────────────
-- 0038 grants authenticated SELECT only; the GRANT layer refuses every write, whatever
-- the role or the area.
set local role authenticated;
select _as('admin', '38000000-0000-0000-0000-0000000000a1');
select throws_ok($$ select _stage('service', 'update', '{"title":{"en":"A"}}') $$, '42501',
  'permission denied for table content_drafts',
  'without R3''s grant, admin CANNOT stage a change (no INSERT on content_drafts)');
select throws_ok(
  $$ update public.content_drafts set fields = '{title}'
      where id = '38000000-0000-0000-0000-000000000d02' $$,
  '42501', 'permission denied for table content_drafts',
  'without R3''s grant, admin CANNOT edit a draft (no UPDATE)');
select throws_ok(
  $$ delete from public.content_drafts where id = '38000000-0000-0000-0000-000000000d02' $$,
  '42501', 'permission denied for table content_drafts',
  'without R3''s grant, admin CANNOT discard a draft (no DELETE)');
select _as('content_creator', '38000000-0000-0000-0000-0000000000c1');
select throws_ok($$ select _stage('service', 'update', '{"title":{"en":"C"}}') $$, '42501',
  'permission denied for table content_drafts',
  'without R3''s grant, content creator CANNOT stage a change');
select _as('seo', '38000000-0000-0000-0000-0000000000e1');
select throws_ok($$ select _stage('entity_seo', 'update', '{"robots":"noindex"}') $$, '42501',
  'permission denied for table content_drafts',
  'without R3''s grant, seo CANNOT stage a change');
select _as('developer', '38000000-0000-0000-0000-0000000000d1');
select throws_ok($$ select _stage('site_profile', 'update', '{"brandName":{"en":"X"}}') $$, '42501',
  'permission denied for table content_drafts',
  'without R3''s grant, developer CANNOT stage a change');
select is((select count(*)::int from public.content_drafts), _drafts_in_a(),
  'staff still read their tenant''s drafts (SELECT is granted)');
reset role;

-- From here on, R3's grant, restored inside this rolled-back transaction: what follows is
-- RLS and the draft lock on their own.
grant insert, update, delete on public.content_drafts to authenticated;

-- ── 1. Who may stage a change, per area ──────────────────────────────────────────
set local role authenticated;
select _as('admin', '38000000-0000-0000-0000-0000000000a1');
select lives_ok($$ select _stage('service', 'update', '{"title":{"en":"A"}}') $$,
  'admin stages a service change');
select _as('content_creator', '38000000-0000-0000-0000-0000000000c1');
select lives_ok($$ select _stage('service', 'update', '{"title":{"en":"C"}}') $$,
  'content creator stages a service change');
select lives_ok($$ select _stage('nav_item', 'update', '{"label":{"en":"C"}}') $$,
  'content creator stages a navigation change');
select throws_ok($$ select _stage('redirect', 'update', '{"targetPath":"/x"}') $$, '42501', null,
  'content creator CANNOT stage a redirect (redirects.manage)');
select throws_ok($$ select _stage('entity_seo', 'update', '{"robots":"noindex"}') $$, '42501', null,
  'content creator CANNOT stage SEO meta (view only)');
select throws_ok($$ select _stage('site_profile', 'update', '{"brandName":{"en":"X"}}') $$, '42501', null,
  'content creator CANNOT stage the public identity');
select _as('seo', '38000000-0000-0000-0000-0000000000e1');
select throws_ok($$ select _stage('service', 'update', '{"title":{"en":"S"}}') $$, '42501', null,
  'seo CANNOT stage a service change');
select lives_ok($$ select _stage('entity_seo', 'update', '{"robots":"noindex"}') $$,
  'seo stages SEO meta');
select lives_ok($$ select _stage('redirect', 'update', '{"targetPath":"/x"}') $$,
  'seo stages a redirect');
select throws_ok($$ select _stage('site_profile', 'update', '{"brandName":{"en":"X"}}') $$, '42501', null,
  'seo CANNOT stage the public identity');
select _as('developer', '38000000-0000-0000-0000-0000000000d1');
select throws_ok($$ select _stage('service', 'update', '{"title":{"en":"D"}}') $$, '42501', null,
  'developer CANNOT stage a service change');
select lives_ok($$ select _stage('site_profile', 'update', '{"brandName":{"en":"X"}}') $$,
  'developer stages the public identity');
select lives_ok($$ select _stage('custom_theme', 'update', '{"name":"Dark"}') $$,
  'developer stages a theme change');
select _as('sales', '38000000-0000-0000-0000-0000000000b5');
select throws_ok($$ select _stage('service', 'update', '{"title":{"en":"B"}}') $$, '42501', null,
  'a sales claim CANNOT stage anything (not in any author list)');

-- ── 2. Removals and archives ────────────────────────────────────────────────────
select _as('content_creator', '38000000-0000-0000-0000-0000000000c1');
select throws_ok($$ select _stage('service', 'delete', '{}') $$, '42501', null,
  'content creator CANNOT stage a removal (content.archiveDelete)');
select throws_ok($$ select _stage('service', 'update', '{"status":"archived"}') $$, '42501', null,
  'content creator CANNOT stage an archive');
select throws_ok(
  $$ update public.content_drafts set payload = '{"status":"archived"}'
      where id = '38000000-0000-0000-0000-000000000d02' $$,
  '42501', 'new row violates row-level security policy for table "content_drafts"',
  'content creator CANNOT turn a pending change into an archive (update WITH CHECK)');
select _as('admin', '38000000-0000-0000-0000-0000000000a1');
select lives_ok($$ select _stage('service', 'delete', '{}') $$, 'admin stages a removal');
select lives_ok($$ select _stage('service', 'update', '{"status":"archived"}') $$,
  'admin stages an archive');
select _as('seo', '38000000-0000-0000-0000-0000000000e1');
select lives_ok($$ select _stage('redirect', 'delete', '{}') $$,
  'seo stages a redirect removal (redirects.manage)');
select _as('developer', '38000000-0000-0000-0000-0000000000d1');
select throws_ok($$ select _stage('custom_theme', 'delete', '{}') $$, '42501', null,
  'developer CANNOT stage a theme removal (content.archiveDelete)');

-- ── 3. The draft lock: the id, the version and the author are the database's ───────
-- A staff insert gets a fresh id, version 1 and its real author and time, whatever it
-- sends; an update always lands on old + 1, keeps the id and the author, and names the
-- editor. So a {draftId, draftVersion} a publisher saw (R6) never names other content.
select _as('content_creator', '38000000-0000-0000-0000-0000000000c1');
insert into public.content_drafts
  (id, tenant_id, entity_type, entity_id, op, payload, version, created_by, created_at)
values ('38000000-0000-0000-0000-000000000d04', '38000000-0000-0000-0000-00000000000a', 'page',
        '38000000-0000-0000-0000-000000000e04', 'update', '{"title":{"en":"Mine"}}', 7,
        '38000000-0000-0000-0000-0000000000f1', '2000-01-01');
select set_config('pgtap.draft',
  (select id::text from public.content_drafts
    where entity_id = '38000000-0000-0000-0000-000000000e04'),
  true);
select isnt(current_setting('pgtap.draft'), '38000000-0000-0000-0000-000000000d04',
  'a staff insert CANNOT choose the draft id (a discarded draft''s id never comes back)');
select is(
  (select version || ' ' || created_by::text || ' ' || (created_at = now())::text
     from public.content_drafts where entity_id = '38000000-0000-0000-0000-000000000e04'),
  '1 38000000-0000-0000-0000-0000000000c1 true',
  'a staff insert starts at version 1 under its real author and time, whatever it sent');
update public.content_drafts set payload = '{"title":{"en":"Mine, again"}}'
 where entity_id = '38000000-0000-0000-0000-000000000e04';
select is(
  (select version from public.content_drafts
    where entity_id = '38000000-0000-0000-0000-000000000e04'),
  2, 'a saved draft bumps its own version (the draftVersion lock)');
select _as('admin', '38000000-0000-0000-0000-0000000000a1');
update public.content_drafts
   set payload = '{"title":{"en":"Mine, edited"}}', version = 1,
       id = '38000000-0000-0000-0000-000000000d06',
       created_by = '38000000-0000-0000-0000-0000000000a1'
 where entity_id = '38000000-0000-0000-0000-000000000e04';
select is(
  (select version from public.content_drafts
    where entity_id = '38000000-0000-0000-0000-000000000e04'),
  3, 'an update that sends an older version still lands on old + 1 (no ABA on the publish check)');
select is(
  (select id::text || ' ' || created_by::text || ' ' || updated_by::text
     from public.content_drafts where entity_id = '38000000-0000-0000-0000-000000000e04'),
  current_setting('pgtap.draft')
    || ' 38000000-0000-0000-0000-0000000000c1 38000000-0000-0000-0000-0000000000a1',
  'an update keeps the id and the author, whatever it sent, and names the editor who saved it');
select _as('content_creator', '38000000-0000-0000-0000-0000000000c1');
select throws_ok(
  $$ update public.content_drafts set op = 'delete', payload = '{}'
      where entity_id = '38000000-0000-0000-0000-000000000e04' $$,
  '42501', null, 'content creator CANNOT turn a draft into a removal');
select is(_discard_draft(current_setting('pgtap.draft')::uuid), 1,
  'content creator discards a draft of an area it authors');

-- ── 4. Who reads drafts ──────────────────────────────────────────────────────────
select _as('seo', '38000000-0000-0000-0000-0000000000e1');
select is((select count(*)::int from public.content_drafts), _drafts_in_a(),
  'seo reads every draft of its tenant (and no other tenant''s)');
select _as('developer', '38000000-0000-0000-0000-0000000000d1');
select is((select count(*)::int from public.content_drafts), _drafts_in_a(),
  'developer reads every draft of its tenant');
select _as('sales', '38000000-0000-0000-0000-0000000000b5');
select is((select count(*)::int from public.content_drafts), 0,
  'a sales claim reads no draft (not CMS staff)');
select _as_other();
select is((select count(*)::int from public.content_drafts), 1,
  'an admin of another tenant reads only its own tenant''s draft');

-- ── 5. A claimed draft is out of reach of staff ──────────────────────────────────
select _as('admin', '38000000-0000-0000-0000-0000000000a1');
select is(_touch_draft('38000000-0000-0000-0000-000000000d01'), 0,
  'admin CANNOT edit a draft claimed by a scheduled release');
select is(_discard_draft('38000000-0000-0000-0000-000000000d01'), 0,
  'admin CANNOT discard a claimed draft');
select throws_ok(
  $$ update public.content_drafts set release_id = '38000000-0000-0000-0000-0000000001a2'
      where id = '38000000-0000-0000-0000-000000000d02' $$,
  '42501', null, 'admin CANNOT claim a draft for a release');
select is(_touch_draft('38000000-0000-0000-0000-000000000d02'), 1,
  'an unclaimed draft stays editable');

-- The policies' `release_id is null` on its own: with the draft lock switched off inside
-- this transaction, RLS alone still refuses a staff claim.
reset role;
alter table public.content_drafts disable trigger content_drafts_lock;
set local role authenticated;
select _as('admin', '38000000-0000-0000-0000-0000000000a1');
select throws_ok(
  $$ insert into public.content_drafts (tenant_id, entity_type, entity_id, op, release_id)
     values ('38000000-0000-0000-0000-00000000000a', 'service', gen_random_uuid(), 'update',
             '38000000-0000-0000-0000-0000000001a2') $$,
  '42501', 'new row violates row-level security policy for table "content_drafts"',
  'with the lock off, RLS alone refuses a draft staged already claimed (insert WITH CHECK)');
select throws_ok(
  $$ update public.content_drafts set release_id = '38000000-0000-0000-0000-0000000001a2'
      where id = '38000000-0000-0000-0000-000000000d02' $$,
  '42501', 'new row violates row-level security policy for table "content_drafts"',
  'with the lock off, RLS alone refuses a staff claim (update WITH CHECK)');
reset role;
alter table public.content_drafts enable trigger content_drafts_lock;

-- The lock on its own (RLS bypassed as the migration role): a staff claim is refused
-- whoever runs the statement; no claim (the runbook) and the service role are allowed.
select _as('admin', '38000000-0000-0000-0000-0000000000a1');
select throws_ok(
  $$ update public.content_drafts set release_id = '38000000-0000-0000-0000-0000000001a2'
      where id = '38000000-0000-0000-0000-000000000d02' $$,
  '42501', 'a pending change is claimed and released only by a scheduled release',
  'the lock refuses a staff claim even past RLS (a definer reached by staff)');
select throws_ok(
  $$ insert into public.content_drafts (tenant_id, entity_type, entity_id, op, release_id)
     values ('38000000-0000-0000-0000-00000000000a', 'service', gen_random_uuid(), 'update',
             '38000000-0000-0000-0000-0000000001a2') $$,
  '42501', 'a pending change is claimed and released only by a scheduled release',
  'the lock refuses a staff insert that arrives claimed, past RLS');
select throws_ok(
  $$ update public.content_drafts set payload = '{"title":{"en":"Sneaked"}}'
      where id = '38000000-0000-0000-0000-000000000d01' $$,
  '42501', 'a pending change claimed by a scheduled release cannot be changed or discarded',
  'the lock refuses a staff edit of a claimed draft, past RLS');
select throws_ok(
  $$ delete from public.content_drafts where id = '38000000-0000-0000-0000-000000000d01' $$,
  '42501', 'a pending change claimed by a scheduled release cannot be changed or discarded',
  'the lock refuses a staff discard of a claimed draft, past RLS');
select _as(null, null);
select lives_ok(
  $$ update public.content_drafts set release_id = '38000000-0000-0000-0000-0000000001a2'
      where id = '38000000-0000-0000-0000-000000000d02' $$,
  'with no role claim (the runbook) a draft can be claimed');
set local role service_role;
select lives_ok(
  $$ update public.content_drafts set release_id = null
      where id = '38000000-0000-0000-0000-000000000d02' $$,
  'the service role releases a claim (the schedule path)');
-- apply_release (R4) deletes the drafts a release consumed as service_role while the
-- publisher's claims are still set.
select _as('admin', '38000000-0000-0000-0000-0000000000a1');
select is(_discard_draft('38000000-0000-0000-0000-000000000d05'), 1,
  'the service role consumes a claimed draft, even with a staff claim set (apply_release)');
reset role;

-- ── 6. Another tenant and anon write nothing ────────────────────────────────────
set local role authenticated;
select _as_other();
select throws_ok(
  $$ insert into public.content_drafts (tenant_id, entity_type, entity_id, op, payload)
     values ('38000000-0000-0000-0000-00000000000a', 'service', gen_random_uuid(), 'update', '{}') $$,
  '42501', null, 'an admin of another tenant CANNOT stage into this tenant');
select is(_touch_draft('38000000-0000-0000-0000-000000000d02'), 0,
  'an admin of another tenant CANNOT edit this tenant''s draft');
select is(_discard_draft('38000000-0000-0000-0000-000000000d02'), 0,
  'an admin of another tenant CANNOT discard this tenant''s draft');
reset role;
set local role anon;
select _as(null, null);
select throws_ok($$ select count(*) from public.content_drafts $$, '42501', null,
  'anon cannot read drafts');
select throws_ok($$ select _stage('service', 'update', '{}') $$, '42501', null,
  'anon cannot stage a change');
reset role;

-- ── 7. The shape and the size of a draft ─────────────────────────────────────────
set local role authenticated;
select _as('admin', '38000000-0000-0000-0000-0000000000a1');
select throws_ok($$ select _stage('service', 'delete', '{"title":{"en":"x"}}') $$, '23514', null,
  'a removal carries no payload');
select throws_ok(
  $$ insert into public.content_drafts (tenant_id, entity_type, entity_id, op, base_version)
     values ('38000000-0000-0000-0000-00000000000a', 'service', gen_random_uuid(), 'create', 3) $$,
  '23514', null, 'a create has no base version');
select throws_ok($$ select _stage('service', 'update', '[1]') $$, '23514', null,
  'a payload is a JSON object');
select throws_ok(
  $$ select _stage('service', 'update', jsonb_build_object('body', _blob(600000))) $$,
  '23514', 'new row for relation "content_drafts" violates check constraint "content_drafts_payload_check"',
  'a payload over 512 KB is refused');
select throws_ok(
  $$ insert into public.content_drafts (tenant_id, entity_type, entity_id, op, base)
     values ('38000000-0000-0000-0000-00000000000a', 'service', gen_random_uuid(), 'update',
             jsonb_build_object('body', _blob(600000))) $$,
  '23514', 'new row for relation "content_drafts" violates check constraint "content_drafts_base_check"',
  'a base over 512 KB is refused');
select throws_ok(
  $$ insert into public.content_drafts (tenant_id, entity_type, entity_id, op, label)
     values ('38000000-0000-0000-0000-00000000000a', 'service', gen_random_uuid(), 'update',
             jsonb_build_object('en', _blob(5000))) $$,
  '23514', 'new row for relation "content_drafts" violates check constraint "content_drafts_label_check"',
  'a label over 4 KB is refused');
select lives_ok(
  $$ insert into public.content_drafts (tenant_id, entity_type, entity_id, op, fields)
     values ('38000000-0000-0000-0000-00000000000a', 'service', gen_random_uuid(), 'update',
             array_fill(repeat('a', 63), array[200])) $$,
  'a draft lists up to 200 changed columns, each a name of up to 63 characters');
select throws_ok(
  $$ insert into public.content_drafts (tenant_id, entity_type, entity_id, op, fields)
     values ('38000000-0000-0000-0000-00000000000a', 'service', gen_random_uuid(), 'update',
             array_fill('title'::text, array[201])) $$,
  '23514', 'new row for relation "content_drafts" violates check constraint "content_drafts_fields_check"',
  'a draft lists at most 200 changed columns');
select throws_ok(
  $$ insert into public.content_drafts (tenant_id, entity_type, entity_id, op, fields)
     values ('38000000-0000-0000-0000-00000000000a', 'service', gen_random_uuid(), 'update',
             array['title', repeat('a', 64)]) $$,
  '23514', 'new row for relation "content_drafts" violates check constraint "content_drafts_fields_check"',
  'a changed column name longer than 63 characters is refused');
select throws_ok(
  $$ insert into public.content_drafts (tenant_id, entity_type, entity_id, op, fields)
     values ('38000000-0000-0000-0000-00000000000a', 'service', gen_random_uuid(), 'update',
             array['title', 'a long, free text']) $$,
  '23514', 'new row for relation "content_drafts" violates check constraint "content_drafts_fields_check"',
  'a changed column is a name, not free text');
select throws_ok(
  $$ insert into public.content_drafts (tenant_id, entity_type, entity_id, op, fields)
     values ('38000000-0000-0000-0000-00000000000a', 'service', gen_random_uuid(), 'update',
             array['title', null]) $$,
  '23514', 'new row for relation "content_drafts" violates check constraint "content_drafts_fields_check"',
  'a changed column list holds no null');
select _as('seo', '38000000-0000-0000-0000-0000000000e1');
select lives_ok(
  $$ select _stage('entity_seo', 'create',
       '{"entityType":"service","entityId":"38000000-0000-0000-0000-0000000005e0"}') $$,
  'seo stages new SEO meta for an entity');
select throws_ok(
  $$ select _stage('entity_seo', 'create',
       '{"entityType":"service","entityId":"38000000-0000-0000-0000-0000000005e0"}') $$,
  '23505', 'duplicate key value violates unique constraint "content_drafts_one_seo_create"',
  'a second pending SEO create for the same entity is refused');
reset role;
select throws_ok($$ select _stage('no_such_type', 'update', '{}') $$, '23503', null,
  'an entity type outside the registry is refused (foreign key), even past RLS');
select is(
  (select string_agg(format('%s %s.%s %s', t.tgname, n.nspname, f.proname, t.tgtype), ', ')
     from pg_trigger t
     join pg_proc f on f.oid = t.tgfoid
     join pg_namespace n on n.oid = f.pronamespace
    where t.tgrelid = 'public.content_drafts'::regclass and not t.tgisinternal),
  'content_drafts_lock app.tg_draft_lock 31',
  'the draft lock is the only trigger on content_drafts (BEFORE, ROW, INSERT/UPDATE/DELETE)');

-- ── 8. Site versions and their items: read-only to staff ────────────────────────
set local role authenticated;
select _as('admin', '38000000-0000-0000-0000-0000000000a1');
select throws_ok(
  $$ insert into public.content_releases (tenant_id, status)
     values ('38000000-0000-0000-0000-00000000000a', 'applying') $$,
  '42501', null, 'admin CANNOT create a release through the API');
select throws_ok($$ update public.content_releases set note = 'rewritten' $$, '42501', null,
  'admin CANNOT rewrite a release');
select throws_ok($$ delete from public.content_releases $$, '42501', null,
  'admin CANNOT delete a release');
select throws_ok(
  $$ insert into public.content_release_items (tenant_id, release_id, entity_type, entity_id, op, after)
     values ('38000000-0000-0000-0000-00000000000a', '38000000-0000-0000-0000-0000000001a1',
             'service', gen_random_uuid(), 'create', '{}') $$,
  '42501', null, 'admin CANNOT add a release item');
select throws_ok($$ update public.content_release_items set after = '{}' $$, '42501', null,
  'admin CANNOT rewrite a release item');
select throws_ok($$ delete from public.content_release_items $$, '42501', null,
  'admin CANNOT delete a release item');
select _as('content_creator', '38000000-0000-0000-0000-0000000000c1');
select is((select count(*)::int from public.content_releases), 2,
  'content creator reads its tenant''s releases');
select _as('seo', '38000000-0000-0000-0000-0000000000e1');
select is((select count(*)::int from public.content_releases), 2, 'seo reads its tenant''s releases');
select _as('developer', '38000000-0000-0000-0000-0000000000d1');
select is((select count(*)::int from public.content_release_items), 1,
  'developer reads its tenant''s release items');
select _as('sales', '38000000-0000-0000-0000-0000000000b5');
select is(
  (select count(*)::int from public.content_releases)
    + (select count(*)::int from public.content_release_items),
  0, 'a sales claim reads no release and no item');
select _as_other();
select is((select count(*)::int from public.content_releases), 1,
  'an admin of another tenant reads only its own tenant''s release');
reset role;
set local role anon;
select _as(null, null);
select throws_ok($$ select count(*) from public.content_releases $$, '42501', null,
  'anon cannot read releases');
select throws_ok($$ select count(*) from public.content_release_items $$, '42501', null,
  'anon cannot read release items');
reset role;

-- The service role writes the ledger (apply_release, R4), but never rewrites history. It
-- holds no privilege on the items' id sequence: an identity column draws its ids without one.
select is(
  (select coalesce(string_agg(r::text, ', ' order by r), '')
     from unnest(array['public', 'anon', 'authenticated', 'service_role']::name[]) as r
    where has_sequence_privilege(r, pg_get_serial_sequence('public.content_release_items', 'id'),
                                 'usage, select, update')),
  '', 'no API role holds a privilege on the release items'' id sequence');
set local role service_role;
select lives_ok(
  $$ insert into public.content_releases (tenant_id, status)
     values ('38000000-0000-0000-0000-00000000000a', 'applying') $$,
  'the service role opens a release');
select lives_ok(
  $$ insert into public.content_release_items (tenant_id, release_id, entity_type, entity_id, op, after)
     values ('38000000-0000-0000-0000-00000000000a', '38000000-0000-0000-0000-0000000001a1',
             'portfolio_children', gen_random_uuid(), 'create', '{"service_ids":[]}') $$,
  'the service role records a synthetic item (the identity draws its id)');
select throws_ok(
  $$ insert into public.content_release_items (tenant_id, release_id, entity_type, entity_id, op, before, after)
     values ('38000000-0000-0000-0000-00000000000a', '38000000-0000-0000-0000-0000000001a1',
             'service', gen_random_uuid(), 'create', '{}', '{}') $$,
  '23514', 'new row for relation "content_release_items" violates check constraint "content_release_items_shape"',
  'a create item carries no before image');
select throws_ok(
  $$ insert into public.content_release_items (tenant_id, release_id, entity_type, entity_id, op, after)
     values ('38000000-0000-0000-0000-00000000000a', '38000000-0000-0000-0000-0000000001a1',
             'service', gen_random_uuid(), 'delete', '{}') $$,
  '23514', 'new row for relation "content_release_items" violates check constraint "content_release_items_shape"',
  'a delete item carries a before image and no after');
select throws_ok(
  $$ insert into public.content_release_items (tenant_id, release_id, entity_type, entity_id, op, after)
     values ('38000000-0000-0000-0000-00000000000a', '38000000-0000-0000-0000-0000000001a1',
             'service', gen_random_uuid(), 'update', '{}') $$,
  '23514', 'new row for relation "content_release_items" violates check constraint "content_release_items_shape"',
  'an update item carries both images');
select throws_ok($$ delete from public.content_releases $$, '42501', null,
  'the service role CANNOT delete a release');
select throws_ok($$ update public.content_release_items set after = '{}' $$, '42501', null,
  'the service role CANNOT rewrite a release item (append-only)');
select throws_ok($$ delete from public.content_release_items $$, '42501', null,
  'the service role CANNOT delete a release item (append-only)');
reset role;
select throws_ok(
  $$ insert into public.content_release_items (tenant_id, release_id, entity_type, entity_id, op, before)
     values ('38000000-0000-0000-0000-00000000000a', '38000000-0000-0000-0000-0000000001b1',
             'service', gen_random_uuid(), 'delete', '{}') $$,
  '23503', null, 'an item cannot name another tenant''s release (tenant-fenced key)');

-- ── 9. The registry and the switch-on flag ──────────────────────────────────────
set local role authenticated;
select _as('content_creator', '38000000-0000-0000-0000-0000000000c1');
select is((select count(*)::int from app.release_entities), 20,
  'CMS staff read the registry (twenty entity types)');
select ok(app.can_author('service') and not app.can_author('redirect')
          and not app.can_stage_delete('service'),
  'content creator: authors services, not redirects, and stages no removal');
select throws_ok($$ insert into app.release_entities (entity_type) values ('x') $$, '42501', null,
  'staff CANNOT change the registry');
select throws_ok($$ select count(*) from app.release_tenants $$, '42501', null,
  'staff CANNOT read the switch-on flag table');
select _as('admin', '38000000-0000-0000-0000-0000000000a1');
select ok(app.can_stage_delete('service') and app.can_stage_delete('redirect')
          and not app.can_stage_delete('site_profile'),
  'admin stages removals, except of a singleton');
select _as('sales', '38000000-0000-0000-0000-0000000000b5');
select is((select count(*)::int from app.release_entities), 0,
  'a sales claim reads no registry row');
reset role;
set local role anon;
select _as(null, null);
select throws_ok($$ select count(*) from app.release_entities $$, '42501', null,
  'anon cannot read the registry');
reset role;
set local role service_role;
select throws_ok($$ select count(*) from app.release_tenants $$, '42501', null,
  'the service role CANNOT read the switch-on flag table either');
reset role;

select is(app.releases_enabled('38000000-0000-0000-0000-00000000000a'), false,
  'releases are off for a tenant with no flag row');
insert into app.release_tenants (tenant_id) values ('38000000-0000-0000-0000-00000000000a');
select ok(app.releases_enabled('38000000-0000-0000-0000-00000000000a')
          and not app.releases_enabled('38000000-0000-0000-0000-00000000000b'),
  'the flag is per tenant: on for A, still off for B');

-- ── 10. Removing a theme is Admin's (registry contract #2) ──────────────────────
set local role authenticated;
select _as('content_creator', '38000000-0000-0000-0000-0000000000c1');
select is(_delete_theme(), 0, 'content creator CANNOT delete a theme (not a theme editor)');
select _as('seo', '38000000-0000-0000-0000-0000000000e1');
select is(_delete_theme(), 0, 'seo CANNOT delete a theme');
select _as('developer', '38000000-0000-0000-0000-0000000000d1');
select is(_delete_theme(), 0, 'developer CANNOT delete a theme (RESTRICTIVE, 0038)');
select _as_other();
select is(_delete_theme(), 0, 'an admin of another tenant CANNOT delete this tenant''s theme');
reset role;
set local role anon;
select _as(null, null);
select throws_ok($$ select _delete_theme() $$, '42501', null, 'anon CANNOT delete a theme');
reset role;
set local role authenticated;
select _as('admin', '38000000-0000-0000-0000-0000000000a1');
select is(_delete_theme(), 1, 'admin deletes a theme');

reset role;
select * from finish();
rollback;
