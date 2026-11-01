-- pgTAP: the forms config (Admin v2 E8, public.form_settings; CLAUDE.md §5 "General settings",
-- docs/admin-v2/README.md P-2 and P-3). Run with `supabase test db`.
--
--   • the catalog: RLS forced, the exact policy set, the grants (anon reads four columns, staff
--     select, insert and update, never DELETE; nobody TRUNCATEs), the registry row, the guard
--     first among the BEFORE triggers;
--   • Admin and Developer add and change the row (settings.general); Content Creator, SEO and
--     Sales change nothing; every CMS role reads it (registry contract #1), Sales none;
--   • anon reads the launch tenant's copy and nothing else of the row, never another tenant's,
--     and writes nothing;
--   • another tenant's Admin reads and writes none of this tenant's row;
--   • stale tokens (a demoted Developer, a deactivated Admin, a locked Admin) change nothing
--     (the RESTRICTIVE live check);
--   • the consent revision is the database's: 1 on a first reworded consent, one more per
--     change of the consent lines, never a writer's value;
--   • the copy CHECK refuses markup, a line break and a shape that is not an object (23514);
--   • history: every save is a content_versions row under 'form_settings';
--   • releases on: a direct write is refused by the release guard;
--   • job_applications.consent_version takes a notice date with an optional `.r<N>`.
--
-- T1 is created older than any seeded tenant, so inside this transaction it is the launch
-- tenant anon resolves to (app.default_tenant_id()).

begin;
select plan(39);

-- ── fixtures (as the migration role) ─────────────────────────────────────────
insert into public.tenants (id, name, created_at) values
  ('e8000000-0000-0000-0000-000000000001', 'E8 one', '2000-01-01T00:00:00Z'),
  ('e8000000-0000-0000-0000-0000000000ff', 'E8 two', '2000-01-02T00:00:00Z');
insert into auth.users (id, email) values
  ('e8000000-0000-0000-0000-0000000000a1', 'e8-admin@example.test'),
  ('e8000000-0000-0000-0000-0000000000c1', 'e8-creator@example.test'),
  ('e8000000-0000-0000-0000-0000000000e1', 'e8-seo@example.test'),
  ('e8000000-0000-0000-0000-0000000000d1', 'e8-developer@example.test'),
  ('e8000000-0000-0000-0000-0000000000b1', 'e8-sales@example.test'),
  ('e8000000-0000-0000-0000-0000000000d2', 'e8-demoted@example.test'),
  ('e8000000-0000-0000-0000-0000000000a3', 'e8-inactive@example.test'),
  ('e8000000-0000-0000-0000-0000000000a4', 'e8-locked@example.test'),
  ('e8000000-0000-0000-0000-0000000000f1', 'e8-other@example.test');
insert into public.profiles (id, tenant_id, role, is_active, locked_until) values
  ('e8000000-0000-0000-0000-0000000000a1', 'e8000000-0000-0000-0000-000000000001', 'admin', true, null),
  ('e8000000-0000-0000-0000-0000000000c1', 'e8000000-0000-0000-0000-000000000001', 'content_creator', true, null),
  ('e8000000-0000-0000-0000-0000000000e1', 'e8000000-0000-0000-0000-000000000001', 'seo', true, null),
  ('e8000000-0000-0000-0000-0000000000d1', 'e8000000-0000-0000-0000-000000000001', 'developer', true, null),
  ('e8000000-0000-0000-0000-0000000000b1', 'e8000000-0000-0000-0000-000000000001', 'sales', true, null),
  -- Stale: each token below still says developer or admin.
  ('e8000000-0000-0000-0000-0000000000d2', 'e8000000-0000-0000-0000-000000000001', 'content_creator', true, null),
  ('e8000000-0000-0000-0000-0000000000a3', 'e8000000-0000-0000-0000-000000000001', 'admin', false, null),
  ('e8000000-0000-0000-0000-0000000000a4', 'e8000000-0000-0000-0000-000000000001', 'admin', true,
   now() + interval '10 minutes'),
  ('e8000000-0000-0000-0000-0000000000f1', 'e8000000-0000-0000-0000-0000000000ff', 'admin', true, null);
-- The other tenant's row, with copy anon must never see.
insert into public.form_settings (tenant_id, inquiry)
  values ('e8000000-0000-0000-0000-0000000000ff', '{"button":{"en":"Other","ar":"آخر"}}');

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
-- T1's rows as the CURRENT role.
create function _seen() returns int language sql as $$
  select count(*)::int from public.form_settings where tenant_id = 'e8000000-0000-0000-0000-000000000001'
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
-- T1's rows as a signed-in token of the given role.
create function _seen_as(p_sub text, p_role text) returns int language plpgsql as $f$
begin
  perform _as(p_sub, p_role, 'e8000000-0000-0000-0000-000000000001');
  return _seen();
end $f$;
grant execute on function _as(text, text, text), _rows(text), _seen(), _state(text), _seen_as(text, text)
  to anon, authenticated, service_role;

-- ── 1. The catalog ───────────────────────────────────────────────────────────
select ok((select relrowsecurity and relforcerowsecurity from pg_class
            where oid = 'public.form_settings'::regclass),
  'form_settings is ENABLE + FORCE row level security');
select is(
  (select string_agg(format('%s %s %s %s', policyname, cmd, permissive, roles), ', '
                     order by policyname collate "C")
     from pg_policies where schemaname = 'public' and tablename = 'form_settings'),
  'form_settings_insert INSERT PERMISSIVE {authenticated}, '
  || 'form_settings_live_insert INSERT RESTRICTIVE {authenticated}, '
  || 'form_settings_live_update UPDATE RESTRICTIVE {authenticated}, '
  || 'form_settings_read SELECT PERMISSIVE {public}, '
  || 'form_settings_staff_columns SELECT RESTRICTIVE {authenticated}, '
  || 'form_settings_update UPDATE PERMISSIVE {authenticated}',
  'the policies: the tenant read, the non-staff block, settings.general by the token and live');
select is(
  (select string_agg(a.attname::text, ',' order by a.attname::text collate "C")
     from pg_attribute a
    where a.attrelid = 'public.form_settings'::regclass and a.attnum > 0 and not a.attisdropped
      and has_column_privilege('anon', a.attrelid, a.attnum, 'select')),
  'application,consent_revision,inquiry,tenant_id',
  'anon may read the two forms, the consent revision and the tenant, no other column');
select ok(not has_table_privilege('anon', 'public.form_settings', 'select')
          and not has_any_column_privilege('anon', 'public.form_settings', 'insert, update, references'),
  'anon holds no table-level SELECT and no write');
select ok(has_table_privilege('authenticated', 'public.form_settings', 'select, insert, update')
          and not has_table_privilege('authenticated', 'public.form_settings', 'delete')
          and not has_table_privilege('authenticated', 'public.form_settings', 'truncate')
          and not has_table_privilege('service_role', 'public.form_settings', 'truncate')
          and has_table_privilege('service_role', 'public.form_settings', 'select, insert, update, delete'),
  'staff select, insert and update, never DELETE; the service role all four; nobody TRUNCATEs');
select ok(exists (select 1 from app.release_entities
                   where entity_type = 'form_settings' and table_name = 'form_settings'
                     and key_column = 'tenant_id' and area = 'settings'
                     and author_roles = '{admin,developer}' and delete_roles = '{}'
                     and columns = '{inquiry,application}' and exempt_columns = '{}'),
  'the registry row: staged under settings, authored by Admin and Developer, never removed');
select is(
  (select tgname::text from pg_trigger
    where tgrelid = 'public.form_settings'::regclass and not tgisinternal
      and tgtype & 1 = 1 and tgtype & 2 = 2
    order by tgname collate "C" limit 1),
  'form_settings__release_guard', 'the release guard is the first BEFORE trigger');

-- ── 2. Admin and Developer write; every CMS role reads ───────────────────────
set local role authenticated;
select _as('e8000000-0000-0000-0000-0000000000a1', 'admin', 'e8000000-0000-0000-0000-000000000001');
select is(_rows($$ insert into public.form_settings (tenant_id, inquiry)
                   values ('e8000000-0000-0000-0000-000000000001',
                           '{"button":{"en":"Send it","ar":"أرسل"}}') $$), 1,
  'admin adds the row');
select is((select format('%s/%s', version, consent_revision) from public.form_settings
            where tenant_id = 'e8000000-0000-0000-0000-000000000001'), '1/0',
  'a first save without consent lines: version 1, consent revision 0');
select is(_rows($$ update public.form_settings
                     set application = '{"consent":{"application":{"en":"I agree","ar":"أوافق"}}}'
                   where tenant_id = 'e8000000-0000-0000-0000-000000000001' $$), 1,
  'admin rewords the Join consent');
select is((select format('%s/%s', version, consent_revision) from public.form_settings
            where tenant_id = 'e8000000-0000-0000-0000-000000000001'), '2/1',
  'a reworded consent: the version moves and the consent revision is 1');
select is(_rows($$ update public.form_settings set consent_revision = 99,
                     inquiry = '{"button":{"en":"Go","ar":"اذهب"}}'
                   where tenant_id = 'e8000000-0000-0000-0000-000000000001' $$), 1,
  'admin changes the inquiry form and names a consent revision');
select is((select consent_revision from public.form_settings
            where tenant_id = 'e8000000-0000-0000-0000-000000000001'), 1,
  'the consent revision is the database''s: a writer''s value is ignored, and an inquiry change leaves it');
select _as('e8000000-0000-0000-0000-0000000000d1', 'developer', 'e8000000-0000-0000-0000-000000000001');
select is(_rows($$ update public.form_settings
                     set application = '{"consent":{"application":{"en":"Yes","ar":"نعم"}}}'
                   where tenant_id = 'e8000000-0000-0000-0000-000000000001' $$), 1,
  'developer changes the row (settings.general)');
select is((select consent_revision from public.form_settings
            where tenant_id = 'e8000000-0000-0000-0000-000000000001'), 2,
  'a second rewording: consent revision 2');
select _as('e8000000-0000-0000-0000-0000000000c1', 'content_creator', 'e8000000-0000-0000-0000-000000000001');
select is(_rows($$ update public.form_settings set inquiry = '{}'
                   where tenant_id = 'e8000000-0000-0000-0000-000000000001' $$), 0,
  'content_creator CANNOT change the forms config');
select _as('e8000000-0000-0000-0000-0000000000e1', 'seo', 'e8000000-0000-0000-0000-000000000001');
select is(_rows($$ update public.form_settings set inquiry = '{}'
                   where tenant_id = 'e8000000-0000-0000-0000-000000000001' $$), 0,
  'seo CANNOT change the forms config');
select _as('e8000000-0000-0000-0000-0000000000b1', 'sales', 'e8000000-0000-0000-0000-000000000001');
select is(_rows($$ update public.form_settings set inquiry = '{}'
                   where tenant_id = 'e8000000-0000-0000-0000-000000000001' $$)
          + _seen(), 0,
  'sales reads and changes nothing (the non-staff block)');
select is(_state($$ delete from public.form_settings
                    where tenant_id = 'e8000000-0000-0000-0000-000000000001' $$), '42501',
  'nobody signed in deletes the row (no grant)');
select is(_seen_as('e8000000-0000-0000-0000-0000000000a1', 'admin')
          + _seen_as('e8000000-0000-0000-0000-0000000000c1', 'content_creator')
          + _seen_as('e8000000-0000-0000-0000-0000000000e1', 'seo')
          + _seen_as('e8000000-0000-0000-0000-0000000000d1', 'developer'),
  4, 'admin, content_creator, seo and developer each read the row (registry contract #1)');
select _as('e8000000-0000-0000-0000-0000000000a1', 'admin', 'e8000000-0000-0000-0000-000000000001');
select is(_state($$ insert into public.form_settings (tenant_id)
                    values ('e8000000-0000-0000-0000-0000000000ff') $$), '42501',
  'admin CANNOT add a row for another tenant (the tenant predicate)');

-- ── 3. Stale tokens and another tenant ───────────────────────────────────────
select _as('e8000000-0000-0000-0000-0000000000d2', 'developer', 'e8000000-0000-0000-0000-000000000001');
select is(_rows($$ update public.form_settings set inquiry = '{}'
                   where tenant_id = 'e8000000-0000-0000-0000-000000000001' $$), 0,
  'a demoted developer''s token changes nothing (live check)');
select _as('e8000000-0000-0000-0000-0000000000a3', 'admin', 'e8000000-0000-0000-0000-000000000001');
select is(_rows($$ update public.form_settings set inquiry = '{}'
                   where tenant_id = 'e8000000-0000-0000-0000-000000000001' $$), 0,
  'a deactivated admin''s token changes nothing (live check)');
select _as('e8000000-0000-0000-0000-0000000000a4', 'admin', 'e8000000-0000-0000-0000-000000000001');
select is(_rows($$ update public.form_settings set inquiry = '{}'
                   where tenant_id = 'e8000000-0000-0000-0000-000000000001' $$), 0,
  'a locked admin''s token changes nothing (live check)');
select _as('e8000000-0000-0000-0000-0000000000f1', 'admin', 'e8000000-0000-0000-0000-0000000000ff');
select is(_seen() + _rows($$ update public.form_settings set inquiry = '{}'
                             where tenant_id = 'e8000000-0000-0000-0000-000000000001' $$), 0,
  'other_tenant reads and changes none of this tenant''s row');

-- ── 4. The copy CHECK ────────────────────────────────────────────────────────
select _as('e8000000-0000-0000-0000-0000000000a1', 'admin', 'e8000000-0000-0000-0000-000000000001');
select is(_state($$ update public.form_settings set inquiry = '{"button":{"en":"<b>Go</b>","ar":"اذهب"}}'
                    where tenant_id = 'e8000000-0000-0000-0000-000000000001' $$), '23514',
  'markup in copy is refused');
select is(_state(format($$ update public.form_settings set application = %L
                           where tenant_id = 'e8000000-0000-0000-0000-000000000001' $$,
                        jsonb_build_object('button', jsonb_build_object('en', E'Se\nnd', 'ar', 'أرسل')))),
  '23514', 'a line break in copy is refused');
select is(_state($$ update public.form_settings set inquiry = '[]'
                    where tenant_id = 'e8000000-0000-0000-0000-000000000001' $$), '23514',
  'a form that is not a JSON object is refused');
select is(_state(format($$ update public.form_settings set inquiry = %L
                           where tenant_id = 'e8000000-0000-0000-0000-000000000001' $$,
                        jsonb_build_object('x', repeat('a', 16400)))),
  '23514', 'a form over 16 KB is refused');
reset role;

select is(
  (select count(*)::int from public.content_versions
    where entity_type = 'form_settings' and entity_id = 'e8000000-0000-0000-0000-000000000001'),
  4, 'every save is a history row under form_settings, keyed by the tenant');

-- ── 5. anon ──────────────────────────────────────────────────────────────────
set local role anon;
select _as(null, null, null);
select is((select inquiry #>> '{button,en}' from public.form_settings), 'Go',
  'anon reads the launch tenant''s copy, never another tenant''s');
select is((select consent_revision from public.form_settings), 2,
  'anon reads the consent revision the Join form posts');
select is(_state($$ select version from public.form_settings $$), '42501',
  'anon CANNOT read the version (no column grant)');
select is(_state($$ update public.form_settings set inquiry = '{}' $$), '42501',
  'anon CANNOT change the forms config');
reset role;

-- ── 6. Releases on: the guard refuses a direct write ─────────────────────────
insert into app.release_tenants (tenant_id) values ('e8000000-0000-0000-0000-000000000001');
set local role authenticated;
select _as('e8000000-0000-0000-0000-0000000000a1', 'admin', 'e8000000-0000-0000-0000-000000000001');
select is(_state($$ update public.form_settings set inquiry = '{}'
                    where tenant_id = 'e8000000-0000-0000-0000-000000000001' $$), '42501',
  'releases on: admin CANNOT write the forms config directly (the release guard)');
reset role;

-- ── 7. The consent version an application stores ─────────────────────────────
select ok((select pg_get_constraintdef(c.oid) like '%\.r[1-9][0-9]{0,8})?$%'
             from pg_constraint c
            where c.conrelid = 'public.job_applications'::regclass
              and c.conname = 'job_applications_consent_version_check'),
  'job_applications.consent_version takes a notice date with an optional .r<N>');
-- The constraint itself, on a real insert (as the migration role, as /api/apply's service role
-- writes): a notice date and a date with a revision from 1 are stored; `.r0` and a bare `.r` are
-- refused (23514).
create function _apply_with(p_version text) returns text language sql as $$
  select _state(format($i$
    insert into public.job_applications (tenant_id, name, email_enc, phone_enc, city, role,
      experience, work_type, availability, skills, portfolio_url, message, consent_version,
      retention_delete_after)
    values ('e8000000-0000-0000-0000-000000000001', 'Applicant', 'ciphertext', 'ciphertext',
      'Jeddah', 'Motion designer', '1-3', 'freelance', 'month', array['animation'],
      'https://example.com/work', 'My best piece', %L, now() + interval '12 months')
  $i$, p_version))
$$;
select is(_apply_with('2026-10-04') || '|' || _apply_with('2026-10-04.r3'), '|',
  'job_applications stores a notice date, and one with a revision from 1');
select is(_apply_with('2026-10-04.r0'), '23514',
  'job_applications refuses a revision 0 (23514)');
select is(_apply_with('2026-10-04.r'), '23514',
  'job_applications refuses a bare .r (23514)');

select * from finish();
rollback;
