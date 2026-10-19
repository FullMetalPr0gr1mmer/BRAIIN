-- ─────────────────────────────────────────────────────────────────────────────
-- 0091 — CRM settings for leads (Admin v2 C9a). Forward-only, EXPAND only.
-- Depends on 0033 (app.live_role), 0034 (lead_stages), 0035 (crm_settings, app.lead_score),
-- 0041 (crm_ingest_lead as restated, the assignee rule, profiles (tenant_id, id)).
-- The number is a placeholder: scripts/renumber-migration.mjs moves it at merge.
--
-- The leads half of crm.md CRM-9 (the approved plan's B2: custom fields are C9b, with the
-- contacts it describes). What it adds:
--
--   • crm.settings, a new capability (Admin only, CLAUDE.md §5), and its one SQL helper,
--     app.role_crm_settings (tests/authz/sqlHelpers.spec.ts holds it equal to ROLE_CAPS).
--   • crm_settings gains the assignment rule (manual by default, owner item O-9; round
--     robin over a pool of at most 20 people; or always one person) and the round-robin
--     cursor. Its configuration columns (the points, the response time, the rule, the pool
--     and the person) become writable by crm.settings holders through a COLUMN grant, a
--     policy and a RESTRICTIVE live check (a demoted or locked token changes nothing). The
--     time zone is not among them: site_profile.timezone (U9) becomes its one source (the
--     plan's B7.5). The version, updated_at and updated_by move only with the configuration,
--     so a lead arriving under round robin (which moves the cursor) never makes a settings
--     save a 409.
--   • Changing the points re-scores every lead of the tenant in the same statement, through
--     a definer trigger (the score is outside the staff column grant, and it is derived, so
--     no lead looks edited: app.tg_lead_pipeline's c_derived). A trigger, not an RPC step:
--     any path that changes the points re-scores.
--   • The assignees are checked when they are named: each person newly added to the pool,
--     and the one person, must be an active lead worker of the tenant (23514, naming a
--     constraint for the Worker). Someone deactivated later blocks nothing; arrival skips
--     them.
--   • A stage that holds leads keeps its kind, whoever writes it (a definer trigger).
--   • lead_stages becomes editable by crm.settings holders: INSERT of the label, tone, kind,
--     order and key; UPDATE of the label, tone, kind and order; DELETE of a stage that is not
--     the initial one. Column grants, so no API caller makes a second initial stage, moves the
--     initial flag, renames a key or picks a tenant. A stage with leads in it cannot be
--     deleted (the 0034 foreign key, RESTRICT), and the 0034 constraint trigger still checks
--     the whole set at commit (2 to 10, one initial, a won and a lost).
--   • public.save_lead_stages(p_tenant, p_known, p_stages): the screen's door. A whole
--     pipeline in board order, applied against the set as the caller loaded it (40001 when
--     anything changed since), as the caller (SECURITY INVOKER: RLS, the live check and the
--     column grants decide), with the errors a person can act on ("Move its N leads first").
--   • public.lead_stage_counts(p_tenant): how many leads sit in each stage (spam included:
--     a spam lead keeps its stage), as the caller.
--   • public.crm_ingest_lead restated with one new step: the assignment, through the definer
--     app.crm_pick_assignee (manual: nobody; fixed: the person while they are an active lead
--     worker; round robin: the next active lead worker of the pool in pool order, the cursor
--     moved under the settings row's lock). The allow-list is unchanged.
-- ─────────────────────────────────────────────────────────────────────────────

-- A busy table fails the push instead of queueing (as 0041 does). This takes ACCESS
-- EXCLUSIVE on crm_settings (new columns) and SHARE ROW EXCLUSIVE on profiles (the key the
-- new foreign key references): every admin request reads profiles, so a lock request waiting
-- behind a long reader would queue sign-ins behind it. Transaction-local.
set local lock_timeout = '5s';

-- ---- 1. The capability helper ------------------------------------------------------------
create or replace function app.role_crm_settings(r text) returns boolean
  language sql immutable
as $$ select coalesce(r in ('admin'), false) $$;  -- crm.settings
revoke all on function app.role_crm_settings(text) from public, anon, authenticated, service_role;
grant execute on function app.role_crm_settings(text) to authenticated, service_role;

-- ---- 2. The assignment columns -------------------------------------------------------------
-- A pool: one dimension, at most 20 people, no blanks, each once. Used in a CHECK, so every
-- writer needs EXECUTE (as app.crm_scoring_ok, 0035).
create or replace function app.crm_pool_ok(p uuid[]) returns boolean
  language sql immutable as $$
  select p is not null
     and (array_ndims(p) is null or array_ndims(p) = 1)
     and cardinality(p) <= 20
     and array_position(p, null) is null
     and cardinality(p) = (select count(distinct m) from unnest(p) m)
$$;
revoke all on function app.crm_pool_ok(uuid[]) from public, anon, authenticated, service_role;
grant execute on function app.crm_pool_ok(uuid[]) to authenticated, service_role;

alter table public.crm_settings
  add column if not exists assignment_rule text not null default 'manual',
  add column if not exists assignment_pool uuid[] not null default '{}',
  add column if not exists assignment_fixed_to uuid,
  add column if not exists rr_cursor int not null default 0;
alter table public.crm_settings drop constraint if exists crm_settings_assignment_rule_ok;
alter table public.crm_settings add constraint crm_settings_assignment_rule_ok
  check (assignment_rule in ('manual', 'round_robin', 'fixed'));
alter table public.crm_settings drop constraint if exists crm_settings_assignment_pool_ok;
alter table public.crm_settings add constraint crm_settings_assignment_pool_ok
  check (app.crm_pool_ok(assignment_pool));
alter table public.crm_settings drop constraint if exists crm_settings_rr_cursor_ok;
alter table public.crm_settings add constraint crm_settings_rr_cursor_ok check (rr_cursor >= 0);
-- The one person is a profile of the same tenant; a profile that goes leaves the rule
-- without a person, and arrival then assigns nobody (as a manual rule would).
alter table public.crm_settings drop constraint if exists crm_settings_fixed_to_fk;
alter table public.crm_settings add constraint crm_settings_fixed_to_fk
  foreign key (tenant_id, assignment_fixed_to) references public.profiles (tenant_id, id)
  on delete set null (assignment_fixed_to);

-- ---- 3. The stamps follow the configuration, never the cursor -------------------------------
-- 0035 fired these on every update. Arrival under round robin moves rr_cursor; a version
-- bumped by that would make the screen's next save a 409 for nothing.
drop trigger if exists crm_settings_updated_at on public.crm_settings;
create trigger crm_settings_updated_at
  before update of scoring, sla_hours, timezone, assignment_rule, assignment_pool, assignment_fixed_to
  on public.crm_settings
  for each row execute function app.tg_set_updated_at();
drop trigger if exists crm_settings_actor on public.crm_settings;
create trigger crm_settings_actor
  before insert or update of scoring, sla_hours, timezone, assignment_rule, assignment_pool,
                             assignment_fixed_to
  on public.crm_settings
  for each row execute function app.tg_set_actor();
drop trigger if exists crm_settings_version on public.crm_settings;
create trigger crm_settings_version
  before update of scoring, sla_hours, timezone, assignment_rule, assignment_pool, assignment_fixed_to
  on public.crm_settings
  for each row execute function app.tg_bump_version();

-- The assignees, checked when they are named (a definer: a staff token reads only its own
-- profile). Only people ADDED to the pool are checked, so a member deactivated since does not
-- block a save that leaves them in; arrival skips them. The messages name a constraint so the
-- Worker can say which field is wrong.
create or replace function app.tg_crm_settings_assignees() returns trigger
  language plpgsql security definer set search_path = '' as $$
declare
  v_added uuid[];
begin
  if tg_op = 'INSERT' then
    v_added := new.assignment_pool;
  else
    select coalesce(array_agg(m), '{}') into v_added
      from unnest(new.assignment_pool) m
     where not (m = any (old.assignment_pool));
  end if;
  if exists (select 1 from unnest(v_added) m
              where not exists (select 1 from public.profiles p
                                 where p.id = m and p.tenant_id = new.tenant_id and p.is_active
                                   and app.role_works_leads(p.role::text))) then
    raise exception using errcode = '23514',
      message = 'everyone in the pool must be an active lead worker of this tenant (constraint "crm_settings_assignment_pool")';
  end if;
  if new.assignment_fixed_to is not null
     and (tg_op = 'INSERT' or new.assignment_fixed_to is distinct from old.assignment_fixed_to)
     and not exists (select 1 from public.profiles p
                      where p.id = new.assignment_fixed_to and p.tenant_id = new.tenant_id
                        and p.is_active and app.role_works_leads(p.role::text)) then
    raise exception using errcode = '23514',
      message = 'the person must be an active lead worker of this tenant (constraint "crm_settings_assignment_fixed_to")';
  end if;
  -- A rule chosen now must have someone to give leads to. Checked when the rule is set, not
  -- on every write: a profile deleted later empties the person (the key's SET NULL fires
  -- this trigger too) and must not be refused.
  if tg_op = 'INSERT' or new.assignment_rule is distinct from old.assignment_rule then
    if new.assignment_rule = 'fixed' and new.assignment_fixed_to is null then
      raise exception using errcode = '23514',
        message = 'always to one person needs the person (constraint "crm_settings_assignment_fixed_to")';
    end if;
    if new.assignment_rule = 'round_robin' and cardinality(new.assignment_pool) = 0 then
      raise exception using errcode = '23514',
        message = 'round robin needs at least one person (constraint "crm_settings_assignment_pool")';
    end if;
  end if;
  return new;
end $$;
revoke all on function app.tg_crm_settings_assignees() from public, anon, authenticated, service_role;
drop trigger if exists crm_settings_assignees on public.crm_settings;
create trigger crm_settings_assignees
  before insert or update of assignment_rule, assignment_pool, assignment_fixed_to
  on public.crm_settings
  for each row execute function app.tg_crm_settings_assignees();

-- ---- 4. New points re-score every lead -------------------------------------------------------
-- In the statement that changes them, so the list never shows scores from the old points. A
-- definer: the score is outside the staff column grant. Only leads whose score moves are
-- written, and a score is derived, so the lead's version, updated_at and updated_by stay
-- (app.tg_lead_pipeline, 0041: c_derived) and its timeline records nothing.
create or replace function app.tg_crm_settings_rescore() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  if new.scoring is distinct from old.scoring then
    update public.leads l
       set score = app.lead_score(l.score_signals, new.scoring)
     where l.tenant_id = new.tenant_id
       and l.score is distinct from app.lead_score(l.score_signals, new.scoring);
  end if;
  return null;
end $$;
revoke all on function app.tg_crm_settings_rescore() from public, anon, authenticated, service_role;
drop trigger if exists crm_settings_rescore on public.crm_settings;
create trigger crm_settings_rescore
  after update of scoring on public.crm_settings
  for each row execute function app.tg_crm_settings_rescore();

-- ---- 5. Who reads and writes crm_settings ----------------------------------------------------
-- Configuration, not personal data: lead workers and crm.settings holders read it;
-- crm.settings holders write its configuration, live.
drop policy if exists crm_settings_read on public.crm_settings;
create policy crm_settings_read on public.crm_settings for select to authenticated
  using (tenant_id = app.effective_tenant_id()
         and (app.role_works_leads(app.current_role()) or app.role_crm_settings(app.current_role())));
drop policy if exists crm_settings_write on public.crm_settings;
create policy crm_settings_write on public.crm_settings for update to authenticated
  using (tenant_id = app.effective_tenant_id() and app.role_crm_settings(app.current_role()))
  with check (tenant_id = app.effective_tenant_id() and app.role_crm_settings(app.current_role()));
drop policy if exists crm_settings_write_live on public.crm_settings;
create policy crm_settings_write_live on public.crm_settings as restrictive for update to authenticated
  using (tenant_id = app.effective_tenant_id() and app.role_crm_settings((select app.live_role())))
  with check (tenant_id = app.effective_tenant_id() and app.role_crm_settings((select app.live_role())));

revoke all on public.crm_settings from public, anon, authenticated, service_role;
grant select on public.crm_settings to authenticated;
grant update (scoring, sla_hours, assignment_rule, assignment_pool, assignment_fixed_to)
  on public.crm_settings to authenticated;
grant select, insert, update on public.crm_settings to service_role;

-- ---- 6. Who writes lead_stages --------------------------------------------------------------
-- Insert, update and delete for crm.settings holders, live. Column grants: no API caller
-- names a tenant (the default is the token's), a key after the stage exists, or the initial
-- flag (so there is never a second initial stage, and the first never moves). The initial
-- stage is never deleted.
drop policy if exists lead_stages_insert on public.lead_stages;
create policy lead_stages_insert on public.lead_stages for insert to authenticated
  with check (tenant_id = app.effective_tenant_id() and app.role_crm_settings(app.current_role()));
drop policy if exists lead_stages_update on public.lead_stages;
create policy lead_stages_update on public.lead_stages for update to authenticated
  using (tenant_id = app.effective_tenant_id() and app.role_crm_settings(app.current_role()))
  with check (tenant_id = app.effective_tenant_id() and app.role_crm_settings(app.current_role()));
drop policy if exists lead_stages_delete on public.lead_stages;
create policy lead_stages_delete on public.lead_stages for delete to authenticated
  using (tenant_id = app.effective_tenant_id() and app.role_crm_settings(app.current_role())
         and not is_initial);
drop policy if exists lead_stages_insert_live on public.lead_stages;
create policy lead_stages_insert_live on public.lead_stages as restrictive for insert to authenticated
  with check (tenant_id = app.effective_tenant_id() and app.role_crm_settings((select app.live_role())));
drop policy if exists lead_stages_update_live on public.lead_stages;
create policy lead_stages_update_live on public.lead_stages as restrictive for update to authenticated
  using (tenant_id = app.effective_tenant_id() and app.role_crm_settings((select app.live_role())))
  with check (tenant_id = app.effective_tenant_id() and app.role_crm_settings((select app.live_role())));
drop policy if exists lead_stages_delete_live on public.lead_stages;
create policy lead_stages_delete_live on public.lead_stages as restrictive for delete to authenticated
  using (tenant_id = app.effective_tenant_id() and app.role_crm_settings((select app.live_role())));

-- A stage that holds leads keeps what it counts as, whoever writes it (the door says so
-- with the count; a direct write through the column grant meets this): turning an open stage
-- into Won would make its leads count as won with no won_at, and the KPIs read both. A
-- definer, because RLS may hide leads from the writer. 23503 with a constraint name, like a
-- delete the foreign key refuses.
create or replace function app.tg_lead_stages_kind_fixed() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  if new.kind is distinct from old.kind
     and exists (select 1 from public.leads l
                  where l.tenant_id = old.tenant_id and l.stage_id = old.id) then
    raise exception using errcode = '23503',
      message = 'a stage that holds leads keeps its kind (constraint "lead_stages_kind_in_use")';
  end if;
  return new;
end $$;
revoke all on function app.tg_lead_stages_kind_fixed() from public, anon, authenticated, service_role;
drop trigger if exists lead_stages_kind_fixed on public.lead_stages;
create trigger lead_stages_kind_fixed
  before update of kind on public.lead_stages
  for each row execute function app.tg_lead_stages_kind_fixed();

revoke all on public.lead_stages from public, anon, authenticated, service_role;
grant select, delete on public.lead_stages to authenticated;
grant insert (key, label, label_ar, tone, kind, sort_order) on public.lead_stages to authenticated;
grant update (label, label_ar, tone, kind, sort_order) on public.lead_stages to authenticated;
grant select, insert, update, delete on public.lead_stages to service_role;

-- ---- 7. How many leads each stage holds --------------------------------------------------------
-- As the caller: RLS and the live check on leads decide. Spam leads count (they keep their
-- stage, so they too stop it being deleted).
create or replace function public.lead_stage_counts(p_tenant uuid)
  returns table (stage_id uuid, leads bigint)
  language sql stable security invoker set search_path = '' as $$
  select l.stage_id, count(*)
    from public.leads l
   where l.tenant_id = p_tenant and l.stage_id is not null
   group by l.stage_id
$$;
revoke all on function public.lead_stage_counts(uuid) from public, anon, authenticated, service_role;
grant execute on function public.lead_stage_counts(uuid) to authenticated;

-- ---- 8. Saving a pipeline ---------------------------------------------------------------------
-- p_known: [{id, version}] of every stage as the caller loaded them. p_stages: the new
-- pipeline in board order, each {id?, label, tone, kind, label_ar?}; one with no id is new.
-- A loaded stage left out is deleted. The initial stage stays, first. Errors:
--   42501  not the caller's tenant, or the caller does not live-hold crm.settings
--   40001  the pipeline changed since it was loaded (someone else saved)
--   22023  a malformed stage, an id twice or one not in the pipeline, the initial stage moved
--   23514  fewer than 2 or more than 10 stages, no won or no lost stage (and the CHECKs)
--   23503  a stage that holds leads would be deleted or change kind; DETAIL is
--          {"stageId","label","leads","change"} so the screen can say "Move its N leads first"
-- Returns the pipeline as saved, in board order.
create or replace function public.save_lead_stages(p_tenant uuid, p_known jsonb, p_stages jsonb)
  returns jsonb
  language plpgsql security invoker set search_path = '' as $$
declare
  v_current jsonb;
  v_known jsonb;
  v_initial uuid;
  v_ids uuid[] := '{}';
  v_id uuid;
  v_n int;
  v_won int := 0;
  v_lost int := 0;
  v_base text;
  r record;
  v_busy record;
begin
  if p_tenant is null or p_tenant is distinct from app.effective_tenant_id() then
    raise exception using errcode = '42501', message = 'save_lead_stages: not the caller''s tenant';
  end if;
  -- Said here, not left to RLS: a refused UPDATE or DELETE touches no row and raises nothing.
  if not app.role_crm_settings(app.current_role())
     or not app.role_crm_settings((select app.live_role())) then
    raise exception using errcode = '42501', message = 'save_lead_stages: crm.settings is required';
  end if;
  if jsonb_typeof(p_stages) is distinct from 'array' or jsonb_typeof(p_known) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'save_lead_stages: stages and known are arrays';
  end if;
  v_n := jsonb_array_length(p_stages);
  if v_n < 2 or v_n > 10 then
    raise exception using errcode = '23514',
      message = format('a pipeline has 2 to 10 stages; this one would have %s', v_n);
  end if;

  -- One save at a time per tenant, then the set as loaded must still be the set.
  perform pg_advisory_xact_lock(hashtextextended('crm:lead_stages:' || p_tenant::text, 0));
  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'version', s.version) order by s.id), '[]'::jsonb)
    into v_current
    from public.lead_stages s where s.tenant_id = p_tenant;
  select coalesce(jsonb_agg(jsonb_build_object('id', (e ->> 'id')::uuid, 'version', (e ->> 'version')::int)
                            order by (e ->> 'id')::uuid), '[]'::jsonb)
    into v_known
    from jsonb_array_elements(p_known) e;
  if v_current is distinct from v_known then
    raise exception using errcode = '40001', message = 'save_lead_stages: the pipeline changed since it was loaded';
  end if;
  select s.id into v_initial from public.lead_stages s where s.tenant_id = p_tenant and s.is_initial;

  -- The shape of each stage, and the set's rules, before anything is written.
  for r in select e, o::int as o from jsonb_array_elements(p_stages) with ordinality t(e, o) loop
    if jsonb_typeof(r.e) is distinct from 'object'
       or exists (select 1 from jsonb_object_keys(r.e) k
                   where k not in ('id', 'label', 'label_ar', 'tone', 'kind'))
       or jsonb_typeof(r.e -> 'label') is distinct from 'string'
       or jsonb_typeof(r.e -> 'tone') is distinct from 'string'
       or jsonb_typeof(r.e -> 'kind') is distinct from 'string' then
      raise exception using errcode = '22023', message = format('save_lead_stages: stage %s is malformed', r.o);
    end if;
    if r.e ? 'id' then
      v_id := (r.e ->> 'id')::uuid;
      if v_id = any (v_ids)
         or not exists (select 1 from public.lead_stages s where s.tenant_id = p_tenant and s.id = v_id) then
        raise exception using errcode = '22023', message = format('save_lead_stages: stage %s is not in the pipeline', r.o);
      end if;
      v_ids := v_ids || v_id;
    end if;
    if r.o = 1 and (r.e ->> 'id') is distinct from v_initial::text then
      raise exception using errcode = '22023', message = 'save_lead_stages: the initial stage stays, first';
    end if;
    if r.e ->> 'kind' = 'won' then v_won := v_won + 1; end if;
    if r.e ->> 'kind' = 'lost' then v_lost := v_lost + 1; end if;
  end loop;
  if v_won < 1 or v_lost < 1 then
    raise exception using errcode = '23514', message = 'a pipeline has at least one won and one lost stage';
  end if;

  -- A stage that holds leads keeps its kind and cannot go (its leads would change what they
  -- count as, or lose their stage): the first such stage, and how many leads it holds.
  select s.id, s.label, count(l.id) as n,
         case when s.id = any (v_ids) then 'kind' else 'delete' end as change
    into v_busy
    from public.lead_stages s
    join public.leads l on l.tenant_id = s.tenant_id and l.stage_id = s.id
   where s.tenant_id = p_tenant
     and (not (s.id = any (v_ids))
          or s.kind is distinct from (select e ->> 'kind' from jsonb_array_elements(p_stages) e
                                       where e ->> 'id' = s.id::text))
   group by s.id, s.label, s.sort_order
   order by s.sort_order
   limit 1;
  if found then
    raise exception using errcode = '23503',
      message = 'save_lead_stages: a stage that holds leads cannot be removed or change kind',
      detail = jsonb_build_object('stageId', v_busy.id, 'label', v_busy.label,
                                  'leads', v_busy.n, 'change', v_busy.change)::text;
  end if;

  delete from public.lead_stages s where s.tenant_id = p_tenant and not (s.id = any (v_ids));

  for r in select e, o::int as o from jsonb_array_elements(p_stages) with ordinality t(e, o) loop
    if r.e ? 'id' then
      update public.lead_stages s
         set label = r.e ->> 'label',
             label_ar = case when r.e ? 'label_ar' then nullif(r.e ->> 'label_ar', '') else s.label_ar end,
             tone = r.e ->> 'tone',
             kind = r.e ->> 'kind',
             sort_order = r.o * 10
       where s.tenant_id = p_tenant and s.id = (r.e ->> 'id')::uuid
         and (s.label, s.label_ar, s.tone, s.kind, s.sort_order) is distinct from
             (r.e ->> 'label',
              case when r.e ? 'label_ar' then nullif(r.e ->> 'label_ar', '') else s.label_ar end,
              r.e ->> 'tone', r.e ->> 'kind', r.o * 10);
    else
      -- A key from the label (lower-case words joined by _), else "stage", and a random
      -- suffix: never one a deleted stage used, which old timeline events still name.
      v_base := btrim(regexp_replace(lower(r.e ->> 'label'), '[^a-z0-9]+', '_', 'g'), '_');
      if v_base = '' then
        v_base := 'stage';
      elsif v_base !~ '^[a-z]' then
        v_base := 'stage_' || v_base;
      end if;
      v_base := rtrim(left(v_base, 24), '_');
      insert into public.lead_stages (key, label, label_ar, tone, kind, sort_order)
      values (v_base || '_' || substr(md5(random()::text || clock_timestamp()::text), 1, 6),
              r.e ->> 'label', nullif(r.e ->> 'label_ar', ''), r.e ->> 'tone', r.e ->> 'kind', r.o * 10);
    end if;
  end loop;

  return (select coalesce(jsonb_agg(jsonb_build_object(
                   'id', s.id, 'key', s.key, 'label', s.label, 'label_ar', s.label_ar,
                   'tone', s.tone, 'kind', s.kind, 'is_initial', s.is_initial,
                   'sort_order', s.sort_order, 'version', s.version)
                 order by s.sort_order, s.key), '[]'::jsonb)
            from public.lead_stages s where s.tenant_id = p_tenant);
end $$;
revoke all on function public.save_lead_stages(uuid, jsonb, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.save_lead_stages(uuid, jsonb, jsonb) to authenticated;

-- ---- 9. Who a new lead goes to ------------------------------------------------------------------
-- Manual: nobody. Fixed: the person, while they are an active lead worker of the tenant.
-- Round robin: the pool's active lead workers in pool order, the next after the cursor, which
-- moves under the settings row's lock (two leads at once go to two people). A definer, so it
-- does not rest on the service role's grants on profiles; the service role alone runs it.
-- The predicate is app.tg_lead_pipeline's assignee rule (0041), so the insert never refuses
-- the person picked.
create or replace function app.crm_pick_assignee(p_tenant uuid) returns uuid
  language plpgsql security definer set search_path = '' as $$
declare
  v_rule text;
  v_pool uuid[];
  v_fixed uuid;
  v_cursor int;
  v_live uuid[];
begin
  select c.assignment_rule, c.assignment_pool, c.assignment_fixed_to
    into v_rule, v_pool, v_fixed
    from public.crm_settings c where c.tenant_id = p_tenant;
  if v_rule = 'fixed' then
    return (select p.id from public.profiles p
             where p.id = v_fixed and p.tenant_id = p_tenant and p.is_active
               and app.role_works_leads(p.role::text));
  elsif v_rule = 'round_robin' then
    select c.rr_cursor, c.assignment_pool into v_cursor, v_pool
      from public.crm_settings c where c.tenant_id = p_tenant
       for update;
    select array_agg(u.m order by u.o) into v_live
      from unnest(v_pool) with ordinality u(m, o)
      join public.profiles p on p.id = u.m
     where p.tenant_id = p_tenant and p.is_active and app.role_works_leads(p.role::text);
    if v_live is null then
      return null;
    end if;
    update public.crm_settings c set rr_cursor = (v_cursor + 1) % 1000000000
     where c.tenant_id = p_tenant;
    return v_live[(v_cursor % cardinality(v_live)) + 1];
  end if;
  return null;
end $$;
revoke all on function app.crm_pick_assignee(uuid) from public, anon, authenticated, service_role;
grant execute on function app.crm_pick_assignee(uuid) to service_role;

-- ---- 10. Arrival, restated: the assignment ------------------------------------------------------
-- 0041's function, with one change: a new lead is assigned by the tenant's rule (step 9),
-- after the retry check, so a retried lead never moves the cursor. The allow-list is
-- unchanged; tests/lib/createLead.spec.ts reads it from the last definition.
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
  return v_id;
end $$;
revoke all on function public.crm_ingest_lead(uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.crm_ingest_lead(uuid, jsonb) to service_role;

-- ---- 11. The help guide -------------------------------------------------------------------------
-- TODO(C9a, H11): once the help-guide catalog (H11) is on main, put this slice's guide here,
-- at the start of a line and outside any DO block, as H11's as-built says:
--   select app.put_help_guide($guide$ <docs/admin-v2/guides/crm-settings.json> $guide$::jsonb, 0);
-- The guide's text is docs/admin-v2/guides/crm-settings.json (sort_order 75, a new guide, so
-- revision 0). Until then no migration seeds it, and tests/lib/helpCentre.spec.ts reads it
-- from that file.

-- ---- 12. Postconditions (Admin v2 P-14: both grant regimes) ------------------------------------
do $$
declare
  -- MAINTAIN exists from PostgreSQL 17 (production runs 17.6, CI 15); the privilege
  -- functions refuse the word on an older server.
  v_privs constant text[] := array['select', 'insert', 'update', 'delete', 'truncate',
                                   'references', 'trigger']
    || case when current_setting('server_version_num')::int >= 170000
            then array['maintain'] else array[]::text[] end;
  v_col_privs constant text[] := array['select', 'insert', 'update', 'references'];
  v_who text;
  v_tbl text;
  v_col text;
  p text;
  v_fn text;
  v_have text[];
begin
  -- RLS stays on and forced on both tables.
  if (select count(*) from pg_class
       where oid in ('public.crm_settings'::regclass, 'public.lead_stages'::regclass)
         and relrowsecurity and relforcerowsecurity) <> 2 then
    raise exception '0091: crm_settings and lead_stages must be ENABLE + FORCE row level security';
  end if;

  -- PUBLIC and anon hold nothing on either table, table-wide or on a column.
  foreach v_who in array array['public', 'anon'] loop
    foreach v_tbl in array array['public.crm_settings', 'public.lead_stages'] loop
      foreach p in array v_privs loop
        if has_table_privilege(v_who, v_tbl, p) then
          raise exception '0091: % holds % on %', v_who, p, v_tbl;
        end if;
      end loop;
      foreach p in array v_col_privs loop
        if has_any_column_privilege(v_who, v_tbl, p) then
          raise exception '0091: % holds % on a column of %', v_who, p, v_tbl;
        end if;
      end loop;
    end loop;
  end loop;

  -- authenticated: crm_settings is SELECT plus UPDATE of the five configuration columns.
  foreach p in array v_privs loop
    if (p = 'select') <> has_table_privilege('authenticated', 'public.crm_settings', p) then
      raise exception '0091: authenticated table-wide % on crm_settings is wrong', p;
    end if;
  end loop;
  select coalesce(array_agg(a.attname::text order by a.attname), '{}') into v_have
    from pg_attribute a
   where a.attrelid = 'public.crm_settings'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', 'public.crm_settings', a.attname::text, 'update');
  if v_have <> array['assignment_fixed_to', 'assignment_pool', 'assignment_rule', 'scoring', 'sla_hours'] then
    raise exception '0091: authenticated may update crm_settings columns %', v_have;
  end if;
  if has_any_column_privilege('authenticated', 'public.crm_settings', 'insert')
     or has_any_column_privilege('authenticated', 'public.crm_settings', 'references') then
    raise exception '0091: authenticated inserts or references crm_settings columns';
  end if;

  -- authenticated: lead_stages is SELECT and DELETE table-wide, INSERT and UPDATE by column.
  foreach p in array v_privs loop
    if (p in ('select', 'delete')) <> has_table_privilege('authenticated', 'public.lead_stages', p) then
      raise exception '0091: authenticated table-wide % on lead_stages is wrong', p;
    end if;
  end loop;
  select coalesce(array_agg(a.attname::text order by a.attname), '{}') into v_have
    from pg_attribute a
   where a.attrelid = 'public.lead_stages'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', 'public.lead_stages', a.attname::text, 'insert');
  if v_have <> array['key', 'kind', 'label', 'label_ar', 'sort_order', 'tone'] then
    raise exception '0091: authenticated may insert lead_stages columns %', v_have;
  end if;
  select coalesce(array_agg(a.attname::text order by a.attname), '{}') into v_have
    from pg_attribute a
   where a.attrelid = 'public.lead_stages'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', 'public.lead_stages', a.attname::text, 'update');
  if v_have <> array['kind', 'label', 'label_ar', 'sort_order', 'tone'] then
    raise exception '0091: authenticated may update lead_stages columns %', v_have;
  end if;
  if has_any_column_privilege('authenticated', 'public.lead_stages', 'references') then
    raise exception '0091: authenticated references lead_stages columns';
  end if;

  -- service_role: stated, and no more than its doors need.
  foreach p in array v_privs loop
    if (p in ('select', 'insert', 'update')) <> has_table_privilege('service_role', 'public.crm_settings', p) then
      raise exception '0091: service_role table-wide % on crm_settings is wrong', p;
    end if;
    if (p in ('select', 'insert', 'update', 'delete')) <> has_table_privilege('service_role', 'public.lead_stages', p) then
      raise exception '0091: service_role table-wide % on lead_stages is wrong', p;
    end if;
  end loop;
  if not has_column_privilege('service_role', 'public.leads', 'assigned_to', 'insert') then
    raise exception '0091: the service role cannot set a new lead''s assignee';
  end if;

  -- The exact policy sets, the tenant predicate first in every one, RESTRICTIVE included.
  if (select array_agg(policyname::text || ':' || permissive || ':' || cmd order by policyname)
        from pg_policies where schemaname = 'public' and tablename = 'crm_settings')
     <> array['crm_settings_read:PERMISSIVE:SELECT', 'crm_settings_write:PERMISSIVE:UPDATE',
              'crm_settings_write_live:RESTRICTIVE:UPDATE'] then
    raise exception '0091: crm_settings has an unexpected policy set';
  end if;
  if (select array_agg(policyname::text || ':' || permissive || ':' || cmd order by policyname)
        from pg_policies where schemaname = 'public' and tablename = 'lead_stages')
     <> array['lead_stages_delete:PERMISSIVE:DELETE', 'lead_stages_delete_live:RESTRICTIVE:DELETE',
              'lead_stages_insert:PERMISSIVE:INSERT', 'lead_stages_insert_live:RESTRICTIVE:INSERT',
              'lead_stages_read:PERMISSIVE:SELECT', 'lead_stages_update:PERMISSIVE:UPDATE',
              'lead_stages_update_live:RESTRICTIVE:UPDATE'] then
    raise exception '0091: lead_stages has an unexpected policy set';
  end if;
  if exists (select 1 from pg_policies
              where schemaname = 'public' and tablename in ('crm_settings', 'lead_stages')
                and (coalesce(qual, with_check) not like '((tenant_id = app.effective_tenant_id())%'
                     or (with_check is not null
                         and with_check not like '((tenant_id = app.effective_tenant_id())%'))) then
    raise exception '0091: a crm_settings or lead_stages policy does not start with the tenant predicate';
  end if;
  if (select count(*) from pg_policies
       where schemaname = 'public' and tablename in ('crm_settings', 'lead_stages')
         and permissive = 'RESTRICTIVE'
         and coalesce(qual, with_check) like '%live_role%') <> 4 then
    raise exception '0091: the four write paths must each carry the live check';
  end if;

  -- The functions: who runs each one.
  if has_function_privilege('anon', 'app.role_crm_settings(text)', 'execute')
     or not has_function_privilege('authenticated', 'app.role_crm_settings(text)', 'execute')
     or not has_function_privilege('service_role', 'app.role_crm_settings(text)', 'execute') then
    raise exception '0091: app.role_crm_settings is executable by the wrong roles';
  end if;
  foreach v_fn in array array['public.save_lead_stages(uuid, jsonb, jsonb)',
                              'public.lead_stage_counts(uuid)'] loop
    if has_function_privilege('anon', v_fn, 'execute')
       or has_function_privilege('service_role', v_fn, 'execute')
       or not has_function_privilege('authenticated', v_fn, 'execute')
       or (select prosecdef from pg_proc where oid = v_fn::regprocedure) then
      raise exception '0091: % must be the caller''s door (authenticated only, SECURITY INVOKER)', v_fn;
    end if;
  end loop;
  foreach v_fn in array array['app.crm_pick_assignee(uuid)', 'public.crm_ingest_lead(uuid, jsonb)'] loop
    if has_function_privilege('anon', v_fn, 'execute')
       or has_function_privilege('authenticated', v_fn, 'execute')
       or not has_function_privilege('service_role', v_fn, 'execute') then
      raise exception '0091: % must be the service role''s alone', v_fn;
    end if;
  end loop;
  foreach v_fn in array array['app.tg_crm_settings_assignees()', 'app.tg_crm_settings_rescore()',
                              'app.tg_lead_stages_kind_fixed()'] loop
    if has_function_privilege('anon', v_fn, 'execute')
       or has_function_privilege('authenticated', v_fn, 'execute')
       or has_function_privilege('service_role', v_fn, 'execute') then
      raise exception '0091: % is executable by an API role', v_fn;
    end if;
  end loop;
  -- The definers write or read FORCE RLS tables with no policy for them: their owner must
  -- bypass RLS (as 0034's and 0041's).
  foreach v_fn in array array['app.tg_crm_settings_assignees()', 'app.tg_crm_settings_rescore()',
                              'app.tg_lead_stages_kind_fixed()', 'app.crm_pick_assignee(uuid)'] loop
    if not exists (select 1 from pg_proc f join pg_roles r on r.oid = f.proowner
                    where f.oid = v_fn::regprocedure and f.prosecdef
                      and (r.rolsuper or r.rolbypassrls)) then
      raise exception '0091: % is not a definer owned by a role that bypasses RLS', v_fn;
    end if;
  end loop;
  if not has_function_privilege('authenticated', 'app.crm_pool_ok(uuid[])', 'execute')
     or not has_function_privilege('service_role', 'app.crm_pool_ok(uuid[])', 'execute')
     or has_function_privilege('anon', 'app.crm_pool_ok(uuid[])', 'execute') then
    raise exception '0091: the pool CHECK helper is not executable by exactly its writers';
  end if;

  -- Every tenant's settings: manual assignment (owner item O-9), nobody in the pool.
  if exists (select 1 from public.tenants t
              where not exists (select 1 from public.crm_settings c
                                 where c.tenant_id = t.id and c.assignment_rule = 'manual'
                                   and cardinality(c.assignment_pool) = 0
                                   and c.assignment_fixed_to is null)) then
    raise exception '0091: a tenant has no crm_settings row with manual assignment';
  end if;
end $$;
