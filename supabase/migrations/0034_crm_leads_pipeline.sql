-- ─────────────────────────────────────────────────────────────────────────────
-- 0034 — Leads v2, part 1: the pipeline, the spam horizon, the timeline and the notes
-- thread (Admin v2 C1a-2). Forward-only, EXPAND only. Depends on 0002, 0008, 0009, 0033.
--
-- The client's CRM (docs/admin-v2/crm.md §4) replaces the four-value `status` with an
-- editable pipeline and adds a timeline and a notes thread. This migration lays that
-- schema down while the current admin keeps working unchanged:
--
--   • lead_stages: per tenant, seeded New / Contacted / Proposal sent / Won / Lost. Tones
--     come from a fixed palette (CSP: no free colours), kinds are open / won / lost, one
--     stage is initial. A constraint trigger checks the whole set at commit. Staff only
--     read it here; editing arrives with CRM settings (C9).
--   • leads gain lead_number (L1, L2… per tenant, never reused), stage_id, is_spam,
--     spam_marked_at, first_response_at, won_at, version and actor columns.
--   • LEGACY SYNC (expand window, removed by the contract slice C14): old code writes
--     `status`, new code writes stage_id / is_spam, and one BEFORE trigger derives the
--     other side. Legacy "done" maps to Lost (owner item O-8; a `legacy_backfill` event
--     marks every mapped lead so it can be found and re-triaged).
--   • THE SPAM HORIZON (D2): app.purge_leads never knew about spam, so "spam: 30 days"
--     (docs/retention.md) was never applied and spam was kept 24 months. Marking spam now
--     caps retention_delete_after at now() + spam_days, never lengthening it; clearing
--     spam gives back the horizon it had before, but never more than a horizon set while
--     the lead was flagged (an erasure, docs/retention.md), so un-marking cannot undo one.
--     The trigger compares OLD and NEW on every update, because a legacy
--     `status = 'spam'` write never names is_spam (a column-specific trigger would not
--     fire for it). Leads already marked spam get the cap now, so they are purged
--     spam_days after this migration.
--   • lead_events: the product timeline (created, stage changes, spam, notes), metadata
--     only. Written by definer triggers, read by lead workers. It is not audit_log.
--   • lead_notes: the notes thread that replaces internal_notes. The service role is its
--     only API reader and writer (the audited path, as for the gated lead columns); no
--     other API role holds any privilege on it. Thread notes are append-only, and each
--     one's timeline event is written by a trigger in the same statement. Until C14 the
--     legacy internal_notes field is mirrored as ONE note per lead (source 'legacy'),
--     rewritten in place when the field is saved and removed when it is cleared, so text
--     taken out of the field leaves the thread too. The mirror runs one way: a thread
--     note never reaches internal_notes, so the legacy panel and the CSV export show the
--     old field only (a transitional gap: C4 moves the panel to the thread, C14 drops
--     the field).
--
-- ONE trigger function per phase, so the order is written down instead of resting on
-- alphabetical trigger names: app.tg_lead_pipeline (BEFORE: the number, the sync, the
-- spam horizon, the stamps, the version, then who changed the lead and when) and
-- app.tg_lead_timeline (AFTER: events and the notes mirror). 0002's timestamps trigger on
-- leads is dropped, its job folded into the BEFORE phase. The definer functions are owned
-- by the migration role, which must bypass RLS to write the FORCE RLS tables they feed; a
-- postcondition checks that.
-- ─────────────────────────────────────────────────────────────────────────────

-- ---- 1. lead_stages ----------------------------------------------------------------------
create table if not exists public.lead_stages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default app.effective_tenant_id() references public.tenants (id) on delete cascade,
  key text not null check (key ~ '^[a-z][a-z0-9_]{0,31}$'),
  label text not null check (char_length(label) between 1 and 40),
  label_ar text check (label_ar is null or char_length(label_ar) between 1 and 40),
  tone text not null check (tone in ('klein', 'sky', 'ok', 'warn', 'err', 'gray')),
  kind text not null check (kind in ('open', 'won', 'lost')),
  is_initial boolean not null default false,
  sort_order int not null default 0,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  constraint lead_stages_initial_is_open check (not is_initial or kind = 'open'),
  constraint lead_stages_tenant_key unique (tenant_id, key),
  constraint lead_stages_tenant_id_id unique (tenant_id, id)
);
create unique index if not exists lead_stages_one_initial on public.lead_stages (tenant_id) where is_initial;
create index if not exists lead_stages_tenant_order on public.lead_stages (tenant_id, sort_order);
alter table public.lead_stages enable row level security;
alter table public.lead_stages force row level security;
drop trigger if exists lead_stages_updated_at on public.lead_stages;
create trigger lead_stages_updated_at before update on public.lead_stages
  for each row execute function app.tg_set_updated_at();
drop trigger if exists lead_stages_actor on public.lead_stages;
create trigger lead_stages_actor before insert or update on public.lead_stages
  for each row execute function app.tg_set_actor();
drop trigger if exists lead_stages_version on public.lead_stages;
create trigger lead_stages_version before update on public.lead_stages
  for each row execute function app.tg_bump_version();

-- The set, checked at commit (a pipeline is edited several rows at a time): 2 to 10
-- stages, exactly one initial (the partial unique index stops a second one at once), at
-- least one won and one lost. A tenant being deleted takes its stages with it.
create or replace function app.tg_lead_stages_shape() returns trigger
  language plpgsql security definer set search_path = '' as $$
declare
  v_tenant uuid;
  n int;
  n_initial int;
  n_won int;
  n_lost int;
begin
  if tg_op = 'DELETE' then
    v_tenant := old.tenant_id;
  else
    v_tenant := new.tenant_id;
  end if;
  if not exists (select 1 from public.tenants where id = v_tenant) then
    return null;
  end if;
  select count(*), count(*) filter (where is_initial),
         count(*) filter (where kind = 'won'), count(*) filter (where kind = 'lost')
    into n, n_initial, n_won, n_lost
    from public.lead_stages where tenant_id = v_tenant;
  if n < 2 or n > 10 then
    raise exception using errcode = '23514',
      message = format('a pipeline has 2 to 10 stages; this one would have %s', n);
  end if;
  if n_initial <> 1 then
    raise exception using errcode = '23514', message = 'a pipeline has exactly one initial stage';
  end if;
  if n_won < 1 or n_lost < 1 then
    raise exception using errcode = '23514', message = 'a pipeline has at least one won and one lost stage';
  end if;
  return null;
end $$;
revoke all on function app.tg_lead_stages_shape() from public, anon, authenticated, service_role;
drop trigger if exists lead_stages_shape on public.lead_stages;
create constraint trigger lead_stages_shape
  after insert or update or delete on public.lead_stages
  deferrable initially deferred
  for each row execute function app.tg_lead_stages_shape();

-- The default pipeline (the mockup's set, owner item O-10).
create or replace function app.seed_lead_stages(p_tenant uuid) returns void
  language sql security definer set search_path = '' as $$
  insert into public.lead_stages (tenant_id, key, label, tone, kind, is_initial, sort_order) values
    (p_tenant, 'new', 'New', 'klein', 'open', true, 10),
    (p_tenant, 'contacted', 'Contacted', 'sky', 'open', false, 20),
    (p_tenant, 'proposal', 'Proposal sent', 'warn', 'open', false, 30),
    (p_tenant, 'won', 'Won', 'ok', 'won', false, 40),
    (p_tenant, 'lost', 'Lost', 'gray', 'lost', false, 50)
  on conflict (tenant_id, key) do nothing
$$;
revoke all on function app.seed_lead_stages(uuid) from public, anon, authenticated, service_role;

-- A new tenant gets the pipeline with it, so a lead can always find its initial stage.
create or replace function app.tg_tenant_crm_defaults() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  perform app.seed_lead_stages(new.id);
  return null;
end $$;
revoke all on function app.tg_tenant_crm_defaults() from public, anon, authenticated, service_role;
drop trigger if exists tenants_crm_defaults on public.tenants;
create trigger tenants_crm_defaults after insert on public.tenants
  for each row execute function app.tg_tenant_crm_defaults();

do $$
declare
  t record;
begin
  for t in select id from public.tenants loop
    perform app.seed_lead_stages(t.id);
  end loop;
end $$;

-- ---- 2. New lead columns ----------------------------------------------------------------
alter table public.leads
  add column if not exists lead_number int,
  add column if not exists stage_id uuid,
  add column if not exists is_spam boolean not null default false,
  add column if not exists spam_marked_at timestamptz,
  add column if not exists retention_before_spam timestamptz,
  add column if not exists first_response_at timestamptz,
  add column if not exists won_at timestamptz,
  add column if not exists version int not null default 1,
  add column if not exists created_by uuid,
  add column if not exists updated_by uuid;
comment on column public.leads.retention_before_spam is
  'The horizon a lead had before it was marked spam, given back when spam is cleared, never past a horizon set while flagged (0034). Never granted to staff.';

-- Composite keys: a lead points only at its own tenant's stage, and the timeline and notes
-- point only at their own tenant's lead, whatever a direct API write tries.
alter table public.leads drop constraint if exists leads_tenant_id_id;
alter table public.leads add constraint leads_tenant_id_id unique (tenant_id, id);
alter table public.leads drop constraint if exists leads_stage_fk;
alter table public.leads add constraint leads_stage_fk foreign key (tenant_id, stage_id)
  references public.lead_stages (tenant_id, id) on delete restrict;
create index if not exists leads_tenant_stage_idx on public.leads (tenant_id, stage_id, created_at desc);

-- Per-tenant lead numbers, never reused: a counter, not max() + 1, so an erased lead's
-- number is never given to someone else. Only the definer trigger (and the backfill)
-- touches it.
create table if not exists app.lead_counters (
  tenant_id uuid primary key references public.tenants (id) on delete cascade,
  last_number int not null check (last_number >= 0)
);
alter table app.lead_counters enable row level security;
alter table app.lead_counters force row level security;
revoke all on app.lead_counters from public, anon, authenticated, service_role;

-- ---- 3. lead_events and lead_notes ------------------------------------------------------
create table if not exists public.lead_events (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  lead_id uuid not null,
  at timestamptz not null default now(),
  actor_id uuid,
  kind text not null check (kind in (
    'created', 'stage_changed', 'assigned', 'unassigned', 'value_set', 'spam_marked',
    'spam_cleared', 'contact_logged', 'note_added', 'contact_linked', 'task_created',
    'task_done', 'merged', 'legacy_backfill')),
  -- Metadata only: stage keys, ids, a channel. Never a note body or contact details.
  detail jsonb not null default '{}'::jsonb
    check (jsonb_typeof(detail) = 'object' and pg_column_size(detail) < 2048),
  constraint lead_events_lead_fk foreign key (tenant_id, lead_id)
    references public.leads (tenant_id, id) on delete cascade
);
create index if not exists lead_events_lead_idx on public.lead_events (tenant_id, lead_id, at desc);
alter table public.lead_events enable row level security;
alter table public.lead_events force row level security;

create table if not exists public.lead_notes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  lead_id uuid not null,
  body text not null check (char_length(body) between 1 and 5000),
  -- 'staff': a thread note, append-only. 'legacy': the mirror of the old internal_notes
  -- field, one per lead (the index below), rewritten in place until C14.
  source text not null check (source in ('staff', 'legacy')),
  -- The author (for the legacy mirror, whoever saved the field last). Null only for
  -- notes copied from internal_notes by this migration.
  created_by uuid,
  created_at timestamptz not null default now(),
  constraint lead_notes_lead_fk foreign key (tenant_id, lead_id)
    references public.leads (tenant_id, id) on delete cascade
);
create index if not exists lead_notes_lead_idx on public.lead_notes (tenant_id, lead_id, created_at desc);
create unique index if not exists lead_notes_one_legacy on public.lead_notes (tenant_id, lead_id)
  where source = 'legacy';
alter table public.lead_notes enable row level security;
alter table public.lead_notes force row level security;
-- No policies: the service role (the Worker's audited path) and the definer triggers
-- are its only readers and writers. No API role may UPDATE it, so a thread note is
-- append-only (a correction is a new note); only the legacy mirror is rewritten, by the
-- definer trigger on leads.

-- A note's timeline event, in the statement that adds the note: a failure leaves neither,
-- so retrying after an error cannot put the same note in the thread twice. Fires for an
-- INSERT only, so rewriting the legacy mirror adds no event; removing it leaves the event
-- (metadata only: the note's id).
create or replace function app.tg_lead_note_event() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  insert into public.lead_events (tenant_id, lead_id, at, actor_id, kind, detail)
  values (new.tenant_id, new.lead_id, new.created_at, new.created_by, 'note_added',
          jsonb_build_object('note_id', new.id));
  return null;
end $$;
revoke all on function app.tg_lead_note_event() from public, anon, authenticated, service_role;
drop trigger if exists lead_notes_event on public.lead_notes;
create trigger lead_notes_event after insert on public.lead_notes
  for each row execute function app.tg_lead_note_event();

-- ---- 4. Helpers ---------------------------------------------------------------------------
-- The tenant's retention settings (site_settings.retention), with app.purge_leads'
-- defaults. Definer: staff and the service role cannot read site_settings rows of their
-- own accord, and the triggers need these values for every writer.
create or replace function app.lead_retention_months(p_tenant uuid) returns int
  language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select (retention ->> 'leads_months')::int from public.site_settings where tenant_id = p_tenant),
    24)
$$;
create or replace function app.lead_spam_days(p_tenant uuid) returns int
  language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select (retention ->> 'spam_days')::int from public.site_settings where tenant_id = p_tenant),
    30)
$$;
revoke all on function app.lead_retention_months(uuid) from public, anon, authenticated, service_role;
revoke all on function app.lead_spam_days(uuid) from public, anon, authenticated, service_role;

-- The stage a legacy status means, given the lead's current stage. A status that the
-- current stage already satisfies keeps it ("in progress" on Proposal sent stays there).
create or replace function app.lead_stage_for_status(p_tenant uuid, p_status text, p_current uuid)
  returns uuid language sql stable security definer set search_path = '' as $$
  with cur as (
    select kind, is_initial from public.lead_stages where tenant_id = p_tenant and id = p_current
  )
  select case
    when p_status = 'new' then
      (select id from public.lead_stages where tenant_id = p_tenant and is_initial)
    when p_status = 'in_progress' then coalesce(
      (select p_current from cur where kind = 'open' and not is_initial),
      (select id from public.lead_stages
        where tenant_id = p_tenant and kind = 'open' and not is_initial
        order by sort_order, key limit 1),
      (select id from public.lead_stages where tenant_id = p_tenant and is_initial))
    when p_status = 'done' then coalesce(
      (select p_current from cur where kind in ('won', 'lost')),
      (select id from public.lead_stages
        where tenant_id = p_tenant and kind = 'lost'
        order by sort_order, key limit 1))
    -- 'spam' is a flag, not a stage: the stage stays (the initial one for a new lead).
    else coalesce(p_current,
      (select id from public.lead_stages where tenant_id = p_tenant and is_initial))
  end
$$;
revoke all on function app.lead_stage_for_status(uuid, text, uuid) from public, anon, authenticated, service_role;

-- ---- 5. Backfill ------------------------------------------------------------------------
-- Every lead that predates this migration: its notes, its first events, the spam horizon,
-- its number and, last, its stage. A function rather than inline statements, so pgTAP can
-- run it on legacy-shaped rows (supabase/tests/lead_pipeline_backfill.test.sql): CI applies
-- this file to an empty table, where every statement below is vacuous. A legacy lead is
-- one with no stage yet, and the stage is set last, so a second run changes nothing.
--
-- 0002's timestamps trigger is dropped first (app.tg_lead_pipeline takes over its job), and
-- the lead triggers are created only after the backfill, so no lead looks freshly edited.
drop trigger if exists leads_updated_at on public.leads;

create or replace function app.backfill_lead_pipeline() returns void
  language plpgsql set search_path = '' as $$
begin
  -- Notes first, each keeping the time its lead was last edited (its note_added event,
  -- app.tg_lead_note_event, takes the same time).
  insert into public.lead_notes (tenant_id, lead_id, body, source, created_by, created_at)
  select l.tenant_id, l.id, left(l.internal_notes, 5000), 'legacy', null, l.updated_at
    from public.leads l
   where l.stage_id is null
     and nullif(btrim(l.internal_notes), '') is not null
     and not exists (select 1 from public.lead_notes n
                      where n.tenant_id = l.tenant_id and n.lead_id = l.id and n.source = 'legacy');

  -- Every timeline starts at the lead's arrival; a mapped status is marked for re-triage.
  insert into public.lead_events (tenant_id, lead_id, at, actor_id, kind, detail)
  select l.tenant_id, l.id, l.created_at, null, 'created', '{}'::jsonb
    from public.leads l
   where l.stage_id is null
     and not exists (select 1 from public.lead_events e
                      where e.tenant_id = l.tenant_id and e.lead_id = l.id and e.kind = 'created');
  insert into public.lead_events (tenant_id, lead_id, at, actor_id, kind, detail)
  select l.tenant_id, l.id, now(), null, 'legacy_backfill', jsonb_build_object('from', l.status)
    from public.leads l
   where l.stage_id is null
     and l.status in ('in_progress', 'done', 'spam')
     and not exists (select 1 from public.lead_events e
                      where e.tenant_id = l.tenant_id and e.lead_id = l.id
                        and e.kind = 'legacy_backfill');

  -- Spam gets its horizon now: spam_days from today, never longer than it had.
  update public.leads l
     set is_spam = true,
         spam_marked_at = now(),
         retention_before_spam = l.retention_delete_after,
         retention_delete_after = least(
           coalesce(l.retention_delete_after,
                    l.created_at + make_interval(months => app.lead_retention_months(l.tenant_id))),
           now() + make_interval(days => app.lead_spam_days(l.tenant_id)))
   where l.stage_id is null and l.status = 'spam' and not l.is_spam;

  -- Numbers in arrival order, after any the tenant has already given out.
  with numbered as (
    select l.id,
           coalesce(c.last_number, 0)
             + row_number() over (partition by l.tenant_id order by l.created_at, l.id) as n
      from public.leads l
      left join app.lead_counters c on c.tenant_id = l.tenant_id
     where l.lead_number is null
  )
  update public.leads l set lead_number = numbered.n from numbered where numbered.id = l.id;
  insert into app.lead_counters as c (tenant_id, last_number)
  select l.tenant_id, max(l.lead_number) from public.leads l
   where l.lead_number is not null
   group by l.tenant_id
  on conflict (tenant_id) do update set last_number = greatest(c.last_number, excluded.last_number);

  -- Last, the stage. A lead mapped past New keeps a null first response: when it was
  -- first answered is not known, so the KPI leaves it out rather than invent a time.
  update public.leads l
     set stage_id = s.id
    from public.lead_stages s
   where l.stage_id is null
     and s.tenant_id = l.tenant_id
     and s.key = case l.status
                   when 'in_progress' then 'contacted'
                   when 'done' then 'lost'
                   else 'new'
                 end;
end $$;
revoke all on function app.backfill_lead_pipeline() from public, anon, authenticated, service_role;

select app.backfill_lead_pipeline();

alter table public.leads alter column stage_id set not null;
alter table public.leads alter column lead_number set not null;
alter table public.leads drop constraint if exists leads_tenant_lead_number;
alter table public.leads add constraint leads_tenant_lead_number unique (tenant_id, lead_number);

-- ---- 6. Triggers on leads ---------------------------------------------------------------
create or replace function app.tg_lead_pipeline() returns trigger
  language plpgsql security definer set search_path = '' as $$
declare
  -- What the CRM works out for itself (the blind indexes, the score and its reasons, the
  -- index cursor: 0035, 0036). A write that changes only these is not an edit.
  c_derived constant text[] := array['email_hmac', 'phone_hmac', 'score', 'score_signals',
    'crm_indexed_at', 'search_text', 'updated_at', 'updated_by'];
  v_skip text[] := c_derived;
  v_edited boolean := true;
  v_kind text;
  v_initial boolean;
  v_old_kind text;
  v_old_initial boolean;
  v_moved boolean := false;
  v_marking boolean := false;
  v_clearing boolean := false;
  v_default timestamptz;
begin
  -- 0. Is this write an edit? Read before any step below changes NEW. Moving a legacy
  --    plaintext timeline band into the encrypted timeline (the daily cron, 0035) changes
  --    no answer, so it is not one either. (A generated column reads as null in NEW here;
  --    search_text is in the list for that reason too.)
  if tg_op = 'UPDATE' then
    if old.timeline_band is not null and new.timeline_band is null then
      v_skip := v_skip || array['timeline_band', 'timeline_text_enc'];
    end if;
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

  -- 2. Legacy sync (expand window). Old code writes status; new code writes stage_id or
  --    is_spam. Whichever moved, the other side is derived from it.
  if tg_op = 'INSERT' then
    if new.stage_id is null then
      new.is_spam := new.is_spam or new.status = 'spam';
      new.stage_id := app.lead_stage_for_status(new.tenant_id, new.status, null);
    end if;
  elsif new.status is distinct from old.status
        and new.stage_id is not distinct from old.stage_id
        and new.is_spam is not distinct from old.is_spam then
    new.is_spam := (new.status = 'spam');
    if not new.is_spam then
      new.stage_id := app.lead_stage_for_status(new.tenant_id, new.status, old.stage_id);
    end if;
  end if;

  select s.kind, s.is_initial into v_kind, v_initial
    from public.lead_stages s
   where s.tenant_id = new.tenant_id and s.id = new.stage_id;
  -- A stage id of another tenant (or none) finds nothing here; the composite foreign key
  -- refuses the row at the end of the statement.

  new.status := case
    when new.is_spam then 'spam'
    when v_kind in ('won', 'lost') then 'done'
    when v_initial then 'new'
    else 'in_progress'
  end;

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

  -- 4. Pipeline stamps, on a real move only (a note, a status rewrite to the same stage or
  --    the index cron never stamps): the first response is the first time a lead LEAVES
  --    the initial stage, and won_at is when it enters a won stage. A lead the backfill
  --    mapped past New keeps a null first response; a manual add sets its own (C3).
  if v_moved and v_old_initial and v_initial is false and new.first_response_at is null then
    new.first_response_at := now();
  end if;
  if v_kind is distinct from 'won' then
    new.won_at := null;
  elsif new.won_at is null
        and (tg_op = 'INSERT' or (v_moved and v_old_kind is distinct from 'won')) then
    new.won_at := now();
  end if;

  -- 5. The version moves only when a versioned field does, so writing a note or a stamp
  --    never causes a 409. (Later slices add assignee, value, tags and contact.)
  if tg_op = 'UPDATE' then
    if (v_moved or new.is_spam is distinct from old.is_spam) and new.version = old.version then
      new.version := old.version + 1;
    end if;
  end if;

  -- 6. Who changed the lead, and when (app.tg_set_actor's and app.tg_set_updated_at's job,
  --    done here so nothing later in the phase can undo it). A write that is not an edit
  --    (step 0) keeps both: the index cron never makes a lead look freshly edited, or
  --    erases who last moved it.
  if tg_op = 'INSERT' then
    new.created_by := coalesce(new.created_by, auth.uid());
    new.updated_by := auth.uid();
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

create or replace function app.tg_lead_timeline() returns trigger
  language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
begin
  if tg_op = 'INSERT' then
    insert into public.lead_events (tenant_id, lead_id, actor_id, kind)
    values (new.tenant_id, new.id, v_actor, 'created');
    return null;
  end if;

  if new.stage_id is distinct from old.stage_id then
    insert into public.lead_events (tenant_id, lead_id, actor_id, kind, detail)
    values (new.tenant_id, new.id, v_actor, 'stage_changed', jsonb_build_object(
      'from', (select key from public.lead_stages where id = old.stage_id),
      'to', (select key from public.lead_stages where id = new.stage_id)));
  end if;
  if new.is_spam and not old.is_spam then
    insert into public.lead_events (tenant_id, lead_id, actor_id, kind)
    values (new.tenant_id, new.id, v_actor, 'spam_marked');
  elsif old.is_spam and not new.is_spam then
    insert into public.lead_events (tenant_id, lead_id, actor_id, kind)
    values (new.tenant_id, new.id, v_actor, 'spam_cleared');
  end if;

  -- The legacy notes field (expand window): mirrored as ONE note per lead, rewritten in
  -- place when the field is saved and removed when it is cleared, so text taken out of
  -- the field leaves the thread as well. Its author and time are the last save's. The
  -- first save adds the note, and app.tg_lead_note_event its timeline event.
  if new.internal_notes is distinct from old.internal_notes then
    if nullif(btrim(new.internal_notes), '') is null then
      delete from public.lead_notes
       where tenant_id = new.tenant_id and lead_id = new.id and source = 'legacy';
    else
      update public.lead_notes
         set body = left(new.internal_notes, 5000), created_by = v_actor, created_at = now()
       where tenant_id = new.tenant_id and lead_id = new.id and source = 'legacy';
      if not found then
        insert into public.lead_notes (tenant_id, lead_id, body, source, created_by)
        values (new.tenant_id, new.id, left(new.internal_notes, 5000), 'legacy', v_actor);
      end if;
    end if;
  end if;
  return null;
end $$;
revoke all on function app.tg_lead_timeline() from public, anon, authenticated, service_role;

-- One BEFORE trigger and one AFTER trigger (a postcondition holds it): 0002's timestamps
-- trigger is gone (section 5) and the number, the actor and the timestamps are steps of
-- app.tg_lead_pipeline.
drop trigger if exists leads_number on public.leads;
drop trigger if exists leads_actor on public.leads;
drop trigger if exists leads_pipeline on public.leads;
create trigger leads_pipeline before insert or update on public.leads
  for each row execute function app.tg_lead_pipeline();
drop trigger if exists leads_timeline on public.leads;
create trigger leads_timeline after insert or update on public.leads
  for each row execute function app.tg_lead_timeline();

-- ---- 7. Policies --------------------------------------------------------------------------
-- Stages are configuration (no personal data): lead workers read them, nobody writes them
-- through the API yet.
drop policy if exists lead_stages_read on public.lead_stages;
create policy lead_stages_read on public.lead_stages for select to authenticated
  using (tenant_id = app.effective_tenant_id() and app.role_works_leads(app.current_role()));

-- The timeline names people's leads, so it carries the live check like leads itself.
drop policy if exists lead_events_read on public.lead_events;
create policy lead_events_read on public.lead_events for select to authenticated
  using (tenant_id = app.effective_tenant_id() and app.role_works_leads(app.current_role()));
drop policy if exists lead_events_live on public.lead_events;
create policy lead_events_live on public.lead_events as restrictive for all to authenticated
  using (tenant_id = app.effective_tenant_id() and app.role_works_leads((select app.live_role())))
  with check (tenant_id = app.effective_tenant_id() and app.role_works_leads((select app.live_role())));

-- ---- 8. leads_safe carries the pipeline (appended: create or replace can only add at the
--         end, and must restate security_invoker or every role would read every lead) ----
create or replace view public.leads_safe with (security_invoker = true) as
select
  id, tenant_id, kind, locale, name, message, service_of_interest,
  status, consent_marketing, created_at, updated_at, company, discipline_of_interest,
  lead_number, stage_id, is_spam, spam_marked_at, first_response_at, won_at, version,
  created_by, updated_by
from public.leads;

-- ---- 9. Grants, stated (Admin v2 P-14: both Supabase grant regimes) -----------------------
-- leads: the pipeline columns join the staff read set. retention_before_spam does not.
grant select (lead_number, stage_id, is_spam, spam_marked_at, first_response_at, won_at,
              version, created_by, updated_by)
  on public.leads to authenticated;
revoke all on public.leads_safe from public, anon, authenticated;
grant select on public.leads_safe to authenticated;

revoke all on public.lead_stages from public, anon, authenticated;
grant select on public.lead_stages to authenticated;
grant select, insert, update, delete on public.lead_stages to service_role;

revoke all on public.lead_events from public, anon, authenticated;
grant select on public.lead_events to authenticated;
grant select, insert, delete on public.lead_events to service_role;

revoke all on public.lead_notes from public, anon, authenticated;
grant select, insert, delete on public.lead_notes to service_role;

-- ---- Postconditions ---------------------------------------------------------------------
do $$
declare
  v_safe constant text[] := array['id', 'tenant_id', 'kind', 'locale', 'name', 'company',
    'message', 'service_of_interest', 'discipline_of_interest', 'status',
    'consent_marketing', 'created_at', 'updated_at', 'lead_number', 'stage_id', 'is_spam',
    'spam_marked_at', 'first_response_at', 'won_at', 'version', 'created_by', 'updated_by'];
  v_readable text[];
  v_fn text;
  p text;
begin
  -- Staff read exactly the safe lead columns (0033's rule, with the pipeline added).
  select coalesce(array_agg(a.attname::text order by a.attname), '{}')
    into v_readable
    from pg_attribute a
   where a.attrelid = 'public.leads'::regclass
     and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', 'public.leads', a.attname::text, 'select');
  if not (v_readable @> v_safe and v_readable <@ v_safe) then
    raise exception '0034: authenticated reads leads columns % (expected exactly %)', v_readable, v_safe;
  end if;
  foreach p in array array['stage_id', 'is_spam', 'version', 'lead_number', 'retention_before_spam',
                           'spam_marked_at', 'won_at', 'first_response_at'] loop
    if has_column_privilege('authenticated', 'public.leads', p, 'update') then
      raise exception '0034: authenticated may update leads.% (the write API arrives with C3)', p;
    end if;
  end loop;

  -- Every lead is in the pipeline and numbered; every tenant has one initial stage.
  if exists (select 1 from public.leads where stage_id is null or lead_number is null) then
    raise exception '0034: a lead has no stage or number';
  end if;
  if exists (select 1 from public.tenants t
              where (select count(*) from public.lead_stages s
                      where s.tenant_id = t.id and s.is_initial) <> 1) then
    raise exception '0034: a tenant does not have exactly one initial stage';
  end if;

  -- The new tables: RLS forced; anon nothing; staff read stages and events only.
  foreach p in array array['public.lead_stages', 'public.lead_events', 'public.lead_notes',
                           'app.lead_counters'] loop
    if not (select relrowsecurity and relforcerowsecurity from pg_class where oid = p::regclass) then
      raise exception '0034: % is not ENABLE + FORCE row level security', p;
    end if;
    if has_table_privilege('anon', p, 'select') or has_table_privilege('anon', p, 'insert') then
      raise exception '0034: anon can reach %', p;
    end if;
  end loop;
  if not has_table_privilege('authenticated', 'public.lead_stages', 'select')
     or not has_table_privilege('authenticated', 'public.lead_events', 'select') then
    raise exception '0034: staff cannot read stages or the timeline';
  end if;
  foreach p in array array['insert', 'update', 'delete', 'truncate'] loop
    if has_table_privilege('authenticated', 'public.lead_stages', p)
       or has_table_privilege('authenticated', 'public.lead_events', p) then
      raise exception '0034: authenticated holds % on lead_stages or lead_events', p;
    end if;
  end loop;
  foreach p in array array['select', 'insert', 'update', 'delete'] loop
    if has_table_privilege('authenticated', 'public.lead_notes', p)
       or has_table_privilege('authenticated', 'app.lead_counters', p) then
      raise exception '0034: authenticated holds % on lead_notes or the lead counters', p;
    end if;
  end loop;
  foreach p in array array['select', 'insert'] loop
    if not has_table_privilege('service_role', 'public.lead_notes', p)
       or not has_table_privilege('service_role', 'public.lead_events', p)
       or not has_table_privilege('service_role', 'public.lead_stages', p) then
      raise exception '0034: service_role lacks % on a CRM table', p;
    end if;
  end loop;
  -- A thread note is append-only for every API role: only the definer mirror rewrites a
  -- note, and only the legacy one.
  if has_table_privilege('service_role', 'public.lead_notes', 'update') then
    raise exception '0034: service_role may update lead_notes (thread notes are append-only)';
  end if;
  if not exists (select 1 from pg_indexes
                  where schemaname = 'public' and tablename = 'lead_notes'
                    and indexname = 'lead_notes_one_legacy'
                    and indexdef like 'CREATE UNIQUE INDEX%' and indexdef like '%legacy%') then
    raise exception '0034: lead_notes_one_legacy (one legacy mirror per lead) is missing';
  end if;

  -- One function per phase: exactly one BEFORE and one AFTER row trigger of this
  -- migration's on leads, and none of 0002's left behind (leads_notify, 0010, is the
  -- notification hook's AFTER INSERT and stays).
  if (select coalesce(array_agg(distinct t.trigger_name::text order by t.trigger_name::text), '{}')
        from information_schema.triggers t
       where t.event_object_schema = 'public' and t.event_object_table = 'leads'
         and t.action_timing = 'BEFORE') <> array['leads_pipeline'] then
    raise exception '0034: leads must have exactly one BEFORE trigger, leads_pipeline';
  end if;
  if not exists (select 1 from information_schema.triggers t
                  where t.event_object_schema = 'public' and t.event_object_table = 'leads'
                    and t.action_timing = 'AFTER' and t.trigger_name = 'leads_timeline') then
    raise exception '0034: leads_timeline is missing';
  end if;
  if not exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'lead_events' and policyname = 'lead_events_live'
                    and permissive = 'RESTRICTIVE'
                    and qual like '%live_role%' and qual like '%effective_tenant_id%') then
    raise exception '0034: lead_events_live is missing, permissive, or lacks the live check or tenant predicate';
  end if;

  -- leads_safe: invoker rights, no gated column.
  if not (select coalesce(reloptions::text[] @> array['security_invoker=true'], false)
            from pg_class where oid = 'public.leads_safe'::regclass) then
    raise exception '0034: leads_safe lost security_invoker';
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'leads_safe'
                and column_name in ('email_enc', 'phone_enc', 'budget_enc', 'timeline_band',
                                    'timeline_text_enc', 'internal_notes', 'ip_inet',
                                    'retention_delete_after', 'retention_before_spam')) then
    raise exception '0034: leads_safe exposes a gated lead column';
  end if;

  -- The definers write FORCE RLS tables with no policy for them, so their owner must
  -- bypass RLS (Supabase's postgres does; 0011). Otherwise every lead write would fail.
  foreach v_fn in array array['app.tg_lead_pipeline()', 'app.tg_lead_timeline()',
                              'app.tg_lead_note_event()', 'app.tg_tenant_crm_defaults()'] loop
    if not exists (select 1 from pg_proc f join pg_roles r on r.oid = f.proowner
                    where f.oid = v_fn::regprocedure and f.prosecdef
                      and (r.rolsuper or r.rolbypassrls)) then
      raise exception '0034: % is not a definer owned by a role that bypasses RLS', v_fn;
    end if;
  end loop;
end $$;
