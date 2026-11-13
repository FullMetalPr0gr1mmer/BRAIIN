-- ─────────────────────────────────────────────────────────────────────────────────────────
-- C15 — CSV import of contacts (Admin v2 C15, crm.md §12 "Import CSV"). Forward-only, EXPAND
-- only. HELD with C5 to C8: the PR merges only after C5 (the contacts schema), C6 (the
-- contacts API), C7, C8 and the C7 + C8 integration, which merge after the owner's lawyer signs
-- off the privacy-notice update (owner item O-11, register L-2 and L-8). The number is a
-- placeholder: the merge train assigns it (scripts/renumber-migration.mjs). Depends on 0033
-- (app.live_role), 0041 (profiles (tenant_id, id)), 0129 (the live write rule) and C5's and
-- C6's migrations (crm_contacts, crm_contact_channels, app.crm_channels_ok,
-- app.crm_email_holder).
--
-- WHAT IT ADDS
--   1. crm.import, a new capability, Admin only, and its one SQL helper app.role_crm_import
--      (tests/authz/sqlHelpers.spec.ts holds it equal to ROLE_CAPS). crm.import implies
--      crm.contacts (matrix.spec): an import makes contacts.
--   2. public.crm_import_batches: one row per import, counts only (rows, bytes, added,
--      already contacts, repeated in the file, phone matches, not imported, the count per
--      lawful basis), its Admin, its status. No personal data. Read by crm.import holders
--      (RLS, tenant first, a RESTRICTIVE live check); written by the service role's doors.
--   3. public.crm_contact_imports: the lawful basis each imported contact came with (the
--      batch, the file's row number, the basis), one per contact, deleted with the contact
--      (retention, erasure). Read by crm.contacts holders (RLS, tenant first, live check).
--   4. Three service-role doors, SECURITY INVOKER, each checking the acting profile live
--      (app.crm_import_actor_ok): crm_import_open, crm_import_rows (at most 50 rows a call:
--      the Workers Free plan's 10 ms of CPU sets the piece; the batch's running totals hold the
--      5,000 rows and the byte ceiling), crm_import_finish. Dedupe by blind index: an e-mail
--      (or, with none, a phone) a contact holds already is skipped, under the link's own
--      per-address lock (app.crm_email_holder); a repeat of an earlier row of the same batch
--      says which row. Answers are counts and row numbers only. One open import per Admin
--      (a partial unique index, and the open door takes the Admin's lock first).
--   5. app.crm_import_sweep, hourly by pg_cron (crm-import-sweep): every import open longer
--      than two hours, in any tenant, is stopped and gets its outcome audit row (counts only,
--      no actor), so an abandoned import or one whose Admin was switched off mid-way is closed
--      and recorded.
--
-- Production behaviour: none until C15's Worker deploys (no existing object changes).
-- ─────────────────────────────────────────────────────────────────────────────────────────

-- A busy table fails the push instead of queueing behind it: this adds foreign keys to
-- crm_contacts and profiles (their referenced side is locked).
set local lock_timeout = '5s';

-- ═══ 1. The capability helper ═══════════════════════════════════════════════════════════
create or replace function app.role_crm_import(r text) returns boolean
  language sql immutable
as $$ select coalesce(r in ('admin'), false) $$;  -- crm.import
revoke all on function app.role_crm_import(text) from public, anon, authenticated, service_role;
grant execute on function app.role_crm_import(text) to authenticated, service_role;

-- ═══ 2. The tables ════════════════════════════════════════════════════════════════════════
create table public.crm_import_batches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default app.effective_tenant_id() references public.tenants (id) on delete cascade,
  -- The Admin who imported (the door's actor; null once their profile is gone).
  created_by uuid,
  status text not null default 'open' check (status in ('open', 'done', 'stopped')),
  -- The lawful-basis statement the Admin confirmed, by version (the screen's words).
  attestation text not null check (attestation in ('c15-v1')),
  -- What the browser said the file holds: at most 5,000 people and 2 MB (2 MiB).
  expected_rows int not null check (expected_rows between 1 and 5000),
  expected_bytes int not null check (expected_bytes between 1 and 2097152),
  -- The running totals the doors keep. The pieces are re-quoted CSV, so their bytes may be a
  -- little more than the file's: the ceiling is the file's limit and a quarter.
  rows_seen int not null default 0 check (rows_seen between 0 and 5000),
  bytes_seen int not null default 0 check (bytes_seen between 0 and 2621440),
  pieces int not null default 0 check (pieces between 0 and 5000),
  created_count int not null default 0 check (created_count >= 0),
  duplicate_count int not null default 0 check (duplicate_count >= 0),
  repeat_count int not null default 0 check (repeat_count >= 0),
  failed_count int not null default 0 check (failed_count >= 0),
  phone_match_count int not null default 0 check (phone_match_count >= 0),
  -- {consent, contract, legitimate_interest, legal_obligation}: counts.
  basis_counts jsonb not null default '{}'::jsonb
    check (jsonb_typeof(basis_counts) = 'object' and pg_column_size(basis_counts) < 512),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint crm_import_batches_tenant_id_id unique (tenant_id, id),
  constraint crm_import_batches_creator_fk foreign key (tenant_id, created_by)
    references public.profiles (tenant_id, id) on delete set null (created_by),
  constraint crm_import_batches_counts
    check (created_count + duplicate_count + repeat_count + failed_count = rows_seen
           and rows_seen <= expected_rows and phone_match_count <= created_count),
  constraint crm_import_batches_finished check ((status = 'open') = (finished_at is null))
);
-- The screen's recent imports, newest first.
create index crm_import_batches_recent_idx on public.crm_import_batches (tenant_id, created_at desc);
-- An Admin's open batch (the open door stops it); and the creator key's own index.
create index crm_import_batches_creator_idx on public.crm_import_batches (tenant_id, created_by, status);
-- One open import per Admin, held by the database: two opens at once from the same Admin
-- (two tabs) cannot both leave a batch open (the open door also serialises them, section 6).
-- A batch whose Admin is gone (created_by null) is outside it. Also the hourly sweep's path.
create unique index crm_import_batches_one_open on public.crm_import_batches (tenant_id, created_by)
  where status = 'open';
alter table public.crm_import_batches enable row level security;
alter table public.crm_import_batches force row level security;

create table public.crm_contact_imports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  contact_id uuid not null,
  batch_id uuid not null,
  -- The row in the file (the heading row is row 1), as a spreadsheet numbers it.
  row_number int not null check (row_number between 2 and 100000),
  basis text not null check (basis in ('consent', 'contract', 'legitimate_interest', 'legal_obligation')),
  created_at timestamptz not null default now(),
  constraint crm_contact_imports_one unique (tenant_id, contact_id),
  constraint crm_contact_imports_contact_fk foreign key (tenant_id, contact_id)
    references public.crm_contacts (tenant_id, id) on delete cascade,
  constraint crm_contact_imports_batch_fk foreign key (tenant_id, batch_id)
    references public.crm_import_batches (tenant_id, id) on delete cascade
);
create index crm_contact_imports_batch_idx on public.crm_contact_imports (tenant_id, batch_id);
alter table public.crm_contact_imports enable row level security;
alter table public.crm_contact_imports force row level security;

-- ═══ 3. Policies (crm.md §3.4): read only; nobody writes through the API ═════════════════
create policy crm_import_batches_read on public.crm_import_batches for select to authenticated
  using (tenant_id = app.effective_tenant_id() and app.role_crm_import(app.current_role()));
create policy crm_import_batches_live on public.crm_import_batches as restrictive for all to authenticated
  using (tenant_id = app.effective_tenant_id() and app.role_crm_import((select app.live_role())))
  with check (tenant_id = app.effective_tenant_id() and app.role_crm_import((select app.live_role())));
create policy crm_contact_imports_read on public.crm_contact_imports for select to authenticated
  using (tenant_id = app.effective_tenant_id() and app.role_crm_contacts(app.current_role()));
create policy crm_contact_imports_live on public.crm_contact_imports as restrictive for all to authenticated
  using (tenant_id = app.effective_tenant_id() and app.role_crm_contacts((select app.live_role())))
  with check (tenant_id = app.effective_tenant_id() and app.role_crm_contacts((select app.live_role())));

-- ═══ 4. Grants, stated (P-14: both Supabase regimes) ══════════════════════════════════════
revoke all on public.crm_import_batches from public, anon, authenticated, service_role;
revoke all on public.crm_contact_imports from public, anon, authenticated, service_role;
grant select on public.crm_import_batches to authenticated;
grant select on public.crm_contact_imports to authenticated;
grant select, insert, update on public.crm_import_batches to service_role;
grant select, insert on public.crm_contact_imports to service_role;

-- ═══ 5. The actor check ═══════════════════════════════════════════════════════════════════
-- The acting profile, live: of the tenant, active, unlocked, holding crm.import and
-- crm.contacts. A definer (the service role's doors call it; it reads profiles).
create or replace function app.crm_import_actor_ok(p_tenant uuid, p_actor uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles p
     where p.id = p_actor
       and p.tenant_id = p_tenant
       and p.is_active
       and (p.locked_until is null or p.locked_until <= now())
       and app.role_crm_import(p.role::text)
       and app.role_crm_contacts(p.role::text))
$$;
revoke all on function app.crm_import_actor_ok(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function app.crm_import_actor_ok(uuid, uuid) to service_role;

-- A batch's counts, as the doors answer them (no personal data).
create or replace function app.crm_import_counts(b public.crm_import_batches) returns jsonb
  language sql immutable set search_path = '' as $$
  select pg_catalog.jsonb_build_object(
    'id', b.id, 'status', b.status, 'rows', b.rows_seen, 'created', b.created_count,
    'duplicates', b.duplicate_count, 'repeats', b.repeat_count, 'failed', b.failed_count,
    'phone_matches', b.phone_match_count, 'bases', b.basis_counts)
$$;
revoke all on function app.crm_import_counts(public.crm_import_batches) from public, anon, authenticated, service_role;
grant execute on function app.crm_import_counts(public.crm_import_batches) to service_role;

-- ═══ 6. The doors (the service role only, INVOKER, the actor checked live) ════════════════
-- Open an import: the attestation's version, the file's declared rows and bytes. Any batch the
-- same Admin left open is stopped first (its counts in `stopped`, for its outcome audit row).
create or replace function public.crm_import_open(p_tenant uuid, p_actor uuid, p_rows int, p_bytes int,
                                                  p_attestation text)
  returns jsonb
  language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  v_id uuid;
  v_stopped jsonb;
begin
  if p_tenant is null or p_actor is null or p_rows is null or p_bytes is null or p_attestation is null then
    raise exception using errcode = '22023', message = 'crm_import_open: a tenant, an actor, rows, bytes and the attestation are required';
  end if;
  if not app.crm_import_actor_ok(p_tenant, p_actor) then
    raise exception using errcode = '42501', message = 'crm_import_open: this person may not import contacts';
  end if;
  if p_rows not between 1 and 5000 or p_bytes not between 1 and 2097152 then
    raise exception using errcode = '54000', message = 'crm_import_open: the file is over the import''s limits';
  end if;
  if p_attestation <> 'c15-v1' then
    raise exception using errcode = '22023', message = 'crm_import_open: an unknown attestation';
  end if;
  -- One open at a time per Admin: a second open from another tab waits here, then (its next
  -- statement reading afresh, READ COMMITTED) stops the batch the first one made.
  perform pg_advisory_xact_lock(hashtextextended('crm-import:' || p_tenant::text || ':' || p_actor::text, 0));
  with s as (
    update public.crm_import_batches b
       set status = 'stopped', finished_at = now(), updated_at = now()
     where b.tenant_id = p_tenant and b.created_by = p_actor and b.status = 'open'
    returning b as batch)
  select coalesce(jsonb_agg(app.crm_import_counts(s.batch) order by (s.batch).created_at), '[]'::jsonb)
    into v_stopped from s;
  insert into public.crm_import_batches (tenant_id, created_by, attestation, expected_rows, expected_bytes)
  values (p_tenant, p_actor, p_attestation, p_rows, p_bytes)
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'stopped', v_stopped);
end $$;
revoke all on function public.crm_import_open(uuid, uuid, int, int, text) from public, anon, authenticated, service_role;
grant execute on function public.crm_import_open(uuid, uuid, int, int, text) to service_role;

-- Import a piece: at most 50 rows the Worker has checked, encrypted and indexed, plus the
-- number it refused (p_failed) and the piece's bytes. Each row: {row, basis, display_name,
-- title, company_name, stage, locale, city, country, tags, channels} with at most one e-mail and
-- one phone. Answers {created, duplicates: [row], repeats: [{row, of}], phone_matches: [row],
-- refused: [row]}: numbers only.
create or replace function public.crm_import_rows(p_tenant uuid, p_batch uuid, p_actor uuid, p_rows jsonb,
                                                  p_failed int, p_bytes int)
  returns jsonb
  language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  v_batch public.crm_import_batches%rowtype;
  v_n int;
  r jsonb;
  v_row int;
  v_channels jsonb;
  v_email text;
  v_phone text;
  v_holder uuid;
  v_of int;
  v_id uuid;
  v_created int := 0;
  v_dups jsonb := '[]'::jsonb;
  v_repeats jsonb := '[]'::jsonb;
  v_matches jsonb := '[]'::jsonb;
  v_refused jsonb := '[]'::jsonb;
  v_bases jsonb := '{}'::jsonb;
begin
  if p_tenant is null or p_batch is null or p_actor is null or p_rows is null or p_failed is null
     or p_bytes is null then
    raise exception using errcode = '22023', message = 'crm_import_rows: a tenant, a batch, an actor, rows, a failed count and bytes are required';
  end if;
  if not app.crm_import_actor_ok(p_tenant, p_actor) then
    raise exception using errcode = '42501', message = 'crm_import_rows: this person may not import contacts';
  end if;
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception using errcode = '22023', message = 'crm_import_rows: rows must be an array';
  end if;
  v_n := jsonb_array_length(p_rows);
  if v_n + p_failed not between 1 and 50 or p_failed < 0 or p_bytes not between 1 and 262144 then
    raise exception using errcode = '22023', message = 'crm_import_rows: a piece holds 1 to 50 rows';
  end if;
  -- Every row's shape first: a bad one is the Worker's bug, and nothing is written.
  if exists (select 1 from jsonb_array_elements(p_rows) e
              where jsonb_typeof(e) <> 'object'
                 or exists (select 1 from jsonb_object_keys(e) k
                             where k not in ('row', 'basis', 'display_name', 'title', 'company_name', 'stage',
                                             'locale', 'city', 'country', 'tags', 'channels'))
                 or coalesce(e ->> 'row', '') !~ '^[0-9]{1,6}$'
                 or jsonb_typeof(coalesce(e -> 'tags', '[]'::jsonb)) <> 'array'
                 or not app.crm_channels_ok(coalesce(e -> 'channels', 'null'::jsonb))
                 or jsonb_array_length(e -> 'channels') not between 1 and 2
                 or (select count(*) from jsonb_array_elements(e -> 'channels') c where c ->> 'kind' = 'email') > 1
                 or (select count(*) from jsonb_array_elements(e -> 'channels') c where c ->> 'kind' = 'phone') > 1) then
    raise exception using errcode = '22023', message = 'crm_import_rows: a row has the wrong shape';
  end if;

  select * into v_batch from public.crm_import_batches b
   where b.tenant_id = p_tenant and b.id = p_batch and b.created_by = p_actor and b.status = 'open'
     and b.created_at > now() - interval '2 hours'
     for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'crm_import_rows: no such open import';
  end if;
  if v_batch.rows_seen + v_n + p_failed > v_batch.expected_rows
     or v_batch.bytes_seen + p_bytes > 2621440 then
    raise exception using errcode = '54000', message = 'crm_import_rows: the import is over its limits';
  end if;

  for r in select e from jsonb_array_elements(p_rows) e loop
    v_row := (r ->> 'row')::int;
    v_channels := r -> 'channels';
    select c ->> 'value_hmac' into v_email from jsonb_array_elements(v_channels) c where c ->> 'kind' = 'email';
    select c ->> 'value_hmac' into v_phone from jsonb_array_elements(v_channels) c where c ->> 'kind' = 'phone';
    v_holder := null;
    v_of := null;
    if v_email is not null then
      -- The link's own per-address lock: an import and an inquiry never both make one.
      v_holder := app.crm_email_holder(p_tenant, v_channels, null);
      if v_holder is not null then
        select ci.row_number into v_of from public.crm_contact_imports ci
         where ci.tenant_id = p_tenant and ci.contact_id = v_holder and ci.batch_id = p_batch;
      end if;
    else
      -- No e-mail: the phone decides, an earlier row of this import first.
      select ch.contact_id, ci.row_number into v_holder, v_of
        from public.crm_contact_channels ch
        left join public.crm_contact_imports ci
          on ci.tenant_id = ch.tenant_id and ci.contact_id = ch.contact_id and ci.batch_id = p_batch
       where ch.tenant_id = p_tenant and ch.kind = 'phone' and ch.value_hmac = v_phone
       order by (ci.row_number is null), ci.row_number, ch.created_at desc
       limit 1;
    end if;
    if v_holder is not null then
      if v_of is not null then
        v_repeats := v_repeats || jsonb_build_array(jsonb_build_object('row', v_row, 'of', v_of));
      else
        v_dups := v_dups || to_jsonb(v_row);
      end if;
      continue;
    end if;

    begin
      insert into public.crm_contacts (tenant_id, display_name, title, company_name, stage, source,
                                       locale, city, country, tags, created_by)
      values (p_tenant, r ->> 'display_name', r ->> 'title', r ->> 'company_name',
              coalesce(r ->> 'stage', 'lead'), 'import', coalesce(r ->> 'locale', 'en'),
              r ->> 'city', r ->> 'country',
              coalesce(array(select jsonb_array_elements_text(r -> 'tags')), '{}'), p_actor)
      returning id into v_id;
      insert into public.crm_contact_channels (tenant_id, contact_id, kind, value_enc, value_hmac,
                                               is_primary, source, created_by)
      select p_tenant, v_id, c ->> 'kind', c ->> 'value_enc', c ->> 'value_hmac', true, 'import', p_actor
        from jsonb_array_elements(v_channels) c;
      insert into public.crm_contact_imports (tenant_id, contact_id, batch_id, row_number, basis)
      values (p_tenant, v_id, p_batch, v_row, r ->> 'basis');
      v_created := v_created + 1;
      v_bases := jsonb_set(v_bases, array[r ->> 'basis'],
                           to_jsonb(coalesce((v_bases ->> (r ->> 'basis'))::int, 0) + 1));
      -- A new e-mail whose phone another contact holds: added, and listed to check.
      if v_email is not null and v_phone is not null
         and exists (select 1 from public.crm_contact_channels ch
                      where ch.tenant_id = p_tenant and ch.kind = 'phone' and ch.value_hmac = v_phone
                        and ch.contact_id <> v_id) then
        v_matches := v_matches || to_jsonb(v_row);
      end if;
    exception
      -- The e-mail's unique index behind the lock: as a contact already.
      when unique_violation then
        v_dups := v_dups || to_jsonb(v_row);
      -- A value the columns refuse (the Worker checks them first): not imported.
      when check_violation or not_null_violation or string_data_right_truncation
           or invalid_text_representation or foreign_key_violation then
        v_refused := v_refused || to_jsonb(v_row);
    end;
  end loop;

  update public.crm_import_batches b
     set rows_seen = b.rows_seen + v_n + p_failed,
         bytes_seen = b.bytes_seen + p_bytes,
         pieces = b.pieces + 1,
         created_count = b.created_count + v_created,
         duplicate_count = b.duplicate_count + jsonb_array_length(v_dups),
         repeat_count = b.repeat_count + jsonb_array_length(v_repeats),
         failed_count = b.failed_count + p_failed + jsonb_array_length(v_refused),
         phone_match_count = b.phone_match_count + jsonb_array_length(v_matches),
         basis_counts = (select coalesce(jsonb_object_agg(k, coalesce((b.basis_counts ->> k)::int, 0)
                                                           + coalesce((v_bases ->> k)::int, 0)), '{}'::jsonb)
                           from unnest(array['consent', 'contract', 'legitimate_interest', 'legal_obligation']) k
                          where b.basis_counts ? k or v_bases ? k),
         updated_at = now()
   where b.tenant_id = p_tenant and b.id = p_batch;
  return jsonb_build_object('created', v_created, 'duplicates', v_dups, 'repeats', v_repeats,
                            'phone_matches', v_matches, 'refused', v_refused);
end $$;
revoke all on function public.crm_import_rows(uuid, uuid, uuid, jsonb, int, int) from public, anon, authenticated, service_role;
grant execute on function public.crm_import_rows(uuid, uuid, uuid, jsonb, int, int) to service_role;

-- Close an import: done, or stopped when the Admin stopped it. Answers its counts.
create or replace function public.crm_import_finish(p_tenant uuid, p_batch uuid, p_actor uuid, p_stopped boolean)
  returns jsonb
  language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  v_batch public.crm_import_batches%rowtype;
begin
  if p_tenant is null or p_batch is null or p_actor is null then
    raise exception using errcode = '22023', message = 'crm_import_finish: a tenant, a batch and an actor are required';
  end if;
  if not app.crm_import_actor_ok(p_tenant, p_actor) then
    raise exception using errcode = '42501', message = 'crm_import_finish: this person may not import contacts';
  end if;
  update public.crm_import_batches b
     set status = case when coalesce(p_stopped, false) then 'stopped' else 'done' end,
         finished_at = now(), updated_at = now()
   where b.tenant_id = p_tenant and b.id = p_batch and b.created_by = p_actor and b.status = 'open'
  returning b.* into v_batch;
  if not found then
    raise exception using errcode = 'P0002', message = 'crm_import_finish: no such open import';
  end if;
  return app.crm_import_counts(v_batch);
end $$;
revoke all on function public.crm_import_finish(uuid, uuid, uuid, boolean) from public, anon, authenticated, service_role;
grant execute on function public.crm_import_finish(uuid, uuid, uuid, boolean) to service_role;

-- Imports left open (a closed tab, a Worker stopped mid-piece, an Admin switched off, demoted
-- or locked mid-import, whose doors then refuse them): a batch takes no piece after two hours,
-- so this stops every batch open longer than that, in every tenant, and writes its OUTCOME
-- audit row with no actor (the schedule did it), the counts only, as the Worker's own outcome
-- row for an import left open (`left_open`, plus `swept`). Without it such a batch stayed open
-- with only its attempt row, unless the same Admin opened another. Returns how many it
-- stopped. A definer for pg_cron (it runs as the job's owner); no API role executes it.
create or replace function app.crm_import_sweep() returns int
  language plpgsql volatile security definer set search_path = '' as $$
declare
  v_n int := 0;
  b record;
begin
  for b in
    update public.crm_import_batches x
       set status = 'stopped', finished_at = pg_catalog.now(), updated_at = pg_catalog.now()
     where x.status = 'open' and x.created_at <= pg_catalog.now() - interval '2 hours'
    returning x.tenant_id, x.id, x.rows_seen, x.created_count, x.duplicate_count, x.repeat_count,
              x.failed_count, x.phone_match_count, x.basis_counts
  loop
    insert into public.audit_log (tenant_id, actor_id, actor_role, action, entity_type, entity_id, detail)
    values (b.tenant_id, null, null, 'crm.import.outcome', 'contact_import', b.id::text,
            pg_catalog.jsonb_build_object(
              'status', 'stopped', 'left_open', true, 'swept', true, 'rows', b.rows_seen,
              'created', b.created_count, 'duplicates', b.duplicate_count, 'repeats', b.repeat_count,
              'failed', b.failed_count, 'phone_matches', b.phone_match_count)
            || coalesce((select pg_catalog.jsonb_object_agg('basis_' || k.key, k.value)
                           from pg_catalog.jsonb_each(b.basis_counts) k
                          where k.key in ('consent', 'contract', 'legitimate_interest', 'legal_obligation')),
                        '{}'::jsonb));
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;
revoke all on function app.crm_import_sweep() from public, anon, authenticated, service_role;

-- Hourly at :47, the 0060 pattern: where pg_cron is missing (a local stack without it) the job
-- is a notice, and stale imports wait for the same Admin's next open.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobname) from cron.job where jobname = 'crm-import-sweep';
    perform cron.schedule('crm-import-sweep', '47 * * * *', $job$ select app.crm_import_sweep() $job$);
  else
    raise notice 'pg_cron not installed: run app.crm_import_sweep() hourly by hand';
  end if;
end $$;

-- ═══ 7. Postconditions (P-14: under both Supabase grant regimes) ═════════════════════════
do $$
declare
  v_maintain boolean := current_setting('server_version_num')::int >= 170000;
  v_got text[];
  v_fn text;
  t text;
  r text;
begin
  -- ---- 1. RLS and policies ----------------------------------------------------------------
  foreach t in array array['crm_import_batches', 'crm_contact_imports'] loop
    if not exists (select 1 from pg_class
                    where oid = ('public.' || t)::regclass and relrowsecurity and relforcerowsecurity) then
      raise exception 'C15: % must have RLS enabled and forced', t;
    end if;
    select array_agg(policyname::text || ':' || cmd || ':' || permissive order by policyname collate "C")
      into v_got from pg_policies where schemaname = 'public' and tablename = t;
    if v_got is distinct from array[t || '_live:ALL:RESTRICTIVE', t || '_read:SELECT:PERMISSIVE'] then
      raise exception 'C15: the % policies are %', t, v_got;
    end if;
    if exists (select 1 from pg_policies
                where schemaname = 'public' and tablename = t
                  and (roles <> array['authenticated']::name[]
                       or qual !~ '^\(\(tenant_id = (app\.)?effective_tenant_id\(\)\) AND (app\.)?role_crm_(import|contacts)\('
                       or (with_check is not null
                           and with_check !~ '^\(\(tenant_id = (app\.)?effective_tenant_id\(\)\) AND (app\.)?role_crm_(import|contacts)\('))) then
      raise exception 'C15: a % policy is not TO authenticated, or does not lead with the tenant predicate and its helper', t;
    end if;
    if not exists (select 1 from pg_policies
                    where schemaname = 'public' and tablename = t and policyname = t || '_live'
                      and qual ~ 'live_role\(\)' and with_check ~ 'live_role\(\)') then
      raise exception 'C15: %_live lacks the live check', t;
    end if;

    -- ---- 2. Grants --------------------------------------------------------------------------
    foreach r in array array['public', 'anon'] loop
      if has_table_privilege(r::name, ('public.' || t)::regclass,
                             'select, insert, update, delete, truncate, references, trigger')
         or has_any_column_privilege(r::name, ('public.' || t)::regclass, 'select, insert, update, references')
         or (case when v_maintain then has_table_privilege(r::name, ('public.' || t)::regclass, 'maintain')
                  else false end) then
        raise exception 'C15: % holds a privilege on %', r, t;
      end if;
    end loop;
    foreach r in array array['authenticated', 'service_role'] loop
      if has_table_privilege(r::name, ('public.' || t)::regclass, 'delete, truncate, references, trigger')
         or has_any_column_privilege(r::name, ('public.' || t)::regclass, 'references')
         or (case when v_maintain then has_table_privilege(r::name, ('public.' || t)::regclass, 'maintain')
                  else false end) then
        raise exception 'C15: % holds DELETE, TRUNCATE, REFERENCES, TRIGGER or MAINTAIN on %', r, t;
      end if;
    end loop;
    if not has_table_privilege('authenticated', ('public.' || t)::regclass, 'select')
       or has_any_column_privilege('authenticated', ('public.' || t)::regclass, 'insert, update') then
      raise exception 'C15: authenticated must read % and write none of it', t;
    end if;
    if not has_table_privilege('service_role', ('public.' || t)::regclass, 'select, insert') then
      raise exception 'C15: the service role must read and insert %', t;
    end if;
  end loop;
  if has_any_column_privilege('service_role', 'public.crm_contact_imports', 'update')
     or not has_table_privilege('service_role', 'public.crm_import_batches', 'update') then
    raise exception 'C15: the service role updates batches, never a contact''s basis';
  end if;

  -- ---- 3. Functions -------------------------------------------------------------------------
  foreach v_fn in array array['public.crm_import_open(uuid, uuid, integer, integer, text)',
                              'public.crm_import_rows(uuid, uuid, uuid, jsonb, integer, integer)',
                              'public.crm_import_finish(uuid, uuid, uuid, boolean)'] loop
    if exists (select 1 from pg_proc where oid = v_fn::regprocedure and prosecdef) then
      raise exception 'C15: % must be SECURITY INVOKER', v_fn;
    end if;
    if has_function_privilege('anon', v_fn, 'execute')
       or has_function_privilege('authenticated', v_fn, 'execute')
       or not has_function_privilege('service_role', v_fn, 'execute')
       or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                   where p.oid = v_fn::regprocedure and a.grantee = 0) then
      raise exception 'C15: % must be executable by the service role only', v_fn;
    end if;
  end loop;
  if not exists (select 1 from pg_proc f join pg_roles o on o.oid = f.proowner
                  where f.oid = 'app.crm_import_actor_ok(uuid, uuid)'::regprocedure and f.prosecdef
                    and f.proconfig[1] = 'search_path=""' and (o.rolsuper or o.rolbypassrls)) then
    raise exception 'C15: app.crm_import_actor_ok is not a definer with an empty search_path owned by a role that bypasses RLS';
  end if;
  foreach v_fn in array array['app.crm_import_actor_ok(uuid, uuid)',
                              'app.crm_import_counts(public.crm_import_batches)'] loop
    if has_function_privilege('anon', v_fn, 'execute')
       or has_function_privilege('authenticated', v_fn, 'execute')
       or not has_function_privilege('service_role', v_fn, 'execute') then
      raise exception 'C15: % must be executable by the service role only', v_fn;
    end if;
  end loop;
  if has_function_privilege('anon', 'app.role_crm_import(text)', 'execute')
     or not has_function_privilege('authenticated', 'app.role_crm_import(text)', 'execute')
     or not has_function_privilege('service_role', 'app.role_crm_import(text)', 'execute') then
    raise exception 'C15: app.role_crm_import must be executable by authenticated and the service role only';
  end if;
  -- The sweep: a definer with an empty search_path that no API role executes, scheduled
  -- hourly where pg_cron is installed. Nested: PL/pgSQL plans a condition when it first runs
  -- it, so cron.job is never named on a server without the extension.
  if not exists (select 1 from pg_proc f join pg_roles o on o.oid = f.proowner
                  where f.oid = 'app.crm_import_sweep()'::regprocedure and f.prosecdef
                    and f.proconfig[1] = 'search_path=""' and (o.rolsuper or o.rolbypassrls)) then
    raise exception 'C15: app.crm_import_sweep is not a definer with an empty search_path owned by a role that bypasses RLS';
  end if;
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if has_function_privilege(r::name, 'app.crm_import_sweep()', 'execute') then
      raise exception 'C15: % may execute app.crm_import_sweep()', r;
    end if;
  end loop;
  if exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
              where p.oid = 'app.crm_import_sweep()'::regprocedure and a.grantee = 0) then
    raise exception 'C15: PUBLIC may execute app.crm_import_sweep()';
  end if;
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if not exists (select 1 from cron.job
                    where jobname = 'crm-import-sweep' and schedule = '47 * * * *'
                      and command ~ 'app\.crm_import_sweep\(\)') then
      raise exception 'C15: the crm-import-sweep job is not scheduled as stated';
    end if;
  end if;
  -- One open import per Admin: the partial unique index, and the open door's lock.
  if not exists (select 1 from pg_indexes
                  where schemaname = 'public' and indexname = 'crm_import_batches_one_open'
                    and indexdef ~ '^CREATE UNIQUE INDEX .* \(tenant_id, created_by\) WHERE \(status = ''open''::text\)$') then
    raise exception 'C15: crm_import_batches_one_open must be unique on (tenant_id, created_by) where open';
  end if;
  if (select prosrc from pg_proc where oid = 'public.crm_import_open(uuid, uuid, integer, integer, text)'::regprocedure)
       !~ 'pg_advisory_xact_lock\(hashtextextended\(''crm-import:''' then
    raise exception 'C15: crm_import_open must take the Admin''s import lock';
  end if;

  -- Every function here but the inlined helper pins its search_path (advisor lint 0011).
  foreach v_fn in array array['app.crm_import_actor_ok(uuid, uuid)',
                              'app.crm_import_sweep()',
                              'app.crm_import_counts(public.crm_import_batches)',
                              'public.crm_import_open(uuid, uuid, integer, integer, text)',
                              'public.crm_import_rows(uuid, uuid, uuid, jsonb, integer, integer)',
                              'public.crm_import_finish(uuid, uuid, uuid, boolean)'] loop
    if not exists (select 1 from pg_proc f, unnest(f.proconfig) c
                    where f.oid = v_fn::regprocedure and c like 'search_path=%') then
      raise exception 'C15: % does not pin its search_path', v_fn;
    end if;
  end loop;
  if not app.role_crm_import('admin')
     or app.role_crm_import('developer') or app.role_crm_import('sales')
     or app.role_crm_import('content_creator') or app.role_crm_import('seo')
     or app.role_crm_import(null) then
    raise exception 'C15: app.role_crm_import does not answer Admin alone';
  end if;

  -- ---- 4. Nothing imported yet --------------------------------------------------------------
  if exists (select 1 from public.crm_import_batches) or exists (select 1 from public.crm_contact_imports) then
    raise exception 'C15: the import tables are not empty';
  end if;
end $$;
