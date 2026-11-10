-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 0131 — CRM contacts (Admin v2 C5, crm.md CRM-5). Forward-only, EXPAND only. HELD: the PR
-- merges only after the owner's lawyer signs off the privacy-notice update (owner item O-11,
-- docs/legal/privacy-notice-c5.md, register L-2). The number is a placeholder: the merge
-- train assigns it (scripts/renumber-migration.mjs). Depends on 0033 (app.live_role), 0034
-- (lead_events, lead_notes, app.lead_retention_months), 0035 (the blind indexes), 0036
-- (app.normalize_ar_q in a generated column), 0041 (app.tags_ok, app.crm_eraser_ok,
-- crm_erase_lead, profiles (tenant_id, id)), 0091 (crm_ingest_lead as restated, the
-- assignment), 0113 (app.tg_lead_pipeline as restated, leads_safe's list) and 0129 (every
-- staff-writable table carries a RESTRICTIVE live policy per command).
--
-- WHAT IT ADDS
--   1. crm.contacts, a new capability, Admin only (Developer none: owner default O-7; Sales
--      only from C10b), and its one SQL helper app.role_crm_contacts
--      (tests/authz/sqlHelpers.spec.ts holds it equal to ROLE_CAPS).
--   2. Four tables, each RLS ENABLE + FORCE, grants stated for both Supabase regimes (P-14),
--      the tenant predicate first in every policy, a RESTRICTIVE live check on every table a
--      staff token can reach:
--        • crm_contacts: a person. Staff holding crm.contacts read it and change its
--          details (a column UPDATE grant); nobody inserts or deletes one through the API
--          (adding a contact encrypts its e-mail, so it is C6's service-role door; removal
--          is erasure or retention). No stored value or score (derived in C6's reader).
--        • crm_contact_channels: an e-mail or phone of a contact, the lead's ciphertext
--          copied as it is (the same key and purpose, LEAD_PII_ENC_KEY), with its blind
--          index. One e-mail per tenant (a partial unique index: one e-mail, one person);
--          phones are shared (an office line), so not unique. Staff read whether a
--          channel exists, never its value or index (a column SELECT grant).
--        • crm_contact_notes: as lead_notes is built (0034): no policy, the service role
--          only (the audited door is C6's), append-only.
--        • crm_contact_events: the contact's timeline, metadata only, written by the definer
--          triggers below; staff read it.
--   3. leads.contact_id (a composite key to a contact of the lead's own tenant, ON DELETE SET
--      NULL (contact_id)) and leads.contact_link (how the link was made: 'email', 'phone',
--      'new', or 'staff' from C6; null = never linked). 'phone' IS the flag: "Linked by
--      phone, please check" (README C5, the phone link-and-flag). Lead workers read both
--      (appended to leads_safe and the column SELECT grant); nobody writes them through the
--      API yet (C6). Both are derived for the BEFORE phase (app.tg_lead_pipeline restated
--      with them in c_derived, nothing else changed): linking a lead is not an edit and
--      never moves its version.
--   4. Linking (app.crm_link_lead_core, a definer the service role's doors call): the
--      e-mail's blind index first (under a per-address advisory lock, the unique index
--      behind it, so two leads from one new address make one contact); else a phone match
--      links to the most recently active contact with that phone and flags the link (the
--      lead's e-mail is NOT added to that contact: a person checks first); else a new
--      contact from the lead's name, company and language, with the lead's channels. A
--      spam lead is never linked. The lead's timeline gets `contact_linked`, the contact's
--      `lead_linked`; a linked lead in a won stage makes its contact a client; an assignee
--      who holds crm.contacts becomes an empty contact's owner.
--   5. Arrival (crm_ingest_lead restated, the allow-list unchanged): after the insert the
--      link runs in its own sub-transaction. ANY error there is caught: a WARNING, the lead
--      stays, the daily cron links it later. The public form is never blocked by it.
--   6. public.crm_link_lead and public.crm_link_backfill: the service role's doors (the
--      daily cron's CRM step, src/lib/crm/linkBackfill.ts). No decryption: the ciphertext
--      is copied, the indexes compared.
--   7. Retention from last activity (docs/retention.md): last_activity_at advances when a
--      linked lead arrives (its own time), is moved, contacted or noted, when a contact note
--      is added or its stage changes; never on a detail edit, a star, an assignment, a value
--      or spam. app.purge_crm() (called by app.run_retention(), restated) deletes contacts
--      idle past leads_months and orphan auto-contacts (made by the system, never edited,
--      not starred, no lead, no note); channels, notes and events go by cascade.
--   8. Person erasure (crm.md §8.2, crm.erase, Admin): public.crm_erase_preview and
--      public.crm_erase_person, the service role's, each checking the acting profile live
--      (app.crm_eraser_ok). The person's leads (linked by e-mail, created with the contact
--      or by a person, or carrying one of its e-mail indexes) go; phone matches only when
--      the Admin ticked them (each must be one); then the contact, its channels, notes and
--      events. crm_erase_lead restated: an auto-contact left with nothing goes with its lead.
--
-- Production behaviour before any C6/C7 screen exists: a lead arriving through the form or
-- by hand is linked (documented above; it adds one timeline line, "Linked to a contact");
-- nothing else about leads changes. Rule 5 (the deployed Worker between the push and the
-- deploy): leads_safe gains two trailing columns no deployed reader selects (every reader
-- names its columns); crm_erase_lead answers one more key, which the erase route's
-- counts() ignores (src/pages/api/admin/leads/[id]/erase.ts reads named keys only);
-- crm_ingest_lead keeps its signature and answer.
-- ─────────────────────────────────────────────────────────────────────────────────────────

-- A busy table fails the push instead of queueing behind it (0041's reason): this locks
-- leads (two columns, a foreign key) and profiles (the owner key's referenced side).
set local lock_timeout = '5s';

-- ═══ 1. The capability helper ═══════════════════════════════════════════════════════════
create or replace function app.role_crm_contacts(r text) returns boolean
  language sql immutable
as $$ select coalesce(r in ('admin'), false) $$;  -- crm.contacts
revoke all on function app.role_crm_contacts(text) from public, anon, authenticated, service_role;
grant execute on function app.role_crm_contacts(text) to authenticated, service_role;

-- ═══ 2. Folding for search and the merge finder (generated columns: immutable) ════════════
-- The search text, folded as leads' is (app.lead_search_text, 0036): app.normalize_ar_q, so
-- C6's contains search folds the query the same way.
create or replace function app.crm_contact_search_text(p_name text, p_company text, p_title text)
  returns text language sql immutable as $$
  select lower(coalesce(app.normalize_ar_q(
    coalesce(p_name, '') || ' ' || coalesce(p_company, '') || ' ' || coalesce(p_title, '')), ''))
$$;
-- The name as the merge finder (C12) compares it: folded, lower-cased, with a leading
-- al-/el-/ال dropped from each word ("Al Rashid", "El-Rashid", "الرشيد" meet).
create or replace function app.crm_name_key(p_name text) returns text
  language sql immutable as $$
  select btrim(regexp_replace(
    regexp_replace(lower(coalesce(app.normalize_ar(coalesce(p_name, '')), '')),
                   '(^|\s)(al-|el-|al |el |ال)', '\1', 'g'),
    '\s+', ' ', 'g'))
$$;
-- A STORED generated column is computed in the writer's session (0036), so every writer
-- of crm_contacts executes both.
revoke all on function app.crm_contact_search_text(text, text, text) from public, anon, authenticated, service_role;
grant execute on function app.crm_contact_search_text(text, text, text) to authenticated, service_role;
revoke all on function app.crm_name_key(text) from public, anon, authenticated, service_role;
grant execute on function app.crm_name_key(text) to authenticated, service_role;

-- ═══ 3. The tables ════════════════════════════════════════════════════════════════════════
create table public.crm_contacts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default app.effective_tenant_id() references public.tenants (id) on delete cascade,
  display_name text not null
    check (char_length(btrim(display_name)) between 1 and 120 and display_name !~ '[[:cntrl:]]'),
  name_key text generated always as (app.crm_name_key(display_name)) stored,
  title text check (title is null or (char_length(title) <= 120 and title !~ '[[:cntrl:]]')),
  company_name text
    check (company_name is null or (char_length(company_name) <= 120 and company_name !~ '[[:cntrl:]]')),
  stage text not null default 'lead' check (stage in ('lead', 'client', 'past', 'partner')),
  -- How they found us. 'import' is reserved for C15.
  source text not null default 'manual' check (source in (
    'web_form', 'manual', 'referral', 'instagram', 'event', 'google', 'linkedin', 'direct',
    'whatsapp', 'import')),
  owner_id uuid,
  locale text not null default 'en' check (locale in ('en', 'ar')),
  city text check (city is null or (char_length(city) <= 80 and city !~ '[[:cntrl:]]')),
  country text check (country is null or country ~ '^[A-Z]{2}$'),
  tags text[] not null default '{}' check (app.tags_ok(tags)),
  -- Custom field values (C9b defines the fields; the API validates against them).
  custom jsonb not null default '{}'::jsonb
    check (jsonb_typeof(custom) = 'object' and pg_column_size(custom) < 8192),
  is_starred boolean not null default false,
  -- Retention runs from here (docs/retention.md): see the triggers below for what moves it.
  last_activity_at timestamptz not null default now(),
  -- Merge tombstones (C12).
  merged_into uuid,
  merged_at timestamptz,
  search_text text generated always as (app.crm_contact_search_text(display_name, company_name, title)) stored,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Null: made by the system (a lead's arrival or the backfill). Never client-chosen.
  created_by uuid,
  updated_by uuid,
  constraint crm_contacts_tenant_id_id unique (tenant_id, id),
  constraint crm_contacts_owner_fk foreign key (tenant_id, owner_id)
    references public.profiles (tenant_id, id) on delete set null (owner_id),
  constraint crm_contacts_merged_fk foreign key (tenant_id, merged_into)
    references public.crm_contacts (tenant_id, id) on delete set null (merged_into),
  constraint crm_contacts_merged_pair
    check ((merged_into is null) = (merged_at is null) and merged_into is distinct from id)
);
create index crm_contacts_list_idx on public.crm_contacts (tenant_id, stage, last_activity_at desc)
  where merged_into is null;
create index crm_contacts_activity_idx on public.crm_contacts (tenant_id, last_activity_at);
create index crm_contacts_owner_idx on public.crm_contacts (tenant_id, owner_id) where owner_id is not null;
create index crm_contacts_merged_idx on public.crm_contacts (tenant_id, merged_into) where merged_into is not null;
-- pg_trgm's operator class unqualified, as 0006 and 0036 name it (the migration role's
-- search_path finds the extension wherever it is installed).
create index crm_contacts_search_trgm_idx on public.crm_contacts using gin (search_text gin_trgm_ops);
create index crm_contacts_name_key_trgm_idx on public.crm_contacts using gin (name_key gin_trgm_ops);
alter table public.crm_contacts enable row level security;
alter table public.crm_contacts force row level security;

create table public.crm_contact_channels (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  contact_id uuid not null,
  kind text not null check (kind in ('email', 'phone')),
  -- AES-GCM ciphertext under LEAD_PII_ENC_KEY, copied from the lead as it is (no decrypt).
  value_enc text not null check (char_length(value_enc) between 1 and 4096),
  -- The blind index (crm-index/v1, tenant-salted, kind-separated: 0035).
  value_hmac text not null check (value_hmac ~ '^[0-9a-f]{64}$'),
  is_primary boolean not null default false,
  -- 'manual' (C6), 'merge' (C12), 'import' (C15) are reserved.
  source text not null default 'lead' check (source in ('lead', 'manual', 'merge', 'import')),
  created_at timestamptz not null default now(),
  created_by uuid,
  constraint crm_contact_channels_contact_fk foreign key (tenant_id, contact_id)
    references public.crm_contacts (tenant_id, id) on delete cascade
);
-- One e-mail, one person.
create unique index crm_contact_channels_one_email on public.crm_contact_channels (tenant_id, value_hmac)
  where kind = 'email';
-- A contact holds a value once (and this leads with the foreign key's columns).
create unique index crm_contact_channels_once on public.crm_contact_channels (tenant_id, contact_id, kind, value_hmac);
create unique index crm_contact_channels_one_primary on public.crm_contact_channels (contact_id, kind)
  where is_primary;
-- Phone lookups (phones are not unique).
create index crm_contact_channels_lookup_idx on public.crm_contact_channels (tenant_id, kind, value_hmac);
alter table public.crm_contact_channels enable row level security;
alter table public.crm_contact_channels force row level security;

create table public.crm_contact_notes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  contact_id uuid not null,
  body text not null check (char_length(body) between 1 and 5000),
  created_by uuid,
  created_at timestamptz not null default now(),
  constraint crm_contact_notes_contact_fk foreign key (tenant_id, contact_id)
    references public.crm_contacts (tenant_id, id) on delete cascade
);
create index crm_contact_notes_contact_idx on public.crm_contact_notes (tenant_id, contact_id, created_at desc);
alter table public.crm_contact_notes enable row level security;
alter table public.crm_contact_notes force row level security;
-- No policies: the service role (C6's audited door) and the definer code are its only
-- readers and writers, as for lead_notes (0034). No API role may UPDATE it: append-only.

create table public.crm_contact_events (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  contact_id uuid not null,
  at timestamptz not null default now(),
  actor_id uuid,
  kind text not null check (kind in (
    'created', 'stage_changed', 'owner_changed', 'details_changed', 'lead_linked',
    'channel_added', 'channel_removed', 'note_added', 'note_deleted', 'task_created',
    'task_done', 'merged')),
  -- Metadata only: ids, keys, field names. Never a note body or contact details.
  detail jsonb not null default '{}'::jsonb
    check (jsonb_typeof(detail) = 'object' and pg_column_size(detail) < 2048),
  constraint crm_contact_events_contact_fk foreign key (tenant_id, contact_id)
    references public.crm_contacts (tenant_id, id) on delete cascade
);
create index crm_contact_events_contact_idx on public.crm_contact_events (tenant_id, contact_id, at desc);
alter table public.crm_contact_events enable row level security;
alter table public.crm_contact_events force row level security;

-- ═══ 4. leads: the link ═══════════════════════════════════════════════════════════════════
alter table public.leads
  add column contact_id uuid,
  add column contact_link text;
alter table public.leads add constraint leads_contact_link_ok
  check ((contact_link is null or contact_link in ('email', 'phone', 'new', 'staff'))
         and (contact_id is null or contact_link is not null));
alter table public.leads add constraint leads_contact_fk foreign key (tenant_id, contact_id)
  references public.crm_contacts (tenant_id, id) on delete set null (contact_id);
create index leads_contact_idx on public.leads (tenant_id, contact_id) where contact_id is not null;
-- The backfill's queue: leads never linked, oldest first.
create index leads_unlinked_idx on public.leads (created_at, id) where contact_link is null;

-- ═══ 5. The BEFORE phase, with the link derived ═══════════════════════════════════════════
-- 0113's function, byte for byte, but for the two link columns in c_derived (C5): linking a
-- lead, or the link going when its contact does (ON DELETE SET NULL), is not an edit.
create or replace function app.tg_lead_pipeline() returns trigger
  language plpgsql security definer set search_path = '' as $$
declare
  -- What the CRM works out for itself (the blind indexes, the score and its reasons, the
  -- index cursor: 0035, 0036). A write that changes only these is not an edit.
  c_derived constant text[] := array['email_hmac', 'phone_hmac', 'score', 'score_signals',
    'crm_indexed_at', 'search_text', 'updated_at', 'updated_by',
    -- (C5) The contact link, set by the link and cleared when its contact goes.
    'contact_id', 'contact_link'];
  -- (0041) Looking at a lead or starring it is not editing it either.
  c_marks constant text[] := array['read_at', 'read_by', 'is_starred'];
  v_skip constant text[] := c_derived || c_marks;
  v_edited boolean := true;
  v_kind text;
  v_initial boolean;
  v_old_kind text;
  v_old_initial boolean;
  v_moved boolean := false;
  v_marking boolean := false;
  v_clearing boolean := false;
  v_check_assignee boolean := false;
  v_logged boolean := false;
  v_default timestamptz;
begin
  -- 0. Is this write an edit? Read before any step below changes NEW. (A generated column
  --    reads as null in NEW here; search_text is in the list for that reason too.)
  if tg_op = 'UPDATE' then
    v_edited := (to_jsonb(new) - v_skip) is distinct from (to_jsonb(old) - v_skip);
  end if;

  -- 1. The number, on arrival: a per-tenant counter, never reused. (BEFORE INSERT fires
  --    even for a row ON CONFLICT then skips, so a caller that may retry checks first.)
  if tg_op = 'INSERT' then
    insert into app.lead_counters as c (tenant_id, last_number)
    values (new.tenant_id, 1)
    on conflict (tenant_id) do update set last_number = c.last_number + 1
    returning c.last_number into new.lead_number;
  end if;

  -- 2. (C14b) The stage on arrival: a lead that names none (the contact form's fallback
  --    insert, a manual or ingested lead) starts in its tenant's initial stage. A tenant
  --    with no initial stage finds none, and NOT NULL on stage_id refuses the row.
  if tg_op = 'INSERT' and new.stage_id is null then
    select s.id into new.stage_id
      from public.lead_stages s
     where s.tenant_id = new.tenant_id and s.is_initial;
  end if;

  select s.kind, s.is_initial into v_kind, v_initial
    from public.lead_stages s
   where s.tenant_id = new.tenant_id and s.id = new.stage_id;
  -- A stage id of another tenant (or none) finds nothing here; the composite foreign key
  -- refuses the row at the end of the statement.

  if tg_op = 'INSERT' then
    v_marking := new.is_spam;
  else
    v_moved := new.stage_id is distinct from old.stage_id;
    v_marking := new.is_spam and not old.is_spam;
    v_clearing := old.is_spam and not new.is_spam;
  end if;
  if v_moved then
    select s.kind, s.is_initial into v_old_kind, v_old_initial
      from public.lead_stages s
     where s.tenant_id = old.tenant_id and s.id = old.stage_id;
  end if;

  -- 3. The spam horizon (D2). Marking caps it at spam_days from now, never lengthening
  --    it, and saves the horizon it had. Clearing gives that back, but never more than a
  --    horizon set while the lead was flagged, or by this same write: an erasure
  --    (docs/retention.md) shortens retention_delete_after, and un-marking spam must not
  --    undo it. (OLD is read only on UPDATE: nested IFs, because SQL does not promise to
  --    test tg_op first inside one expression.)
  if v_marking then
    new.spam_marked_at := now();
    new.retention_before_spam := new.retention_delete_after;
    new.retention_delete_after := least(
      coalesce(new.retention_delete_after,
               new.created_at + make_interval(months => app.lead_retention_months(new.tenant_id))),
      now() + make_interval(days => app.lead_spam_days(new.tenant_id)));
  elsif tg_op = 'UPDATE' then
    if old.is_spam then
      if new.retention_delete_after is distinct from old.retention_delete_after then
        v_default := new.created_at
                     + make_interval(months => app.lead_retention_months(new.tenant_id));
        if new.retention_delete_after < coalesce(old.retention_before_spam, v_default) then
          new.retention_before_spam := new.retention_delete_after;
        end if;
      end if;
      if v_clearing then
        new.spam_marked_at := null;
        new.retention_delete_after := new.retention_before_spam;
        new.retention_before_spam := null;
      end if;
    end if;
  end if;

  -- 3b. (0041) The assignee: an active profile of this lead's tenant whose role works
  --     leads, checked when it is set or changes (an assignee deactivated later does not
  --     block unrelated writes). The message names a constraint so the Worker can say
  --     which field is wrong (crud.ts constraintOf).
  if new.assigned_to is not null then
    if tg_op = 'INSERT' then
      v_check_assignee := true;
    elsif new.assigned_to is distinct from old.assigned_to then
      v_check_assignee := true;
    end if;
  end if;
  if v_check_assignee and not exists (
       select 1 from public.profiles p
        where p.id = new.assigned_to
          and p.tenant_id = new.tenant_id
          and p.is_active
          and app.role_works_leads(p.role::text)) then
    raise exception using errcode = '23514',
      message = 'the assignee must be an active lead worker of this tenant (constraint "leads_assignee_active")';
  end if;

  -- 3c. (0041) The marks the server sets. The read mark is the FIRST look: setting it again
  --     keeps the time and the person, clearing it clears both, and who looked is always
  --     the session (read_by has no UPDATE grant). A logged contact takes the server's
  --     time, whatever the client sent.
  if tg_op = 'UPDATE' then
    if new.read_at is distinct from old.read_at then
      if new.read_at is null then
        new.read_by := null;
      elsif old.read_at is not null then
        new.read_at := old.read_at;
        new.read_by := old.read_by;
      else
        new.read_at := now();
        new.read_by := auth.uid();
      end if;
    elsif new.read_by is distinct from old.read_by then
      new.read_by := old.read_by;
    end if;
    if new.last_contact_channel is not null then
      if new.last_contact_at is distinct from old.last_contact_at
         or new.last_contact_channel is distinct from old.last_contact_channel then
        new.last_contact_at := now();
        v_logged := true;
      end if;
    end if;
  end if;

  -- 4. Pipeline stamps, on a real move only (a note, a write that keeps the stage or the
  --    index cron never stamps): the first response is the first time a lead LEAVES the
  --    initial stage, and won_at is when it enters a won stage. A lead the 0034 backfill
  --    mapped past New keeps a null first response; a manual add sets its own (0041,
  --    crm_ingest_lead).
  if v_moved and v_old_initial and v_initial is false and new.first_response_at is null then
    new.first_response_at := now();
  end if;
  -- (0041) A contact logged while the lead is still in the initial stage answers it too.
  -- Not on a lead already past it: when THAT one was first answered is not known.
  if v_logged and v_initial and new.first_response_at is null then
    new.first_response_at := now();
  end if;
  if v_kind is distinct from 'won' then
    new.won_at := null;
  elsif new.won_at is null
        and (tg_op = 'INSERT' or (v_moved and v_old_kind is distinct from 'won')) then
    new.won_at := now();
  end if;

  -- 5. The version moves only when a versioned field does: the stage, the spam flag and
  --    (0041) the assignee, the value and the tags. A note, a stamp, a star, a read mark or
  --    a logged contact never causes a 409.
  if tg_op = 'UPDATE' then
    if (v_moved
        or new.is_spam is distinct from old.is_spam
        or new.assigned_to is distinct from old.assigned_to
        or new.value_sar is distinct from old.value_sar
        or new.tags is distinct from old.tags)
       and new.version = old.version then
      new.version := old.version + 1;
    end if;
  end if;

  -- 6. Who changed the lead, and when (app.tg_set_actor's and app.tg_set_updated_at's job,
  --    done here so nothing later in the phase can undo it). A write that is not an edit
  --    (step 0) keeps both: the index cron never makes a lead look freshly edited, or
  --    erases who last moved it. The person is the session's; a service-role write has no
  --    session, so it names whom it was made for itself: a lead added by hand is its
  --    creator's (crm_ingest_lead). (C14b) A service-role edit is otherwise no one's: the
  --    one door that named its person another way edits no lead any more.
  if tg_op = 'INSERT' then
    new.created_by := coalesce(new.created_by, auth.uid());
    new.updated_by := coalesce(auth.uid(), new.created_by);
  elsif v_edited then
    new.updated_at := now();
    new.updated_by := auth.uid();
  else
    new.updated_at := old.updated_at;
    new.updated_by := old.updated_by;
  end if;
  return new;
end $$;
revoke all on function app.tg_lead_pipeline() from public, anon, authenticated, service_role;


-- ═══ 6. The contact's own triggers ════════════════════════════════════════════════════════
-- Moving a contact's last activity forward (never back). A definer: the link, the lead
-- triggers and the note door reach a contact their caller may not read. The `<` keeps a
-- write that changes nothing from being made.
create or replace function app.crm_touch(p_tenant uuid, p_contact uuid, p_at timestamptz)
  returns void language sql volatile security definer set search_path = '' as $$
  update public.crm_contacts c
     set last_activity_at = p_at
   where c.tenant_id = p_tenant and c.id = p_contact and c.last_activity_at < p_at
$$;
revoke all on function app.crm_touch(uuid, uuid, timestamptz) from public, anon, authenticated, service_role;

-- BEFORE INSERT OR UPDATE: who and when, the version, the owner rule, and activity on a
-- stage change. Modelled on app.tg_lead_pipeline: a write that changes only what the CRM
-- derives (the activity time, the generated columns, the stamps) or marks (the star) is
-- not an edit, so the system's writes never cause a 409 or make a contact look edited. A
-- definer, because the owner rule reads a colleague's profile, which a staff token cannot.
create or replace function app.tg_crm_contact_row() returns trigger
  language plpgsql security definer set search_path = '' as $$
declare
  c_skip constant text[] := array['last_activity_at', 'is_starred', 'name_key', 'search_text',
    'updated_at', 'updated_by', 'version'];
  v_edited boolean := true;
begin
  if tg_op = 'UPDATE' then
    v_edited := (to_jsonb(new) - c_skip) is distinct from (to_jsonb(old) - c_skip);
  end if;

  -- The owner: an active profile of this tenant that holds crm.contacts, checked when it is
  -- set or changes (someone deactivated later blocks nothing). The message names a
  -- constraint so the Worker can say which field is wrong (crud.ts constraintOf).
  if new.owner_id is not null
     and (tg_op = 'INSERT' or new.owner_id is distinct from old.owner_id)
     and not exists (select 1 from public.profiles p
                      where p.id = new.owner_id and p.tenant_id = new.tenant_id and p.is_active
                        and app.role_crm_contacts(p.role::text)) then
    raise exception using errcode = '23514',
      message = 'the owner must be an active contacts user of this tenant (constraint "crm_contacts_owner_active")';
  end if;

  if tg_op = 'INSERT' then
    -- The session's person; a service-role door names whom it acts for in created_by; the
    -- system's own contacts (a lead's arrival, the backfill) have none.
    new.created_by := coalesce(auth.uid(), new.created_by);
    new.updated_by := new.created_by;
    new.created_at := now();
    new.updated_at := now();
    new.version := 1;
    return new;
  end if;

  new.created_by := old.created_by;
  new.created_at := old.created_at;
  -- A staff stage change is activity (a client, a partner: someone is working with them).
  if new.stage is distinct from old.stage then
    new.last_activity_at := greatest(old.last_activity_at, now());
  end if;
  if v_edited then
    new.updated_at := now();
    new.updated_by := auth.uid();
    if new.version = old.version then
      new.version := old.version + 1;
    end if;
  else
    new.updated_at := old.updated_at;
    new.updated_by := old.updated_by;
    new.version := old.version;
  end if;
  return new;
end $$;
revoke all on function app.tg_crm_contact_row() from public, anon, authenticated, service_role;
create trigger crm_contacts_row before insert or update on public.crm_contacts
  for each row execute function app.tg_crm_contact_row();

-- AFTER: the timeline. Field names and keys only, never a value a person typed.
create or replace function app.tg_crm_contact_events() returns trigger
  language plpgsql security definer set search_path = '' as $$
declare
  v_fields text[];
begin
  if tg_op = 'INSERT' then
    insert into public.crm_contact_events (tenant_id, contact_id, actor_id, kind, detail)
    values (new.tenant_id, new.id, auth.uid(), 'created', jsonb_build_object('source', new.source));
    return null;
  end if;
  if new.stage is distinct from old.stage then
    insert into public.crm_contact_events (tenant_id, contact_id, actor_id, kind, detail)
    values (new.tenant_id, new.id, auth.uid(), 'stage_changed',
            jsonb_build_object('from', old.stage, 'to', new.stage));
  end if;
  if new.owner_id is distinct from old.owner_id then
    insert into public.crm_contact_events (tenant_id, contact_id, actor_id, kind, detail)
    values (new.tenant_id, new.id, auth.uid(), 'owner_changed',
            jsonb_build_object('from', old.owner_id, 'to', new.owner_id));
  end if;
  select coalesce(array_agg(f order by f), '{}') into v_fields
    from unnest(array['display_name', 'title', 'company_name', 'source', 'locale', 'city',
                      'country', 'tags', 'custom']) f
   where to_jsonb(new) -> f is distinct from to_jsonb(old) -> f;
  if cardinality(v_fields) > 0 then
    insert into public.crm_contact_events (tenant_id, contact_id, actor_id, kind, detail)
    values (new.tenant_id, new.id, auth.uid(), 'details_changed',
            jsonb_build_object('fields', to_jsonb(v_fields)));
  end if;
  return null;
end $$;
revoke all on function app.tg_crm_contact_events() from public, anon, authenticated, service_role;
create trigger crm_contacts_events after insert or update of stage, owner_id, display_name, title,
  company_name, source, locale, city, country, tags, custom on public.crm_contacts
  for each row execute function app.tg_crm_contact_events();

-- A channel added (its kind and where it came from; never the value).
create or replace function app.tg_crm_channel_event() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  insert into public.crm_contact_events (tenant_id, contact_id, actor_id, kind, detail)
  values (new.tenant_id, new.contact_id, coalesce(auth.uid(), new.created_by), 'channel_added',
          jsonb_build_object('kind', new.kind, 'source', new.source));
  return null;
end $$;
revoke all on function app.tg_crm_channel_event() from public, anon, authenticated, service_role;
create trigger crm_contact_channels_event after insert on public.crm_contact_channels
  for each row execute function app.tg_crm_channel_event();

-- A note's event, in the statement that adds it (as app.tg_lead_note_event, 0034), and the
-- contact's activity.
create or replace function app.tg_crm_contact_note_event() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  insert into public.crm_contact_events (tenant_id, contact_id, at, actor_id, kind, detail)
  values (new.tenant_id, new.contact_id, new.created_at, new.created_by, 'note_added',
          jsonb_build_object('note_id', new.id));
  perform app.crm_touch(new.tenant_id, new.contact_id, new.created_at);
  return null;
end $$;
revoke all on function app.tg_crm_contact_note_event() from public, anon, authenticated, service_role;
create trigger crm_contact_notes_event after insert on public.crm_contact_notes
  for each row execute function app.tg_crm_contact_note_event();

-- ═══ 7. The lead side ═════════════════════════════════════════════════════════════════════
-- A linked lead's timeline is the person's activity: arriving, moving, being contacted,
-- a note (and, from C8, a task done; C12, a merge). Not an assignment, a value, spam, a
-- deleted note or the link itself (linking is the system's act, not the person's).
create or replace function app.tg_lead_event_contact_activity() returns trigger
  language plpgsql security definer set search_path = '' as $$
declare
  v_contact uuid;
begin
  if new.kind not in ('created', 'stage_changed', 'contact_logged', 'note_added', 'task_done', 'merged') then
    return null;
  end if;
  select l.contact_id into v_contact
    from public.leads l where l.tenant_id = new.tenant_id and l.id = new.lead_id;
  if v_contact is not null then
    perform app.crm_touch(new.tenant_id, v_contact, new.at);
  end if;
  return null;
end $$;
revoke all on function app.tg_lead_event_contact_activity() from public, anon, authenticated, service_role;
create trigger lead_events_contact_activity after insert on public.lead_events
  for each row execute function app.tg_lead_event_contact_activity();

-- AFTER UPDATE OF the link, the stage or the assignee, on a linked lead only (an unlinked
-- lead returns at once): the link's two timeline lines; a won lead makes its contact a
-- client (from lead or past; a partner stays a partner); the assignee fills an empty owner
-- when they hold crm.contacts (the owner rule above, so the update never refuses).
create or replace function app.tg_lead_contact() returns trigger
  language plpgsql security definer set search_path = '' as $$
declare
  v_linked boolean := new.contact_id is distinct from old.contact_id;
begin
  if new.contact_id is null then
    return null;
  end if;
  if v_linked then
    insert into public.lead_events (tenant_id, lead_id, actor_id, kind, detail)
    values (new.tenant_id, new.id, auth.uid(), 'contact_linked',
            jsonb_build_object('contact_id', new.contact_id, 'by', new.contact_link));
    insert into public.crm_contact_events (tenant_id, contact_id, actor_id, kind, detail)
    values (new.tenant_id, new.contact_id, auth.uid(), 'lead_linked',
            jsonb_build_object('lead_id', new.id, 'lead_number', new.lead_number,
                               'by', new.contact_link));
  end if;
  if (v_linked or new.stage_id is distinct from old.stage_id)
     and exists (select 1 from public.lead_stages s
                  where s.tenant_id = new.tenant_id and s.id = new.stage_id and s.kind = 'won') then
    update public.crm_contacts c set stage = 'client'
     where c.tenant_id = new.tenant_id and c.id = new.contact_id and c.stage in ('lead', 'past');
  end if;
  if new.assigned_to is not null and (v_linked or new.assigned_to is distinct from old.assigned_to) then
    update public.crm_contacts c set owner_id = new.assigned_to
     where c.tenant_id = new.tenant_id and c.id = new.contact_id and c.owner_id is null
       and exists (select 1 from public.profiles p
                    where p.id = new.assigned_to and p.tenant_id = new.tenant_id and p.is_active
                      and app.role_crm_contacts(p.role::text));
  end if;
  return null;
end $$;
revoke all on function app.tg_lead_contact() from public, anon, authenticated, service_role;
create trigger leads_contact after update of contact_id, stage_id, assigned_to on public.leads
  for each row execute function app.tg_lead_contact();

-- ═══ 8. Policies (crm.md §3.4) ════════════════════════════════════════════════════════════
create policy crm_contacts_read on public.crm_contacts for select to authenticated
  using (tenant_id = app.effective_tenant_id() and app.role_crm_contacts(app.current_role()));
create policy crm_contacts_update on public.crm_contacts for update to authenticated
  using (tenant_id = app.effective_tenant_id() and app.role_crm_contacts(app.current_role()))
  with check (tenant_id = app.effective_tenant_id() and app.role_crm_contacts(app.current_role()));
create policy crm_contacts_live on public.crm_contacts as restrictive for all to authenticated
  using (tenant_id = app.effective_tenant_id() and app.role_crm_contacts((select app.live_role())))
  with check (tenant_id = app.effective_tenant_id() and app.role_crm_contacts((select app.live_role())));

create policy crm_contact_channels_read on public.crm_contact_channels for select to authenticated
  using (tenant_id = app.effective_tenant_id() and app.role_crm_contacts(app.current_role()));
create policy crm_contact_channels_live on public.crm_contact_channels as restrictive for all to authenticated
  using (tenant_id = app.effective_tenant_id() and app.role_crm_contacts((select app.live_role())))
  with check (tenant_id = app.effective_tenant_id() and app.role_crm_contacts((select app.live_role())));

create policy crm_contact_events_read on public.crm_contact_events for select to authenticated
  using (tenant_id = app.effective_tenant_id() and app.role_crm_contacts(app.current_role()));
create policy crm_contact_events_live on public.crm_contact_events as restrictive for all to authenticated
  using (tenant_id = app.effective_tenant_id() and app.role_crm_contacts((select app.live_role())))
  with check (tenant_id = app.effective_tenant_id() and app.role_crm_contacts((select app.live_role())));

-- ═══ 9. Grants, stated (P-14: both Supabase regimes) ══════════════════════════════════════
revoke all on public.crm_contacts from public, anon, authenticated, service_role;
grant select on public.crm_contacts to authenticated;
grant update (display_name, title, company_name, stage, source, owner_id, locale, city, country,
              tags, custom, is_starred)
  on public.crm_contacts to authenticated;
grant select, insert, update, delete on public.crm_contacts to service_role;

revoke all on public.crm_contact_channels from public, anon, authenticated, service_role;
grant select (id, tenant_id, contact_id, kind, is_primary, source, created_at, created_by)
  on public.crm_contact_channels to authenticated;
grant select, insert, update, delete on public.crm_contact_channels to service_role;

revoke all on public.crm_contact_notes from public, anon, authenticated, service_role;
grant select, insert, delete on public.crm_contact_notes to service_role;

revoke all on public.crm_contact_events from public, anon, authenticated, service_role;
grant select on public.crm_contact_events to authenticated;
grant select, insert, delete on public.crm_contact_events to service_role;

-- leads: lead workers read the link (a contact's id and how it was made, never the
-- contact's details), and leads_safe carries it, appended (create or replace can only add
-- at the end, and must restate security_invoker or every role would read every lead).
grant select (contact_id, contact_link) on public.leads to authenticated;
create or replace view public.leads_safe with (security_invoker = true) as
select
  id, tenant_id, kind, locale, name, message, service_of_interest,
  consent_marketing, created_at, updated_at, company, discipline_of_interest,
  lead_number, stage_id, is_spam, spam_marked_at, first_response_at, won_at, version,
  created_by, updated_by, score, source, channel,
  assigned_to, value_sar, is_starred, read_at, read_by, tags, last_contact_at,
  last_contact_channel, contact_id, contact_link
from public.leads;
revoke all on public.leads_safe from public, anon, authenticated, service_role;
grant select on public.leads_safe to authenticated;

-- ═══ 10. Linking a lead to its contact ════════════════════════════════════════════════════
-- What happened to one lead: 'email' (an existing contact with its e-mail), 'phone' (the
-- most recently active contact with its phone: flagged), 'new' (a contact made from it),
-- or why it was left: 'done' (linked before, or its contact since removed: never relinked,
-- so a contact that retention or erasure removed does not come back), 'spam', 'unindexed'
-- (the cron indexes it first), 'no_index' (no e-mail or phone index), 'missing'.
-- A definer owned by a role that bypasses RLS: it writes four FORCE RLS tables for the
-- service role's doors (the only callers; no API role executes it).
create or replace function app.crm_link_lead_core(p_tenant uuid, p_lead uuid) returns text
  language plpgsql volatile security definer set search_path = '' as $$
declare
  l record;
  v_contact uuid;
  v_by text;
  v_n int;
begin
  select x.id, x.name, x.company, x.locale, x.source, x.email_enc, x.phone_enc, x.email_hmac,
         x.phone_hmac, x.contact_id, x.contact_link, x.is_spam, x.crm_indexed_at, x.created_at
    into l
    from public.leads x
   where x.tenant_id = p_tenant and x.id = p_lead
     for update;
  if not found then
    return 'missing';
  end if;
  if l.contact_id is not null or l.contact_link is not null then
    return 'done';
  end if;
  if l.is_spam then
    return 'spam';
  end if;
  if l.crm_indexed_at is null then
    return 'unindexed';
  end if;
  if l.email_hmac is null and l.phone_hmac is null then
    return 'no_index';
  end if;

  -- 1. The e-mail. The lock serialises two arrivals from one new address (the second
  --    waits, then finds the first's contact); the unique index is the backstop below.
  if l.email_hmac is not null then
    perform pg_advisory_xact_lock(hashtextextended('crm-email:' || p_tenant::text || ':' || l.email_hmac, 0));
    select ch.contact_id into v_contact
      from public.crm_contact_channels ch
     where ch.tenant_id = p_tenant and ch.kind = 'email' and ch.value_hmac = l.email_hmac;
    if v_contact is not null then
      v_by := 'email';
    end if;
  end if;

  -- 2. The phone: shared lines exist, so this links AND flags (contact_link 'phone'), and
  --    adds nothing to that contact; a person checks it (C6/C7).
  if v_contact is null and l.phone_hmac is not null then
    select ch.contact_id into v_contact
      from public.crm_contact_channels ch
      join public.crm_contacts k on k.tenant_id = ch.tenant_id and k.id = ch.contact_id
     where ch.tenant_id = p_tenant and ch.kind = 'phone' and ch.value_hmac = l.phone_hmac
       and k.merged_into is null
     order by k.last_activity_at desc, k.id
     limit 1;
    if v_contact is not null then
      v_by := 'phone';
    end if;
  end if;

  -- 3. A new contact, from what the lead says about itself. Its activity starts at the
  --    lead's arrival, not at this link (the backfill reaches old leads).
  if v_contact is null then
    insert into public.crm_contacts (tenant_id, display_name, company_name, locale, source,
                                     last_activity_at)
    values (p_tenant,
            coalesce(nullif(left(btrim(regexp_replace(coalesce(l.name, ''), '[[:cntrl:]]', ' ', 'g')), 120), ''),
                     'Unknown'),
            nullif(left(btrim(regexp_replace(coalesce(l.company, ''), '[[:cntrl:]]', ' ', 'g')), 120), ''),
            case when l.locale = 'ar' then 'ar' else 'en' end,
            case when l.source in ('manual', 'import') then l.source else 'web_form' end,
            l.created_at)
    returning id into v_contact;
    v_by := 'new';
    if l.email_hmac is not null and l.email_enc is not null then
      insert into public.crm_contact_channels (tenant_id, contact_id, kind, value_enc, value_hmac,
                                               is_primary, source)
      values (p_tenant, v_contact, 'email', l.email_enc, l.email_hmac, true, 'lead')
      on conflict (tenant_id, value_hmac) where kind = 'email' do nothing;
      get diagnostics v_n = row_count;
      if v_n = 0 then
        -- Another arrival holds the address after all: that contact is the person's.
        delete from public.crm_contacts c where c.tenant_id = p_tenant and c.id = v_contact;
        select ch.contact_id into v_contact
          from public.crm_contact_channels ch
         where ch.tenant_id = p_tenant and ch.kind = 'email' and ch.value_hmac = l.email_hmac;
        v_by := 'email';
      end if;
    end if;
  end if;

  -- 4. The lead's phone joins a contact it is the person's own (by e-mail, or new).
  if v_by in ('email', 'new') and l.phone_hmac is not null and l.phone_enc is not null then
    insert into public.crm_contact_channels (tenant_id, contact_id, kind, value_enc, value_hmac,
                                             is_primary, source)
    values (p_tenant, v_contact, 'phone', l.phone_enc, l.phone_hmac,
            not exists (select 1 from public.crm_contact_channels ch
                         where ch.contact_id = v_contact and ch.kind = 'phone' and ch.is_primary),
            'lead')
    on conflict (tenant_id, contact_id, kind, value_hmac) do nothing;
  end if;

  -- 5. The link (not an edit: app.tg_lead_pipeline's c_derived). app.tg_lead_contact writes
  --    the two timeline lines and the won and owner rules.
  update public.leads x set contact_id = v_contact, contact_link = v_by
   where x.tenant_id = p_tenant and x.id = p_lead;
  perform app.crm_touch(p_tenant, v_contact, l.created_at);
  return v_by;
end $$;
revoke all on function app.crm_link_lead_core(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function app.crm_link_lead_core(uuid, uuid) to service_role;

-- One lead, for a door that has just written one (C6's "new lead for a contact" names its
-- own link instead).
create or replace function public.crm_link_lead(p_tenant uuid, p_lead uuid) returns text
  language plpgsql volatile security invoker set search_path = public, pg_temp as $$
begin
  if p_tenant is null or p_lead is null then
    raise exception using errcode = '22023', message = 'crm_link_lead: a tenant and a lead are required';
  end if;
  return app.crm_link_lead_core(p_tenant, p_lead);
end $$;
revoke all on function public.crm_link_lead(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.crm_link_lead(uuid, uuid) to service_role;

-- The daily cron's backfill: up to p_limit leads never linked, indexed, not spam, with an
-- index to link by, oldest first; each in its own sub-transaction, so one failure costs
-- only that lead (counted, retried the next day). Counts only, never a value.
create or replace function public.crm_link_backfill(p_limit int default 200) returns jsonb
  language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  r record;
  v text;
  v_out jsonb := jsonb_build_object('scanned', 0, 'email', 0, 'phone', 0, 'new', 0,
                                    'skipped', 0, 'failed', 0);
  v_key text;
begin
  for r in
    select x.tenant_id, x.id
      from public.leads x
     where x.contact_link is null and x.contact_id is null and not x.is_spam
       and x.crm_indexed_at is not null
       and (x.email_hmac is not null or x.phone_hmac is not null)
     order by x.created_at, x.id
     limit least(greatest(coalesce(p_limit, 200), 1), 500)
  loop
    v_out := jsonb_set(v_out, '{scanned}', to_jsonb((v_out ->> 'scanned')::int + 1));
    begin
      v := app.crm_link_lead_core(r.tenant_id, r.id);
      v_key := case when v in ('email', 'phone', 'new') then v else 'skipped' end;
    exception when others then
      v_key := 'failed';
    end;
    v_out := jsonb_set(v_out, array[v_key], to_jsonb((v_out ->> v_key)::int + 1));
  end loop;
  return v_out;
end $$;
revoke all on function public.crm_link_backfill(int) from public, anon, authenticated, service_role;
grant execute on function public.crm_link_backfill(int) to service_role;

-- ═══ 11. Arrival, restated: the link ══════════════════════════════════════════════════════
-- 0091's function, with one change at its end (C5): a lead that was inserted is linked, in a
-- sub-transaction whose errors are caught. The allow-list is unchanged;
-- tests/lib/createLead.spec.ts reads it from the last definition.
create or replace function public.crm_ingest_lead(p_tenant uuid, p_lead jsonb) returns uuid
  language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_id uuid;
  v_signals text[];
  v_scoring jsonb;
  v_email_hmac text := nullif(p_lead ->> 'email_hmac', '');
  v_phone_hmac text := nullif(p_lead ->> 'phone_hmac', '');
  v_manual boolean;
  v_creator uuid;
  v_assignee uuid;
begin
  if p_tenant is null or p_lead is null or jsonb_typeof(p_lead) <> 'object' then
    raise exception using errcode = '22023', message = 'crm_ingest_lead: a tenant and a lead object are required';
  end if;
  -- An allow-list: a key outside it is a caller bug, refused rather than ignored.
  if exists (select 1 from jsonb_object_keys(p_lead) k
              where k not in ('id', 'kind', 'locale', 'name', 'company', 'email_enc', 'phone_enc',
                              'budget_enc', 'timeline_text_enc', 'message', 'service_of_interest',
                              'discipline_of_interest', 'consent_marketing', 'email_hmac',
                              'phone_hmac', 'score_signals', 'source', 'channel', 'created_by')) then
    raise exception using errcode = '22023', message = 'crm_ingest_lead: unknown lead field';
  end if;
  v_id := nullif(p_lead ->> 'id', '')::uuid;
  if v_id is null then
    raise exception using errcode = '22023', message = 'crm_ingest_lead: the lead id is required';
  end if;
  v_manual := coalesce(p_lead ->> 'source', 'web_form') = 'manual';
  v_creator := nullif(p_lead ->> 'created_by', '')::uuid;
  if v_manual and v_creator is null then
    raise exception using errcode = '22023', message = 'crm_ingest_lead: a manual lead names who added it';
  end if;
  -- A retry of a lead that did arrive (its answer was lost): nothing to do. Checked first
  -- because BEFORE INSERT triggers fire even for a row ON CONFLICT then skips, and the
  -- BEFORE phase (app.tg_lead_pipeline, 0034) would spend a lead number on it.
  if exists (select 1 from public.leads where id = v_id) then
    return v_id;
  end if;

  -- The caller's signals, minus `returning`: only this side can see earlier leads.
  select coalesce(array_agg(distinct s order by s), '{}') into v_signals
    from jsonb_array_elements_text(coalesce(p_lead -> 'score_signals', '[]'::jsonb)) s
   where s <> 'returning';
  if v_email_hmac is not null and exists (
       select 1 from public.leads
        where tenant_id = p_tenant and email_hmac = v_email_hmac and id <> v_id) then
    v_signals := v_signals || 'returning'::text;
  end if;
  select scoring into v_scoring from public.crm_settings where tenant_id = p_tenant;
  -- (0091) Who it goes to, by the tenant's rule (CRM settings, C9a).
  v_assignee := app.crm_pick_assignee(p_tenant);

  insert into public.leads (
    id, tenant_id, kind, locale, name, company, email_enc, phone_enc, budget_enc,
    timeline_text_enc, message, service_of_interest, discipline_of_interest,
    consent_marketing, email_hmac, phone_hmac, score_signals, score, source, channel,
    crm_indexed_at, created_by, first_response_at, read_at, read_by, assigned_to)
  values (
    v_id, p_tenant, coalesce(p_lead ->> 'kind', 'contact'), coalesce(p_lead ->> 'locale', 'en'),
    p_lead ->> 'name', nullif(p_lead ->> 'company', ''), p_lead ->> 'email_enc',
    p_lead ->> 'phone_enc', p_lead ->> 'budget_enc', p_lead ->> 'timeline_text_enc',
    p_lead ->> 'message', p_lead ->> 'service_of_interest', p_lead ->> 'discipline_of_interest',
    coalesce((p_lead ->> 'consent_marketing')::boolean, false), v_email_hmac, v_phone_hmac,
    v_signals, app.lead_score(v_signals, coalesce(v_scoring, '{}'::jsonb)),
    coalesce(p_lead ->> 'source', 'web_form'), coalesce(p_lead ->> 'channel', 'unknown'),
    -- Indexed only if the Worker computed the indexes (it sends the signals with them);
    -- otherwise the daily cron picks the lead up.
    case when p_lead ? 'score_signals' then now() end,
    v_creator,
    -- (0041) Written down by the person who answered it, so answered and read at once.
    case when v_manual then now() end,
    case when v_manual then now() end,
    case when v_manual then v_creator end,
    v_assignee)
  -- The same id again is the same lead (a retry after a lost response): nothing to do.
  on conflict (id) do nothing;

  -- (C5) The contact link, in its own sub-transaction: whatever goes wrong there is undone
  -- alone and the lead stays (the contact form fails open, CLAUDE.md §3; createLead keeps
  -- only an RPC that answers). The daily cron's backfill links it later
  -- (public.crm_link_backfill). A lead without its indexes waits for them the same way.
  if found then
    begin
      perform app.crm_link_lead_core(p_tenant, v_id);
    exception when others then
      raise warning 'crm_ingest_lead: the contact link was skipped (SQLSTATE %); the daily cron links the lead later', sqlstate;
    end;
  end if;
  return v_id;
end $$;
revoke all on function public.crm_ingest_lead(uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.crm_ingest_lead(uuid, jsonb) to service_role;


-- ═══ 12. Retention from last activity ═════════════════════════════════════════════════════
-- An auto-contact with nothing left: made by the system (created_by null), never edited by
-- a person (version 1), not starred, no lead and no note. Its channels are copies of its
-- leads' ciphertext, so it must not outlive them.
create or replace function app.crm_contact_is_orphan(p_tenant uuid, p_contact uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.crm_contacts c
     where c.tenant_id = p_tenant and c.id = p_contact
       and c.created_by is null and c.version = 1 and not c.is_starred
       and not exists (select 1 from public.leads l
                        where l.tenant_id = c.tenant_id and l.contact_id = c.id)
       and not exists (select 1 from public.crm_contact_notes n
                        where n.tenant_id = c.tenant_id and n.contact_id = c.id))
$$;
revoke all on function app.crm_contact_is_orphan(uuid, uuid) from public, anon, authenticated, service_role;
-- crm_erase_lead (an INVOKER the service role runs) asks it.
grant execute on function app.crm_contact_is_orphan(uuid, uuid) to service_role;

-- Every tenant, its own horizon (site_settings.retention.leads_months, 24 by default:
-- app.lead_retention_months, 0034; one horizon, never longer than the leads'). Contacts idle
-- past it go, then the orphans. Channels, notes and events go by cascade; a lead still
-- linked to an expired contact keeps its own horizon and loses only the link (its
-- contact_link stays, so the backfill never brings the contact back).
create or replace function app.purge_crm() returns int
  language plpgsql security definer set search_path = '' as $$
declare
  removed int := 0;
  n int;
  t record;
begin
  for t in select x.id from public.tenants x loop
    delete from public.crm_contacts c
     where c.tenant_id = t.id
       and c.last_activity_at < now() - make_interval(months => app.lead_retention_months(t.id));
    get diagnostics n = row_count;
    removed := removed + n;
    delete from public.crm_contacts c
     where c.tenant_id = t.id
       and c.created_by is null and c.version = 1 and not c.is_starred
       and not exists (select 1 from public.leads l
                        where l.tenant_id = c.tenant_id and l.contact_id = c.id)
       and not exists (select 1 from public.crm_contact_notes nn
                        where nn.tenant_id = c.tenant_id and nn.contact_id = c.id);
    get diagnostics n = row_count;
    removed := removed + n;
  end loop;
  return removed;
end $$;
revoke all on function app.purge_crm() from public, anon, authenticated, service_role;

-- 0008's orchestrator, with one step added after the leads' (C5): the contacts, so a
-- contact whose last lead went tonight goes tonight too. Its summary row gains a count.
create or replace function app.run_retention()
  returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  made int; dropped int; leads_removed int; logs_removed int; contacts_removed int;
begin
  made := app.ensure_telemetry_partitions();
  dropped := app.purge_telemetry();
  leads_removed := app.purge_leads();
  contacts_removed := app.purge_crm();
  logs_removed := app.purge_system_logs();
  insert into public.system_logs (tenant_id, level, source, message, detail)
  select id, 'info', 'retention', 'retention run',
         jsonb_build_object('partitions_created', made, 'partitions_dropped', dropped,
                            'leads_purged', leads_removed, 'contacts_purged', contacts_removed,
                            'system_logs_purged', logs_removed)
  from public.tenants order by created_at asc limit 1;
  return jsonb_build_object('partitions_created', made, 'partitions_dropped', dropped,
                            'leads_purged', leads_removed, 'contacts_purged', contacts_removed,
                            'system_logs_purged', logs_removed);
end $$;
revoke all on function app.run_retention() from public, anon, authenticated, service_role;

-- ═══ 13. Erasure ══════════════════════════════════════════════════════════════════════════
-- Whose leads are a person's (crm.md §8.2): those linked by e-mail, created with the contact
-- or linked by a person, and every lead carrying one of the person's e-mail indexes. A lead
-- linked by phone, or carrying one of the person's phone indexes, may be someone else's (a
-- shared line): those are listed, and go only when the Admin ticks them.
create or replace function app.crm_person_leads(p_tenant uuid, p_contact uuid)
  returns table (lead_id uuid, certain boolean)
  language sql stable security definer set search_path = '' as $$
  with em as (
    select ch.value_hmac from public.crm_contact_channels ch
     where ch.tenant_id = p_tenant and ch.contact_id = p_contact and ch.kind = 'email'
  ), ph as (
    select ch.value_hmac from public.crm_contact_channels ch
     where ch.tenant_id = p_tenant and ch.contact_id = p_contact and ch.kind = 'phone'
  ), sure as (
    select l.id from public.leads l
     where l.tenant_id = p_tenant
       and ((l.contact_id = p_contact and l.contact_link <> 'phone')
            or l.email_hmac in (select value_hmac from em))
  ), maybe as (
    select l.id from public.leads l
     where l.tenant_id = p_tenant
       and ((l.contact_id = p_contact and l.contact_link = 'phone')
            or l.phone_hmac in (select value_hmac from ph))
       and l.id not in (select id from sure)
  )
  select id, true from sure
  union all
  select id, false from maybe
$$;
revoke all on function app.crm_person_leads(uuid, uuid) from public, anon, authenticated, service_role;
-- The two erasure doors (INVOKERs the service role runs) ask it.
grant execute on function app.crm_person_leads(uuid, uuid) to service_role;

-- What erasing a person would remove, for the Admin's review (C6's erase-preview route).
-- Counts, and the phone matches with the lead columns staff read anyway (number, name,
-- company, arrival; never contact details). P0002 when the tenant has no such contact.
create or replace function public.crm_erase_preview(p_tenant uuid, p_contact uuid, p_actor uuid)
  returns jsonb
  language plpgsql stable security invoker set search_path = public, pg_temp as $$
begin
  if p_tenant is null or p_contact is null or p_actor is null then
    raise exception using errcode = '22023', message = 'crm_erase_preview: a tenant, a contact and an actor are required';
  end if;
  if not app.crm_eraser_ok(p_tenant, p_actor) then
    raise exception using errcode = '42501', message = 'crm_erase_preview: this person may not erase';
  end if;
  if not exists (select 1 from public.crm_contacts c where c.tenant_id = p_tenant and c.id = p_contact) then
    raise exception using errcode = 'P0002', message = 'crm_erase_preview: no such contact';
  end if;
  return jsonb_build_object(
    'leads', (select count(*)::int from app.crm_person_leads(p_tenant, p_contact) p where p.certain),
    'channels', (select count(*)::int from public.crm_contact_channels ch
                  where ch.tenant_id = p_tenant and ch.contact_id = p_contact),
    'notes', (select count(*)::int from public.crm_contact_notes n
               where n.tenant_id = p_tenant and n.contact_id = p_contact),
    'phone_matches', coalesce((
      select jsonb_agg(jsonb_build_object('id', l.id, 'lead_number', l.lead_number,
                                          'name', l.name, 'company', l.company,
                                          'created_at', l.created_at,
                                          'linked', coalesce(l.contact_id = p_contact, false))
                       order by l.created_at desc, l.id)
        from app.crm_person_leads(p_tenant, p_contact) p
        join public.leads l on l.tenant_id = p_tenant and l.id = p.lead_id
       where not p.certain), '[]'::jsonb));
end $$;
revoke all on function public.crm_erase_preview(uuid, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.crm_erase_preview(uuid, uuid, uuid) to service_role;

-- Erase a person, in one transaction: their leads (and by cascade those leads' notes and
-- timelines), the phone matches the Admin ticked (each must be one: 22023 otherwise, so
-- this door erases no other lead), then the contact (its channels, notes and events by
-- cascade). Counts only. P0002 when the tenant has no such contact, 42501 when the actor
-- may not erase. (Tasks join in C8.)
create or replace function public.crm_erase_person(p_tenant uuid, p_contact uuid,
                                                   p_extra_leads uuid[], p_actor uuid)
  returns jsonb
  language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  v_sure uuid[];
  v_maybe uuid[];
  v_leads uuid[];
  v_extra uuid[] := coalesce(p_extra_leads, '{}');
  v_lead_notes int;
  v_lead_events int;
  v_channels int;
  v_notes int;
  v_events int;
  v_link_lines int;
begin
  if p_tenant is null or p_contact is null or p_actor is null then
    raise exception using errcode = '22023', message = 'crm_erase_person: a tenant, a contact and an actor are required';
  end if;
  if not app.crm_eraser_ok(p_tenant, p_actor) then
    raise exception using errcode = '42501', message = 'crm_erase_person: this person may not erase';
  end if;
  perform 1 from public.crm_contacts c where c.tenant_id = p_tenant and c.id = p_contact for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'crm_erase_person: no such contact';
  end if;
  select coalesce(array_agg(p.lead_id) filter (where p.certain), '{}'),
         coalesce(array_agg(p.lead_id) filter (where not p.certain), '{}')
    into v_sure, v_maybe
    from app.crm_person_leads(p_tenant, p_contact) p;
  if cardinality(v_extra) > 100 or exists (select 1 from unnest(v_extra) x where x is null or not x = any (v_maybe)) then
    raise exception using errcode = '22023', message = 'crm_erase_person: a ticked lead is not one of this person''s phone matches';
  end if;
  v_leads := v_sure || array(select distinct x from unnest(v_extra) x);

  select count(*)::int into v_lead_notes from public.lead_notes n
   where n.tenant_id = p_tenant and n.lead_id = any (v_leads);
  select count(*)::int into v_lead_events from public.lead_events e
   where e.tenant_id = p_tenant and e.lead_id = any (v_leads);
  select count(*)::int into v_channels from public.crm_contact_channels ch
   where ch.tenant_id = p_tenant and ch.contact_id = p_contact;
  select count(*)::int into v_notes from public.crm_contact_notes n
   where n.tenant_id = p_tenant and n.contact_id = p_contact;
  select count(*)::int into v_events from public.crm_contact_events e
   where e.tenant_id = p_tenant and e.contact_id = p_contact;

  delete from public.leads l where l.tenant_id = p_tenant and l.id = any (v_leads);
  -- A lead left behind (an unticked phone match) keeps no timeline line naming the erased
  -- contact: the link it describes is gone, and no row should point at the person.
  delete from public.lead_events e
   where e.tenant_id = p_tenant and e.kind = 'contact_linked'
     and e.detail ->> 'contact_id' = p_contact::text;
  get diagnostics v_link_lines = row_count;
  delete from public.crm_contacts c where c.tenant_id = p_tenant and c.id = p_contact;
  return jsonb_build_object(
    'contacts', 1, 'leads', cardinality(v_sure), 'phone_leads', cardinality(v_leads) - cardinality(v_sure),
    'lead_notes', v_lead_notes, 'lead_events', v_lead_events, 'link_lines', v_link_lines,
    'channels', v_channels, 'notes', v_notes, 'events', v_events);
end $$;
revoke all on function public.crm_erase_person(uuid, uuid, uuid[], uuid) from public, anon, authenticated, service_role;
grant execute on function public.crm_erase_person(uuid, uuid, uuid[], uuid) to service_role;

-- 0041's lead erasure, with one step added (C5): an auto-contact the erased lead leaves with
-- nothing (app.crm_contact_is_orphan) goes with it, so the copy of the lead's contact
-- details in its channels does not outlive the lead. The answer gains `contacts` (0 or 1),
-- which the deployed route ignores (it reads named keys).
create or replace function public.crm_erase_lead(p_tenant uuid, p_lead uuid, p_actor uuid)
  returns jsonb
  language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  v_number int;
  v_notes int;
  v_events int;
  v_contact uuid;
  v_contacts int := 0;
begin
  if p_tenant is null or p_lead is null or p_actor is null then
    raise exception using errcode = '22023', message = 'crm_erase_lead: a tenant, a lead and an actor are required';
  end if;
  if not app.crm_eraser_ok(p_tenant, p_actor) then
    raise exception using errcode = '42501', message = 'crm_erase_lead: this person may not erase';
  end if;
  select l.lead_number, l.contact_id into v_number, v_contact
    from public.leads l
   where l.tenant_id = p_tenant and l.id = p_lead
     for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'crm_erase_lead: no such lead';
  end if;
  select count(*)::int into v_notes from public.lead_notes n
   where n.tenant_id = p_tenant and n.lead_id = p_lead;
  select count(*)::int into v_events from public.lead_events e
   where e.tenant_id = p_tenant and e.lead_id = p_lead;
  delete from public.leads l where l.tenant_id = p_tenant and l.id = p_lead;
  if v_contact is not null and app.crm_contact_is_orphan(p_tenant, v_contact) then
    delete from public.crm_contacts c where c.tenant_id = p_tenant and c.id = v_contact;
    v_contacts := 1;
  end if;
  return jsonb_build_object('lead_number', v_number, 'leads', 1, 'notes', v_notes, 'events', v_events,
                            'contacts', v_contacts);
end $$;
revoke all on function public.crm_erase_lead(uuid, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.crm_erase_lead(uuid, uuid, uuid) to service_role;

-- ═══ Postconditions (true under both grant regimes; MAINTAIN only on 17+) ═════════════════
do $$
declare
  v_maintain boolean := current_setting('server_version_num')::int >= 170000;
  v_tables constant text[] := array['crm_contacts', 'crm_contact_channels', 'crm_contact_notes',
                                    'crm_contact_events'];
  v_contact_write constant text[] := array['city', 'company_name', 'country', 'custom',
    'display_name', 'is_starred', 'locale', 'owner_id', 'source', 'stage', 'tags', 'title'];
  v_channel_read constant text[] := array['contact_id', 'created_at', 'created_by', 'id',
    'is_primary', 'kind', 'source', 'tenant_id'];
  v_safe constant text[] := array[
    'id', 'tenant_id', 'kind', 'locale', 'name', 'message', 'service_of_interest',
    'consent_marketing', 'created_at', 'updated_at', 'company', 'discipline_of_interest',
    'lead_number', 'stage_id', 'is_spam', 'spam_marked_at', 'first_response_at', 'won_at',
    'version', 'created_by', 'updated_by', 'score', 'source', 'channel', 'assigned_to',
    'value_sar', 'is_starred', 'read_at', 'read_by', 'tags', 'last_contact_at',
    'last_contact_channel', 'contact_id', 'contact_link'];
  v_lead_write constant text[] := array[
    'assigned_to', 'is_spam', 'is_starred', 'last_contact_at', 'last_contact_channel',
    'read_at', 'stage_id', 'tags', 'value_sar'];
  v_got text[];
  v_fn text;
  t text;
  r text;
begin
  -- ---- 1. RLS on, forced -------------------------------------------------------------------
  foreach t in array v_tables loop
    if not exists (select 1 from pg_class c
                    where c.oid = ('public.' || t)::regclass and c.relrowsecurity and c.relforcerowsecurity) then
      raise exception 'C5: % does not ENABLE and FORCE row level security', t;
    end if;
  end loop;

  -- ---- 2. The policies, exactly, each leading with the tenant predicate --------------------
  select array_agg(format('%s %s %s %s', tablename, policyname, cmd, permissive)
                   order by tablename collate "C", policyname collate "C")
    into v_got
    from pg_policies where schemaname = 'public' and tablename = any (v_tables);
  if v_got is distinct from array[
       'crm_contact_channels crm_contact_channels_live ALL RESTRICTIVE',
       'crm_contact_channels crm_contact_channels_read SELECT PERMISSIVE',
       'crm_contact_events crm_contact_events_live ALL RESTRICTIVE',
       'crm_contact_events crm_contact_events_read SELECT PERMISSIVE',
       'crm_contacts crm_contacts_live ALL RESTRICTIVE',
       'crm_contacts crm_contacts_read SELECT PERMISSIVE',
       'crm_contacts crm_contacts_update UPDATE PERMISSIVE'] then
    raise exception 'C5: the policies are %', v_got;
  end if;
  if exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = any (v_tables)
                and (roles <> '{authenticated}'
                     or coalesce(qual, '') !~ '^\(\(tenant_id = (app\.)?effective_tenant_id\(\)\) AND (app\.)?role_crm_contacts\('
                     or (with_check is not null
                         and with_check !~ '^\(\(tenant_id = (app\.)?effective_tenant_id\(\)\) AND (app\.)?role_crm_contacts\('))) then
    raise exception 'C5: a policy is not TO authenticated, or does not lead with the tenant predicate and the crm.contacts helper';
  end if;
  if (select count(*) from pg_policies
       where schemaname = 'public' and tablename = any (v_tables) and permissive = 'RESTRICTIVE'
         and qual ~ 'live_role\(\)' and with_check ~ 'live_role\(\)') <> 3 then
    raise exception 'C5: a RESTRICTIVE policy lacks the live check';
  end if;

  -- ---- 3. Grants ----------------------------------------------------------------------------
  foreach t in array v_tables loop
    foreach r in array array['public', 'anon'] loop
      if has_table_privilege(r::name, ('public.' || t)::regclass,
                             'select, insert, update, delete, truncate, references, trigger')
         or has_any_column_privilege(r::name, ('public.' || t)::regclass, 'select, insert, update, references')
         or (case when v_maintain then has_table_privilege(r::name, ('public.' || t)::regclass, 'maintain')
                  else false end) then
        raise exception 'C5: % holds a privilege on %', r, t;
      end if;
    end loop;
    -- Nobody but the owner truncates, references or triggers.
    foreach r in array array['authenticated', 'service_role'] loop
      if has_table_privilege(r::name, ('public.' || t)::regclass, 'truncate, references, trigger')
         or has_any_column_privilege(r::name, ('public.' || t)::regclass, 'references')
         or (case when v_maintain then has_table_privilege(r::name, ('public.' || t)::regclass, 'maintain')
                  else false end) then
        raise exception 'C5: % holds TRUNCATE, REFERENCES, TRIGGER or MAINTAIN on %', r, t;
      end if;
    end loop;
  end loop;
  -- authenticated: contacts SELECT and the detail UPDATE; channels the safe columns; events
  -- SELECT; notes nothing; no INSERT or DELETE anywhere.
  if not has_table_privilege('authenticated', 'public.crm_contacts', 'select')
     or has_table_privilege('authenticated', 'public.crm_contacts', 'insert, update, delete')
     or has_any_column_privilege('authenticated', 'public.crm_contacts', 'insert') then
    raise exception 'C5: authenticated must hold SELECT, no INSERT, no table-wide UPDATE and no DELETE on crm_contacts';
  end if;
  select coalesce(array_agg(a.attname::text order by a.attname::text collate "C"), '{}') into v_got
    from pg_attribute a
   where a.attrelid = 'public.crm_contacts'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', a.attrelid, a.attnum, 'update');
  if v_got is distinct from v_contact_write then
    raise exception 'C5: authenticated updates the crm_contacts columns %', v_got;
  end if;
  select coalesce(array_agg(a.attname::text order by a.attname::text collate "C"), '{}') into v_got
    from pg_attribute a
   where a.attrelid = 'public.crm_contact_channels'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', a.attrelid, a.attnum, 'select');
  if v_got is distinct from v_channel_read then
    raise exception 'C5: authenticated reads the crm_contact_channels columns % (never the value or its index)', v_got;
  end if;
  if has_table_privilege('authenticated', 'public.crm_contact_channels', 'select, insert, update, delete')
     or has_any_column_privilege('authenticated', 'public.crm_contact_channels', 'insert, update')
     or has_table_privilege('authenticated', 'public.crm_contact_notes', 'select, insert, update, delete')
     or has_any_column_privilege('authenticated', 'public.crm_contact_notes', 'select, insert, update')
     or not has_table_privilege('authenticated', 'public.crm_contact_events', 'select')
     or has_table_privilege('authenticated', 'public.crm_contact_events', 'insert, update, delete')
     or has_any_column_privilege('authenticated', 'public.crm_contact_events', 'insert, update') then
    raise exception 'C5: authenticated holds more than it should on channels, notes or events';
  end if;
  -- service_role: what its doors run on; notes and events append-only for it too.
  if not has_table_privilege('service_role', 'public.crm_contacts', 'select, insert, update, delete')
     or not has_table_privilege('service_role', 'public.crm_contact_channels', 'select, insert, update, delete')
     or not has_table_privilege('service_role', 'public.crm_contact_notes', 'select')
     or not has_table_privilege('service_role', 'public.crm_contact_notes', 'insert')
     or not has_table_privilege('service_role', 'public.crm_contact_notes', 'delete')
     or has_table_privilege('service_role', 'public.crm_contact_notes', 'update')
     or not has_table_privilege('service_role', 'public.crm_contact_events', 'select')
     or not has_table_privilege('service_role', 'public.crm_contact_events', 'insert')
     or not has_table_privilege('service_role', 'public.crm_contact_events', 'delete')
     or has_table_privilege('service_role', 'public.crm_contact_events', 'update') then
    raise exception 'C5: service_role''s privileges on the contact tables are not as stated';
  end if;

  -- ---- 4. leads: the link is read, never written, by staff; leads_safe -----------------------
  if not has_column_privilege('authenticated', 'public.leads', 'contact_id', 'select')
     or not has_column_privilege('authenticated', 'public.leads', 'contact_link', 'select') then
    raise exception 'C5: lead workers cannot read the link';
  end if;
  select coalesce(array_agg(a.attname::text order by a.attname::text collate "C"), '{}') into v_got
    from pg_attribute a
   where a.attrelid = 'public.leads'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', a.attrelid, a.attnum, 'update');
  if v_got is distinct from v_lead_write then
    raise exception 'C5: authenticated updates the leads columns % (the link is C6''s)', v_got;
  end if;
  foreach r in array array['public', 'anon'] loop
    if has_any_column_privilege(r::name, 'public.leads', 'select, insert, update, references') then
      raise exception 'C5: % holds a privilege on leads', r;
    end if;
  end loop;
  if not (select coalesce(c.reloptions::text[] @> array['security_invoker=true'], false)
            from pg_class c where c.oid = 'public.leads_safe'::regclass and c.relkind = 'v') then
    raise exception 'C5: leads_safe is not a SECURITY INVOKER view';
  end if;
  select array_agg(a.attname::text order by a.attnum) into v_got
    from pg_attribute a
   where a.attrelid = 'public.leads_safe'::regclass and a.attnum > 0 and not a.attisdropped;
  if v_got is distinct from v_safe then
    raise exception 'C5: leads_safe has the columns %', v_got;
  end if;
  if not has_table_privilege('authenticated', 'public.leads_safe', 'select')
     or has_table_privilege('authenticated', 'public.leads_safe', 'insert, update, delete, truncate, references, trigger') then
    raise exception 'C5: authenticated must hold SELECT and nothing else on leads_safe';
  end if;
  foreach r in array array['public', 'anon', 'service_role'] loop
    if has_table_privilege(r::name, 'public.leads_safe', 'select, insert, update, delete, truncate, references, trigger') then
      raise exception 'C5: % holds a privilege on leads_safe', r;
    end if;
  end loop;

  -- ---- 5. Functions -------------------------------------------------------------------------
  -- The doors: the service role's alone, INVOKER (the definers they call decide the rest).
  foreach v_fn in array array['public.crm_ingest_lead(uuid, jsonb)', 'public.crm_link_lead(uuid, uuid)',
                              'public.crm_link_backfill(integer)',
                              'public.crm_erase_preview(uuid, uuid, uuid)',
                              'public.crm_erase_person(uuid, uuid, uuid[], uuid)',
                              'public.crm_erase_lead(uuid, uuid, uuid)'] loop
    if has_function_privilege('anon', v_fn, 'execute')
       or has_function_privilege('authenticated', v_fn, 'execute')
       or not has_function_privilege('service_role', v_fn, 'execute') then
      raise exception 'C5: % must be executable by the service role only', v_fn;
    end if;
    if exists (select 1 from pg_proc where oid = v_fn::regprocedure and prosecdef) then
      raise exception 'C5: % must be SECURITY INVOKER', v_fn;
    end if;
  end loop;
  -- The definers: an empty search_path, owned by a role that bypasses RLS (they write FORCE
  -- RLS tables with no policy for them); no API role but the service role (for the three
  -- its doors call) executes one.
  foreach v_fn in array array['app.crm_touch(uuid, uuid, timestamp with time zone)',
                              'app.tg_crm_contact_row()', 'app.tg_crm_contact_events()',
                              'app.tg_crm_channel_event()', 'app.tg_crm_contact_note_event()',
                              'app.tg_lead_event_contact_activity()', 'app.tg_lead_contact()',
                              'app.tg_lead_pipeline()',
                              'app.crm_link_lead_core(uuid, uuid)', 'app.crm_contact_is_orphan(uuid, uuid)',
                              'app.purge_crm()', 'app.crm_person_leads(uuid, uuid)'] loop
    if not exists (select 1 from pg_proc f join pg_roles o on o.oid = f.proowner
                    where f.oid = v_fn::regprocedure and f.prosecdef
                      and f.proconfig = array['search_path=""']
                      and (o.rolsuper or o.rolbypassrls)) then
      raise exception 'C5: % is not a definer with an empty search_path owned by a role that bypasses RLS', v_fn;
    end if;
    if has_function_privilege('anon', v_fn, 'execute')
       or has_function_privilege('authenticated', v_fn, 'execute')
       or (has_function_privilege('service_role', v_fn, 'execute')
           and v_fn not in ('app.crm_link_lead_core(uuid, uuid)', 'app.crm_contact_is_orphan(uuid, uuid)',
                            'app.crm_person_leads(uuid, uuid)')) then
      raise exception 'C5: % is executable by an API role it should not be', v_fn;
    end if;
  end loop;
  if has_function_privilege('anon', 'app.run_retention()', 'execute')
     or has_function_privilege('authenticated', 'app.run_retention()', 'execute')
     or has_function_privilege('service_role', 'app.run_retention()', 'execute') then
    raise exception 'C5: app.run_retention() is executable by an API role';
  end if;
  -- The helper answers crm.contacts: Admin alone.
  if not app.role_crm_contacts('admin')
     or app.role_crm_contacts('developer') or app.role_crm_contacts('sales')
     or app.role_crm_contacts('content_creator') or app.role_crm_contacts('seo')
     or app.role_crm_contacts(null) then
    raise exception 'C5: app.role_crm_contacts does not answer Admin alone';
  end if;
  foreach v_fn in array array['app.role_crm_contacts(text)', 'app.crm_name_key(text)',
                              'app.crm_contact_search_text(text, text, text)'] loop
    if has_function_privilege('anon', v_fn, 'execute')
       or not has_function_privilege('authenticated', v_fn, 'execute')
       or not has_function_privilege('service_role', v_fn, 'execute') then
      raise exception 'C5: % must be executable by authenticated and the service role only', v_fn;
    end if;
  end loop;

  -- ---- 6. Triggers ------------------------------------------------------------------------
  select array_agg(format('%s %s', t.tgname, f.proname) order by t.tgname collate "C") into v_got
    from pg_trigger t join pg_proc f on f.oid = t.tgfoid
   where t.tgrelid = 'public.leads'::regclass and not t.tgisinternal;
  if v_got is distinct from array['leads_contact tg_lead_contact', 'leads_notify tg_notify_lead',
                                  'leads_pipeline tg_lead_pipeline', 'leads_timeline tg_lead_timeline'] then
    raise exception 'C5: the triggers on leads are %', v_got;
  end if;
  if exists (select 1 from pg_trigger t
              where t.tgrelid in ('public.leads'::regclass, 'public.lead_events'::regclass,
                                  'public.crm_contacts'::regclass, 'public.crm_contact_channels'::regclass,
                                  'public.crm_contact_notes'::regclass)
                and not t.tgisinternal and t.tgenabled::text <> 'O') then
    raise exception 'C5: a trigger is not switched on';
  end if;
  if (select count(*) from pg_trigger t
       where not t.tgisinternal
         and (t.tgrelid, t.tgname) in (('public.crm_contacts'::regclass, 'crm_contacts_row'),
                                       ('public.crm_contacts'::regclass, 'crm_contacts_events'),
                                       ('public.crm_contact_channels'::regclass, 'crm_contact_channels_event'),
                                       ('public.crm_contact_notes'::regclass, 'crm_contact_notes_event'),
                                       ('public.lead_events'::regclass, 'lead_events_contact_activity'))) <> 5 then
    raise exception 'C5: a contact trigger is missing';
  end if;

  -- ---- 7. Nothing to link yet that is not a lead ---------------------------------------------
  if exists (select 1 from public.leads where contact_id is not null or contact_link is not null) then
    raise exception 'C5: a lead is linked before the backfill ran';
  end if;
end $$;
