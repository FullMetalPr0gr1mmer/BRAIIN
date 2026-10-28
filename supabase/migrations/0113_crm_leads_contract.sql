-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 0113 — The leads contract (Admin v2 C14b): the legacy lead columns are dropped.
-- Forward-only: a CONTRACTION, the migration alone (migrations.md rule 6, launch runbook
-- §5a). C14a's code PR (#109), which stopped naming every column this file drops, merged and
-- deployed first, and one release passed with no legacy writer; this file is applied to
-- production before its own PR merges (the deploy guard refuses a checkout holding a
-- migration production lacks). Built with the placeholder 0111, renumbered 0112 above U5+U6's
-- 0111_services_projects, then 0113 above R11's 0112_release_schedule; its number is assigned
-- at the merge train (scripts/renumber-migration.mjs). Depends on 0033 (the staff column grant,
-- app.live_role), 0034 (the pipeline, the notes thread, the legacy sync and mirror), 0035
-- (crm_settings, crm_index_lead), 0041 (the latest app.tg_lead_pipeline,
-- app.tg_lead_timeline, crm_delete_lead_note and leads_safe), 0091 (crm_settings' column
-- triggers), 0097 (the legacy UPDATE grant withdrawn) and 0102 (site_settings.timezone, the
-- studio's one zone).
--
-- WHY. Leads v2 (0034) kept the four-value `status`, the free-text `internal_notes` field,
-- the never-written `ip_inet` and the plaintext `timeline_band` alive for the Worker deployed
-- before the CRM, with a BEFORE-trigger sync between `status` and the pipeline and a mirror of
-- the notes field into the thread. Since C14a no Worker code reads or writes any of them
-- (tests/lib/leadsContract.spec.ts), so the sync and the mirror serve nobody, and every
-- column is a place personal data could sit outside the audited paths. This step removes
-- them. `crm_settings.timezone` goes too: site_settings.timezone (0102) is the studio's one
-- zone, and since C14a nothing reads the CRM's copy.
--
--   1. Preconditions, under the drop's own locks (so nothing is written between the counts
--      and the drop), each a COUNT, never a value, run only by a role that bypasses row
--      security (leads forces it, so any other runner would count nothing): no lead holds a plaintext band without an
--      encrypted timeline (the daily cron moved every band it could read, 0035); no lead's
--      legacy notes field differs from its mirrored note (a field longer than the mirror's
--      5,000 characters differs, so no words are dropped unread); no lead holds an address
--      (`ip_inet` was never written); no tenant's only record of a non-default zone is
--      crm_settings (0102 copied the CRM zone to every site_settings row that existed, so
--      only a tenant with no site_settings row and a zone other than Riyadh could lose one);
--      every lead has a stage and every tenant exactly one initial stage (the arrival
--      default in 2. stands on it). Production counted 0, 0 and 0 of 2 leads for the first
--      three on 2026-10-25.
--   2. app.tg_lead_pipeline() restated from 0041 without its legacy steps: no band clause in
--      step 0, no sync in step 2 (an INSERT that names no stage takes its tenant's initial
--      stage, which the old `status` default gave it), no derived `status`; and the edit's
--      person is the session's alone (app.acting_for had one setter, the legacy branch of the
--      note door, which 4. removes).
--   3. app.tg_lead_timeline() restated without the notes mirror. The mirror notes already in
--      the thread (source 'legacy') stay: they are notes now, append-only like the rest.
--   4. public.crm_delete_lead_note restated without the legacy branch and its acting_for
--      bracket: a legacy note is deleted like any other, its note_deleted event still naming
--      the source. It writes no lead any more, so it sets no setting.
--   5. public.crm_index_lead restated with the same signature and without the band move.
--      `p_timeline_text_enc` stays (default null, ignored), so any caller that names it
--      still resolves; C14a's cron does not.
--   6. app.backfill_lead_pipeline() (0034's one-off backfill) and
--      app.lead_stage_for_status(uuid, text, uuid) (the sync's helper) dropped: both read
--      `status`, and nothing calls either after 2.
--   6b. Every lead still holding a notes field or a band is rewritten with both empty (the
--      BEFORE phase off for that one statement, so it is no edit): a dropped column's bytes
--      stay in a row until the row is next written, and the words should not.
--   7. leads: leads_safe dropped (it names `status`; `create or replace` can only append),
--      `leads_status_check` and `leads_tenant_status_idx` dropped by name, then the four
--      columns, RESTRICT: an object that depends on one fails the push instead of going with
--      it. Their column privileges go with them (0033's SELECT on `status`; 0030's UPDATE on
--      `status` and `internal_notes`, which 0097 already revoked). leads_safe is re-created in
--      the same transaction, WITH security_invoker (0015's warning: without it every
--      authenticated role reads every lead) and its grants stated for both regimes.
--   8. crm_settings: its three column-list triggers (0091) re-created without `timezone`
--      (a trigger that names a column is a dependency: the drop would fail), then the column
--      dropped (its CHECK and comment go with it).
--   9. Postconditions, true under both grant regimes (MAINTAIN only on 17+).
--
-- Unchanged: every policy on leads (none names a dropped column; the postconditions read them
-- back), the staff column grants on the columns that remain, crm_ingest_lead (0091: its
-- allow-list never named a dropped column), the readers (0063), the help guides (none
-- describes a dropped field), the notes route and the reveal (C14a).
--
-- Rollback floor (launch runbook §10): once this is applied, a Worker older than C14a's merge
-- commit names a dropped column (the legacy list and `?pii=1`, the export's `status`,
-- notify-lead's and the cron's band, the CRM settings' zone), and those paths fail (42703).
--
-- Production as of 2026-10-25: PostgreSQL 17.6, one tenant, two leads; the ledger holds
-- every migration through 0105, and the merge train pushes the slices that merge before this
-- one first. CLAUDE.md §3 (Pillar 1, lead PII), §5, §8 (Leads v2), §9.
-- ─────────────────────────────────────────────────────────────────────────────────────────

-- A busy table fails the push instead of queueing behind it: the push is retried later.
-- Every contact form writes leads and every admin lead screen reads them. Transaction-local.
set local lock_timeout = '5s';

-- ═══ 1. Nothing would be dropped unread ═══════════════════════════════════════════════════
-- The tables are locked first, in the mode the drops take anyway (ACCESS EXCLUSIVE), so no
-- write can land between the counts and the drops. The locks are taken inside the DO block,
-- not as a top-level LOCK TABLE: the Supabase CLI sends a migration as one extended-protocol
-- pipeline with no BEGIN, which PostgreSQL does not count as a transaction block, so a
-- top-level LOCK TABLE raises 25P01 there. A lock taken in plpgsql is held until the batch's
-- transaction ends, all the way to the drops. The block sets the 5 s bound itself as well, so
-- it holds however the top-level SET LOCAL above fared. crm_settings before leads: arrival and
-- a points change take them in that order (crm_ingest_lead reads the settings first; the
-- re-score trigger writes leads after the settings), so this file waits behind them instead
-- of deadlocking with them.
--
-- The notes thread is not locked. Every write that changes a legacy mirror goes through
-- leads (the mirror trigger, or the old note door, which clears the field before it deletes
-- the note), so the lock on leads holds the mirrors still; a mirror removed some other way
-- leaves its field unmatched, and the count below then refuses, the safe direction.
do $$
declare
  n_bands int;
  n_notes int;
  n_long int;
  n_addresses int;
  n_zones int;
  n_unstaged int;
  n_initial int;
begin
  -- leads and lead_stages force row security, so a runner that does not bypass it reads no
  -- row: every count below would be 0 and the columns would go unread. Production runs this
  -- as postgres (BYPASSRLS); anything else refuses before a lock is taken.
  if not coalesce((select r.rolsuper or r.rolbypassrls from pg_roles r
                    where r.rolname = current_user), false) then
    raise exception 'C14b: run this as a role that bypasses row security (the counts below would read no lead), so nothing is dropped';
  end if;
  perform set_config('lock_timeout', '5s', true);
  lock table public.crm_settings in access exclusive mode;
  lock table public.leads in access exclusive mode;

  -- A plaintext band with no encrypted timeline is one the cron never moved (a value it
  -- could not read, or a batch the key decrypted none of).
  select count(*) into n_bands
    from public.leads
   where timeline_band is not null and timeline_text_enc is null;
  if n_bands > 0 then
    raise exception 'C14b: % lead(s) hold a timeline band the cron never moved into the encrypted timeline, so nothing is dropped', n_bands
      using hint = 'Owner question 1 of docs/admin-v2/as-built/C14a.md: move the remaining bands first '
                   || '(a one-off step), or accept dropping them. Then push again.';
  end if;

  -- The mirror holds the field's first 5,000 characters, so a longer field differs from it
  -- and is counted: its tail would go with the column.
  select count(*), count(*) filter (where length(l.internal_notes) > 5000)
    into n_notes, n_long
    from public.leads l
   where nullif(btrim(l.internal_notes), '') is not null
     and not exists (select 1 from public.lead_notes m
                      where m.tenant_id = l.tenant_id and m.lead_id = l.id
                        and m.source = 'legacy' and m.body = l.internal_notes);
  if n_notes > 0 then
    raise exception 'C14b: % lead(s) hold a legacy notes field that differs from its mirrored note (% of them longer than the mirror''s 5,000 characters), so nothing is dropped', n_notes, n_long
      using hint = 'Copy each field''s words into the lead''s notes thread through the admin (or an '
                   || 'operator''s reviewed step), then push again (docs/admin-v2/as-built/C14b.md).';
  end if;

  select count(*) into n_addresses from public.leads where ip_inet is not null;
  if n_addresses > 0 then
    raise exception 'C14b: % lead(s) hold an ip_inet address, which no code ever wrote, so nothing is dropped', n_addresses
      using hint = 'Find out what wrote them before dropping the column (docs/admin-v2/as-built/C14b.md).';
  end if;

  -- 0102 gave every existing site_settings row its tenant's CRM zone; a tenant with no row
  -- reads the Riyadh default (app.studio_time_zone). Only such a tenant whose CRM zone is
  -- something else would lose a value here.
  select count(*) into n_zones
    from public.crm_settings c
   where c.timezone <> 'Asia/Riyadh'
     and not exists (select 1 from public.site_settings s where s.tenant_id = c.tenant_id);
  if n_zones > 0 then
    raise exception 'C14b: % tenant(s) keep a time zone only in crm_settings, so nothing is dropped', n_zones
      using hint = 'Save General settings once for that tenant (its time zone), then push again.';
  end if;

  select count(*) into n_unstaged from public.leads where stage_id is null;
  select count(*) into n_initial
    from public.tenants t
   where (select count(*) from public.lead_stages s where s.tenant_id = t.id and s.is_initial) <> 1;
  if n_unstaged > 0 or n_initial > 0 then
    raise exception 'C14b: % lead(s) without a stage, % tenant(s) without exactly one initial stage', n_unstaged, n_initial;
  end if;
end $$;

-- ═══ 2. The BEFORE phase, without the legacy steps ═════════════════════════════════════════
-- 0041's function, step for step; what C14b changes is marked (C14b). No comment in a body
-- below names a dropped column: the postconditions read the bodies.
create or replace function app.tg_lead_pipeline() returns trigger
  language plpgsql security definer set search_path = '' as $$
declare
  -- What the CRM works out for itself (the blind indexes, the score and its reasons, the
  -- index cursor: 0035, 0036). A write that changes only these is not an edit.
  c_derived constant text[] := array['email_hmac', 'phone_hmac', 'score', 'score_signals',
    'crm_indexed_at', 'search_text', 'updated_at', 'updated_by'];
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

-- ═══ 3. The AFTER phase, without the notes mirror ═══════════════════════════════════════════
create or replace function app.tg_lead_timeline() returns trigger
  language plpgsql security definer set search_path = '' as $$
declare
  -- (0041) Who did it: the session's person, else the one the BEFORE phase recorded (a
  -- service-role write made for someone: a manual add's creator). Every event below follows
  -- an edit, so updated_by is this write's own.
  v_actor uuid := coalesce(auth.uid(),
                           case when tg_op = 'INSERT' then new.created_by else new.updated_by end);
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
  -- (C14b) The notes are the thread's alone: a note's event is app.tg_lead_note_event's.
  return null;
end $$;
revoke all on function app.tg_lead_timeline() from public, anon, authenticated, service_role;

-- ═══ 4. Deleting one note: every note alike ═════════════════════════════════════════════════
-- (C14b) 0041's door without the legacy branch. A note that came from the old field (source
-- 'legacy') is deleted like a thread note; there is no field left to clear, so the door
-- writes no lead and names no one through a setting. The timeline still says a note went,
-- which one, from where, and who removed it: never its words.
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
  delete from public.lead_notes n
   where n.tenant_id = p_tenant and n.lead_id = p_lead and n.id = p_note;
  insert into public.lead_events (tenant_id, lead_id, actor_id, kind, detail)
  values (p_tenant, p_lead, p_actor, 'note_deleted',
          jsonb_build_object('note_id', p_note, 'source', v_source));
  return v_source;
end $$;
revoke all on function public.crm_delete_lead_note(uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.crm_delete_lead_note(uuid, uuid, uuid, uuid) to service_role;

-- ═══ 5. The daily index door, without the band move ═════════════════════════════════════════
-- (C14b) 0035's function with the same signature. The last parameter, the band's encrypted
-- label an older cron sent, stays (default null) so a caller that names it still resolves,
-- and is ignored: there is no band left to move. Not an edit: it changes only what the CRM
-- derives, so the lead keeps its updated_at and updated_by (app.tg_lead_pipeline step 0).
create or replace function public.crm_index_lead(
  p_tenant uuid,
  p_id uuid,
  p_email_hmac text,
  p_phone_hmac text,
  p_signals text[],
  p_timeline_text_enc text default null
) returns boolean
  language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_signals text[];
  v_scoring jsonb;
  v_created timestamptz;
begin
  select created_at into v_created from public.leads where tenant_id = p_tenant and id = p_id;
  if v_created is null then
    return false;
  end if;
  select coalesce(array_agg(distinct s order by s), '{}') into v_signals
    from unnest(coalesce(p_signals, '{}')) s
   where s <> 'returning';
  -- `returning`: someone with this e-mail wrote to us BEFORE this lead.
  if p_email_hmac is not null and exists (
       select 1 from public.leads
        where tenant_id = p_tenant and email_hmac = p_email_hmac and id <> p_id
          and created_at < v_created) then
    v_signals := v_signals || 'returning'::text;
  end if;
  select scoring into v_scoring from public.crm_settings where tenant_id = p_tenant;

  update public.leads
     set email_hmac = p_email_hmac,
         phone_hmac = p_phone_hmac,
         score_signals = v_signals,
         score = app.lead_score(v_signals, coalesce(v_scoring, '{}'::jsonb)),
         crm_indexed_at = now()
   where tenant_id = p_tenant and id = p_id;
  return found;
end $$;
revoke all on function public.crm_index_lead(uuid, uuid, text, text, text[], text)
  from public, anon, authenticated, service_role;
grant execute on function public.crm_index_lead(uuid, uuid, text, text, text[], text) to service_role;

-- ═══ 6. The legacy helpers go ═══════════════════════════════════════════════════════════════
-- RESTRICT (the default): a dependency the catalog records fails the push. Nothing calls
-- either once 2. is in place (the postconditions read every function body for their names).
drop function app.backfill_lead_pipeline();
drop function app.lead_stage_for_status(uuid, text, uuid);

-- ═══ 6b. The words leave the rows, not only the catalog ═════════════════════════════════════
-- DROP COLUMN only hides a column: a row keeps the dropped value's bytes on disk (and in a
-- physical backup) until that row is next written. So every lead still holding a notes field
-- (each one matches a mirrored note, 1. refused otherwise) or a moved band is rewritten with
-- both empty first; autovacuum then reclaims the old versions. This runs after 3., so the
-- mirror notes stay in the thread. The BEFORE phase is switched off for this one statement,
-- under the ACCESS EXCLUSIVE lock 1. holds, so the rewrite is no edit: each lead keeps its
-- updated_at, updated_by and version (the AFTER phase records nothing for these columns).
-- The postconditions check that every trigger on leads is switched on again.
alter table public.leads disable trigger leads_pipeline;
do $$
declare
  n_rewritten int;
begin
  update public.leads
     set internal_notes = null, timeline_band = null
   where internal_notes is not null or timeline_band is not null;
  get diagnostics n_rewritten = row_count;
  raise notice 'C14b: % lead row(s) rewritten without the notes field and the band', n_rewritten;
  if exists (select 1 from public.leads
              where internal_notes is not null or timeline_band is not null) then
    raise exception 'C14b: a lead still holds a notes field or a band before the drop';
  end if;
end $$;
alter table public.leads enable trigger leads_pipeline;

-- ═══ 7. The lead columns go, and leads_safe is re-created without status ═════════════════════
-- One transaction: no reader meets leads_safe missing or with default rights. The view goes
-- first because it names `status`; the CHECK and the index are named so the file says
-- everything it removes (each would go with its column anyway).
drop view public.leads_safe;
alter table public.leads drop constraint leads_status_check;
drop index public.leads_tenant_status_idx;
alter table public.leads
  drop column status,
  drop column internal_notes,
  drop column ip_inet,
  drop column timeline_band;

-- 0041's list less `status`, in 0041's order. `security_invoker = true` is the point: a view
-- runs with its owner's rights unless it says otherwise, and it is granted to every signed-in
-- role, Content Creator and SEO included (a GRANT cannot tell app roles apart), so without
-- the option every authenticated role would read every lead of every tenant through it.
create view public.leads_safe with (security_invoker = true) as
select
  id, tenant_id, kind, locale, name, message, service_of_interest,
  consent_marketing, created_at, updated_at, company, discipline_of_interest,
  lead_number, stage_id, is_spam, spam_marked_at, first_response_at, won_at, version,
  created_by, updated_by, score, source, channel,
  assigned_to, value_sar, is_starred, read_at, read_by, tags, last_contact_at,
  last_contact_channel
from public.leads;
-- P-14: a new view takes the regime's default privileges, so both sides are stated. Staff
-- read it; nothing else, the service role included (nothing reads it as the service role,
-- and it is in FORBIDDEN_BACKUP_TABLES).
revoke all on public.leads_safe from public, anon, authenticated, service_role;
grant select on public.leads_safe to authenticated;

-- ═══ 8. crm_settings.timezone goes ══════════════════════════════════════════════════════════
-- 0091's three triggers, the same names (so the same alphabetical order among the BEFORE
-- triggers) and the same functions, with `timezone` out of their column lists.
drop trigger crm_settings_updated_at on public.crm_settings;
create trigger crm_settings_updated_at
  before update of scoring, sla_hours, assignment_rule, assignment_pool, assignment_fixed_to
  on public.crm_settings
  for each row execute function app.tg_set_updated_at();
drop trigger crm_settings_actor on public.crm_settings;
create trigger crm_settings_actor
  before insert or update of scoring, sla_hours, assignment_rule, assignment_pool,
                             assignment_fixed_to
  on public.crm_settings
  for each row execute function app.tg_set_actor();
drop trigger crm_settings_version on public.crm_settings;
create trigger crm_settings_version
  before update of scoring, sla_hours, assignment_rule, assignment_pool, assignment_fixed_to
  on public.crm_settings
  for each row execute function app.tg_bump_version();
alter table public.crm_settings drop column timezone;

-- ═══ Postconditions ═══════════════════════════════════════════════════════════════════════
do $$
declare
  v_lead_cols constant text[] := array[
    'assigned_to', 'budget_enc', 'channel', 'company', 'consent_marketing', 'created_at',
    'created_by', 'crm_indexed_at', 'discipline_of_interest', 'email_enc', 'email_hmac',
    'first_response_at', 'id', 'is_spam', 'is_starred', 'kind', 'last_contact_at',
    'last_contact_channel', 'lead_number', 'locale', 'message', 'name', 'phone_enc',
    'phone_hmac', 'read_at', 'read_by', 'retention_before_spam', 'retention_delete_after',
    'score', 'score_signals', 'search_text', 'service_of_interest', 'source', 'spam_marked_at',
    'stage_id', 'tags', 'tenant_id', 'timeline_text_enc', 'updated_at', 'updated_by', 'value_sar',
    'version', 'won_at'];
  v_safe constant text[] := array[
    'id', 'tenant_id', 'kind', 'locale', 'name', 'message', 'service_of_interest',
    'consent_marketing', 'created_at', 'updated_at', 'company', 'discipline_of_interest',
    'lead_number', 'stage_id', 'is_spam', 'spam_marked_at', 'first_response_at', 'won_at',
    'version', 'created_by', 'updated_by', 'score', 'source', 'channel', 'assigned_to',
    'value_sar', 'is_starred', 'read_at', 'read_by', 'tags', 'last_contact_at',
    'last_contact_channel'];
  v_read constant text[] := array[
    'assigned_to', 'channel', 'company', 'consent_marketing', 'created_at', 'created_by',
    'discipline_of_interest', 'first_response_at', 'id', 'is_spam', 'is_starred', 'kind',
    'last_contact_at', 'last_contact_channel', 'lead_number', 'locale', 'message', 'name',
    'read_at', 'read_by', 'score', 'search_text', 'service_of_interest', 'source',
    'spam_marked_at', 'stage_id', 'tags', 'tenant_id', 'updated_at', 'updated_by', 'value_sar',
    'version', 'won_at'];
  v_write constant text[] := array[
    'assigned_to', 'is_spam', 'is_starred', 'last_contact_at', 'last_contact_channel',
    'read_at', 'stage_id', 'tags', 'value_sar'];
  v_crm_cols constant text[] := array[
    'assignment_fixed_to', 'assignment_pool', 'assignment_rule', 'created_at', 'created_by',
    'rr_cursor', 'scoring', 'sla_hours', 'tenant_id', 'updated_at', 'updated_by', 'version'];
  v_crm_write constant text[] := array[
    'assignment_fixed_to', 'assignment_pool', 'assignment_rule', 'scoring', 'sla_hours'];
  v_cfg constant text := 'scoring, sla_hours, assignment_rule, assignment_pool, assignment_fixed_to';
  v_got text[];
  v_bad text;
  v_fn text;
  r text;
  v_maintain boolean := current_setting('server_version_num')::int >= 170000;
begin
  -- ---- 1. The columns -----------------------------------------------------------------------
  select array_agg(a.attname::text order by a.attname::text collate "C") into v_got
    from pg_attribute a
   where a.attrelid = 'public.leads'::regclass and a.attnum > 0 and not a.attisdropped;
  if v_got is distinct from v_lead_cols then
    raise exception 'C14b: public.leads has the columns %', v_got;
  end if;
  select array_agg(a.attname::text order by a.attname::text collate "C") into v_got
    from pg_attribute a
   where a.attrelid = 'public.crm_settings'::regclass and a.attnum > 0 and not a.attisdropped;
  if v_got is distinct from v_crm_cols then
    raise exception 'C14b: public.crm_settings has the columns %', v_got;
  end if;
  if to_regclass('public.leads_tenant_status_idx') is not null
     or exists (select 1 from pg_constraint
                 where conrelid = 'public.leads'::regclass and conname = 'leads_status_check') then
    raise exception 'C14b: the status index or CHECK is still there';
  end if;

  -- ---- 2. leads_safe: invoker rights, exactly the safe columns, SELECT for staff only -----
  if not (select coalesce(c.reloptions::text[] @> array['security_invoker=true'], false)
            from pg_class c where c.oid = 'public.leads_safe'::regclass and c.relkind = 'v') then
    raise exception 'C14b: leads_safe is not a SECURITY INVOKER view (every authenticated role would read every lead)';
  end if;
  select array_agg(a.attname::text order by a.attnum) into v_got
    from pg_attribute a
   where a.attrelid = 'public.leads_safe'::regclass and a.attnum > 0 and not a.attisdropped;
  if v_got is distinct from v_safe then
    raise exception 'C14b: leads_safe has the columns %, expected %', v_got, v_safe;
  end if;
  if not has_table_privilege('authenticated', 'public.leads_safe', 'select')
     or has_table_privilege('authenticated', 'public.leads_safe',
                            'insert, update, delete, truncate, references, trigger')
     or has_any_column_privilege('authenticated', 'public.leads_safe', 'insert, update, references')
     or (case when v_maintain
              then has_table_privilege('authenticated', 'public.leads_safe', 'maintain')
              else false end) then
    raise exception 'C14b: authenticated must hold SELECT and nothing else on leads_safe';
  end if;
  foreach r in array array['public', 'anon', 'service_role'] loop
    if has_table_privilege(r::name, 'public.leads_safe',
                           'select, insert, update, delete, truncate, references, trigger')
       or has_any_column_privilege(r::name, 'public.leads_safe', 'select, insert, update, references')
       or (case when v_maintain
                then has_table_privilege(r::name, 'public.leads_safe', 'maintain')
                else false end) then
      raise exception 'C14b: % holds a privilege on leads_safe', r;
    end if;
  end loop;

  -- ---- 3. leads: the staff column grants, exactly; anon and PUBLIC nothing -----------------
  select coalesce(array_agg(a.attname::text order by a.attname::text collate "C"), '{}') into v_got
    from pg_attribute a
   where a.attrelid = 'public.leads'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', a.attrelid, a.attnum, 'select');
  if v_got is distinct from v_read then
    raise exception 'C14b: authenticated reads the leads columns %, expected %', v_got, v_read;
  end if;
  select coalesce(array_agg(a.attname::text order by a.attname::text collate "C"), '{}') into v_got
    from pg_attribute a
   where a.attrelid = 'public.leads'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', a.attrelid, a.attnum, 'update');
  if v_got is distinct from v_write then
    raise exception 'C14b: authenticated updates the leads columns %, expected %', v_got, v_write;
  end if;
  if has_table_privilege('authenticated', 'public.leads',
                         'select, insert, update, delete, truncate, references, trigger')
     or has_any_column_privilege('authenticated', 'public.leads', 'insert, references')
     or (case when v_maintain
              then has_table_privilege('authenticated', 'public.leads', 'maintain')
              else false end) then
    raise exception 'C14b: authenticated holds a table-wide privilege, or a column INSERT or REFERENCES, on leads';
  end if;
  foreach r in array array['public', 'anon'] loop
    if has_table_privilege(r::name, 'public.leads',
                           'select, insert, update, delete, truncate, references, trigger')
       or has_any_column_privilege(r::name, 'public.leads', 'select, insert, update, references')
       or (case when v_maintain
                then has_table_privilege(r::name, 'public.leads', 'maintain')
                else false end) then
      raise exception 'C14b: % holds a privilege on leads', r;
    end if;
  end loop;
  foreach r in array array['select', 'insert', 'update', 'delete'] loop
    if not has_table_privilege('service_role', 'public.leads', r) then
      raise exception 'C14b: service_role lacks % on leads (the ingest, reveal, export and erase paths)', r;
    end if;
  end loop;

  -- ---- 4. The policies on leads: still the three, each leading with the tenant predicate ---
  select array_agg(format('%s %s %s', policyname, cmd, permissive) order by policyname collate "C")
    into v_got
    from pg_policies where schemaname = 'public' and tablename = 'leads';
  if v_got is distinct from array['leads_live ALL RESTRICTIVE', 'leads_read SELECT PERMISSIVE',
                                  'leads_update UPDATE PERMISSIVE'] then
    raise exception 'C14b: the policies on leads are %', v_got;
  end if;
  if exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = 'leads'
                and (coalesce(qual, '') !~ '^\(\(tenant_id = (app\.)?effective_tenant_id\(\)\) AND '
                     or (with_check is not null
                         and with_check !~ '^\(\(tenant_id = (app\.)?effective_tenant_id\(\)\) AND '))) then
    raise exception 'C14b: a policy on leads does not lead with the tenant predicate';
  end if;
  if not exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'leads' and policyname = 'leads_live'
                    and qual ~ 'live_role' and with_check ~ 'live_role') then
    raise exception 'C14b: leads_live no longer carries the live check';
  end if;

  -- ---- 5. The functions --------------------------------------------------------------------
  -- The four restated bodies name no dropped column and no acting_for setting.
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
    from pg_proc p
   where p.oid in ('app.tg_lead_pipeline()'::regprocedure, 'app.tg_lead_timeline()'::regprocedure,
                   'public.crm_delete_lead_note(uuid, uuid, uuid, uuid)'::regprocedure,
                   'public.crm_index_lead(uuid, uuid, text, text, text[], text)'::regprocedure)
     and p.prosrc ~* '\m(status|internal_notes|timeline_band|ip_inet|acting_for|set_config)\M';
  if v_bad is not null then
    raise exception 'C14b: % still name a dropped column or a setting', v_bad;
  end if;
  -- No function in app or public names the band, the address, the dropped helpers or the
  -- acting_for setting; the notes field only in job-application code (job_applications keeps
  -- its own, 0029).
  select string_agg(n.nspname || '.' || p.proname, ', ' order by n.nspname, p.proname) into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('app', 'public')
     and (p.prosrc ~* '\m(timeline_band|ip_inet|lead_stage_for_status|backfill_lead_pipeline|acting_for)\M'
          or (p.prosrc ~* '\minternal_notes\M' and p.prosrc !~* '\mjob_applications\M'));
  if v_bad is not null then
    raise exception 'C14b: functions still naming a dropped lead column or helper: %', v_bad;
  end if;
  if to_regprocedure('app.backfill_lead_pipeline()') is not null
     or to_regprocedure('app.lead_stage_for_status(uuid, text, uuid)') is not null then
    raise exception 'C14b: a dropped legacy helper is still there';
  end if;
  -- Who may call what: the triggers no API role; the two doors the service role only, as
  -- SECURITY INVOKER; the triggers SECURITY DEFINER, owned by a role that bypasses RLS (they
  -- write FORCE RLS tables with no policy for them).
  foreach v_fn in array array['app.tg_lead_pipeline()', 'app.tg_lead_timeline()'] loop
    if has_function_privilege('anon', v_fn, 'execute')
       or has_function_privilege('authenticated', v_fn, 'execute')
       or has_function_privilege('service_role', v_fn, 'execute') then
      raise exception 'C14b: % is executable by an API role', v_fn;
    end if;
    if not exists (select 1 from pg_proc f join pg_roles o on o.oid = f.proowner
                    where f.oid = v_fn::regprocedure and f.prosecdef
                      and (o.rolsuper or o.rolbypassrls)) then
      raise exception 'C14b: % is not a definer owned by a role that bypasses RLS', v_fn;
    end if;
  end loop;
  foreach v_fn in array array['public.crm_delete_lead_note(uuid, uuid, uuid, uuid)',
                              'public.crm_index_lead(uuid, uuid, text, text, text[], text)'] loop
    if has_function_privilege('anon', v_fn, 'execute')
       or has_function_privilege('authenticated', v_fn, 'execute')
       or not has_function_privilege('service_role', v_fn, 'execute') then
      raise exception 'C14b: % must be executable by the service role only', v_fn;
    end if;
    if exists (select 1 from pg_proc where oid = v_fn::regprocedure and prosecdef) then
      raise exception 'C14b: % must be SECURITY INVOKER', v_fn;
    end if;
  end loop;

  -- ---- 6. The triggers ---------------------------------------------------------------------
  -- leads: still one BEFORE and one AFTER phase function (and 0048's notification hook).
  select array_agg(format('%s %s.%s', t.tgname, fn.nspname, f.proname) order by t.tgname collate "C")
    into v_got
    from pg_trigger t
    join pg_proc f on f.oid = t.tgfoid
    join pg_namespace fn on fn.oid = f.pronamespace
   where t.tgrelid = 'public.leads'::regclass and not t.tgisinternal;
  if v_got is distinct from array['leads_notify app.tg_notify_lead',
                                  'leads_pipeline app.tg_lead_pipeline',
                                  'leads_timeline app.tg_lead_timeline'] then
    raise exception 'C14b: the triggers on leads are %', v_got;
  end if;
  -- 6b switched the BEFORE phase off for one statement: every trigger fires again, always.
  if exists (select 1 from pg_trigger t
              where t.tgrelid = 'public.leads'::regclass and not t.tgisinternal
                and t.tgenabled::text <> 'O') then
    raise exception 'C14b: a trigger on leads is not switched on';
  end if;
  -- crm_settings: the three stamps fire on the configuration columns, exactly.
  if (select count(*) from pg_trigger t
       where t.tgrelid = 'public.crm_settings'::regclass and not t.tgisinternal
         and (t.tgname, pg_get_triggerdef(t.oid)) in (
           ('crm_settings_updated_at',
            'CREATE TRIGGER crm_settings_updated_at BEFORE UPDATE OF ' || v_cfg
            || ' ON public.crm_settings FOR EACH ROW EXECUTE FUNCTION app.tg_set_updated_at()'),
           ('crm_settings_actor',
            'CREATE TRIGGER crm_settings_actor BEFORE INSERT OR UPDATE OF ' || v_cfg
            || ' ON public.crm_settings FOR EACH ROW EXECUTE FUNCTION app.tg_set_actor()'),
           ('crm_settings_version',
            'CREATE TRIGGER crm_settings_version BEFORE UPDATE OF ' || v_cfg
            || ' ON public.crm_settings FOR EACH ROW EXECUTE FUNCTION app.tg_bump_version()'))) <> 3 then
    raise exception 'C14b: crm_settings'' stamp triggers do not fire on exactly the configuration columns';
  end if;
  select coalesce(array_agg(a.attname::text order by a.attname::text collate "C"), '{}') into v_got
    from pg_attribute a
   where a.attrelid = 'public.crm_settings'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', a.attrelid, a.attnum, 'update');
  if v_got is distinct from v_crm_write then
    raise exception 'C14b: authenticated updates the crm_settings columns %, expected %', v_got, v_crm_write;
  end if;

  -- ---- 7. Every lead in the pipeline, every tenant with its one initial stage --------------
  if exists (select 1 from public.leads where stage_id is null)
     or exists (select 1 from public.tenants t
                 where (select count(*) from public.lead_stages s
                         where s.tenant_id = t.id and s.is_initial) <> 1) then
    raise exception 'C14b: a lead has no stage, or a tenant has not exactly one initial stage';
  end if;
end $$;
