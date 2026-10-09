-- ─────────────────────────────────────────────────────────────────────────────
-- 0041 — Leads v2, part 4: writing the pipeline (Admin v2 C3). Forward-only, EXPAND only.
-- Depends on 0033, 0034, 0035, 0036.
--
-- The CRM's write side (docs/admin-v2/crm.md CRM-3, §4.2 to §4.4, §7.2, §8.2):
--
--   • crm.erase, a new capability (Admin only, CLAUDE.md §5), and its one SQL helper,
--     app.role_crm_erase (tests/authz/sqlHelpers.spec.ts holds it equal to ROLE_CAPS).
--   • leads gain the columns the write API sets: assigned_to (a composite key to a profile
--     of the lead's own tenant; an active lead worker, checked when it changes),
--     value_sar (0 to 10,000,000), is_starred, read_at / read_by ("someone on the team has
--     looked": the first look stands, and who looked is the session, never the client),
--     tags (at most 10, 1 to 32 characters each, app.tags_ok) and last_contact_at /
--     last_contact_channel ("Log contact": the time is the server's).
--   • Staff UPDATE on leads grows from 0030's two legacy columns to the pipeline: stage,
--     spam flag, assignee, value, star, read mark, tags and the logged contact. Still a
--     COLUMN grant (D3): no ciphertext, retention date, score or index is writable, and
--     there is still no INSERT and no DELETE for any API role (0030).
--   • The BEFORE phase (app.tg_lead_pipeline) learns the new columns: the assignee check,
--     the read mark, the logged contact, a first response stamped by a contact logged
--     while the lead is still new, and the version moving with the assignee, the value and
--     the tags too (a star, a read mark or a logged contact never causes a 409). The AFTER
--     phase (app.tg_lead_timeline) records assigned / unassigned, value_set and
--     contact_logged. Both are restated whole: the order of their steps is the contract.
--   • public.leads_bulk_update: up to 100 leads, one action, one statement, as the caller
--     (SECURITY INVOKER: RLS, the live check and the column grant decide). Versioned
--     actions apply only where the version still matches; every item comes back applied,
--     conflict, missing or skipped. One round trip, because a Worker on the Free plan has
--     50 subrequests per request.
--   • public.crm_ingest_lead (0035) restated: a lead added by hand (source 'manual') names
--     who added it, counts as answered and as read when it arrives.
--   • public.crm_erase_lead and public.crm_delete_lead_note: the service role's doors for
--     erasure (§8.2) and for deleting one note. No API role may delete a lead (0030), so
--     the Worker calls them as the service role, after assertCap('crm.erase'), a live
--     recheck and a fail-closed audit row; each also checks the acting profile itself,
--     live, through app.role_crm_erase, so the database does not take the Worker's word.
--   • public.crm_lead_note_counts: how many notes each exported lead has (the CSV export
--     drops note bodies for a count, crm.md §9). Service role only, like the thread.
-- ─────────────────────────────────────────────────────────────────────────────

-- ---- 1. The capability helper ------------------------------------------------------------
create or replace function app.role_crm_erase(r text) returns boolean
  language sql immutable
as $$ select coalesce(r in ('admin'), false) $$;  -- crm.erase
revoke all on function app.role_crm_erase(text) from public, anon, authenticated, service_role;
grant execute on function app.role_crm_erase(text) to authenticated, service_role;

-- ---- 2. Tags (used in a CHECK, so every writer needs EXECUTE) -----------------------------
-- At most 10, each 1 to 32 characters with no surrounding spaces and no control
-- characters, no repeats. Named for the CRM, not for leads: contacts take the same rule.
create or replace function app.tags_ok(p text[]) returns boolean
  language sql immutable as $$
  select p is not null
     and cardinality(p) <= 10
     and not exists (select 1 from unnest(p) t
                      where t is null
                         or char_length(t) not between 1 and 32
                         or t <> btrim(t)
                         or t ~ '[[:cntrl:]]')
     and cardinality(p) = (select count(distinct t) from unnest(p) t)
$$;
revoke all on function app.tags_ok(text[]) from public, anon, authenticated, service_role;
grant execute on function app.tags_ok(text[]) to authenticated, service_role;

-- ---- 3. New lead columns -------------------------------------------------------------------
alter table public.leads
  add column if not exists assigned_to uuid,
  add column if not exists value_sar integer,
  add column if not exists is_starred boolean not null default false,
  add column if not exists read_at timestamptz,
  add column if not exists read_by uuid,
  add column if not exists tags text[] not null default '{}',
  add column if not exists last_contact_at timestamptz,
  add column if not exists last_contact_channel text;

alter table public.leads drop constraint if exists leads_value_sar_range;
alter table public.leads add constraint leads_value_sar_range
  check (value_sar is null or value_sar between 0 and 10000000);
alter table public.leads drop constraint if exists leads_tags_ok;
alter table public.leads add constraint leads_tags_ok check (app.tags_ok(tags));
alter table public.leads drop constraint if exists leads_last_contact_channel_ok;
alter table public.leads add constraint leads_last_contact_channel_ok
  check (last_contact_channel is null
         or last_contact_channel in ('call', 'email', 'whatsapp', 'meeting', 'other'));
alter table public.leads drop constraint if exists leads_last_contact_pair;
alter table public.leads add constraint leads_last_contact_pair
  check ((last_contact_at is null) = (last_contact_channel is null));

-- The assignee is a profile of the lead's OWN tenant: a composite key, so a direct API write
-- cannot point a lead at another tenant's person. A profile that goes takes the assignment
-- with it (SET NULL on that column only, PG 15+).
alter table public.profiles drop constraint if exists profiles_tenant_id_id;
alter table public.profiles add constraint profiles_tenant_id_id unique (tenant_id, id);
alter table public.leads drop constraint if exists leads_assignee_fk;
alter table public.leads add constraint leads_assignee_fk foreign key (tenant_id, assigned_to)
  references public.profiles (tenant_id, id) on delete set null (assigned_to);
create index if not exists leads_tenant_assignee_idx on public.leads (tenant_id, assigned_to)
  where assigned_to is not null;

-- ---- 4. The BEFORE phase, restated with the new columns ------------------------------------
-- 0034's function, step for step; what 0041 adds is marked (0041).
create or replace function app.tg_lead_pipeline() returns trigger
  language plpgsql security definer set search_path = '' as $$
declare
  -- What the CRM works out for itself (the blind indexes, the score and its reasons, the
  -- index cursor: 0035, 0036). A write that changes only these is not an edit.
  c_derived constant text[] := array['email_hmac', 'phone_hmac', 'score', 'score_signals',
    'crm_indexed_at', 'search_text', 'updated_at', 'updated_by'];
  -- (0041) Looking at a lead or starring it is not editing it either.
  c_marks constant text[] := array['read_at', 'read_by', 'is_starred'];
  v_skip text[] := c_derived || c_marks;
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

  -- 4. Pipeline stamps, on a real move only (a note, a status rewrite to the same stage or
  --    the index cron never stamps): the first response is the first time a lead LEAVES
  --    the initial stage, and won_at is when it enters a won stage. A lead the backfill
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

-- ---- 5. The AFTER phase, restated with the new events ---------------------------------------
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

  -- (0041) Who it is assigned to, its value and a logged contact: ids, a number and a
  -- channel. Metadata only, never the person's details.
  if new.assigned_to is distinct from old.assigned_to then
    if new.assigned_to is null then
      insert into public.lead_events (tenant_id, lead_id, actor_id, kind, detail)
      values (new.tenant_id, new.id, v_actor, 'unassigned',
              jsonb_build_object('from', old.assigned_to));
    else
      insert into public.lead_events (tenant_id, lead_id, actor_id, kind, detail)
      values (new.tenant_id, new.id, v_actor, 'assigned',
              jsonb_build_object('to', new.assigned_to, 'from', old.assigned_to));
    end if;
  end if;
  if new.value_sar is distinct from old.value_sar then
    insert into public.lead_events (tenant_id, lead_id, actor_id, kind, detail)
    values (new.tenant_id, new.id, v_actor, 'value_set',
            jsonb_build_object('value_sar', new.value_sar));
  end if;
  if new.last_contact_at is distinct from old.last_contact_at and new.last_contact_at is not null then
    insert into public.lead_events (tenant_id, lead_id, actor_id, kind, detail)
    values (new.tenant_id, new.id, v_actor, 'contact_logged',
            jsonb_build_object('channel', new.last_contact_channel));
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

-- ---- 6. Arrival, restated: a lead added by hand ----------------------------------------------
-- 0035's function, with one change: a lead staff add by hand (source 'manual') must name
-- who added it, and arrives answered and read by them (crm.md §7.2: first_response_at =
-- created_at). The allow-list is unchanged; tests/lib/createLead.spec.ts reads it from the
-- last definition.
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

  insert into public.leads (
    id, tenant_id, kind, locale, name, company, email_enc, phone_enc, budget_enc,
    timeline_text_enc, message, service_of_interest, discipline_of_interest,
    consent_marketing, email_hmac, phone_hmac, score_signals, score, source, channel,
    crm_indexed_at, created_by, first_response_at, read_at, read_by)
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
    case when v_manual then v_creator end)
  -- The same id again is the same lead (a retry after a lost response): nothing to do.
  on conflict (id) do nothing;
  return v_id;
end $$;
revoke all on function public.crm_ingest_lead(uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.crm_ingest_lead(uuid, jsonb) to service_role;

-- ---- 7. Bulk: one action over up to 100 leads, as the caller -------------------------------
-- p_value is the action's argument as JSON: a profile id or null (assign), a stage id
-- (stage), true or false (spam, read, star), a tag (tagAdd, tagRemove). Each item is
-- {id, version}; the version is required for the versioned actions (assign, stage, spam,
-- tagAdd, tagRemove) and ignored for read and star. Every item comes back once:
--   applied   changed (or already so), with its new version
--   conflict  its version moved on: someone else changed it (the current version returned)
--   missing   not a lead this caller can change: none, another tenant's, a stale token's
--   skipped   seen but left alone: a lead already holding ten tags, or a race lost
-- A refused value (an assignee who is not a live lead worker, another tenant's stage) fails
-- the whole statement (23514 / 23503): nothing half-applied.
create or replace function public.leads_bulk_update(
  p_tenant uuid,
  p_action text,
  p_value jsonb,
  p_items jsonb
) returns table (lead_id uuid, lead_version int, outcome text)
  language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  c_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_item jsonb;
  v_versioned boolean;
  v_set text;
  v_guard text := '';
  v_uuid uuid;
  v_bool boolean;
  v_tag text;
begin
  -- The action and its value. Each SET below is chosen from this fixed list, never built
  -- from the caller's text; the value travels as a bound parameter.
  if p_action in ('assign', 'stage') then
    v_versioned := true;
    if p_value is null or jsonb_typeof(p_value) = 'null' then
      if p_action = 'stage' then
        raise exception using errcode = '22023', message = 'leads_bulk_update: stage needs a stage id';
      end if;
    elsif jsonb_typeof(p_value) = 'string' and (p_value #>> '{}') ~* c_uuid then
      v_uuid := (p_value #>> '{}')::uuid;
    else
      raise exception using errcode = '22023', message = 'leads_bulk_update: the value must be an id';
    end if;
    v_set := case p_action when 'assign' then 'assigned_to = $4' else 'stage_id = $4' end;
  elsif p_action in ('spam', 'read', 'star') then
    v_versioned := (p_action = 'spam');
    if jsonb_typeof(p_value) is distinct from 'boolean' then
      raise exception using errcode = '22023', message = 'leads_bulk_update: the value must be true or false';
    end if;
    v_bool := (p_value #>> '{}')::boolean;
    v_set := case p_action
      when 'spam' then 'is_spam = $5'
      when 'star' then 'is_starred = $5'
      -- The first look stands (the BEFORE phase keeps it too); unread clears it.
      else 'read_at = case when $5 then coalesce(l.read_at, now()) end'
    end;
  elsif p_action in ('tagAdd', 'tagRemove') then
    v_versioned := true;
    if jsonb_typeof(p_value) is distinct from 'string' then
      raise exception using errcode = '22023', message = 'leads_bulk_update: the value must be a tag';
    end if;
    v_tag := p_value #>> '{}';
    if not app.tags_ok(array[v_tag]) then
      raise exception using errcode = '22023', message = 'leads_bulk_update: a tag is 1 to 32 characters';
    end if;
    if p_action = 'tagAdd' then
      v_set := 'tags = case when $6 = any(l.tags) then l.tags else l.tags || $6 end';
      -- A lead already holding ten tags is skipped, not the whole batch failed.
      v_guard := ' and ($6 = any(l.tags) or cardinality(l.tags) < 10)';
    else
      v_set := 'tags = array_remove(l.tags, $6)';
    end if;
  else
    raise exception using errcode = '22023', message = 'leads_bulk_update: unknown action';
  end if;

  -- The items: 1 to 100 objects {id, version}, each lead once. Nested IFs: SQL does not
  -- promise to test the type before jsonb_object_keys() would raise on a non-object.
  if p_items is null or jsonb_typeof(p_items) is distinct from 'array'
     or jsonb_array_length(p_items) not between 1 and 100 then
    raise exception using errcode = '22023', message = 'leads_bulk_update: 1 to 100 items';
  end if;
  for v_item in select e from jsonb_array_elements(p_items) e loop
    if jsonb_typeof(v_item) <> 'object' then
      raise exception using errcode = '22023', message = 'leads_bulk_update: an item is an object';
    end if;
    if exists (select 1 from jsonb_object_keys(v_item) k where k not in ('id', 'version')) then
      raise exception using errcode = '22023', message = 'leads_bulk_update: an item is {id, version}';
    end if;
    if coalesce(v_item ->> 'id', '') !~* c_uuid then
      raise exception using errcode = '22023', message = 'leads_bulk_update: an item needs a lead id';
    end if;
    if v_item ? 'version' then
      if coalesce(v_item ->> 'version', '') !~ '^[1-9][0-9]{0,8}$' then
        raise exception using errcode = '22023', message = 'leads_bulk_update: a version is a positive whole number';
      end if;
    elsif v_versioned then
      raise exception using errcode = '22023', message = 'leads_bulk_update: this action needs each lead''s version';
    end if;
  end loop;
  if (select count(distinct (e ->> 'id')::uuid) from jsonb_array_elements(p_items) e)
     <> jsonb_array_length(p_items) then
    raise exception using errcode = '22023', message = 'leads_bulk_update: each lead once';
  end if;

  -- One statement. `seen` reads the leads as they were when it started (a data-modifying
  -- CTE's changes are not visible to its siblings), so an item that was not changed is
  -- told apart: unseen (missing), a version that moved on (conflict), or left alone.
  return query execute format($sql$
    with items as (
      select (e ->> 'id')::uuid as id, (e ->> 'version')::int as expected
        from jsonb_array_elements($1) e
    ),
    upd as (
      update public.leads l
         set %s
        from items i
       where l.tenant_id = app.effective_tenant_id()
         and l.tenant_id = $2
         and l.id = i.id%s%s
      returning l.id, l.version
    ),
    seen as (
      select l.id, l.version
        from public.leads l
        join items i on i.id = l.id
       where l.tenant_id = app.effective_tenant_id()
         and l.tenant_id = $2
    )
    select i.id,
           coalesce(u.version, s.version),
           case when u.id is not null then 'applied'
                when s.id is null then 'missing'
                when $3 and s.version <> i.expected then 'conflict'
                else 'skipped'
           end
      from items i
      left join upd u on u.id = i.id
      left join seen s on s.id = i.id
     order by i.id
  $sql$, v_set, case when v_versioned then ' and l.version = i.expected' else '' end, v_guard)
  using p_items, p_tenant, v_versioned, v_uuid, v_bool, v_tag;
end $$;
revoke all on function public.leads_bulk_update(uuid, text, jsonb, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.leads_bulk_update(uuid, text, jsonb, jsonb) to authenticated;

-- ---- 8. Erasure and note deletion: the service role's doors ----------------------------------
-- Is this profile, right now, allowed to erase in this tenant? The Worker has already run
-- assertCap('crm.erase') and its live recheck; the doors ask again, so the database holds
-- its own line. Locked counts as not live, as in liveRecheck.
create or replace function app.crm_eraser_ok(p_tenant uuid, p_actor uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles p
     where p.id = p_actor
       and p.tenant_id = p_tenant
       and p.is_active
       and (p.locked_until is null or p.locked_until <= now())
       and app.role_crm_erase(p.role::text))
$$;
revoke all on function app.crm_eraser_ok(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function app.crm_eraser_ok(uuid, uuid) to service_role;

-- Erase one lead (crm.md §8.2, for a lead; a person's erasure arrives with contacts, C5):
-- the lead, and by cascade its notes and its timeline. Returns what went, as counts.
-- P0002 when the tenant has no such lead, 42501 when the actor may not erase.
create or replace function public.crm_erase_lead(p_tenant uuid, p_lead uuid, p_actor uuid)
  returns jsonb
  language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  v_number int;
  v_notes int;
  v_events int;
begin
  if p_tenant is null or p_lead is null or p_actor is null then
    raise exception using errcode = '22023', message = 'crm_erase_lead: a tenant, a lead and an actor are required';
  end if;
  if not app.crm_eraser_ok(p_tenant, p_actor) then
    raise exception using errcode = '42501', message = 'crm_erase_lead: this person may not erase';
  end if;
  select l.lead_number into v_number
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
  return jsonb_build_object('lead_number', v_number, 'leads', 1, 'notes', v_notes, 'events', v_events);
end $$;
revoke all on function public.crm_erase_lead(uuid, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.crm_erase_lead(uuid, uuid, uuid) to service_role;

-- Delete one note from a lead's thread (crm.erase: notes are otherwise append-only).
-- Returns the note's source. The legacy mirror (expand window) is removed by clearing the
-- field it mirrors: deleting only the mirror would leave the words in internal_notes, and
-- the next legacy save would bring them back.
create or replace function public.crm_delete_lead_note(p_tenant uuid, p_lead uuid, p_note uuid, p_actor uuid)
  returns text
  language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  v_source text;
begin
  if p_tenant is null or p_lead is null or p_note is null or p_actor is null then
    raise exception using errcode = '22023', message = 'crm_delete_lead_note: a tenant, a lead, a note and an actor are required';
  end if;
  if not app.crm_eraser_ok(p_tenant, p_actor) then
    raise exception using errcode = '42501', message = 'crm_delete_lead_note: this person may not delete notes';
  end if;
  select n.source into v_source
    from public.lead_notes n
   where n.tenant_id = p_tenant and n.lead_id = p_lead and n.id = p_note;
  if not found then
    raise exception using errcode = 'P0002', message = 'crm_delete_lead_note: no such note';
  end if;
  if v_source = 'legacy' then
    update public.leads l set internal_notes = null
     where l.tenant_id = p_tenant and l.id = p_lead;
  end if;
  -- The thread note itself (and the mirror, should the field's trigger be gone by then).
  delete from public.lead_notes n
   where n.tenant_id = p_tenant and n.lead_id = p_lead and n.id = p_note;
  return v_source;
end $$;
revoke all on function public.crm_delete_lead_note(uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.crm_delete_lead_note(uuid, uuid, uuid, uuid) to service_role;

-- How many notes each of these leads has, as one object {lead id: count} (one row, so
-- PostgREST's row cap never cuts it short). Leads with no note are absent.
create or replace function public.crm_lead_note_counts(p_tenant uuid, p_leads uuid[])
  returns jsonb
  language sql stable security invoker set search_path = public, pg_temp as $$
  select coalesce(jsonb_object_agg(c.lead_id, c.n), '{}'::jsonb)
    from (select n.lead_id, count(*)::int as n
            from public.lead_notes n
           where n.tenant_id = p_tenant
             and n.lead_id = any(coalesce(p_leads, '{}'::uuid[]))
           group by n.lead_id) c
$$;
revoke all on function public.crm_lead_note_counts(uuid, uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.crm_lead_note_counts(uuid, uuid[]) to service_role;

-- ---- 9. leads_safe carries the new columns (appended; invoker rights restated) --------------
create or replace view public.leads_safe with (security_invoker = true) as
select
  id, tenant_id, kind, locale, name, message, service_of_interest,
  status, consent_marketing, created_at, updated_at, company, discipline_of_interest,
  lead_number, stage_id, is_spam, spam_marked_at, first_response_at, won_at, version,
  created_by, updated_by, score, source, channel,
  assigned_to, value_sar, is_starred, read_at, read_by, tags, last_contact_at,
  last_contact_channel
from public.leads;

-- ---- 10. Grants, stated (Admin v2 P-14: both Supabase grant regimes) ------------------------
grant select (assigned_to, value_sar, is_starred, read_at, read_by, tags, last_contact_at,
              last_contact_channel)
  on public.leads to authenticated;
-- The pipeline joins 0030's legacy pair. read_by is the trigger's (the session), never the
-- client's; the score, the indexes, the retention date and the ciphertext stay unwritable.
grant update (stage_id, is_spam, assigned_to, value_sar, is_starred, read_at, tags,
              last_contact_at, last_contact_channel)
  on public.leads to authenticated;
revoke all on public.leads_safe from public, anon, authenticated;
grant select on public.leads_safe to authenticated;

-- ---- Postconditions ---------------------------------------------------------------------
do $$
declare
  v_read constant text[] := array['id', 'tenant_id', 'kind', 'locale', 'name', 'company',
    'message', 'service_of_interest', 'discipline_of_interest', 'status',
    'consent_marketing', 'created_at', 'updated_at', 'lead_number', 'stage_id', 'is_spam',
    'spam_marked_at', 'first_response_at', 'won_at', 'version', 'created_by', 'updated_by',
    'score', 'source', 'channel', 'search_text', 'assigned_to', 'value_sar', 'is_starred',
    'read_at', 'read_by', 'tags', 'last_contact_at', 'last_contact_channel'];
  v_write constant text[] := array['status', 'internal_notes', 'stage_id', 'is_spam',
    'assigned_to', 'value_sar', 'is_starred', 'read_at', 'tags', 'last_contact_at',
    'last_contact_channel'];
  v_cols text[];
  v_fn text;
  p text;
begin
  -- Staff read exactly the safe lead columns, and write exactly the pipeline's.
  select coalesce(array_agg(a.attname::text order by a.attname), '{}')
    into v_cols
    from pg_attribute a
   where a.attrelid = 'public.leads'::regclass
     and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', 'public.leads', a.attname::text, 'select');
  if not (v_cols @> v_read and v_cols <@ v_read) then
    raise exception '0041: authenticated reads leads columns % (expected exactly %)', v_cols, v_read;
  end if;
  select coalesce(array_agg(a.attname::text order by a.attname), '{}')
    into v_cols
    from pg_attribute a
   where a.attrelid = 'public.leads'::regclass
     and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', 'public.leads', a.attname::text, 'update');
  if not (v_cols @> v_write and v_cols <@ v_write) then
    raise exception '0041: authenticated may update leads columns % (expected exactly %)', v_cols, v_write;
  end if;
  foreach p in array array['insert', 'update', 'delete', 'truncate'] loop
    if has_table_privilege('authenticated', 'public.leads', p) then
      raise exception '0041: authenticated holds table-wide % on leads', p;
    end if;
  end loop;
  if has_any_column_privilege('anon', 'public.leads', 'select')
     or has_any_column_privilege('anon', 'public.leads', 'update') then
    raise exception '0041: anon can reach leads';
  end if;
  foreach p in array array['select', 'insert', 'update', 'delete'] loop
    if not has_table_privilege('service_role', 'public.leads', p) then
      raise exception '0041: service_role lacks % on leads', p;
    end if;
  end loop;

  -- leads_safe: invoker rights, the new columns, no gated column, read-only for staff.
  if not (select coalesce(reloptions::text[] @> array['security_invoker=true'], false)
            from pg_class where oid = 'public.leads_safe'::regclass) then
    raise exception '0041: leads_safe lost security_invoker';
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'leads_safe'
                and column_name in ('email_enc', 'phone_enc', 'budget_enc', 'timeline_band',
                                    'timeline_text_enc', 'internal_notes', 'ip_inet',
                                    'retention_delete_after', 'retention_before_spam',
                                    'email_hmac', 'phone_hmac', 'score_signals',
                                    'crm_indexed_at', 'search_text')) then
    raise exception '0041: leads_safe exposes a gated lead column';
  end if;
  if (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'leads_safe'
         and column_name in ('assigned_to', 'value_sar', 'is_starred', 'read_at', 'read_by',
                             'tags', 'last_contact_at', 'last_contact_channel')) <> 8 then
    raise exception '0041: leads_safe lacks a new pipeline column';
  end if;
  if has_table_privilege('anon', 'public.leads_safe', 'select')
     or has_table_privilege('authenticated', 'public.leads_safe', 'update') then
    raise exception '0041: leads_safe grants are wrong';
  end if;

  -- The keys and the constraints.
  if not exists (select 1 from pg_constraint
                  where conname = 'leads_assignee_fk' and conrelid = 'public.leads'::regclass
                    and contype = 'f' and confdeltype = 'n'
                    and confrelid = 'public.profiles'::regclass) then
    raise exception '0041: leads_assignee_fk is missing or does not SET NULL';
  end if;
  foreach p in array array['leads_value_sar_range', 'leads_tags_ok',
                           'leads_last_contact_channel_ok', 'leads_last_contact_pair'] loop
    if not exists (select 1 from pg_constraint
                    where conname = p and conrelid = 'public.leads'::regclass and contype = 'c') then
      raise exception '0041: CHECK % is missing on leads', p;
    end if;
  end loop;

  -- Who may call what.
  foreach v_fn in array array['app.role_crm_erase(text)', 'app.tags_ok(text[])'] loop
    if has_function_privilege('anon', v_fn, 'execute')
       or not has_function_privilege('authenticated', v_fn, 'execute')
       or not has_function_privilege('service_role', v_fn, 'execute') then
      raise exception '0041: % must be executable by authenticated and service_role only', v_fn;
    end if;
  end loop;
  if has_function_privilege('anon', 'public.leads_bulk_update(uuid, text, jsonb, jsonb)', 'execute')
     or has_function_privilege('service_role', 'public.leads_bulk_update(uuid, text, jsonb, jsonb)', 'execute')
     or not has_function_privilege('authenticated', 'public.leads_bulk_update(uuid, text, jsonb, jsonb)', 'execute') then
    raise exception '0041: leads_bulk_update must be executable by authenticated only (the caller''s door)';
  end if;
  foreach v_fn in array array['public.crm_ingest_lead(uuid, jsonb)',
                              'public.crm_erase_lead(uuid, uuid, uuid)',
                              'public.crm_delete_lead_note(uuid, uuid, uuid, uuid)',
                              'public.crm_lead_note_counts(uuid, uuid[])',
                              'app.crm_eraser_ok(uuid, uuid)'] loop
    if has_function_privilege('anon', v_fn, 'execute')
       or has_function_privilege('authenticated', v_fn, 'execute')
       or not has_function_privilege('service_role', v_fn, 'execute') then
      raise exception '0041: % must be executable by the service role only', v_fn;
    end if;
  end loop;
  foreach v_fn in array array['public.leads_bulk_update(uuid, text, jsonb, jsonb)',
                              'public.crm_ingest_lead(uuid, jsonb)',
                              'public.crm_erase_lead(uuid, uuid, uuid)',
                              'public.crm_delete_lead_note(uuid, uuid, uuid, uuid)',
                              'public.crm_lead_note_counts(uuid, uuid[])'] loop
    if exists (select 1 from pg_proc where oid = v_fn::regprocedure and prosecdef) then
      raise exception '0041: % must be SECURITY INVOKER', v_fn;
    end if;
  end loop;

  -- Still one BEFORE trigger on leads, and its definers' owner still bypasses RLS (they
  -- write FORCE RLS tables with no policy for them).
  if (select coalesce(array_agg(distinct t.trigger_name::text order by t.trigger_name::text), '{}')
        from information_schema.triggers t
       where t.event_object_schema = 'public' and t.event_object_table = 'leads'
         and t.action_timing = 'BEFORE') <> array['leads_pipeline'] then
    raise exception '0041: leads must have exactly one BEFORE trigger, leads_pipeline';
  end if;
  foreach v_fn in array array['app.tg_lead_pipeline()', 'app.tg_lead_timeline()',
                              'app.crm_eraser_ok(uuid, uuid)'] loop
    if not exists (select 1 from pg_proc f join pg_roles r on r.oid = f.proowner
                    where f.oid = v_fn::regprocedure and f.prosecdef
                      and (r.rolsuper or r.rolbypassrls)) then
      raise exception '0041: % is not a definer owned by a role that bypasses RLS', v_fn;
    end if;
  end loop;
end $$;
