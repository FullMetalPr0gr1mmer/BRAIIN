-- ─────────────────────────────────────────────────────────────────────────────────────────
-- E8 — The forms config: public.form_settings (Admin v2 E8). Forward-only and EXPAND only:
-- one new table (a staged per-tenant singleton), two new functions (its copy CHECK and its
-- consent-revision trigger), its release-registry row, and one widened CHECK on
-- job_applications. Nothing that exists narrows.
-- Depends on 0001 (tenants, app.current_role, app.tg_set_updated_at), 0009 (app.tg_bump_version,
-- app.tg_set_actor), 0029 (job_applications), 0033 (app.live_role), 0038 (the release registry,
-- app.tg_snapshot_singleton), 0051 (app.tg_release_capture), 0066 (app.tg_release_guard),
-- 0097 (C10a: the non-staff block this table joins) and 0102 (U9: app.role_general_settings).
--
-- The design is docs/admin-v2/README.md (the E8 row, P-2: forms config publishes under
-- settings.general, P-3: forms config is staged), ui.md "Integrations, Forms, Notifications
-- (AV-20)", deviations.md "Forms" and releases.md §1.3 (the registry contract); what was built
-- and every departure is docs/admin-v2/as-built/E8.md.
--
--   1. app.form_copy_ok(jsonb): a stored form is a JSON object of at most 16 KB in which no
--      string carries `<`, `>` or a C0/C1 control character (no markup, no line break). Its
--      SHAPE is the Worker's Zod contract (packages/schemas/forms.ts), re-parsed by every
--      reader part by part (src/lib/forms/config.ts), so a row written around the Worker costs
--      a part its built-in value, never a page.
--   2. public.form_settings: one row per tenant (key tenant_id, created on the first save, as
--      seo_defaults), `inquiry` and `application` holding only what differs from the built-in
--      forms, `consent_revision` (computed, below), version, stamps and actors.
--   3. RLS, ENABLE + FORCE, the tenant predicate FIRST in every USING and WITH CHECK: everyone
--      reads the tenant's row (the forms are public copy: anon renders it); a signed-in token
--      that is not CMS staff reads none (0097's non-staff block); Admin and Developer insert and
--      update by the token's role (app.role_general_settings(app.current_role())) and,
--      RESTRICTIVE, by the live profile (app.live_role()), as 0102 holds site_profile; nobody
--      deletes (no policy, no grant).
--   4. Grants, stated for both Supabase grant regimes (P-14): anon SELECTs four columns
--      (tenant_id, inquiry, application, consent_revision: never the version, the stamps or the
--      actors); authenticated SELECT, INSERT, UPDATE; the service role SELECT, INSERT, UPDATE,
--      DELETE; no TRUNCATE, REFERENCES, TRIGGER or MAINTAIN for anyone.
--   5. Triggers, BEFORE ones in the order their names sort: the release guard
--      (`form_settings__release_guard`, first), the actor, the consent revision, updated_at and
--      the version; AFTER: the history snapshot (app.tg_snapshot_singleton('form_settings')) and
--      the release capture (keyed by tenant_id).
--   6. The consent revision: app.tg_form_consent_revision sets consent_revision on every write
--      and never takes the writer's value: 0 or 1 on the insert (1 when the row words the Join
--      consent lines), and one more on every update that changes `application -> 'consent'`.
--      A Join form whose consent lines are reworded posts `<notice date>.r<revision>`, the
--      version an application stores, and the wording of revision N is the row's history
--      (content_versions), which only the snapshot trigger writes (0032).
--   7. The release registry row (registry contract #4): staged once releases switch on (P-3);
--      authors Admin and Developer (settings.general), never removed by a release.
--   8. job_applications.consent_version: the CHECK widens from a notice date to a notice date
--      with an optional `.r<N>` (packages/schemas/forms.ts CONSENT_VERSION_PATTERN). Every
--      stored value still passes; /api/apply accepts N only up to the published revision.
--
-- No new capability and no app.role_* helper (settings.general is 0102's
-- app.role_general_settings), no ROLE_CAPS or §5 change. No content is seeded: no row is the
-- forms as built.
--
-- CLAUDE.md §3 (Pillar 1), §8 (Admin v2 lanes), §9.
-- ─────────────────────────────────────────────────────────────────────────────────────────

-- A busy table fails the push instead of queueing behind it: the push is retried later.
-- Transaction-local: it ends with this file.
set local lock_timeout = '5s';

-- ═══ 1. The copy CHECK ═══════════════════════════════════════════════════════════════════
-- `language sql immutable` (a CHECK needs a stable meaning). Every string anywhere in the
-- object is tested; a jsonb string cannot hold NUL, so the control range starts at U+0001.
create or replace function app.form_copy_ok(p jsonb) returns boolean
  language sql immutable set search_path = ''
as $$
  select coalesce(
    pg_catalog.jsonb_typeof(p) = 'object'
    and pg_catalog.octet_length(p::text) <= 16384
    and not pg_catalog.jsonb_path_exists(
      p, '$.** ? (@.type() == "string" && @ like_regex "[<>\u0001-\u001f\u007f-\u009f]")'),
    false)
$$;
-- A CHECK runs with the writer's privileges: the two roles that write may call it.
revoke all on function app.form_copy_ok(jsonb) from public, anon, authenticated, service_role;
grant execute on function app.form_copy_ok(jsonb) to authenticated, service_role;

-- ═══ 2. The table ═════════════════════════════════════════════════════════════════════════
create table if not exists public.form_settings (
  tenant_id uuid primary key default app.effective_tenant_id()
    references public.tenants (id) on delete cascade,
  inquiry jsonb not null default '{}'::jsonb,
  application jsonb not null default '{}'::jsonb,
  consent_revision int not null default 0,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  constraint form_settings_inquiry_copy check (app.form_copy_ok(inquiry)),
  constraint form_settings_application_copy check (app.form_copy_ok(application)),
  constraint form_settings_consent_revision_range check (consent_revision >= 0)
);
alter table public.form_settings enable row level security;
alter table public.form_settings force row level security;
comment on table public.form_settings is
  'The forms config (Admin v2 E8): per tenant, what the inquiry form and the Join form change '
  'from the built-in forms (labels, order, optional fields shown and required, the button, '
  'the budget labels, the Join consent lines). Read by the public forms and by /api/contact '
  'and /api/apply, which hold a submission to it (src/lib/forms/config.ts).';
comment on column public.form_settings.consent_revision is
  'Computed by app.tg_form_consent_revision, never written by a client or a release: one more '
  'on every change of application->consent. A reworded Join form posts <notice date>.r<N>.';

-- ═══ 3. Row security (the fence before any grant) ═════════════════════════════════════════
drop policy if exists form_settings_read on public.form_settings;
create policy form_settings_read on public.form_settings for select
  using (tenant_id = app.effective_tenant_id());
-- The non-staff block (0097 §4, Admin v2 C10a): a signed-in token that is not CMS staff reads
-- no more than anon outside the CRM, and a GRANT cannot tell the app roles apart. RESTRICTIVE,
-- FOR SELECT, TO authenticated, the tenant predicate first, then app.is_staff(). anon is not
-- named: anon reads its four columns through form_settings_read.
drop policy if exists form_settings_staff_columns on public.form_settings;
create policy form_settings_staff_columns on public.form_settings
  as restrictive for select to authenticated
  using (tenant_id = app.effective_tenant_id() and app.is_staff());
drop policy if exists form_settings_insert on public.form_settings;
create policy form_settings_insert on public.form_settings for insert to authenticated
  with check (tenant_id = app.effective_tenant_id() and app.role_general_settings(app.current_role()));
drop policy if exists form_settings_update on public.form_settings;
create policy form_settings_update on public.form_settings for update to authenticated
  using (tenant_id = app.effective_tenant_id() and app.role_general_settings(app.current_role()))
  with check (tenant_id = app.effective_tenant_id() and app.role_general_settings(app.current_role()));
-- The live check (as 0102 for site_profile): the profile, read now, must still hold
-- settings.general, so a demoted, deactivated or locked token writes nothing.
drop policy if exists form_settings_live_insert on public.form_settings;
create policy form_settings_live_insert on public.form_settings as restrictive for insert to authenticated
  with check (tenant_id = app.effective_tenant_id() and app.role_general_settings((select app.live_role())));
drop policy if exists form_settings_live_update on public.form_settings;
create policy form_settings_live_update on public.form_settings as restrictive for update to authenticated
  using (tenant_id = app.effective_tenant_id() and app.role_general_settings((select app.live_role())))
  with check (tenant_id = app.effective_tenant_id() and app.role_general_settings((select app.live_role())));

-- ═══ 4. Grants (stated, never inherited: both grant regimes) ══════════════════════════════
-- Readers and writers: anon reads the copy (the public forms, the preview's dataset);
-- staff read the row and Admin and Developer write it (the Forms screen, through the singleton
-- kernel); the service role reads it (/api/contact, /api/apply), and inserts, updates and
-- deletes it (apply_release's conflict lock, the seeds, R17's restore). Never TRUNCATE (it
-- fires no row trigger: neither the guard nor the capture would see it, 0066).
revoke all on public.form_settings from public, anon, authenticated, service_role;
grant select (tenant_id, inquiry, application, consent_revision) on public.form_settings to anon;
grant select, insert, update on public.form_settings to authenticated;
grant select, insert, update, delete on public.form_settings to service_role;

-- ═══ 5 + 6. Triggers ══════════════════════════════════════════════════════════════════════
-- The consent revision. SECURITY INVOKER (it reads only OLD and NEW), search_path ''.
create or replace function app.tg_form_consent_revision() returns trigger
  language plpgsql set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.consent_revision := case when new.application ? 'consent' then 1 else 0 end;
  else
    new.consent_revision := old.consent_revision
      + case when (new.application -> 'consent') is distinct from (old.application -> 'consent')
             then 1 else 0 end;
  end if;
  return new;
end $$;
revoke all on function app.tg_form_consent_revision() from public, anon, authenticated, service_role;

-- BEFORE row triggers fire in name order: the guard (its double underscore sorts first)
-- refuses before any other BEFORE trigger's work runs, as 0066 gives every registry table.
drop trigger if exists form_settings__release_guard on public.form_settings;
create trigger form_settings__release_guard before insert or update or delete on public.form_settings
  for each row execute function app.tg_release_guard();
drop trigger if exists form_settings_actor on public.form_settings;
create trigger form_settings_actor before insert or update on public.form_settings
  for each row execute function app.tg_set_actor();
drop trigger if exists form_settings_consent_revision on public.form_settings;
create trigger form_settings_consent_revision before insert or update on public.form_settings
  for each row execute function app.tg_form_consent_revision();
drop trigger if exists form_settings_updated_at on public.form_settings;
create trigger form_settings_updated_at before update on public.form_settings
  for each row execute function app.tg_set_updated_at();
drop trigger if exists form_settings_version on public.form_settings;
create trigger form_settings_version before update on public.form_settings
  for each row execute function app.tg_bump_version();
-- History, keyed by the tenant (a singleton, 0038).
drop trigger if exists form_settings_snapshot on public.form_settings;
create trigger form_settings_snapshot after insert or update on public.form_settings
  for each row execute function app.tg_snapshot_singleton('form_settings');
-- What a release changes (0051), built as 0051's loop builds it: the generated columns read
-- from the catalog (none), keyed by tenant_id.
do $$
declare
  v_generated text;
begin
  select coalesce(string_agg(a.attname::text, ',' order by a.attnum), '') into v_generated
    from pg_attribute a
   where a.attrelid = 'public.form_settings'::regclass
     and a.attnum > 0 and not a.attisdropped and a.attgenerated = 's';
  execute 'drop trigger if exists form_settings_release_capture on public.form_settings';
  execute format('create trigger form_settings_release_capture after insert or update or delete '
                 'on public.form_settings for each row execute function '
                 'app.tg_release_capture(%L, %L, %L)', 'form_settings', 'tenant_id', v_generated);
end $$;

-- ═══ 7. The release registry ════════════════════════════════════════════════════════════
-- Registry contract #4 (releases.md §1.3): staged once releases switch on (P-3). Authors are
-- the holders of settings.general (P-2); never removed by a release. consent_revision is the
-- database's, so it is in neither list (supabase/tests/snapshot_coverage.test.sql classifies
-- it as computed). One row per line group, parsed by tests/fixtures/releaseRegistry.ts: keep
-- the shape.
insert into app.release_entities
  (entity_type, table_name, key_column, area, author_roles, delete_roles, columns,
   deferred_columns, unique_flags, exempt_columns, apply_order, has_status, publish_flag)
values
  ('form_settings', 'form_settings', 'tenant_id', 'settings', '{admin,developer}', '{}',
   '{inquiry,application}',
   '{}', '{}', '{}', 110, false, null)
on conflict (entity_type) do nothing;

-- ═══ 8. The consent version an application stores ════════════════════════════════════════
-- Widened, never narrowed: every stored value (a notice date) still passes.
alter table public.job_applications drop constraint if exists job_applications_consent_version_check;
alter table public.job_applications add constraint job_applications_consent_version_check
  check (consent_version ~ '^\d{4}-\d{2}-\d{2}(\.r[1-9][0-9]{0,8})?$');

-- ═══ Postconditions ═══════════════════════════════════════════════════════════════════════
-- Each block says what it checks. Expressions are read as pg_get_expr prints them.
do $$
declare
  v_bad text;
  v_want text[];
  v_got text[];
  v_tenant_first constant text :=
    '^\((\(tenant_id = (app\.)?effective_tenant_id\(\)\) AND .+|tenant_id = (app\.)?effective_tenant_id\(\))\)$';
  v_tenant constant text := '\(tenant_id = (app\.)?effective_tenant_id\(\)\)';
  r text;
  pr text;
begin
  -- ---- 1. RLS enabled and forced --------------------------------------------------------
  if not (select relrowsecurity and relforcerowsecurity from pg_class
           where oid = 'public.form_settings'::regclass) then
    raise exception 'E8: public.form_settings is not ENABLE + FORCE row level security';
  end if;

  -- ---- 2. The exact policy set ----------------------------------------------------------
  v_want := array[
    'form_settings_insert INSERT PERMISSIVE {authenticated}',
    'form_settings_live_insert INSERT RESTRICTIVE {authenticated}',
    'form_settings_live_update UPDATE RESTRICTIVE {authenticated}',
    'form_settings_read SELECT PERMISSIVE {public}',
    'form_settings_staff_columns SELECT RESTRICTIVE {authenticated}',
    'form_settings_update UPDATE PERMISSIVE {authenticated}'];
  select array_agg(format('%s %s %s %s', policyname, cmd, permissive, roles) order by policyname)
    into v_got
    from pg_policies where schemaname = 'public' and tablename = 'form_settings';
  if v_got is distinct from v_want then
    raise exception 'E8: form_settings policies are %, expected %', v_got, v_want;
  end if;

  -- ---- 3. The tenant predicate is the first conjunct of every USING and WITH CHECK -------
  select string_agg(policyname, ', ') into v_bad
    from pg_policies
   where schemaname = 'public' and tablename = 'form_settings'
     and ((qual is not null and qual !~ v_tenant_first)
          or (with_check is not null and with_check !~ v_tenant_first)
          or coalesce(qual, with_check) is null);
  if v_bad is not null then
    raise exception 'E8: form_settings policies that do not lead with the tenant predicate: %', v_bad;
  end if;
  -- The read is the tenant fence alone, and the non-staff block is (tenant, is_staff).
  if (select qual from pg_policies where schemaname = 'public' and tablename = 'form_settings'
        and policyname = 'form_settings_read') !~ ('^' || v_tenant || '$')
     or (select count(*) from pg_policies
          where schemaname = 'public' and tablename = 'form_settings'
            and policyname = 'form_settings_staff_columns' and with_check is null
            and qual ~ ('^\(' || v_tenant || ' AND (app\.)?is_staff\(\)\)$')) <> 1 then
    raise exception 'E8: form_settings_read or form_settings_staff_columns is not as written';
  end if;
  -- Every write policy names settings.general's helper; the live ones read the live role.
  select string_agg(policyname, ', ') into v_bad
    from pg_policies
   where schemaname = 'public' and tablename = 'form_settings' and cmd in ('INSERT', 'UPDATE')
     and (coalesce(with_check, '') !~ 'role_general_settings'
          or (policyname like '%live%' and with_check !~ 'live_role\(\)')
          -- current_role is a keyword: the catalog prints it quoted.
          or (policyname not like '%live%' and with_check !~ 'current_role"?\(\)'));
  if v_bad is not null then
    raise exception 'E8: form_settings write policies that do not check settings.general as written: %', v_bad;
  end if;

  -- ---- 4. Privileges, exactly ---------------------------------------------------------------
  foreach r in array array['public', 'anon'] loop
    if has_table_privilege(r::name, 'public.form_settings',
                           'select, insert, update, delete, truncate, references, trigger')
       or (case when current_setting('server_version_num')::int >= 170000
                then has_table_privilege(r::name, 'public.form_settings', 'maintain')
                else false end) then
      raise exception 'E8: % holds a table privilege on public.form_settings', r;
    end if;
  end loop;
  foreach pr in array array['select', 'insert', 'update'] loop
    if not has_table_privilege('authenticated', 'public.form_settings', pr) then
      raise exception 'E8: authenticated lacks % on public.form_settings', pr;
    end if;
  end loop;
  foreach pr in array array['select', 'insert', 'update', 'delete'] loop
    if not has_table_privilege('service_role', 'public.form_settings', pr) then
      raise exception 'E8: service_role lacks % on public.form_settings', pr;
    end if;
  end loop;
  if has_table_privilege('authenticated', 'public.form_settings', 'delete') then
    raise exception 'E8: authenticated holds DELETE on public.form_settings';
  end if;
  foreach r in array array['authenticated', 'service_role'] loop
    -- CASE, not AND: the privilege functions refuse MAINTAIN before PostgreSQL 17 (CI runs 15).
    if has_table_privilege(r::name, 'public.form_settings', 'truncate, references, trigger')
       or (case when current_setting('server_version_num')::int >= 170000
                then has_table_privilege(r::name, 'public.form_settings', 'maintain')
                else false end) then
      raise exception 'E8: % holds TRUNCATE, REFERENCES, TRIGGER or MAINTAIN on public.form_settings', r;
    end if;
  end loop;
  -- Column level: anon SELECTs exactly four columns and nothing else; PUBLIC nothing; no
  -- column-level grant to authenticated or service_role (their access is the table grant).
  select array_agg(a.attname::text order by a.attname::text collate "C") into v_got
    from pg_attribute a
   where a.attrelid = 'public.form_settings'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('anon', a.attrelid, a.attnum, 'select');
  if v_got is distinct from array['application', 'consent_revision', 'inquiry', 'tenant_id'] then
    raise exception 'E8: anon''s SELECT columns on form_settings are %', v_got;
  end if;
  if has_any_column_privilege('anon', 'public.form_settings', 'insert, update, references')
     or has_any_column_privilege('public', 'public.form_settings', 'select, insert, update, references') then
    raise exception 'E8: anon or PUBLIC holds a column privilege beyond anon''s SELECT';
  end if;
  select string_agg(format('%s.%s', g.grantee::regrole, a.attname), ', ') into v_bad
    from pg_attribute a
    cross join lateral aclexplode(a.attacl) g
   where a.attrelid = 'public.form_settings'::regclass and a.attnum > 0 and not a.attisdropped
     and a.attacl is not null
     and g.grantee in ('authenticated'::regrole, 'service_role'::regrole);
  if v_bad is not null then
    raise exception 'E8: column-level grants to authenticated or service_role: %', v_bad;
  end if;

  -- ---- 5. The triggers: exactly these seven, with their functions and timing --------------
  -- tgtype bits: 1 ROW, 2 BEFORE, 4 INSERT, 8 DELETE, 16 UPDATE.
  select array_agg(format('%s %s %s', t.tgname, t.tgtype, t.tgfoid::regprocedure)
                   order by t.tgname collate "C") into v_got
    from pg_trigger t
   where t.tgrelid = 'public.form_settings'::regclass and not t.tgisinternal and t.tgenabled = 'O';
  v_want := array[
    'form_settings__release_guard 31 app.tg_release_guard()',
    'form_settings_actor 23 app.tg_set_actor()',
    'form_settings_consent_revision 23 app.tg_form_consent_revision()',
    'form_settings_release_capture 29 app.tg_release_capture()',
    'form_settings_snapshot 21 app.tg_snapshot_singleton()',
    'form_settings_updated_at 19 app.tg_set_updated_at()',
    'form_settings_version 19 app.tg_bump_version()'];
  if v_got is distinct from v_want then
    raise exception 'E8: form_settings triggers are %, expected %', v_got, v_want;
  end if;
  if not exists (select 1 from pg_trigger t
                  where t.tgrelid = 'public.form_settings'::regclass
                    and t.tgname = 'form_settings_snapshot'
                    and t.tgnargs = 1 and t.tgargs = convert_to('form_settings', 'UTF8') || '\x00'::bytea)
     or not exists (select 1 from pg_trigger t
                     where t.tgrelid = 'public.form_settings'::regclass
                       and t.tgname = 'form_settings_release_capture' and t.tgnargs = 3
                       and t.tgargs = convert_to('form_settings', 'UTF8') || '\x00'::bytea
                                      || convert_to('tenant_id', 'UTF8') || '\x00'::bytea
                                      || '\x00'::bytea) then
    raise exception 'E8: the snapshot or the capture trigger has the wrong arguments';
  end if;

  -- ---- 6. The two functions: IMMUTABLE / INVOKER, search_path '', who may call them --------
  if not exists (select 1 from pg_proc f
                  where f.oid = 'app.form_copy_ok(jsonb)'::regprocedure
                    and f.provolatile = 'i' and not f.prosecdef
                    and f.proconfig = array['search_path=""'])
     or not exists (select 1 from pg_proc f
                     where f.oid = 'app.tg_form_consent_revision()'::regprocedure
                       and not f.prosecdef and f.proconfig = array['search_path=""']) then
    raise exception 'E8: app.form_copy_ok or app.tg_form_consent_revision is not as written';
  end if;
  if not has_function_privilege('authenticated', 'app.form_copy_ok(jsonb)', 'execute')
     or not has_function_privilege('service_role', 'app.form_copy_ok(jsonb)', 'execute')
     or has_function_privilege('anon', 'app.form_copy_ok(jsonb)', 'execute')
     or has_function_privilege('public', 'app.form_copy_ok(jsonb)', 'execute') then
    raise exception 'E8: app.form_copy_ok must be executable by authenticated and service_role only';
  end if;
  foreach r in array array['public', 'anon', 'authenticated', 'service_role'] loop
    if has_function_privilege(r::name, 'app.tg_form_consent_revision()', 'execute') then
      raise exception 'E8: % can execute app.tg_form_consent_revision()', r;
    end if;
  end loop;
  -- And the CHECK says what it means (one that admits everything would pass every test above).
  if not app.form_copy_ok('{}')
     or not app.form_copy_ok('{"button":{"en":"Send","ar":"أرسل"},"order":["name"]}')
     or app.form_copy_ok('[]')
     or app.form_copy_ok('"x"')
     or app.form_copy_ok('{"button":{"en":"<b>Send</b>","ar":"أرسل"}}')
     or app.form_copy_ok('{"fields":{"name":{"label":{"en":"a >","ar":"ب"}}}}')
     or app.form_copy_ok(jsonb_build_object('button', jsonb_build_object('en', E'Se\nnd', 'ar', 'x')))
     or app.form_copy_ok(jsonb_build_object('x', repeat('a', 16400))) then
    raise exception 'E8: app.form_copy_ok admits a shape it must refuse, or refuses a good one';
  end if;

  -- ---- 7. The registry row, exactly, and its columns real ---------------------------------
  if not exists (select 1 from app.release_entities e
                  where e.entity_type = 'form_settings' and e.table_name = 'form_settings'
                    and e.key_column = 'tenant_id' and e.area = 'settings'
                    and e.author_roles = array['admin', 'developer']
                    and e.delete_roles = '{}'
                    and e.columns = array['inquiry', 'application']
                    and e.deferred_columns = '{}' and e.unique_flags = '{}'
                    and e.exempt_columns = '{}' and e.apply_order = 110 and not e.has_status
                    and e.publish_flag is null) then
    raise exception 'E8: the form_settings registry row is missing or differs';
  end if;

  -- ---- 8. The release guard: still first on every registry table (0066's postcondition 3) --
  select string_agg(e.table_name, ', ' order by e.table_name) into v_bad
    from app.release_entities e
   where (select count(*) from pg_trigger tg
           where tg.tgrelid = format('public.%I', e.table_name)::regclass and not tg.tgisinternal
             and tg.tgfoid = 'app.tg_release_guard()'::regprocedure
             and tg.tgname = e.table_name || '__release_guard'
             and tg.tgtype = 31 and tg.tgenabled = 'O' and tg.tgnargs = 0) <> 1
      or (select tg.tgname from pg_trigger tg
           where tg.tgrelid = format('public.%I', e.table_name)::regclass and not tg.tgisinternal
             and tg.tgtype & 1 = 1 and tg.tgtype & 2 = 2
           order by tg.tgname collate "C" limit 1) is distinct from e.table_name || '__release_guard';
  if v_bad is not null then
    raise exception 'E8: registry tables without exactly one guard firing first: %', v_bad;
  end if;

  -- ---- 9. The widened consent version CHECK: one, and it reads as written ------------------
  if (select count(*) from pg_constraint c
       where c.conrelid = 'public.job_applications'::regclass and c.contype = 'c'
         and pg_get_constraintdef(c.oid) like '%consent_version%') <> 1
     or not exists (select 1 from pg_constraint c
                     where c.conrelid = 'public.job_applications'::regclass
                       and c.conname = 'job_applications_consent_version_check'
                       and pg_get_constraintdef(c.oid) like '%\.r[1-9][0-9]{0,8})?$%') then
    raise exception 'E8: job_applications'' consent_version CHECK is not the widened one';
  end if;

  -- ---- 10. Releases are still off everywhere (0038, 0051, 0062, 0066) ----------------------
  if exists (select 1 from app.release_tenants) then
    raise exception 'E8: releases must stay switched off (app.release_tenants is not empty)';
  end if;
end $$;
