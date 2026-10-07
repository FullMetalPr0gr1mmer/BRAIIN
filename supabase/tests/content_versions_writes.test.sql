-- pgTAP: who writes public.content_versions (migration 0032, hotfix H6).
--
-- History must be written by the snapshot trigger and by nothing else. Before 0032 any
-- staff role could insert rows straight through the API, forging both the content of a
-- past version and the person it names. These assertions check both halves: every API
-- role is refused a direct write, by the GRANT layer AND by RLS on its own, and an
-- ordinary staff edit still records its snapshot, attributed to the real editor. The rows
-- run over admin, content_creator, seo, developer, anon and other_tenant (CLAUDE.md §9).
--
-- Run with `supabase test db`. CLAUDE.md §3 (Pillar 1), §8, §9.

begin;
select plan(19);

insert into public.tenants (id, name) values ('68000000-0000-0000-0000-000000000001', 'HistT');

create function _as(p_role text, p_sub text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    case when p_role is null then ''
         else json_build_object(
                'sub', p_sub,
                'app_metadata', json_build_object(
                  'role', p_role, 'tenant_id', '68000000-0000-0000-0000-000000000001')
              )::text
    end,
    true
  )
$$;

-- Admin of ANOTHER tenant (the other_tenant row).
create function _as_other(p_role text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    json_build_object(
      'sub', '68000000-0000-0000-0000-0000000000f1',
      'app_metadata', json_build_object(
        'role', p_role, 'tenant_id', '68000000-0000-0000-0000-0000000000ff')
    )::text,
    true
  )
$$;

create function _forge() returns void language sql as $$
  insert into public.content_versions (tenant_id, entity_type, entity_id, version, snapshot, created_by)
  values ('68000000-0000-0000-0000-000000000001', 'service', gen_random_uuid(), 99,
          '{"title":{"en":"forged"}}'::jsonb, '68000000-0000-0000-0000-0000000000ff')
$$;

-- ── 1. No API role writes history directly ─────────────────────────────────────
set local role authenticated;
select _as('admin', '68000000-0000-0000-0000-0000000000a1');
select throws_ok($$ select _forge() $$, '42501', null, 'admin CANNOT insert a history row directly');
select _as('content_creator', '68000000-0000-0000-0000-0000000000c1');
select throws_ok($$ select _forge() $$, '42501', null, 'content creator CANNOT insert a history row directly');
select _as('seo', '68000000-0000-0000-0000-0000000000e1');
select throws_ok($$ select _forge() $$, '42501', null, 'seo CANNOT insert a history row directly');
select _as('developer', '68000000-0000-0000-0000-0000000000d1');
select throws_ok($$ select _forge() $$, '42501', null, 'developer CANNOT insert a history row directly');
select _as_other('admin');
select throws_ok($$ select _forge() $$, '42501', null, 'admin of another tenant CANNOT insert a history row');

-- ── 1b. RLS refuses on its own, even if a later grant restored INSERT ───────────
-- The privilege is put back inside this (rolled-back) transaction, so the refusal below
-- can only come from the policies: no insert policy names an API role any more.
reset role;
grant insert on public.content_versions to authenticated;
set local role authenticated;
select _as('admin', '68000000-0000-0000-0000-0000000000a1');
select throws_ok($$ select _forge() $$, '42501',
  'new row violates row-level security policy for table "content_versions"',
  'with the GRANT restored, RLS alone still refuses an admin''s direct insert');
select _as('content_creator', '68000000-0000-0000-0000-0000000000c1');
select throws_ok($$ select _forge() $$, '42501',
  'new row violates row-level security policy for table "content_versions"',
  'with the GRANT restored, RLS alone still refuses a content creator''s direct insert');
reset role;
revoke insert on public.content_versions from authenticated;
set local role authenticated;

-- ── 2. A staff edit still records its snapshot, attributed to the editor ──────
select _as('content_creator', '68000000-0000-0000-0000-0000000000c1');
insert into public.disciplines (tenant_id, slug, name)
values ('68000000-0000-0000-0000-000000000001', 'pg-hist-disc', '{"en":"History","ar":"السجل"}');

select is(
  (select count(*)::int from public.content_versions
    where entity_type = 'discipline'
      and entity_id = (select id from public.disciplines where slug = 'pg-hist-disc')),
  1, 'the snapshot trigger still writes history for a staff edit (as the table owner)');
select is(
  (select created_by::text from public.content_versions
    where entity_type = 'discipline'
      and entity_id = (select id from public.disciplines where slug = 'pg-hist-disc')),
  '68000000-0000-0000-0000-0000000000c1',
  'the snapshot names the real editor (auth.uid()), which no caller can supply');

-- ── 3. Staff read history; nobody rewrites or deletes it ───────────────────────
create function _hist_count() returns int language sql as $$
  select count(*)::int from public.content_versions
   where entity_type = 'discipline'
     and entity_id = (select id from public.disciplines where slug = 'pg-hist-disc')
$$;
select _as('seo', '68000000-0000-0000-0000-0000000000e1');
select is(_hist_count(), 1, 'seo reads the snapshot (staff read history)');
select _as('developer', '68000000-0000-0000-0000-0000000000d1');
select is(_hist_count(), 1, 'developer reads the snapshot');
select _as_other('admin');
select is((select count(*)::int from public.content_versions), 0,
  'admin of another tenant reads no history row');
select _as('admin', '68000000-0000-0000-0000-0000000000a1');
select throws_ok(
  $$ update public.content_versions set snapshot = '{}'::jsonb where entity_type = 'discipline' $$,
  '42501', null, 'admin CANNOT rewrite a history row');
select throws_ok($$ delete from public.content_versions $$, '42501', null,
  'admin CANNOT delete a history row');
select _as('content_creator', '68000000-0000-0000-0000-0000000000c1');
select throws_ok($$ delete from public.content_versions $$, '42501', null,
  'content creator CANNOT delete a history row');
select _as('seo', '68000000-0000-0000-0000-0000000000e1');
select throws_ok($$ delete from public.content_versions $$, '42501', null,
  'seo CANNOT delete a history row');
select _as('developer', '68000000-0000-0000-0000-0000000000d1');
select throws_ok($$ delete from public.content_versions $$, '42501', null,
  'developer CANNOT delete a history row');

-- ── 4. anon never reaches history ─────────────────────────────────────────────
reset role;
set local role anon;
select _as(null, null);
select throws_ok(
  $$ select count(*) from public.content_versions $$,
  '42501', null, 'anon cannot read history');
select throws_ok($$ select _forge() $$, '42501', null, 'anon CANNOT insert a history row');

reset role;
select * from finish();
rollback;
