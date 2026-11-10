-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 0134 — CRM tasks (Admin v2 C8, crm.md CRM-8). Forward-only, EXPAND only. HELD with C5 and
-- C6: the PR merges only after C5 (the contacts schema) and C6 (the contacts API), which merge
-- after the owner's lawyer signs off the privacy-notice update (owner item O-11, register
-- L-2). The number is a placeholder: the merge train assigns it
-- (scripts/renumber-migration.mjs). Depends on 0033 (app.live_role), 0034 (lead_events, the
-- lead keys), 0041 (profiles (tenant_id, id), app.crm_eraser_ok), 0102 (app.studio_time_zone),
-- 0129 (every staff-writable table carries a RESTRICTIVE live policy) and C5's migration (the
-- contacts, app.crm_touch, app.run_retention and the erasure doors as C5 restated them).
--
-- WHAT IT ADDS
--   1. crm.tasks, a new capability, Admin only (Developer none: owner default O-7; Sales only
--      from C10b), and its one SQL helper app.role_crm_tasks (tests/authz/sqlHelpers.spec.ts
--      holds it equal to ROLE_CAPS). crm.tasks implies crm.contacts (matrix.spec), so whoever
--      reads a task may read the contact and the lead it names.
--   2. public.crm_tasks: a follow-up (call, e-mail, WhatsApp, meeting, to-do) with a title, a
--      due moment, an owner, a note, and optionally the contact and the lead it is about
--      (composite keys to the task's own tenant, CASCADE: a task goes with its contact or its
--      lead). RLS ENABLE + FORCE, the tenant predicate first in every policy, permissive
--      policies per command through the helper and a RESTRICTIVE live check for every
--      command (app.live_role(): a demoted, switched-off or locked token reads and writes
--      nothing). Grants stated for both Supabase regimes (P-14).
--   3. The row's rules (app.tg_crm_task_row, BEFORE): who and when, the version (moved by an
--      edit, never by ticking a task done), the done stamps (the server's time and the
--      session's person, never the client's), the owner (an active crm.tasks holder of the
--      tenant), and no new link to a merge tombstone (C12).
--   4. The timeline (app.tg_crm_task_events, AFTER, a definer): task_created and task_done on
--      the lead's timeline and the contact's, with the task's id and type only (never its
--      title or note). A task done on a contact is the contact's activity (crm.md §5.1); on a
--      lead it already is, through C5's lead-event trigger.
--   5. Time in the studio's zone (site_settings.timezone, U9), in SQL only: a local date and
--      time to an instant, the grouping (overdue, today, upcoming, done) and the snooze
--      (tomorrow, 10:00). The browser never does zone arithmetic.
--   6. Readers and writers, SECURITY INVOKER (RLS, the live check and the grants decide; the
--      Worker names the tenant and is refused unless it is the token's), executable by
--      authenticated only: crm_tasks_grouped, crm_task_create, crm_task_update,
--      crm_task_delete, crm_my_overdue_tasks (the sidebar badge, owner item O-9: MY overdue
--      tasks).
--   7. Retention (crm.md §8.1, docs/retention.md): app.purge_crm_tasks: a done task goes
--      leads_months after it was done; an open task about no one goes leads_months after its
--      last change or its due moment, whichever is later; a task about someone goes with its
--      contact or lead. app.run_retention restated to call it (its summary gains
--      tasks_purged); app.crm_contact_is_orphan restated: an auto-contact with a task is not
--      an orphan (a person is working with them). The person erasure doors restated to count
--      the tasks that go (C5 left "(Tasks join in C8.)"). Each restated function is C5's copy
--      plus the lines marked `-- C8` (tests/lib/crmTasksSql.spec.ts).
--
-- Production behaviour: none until C8's Worker deploys. Rule 5 (the deployed Worker between
-- the push and the deploy): no table it reads changes; app.run_retention's answer gains one
-- key (pg_cron ignores it); crm_erase_preview and crm_erase_person answer one more key, which
-- C6's routes read by name only.
-- ─────────────────────────────────────────────────────────────────────────────────────────

-- A busy table fails the push instead of queueing behind it (0041's reason): this adds
-- foreign keys to leads, crm_contacts and profiles (their referenced side is locked).
set local lock_timeout = '5s';

-- ═══ 1. The capability helper ═══════════════════════════════════════════════════════════
create or replace function app.role_crm_tasks(r text) returns boolean
  language sql immutable
as $$ select coalesce(r in ('admin'), false) $$;  -- crm.tasks
revoke all on function app.role_crm_tasks(text) from public, anon, authenticated, service_role;
grant execute on function app.role_crm_tasks(text) to authenticated, service_role;

-- ═══ 2. The table ═════════════════════════════════════════════════════════════════════════
create table public.crm_tasks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default app.effective_tenant_id() references public.tenants (id) on delete cascade,
  title text not null
    check (char_length(btrim(title)) between 1 and 200 and title !~ '[[:cntrl:]]'),
  type text not null default 'todo' check (type in ('call', 'email', 'whatsapp', 'meeting', 'todo')),
  -- Who and what it is about: both optional (a to-do may be about no one).
  contact_id uuid,
  lead_id uuid,
  owner_id uuid,
  due_at timestamptz not null
    check (due_at >= '2000-01-01T00:00:00Z' and due_at < '2101-01-01T00:00:00Z'),
  -- Stamped by app.tg_crm_task_row (the server's time, the session's person).
  done_at timestamptz,
  done_by uuid,
  -- Free text: a line break or a tab is fine, no other control character.
  note text check (note is null or (char_length(note) <= 2000
                                    and note !~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]')),
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  constraint crm_tasks_tenant_id_id unique (tenant_id, id),
  constraint crm_tasks_contact_fk foreign key (tenant_id, contact_id)
    references public.crm_contacts (tenant_id, id) on delete cascade,
  constraint crm_tasks_lead_fk foreign key (tenant_id, lead_id)
    references public.leads (tenant_id, id) on delete cascade,
  constraint crm_tasks_owner_fk foreign key (tenant_id, owner_id)
    references public.profiles (tenant_id, id) on delete set null (owner_id),
  constraint crm_tasks_done_pair check (done_at is not null or done_by is null)
);
-- "My tasks" and the badge (owner, open, by due), crm.md §5.4.
create index crm_tasks_owner_idx on public.crm_tasks (tenant_id, owner_id, done_at, due_at);
-- "Everyone": the open ones by due.
create index crm_tasks_open_idx on public.crm_tasks (tenant_id, due_at) where done_at is null;
-- A contact's and a lead's tasks (and the cascades).
create index crm_tasks_contact_idx on public.crm_tasks (tenant_id, contact_id) where contact_id is not null;
create index crm_tasks_lead_idx on public.crm_tasks (tenant_id, lead_id) where lead_id is not null;
-- Retention: the done ones by when.
create index crm_tasks_done_idx on public.crm_tasks (tenant_id, done_at) where done_at is not null;
alter table public.crm_tasks enable row level security;
alter table public.crm_tasks force row level security;

-- ═══ 3. The row's rules (BEFORE) ══════════════════════════════════════════════════════════
-- A definer: the owner rule reads a colleague's profile and the tombstone rule a contact,
-- which the session may not. Ticking a task done (or undone) is not an edit: it moves no
-- version, so two people ticking the same task never see a 409.
create or replace function app.tg_crm_task_row() returns trigger
  language plpgsql security definer set search_path = '' as $$
declare
  c_versioned constant text[] := array['title', 'type', 'contact_id', 'lead_id', 'owner_id',
    'due_at', 'note'];
  v_edited boolean := false;
  v_changed boolean := true;
  f text;
begin
  -- The done stamps are the server's: the first tick keeps its time and person, unticking
  -- clears both, and done_by follows done_at only.
  if tg_op = 'INSERT' then
    if new.done_at is not null then
      new.done_at := now();
      new.done_by := auth.uid();
    else
      new.done_by := null;
    end if;
  else
    if new.done_at is distinct from old.done_at then
      if new.done_at is null then
        new.done_by := null;
      elsif old.done_at is not null then
        new.done_at := old.done_at;
        new.done_by := old.done_by;
      else
        new.done_at := now();
        new.done_by := auth.uid();
      end if;
    else
      new.done_by := old.done_by;
    end if;
  end if;

  -- The owner: an active profile of this tenant holding crm.tasks, checked when it is set or
  -- changes (someone switched off later blocks nothing). The message names a constraint so
  -- the Worker can say which field is wrong.
  if new.owner_id is not null
     and (tg_op = 'INSERT' or new.owner_id is distinct from old.owner_id)
     and not exists (select 1 from public.profiles p
                      where p.id = new.owner_id and p.tenant_id = new.tenant_id and p.is_active
                        and app.role_crm_tasks(p.role::text)) then
    raise exception using errcode = '23514',
      message = 'the owner must be an active tasks user of this tenant (constraint "crm_tasks_owner_active")';
  end if;
  -- A merge tombstone (C12) is not a contact: no new task points at one.
  if new.contact_id is not null
     and (tg_op = 'INSERT' or new.contact_id is distinct from old.contact_id)
     and exists (select 1 from public.crm_contacts c
                  where c.tenant_id = new.tenant_id and c.id = new.contact_id
                    and c.merged_into is not null) then
    raise exception using errcode = '23514',
      message = 'a task cannot be about a merged contact (constraint "crm_tasks_contact_live")';
  end if;

  if tg_op = 'INSERT' then
    new.created_by := coalesce(auth.uid(), new.created_by);
    new.updated_by := new.created_by;
    new.created_at := now();
    new.updated_at := now();
    new.version := 1;
    return new;
  end if;

  foreach f in array c_versioned loop
    if to_jsonb(new) -> f is distinct from to_jsonb(old) -> f then
      v_edited := true;
    end if;
  end loop;
  v_changed := v_edited or new.done_at is distinct from old.done_at;
  new.created_by := old.created_by;
  new.created_at := old.created_at;
  if v_edited and new.version = old.version then
    new.version := old.version + 1;
  elsif not v_edited then
    new.version := old.version;
  end if;
  if v_changed then
    new.updated_at := now();
    new.updated_by := auth.uid();
  else
    new.updated_at := old.updated_at;
    new.updated_by := old.updated_by;
  end if;
  return new;
end $$;
revoke all on function app.tg_crm_task_row() from public, anon, authenticated, service_role;
create trigger crm_tasks_row before insert or update on public.crm_tasks
  for each row execute function app.tg_crm_task_row();

-- ═══ 4. The timeline (AFTER) ══════════════════════════════════════════════════════════════
-- The task's id and type only: its title and note are the person's words, which stay on the
-- task. A definer: the event tables have no staff INSERT.
create or replace function app.tg_crm_task_events() returns trigger
  language plpgsql security definer set search_path = '' as $$
declare
  v_kind text;
begin
  if tg_op = 'INSERT' then
    v_kind := 'task_created';
  elsif new.done_at is not null and old.done_at is null then
    v_kind := 'task_done';
  else
    return null;
  end if;
  if new.lead_id is not null then
    insert into public.lead_events (tenant_id, lead_id, actor_id, kind, detail)
    values (new.tenant_id, new.lead_id, auth.uid(), v_kind,
            jsonb_build_object('task_id', new.id, 'type', new.type));
  end if;
  if new.contact_id is not null then
    insert into public.crm_contact_events (tenant_id, contact_id, actor_id, kind, detail)
    values (new.tenant_id, new.contact_id, auth.uid(), v_kind,
            jsonb_build_object('task_id', new.id, 'type', new.type));
    -- A task done is the person's activity (crm.md §5.1). A task created is not: planning a
    -- call keeps no one's details longer.
    if v_kind = 'task_done' then
      perform app.crm_touch(new.tenant_id, new.contact_id, now());
    end if;
  end if;
  return null;
end $$;
revoke all on function app.tg_crm_task_events() from public, anon, authenticated, service_role;
create trigger crm_tasks_events after insert or update of done_at on public.crm_tasks
  for each row execute function app.tg_crm_task_events();

-- ═══ 5. Policies (crm.md §3.4) ════════════════════════════════════════════════════════════
create policy crm_tasks_read on public.crm_tasks for select to authenticated
  using (tenant_id = app.effective_tenant_id() and app.role_crm_tasks(app.current_role()));
create policy crm_tasks_insert on public.crm_tasks for insert to authenticated
  with check (tenant_id = app.effective_tenant_id() and app.role_crm_tasks(app.current_role()));
create policy crm_tasks_update on public.crm_tasks for update to authenticated
  using (tenant_id = app.effective_tenant_id() and app.role_crm_tasks(app.current_role()))
  with check (tenant_id = app.effective_tenant_id() and app.role_crm_tasks(app.current_role()));
create policy crm_tasks_delete on public.crm_tasks for delete to authenticated
  using (tenant_id = app.effective_tenant_id() and app.role_crm_tasks(app.current_role()));
create policy crm_tasks_live on public.crm_tasks as restrictive for all to authenticated
  using (tenant_id = app.effective_tenant_id() and app.role_crm_tasks((select app.live_role())))
  with check (tenant_id = app.effective_tenant_id() and app.role_crm_tasks((select app.live_role())));

-- ═══ 6. Grants, stated (P-14: both Supabase regimes) ══════════════════════════════════════
-- Staff read every column, insert and change only what a person chooses (never the stamps,
-- the version or the person who did it), and delete. done_at is writable so a tick can be a
-- plain write; the trigger replaces any value but null with the server's time.
revoke all on public.crm_tasks from public, anon, authenticated, service_role;
grant select, delete on public.crm_tasks to authenticated;
grant insert (tenant_id, title, type, contact_id, lead_id, owner_id, due_at, note)
  on public.crm_tasks to authenticated;
grant update (title, type, contact_id, lead_id, owner_id, due_at, note, done_at)
  on public.crm_tasks to authenticated;
grant select, insert, update, delete on public.crm_tasks to service_role;

-- ═══ 7. Time in the studio's zone ═════════════════════════════════════════════════════════
-- A local date and clock time in a zone, as an instant (a time a clock change skips moves
-- forward, as Postgres reads it). Pure: the zone is an argument.
create or replace function app.crm_local_at(p_date date, p_time time, p_tz text) returns timestamptz
  language sql stable as $$
  select (p_date + p_time) at time zone p_tz
$$;
-- Which list a task is in at `p_now`, in zone `p_tz`: done; overdue (open and due before
-- now); today (open, due later on the same local day); upcoming. Pure, so pgTAP pins the
-- day boundary with a fixed now (crm.md §13: 21:30Z is the next day in Riyadh).
create or replace function app.crm_task_bucket(p_due timestamptz, p_done timestamptz,
                                               p_now timestamptz, p_tz text) returns text
  language sql stable as $$
  select case
    when p_done is not null then 'done'
    when p_due < p_now then 'overdue'
    when (p_due at time zone p_tz)::date = (p_now at time zone p_tz)::date then 'today'
    else 'upcoming'
  end
$$;
-- "Snooze to tomorrow 10:00": tomorrow's local date at 10:00 in the zone.
create or replace function app.crm_task_snooze_at(p_now timestamptz, p_tz text) returns timestamptz
  language sql stable as $$
  select app.crm_local_at(((p_now at time zone p_tz)::date + 1), time '10:00', p_tz)
$$;
revoke all on function app.crm_local_at(date, time, text) from public, anon, authenticated, service_role;
revoke all on function app.crm_task_bucket(timestamptz, timestamptz, timestamptz, text) from public, anon, authenticated, service_role;
revoke all on function app.crm_task_snooze_at(timestamptz, text) from public, anon, authenticated, service_role;
grant execute on function app.crm_local_at(date, time, text) to authenticated, service_role;
grant execute on function app.crm_task_bucket(timestamptz, timestamptz, timestamptz, text) to authenticated, service_role;
grant execute on function app.crm_task_snooze_at(timestamptz, text) to authenticated, service_role;

-- ═══ 8. Readers and writers (INVOKER) ═════════════════════════════════════════════════════
-- One task as the screens show it: its own columns, its due moment as the studio's local
-- date and clock time (so the drawer never converts), and the names of the contact and the
-- lead it is about, read as the caller (RLS decides; crm.tasks implies both). Never a
-- contact detail. Null when the caller sees no such task.
create or replace function app.crm_task_json(p_tenant uuid, p_task uuid, p_tz text) returns jsonb
  language sql stable security invoker set search_path = public, pg_temp as $$
  select jsonb_build_object(
           'id', t.id, 'title', t.title, 'type', t.type, 'note', t.note,
           'due_at', t.due_at,
           'due_date', to_char(t.due_at at time zone p_tz, 'YYYY-MM-DD'),
           'due_time', to_char(t.due_at at time zone p_tz, 'HH24:MI'),
           'done_at', t.done_at, 'owner_id', t.owner_id,
           'contact_id', t.contact_id, 'contact_name', c.display_name,
           'contact_company', c.company_name,
           'lead_id', t.lead_id, 'lead_number', l.lead_number, 'lead_name', l.name,
           'version', t.version, 'created_at', t.created_at)
    from public.crm_tasks t
    left join public.crm_contacts c
      on c.tenant_id = t.tenant_id and c.id = t.contact_id and c.merged_into is null
    left join public.leads_safe l on l.tenant_id = t.tenant_id and l.id = t.lead_id
   where t.tenant_id = app.effective_tenant_id() and t.tenant_id = p_tenant and t.id = p_task
$$;
revoke all on function app.crm_task_json(uuid, uuid, text) from public, anon, authenticated, service_role;
grant execute on function app.crm_task_json(uuid, uuid, text) to authenticated;

-- The tenant a writer names must be the token's: anything else is refused before a read.
create or replace function app.crm_task_tenant_ok(p_tenant uuid) returns void
  language plpgsql stable as $$
begin
  if p_tenant is null or p_tenant is distinct from app.effective_tenant_id() then
    raise exception using errcode = '42501', message = 'crm tasks: not this tenant';
  end if;
end $$;
revoke all on function app.crm_task_tenant_ok(uuid) from public, anon, authenticated, service_role;
grant execute on function app.crm_task_tenant_ok(uuid) to authenticated;

-- A contact or a lead a task may name: one the caller sees (RLS and the live check), not a
-- merge tombstone. 23503 naming crm_tasks_link_missing otherwise (the Worker's 422), so an
-- id the caller cannot see is never an oracle beyond "not there".
create or replace function app.crm_task_links_ok(p_tenant uuid, p_contact uuid, p_lead uuid)
  returns void language plpgsql stable set search_path = public, pg_temp as $$
begin
  if p_contact is not null and not exists (
       select 1 from public.crm_contacts c
        where c.tenant_id = p_tenant and c.id = p_contact and c.merged_into is null) then
    raise exception using errcode = '23503',
      message = 'that contact is not there (constraint "crm_tasks_link_missing")';
  end if;
  if p_lead is not null and not exists (
       select 1 from public.leads_safe l where l.tenant_id = p_tenant and l.id = p_lead) then
    raise exception using errcode = '23503',
      message = 'that lead is not there (constraint "crm_tasks_link_missing")';
  end if;
end $$;
revoke all on function app.crm_task_links_ok(uuid, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function app.crm_task_links_ok(uuid, uuid, uuid) to authenticated;

-- The Tasks screen and the cards: {tz, today, now, counts, mine_open, overdue, today_tasks,
-- upcoming, done}. p_filter (allow-listed; 22023 otherwise): view 'mine' (owned by the
-- caller) or 'all' (the default), contact (a contact's tasks), lead (a lead's). Each open list
-- is the first 100 by due moment, its count the whole; done is the last 20 ticked within 30
-- days. mine_open counts the caller's open tasks whatever the filter, so the screen can fall
-- back to Everyone when the caller has none.
create or replace function public.crm_tasks_grouped(p_tenant uuid, p_filter jsonb default '{}'::jsonb)
  returns jsonb
  language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare
  f jsonb := coalesce(p_filter, '{}'::jsonb);
  v_view text;
  v_contact uuid;
  v_lead uuid;
  v_now timestamptz := now();
  v_tz text;
  v_me uuid := auth.uid();
begin
  if jsonb_typeof(f) <> 'object'
     or exists (select 1 from jsonb_object_keys(f) k where k not in ('view', 'contact', 'lead')) then
    raise exception using errcode = '22023', message = 'task filter: unknown key';
  end if;
  begin
    v_view := coalesce(f ->> 'view', 'all');
    v_contact := (f ->> 'contact')::uuid;
    v_lead := (f ->> 'lead')::uuid;
  exception when others then
    raise exception using errcode = '22023', message = 'task filter: a value has the wrong type';
  end;
  if v_view not in ('mine', 'all') then
    raise exception using errcode = '22023', message = 'task filter: unknown view';
  end if;
  perform app.crm_task_tenant_ok(p_tenant);
  v_tz := app.studio_time_zone(p_tenant);
  return (
    with t as (
      select x.id, x.due_at, x.done_at, app.crm_task_bucket(x.due_at, x.done_at, v_now, v_tz) as bucket
        from public.crm_tasks x
       where x.tenant_id = app.effective_tenant_id() and x.tenant_id = p_tenant
         and (v_view = 'all' or x.owner_id = v_me)
         and (v_contact is null or x.contact_id = v_contact)
         and (v_lead is null or x.lead_id = v_lead)
         and (x.done_at is null or x.done_at > v_now - interval '30 days')
    ),
    ranked as (
      select t.*, row_number() over (
               partition by t.bucket
               order by case when t.bucket = 'done' then t.done_at end desc,
                        t.due_at, t.id) as pos
        from t
    )
    select jsonb_build_object(
      'tz', v_tz,
      'now', v_now,
      'today', to_char(v_now at time zone v_tz, 'YYYY-MM-DD'),
      'counts', jsonb_build_object(
        'overdue', (select count(*) from t where t.bucket = 'overdue'),
        'today', (select count(*) from t where t.bucket = 'today'),
        'upcoming', (select count(*) from t where t.bucket = 'upcoming'),
        'done', (select count(*) from t where t.bucket = 'done')),
      'mine_open', (select count(*) from public.crm_tasks x
                     where x.tenant_id = app.effective_tenant_id() and x.tenant_id = p_tenant
                       and x.owner_id = v_me and x.done_at is null),
      'overdue', coalesce((select jsonb_agg(app.crm_task_json(p_tenant, r.id, v_tz) order by r.pos)
                             from ranked r where r.bucket = 'overdue' and r.pos <= 100), '[]'::jsonb),
      'today_tasks', coalesce((select jsonb_agg(app.crm_task_json(p_tenant, r.id, v_tz) order by r.pos)
                                 from ranked r where r.bucket = 'today' and r.pos <= 100), '[]'::jsonb),
      'upcoming', coalesce((select jsonb_agg(app.crm_task_json(p_tenant, r.id, v_tz) order by r.pos)
                              from ranked r where r.bucket = 'upcoming' and r.pos <= 100), '[]'::jsonb),
      'done', coalesce((select jsonb_agg(app.crm_task_json(p_tenant, r.id, v_tz) order by r.pos)
                          from ranked r where r.bucket = 'done' and r.pos <= 20), '[]'::jsonb)));
end $$;
revoke all on function public.crm_tasks_grouped(uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.crm_tasks_grouped(uuid, jsonb) to authenticated;

-- The keys a task's body may carry, and their shapes (packages/schemas/crmTasks.ts is the
-- Worker's half). 22023 on anything else.
create or replace function app.crm_task_input(p jsonb, p_patch boolean)
  returns table (has_title boolean, title text, has_type boolean, type text,
                 has_due boolean, due_date date, due_time time,
                 has_contact boolean, contact_id uuid, has_lead boolean, lead_id uuid,
                 has_owner boolean, owner_id uuid, has_note boolean, note text,
                 has_done boolean, done boolean, snooze boolean)
  language plpgsql stable as $$
declare
  v_allowed text[] := array['title', 'type', 'due_date', 'due_time', 'contact_id', 'lead_id',
                            'owner_id', 'note'];
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception using errcode = '22023', message = 'task: an object is required';
  end if;
  if p_patch then
    v_allowed := v_allowed || array['done', 'snooze'];
  end if;
  if exists (select 1 from jsonb_object_keys(p) k where k <> all (v_allowed)) then
    raise exception using errcode = '22023', message = 'task: unknown key';
  end if;
  has_title := p ? 'title';
  has_type := p ? 'type';
  has_due := p ? 'due_date' or p ? 'due_time';
  has_contact := p ? 'contact_id';
  has_lead := p ? 'lead_id';
  has_owner := p ? 'owner_id';
  has_note := p ? 'note';
  has_done := p ? 'done';
  begin
    title := p ->> 'title';
    type := p ->> 'type';
    if has_due then
      if not (p ? 'due_date' and p ? 'due_time') or (p ->> 'due_time') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
         or (p ->> 'due_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
        raise exception using errcode = '22023', message = 'task: a due date and time go together';
      end if;
      due_date := (p ->> 'due_date')::date;
      due_time := (p ->> 'due_time')::time;
    end if;
    contact_id := (p ->> 'contact_id')::uuid;
    lead_id := (p ->> 'lead_id')::uuid;
    owner_id := (p ->> 'owner_id')::uuid;
    note := p ->> 'note';
    done := (p ->> 'done')::boolean;
  exception when others then
    raise exception using errcode = '22023', message = 'task: a value has the wrong type';
  end;
  snooze := p ? 'snooze';
  if snooze and ((p ->> 'snooze') is distinct from 'tomorrow_10' or has_due) then
    raise exception using errcode = '22023', message = 'task: snooze is tomorrow_10, without a due date';
  end if;
  if (has_title and title is null) or (has_type and type is null)
     or (has_done and done is null)
     or (due_date is not null and (due_date < date '2000-01-01' or due_date > date '2100-12-31')) then
    raise exception using errcode = '22023', message = 'task: a value is out of range';
  end if;
  if not p_patch and (not has_title or not has_due) then
    raise exception using errcode = '22023', message = 'task: a title and a due date and time are required';
  end if;
  return next;
end $$;
revoke all on function app.crm_task_input(jsonb, boolean) from public, anon, authenticated, service_role;
grant execute on function app.crm_task_input(jsonb, boolean) to authenticated;

-- A new task, as the caller (RLS, the live check, the grants). The due moment is the local
-- date and time in the studio's zone. The answer is the task as the screens show it.
create or replace function public.crm_task_create(p_tenant uuid, p_task jsonb)
  returns jsonb
  language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  i record;
  v_tz text;
  v_id uuid;
begin
  select * into i from app.crm_task_input(p_task, false);
  perform app.crm_task_tenant_ok(p_tenant);
  perform app.crm_task_links_ok(p_tenant, i.contact_id, i.lead_id);
  v_tz := app.studio_time_zone(p_tenant);
  insert into public.crm_tasks (tenant_id, title, type, contact_id, lead_id, owner_id, due_at, note)
  values (p_tenant, i.title, coalesce(i.type, 'todo'), i.contact_id, i.lead_id, i.owner_id,
          app.crm_local_at(i.due_date, i.due_time, v_tz), i.note)
  returning id into v_id;
  return app.crm_task_json(p_tenant, v_id, v_tz);
end $$;
revoke all on function public.crm_task_create(uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.crm_task_create(uuid, jsonb) to authenticated;

-- A change, as the caller. Every change but a tick (done) carries the version the screen read
-- (40001 when it moved; 22023 when it is missing); a tick is unversioned and moves none.
-- `snooze: 'tomorrow_10'` sets the due moment to tomorrow 10:00 in the studio's zone. P0002
-- when the caller sees no such task (another tenant's, a stale token's, none).
create or replace function public.crm_task_update(p_tenant uuid, p_task uuid, p_version int, p_patch jsonb)
  returns jsonb
  language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  i record;
  v_tz text;
  v_row public.crm_tasks%rowtype;
  v_versioned boolean;
begin
  select * into i from app.crm_task_input(p_patch, true);
  perform app.crm_task_tenant_ok(p_tenant);
  v_versioned := i.has_title or i.has_type or i.has_due or i.has_contact or i.has_lead
                 or i.has_owner or i.has_note or i.snooze;
  if not v_versioned and not i.has_done then
    raise exception using errcode = '22023', message = 'task: nothing to change';
  end if;
  if v_versioned and p_version is null then
    raise exception using errcode = '22023', message = 'task: send the version you read';
  end if;
  select * into v_row from public.crm_tasks t
   where t.tenant_id = app.effective_tenant_id() and t.tenant_id = p_tenant and t.id = p_task
   for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'task: no such task';
  end if;
  if v_versioned and v_row.version <> p_version then
    raise exception using errcode = '40001', message = 'task: someone else changed it';
  end if;
  perform app.crm_task_links_ok(p_tenant,
    case when i.has_contact and i.contact_id is distinct from v_row.contact_id then i.contact_id end,
    case when i.has_lead and i.lead_id is distinct from v_row.lead_id then i.lead_id end);
  v_tz := app.studio_time_zone(p_tenant);
  update public.crm_tasks t set
    title = case when i.has_title then i.title else t.title end,
    type = case when i.has_type then i.type else t.type end,
    due_at = case when i.has_due then app.crm_local_at(i.due_date, i.due_time, v_tz)
                  when i.snooze then app.crm_task_snooze_at(now(), v_tz)
                  else t.due_at end,
    contact_id = case when i.has_contact then i.contact_id else t.contact_id end,
    lead_id = case when i.has_lead then i.lead_id else t.lead_id end,
    owner_id = case when i.has_owner then i.owner_id else t.owner_id end,
    note = case when i.has_note then i.note else t.note end,
    done_at = case when not i.has_done then t.done_at
                   when i.done then coalesce(t.done_at, now())
                   else null end
   where t.tenant_id = p_tenant and t.id = p_task;
  if not found then
    raise exception using errcode = '42501', message = 'task: the change was refused';
  end if;
  return app.crm_task_json(p_tenant, p_task, v_tz);
end $$;
revoke all on function public.crm_task_update(uuid, uuid, int, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.crm_task_update(uuid, uuid, int, jsonb) to authenticated;

-- A task removed, as the caller, at the version the screen read. Answers what it was about
-- (ids only, for the audit row). P0002 unseen, 40001 moved, 42501 refused.
create or replace function public.crm_task_delete(p_tenant uuid, p_task uuid, p_version int)
  returns jsonb
  language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  v_row public.crm_tasks%rowtype;
begin
  perform app.crm_task_tenant_ok(p_tenant);
  if p_version is null then
    raise exception using errcode = '22023', message = 'task: send the version you read';
  end if;
  select * into v_row from public.crm_tasks t
   where t.tenant_id = app.effective_tenant_id() and t.tenant_id = p_tenant and t.id = p_task
   for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'task: no such task';
  end if;
  if v_row.version <> p_version then
    raise exception using errcode = '40001', message = 'task: someone else changed it';
  end if;
  delete from public.crm_tasks t where t.tenant_id = p_tenant and t.id = p_task;
  if not found then
    raise exception using errcode = '42501', message = 'task: the removal was refused';
  end if;
  return jsonb_build_object('contact_id', v_row.contact_id, 'lead_id', v_row.lead_id,
                            'done', v_row.done_at is not null);
end $$;
revoke all on function public.crm_task_delete(uuid, uuid, int) from public, anon, authenticated, service_role;
grant execute on function public.crm_task_delete(uuid, uuid, int) to authenticated;

-- The sidebar badge (owner item O-9): the caller's own open tasks due before now. A count,
-- read as the caller; 0 for anyone who reads no task.
create or replace function public.crm_my_overdue_tasks(p_tenant uuid) returns int
  language sql stable security invoker set search_path = public, pg_temp as $$
  select count(*)::int from public.crm_tasks t
   where t.tenant_id = app.effective_tenant_id() and t.tenant_id = p_tenant
     and t.owner_id = auth.uid() and t.done_at is null and t.due_at < now()
$$;
revoke all on function public.crm_my_overdue_tasks(uuid) from public, anon, authenticated, service_role;
grant execute on function public.crm_my_overdue_tasks(uuid) to authenticated;

-- ═══ 9. Retention ═════════════════════════════════════════════════════════════════════════
-- Every tenant, its own horizon (site_settings.retention.leads_months, 24 by default:
-- app.lead_retention_months). A task about someone goes with them (cascade); here, a done
-- task goes leads_months after it was done, and an open task about no one leads_months after
-- its last change or its due moment, whichever is later. A definer, run by pg_cron through
-- app.run_retention.
create or replace function app.purge_crm_tasks() returns int
  language plpgsql security definer set search_path = '' as $$
declare
  removed int := 0;
  n int;
  t record;
begin
  for t in select x.id from public.tenants x loop
    delete from public.crm_tasks k
     where k.tenant_id = t.id and k.done_at is not null
       and k.done_at < now() - make_interval(months => app.lead_retention_months(t.id));
    get diagnostics n = row_count;
    removed := removed + n;
    delete from public.crm_tasks k
     where k.tenant_id = t.id and k.done_at is null
       and k.contact_id is null and k.lead_id is null
       and greatest(k.updated_at, k.due_at)
           < now() - make_interval(months => app.lead_retention_months(t.id));
    get diagnostics n = row_count;
    removed := removed + n;
  end loop;
  return removed;
end $$;
revoke all on function app.purge_crm_tasks() from public, anon, authenticated, service_role;

-- ═══ 10. C5's functions, restated (each C5's copy plus the lines marked `-- C8`) ══════════
-- An auto-contact with a task (open or done) is not an orphan: a person is working with them
-- (crm.md §8.1 "no task"); a task goes with its contact otherwise, unseen.
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
       and not exists (select 1 from public.crm_contact_channels ch
                        where ch.tenant_id = c.tenant_id and ch.contact_id = c.id
                          and ch.source <> 'lead'))
$$;
revoke all on function app.crm_contact_is_orphan(uuid, uuid) from public, anon, authenticated, service_role;
-- crm_erase_lead (an INVOKER the service role runs) asks it.
grant execute on function app.crm_contact_is_orphan(uuid, uuid) to service_role;

-- The nightly run, with the tasks (crm.md §8.1) after the leads and before the contacts, so a
-- task purged tonight lets its auto-contact go tonight too. Its summary row gains a count.
create or replace function app.run_retention()
  returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  made int; dropped int; leads_removed int; logs_removed int; contacts_removed int;
  tasks_removed int;  -- C8
begin
  made := app.ensure_telemetry_partitions();
  dropped := app.purge_telemetry();
  leads_removed := app.purge_leads();
  tasks_removed := app.purge_crm_tasks();  -- C8
  contacts_removed := app.purge_crm();
  logs_removed := app.purge_system_logs();
  insert into public.system_logs (tenant_id, level, source, message, detail)
  select id, 'info', 'retention', 'retention run',
         jsonb_build_object('partitions_created', made, 'partitions_dropped', dropped,
                            'leads_purged', leads_removed, 'contacts_purged', contacts_removed,
                            'tasks_purged', tasks_removed,  -- C8
                            'system_logs_purged', logs_removed)
  from public.tenants order by created_at asc limit 1;
  return jsonb_build_object('partitions_created', made, 'partitions_dropped', dropped,
                            'leads_purged', leads_removed, 'contacts_purged', contacts_removed,
                            'tasks_purged', tasks_removed,  -- C8
                            'system_logs_purged', logs_removed);
end $$;
revoke all on function app.run_retention() from public, anon, authenticated, service_role;

-- C5's erasure preview, with the tasks counted.
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
    -- (C5 review) Leads not indexed yet (the fail-open insert, or the cron behind): their
    -- e-mail and phone cannot be compared, so this erasure cannot find them if they are the
    -- person's. C6's route runs the index backfill first and shows any count left.
    'unindexed', (select count(*)::int from public.leads l
                   where l.tenant_id = p_tenant and l.crm_indexed_at is null),
    'channels', (select count(*)::int from public.crm_contact_channels ch
                  where ch.tenant_id = p_tenant and ch.contact_id = p_contact),
    'notes', (select count(*)::int from public.crm_contact_notes n
               where n.tenant_id = p_tenant and n.contact_id = p_contact),
    -- The tasks about the person or their certain leads (a ticked phone match's go too).  -- C8
    'tasks', (select count(*)::int from public.crm_tasks tk  -- C8
               where tk.tenant_id = p_tenant  -- C8
                 and (tk.contact_id = p_contact  -- C8
                      or tk.lead_id in (select p.lead_id from app.crm_person_leads(p_tenant, p_contact) p  -- C8
                                         where p.certain))),  -- C8
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

-- C5's person erasure, with the tasks counted (they go by cascade with the leads and the
-- contact, in the same transaction).
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
  v_tasks int;  -- C8
  v_n int;
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
  select count(*)::int into v_tasks from public.crm_tasks tk  -- C8
   where tk.tenant_id = p_tenant and (tk.contact_id = p_contact or tk.lead_id = any (v_leads));  -- C8

  delete from public.leads l where l.tenant_id = p_tenant and l.id = any (v_leads);
  -- A lead left behind (an unticked phone match) keeps no timeline line naming the erased
  -- contact: the link it describes is gone, and no row should point at the person.
  delete from public.lead_events e
   where e.tenant_id = p_tenant and e.kind = 'contact_linked'
     and e.detail ->> 'contact_id' = p_contact::text;
  get diagnostics v_link_lines = row_count;
  -- (C5 review) Nor does another contact's timeline keep a line naming an erased lead (one
  -- of the person's leads linked to someone else by phone, say).
  delete from public.crm_contact_events e
   where e.tenant_id = p_tenant and e.kind = 'lead_linked' and e.contact_id <> p_contact
     and e.detail ->> 'lead_id' = any (v_leads::text[]);
  get diagnostics v_n = row_count;
  v_link_lines := v_link_lines + v_n;
  delete from public.crm_contacts c where c.tenant_id = p_tenant and c.id = p_contact;
  return jsonb_build_object(
    'contacts', 1, 'leads', cardinality(v_sure), 'phone_leads', cardinality(v_leads) - cardinality(v_sure),
    'lead_notes', v_lead_notes, 'lead_events', v_lead_events, 'link_lines', v_link_lines,
    'channels', v_channels, 'notes', v_notes, 'events', v_events,
    'tasks', v_tasks,  -- C8
    -- (C5 review) What this erasure could not check (crm_erase_preview says why).
    'unindexed', (select count(*)::int from public.leads l
                   where l.tenant_id = p_tenant and l.crm_indexed_at is null));
end $$;
revoke all on function public.crm_erase_person(uuid, uuid, uuid[], uuid) from public, anon, authenticated, service_role;
grant execute on function public.crm_erase_person(uuid, uuid, uuid[], uuid) to service_role;

-- ═══ 11. Postconditions (P-14: under both Supabase grant regimes) ═════════════════════════
do $$
declare
  v_maintain boolean := current_setting('server_version_num')::int >= 170000;
  v_got text[];
  v_fn text;
  r text;
begin
  -- ---- 1. RLS and policies ----------------------------------------------------------------
  if not exists (select 1 from pg_class
                  where oid = 'public.crm_tasks'::regclass and relrowsecurity and relforcerowsecurity) then
    raise exception 'C8: crm_tasks must have RLS enabled and forced';
  end if;
  select array_agg(policyname::text || ':' || cmd || ':' || permissive order by policyname collate "C")
    into v_got
    from pg_policies where schemaname = 'public' and tablename = 'crm_tasks';
  if v_got is distinct from array['crm_tasks_delete:DELETE:PERMISSIVE', 'crm_tasks_insert:INSERT:PERMISSIVE',
                                  'crm_tasks_live:ALL:RESTRICTIVE', 'crm_tasks_read:SELECT:PERMISSIVE',
                                  'crm_tasks_update:UPDATE:PERMISSIVE'] then
    raise exception 'C8: the crm_tasks policies are %', v_got;
  end if;
  if exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = 'crm_tasks'
                and (roles <> array['authenticated']::name[]
                     or coalesce(qual, with_check) !~ '^\(\(tenant_id = (app\.)?effective_tenant_id\(\)\) AND (app\.)?role_crm_tasks\('
                     or (with_check is not null
                         and with_check !~ '^\(\(tenant_id = (app\.)?effective_tenant_id\(\)\) AND (app\.)?role_crm_tasks\('))) then
    raise exception 'C8: a crm_tasks policy is not TO authenticated, or does not lead with the tenant predicate and the crm.tasks helper';
  end if;
  if not exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'crm_tasks' and policyname = 'crm_tasks_live'
                    and qual ~ 'live_role\(\)' and with_check ~ 'live_role\(\)') then
    raise exception 'C8: crm_tasks_live lacks the live check';
  end if;

  -- ---- 2. Grants ----------------------------------------------------------------------------
  foreach r in array array['public', 'anon'] loop
    if has_table_privilege(r::name, 'public.crm_tasks',
                           'select, insert, update, delete, truncate, references, trigger')
       or has_any_column_privilege(r::name, 'public.crm_tasks', 'select, insert, update, references')
       or (case when v_maintain then has_table_privilege(r::name, 'public.crm_tasks', 'maintain')
                else false end) then
      raise exception 'C8: % holds a privilege on crm_tasks', r;
    end if;
  end loop;
  foreach r in array array['authenticated', 'service_role'] loop
    if has_table_privilege(r::name, 'public.crm_tasks', 'truncate, references, trigger')
       or has_any_column_privilege(r::name, 'public.crm_tasks', 'references')
       or (case when v_maintain then has_table_privilege(r::name, 'public.crm_tasks', 'maintain')
                else false end) then
      raise exception 'C8: % holds TRUNCATE, REFERENCES, TRIGGER or MAINTAIN on crm_tasks', r;
    end if;
  end loop;
  if not has_table_privilege('authenticated', 'public.crm_tasks', 'select')
     or not has_table_privilege('authenticated', 'public.crm_tasks', 'delete')
     or has_table_privilege('authenticated', 'public.crm_tasks', 'insert')
     or has_table_privilege('authenticated', 'public.crm_tasks', 'update') then
    raise exception 'C8: authenticated must hold SELECT and DELETE on crm_tasks, and INSERT and UPDATE on named columns only';
  end if;
  select coalesce(array_agg(a.attname::text order by a.attname::text collate "C"), '{}') into v_got
    from pg_attribute a
   where a.attrelid = 'public.crm_tasks'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', a.attrelid, a.attnum, 'insert');
  if v_got is distinct from array['contact_id', 'due_at', 'lead_id', 'note', 'owner_id', 'tenant_id',
                                  'title', 'type'] then
    raise exception 'C8: authenticated inserts the crm_tasks columns %', v_got;
  end if;
  select coalesce(array_agg(a.attname::text order by a.attname::text collate "C"), '{}') into v_got
    from pg_attribute a
   where a.attrelid = 'public.crm_tasks'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', a.attrelid, a.attnum, 'update');
  if v_got is distinct from array['contact_id', 'done_at', 'due_at', 'lead_id', 'note', 'owner_id',
                                  'title', 'type'] then
    raise exception 'C8: authenticated updates the crm_tasks columns %', v_got;
  end if;
  if not has_table_privilege('service_role', 'public.crm_tasks', 'select, insert, update, delete') then
    raise exception 'C8: the service role must hold SELECT, INSERT, UPDATE and DELETE on crm_tasks';
  end if;

  -- ---- 3. Functions -------------------------------------------------------------------------
  -- The readers and writers: INVOKER, executable by authenticated alone.
  foreach v_fn in array array['public.crm_tasks_grouped(uuid, jsonb)',
                              'public.crm_task_create(uuid, jsonb)',
                              'public.crm_task_update(uuid, uuid, integer, jsonb)',
                              'public.crm_task_delete(uuid, uuid, integer)',
                              'public.crm_my_overdue_tasks(uuid)',
                              'app.crm_task_json(uuid, uuid, text)',
                              'app.crm_task_tenant_ok(uuid)',
                              'app.crm_task_links_ok(uuid, uuid, uuid)',
                              'app.crm_task_input(jsonb, boolean)'] loop
    if exists (select 1 from pg_proc where oid = v_fn::regprocedure and prosecdef) then
      raise exception 'C8: % must be SECURITY INVOKER', v_fn;
    end if;
    if has_function_privilege('anon', v_fn, 'execute')
       or has_function_privilege('service_role', v_fn, 'execute')
       or not has_function_privilege('authenticated', v_fn, 'execute')
       or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                   where p.oid = v_fn::regprocedure and a.grantee = 0) then
      raise exception 'C8: % must be executable by authenticated alone', v_fn;
    end if;
  end loop;
  -- The pure helpers: authenticated and the service role.
  foreach v_fn in array array['app.role_crm_tasks(text)', 'app.crm_local_at(date, time without time zone, text)',
                              'app.crm_task_bucket(timestamp with time zone, timestamp with time zone, timestamp with time zone, text)',
                              'app.crm_task_snooze_at(timestamp with time zone, text)'] loop
    if has_function_privilege('anon', v_fn, 'execute')
       or not has_function_privilege('authenticated', v_fn, 'execute')
       or not has_function_privilege('service_role', v_fn, 'execute')
       or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                   where p.oid = v_fn::regprocedure and a.grantee = 0) then
      raise exception 'C8: % must be executable by authenticated and the service role only', v_fn;
    end if;
  end loop;
  -- The definers: an empty search_path, owned by a role that bypasses RLS, executable by no
  -- API role (triggers and pg_cron run them).
  foreach v_fn in array array['app.tg_crm_task_row()', 'app.tg_crm_task_events()',
                              'app.purge_crm_tasks()', 'app.crm_contact_is_orphan(uuid, uuid)'] loop
    if not exists (select 1 from pg_proc f join pg_roles o on o.oid = f.proowner
                    where f.oid = v_fn::regprocedure and f.prosecdef
                      and f.proconfig[1] = 'search_path=""'
                      and (o.rolsuper or o.rolbypassrls)) then
      raise exception 'C8: % is not a definer with an empty search_path owned by a role that bypasses RLS', v_fn;
    end if;
    if has_function_privilege('anon', v_fn, 'execute')
       or has_function_privilege('authenticated', v_fn, 'execute')
       or (has_function_privilege('service_role', v_fn, 'execute')
           and v_fn <> 'app.crm_contact_is_orphan(uuid, uuid)') then
      raise exception 'C8: % is executable by an API role it should not be', v_fn;
    end if;
  end loop;
  -- The restated doors stay the service role's alone, INVOKER; the nightly run no API role's.
  foreach v_fn in array array['public.crm_erase_preview(uuid, uuid, uuid)',
                              'public.crm_erase_person(uuid, uuid, uuid[], uuid)'] loop
    if has_function_privilege('anon', v_fn, 'execute')
       or has_function_privilege('authenticated', v_fn, 'execute')
       or not has_function_privilege('service_role', v_fn, 'execute')
       or exists (select 1 from pg_proc where oid = v_fn::regprocedure and prosecdef) then
      raise exception 'C8: % must stay an INVOKER the service role alone executes', v_fn;
    end if;
  end loop;
  if has_function_privilege('anon', 'app.run_retention()', 'execute')
     or has_function_privilege('authenticated', 'app.run_retention()', 'execute')
     or has_function_privilege('service_role', 'app.run_retention()', 'execute') then
    raise exception 'C8: app.run_retention() is executable by an API role';
  end if;
  -- The helper answers crm.tasks: Admin alone.
  if not app.role_crm_tasks('admin')
     or app.role_crm_tasks('developer') or app.role_crm_tasks('sales')
     or app.role_crm_tasks('content_creator') or app.role_crm_tasks('seo')
     or app.role_crm_tasks(null) then
    raise exception 'C8: app.role_crm_tasks does not answer Admin alone';
  end if;

  -- ---- 4. Triggers ------------------------------------------------------------------------
  select array_agg(format('%s %s', t.tgname, f.proname) order by t.tgname collate "C") into v_got
    from pg_trigger t join pg_proc f on f.oid = t.tgfoid
   where t.tgrelid = 'public.crm_tasks'::regclass and not t.tgisinternal and t.tgenabled::text = 'O';
  if v_got is distinct from array['crm_tasks_events tg_crm_task_events', 'crm_tasks_row tg_crm_task_row'] then
    raise exception 'C8: the triggers on crm_tasks are %', v_got;
  end if;

  -- ---- 5. Nothing to purge or count yet ------------------------------------------------------
  if exists (select 1 from public.crm_tasks) then
    raise exception 'C8: crm_tasks is not empty';
  end if;
end $$;
