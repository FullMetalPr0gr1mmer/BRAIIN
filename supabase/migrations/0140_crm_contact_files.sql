-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 0140 — CRM contact files (Admin v2 C16, crm.md §12 "Files"). Forward-only, EXPAND only.
-- HELD: the PR merges only after the owner's lawyer signs off the privacy-notice update (owner
-- item O-11) and after C5, C6, C7 and C8. The number is a placeholder: the merge train assigns
-- it (scripts/renumber-migration.mjs). Depends on 0029 (the private-bucket pattern), 0033
-- (app.live_role), 0131 (crm_contacts, app.crm_touch, app.crm_contact_is_orphan), 0134 (the
-- orphan rule as restated with tasks) and 0129 (every staff-reachable table carries a
-- RESTRICTIVE live policy).
--
-- WHAT IT ADDS
--   1. crm.files, a new capability, Admin only (Developer none: owner default O-7; Sales none
--      unless C10b's design gives it), and its one SQL helper app.role_crm_files
--      (tests/authz/sqlHelpers.spec.ts holds it equal to ROLE_CAPS).
--   2. public.crm_contact_files: a file kept with a contact. The object lives in the PRIVATE
--      Storage bucket `crm-files` under `<tenant>/<contact>/<random>.<ext>`, never the
--      uploaded name (a name is personal data and an object path is not encrypted). Staff
--      holding crm.files read every column but the path (a column grant); nobody writes
--      through the API: the Worker's service-role doors add and remove (it alone stores and
--      deletes the object, which SQL cannot). RLS ENABLE + FORCE, the tenant predicate first,
--      a RESTRICTIVE live check.
--   3. The doors, SECURITY INVOKER, the service role's only, each checking the acting profile
--      live: public.crm_file_add (at most 20 files a contact, never a merge tombstone, the
--      path naming this tenant and contact) and public.crm_file_remove.
--   4. A file added is the contact's activity, as a note is (a definer trigger, app.crm_touch);
--      removing one is not. An auto-contact with a file is not an orphan
--      (app.crm_contact_is_orphan restated: 0134's copy plus the lines marked `-- C16`,
--      tests/lib/crmFilesSql.spec.ts).
--   5. public.crm_file_orphans: objects in the bucket no row names (a contact purged by
--      retention takes its rows by cascade; an upload whose row was never written), for the
--      Worker's sweep (src/lib/crm/fileOrphans.ts). The service role's only.
--   6. The bucket `crm-files`: private, ≤ 10 MiB, PDF, .docx, PNG, JPEG, WebP; a RESTRICTIVE
--      belt on storage.objects for anon and authenticated (0029's).
--
-- Production behaviour: none until C16's Worker deploys (no route reads or writes the table
-- before it). Rule 5: no existing table, column, grant or policy changes; the orphan rule
-- answers false for more contacts only when a file exists, and none does before the deploy.
-- ─────────────────────────────────────────────────────────────────────────────────────────

-- A busy table fails the push instead of queueing behind it (0041's reason): this adds a
-- foreign key to crm_contacts (its referenced side is locked).
set local lock_timeout = '5s';

-- ═══ 1. The capability helper ═══════════════════════════════════════════════════════════
create or replace function app.role_crm_files(r text) returns boolean
  language sql immutable
as $$ select coalesce(r in ('admin'), false) $$;  -- crm.files
revoke all on function app.role_crm_files(text) from public, anon, authenticated, service_role;
grant execute on function app.role_crm_files(text) to authenticated, service_role;

-- ═══ 2. The table ═════════════════════════════════════════════════════════════════════════
create table public.crm_contact_files (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  contact_id uuid not null,
  -- `<tenant>/<contact at upload>/<random>.<ext>` in the `crm-files` bucket: the Worker's
  -- shape only, and always under the row's own tenant.
  object_path text not null
    check (object_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|docx|png|jpg|webp)$'),
  -- What staff see. Never part of the path.
  name text not null
    check (char_length(btrim(name)) between 1 and 120 and name !~ '[[:cntrl:]/\\]'),
  -- Decided by the bytes (src/lib/crm/fileSniff.ts), never by the browser.
  content_type text not null check (content_type in (
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/png', 'image/jpeg', 'image/webp')),
  bytes int not null check (bytes between 1 and 10485760),
  created_at timestamptz not null default now(),
  -- The person who added it (the door's actor). Never client-chosen.
  created_by uuid,
  constraint crm_contact_files_contact_fk foreign key (tenant_id, contact_id)
    references public.crm_contacts (tenant_id, id) on delete cascade,
  constraint crm_contact_files_tenant_path
    check (starts_with(object_path, tenant_id::text || '/')),
  constraint crm_contact_files_kind_ext check (
    case content_type
      when 'application/pdf' then object_path like '%.pdf'
      when 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' then object_path like '%.docx'
      when 'image/png' then object_path like '%.png'
      when 'image/jpeg' then object_path like '%.jpg'
      when 'image/webp' then object_path like '%.webp'
    end)
);
-- One object, one row: removing one file can never delete another's object, and the orphan
-- sweep looks a path up by this index.
create unique index crm_contact_files_object_key on public.crm_contact_files (object_path);
-- The card (newest first) and the foreign key's columns.
create index crm_contact_files_contact_idx
  on public.crm_contact_files (tenant_id, contact_id, created_at desc, id);
alter table public.crm_contact_files enable row level security;
alter table public.crm_contact_files force row level security;

-- ═══ 3. Activity ══════════════════════════════════════════════════════════════════════════
-- A file a person adds is the contact's activity, as a note is (0131's note trigger). A
-- definer: app.crm_touch is executable by no API role.
create or replace function app.tg_crm_contact_file_activity() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  perform app.crm_touch(new.tenant_id, new.contact_id, new.created_at);
  return null;
end $$;
revoke all on function app.tg_crm_contact_file_activity() from public, anon, authenticated, service_role;
create trigger crm_contact_files_activity after insert on public.crm_contact_files
  for each row execute function app.tg_crm_contact_file_activity();

-- ═══ 4. Policies (crm.md §3.4) ════════════════════════════════════════════════════════════
create policy crm_contact_files_read on public.crm_contact_files for select to authenticated
  using (tenant_id = app.effective_tenant_id() and app.role_crm_files(app.current_role()));
create policy crm_contact_files_live on public.crm_contact_files as restrictive for all to authenticated
  using (tenant_id = app.effective_tenant_id() and app.role_crm_files((select app.live_role())))
  with check (tenant_id = app.effective_tenant_id() and app.role_crm_files((select app.live_role())));

-- ═══ 5. Grants, stated (P-14: both Supabase regimes) ══════════════════════════════════════
revoke all on public.crm_contact_files from public, anon, authenticated, service_role;
grant select (id, tenant_id, contact_id, name, content_type, bytes, created_at, created_by)
  on public.crm_contact_files to authenticated;
grant select, insert, delete on public.crm_contact_files to service_role;

-- ═══ 6. The doors ═════════════════════════════════════════════════════════════════════════
-- Who may add or remove a file for a contact, read now (the token may be an hour old): an
-- active, unlocked profile of the tenant whose role holds crm.files and crm.contacts. A
-- definer, because profiles' own RLS would hide the row; the service role's only.
create or replace function app.crm_files_actor_ok(p_tenant uuid, p_actor uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles p
     where p.id = p_actor
       and p.tenant_id = p_tenant
       and p.is_active
       and (p.locked_until is null or p.locked_until <= now())
       and app.role_crm_files(p.role::text)
       and app.role_crm_contacts(p.role::text))
$$;
revoke all on function app.crm_files_actor_ok(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function app.crm_files_actor_ok(uuid, uuid) to service_role;

-- How many files one contact keeps (a ceiling on what one person's record can hold).
create or replace function app.crm_files_cap() returns int
  language sql immutable set search_path = '' as $$ select 20 $$;
revoke all on function app.crm_files_cap() from public, anon, authenticated, service_role;
grant execute on function app.crm_files_cap() to service_role;

-- A file stored by the Worker (the object is already in the bucket): the row, or a refusal
-- the Worker answers by removing the object again. p_file: {id, object_path, name,
-- content_type, bytes}; anything else is 22023. Answers the row's safe columns.
create or replace function public.crm_file_add(p_tenant uuid, p_contact uuid, p_file jsonb,
                                               p_actor uuid)
  returns jsonb
  language plpgsql volatile security invoker set search_path = '' as $$
declare
  v_id uuid;
  v_path text;
  v_n int;
  r public.crm_contact_files;
begin
  if p_tenant is null or p_contact is null or p_actor is null
     or p_file is null or jsonb_typeof(p_file) <> 'object' then
    raise exception using errcode = '22023', message = 'crm_file_add: a tenant, a contact, a file and an actor are required';
  end if;
  if exists (select 1 from jsonb_object_keys(p_file) k
              where k not in ('id', 'object_path', 'name', 'content_type', 'bytes')) then
    raise exception using errcode = '22023', message = 'crm_file_add: unknown key';
  end if;
  if not app.crm_files_actor_ok(p_tenant, p_actor) then
    raise exception using errcode = '42501', message = 'crm_file_add: this person may not add files';
  end if;
  begin
    v_id := (p_file ->> 'id')::uuid;
  exception when others then
    raise exception using errcode = '22023', message = 'crm_file_add: the id is not a uuid';
  end;
  v_path := p_file ->> 'object_path';
  if v_id is null or v_path is null
     or not starts_with(v_path, p_tenant::text || '/' || p_contact::text || '/') then
    raise exception using errcode = '22023', message = 'crm_file_add: the path must name this tenant and contact';
  end if;
  -- One writer per contact: the count and the insert see the same files.
  perform pg_advisory_xact_lock(hashtextextended('crm-files:' || p_contact::text, 0));
  if not exists (select 1 from public.crm_contacts c
                  where c.tenant_id = p_tenant and c.id = p_contact and c.merged_into is null) then
    raise exception using errcode = 'P0002', message = 'crm_file_add: no such contact';
  end if;
  select count(*) into v_n from public.crm_contact_files f
   where f.tenant_id = p_tenant and f.contact_id = p_contact;
  if v_n >= app.crm_files_cap() then
    raise exception using errcode = '23514', message = 'crm_contact_files_cap: a contact keeps up to 20 files',
      constraint = 'crm_contact_files_cap';
  end if;
  insert into public.crm_contact_files (id, tenant_id, contact_id, object_path, name, content_type,
                                        bytes, created_by)
  values (v_id, p_tenant, p_contact, v_path, p_file ->> 'name', p_file ->> 'content_type',
          (p_file ->> 'bytes')::int, p_actor)
  returning * into r;
  return jsonb_build_object('id', r.id, 'contact_id', r.contact_id, 'name', r.name,
                            'content_type', r.content_type, 'bytes', r.bytes,
                            'created_at', r.created_at, 'created_by', r.created_by);
end $$;
revoke all on function public.crm_file_add(uuid, uuid, jsonb, uuid) from public, anon, authenticated, service_role;
grant execute on function public.crm_file_add(uuid, uuid, jsonb, uuid) to service_role;

-- A file's row, once the Worker has removed its object (object first: if the object cannot
-- be removed the row stays, so the removal can be tried again). Answers the path removed.
create or replace function public.crm_file_remove(p_tenant uuid, p_contact uuid, p_file uuid,
                                                  p_actor uuid)
  returns text
  language plpgsql volatile security invoker set search_path = '' as $$
declare
  v_path text;
begin
  if p_tenant is null or p_contact is null or p_file is null or p_actor is null then
    raise exception using errcode = '22023', message = 'crm_file_remove: a tenant, a contact, a file and an actor are required';
  end if;
  if not app.crm_files_actor_ok(p_tenant, p_actor) then
    raise exception using errcode = '42501', message = 'crm_file_remove: this person may not remove files';
  end if;
  delete from public.crm_contact_files f
   where f.tenant_id = p_tenant and f.contact_id = p_contact and f.id = p_file
  returning f.object_path into v_path;
  if v_path is null then
    raise exception using errcode = 'P0002', message = 'crm_file_remove: no such file';
  end if;
  return v_path;
end $$;
revoke all on function public.crm_file_remove(uuid, uuid, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.crm_file_remove(uuid, uuid, uuid, uuid) to service_role;

-- ═══ 7. The orphan rule, restated ═════════════════════════════════════════════════════════
-- 0134's copy plus the lines marked `-- C16`: an auto-contact with a file a person added is
-- not an orphan (as a note, a task or a channel a person added keeps it).
create or replace function app.crm_contact_is_orphan(p_tenant uuid, p_contact uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.crm_contacts c
     where c.tenant_id = p_tenant and c.id = p_contact
       and c.created_by is null and not c.staff_edited and not c.is_starred
       and not exists (select 1 from public.leads l
                        where l.tenant_id = c.tenant_id and l.contact_id = c.id
                          and l.contact_link is distinct from 'phone')
       and not exists (select 1 from public.crm_contact_notes n
                        where n.tenant_id = c.tenant_id and n.contact_id = c.id)
       and not exists (select 1 from public.crm_tasks tk  -- C8
                        where tk.tenant_id = c.tenant_id and tk.contact_id = c.id)  -- C8
       and not exists (select 1 from public.crm_contact_files fl  -- C16
                        where fl.tenant_id = c.tenant_id and fl.contact_id = c.id)  -- C16
       and not exists (select 1 from public.crm_contact_channels ch
                        where ch.tenant_id = c.tenant_id and ch.contact_id = c.id
                          and ch.source <> 'lead'))
$$;
revoke all on function app.crm_contact_is_orphan(uuid, uuid) from public, anon, authenticated, service_role;

-- ═══ 8. Orphaned objects ══════════════════════════════════════════════════════════════════
-- Objects in the bucket no row names: a contact deleted by retention (app.purge_crm, pg_cron)
-- takes its rows by cascade, and SQL cannot delete a Storage object; an upload whose row was
-- never written (the Worker stopped between the two, and its compensating removal failed).
-- Only the Worker's own shape, and only older than the grace, so an upload whose row is still
-- being written is never one. The Worker removes them through the Storage API. Service role
-- only; INVOKER; PL/pgSQL, so `storage` is resolved when it runs (0029's reason).
create or replace function public.crm_file_orphans(p_older_than_minutes int, p_limit int)
returns table (object_name text)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if p_older_than_minutes is null or p_older_than_minutes < 0
     or p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception using errcode = '22023', message = 'crm_file_orphans: argument out of range';
  end if;
  return query
    select o.name::text
      from storage.objects o
     where o.bucket_id = 'crm-files'
       and o.name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|docx|png|jpg|webp)$'
       and o.created_at < now() - make_interval(mins => p_older_than_minutes)
       and not exists (select 1 from public.crm_contact_files f where f.object_path = o.name)
     order by o.created_at
     limit p_limit;
end
$$;
revoke all on function public.crm_file_orphans(int, int) from public, anon, authenticated, service_role;
grant execute on function public.crm_file_orphans(int, int) to service_role;

-- ═══ 9. The bucket ════════════════════════════════════════════════════════════════════════
-- Guarded: bare Postgres has no `storage` schema. On Supabase it always exists, so this
-- branch always runs there, and the postcondition below refuses a bucket left public.
do $$
begin
  if to_regclass('storage.buckets') is null then
    raise warning 'C16: storage.buckets absent, skipping the crm-files bucket (expected ONLY outside Supabase)';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('crm-files', 'crm-files', false, 10485760,
          array['application/pdf',
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                'image/png', 'image/jpeg', 'image/webp'])
  on conflict (id) do update
    set public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;

  -- The belt: a RESTRICTIVE policy no permissive storage policy added later (for some other
  -- bucket) can widen to this one. If the migration role may not add it, the bucket is still
  -- unreachable to anon and authenticated (no policy names it): say so, do not fail the push.
  begin
    execute 'drop policy if exists crm_files_bucket_service_only on storage.objects';
    execute $p$
      create policy crm_files_bucket_service_only on storage.objects
        as restrictive for all to anon, authenticated
        using (bucket_id <> 'crm-files')
        with check (bucket_id <> 'crm-files')
    $p$;
  exception when insufficient_privilege then
    raise warning 'C16: not permitted to add the storage.objects belt policy; the private bucket with no policy naming it still denies anon and authenticated';
  end;
end $$;

-- ═══ 10. Postconditions (P-14: under both Supabase grant regimes) ═════════════════════════
do $$
declare
  v_maintain boolean := current_setting('server_version_num')::int >= 170000;
  v_got text[];
  v_fn text;
  r text;
begin
  -- ---- RLS and policies ---------------------------------------------------------------------
  if not exists (select 1 from pg_class
                  where oid = 'public.crm_contact_files'::regclass and relrowsecurity and relforcerowsecurity) then
    raise exception 'C16: crm_contact_files must have RLS enabled and forced';
  end if;
  select array_agg(policyname::text || ':' || cmd || ':' || permissive order by policyname collate "C")
    into v_got
    from pg_policies where schemaname = 'public' and tablename = 'crm_contact_files';
  if v_got is distinct from array['crm_contact_files_live:ALL:RESTRICTIVE',
                                  'crm_contact_files_read:SELECT:PERMISSIVE'] then
    raise exception 'C16: the crm_contact_files policies are %', v_got;
  end if;
  if exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = 'crm_contact_files'
                and (roles <> array['authenticated']::name[]
                     or qual !~ '^\(\(tenant_id = (app\.)?effective_tenant_id\(\)\) AND (app\.)?role_crm_files\('
                     or (with_check is not null
                         and with_check !~ '^\(\(tenant_id = (app\.)?effective_tenant_id\(\)\) AND (app\.)?role_crm_files\('))) then
    raise exception 'C16: a crm_contact_files policy is not TO authenticated, or does not lead with the tenant predicate and the crm.files helper';
  end if;
  if not exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'crm_contact_files'
                    and policyname = 'crm_contact_files_live'
                    and qual ~ 'live_role\(\)' and with_check ~ 'live_role\(\)') then
    raise exception 'C16: crm_contact_files_live lacks the live check';
  end if;

  -- ---- Grants -------------------------------------------------------------------------------
  foreach r in array array['public', 'anon'] loop
    if has_table_privilege(r::name, 'public.crm_contact_files',
                           'select, insert, update, delete, truncate, references, trigger')
       or has_any_column_privilege(r::name, 'public.crm_contact_files', 'select, insert, update, references')
       or (case when v_maintain then has_table_privilege(r::name, 'public.crm_contact_files', 'maintain')
                else false end) then
      raise exception 'C16: % holds a privilege on crm_contact_files', r;
    end if;
  end loop;
  foreach r in array array['authenticated', 'service_role'] loop
    if has_table_privilege(r::name, 'public.crm_contact_files', 'update, truncate, references, trigger')
       or has_any_column_privilege(r::name, 'public.crm_contact_files', 'update, references')
       or (case when v_maintain then has_table_privilege(r::name, 'public.crm_contact_files', 'maintain')
                else false end) then
      raise exception 'C16: % holds UPDATE, TRUNCATE, REFERENCES, TRIGGER or MAINTAIN on crm_contact_files', r;
    end if;
  end loop;
  if has_table_privilege('authenticated', 'public.crm_contact_files', 'select')
     or has_table_privilege('authenticated', 'public.crm_contact_files', 'insert')
     or has_any_column_privilege('authenticated', 'public.crm_contact_files', 'insert')
     or has_table_privilege('authenticated', 'public.crm_contact_files', 'delete') then
    raise exception 'C16: authenticated must read named columns only, and never insert or delete';
  end if;
  select coalesce(array_agg(a.attname::text order by a.attname::text collate "C"), '{}') into v_got
    from pg_attribute a
   where a.attrelid = 'public.crm_contact_files'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', a.attrelid, a.attnum, 'select');
  if v_got is distinct from array['bytes', 'contact_id', 'content_type', 'created_at', 'created_by',
                                  'id', 'name', 'tenant_id'] then
    raise exception 'C16: authenticated reads the crm_contact_files columns %', v_got;
  end if;
  if not has_table_privilege('service_role', 'public.crm_contact_files', 'select, insert, delete') then
    raise exception 'C16: the service role must hold SELECT, INSERT and DELETE on crm_contact_files';
  end if;

  -- ---- Functions ----------------------------------------------------------------------------
  -- The doors and the sweep's reader: INVOKER, a pinned search_path, the service role alone.
  foreach v_fn in array array['public.crm_file_add(uuid, uuid, jsonb, uuid)',
                              'public.crm_file_remove(uuid, uuid, uuid, uuid)',
                              'public.crm_file_orphans(integer, integer)'] loop
    if exists (select 1 from pg_proc where oid = v_fn::regprocedure and prosecdef) then
      raise exception 'C16: % must be SECURITY INVOKER', v_fn;
    end if;
    if has_function_privilege('anon', v_fn, 'execute')
       or has_function_privilege('authenticated', v_fn, 'execute')
       or not has_function_privilege('service_role', v_fn, 'execute')
       or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                   where p.oid = v_fn::regprocedure and a.grantee = 0) then
      raise exception 'C16: % must be executable by the service role alone', v_fn;
    end if;
  end loop;
  foreach v_fn in array array['app.crm_files_actor_ok(uuid, uuid)', 'app.crm_files_cap()'] loop
    if has_function_privilege('anon', v_fn, 'execute')
       or has_function_privilege('authenticated', v_fn, 'execute')
       or not has_function_privilege('service_role', v_fn, 'execute')
       or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                   where p.oid = v_fn::regprocedure and a.grantee = 0) then
      raise exception 'C16: % must be executable by the service role alone', v_fn;
    end if;
  end loop;
  if has_function_privilege('anon', 'app.role_crm_files(text)', 'execute')
     or not has_function_privilege('authenticated', 'app.role_crm_files(text)', 'execute')
     or not has_function_privilege('service_role', 'app.role_crm_files(text)', 'execute') then
    raise exception 'C16: app.role_crm_files must be executable by authenticated and the service role only';
  end if;
  -- The definers: an empty search_path, owned by a role that bypasses RLS, executable by no
  -- API role (a trigger and the definer doors of C5 call them).
  foreach v_fn in array array['app.tg_crm_contact_file_activity()',
                              'app.crm_contact_is_orphan(uuid, uuid)'] loop
    if not exists (select 1 from pg_proc f join pg_roles o on o.oid = f.proowner
                    where f.oid = v_fn::regprocedure and f.prosecdef
                      and (o.rolbypassrls or o.rolsuper)) then
      raise exception 'C16: % must be a definer owned by a role that bypasses RLS', v_fn;
    end if;
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if has_function_privilege(r::name, v_fn, 'execute') then
        raise exception 'C16: % can execute %', r, v_fn;
      end if;
    end loop;
  end loop;
  -- Every function this migration makes or restates pins its search_path, but the inlined
  -- capability helper (as every app.role_* helper).
  foreach v_fn in array array['app.tg_crm_contact_file_activity()', 'app.crm_contact_is_orphan(uuid, uuid)',
                              'app.crm_files_actor_ok(uuid, uuid)', 'app.crm_files_cap()',
                              'public.crm_file_add(uuid, uuid, jsonb, uuid)',
                              'public.crm_file_remove(uuid, uuid, uuid, uuid)',
                              'public.crm_file_orphans(integer, integer)'] loop
    if not exists (select 1 from pg_proc where oid = v_fn::regprocedure
                    and proconfig is not null and 'search_path=""' = any (proconfig)) then
      raise exception 'C16: % does not pin search_path to empty', v_fn;
    end if;
  end loop;

  -- ---- The trigger and the bucket -----------------------------------------------------------
  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.crm_contact_files'::regclass
                    and tgname = 'crm_contact_files_activity' and not tgisinternal) then
    raise exception 'C16: the activity trigger is missing';
  end if;
  if to_regclass('storage.buckets') is not null then
    if not exists (select 1 from storage.buckets where id = 'crm-files' and public = false) then
      raise exception 'C16: the crm-files bucket is missing or public';
    end if;
  end if;
end $$;
