-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 0137 — CRM companies (Admin v2 C11, crm.md CRM-11 and §5.3). Forward-only, EXPAND only.
-- HELD with the contacts chain: the PR merges only after the owner's lawyer signs off the
-- privacy-notice update (owner item O-11, register L-2 to L-4 and L-11) and after C5, C6, C7,
-- C8 and C8b. The number is a placeholder: the merge train assigns it
-- (scripts/renumber-migration.mjs); messages below name the slice, never the number. Depends
-- on 0021 (sectors, clients), 0033 (app.live_role), 0041 (profiles (tenant_id, id)), 0129
-- (every staff-writable table carries a RESTRICTIVE live policy) and C5's migration (the
-- contacts, their channels, app.crm_name_key, the lead link and its triggers).
--
-- WHAT IT ADDS
--   1. public.crm_companies: an organisation the studio works with (crm.md §5.3): a name, a
--      sector (the public sectors taxonomy), a size, a website, a city, a stage, an owner,
--      notes, and optionally the public clients row it is (a LINK only: clients.visible stays
--      the disclosure switch, owned by portfolio.write; linking publishes nothing). RLS ENABLE
--      + FORCE through crm.contacts' helper (crm.md §2.1: "contacts & companies"), the tenant
--      predicate first, a RESTRICTIVE live check for every command. Composite keys fence the
--      sector, the client and the owner to the company's own tenant (sectors and clients gain
--      unique (tenant_id, id) for them, as profiles did in 0041).
--   2. crm_contacts.company_id: the contact's company (a composite key, ON DELETE SET NULL of
--      that column). The free text company_name stays, so C7's field keeps working until a
--      contact is linked; while linked it is the company's name (kept in step by the database,
--      a rename included), so every reader C6 built shows the company with no restatement.
--   3. Find-or-create at arrival (README's C11 row), never blocking the public form:
--        • by name: when a lead is linked to a contact other than by phone (C5's link at
--          arrival, the nightly backfill, a person's confirm), a contact with no company that
--          no person has edited is given the company the lead names (C5's name folding),
--          found, oldest first, or made by the system;
--        • by domain: the Worker records the blind index of a non-freemail e-mail domain on
--          the lead's e-mail channel (public.crm_lead_domain, the service role's); the channel's
--          trigger links a contact with no company to the company holding that domain, or
--          teaches the contact's company its domain when no company holds it.
--      Both write the contact from INSIDE a trigger, as C5's won rule and owner fill do, so the
--      system's link never marks a contact as edited by a person (app.tg_crm_contact_row's
--      staff_edited, which keeps an auto-contact after its inquiries' erasure, C5-SEC-1). Each
--      step runs in its own sub-transaction: an error is a WARNING and the link stands.
--   4. An auto-company (made by the system, never edited by a person) goes with its last
--      contact: retention, a lead's erasure and a person's erasure take the company an
--      inquiry's free text made, with no restatement of app.purge_crm or the erasure doors.
--   5. SECURITY INVOKER readers and writers for the screens: the list (contacts and won value
--      derived, never stored), one company with its contacts, create, a versioned update and
--      removal, and a contact's company (link, unlink, "Create company from this name").
--
-- Nothing of another slice is restated: crm_ingest_lead, app.tg_lead_pipeline,
-- app.tg_crm_contact_row, app.purge_crm, app.run_retention and the erasure doors are left as
-- C5, C8 and C13 leave them. Rule 5 (the deployed Worker between the push and the deploy): no
-- deployed reader names a new column, and the deployed Worker never calls the new functions;
-- the name step at arrival is the documented change.
-- ─────────────────────────────────────────────────────────────────────────────────────────

-- A busy table fails the push instead of queueing behind it (0041's reason): this adds keys
-- to sectors and clients and columns to crm_contacts and crm_contact_channels.
set local lock_timeout = '5s';

-- ═══ 1. Keys the composite foreign keys need ══════════════════════════════════════════════
alter table public.sectors add constraint sectors_tenant_id_id unique (tenant_id, id);
alter table public.clients add constraint clients_tenant_id_id unique (tenant_id, id);

-- ═══ 2. The table ═════════════════════════════════════════════════════════════════════════
create table public.crm_companies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default app.effective_tenant_id() references public.tenants (id) on delete cascade,
  name text not null
    check (char_length(btrim(name)) between 1 and 120 and name !~ '[[:cntrl:]]'),
  -- C5's folding (lower-cased, normalize_ar, a leading al-/el-/ال dropped from each word), so
  -- "Al Rashid Trading" and "الرشيد" meet the way contacts' names do.
  name_key text generated always as (app.crm_name_key(name)) stored,
  sector_id uuid,
  client_id uuid,
  size text check (size is null or size in ('1-10', '11-50', '51-200', '200+')),
  website text check (website is null or (char_length(website) <= 2048
                                          and website ~ '^https://[^[:space:]/?#@]+([/?#][^[:space:]]*)?$')),
  city text check (city is null or (char_length(city) <= 80 and city !~ '[[:cntrl:]]')),
  stage text not null default 'lead' check (stage in ('lead', 'client', 'past', 'partner')),
  owner_id uuid,
  -- Free text: a line break or a tab is fine, no other control character.
  notes text check (notes is null or (char_length(notes) <= 2000
                                      and notes !~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]')),
  -- The blind index of the company's e-mail domain (crm-index/v1, kind 'domain', tenant
  -- salted: crm.md §6.1), learnt from a non-freemail inquiry. Written by the system only;
  -- no staff grant reads or writes it.
  domain_hmac text check (domain_hmac is null or domain_hmac ~ '^[0-9a-f]{64}$'),
  -- A person has edited it (as crm_contacts.staff_edited, C5 review): set by a direct write
  -- that changes a chosen column, never by the system's, never cleared. An auto-company a
  -- person never edited goes with its last contact.
  staff_edited boolean not null default false,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Null: made by the system (an inquiry's arrival). Never client-chosen.
  created_by uuid,
  updated_by uuid,
  constraint crm_companies_tenant_id_id unique (tenant_id, id),
  constraint crm_companies_sector_fk foreign key (tenant_id, sector_id)
    references public.sectors (tenant_id, id) on delete set null (sector_id),
  constraint crm_companies_client_fk foreign key (tenant_id, client_id)
    references public.clients (tenant_id, id) on delete set null (client_id),
  constraint crm_companies_owner_fk foreign key (tenant_id, owner_id)
    references public.profiles (tenant_id, id) on delete set null (owner_id)
);
-- One company per domain (the domain match is exact).
create unique index crm_companies_one_domain on public.crm_companies (tenant_id, domain_hmac)
  where domain_hmac is not null;
-- The name match at arrival (equality) and the search (contains, trigram).
create index crm_companies_name_key_idx on public.crm_companies (tenant_id, name_key);
create index crm_companies_name_trgm_idx on public.crm_companies using gin (name_key gin_trgm_ops);
-- The foreign keys' referencing sides.
create index crm_companies_owner_idx on public.crm_companies (tenant_id, owner_id) where owner_id is not null;
create index crm_companies_sector_idx on public.crm_companies (tenant_id, sector_id) where sector_id is not null;
create index crm_companies_client_idx on public.crm_companies (tenant_id, client_id) where client_id is not null;
alter table public.crm_companies enable row level security;
alter table public.crm_companies force row level security;

-- The contact's company, and the domain index of an e-mail channel.
alter table public.crm_contacts add column company_id uuid;
alter table public.crm_contacts add constraint crm_contacts_company_fk foreign key (tenant_id, company_id)
  references public.crm_companies (tenant_id, id) on delete set null (company_id);
create index crm_contacts_company_idx on public.crm_contacts (tenant_id, company_id) where company_id is not null;
alter table public.crm_contact_channels add column domain_hmac text
  constraint crm_contact_channels_domain_ok
  check (domain_hmac is null or (kind = 'email' and domain_hmac ~ '^[0-9a-f]{64}$'));
create index crm_contact_channels_domain_idx on public.crm_contact_channels (tenant_id, domain_hmac)
  where domain_hmac is not null;

-- ═══ 3. The company's row rules (BEFORE) ══════════════════════════════════════════════════
-- A definer: the owner rule reads a colleague's profile, which a staff token cannot. As the
-- contacts' and tasks' rules: who and when, the version (moved by an edit of a chosen column),
-- the owner (an active crm.contacts holder of the tenant), staff_edited.
create or replace function app.tg_crm_company_row() returns trigger
  language plpgsql security definer set search_path = '' as $$
declare
  c_chosen constant text[] := array['name', 'sector_id', 'client_id', 'size', 'website', 'city',
    'stage', 'owner_id', 'notes'];
  -- A direct write: a statement on the table itself, not one a trigger made (the arrival's
  -- find-or-create runs inside a trigger on leads or on a contact's channel).
  v_direct constant boolean := pg_trigger_depth() = 1;
  v_edited boolean := false;
  f text;
begin
  -- (C8-SEC-2's guard) An API session's direct insert is held to its own tenant and a live
  -- contacts role FIRST: Postgres runs this BEFORE trigger ahead of RLS's WITH CHECK, and the
  -- owner rule below would otherwise tell any signed-in token whether a uuid is an active
  -- member of any tenant. The refusal is RLS's own code and words.
  if tg_op = 'INSERT' and v_direct and auth.uid() is not null
     and (new.tenant_id is distinct from app.effective_tenant_id()
          or not coalesce(app.role_crm_contacts(app.live_role()), false)) then
    raise exception using errcode = '42501',
      message = 'new row violates row-level security policy for table "crm_companies"';
  end if;

  if new.owner_id is not null
     and (tg_op = 'INSERT' or new.owner_id is distinct from old.owner_id)
     and not exists (select 1 from public.profiles p
                      where p.id = new.owner_id and p.tenant_id = new.tenant_id and p.is_active
                        and app.role_crm_contacts(p.role::text)) then
    raise exception using errcode = '23514',
      message = 'the owner must be an active contacts user of this tenant (constraint "crm_companies_owner_active")';
  end if;

  if tg_op = 'INSERT' then
    -- The session's person for a direct write; the system's companies (made inside a trigger
    -- at an inquiry's arrival) have none, whoever's session it is.
    new.created_by := case when v_direct then coalesce(auth.uid(), new.created_by) end;
    new.updated_by := new.created_by;
    new.created_at := now();
    new.updated_at := now();
    new.version := 1;
    new.staff_edited := v_direct and new.created_by is not null;
    return new;
  end if;

  foreach f in array c_chosen loop
    if to_jsonb(new) -> f is distinct from to_jsonb(old) -> f then
      v_edited := true;
    end if;
  end loop;
  new.created_by := old.created_by;
  new.created_at := old.created_at;
  new.staff_edited := old.staff_edited or (v_direct and v_edited);
  if v_edited then
    new.updated_at := now();
    new.updated_by := auth.uid();
    if new.version = old.version then
      new.version := old.version + 1;
    end if;
  else
    -- The learnt domain is the system's, not an edit: no version, no stamps.
    new.updated_at := old.updated_at;
    new.updated_by := old.updated_by;
    new.version := old.version;
  end if;
  return new;
end $$;
revoke all on function app.tg_crm_company_row() from public, anon, authenticated, service_role;
create trigger crm_companies_row before insert or update on public.crm_companies
  for each row execute function app.tg_crm_company_row();

-- A rename reaches the company's contacts (their company_name is the company's while linked).
-- From inside a trigger, so it is the system's write: the contacts' version moves (an open
-- screen must not save the old name over it) and their timeline says the company changed,
-- but no contact is marked as edited by a person.
create or replace function app.tg_crm_company_rename() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  if new.name is distinct from old.name then
    update public.crm_contacts k set company_name = new.name
     where k.tenant_id = new.tenant_id and k.company_id = new.id
       and k.company_name is distinct from new.name;
  end if;
  return null;
end $$;
revoke all on function app.tg_crm_company_rename() from public, anon, authenticated, service_role;
create trigger crm_companies_rename after update of name on public.crm_companies
  for each row execute function app.tg_crm_company_rename();

-- ═══ 4. The contact's company ═════════════════════════════════════════════════════════════
-- BEFORE, and named to fire before C5's crm_contacts_row (triggers fire in name order), so
-- C5's rules see the name it sets: while a contact is linked, its company_name is the
-- company's. A definer (the system's writes reach a contact its caller may not read); the
-- company is read in the contact's own tenant only, and the composite key refuses any other.
create or replace function app.tg_crm_contact_company() returns trigger
  language plpgsql security definer set search_path = '' as $$
declare
  v_name text;
begin
  if new.company_id is not null then
    select c.name into v_name from public.crm_companies c
     where c.tenant_id = new.tenant_id and c.id = new.company_id;
    if found then
      new.company_name := v_name;
    end if;
  end if;
  return new;
end $$;
revoke all on function app.tg_crm_contact_company() from public, anon, authenticated, service_role;
create trigger crm_contacts_company before insert or update of company_id, company_name
  on public.crm_contacts for each row execute function app.tg_crm_contact_company();

-- An auto-company goes with its last contact: made by the system, never edited by a person,
-- and named by no contact (a merge tombstone included) once this contact is gone or has moved.
-- Its name came from an inquiry's free text, which can be a person's ("Sara Design"), so it
-- must not outlive the inquiries it came from (retention, a lead's or a person's erasure).
create or replace function app.tg_crm_company_orphan() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  if old.company_id is null
     or (tg_op = 'UPDATE' and new.company_id is not distinct from old.company_id) then
    return null;
  end if;
  delete from public.crm_companies c
   where c.tenant_id = old.tenant_id and c.id = old.company_id
     and c.created_by is null and not c.staff_edited
     and not exists (select 1 from public.crm_contacts k
                      where k.tenant_id = c.tenant_id and k.company_id = c.id);
  return null;
end $$;
revoke all on function app.tg_crm_company_orphan() from public, anon, authenticated, service_role;
create trigger crm_contacts_company_orphan after delete or update of company_id on public.crm_contacts
  for each row execute function app.tg_crm_company_orphan();

-- ═══ 5. Find-or-create at arrival ═════════════════════════════════════════════════════════
-- What the system does for one contact, given what an inquiry says (a company name, the
-- blind index of a non-freemail domain). Answers what happened: 'domain' or 'name' (linked
-- to the company found), 'new' (a company made and linked), 'learned' (the contact's company
-- now knows the domain), or why nothing changed: 'missing', 'has_company', 'edited' (a
-- person edited the contact: their choice stands), 'no_name'.
-- CALLED ONLY FROM A TRIGGER (app.tg_lead_company, app.tg_crm_channel_company): its contact
-- write must be at trigger depth 2, the system's, so it never marks the contact as edited by
-- a person (C5-SEC-1). No API role executes it.
create or replace function app.crm_company_autolink(p_tenant uuid, p_contact uuid, p_name text,
                                                    p_domain text)
  returns text language plpgsql volatile security definer set search_path = '' as $$
declare
  k record;
  v_company uuid;
  v_name text;
  v_key text;
  v_how text;
begin
  select c.company_id, c.staff_edited, c.merged_into into k
    from public.crm_contacts c
   where c.tenant_id = p_tenant and c.id = p_contact
     for update;
  if not found or k.merged_into is not null then
    return 'missing';
  end if;
  if p_domain is not null and p_domain !~ '^[0-9a-f]{64}$' then
    p_domain := null;
  end if;

  if k.company_id is not null then
    -- The contact's company learns the domain, when it has none and no company holds it.
    if p_domain is not null then
      update public.crm_companies c set domain_hmac = p_domain
       where c.tenant_id = p_tenant and c.id = k.company_id and c.domain_hmac is null
         and not exists (select 1 from public.crm_companies o
                          where o.tenant_id = p_tenant and o.domain_hmac = p_domain);
      if found then
        return 'learned';
      end if;
    end if;
    return 'has_company';
  end if;
  if k.staff_edited then
    return 'edited';
  end if;

  -- 1. The domain: exact, one company per domain.
  if p_domain is not null then
    select c.id into v_company from public.crm_companies c
     where c.tenant_id = p_tenant and c.domain_hmac = p_domain;
    if v_company is not null then
      v_how := 'domain';
    end if;
  end if;

  -- 2. The name, folded as contacts' names are; the oldest company of that name. A lock per
  --    name serialises two arrivals naming one new company (the second finds the first's).
  if v_company is null then
    v_name := nullif(left(btrim(regexp_replace(coalesce(p_name, ''), '[[:cntrl:]]', ' ', 'g')), 120), '');
    v_key := nullif(app.crm_name_key(v_name), '');
    if v_key is null then
      return 'no_name';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('crm-company:' || p_tenant::text || ':' || v_key, 0));
    select c.id into v_company from public.crm_companies c
     where c.tenant_id = p_tenant and c.name_key = v_key
     order by c.created_at, c.id
     limit 1;
    if v_company is not null then
      v_how := 'name';
    else
      insert into public.crm_companies (tenant_id, name, domain_hmac)
      values (p_tenant, v_name,
              case when p_domain is not null
                        and not exists (select 1 from public.crm_companies o
                                         where o.tenant_id = p_tenant and o.domain_hmac = p_domain)
                   then p_domain end)
      returning id into v_company;
      v_how := 'new';
    end if;
  end if;

  -- company_name is in the SET list so C5's AFTER trigger writes the contact's
  -- details_changed line when the name it shows changes.
  update public.crm_contacts c set company_id = v_company, company_name = c.company_name
   where c.tenant_id = p_tenant and c.id = p_contact;
  return v_how;
end $$;
revoke all on function app.crm_company_autolink(uuid, uuid, text, text) from public, anon, authenticated, service_role;

-- AFTER UPDATE OF contact_id on leads (after C5's leads_contact, by name order): a lead
-- linked to a contact other than by phone (a phone match may be someone else's until a
-- person confirms it, C5), and not spam, names the contact's company. Its own
-- sub-transaction: whatever goes wrong is undone alone, the link stands (the public form is
-- never blocked by it; CLAUDE.md §3).
create or replace function app.tg_lead_company() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  if new.contact_id is null or new.contact_id is not distinct from old.contact_id
     or new.contact_link is not distinct from 'phone' or new.is_spam then
    return null;
  end if;
  begin
    perform app.crm_company_autolink(new.tenant_id, new.contact_id, new.company, null);
  exception when others then
    raise warning 'C11: the company step was skipped (SQLSTATE %); the lead stays linked', sqlstate;
  end;
  return null;
end $$;
revoke all on function app.tg_lead_company() from public, anon, authenticated, service_role;
create trigger leads_contact_company after update of contact_id on public.leads
  for each row execute function app.tg_lead_company();

-- AFTER INSERT OR UPDATE OF domain_hmac on a contact's channels: an e-mail channel that
-- carries a domain index links its contact to the company holding the domain, or teaches
-- the contact's company the domain. Every write that names the column runs it (it is
-- idempotent), so a returning person's channel, which holds the index already, still gets
-- its contact a company. Its own sub-transaction, as above.
create or replace function app.tg_crm_channel_company() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  if new.kind <> 'email' or new.domain_hmac is null then
    return null;
  end if;
  begin
    perform app.crm_company_autolink(new.tenant_id, new.contact_id, null, new.domain_hmac);
  exception when others then
    raise warning 'C11: the company step was skipped (SQLSTATE %)', sqlstate;
  end;
  return null;
end $$;
revoke all on function app.tg_crm_channel_company() from public, anon, authenticated, service_role;
create trigger crm_contact_channels_company after insert or update of domain_hmac
  on public.crm_contact_channels for each row execute function app.tg_crm_channel_company();

-- The Worker's half of the domain step (src/lib/crm/companyDomain.ts): after an inquiry is
-- in, the blind index of its non-freemail e-mail domain is recorded on the e-mail channel
-- the link copied from it (the lead's own e-mail index). The service role's alone; it reads
-- and writes nothing a person typed. Answers 'recorded', or why not: 'missing', 'unlinked'
-- (not linked, or linked by phone alone), 'spam', 'no_channel' (the lead's e-mail is not on
-- its contact: another contact holds it).
create or replace function public.crm_lead_domain(p_tenant uuid, p_lead uuid, p_domain_hmac text)
  returns text language plpgsql volatile security invoker set search_path = '' as $$
declare
  l record;
begin
  if p_tenant is null or p_lead is null
     or p_domain_hmac is null or p_domain_hmac !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023',
      message = 'crm_lead_domain: a tenant, a lead and a domain index (64 hex) are required';
  end if;
  select x.contact_id, x.contact_link, x.email_hmac, x.is_spam into l
    from public.leads x
   where x.tenant_id = p_tenant and x.id = p_lead;
  if not found then
    return 'missing';
  end if;
  if l.contact_id is null or l.contact_link is not distinct from 'phone' then
    return 'unlinked';
  end if;
  if l.is_spam then
    return 'spam';
  end if;
  update public.crm_contact_channels ch set domain_hmac = p_domain_hmac
   where ch.tenant_id = p_tenant and ch.contact_id = l.contact_id and ch.kind = 'email'
     and ch.value_hmac = l.email_hmac;
  if not found then
    return 'no_channel';
  end if;
  return 'recorded';
end $$;
revoke all on function public.crm_lead_domain(uuid, uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.crm_lead_domain(uuid, uuid, text) to service_role;

-- ═══ 6. Policies (crm.md §3.4) ════════════════════════════════════════════════════════════
create policy crm_companies_read on public.crm_companies for select to authenticated
  using (tenant_id = app.effective_tenant_id() and app.role_crm_contacts(app.current_role()));
create policy crm_companies_insert on public.crm_companies for insert to authenticated
  with check (tenant_id = app.effective_tenant_id() and app.role_crm_contacts(app.current_role()));
create policy crm_companies_update on public.crm_companies for update to authenticated
  using (tenant_id = app.effective_tenant_id() and app.role_crm_contacts(app.current_role()))
  with check (tenant_id = app.effective_tenant_id() and app.role_crm_contacts(app.current_role()));
create policy crm_companies_delete on public.crm_companies for delete to authenticated
  using (tenant_id = app.effective_tenant_id() and app.role_crm_contacts(app.current_role()));
create policy crm_companies_live on public.crm_companies as restrictive for all to authenticated
  using (tenant_id = app.effective_tenant_id() and app.role_crm_contacts((select app.live_role())))
  with check (tenant_id = app.effective_tenant_id() and app.role_crm_contacts((select app.live_role())));

-- ═══ 7. Grants, stated (P-14: both Supabase regimes) ══════════════════════════════════════
-- Staff read every column but the domain index, insert and change only what a person
-- chooses (never the stamps, the version, staff_edited or the index), and remove.
revoke all on public.crm_companies from public, anon, authenticated, service_role;
grant select (id, tenant_id, name, name_key, sector_id, client_id, size, website, city, stage,
              owner_id, notes, staff_edited, version, created_at, updated_at, created_by,
              updated_by)
  on public.crm_companies to authenticated;
grant insert (tenant_id, name, sector_id, client_id, size, website, city, stage, owner_id, notes)
  on public.crm_companies to authenticated;
grant update (name, sector_id, client_id, size, website, city, stage, owner_id, notes)
  on public.crm_companies to authenticated;
grant delete on public.crm_companies to authenticated;
grant select, insert, update, delete on public.crm_companies to service_role;
-- A contact's company: a person links one (the column grant beside C5's), the composite key
-- holds it to the contact's own tenant.
grant update (company_id) on public.crm_contacts to authenticated;

-- ═══ 8. Readers and writers (INVOKER) ═════════════════════════════════════════════════════
-- The tenant a caller names must be the token's: anything else is refused before a read.
create or replace function app.crm_company_tenant_ok(p_tenant uuid) returns void
  language plpgsql stable set search_path = '' as $$
begin
  if p_tenant is null or p_tenant is distinct from app.effective_tenant_id() then
    raise exception using errcode = '42501', message = 'crm companies: not this tenant';
  end if;
end $$;
revoke all on function app.crm_company_tenant_ok(uuid) from public, anon, authenticated, service_role;
grant execute on function app.crm_company_tenant_ok(uuid) to authenticated;

-- A company's contacts (not merged) and its won value: the won stages' value_sar over its
-- contacts' leads linked other than by phone and not spam (a phone match may be someone
-- else's: crm.md §5.1's rule for a contact's value). Derived, never stored. As the caller.
create or replace function app.crm_company_contacts(p_tenant uuid, p_company uuid) returns int
  language sql stable security invoker set search_path = '' as $$
  select count(*)::int from public.crm_contacts k
   where k.tenant_id = app.effective_tenant_id() and k.tenant_id = p_tenant
     and k.company_id = p_company and k.merged_into is null
$$;
create or replace function app.crm_company_won_value(p_tenant uuid, p_company uuid) returns bigint
  language sql stable security invoker set search_path = '' as $$
  select coalesce(sum(l.value_sar), 0)::bigint
    from public.crm_contacts k
    join public.leads_safe l on l.tenant_id = k.tenant_id and l.contact_id = k.id
    join public.lead_stages st on st.tenant_id = l.tenant_id and st.id = l.stage_id
   where k.tenant_id = app.effective_tenant_id() and k.tenant_id = p_tenant
     and k.company_id = p_company and k.merged_into is null
     and st.kind = 'won' and not l.is_spam and l.contact_link is distinct from 'phone'
$$;
revoke all on function app.crm_company_contacts(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function app.crm_company_contacts(uuid, uuid) to authenticated;
revoke all on function app.crm_company_won_value(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function app.crm_company_won_value(uuid, uuid) to authenticated;

-- One company as the screens show it, read as the caller (RLS, the live check and the column
-- grants decide): its own columns but the domain index, the sector's and the client's English
-- names (when the caller reads them), whether the system made it, its contacts and its won
-- value. Null when the caller sees no such company.
create or replace function app.crm_company_json(p_tenant uuid, p_company uuid) returns jsonb
  language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
           'id', c.id, 'name', c.name, 'website', c.website, 'size', c.size, 'city', c.city,
           'stage', c.stage, 'owner_id', c.owner_id, 'notes', c.notes,
           'sector_id', c.sector_id, 'sector_name', s.name ->> 'en',
           'client_id', c.client_id, 'client_name', cl.name ->> 'en',
           'auto', c.created_by is null,
           'version', c.version, 'created_at', c.created_at, 'updated_at', c.updated_at,
           'contacts', app.crm_company_contacts(p_tenant, c.id),
           'won_value', app.crm_company_won_value(p_tenant, c.id))
    from public.crm_companies c
    left join public.sectors s on s.tenant_id = c.tenant_id and s.id = c.sector_id
    left join public.clients cl on cl.tenant_id = c.tenant_id and cl.id = c.client_id
   where c.tenant_id = app.effective_tenant_id() and c.tenant_id = p_tenant and c.id = p_company
$$;
revoke all on function app.crm_company_json(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function app.crm_company_json(uuid, uuid) to authenticated;

-- The Companies tab: {total, rows}. p_filter (allow-listed; 22023 otherwise): q (at most 64
-- printable characters, folded as the names are, "contains", % and _ escaped), stage, owner
-- ('me', 'none' or a person), sort ('name' default, 'recent', 'contacts', 'value'), limit
-- (1 to 100, 25), offset (0 to 10,000). The total counts every match apart from the page.
create or replace function public.crm_companies_list(p_tenant uuid, p_filter jsonb default '{}'::jsonb)
  returns jsonb
  language plpgsql stable security invoker set search_path = '' as $$
declare
  f jsonb := coalesce(p_filter, '{}'::jsonb);
  v_q text;
  v_needle text;
  v_stage text;
  v_owner text;
  v_owner_id uuid;
  v_sort text;
  v_limit int;
  v_offset int;
begin
  if jsonb_typeof(f) <> 'object'
     or exists (select 1 from jsonb_object_keys(f) k
                 where k not in ('q', 'stage', 'owner', 'sort', 'limit', 'offset')) then
    raise exception using errcode = '22023', message = 'company filter: unknown key';
  end if;
  begin
    v_limit := coalesce((f ->> 'limit')::int, 25);
    v_offset := coalesce((f ->> 'offset')::int, 0);
  exception when others then
    raise exception using errcode = '22023', message = 'company filter: a value has the wrong type';
  end;
  if v_limit not between 1 and 100 or v_offset not between 0 and 10000 then
    raise exception using errcode = '22023', message = 'company filter: a page bound is out of range';
  end if;
  v_stage := f ->> 'stage';
  if v_stage is not null and v_stage not in ('lead', 'client', 'past', 'partner') then
    raise exception using errcode = '22023', message = 'company filter: unknown stage';
  end if;
  v_sort := coalesce(f ->> 'sort', 'name');
  if v_sort not in ('name', 'recent', 'contacts', 'value') then
    raise exception using errcode = '22023', message = 'company filter: sort is name, recent, contacts or value';
  end if;
  v_owner := f ->> 'owner';
  if v_owner is not null and v_owner not in ('me', 'none') then
    if v_owner !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception using errcode = '22023', message = 'company filter: owner is me, none or a person';
    end if;
    v_owner_id := v_owner::uuid;
  elsif v_owner = 'me' then
    v_owner_id := auth.uid();
  end if;
  v_q := f ->> 'q';
  if v_q is not null then
    if char_length(v_q) > 64 or v_q ~ '[[:cntrl:]]' then
      raise exception using errcode = '22023', message = 'company filter: q is at most 64 printable characters';
    end if;
    v_needle := nullif(replace(replace(replace(app.crm_name_key(btrim(v_q)),
                  '\', '\\'), '%', '\%'), '_', '\_'), '');
  end if;
  perform app.crm_company_tenant_ok(p_tenant);
  return (
    with m as (
      -- The two derived sorts are worked out only when asked for (a CASE runs its subquery
      -- lazily); the page's rows are built once the page is cut.
      select c.id, c.name_key, c.updated_at,
             case when v_sort = 'contacts' then app.crm_company_contacts(p_tenant, c.id) end as n_contacts,
             case when v_sort = 'value' then app.crm_company_won_value(p_tenant, c.id) end as n_value
        from public.crm_companies c
       where c.tenant_id = app.effective_tenant_id() and c.tenant_id = p_tenant
         and (v_stage is null or c.stage = v_stage)
         and (v_owner is null or (v_owner = 'none' and c.owner_id is null)
              or (v_owner <> 'none' and c.owner_id = v_owner_id))
         and (v_needle is null or c.name_key like '%' || v_needle || '%')
    ),
    ranked as (
      select m.id, row_number() over (
               order by m.n_contacts desc nulls last, m.n_value desc nulls last,
                        case when v_sort = 'recent' then m.updated_at end desc nulls last,
                        m.name_key, m.id) as pos
        from m
    )
    select jsonb_build_object(
      'total', (select count(*) from m),
      'rows', coalesce((select jsonb_agg(app.crm_company_json(p_tenant, r.id) order by r.pos)
                          from ranked r
                         where r.pos > v_offset and r.pos <= v_offset + v_limit), '[]'::jsonb)));
end $$;
revoke all on function public.crm_companies_list(uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.crm_companies_list(uuid, jsonb) to authenticated;

-- One company and its first 50 contacts (names, titles, stages: what the People list shows,
-- never a contact detail), most recently active first, with `more` when there are others.
-- P0002 when the caller sees no such company.
create or replace function public.crm_company_read(p_tenant uuid, p_company uuid) returns jsonb
  language plpgsql stable security invoker set search_path = '' as $$
declare
  v_company jsonb;
  v_contacts jsonb;
  v_n int;
begin
  perform app.crm_company_tenant_ok(p_tenant);
  v_company := app.crm_company_json(p_tenant, p_company);
  if v_company is null then
    raise exception using errcode = 'P0002', message = 'company: no such company';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'display_name', x.display_name,
                                               'title', x.title, 'stage', x.stage)
                            order by x.last_activity_at desc, x.id), '[]'::jsonb),
         count(*)
    into v_contacts, v_n
    from (select k.id, k.display_name, k.title, k.stage, k.last_activity_at
            from public.crm_contacts k
           where k.tenant_id = app.effective_tenant_id() and k.tenant_id = p_tenant
             and k.company_id = p_company and k.merged_into is null
           order by k.last_activity_at desc, k.id
           limit 51) x;
  if v_n > 50 then
    v_contacts := v_contacts - 50;
  end if;
  return jsonb_build_object('company', v_company, 'contacts', v_contacts, 'more', v_n > 50);
end $$;
revoke all on function public.crm_company_read(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.crm_company_read(uuid, uuid) to authenticated;

-- The keys a company's body may carry (packages/schemas/crmCompanies.ts is the Worker's
-- half; the column CHECKs, the keys and the owner rule are the database's). 22023 on a key
-- outside them or a value of the wrong type.
create or replace function app.crm_company_body_ok(p jsonb) returns void
  language plpgsql immutable set search_path = '' as $$
begin
  if p is null or jsonb_typeof(p) <> 'object'
     or exists (select 1 from jsonb_object_keys(p) k
                 where k not in ('name', 'website', 'sector_id', 'client_id', 'size', 'city',
                                 'stage', 'owner_id', 'notes')) then
    raise exception using errcode = '22023', message = 'company: unknown field';
  end if;
  if exists (select 1 from jsonb_each(p) e
              where jsonb_typeof(e.value) not in ('string', 'null')) then
    raise exception using errcode = '22023', message = 'company: every field is text or null';
  end if;
end $$;
revoke all on function app.crm_company_body_ok(jsonb) from public, anon, authenticated, service_role;
grant execute on function app.crm_company_body_ok(jsonb) to authenticated;

-- A new company, as the caller (RLS, the insert guard, the owner rule and the keys decide).
create or replace function public.crm_company_create(p_tenant uuid, p_company jsonb) returns jsonb
  language plpgsql volatile security invoker set search_path = '' as $$
declare
  v_id uuid;
begin
  perform app.crm_company_body_ok(p_company);
  perform app.crm_company_tenant_ok(p_tenant);
  if nullif(btrim(coalesce(p_company ->> 'name', '')), '') is null then
    raise exception using errcode = '23514',
      message = 'a company needs a name (constraint "crm_companies_name_check")';
  end if;
  begin
    insert into public.crm_companies (tenant_id, name, website, sector_id, client_id, size, city,
                                      stage, owner_id, notes)
    values (p_tenant, btrim(p_company ->> 'name'), p_company ->> 'website',
            (p_company ->> 'sector_id')::uuid, (p_company ->> 'client_id')::uuid,
            p_company ->> 'size', p_company ->> 'city', coalesce(p_company ->> 'stage', 'lead'),
            (p_company ->> 'owner_id')::uuid, p_company ->> 'notes')
    returning id into v_id;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'company: an id is not a uuid';
  end;
  return app.crm_company_json(p_tenant, v_id);
end $$;
revoke all on function public.crm_company_create(uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.crm_company_create(uuid, jsonb) to authenticated;

-- A change, as the caller, at the version the screen read: 40001 when it moved, P0002 when
-- the caller sees no such company, 42501 when the write was refused.
create or replace function public.crm_company_update(p_tenant uuid, p_company uuid, p_version int,
                                                     p_patch jsonb)
  returns jsonb
  language plpgsql volatile security invoker set search_path = '' as $$
declare
  v_version int;
begin
  perform app.crm_company_body_ok(p_patch);
  perform app.crm_company_tenant_ok(p_tenant);
  if p_version is null then
    raise exception using errcode = '22023', message = 'company: send the version you read';
  end if;
  if not exists (select 1 from jsonb_object_keys(p_patch)) then
    raise exception using errcode = '22023', message = 'company: nothing to change';
  end if;
  select c.version into v_version from public.crm_companies c
   where c.tenant_id = app.effective_tenant_id() and c.tenant_id = p_tenant and c.id = p_company
   for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'company: no such company';
  end if;
  if v_version <> p_version then
    raise exception using errcode = '40001', message = 'company: someone else changed it';
  end if;
  if p_patch ? 'name' and nullif(btrim(coalesce(p_patch ->> 'name', '')), '') is null then
    raise exception using errcode = '23514',
      message = 'a company needs a name (constraint "crm_companies_name_check")';
  end if;
  begin
    update public.crm_companies c set
      name = case when p_patch ? 'name' then btrim(p_patch ->> 'name') else c.name end,
      website = case when p_patch ? 'website' then p_patch ->> 'website' else c.website end,
      sector_id = case when p_patch ? 'sector_id' then (p_patch ->> 'sector_id')::uuid else c.sector_id end,
      client_id = case when p_patch ? 'client_id' then (p_patch ->> 'client_id')::uuid else c.client_id end,
      size = case when p_patch ? 'size' then p_patch ->> 'size' else c.size end,
      city = case when p_patch ? 'city' then p_patch ->> 'city' else c.city end,
      stage = case when p_patch ? 'stage' then coalesce(p_patch ->> 'stage', 'lead') else c.stage end,
      owner_id = case when p_patch ? 'owner_id' then (p_patch ->> 'owner_id')::uuid else c.owner_id end,
      notes = case when p_patch ? 'notes' then p_patch ->> 'notes' else c.notes end
     where c.tenant_id = p_tenant and c.id = p_company;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'company: an id is not a uuid';
  end;
  if not found then
    raise exception using errcode = '42501', message = 'company: the change was refused';
  end if;
  return app.crm_company_json(p_tenant, p_company);
end $$;
revoke all on function public.crm_company_update(uuid, uuid, integer, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.crm_company_update(uuid, uuid, integer, jsonb) to authenticated;

-- A company removed, as the caller, at the version the screen read. Its contacts stay, with
-- their last company name as free text (ON DELETE SET NULL of company_id). Answers how many
-- contacts it named (for the audit row). P0002 unseen, 40001 moved, 42501 refused.
create or replace function public.crm_company_delete(p_tenant uuid, p_company uuid, p_version int)
  returns jsonb
  language plpgsql volatile security invoker set search_path = '' as $$
declare
  v_version int;
  v_contacts int;
begin
  perform app.crm_company_tenant_ok(p_tenant);
  if p_version is null then
    raise exception using errcode = '22023', message = 'company: send the version you read';
  end if;
  select c.version into v_version from public.crm_companies c
   where c.tenant_id = app.effective_tenant_id() and c.tenant_id = p_tenant and c.id = p_company
   for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'company: no such company';
  end if;
  if v_version <> p_version then
    raise exception using errcode = '40001', message = 'company: someone else changed it';
  end if;
  select count(*)::int into v_contacts from public.crm_contacts k
   where k.tenant_id = p_tenant and k.company_id = p_company;
  delete from public.crm_companies c where c.tenant_id = p_tenant and c.id = p_company;
  if not found then
    raise exception using errcode = '42501', message = 'company: the removal was refused';
  end if;
  return jsonb_build_object('contacts', v_contacts);
end $$;
revoke all on function public.crm_company_delete(uuid, uuid, integer) from public, anon, authenticated, service_role;
grant execute on function public.crm_company_delete(uuid, uuid, integer) to authenticated;

-- A contact's company, as the caller, at the contact's version (C7's Details card reads it):
--   'link'   p_company: one the caller sees (23503 naming crm_contacts_company_missing else);
--   'unlink' the free text keeps the last name;
--   'create' "Create company from this name": the company named by the contact's free text,
--            found by C5's folding (oldest first) or made as the caller's, then linked.
-- A person's choice: the contact is marked as edited by a person (C5's rule). Answers
-- {company_id, how: linked | found | created | unlinked}. P0002 for a contact the caller
-- does not see (or a merge tombstone), 40001 when its version moved.
create or replace function public.crm_contact_company(p_tenant uuid, p_contact uuid, p_version int,
                                                      p_action text, p_company uuid default null)
  returns jsonb
  language plpgsql volatile security invoker set search_path = '' as $$
declare
  k record;
  v_company uuid;
  v_key text;
  v_how text;
begin
  perform app.crm_company_tenant_ok(p_tenant);
  if p_action is null or p_action not in ('link', 'unlink', 'create') then
    raise exception using errcode = '22023', message = 'contact company: the action is link, unlink or create';
  end if;
  if p_version is null or (p_action = 'link') <> (p_company is not null) then
    raise exception using errcode = '22023',
      message = 'contact company: send the version you read, and a company to link only';
  end if;
  select c.version, c.company_name, c.merged_into into k from public.crm_contacts c
   where c.tenant_id = app.effective_tenant_id() and c.tenant_id = p_tenant and c.id = p_contact
   for update;
  if not found or k.merged_into is not null then
    raise exception using errcode = 'P0002', message = 'contact company: no such contact';
  end if;
  if k.version <> p_version then
    raise exception using errcode = '40001', message = 'contact company: someone else changed it';
  end if;

  if p_action = 'link' then
    if not exists (select 1 from public.crm_companies c
                    where c.tenant_id = app.effective_tenant_id() and c.tenant_id = p_tenant
                      and c.id = p_company) then
      raise exception using errcode = '23503',
        message = 'that company is not there (constraint "crm_contacts_company_missing")';
    end if;
    v_company := p_company;
    v_how := 'linked';
  elsif p_action = 'create' then
    v_key := nullif(app.crm_name_key(btrim(coalesce(k.company_name, ''))), '');
    if v_key is null then
      raise exception using errcode = '23514',
        message = 'the contact names no company (constraint "crm_contacts_company_named")';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('crm-company:' || p_tenant::text || ':' || v_key, 0));
    select c.id into v_company from public.crm_companies c
     where c.tenant_id = app.effective_tenant_id() and c.tenant_id = p_tenant and c.name_key = v_key
     order by c.created_at, c.id
     limit 1;
    if v_company is not null then
      v_how := 'found';
    else
      insert into public.crm_companies (tenant_id, name)
      values (p_tenant, btrim(k.company_name))
      returning id into v_company;
      v_how := 'created';
    end if;
  else
    v_company := null;
    v_how := 'unlinked';
  end if;

  update public.crm_contacts c set company_id = v_company, company_name = c.company_name
   where c.tenant_id = p_tenant and c.id = p_contact;
  if not found then
    raise exception using errcode = '42501', message = 'contact company: the change was refused';
  end if;
  return jsonb_build_object('company_id', v_company, 'how', v_how);
end $$;
revoke all on function public.crm_contact_company(uuid, uuid, integer, text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.crm_contact_company(uuid, uuid, integer, text, uuid) to authenticated;

-- ═══ 9. Postconditions (P-14: under both Supabase grant regimes) ═════════════════════════
do $$
declare
  v_maintain boolean := current_setting('server_version_num')::int >= 170000;
  v_got text[];
  v_fn text;
  r text;
begin
  -- ---- 1. RLS and policies ----------------------------------------------------------------
  if not exists (select 1 from pg_class
                  where oid = 'public.crm_companies'::regclass and relrowsecurity and relforcerowsecurity) then
    raise exception 'C11: crm_companies must have RLS enabled and forced';
  end if;
  select array_agg(policyname::text || ':' || cmd || ':' || permissive order by policyname collate "C")
    into v_got
    from pg_policies where schemaname = 'public' and tablename = 'crm_companies';
  if v_got is distinct from array['crm_companies_delete:DELETE:PERMISSIVE', 'crm_companies_insert:INSERT:PERMISSIVE',
                                  'crm_companies_live:ALL:RESTRICTIVE', 'crm_companies_read:SELECT:PERMISSIVE',
                                  'crm_companies_update:UPDATE:PERMISSIVE'] then
    raise exception 'C11: the crm_companies policies are %', v_got;
  end if;
  if exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = 'crm_companies'
                and (roles <> array['authenticated']::name[]
                     or coalesce(qual, with_check) !~ '^\(\(tenant_id = (app\.)?effective_tenant_id\(\)\) AND (app\.)?role_crm_contacts\('
                     or (with_check is not null
                         and with_check !~ '^\(\(tenant_id = (app\.)?effective_tenant_id\(\)\) AND (app\.)?role_crm_contacts\('))) then
    raise exception 'C11: a crm_companies policy is not TO authenticated, or does not lead with the tenant predicate and the crm.contacts helper';
  end if;
  if not exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'crm_companies' and policyname = 'crm_companies_live'
                    and qual ~ 'live_role\(\)' and with_check ~ 'live_role\(\)') then
    raise exception 'C11: crm_companies_live lacks the live check';
  end if;

  -- ---- 2. Grants ----------------------------------------------------------------------------
  foreach r in array array['public', 'anon'] loop
    if has_table_privilege(r::name, 'public.crm_companies',
                           'select, insert, update, delete, truncate, references, trigger')
       or has_any_column_privilege(r::name, 'public.crm_companies', 'select, insert, update, references')
       or (case when v_maintain then has_table_privilege(r::name, 'public.crm_companies', 'maintain')
                else false end) then
      raise exception 'C11: % holds a privilege on crm_companies', r;
    end if;
  end loop;
  foreach r in array array['authenticated', 'service_role'] loop
    if has_table_privilege(r::name, 'public.crm_companies', 'truncate, references, trigger')
       or has_any_column_privilege(r::name, 'public.crm_companies', 'references')
       or (case when v_maintain then has_table_privilege(r::name, 'public.crm_companies', 'maintain')
                else false end) then
      raise exception 'C11: % holds TRUNCATE, REFERENCES, TRIGGER or MAINTAIN on crm_companies', r;
    end if;
  end loop;
  if has_table_privilege('authenticated', 'public.crm_companies', 'select')
     or has_table_privilege('authenticated', 'public.crm_companies', 'insert')
     or has_table_privilege('authenticated', 'public.crm_companies', 'update')
     or not has_table_privilege('authenticated', 'public.crm_companies', 'delete') then
    raise exception 'C11: authenticated must hold DELETE on crm_companies, and SELECT, INSERT and UPDATE on named columns only';
  end if;
  if has_column_privilege('authenticated', 'public.crm_companies', 'domain_hmac', 'select, insert, update') then
    raise exception 'C11: authenticated reaches crm_companies.domain_hmac';
  end if;
  select coalesce(array_agg(a.attname::text order by a.attname::text collate "C"), '{}') into v_got
    from pg_attribute a
   where a.attrelid = 'public.crm_companies'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', a.attrelid, a.attnum, 'insert');
  if v_got is distinct from array['city', 'client_id', 'name', 'notes', 'owner_id', 'sector_id', 'size',
                                  'stage', 'tenant_id', 'website'] then
    raise exception 'C11: authenticated inserts the crm_companies columns %', v_got;
  end if;
  select coalesce(array_agg(a.attname::text order by a.attname::text collate "C"), '{}') into v_got
    from pg_attribute a
   where a.attrelid = 'public.crm_companies'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', a.attrelid, a.attnum, 'update');
  if v_got is distinct from array['city', 'client_id', 'name', 'notes', 'owner_id', 'sector_id', 'size',
                                  'stage', 'website'] then
    raise exception 'C11: authenticated updates the crm_companies columns %', v_got;
  end if;
  if not has_table_privilege('service_role', 'public.crm_companies', 'select, insert, update, delete') then
    raise exception 'C11: the service role must hold SELECT, INSERT, UPDATE and DELETE on crm_companies';
  end if;
  if not has_column_privilege('authenticated', 'public.crm_contacts', 'company_id', 'update')
     or has_column_privilege('anon', 'public.crm_contacts', 'company_id', 'select, update')
     or has_column_privilege('authenticated', 'public.crm_contact_channels', 'domain_hmac', 'select, insert, update')
     or has_column_privilege('anon', 'public.crm_contact_channels', 'domain_hmac', 'select, insert, update') then
    raise exception 'C11: the grants on crm_contacts.company_id or crm_contact_channels.domain_hmac are wrong';
  end if;

  -- ---- 3. Functions -------------------------------------------------------------------------
  -- The readers and writers: INVOKER, executable by authenticated alone.
  foreach v_fn in array array['public.crm_companies_list(uuid, jsonb)',
                              'public.crm_company_read(uuid, uuid)',
                              'public.crm_company_create(uuid, jsonb)',
                              'public.crm_company_update(uuid, uuid, integer, jsonb)',
                              'public.crm_company_delete(uuid, uuid, integer)',
                              'public.crm_contact_company(uuid, uuid, integer, text, uuid)',
                              'app.crm_company_json(uuid, uuid)',
                              'app.crm_company_contacts(uuid, uuid)',
                              'app.crm_company_won_value(uuid, uuid)',
                              'app.crm_company_tenant_ok(uuid)',
                              'app.crm_company_body_ok(jsonb)'] loop
    if exists (select 1 from pg_proc where oid = v_fn::regprocedure and prosecdef) then
      raise exception 'C11: % must be SECURITY INVOKER', v_fn;
    end if;
    if has_function_privilege('anon', v_fn, 'execute')
       or has_function_privilege('service_role', v_fn, 'execute')
       or not has_function_privilege('authenticated', v_fn, 'execute')
       or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                   where p.oid = v_fn::regprocedure and a.grantee = 0) then
      raise exception 'C11: % must be executable by authenticated alone', v_fn;
    end if;
  end loop;
  -- The service role's door: INVOKER, the service role alone.
  if exists (select 1 from pg_proc where oid = 'public.crm_lead_domain(uuid, uuid, text)'::regprocedure and prosecdef)
     or has_function_privilege('anon', 'public.crm_lead_domain(uuid, uuid, text)', 'execute')
     or has_function_privilege('authenticated', 'public.crm_lead_domain(uuid, uuid, text)', 'execute')
     or not has_function_privilege('service_role', 'public.crm_lead_domain(uuid, uuid, text)', 'execute') then
    raise exception 'C11: public.crm_lead_domain must be an INVOKER the service role alone executes';
  end if;
  -- The definers: an empty search_path, owned by a role that bypasses RLS, executable by no
  -- API role (triggers run them).
  foreach v_fn in array array['app.tg_crm_company_row()', 'app.tg_crm_company_rename()',
                              'app.tg_crm_contact_company()', 'app.tg_crm_company_orphan()',
                              'app.tg_lead_company()', 'app.tg_crm_channel_company()',
                              'app.crm_company_autolink(uuid, uuid, text, text)'] loop
    if not exists (select 1 from pg_proc f join pg_roles o on o.oid = f.proowner
                    where f.oid = v_fn::regprocedure and f.prosecdef
                      and f.proconfig[1] = 'search_path=""'
                      and (o.rolsuper or o.rolbypassrls)) then
      raise exception 'C11: % is not a definer with an empty search_path owned by a role that bypasses RLS', v_fn;
    end if;
    if has_function_privilege('anon', v_fn, 'execute')
       or has_function_privilege('authenticated', v_fn, 'execute')
       or has_function_privilege('service_role', v_fn, 'execute') then
      raise exception 'C11: % is executable by an API role', v_fn;
    end if;
  end loop;
  -- Every function this migration makes pins its search_path (Supabase advisor lint 0011).
  foreach v_fn in array array['public.crm_companies_list(uuid, jsonb)', 'public.crm_company_read(uuid, uuid)',
                              'public.crm_company_create(uuid, jsonb)',
                              'public.crm_company_update(uuid, uuid, integer, jsonb)',
                              'public.crm_company_delete(uuid, uuid, integer)',
                              'public.crm_contact_company(uuid, uuid, integer, text, uuid)',
                              'public.crm_lead_domain(uuid, uuid, text)',
                              'app.crm_company_json(uuid, uuid)', 'app.crm_company_tenant_ok(uuid)',
                              'app.crm_company_contacts(uuid, uuid)', 'app.crm_company_won_value(uuid, uuid)',
                              'app.crm_company_body_ok(jsonb)'] loop
    if not exists (select 1 from pg_proc f, unnest(f.proconfig) c
                    where f.oid = v_fn::regprocedure and c like 'search_path=%') then
      raise exception 'C11: % does not pin its search_path', v_fn;
    end if;
  end loop;

  -- ---- 4. Triggers ------------------------------------------------------------------------
  select array_agg(format('%s %s', t.tgname, f.proname) order by t.tgname collate "C") into v_got
    from pg_trigger t join pg_proc f on f.oid = t.tgfoid
   where t.tgrelid = 'public.crm_companies'::regclass and not t.tgisinternal and t.tgenabled::text = 'O';
  if v_got is distinct from array['crm_companies_rename tg_crm_company_rename', 'crm_companies_row tg_crm_company_row'] then
    raise exception 'C11: the triggers on crm_companies are %', v_got;
  end if;
  -- The mirror must fire before C5's row rules (name order), so they see the name it sets.
  if not ('crm_contacts_company' collate "C" < 'crm_contacts_row' collate "C")
     or not exists (select 1 from pg_trigger where tgrelid = 'public.crm_contacts'::regclass
                     and tgname = 'crm_contacts_row')
     or (select count(*) from pg_trigger
          where (tgrelid, tgname) in (('public.crm_contacts'::regclass, 'crm_contacts_company'),
                                      ('public.crm_contacts'::regclass, 'crm_contacts_company_orphan'),
                                      ('public.leads'::regclass, 'leads_contact_company'),
                                      ('public.crm_contact_channels'::regclass, 'crm_contact_channels_company'))
            and tgenabled::text = 'O') <> 4 then
    raise exception 'C11: the company triggers on contacts, leads and channels are not all in place';
  end if;

  -- ---- 5. Nothing yet ------------------------------------------------------------------------
  if exists (select 1 from public.crm_companies)
     or exists (select 1 from public.crm_contacts where company_id is not null) then
    raise exception 'C11: companies exist before the migration made them';
  end if;
end $$;
