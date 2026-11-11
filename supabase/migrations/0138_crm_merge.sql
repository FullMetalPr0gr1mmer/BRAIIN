-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 0138 — merge duplicate contacts (Admin v2 C12, crm.md §5.5 and CRM-12). Forward-only,
-- EXPAND only. HELD with the contacts chain: it merges only after C5 (the contacts schema),
-- C6 (the contacts API), C7 (the screens), C8 (tasks) and their integration, which merge after
-- the owner's lawyer signs off the privacy-notice update (O-11, register L-2). The number is a
-- placeholder: the merge train assigns it (scripts/renumber-migration.mjs). Depends on C5's
-- migration (the contact tables, merged_into / merged_at, app.crm_name_key, app.role_crm_contacts,
-- app.purge_crm), C6's (app.crm_contacts_actor_ok, app.crm_channel_cap, app.crm_fill_primary)
-- and C8's (crm_tasks), 0033 (app.live_role) and 0041 (app.tags_ok).
--
-- WHAT IT ADDS
--   1. crm_merge_dismissals: "Not a duplicate", one row per pair (contact_a < contact_b), so a
--      pair is not offered again. RLS ENABLE + FORCE; crm.contacts reads and adds; a
--      RESTRICTIVE live check (H16); grants stated (P-14).
--   2. The finder, in two layers: app.crm_duplicate_candidates, a pinned definer (it compares
--      blind indexes, which no staff token reads; empty unless the caller's LIVE role holds
--      crm.contacts; the token's own tenant only), and public.crm_duplicate_pairs, SECURITY
--      INVOKER, which reads both people of each pair through RLS. Rules (crm.md §9): the same
--      phone blind index; the same name_key and the same folded company. Dismissed pairs and
--      tombstones are left out; at most 50 pairs. (The design's third rule, the same
--      non-freemail e-mail domain with a similar name, needs a domain index on the channels,
--      which C5 left to C11; it joins when they carry one.)
--   3. public.crm_dismiss_duplicate: INVOKER, as the caller.
--   4. public.crm_merge_contacts: the service role's door (INVOKER; it moves channels, notes,
--      leads' links and timeline lines, which no staff token may write, as C6's doors do),
--      checking the acting profile LIVE. One transaction: both rows locked in id order, the
--      versions (40001), the channel ceiling, the survivor's blanks filled, the leads, channels,
--      notes, tasks, timeline and dismissals moved, a `merged` line, the dropped record made a
--      scrubbed tombstone, and the crm.contact.merge audit row.
--   5. app.purge_crm restated (C5's copy plus the lines marked `-- C12`): tombstones go on the
--      next run (crm.md §8.1), after anything that raced onto one moves to its survivor.
--   6. public.crm_erase_person restated (C8's copy plus the lines marked `-- C12`): a record a
--      merge made a tombstone while the erasure waited is not erased (P0002).
--
-- Production behaviour: none until the Worker that calls these deploys; nothing reads or calls
-- what this file adds, and the nightly run purges no tombstone because none exists before the
-- first merge. Rule 5 holds trivially.
-- ─────────────────────────────────────────────────────────────────────────────────────────

-- A busy table fails the push instead of queueing behind it: the index below locks
-- crm_contacts against writes while it builds.
set local lock_timeout = '5s';

-- ═══ 1. The finder's index ════════════════════════════════════════════════════════════════
-- The same name, compared by equality (the trigram index C5 made serves the search, not this).
create index crm_contacts_name_key_idx on public.crm_contacts (tenant_id, name_key)
  where merged_into is null;

-- ═══ 2. Dismissals ═══════════════════════════════════════════════════════════════════════
create table public.crm_merge_dismissals (
  tenant_id uuid not null default app.effective_tenant_id() references public.tenants (id) on delete cascade,
  contact_a uuid not null,
  contact_b uuid not null,
  -- The person who said so. Never client-chosen (the trigger below).
  created_by uuid,
  created_at timestamptz not null default now(),
  constraint crm_merge_dismissals_pkey primary key (tenant_id, contact_a, contact_b),
  constraint crm_merge_dismissals_order check (contact_a < contact_b),
  constraint crm_merge_dismissals_a_fk foreign key (tenant_id, contact_a)
    references public.crm_contacts (tenant_id, id) on delete cascade,
  constraint crm_merge_dismissals_b_fk foreign key (tenant_id, contact_b)
    references public.crm_contacts (tenant_id, id) on delete cascade
);
-- The second key's side (the primary key leads with the first).
create index crm_merge_dismissals_b_idx on public.crm_merge_dismissals (tenant_id, contact_b);
alter table public.crm_merge_dismissals enable row level security;
alter table public.crm_merge_dismissals force row level security;

-- BEFORE INSERT, a definer (it reads a contact the row names). An API session's insert is held
-- to its own tenant and a live contacts role FIRST (C8-SEC-2's lesson: Postgres runs this
-- trigger ahead of RLS's WITH CHECK, so the tombstone rule below would otherwise tell any
-- signed-in token whether a uuid is a merged contact of any tenant); then who and when are the
-- server's, and a tombstone is never dismissed. The service role (the merge door, moving a
-- dismissal to the survivor) carries no user and keeps the row's own person.
create or replace function app.tg_crm_merge_dismissal() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null
     and (new.tenant_id is distinct from app.effective_tenant_id()
          or not coalesce(app.role_crm_contacts(app.live_role()), false)) then
    raise exception using errcode = '42501',
      message = 'new row violates row-level security policy for table "crm_merge_dismissals"';
  end if;
  new.created_by := coalesce(auth.uid(), new.created_by);
  if auth.uid() is not null then
    new.created_at := now();
  end if;
  if exists (select 1 from public.crm_contacts c
              where c.tenant_id = new.tenant_id and c.id in (new.contact_a, new.contact_b)
                and c.merged_into is not null) then
    raise exception using errcode = '23514',
      message = 'a merged contact cannot be dismissed (constraint "crm_merge_dismissals_live")';
  end if;
  return new;
end $$;
revoke all on function app.tg_crm_merge_dismissal() from public, anon, authenticated, service_role;
create trigger crm_merge_dismissals_row before insert on public.crm_merge_dismissals
  for each row execute function app.tg_crm_merge_dismissal();

create policy crm_merge_dismissals_read on public.crm_merge_dismissals for select to authenticated
  using (tenant_id = app.effective_tenant_id() and app.role_crm_contacts(app.current_role()));
create policy crm_merge_dismissals_insert on public.crm_merge_dismissals for insert to authenticated
  with check (tenant_id = app.effective_tenant_id() and app.role_crm_contacts(app.current_role()));
create policy crm_merge_dismissals_live on public.crm_merge_dismissals as restrictive for all to authenticated
  using (tenant_id = app.effective_tenant_id() and app.role_crm_contacts((select app.live_role())))
  with check (tenant_id = app.effective_tenant_id() and app.role_crm_contacts((select app.live_role())));

revoke all on public.crm_merge_dismissals from public, anon, authenticated, service_role;
grant select on public.crm_merge_dismissals to authenticated;
grant insert (tenant_id, contact_a, contact_b) on public.crm_merge_dismissals to authenticated;
grant select, insert, delete on public.crm_merge_dismissals to service_role;

-- ═══ 3. The finder ════════════════════════════════════════════════════════════════════════
-- The likely duplicates of the caller's own tenant, as pairs of contact ids (the older-made id
-- first is NOT implied: contact_a < contact_b by uuid) with the reasons each pair was found:
--   'phone'         both hold a phone with the same blind index (a shared office line is one
--                   too: a person decides);
--   'name_company'  the same name_key (folded, al-/el-/ال dropped) and the same company,
--                   folded the same way.
-- Dismissed pairs and tombstones are left out; phone matches first, then the most recently
-- active pairs; at most p_limit (1 to 50). A definer, because it compares blind indexes,
-- which no staff token reads (C5's column grant); it answers nothing unless the caller's LIVE
-- role holds crm.contacts, and reads only the token's own tenant.
--
-- (C12 review, C12-SEC-R2-4) The name rule skips a name-and-company group of more than five
-- live records. Anyone on the public form can make a contact named as they choose (a new
-- e-mail always makes one), so without a bound a batch of copies of one person's name and
-- company would cost every finder call a square of pairs. A real person is rarely on file six
-- times; a group that large is a flood or a common name, and the phone rule still finds its
-- members. A planted copy inside the bound is still offered: register L-5 question 1.
create or replace function app.crm_duplicate_candidates(p_limit int)
  returns table (contact_a uuid, contact_b uuid, reasons text[], ord int)
  language plpgsql stable security definer set search_path = '' as $$
declare
  v_tenant uuid := app.effective_tenant_id();
  c_group constant int := 5;
begin
  if v_tenant is null or not coalesce(app.role_crm_contacts(app.live_role()), false) then
    return;
  end if;
  return query
  with named as (
    select c.id, c.name_key, app.crm_name_key(c.company_name) as company_key
      from public.crm_contacts c
     where c.tenant_id = v_tenant and c.merged_into is null and c.name_key <> ''
  ), sized as (
    select g.id, g.name_key, g.company_key,
           count(*) over (partition by g.name_key, g.company_key) as size
      from named g
     where g.company_key <> ''
  ), found as (
    select x.contact_id as a, y.contact_id as b, 'phone'::text as reason
      from public.crm_contact_channels x
      join public.crm_contact_channels y
        on y.tenant_id = x.tenant_id and y.kind = 'phone' and y.value_hmac = x.value_hmac
       and y.contact_id > x.contact_id
     where x.tenant_id = v_tenant and x.kind = 'phone'
    union all
    select x.id, y.id, 'name_company'::text
      from sized x
      join sized y
        on y.name_key = x.name_key and y.company_key = x.company_key and y.id > x.id
     where x.size <= c_group
  ), pairs as (
    select f.a, f.b, array_agg(distinct f.reason order by f.reason) as reasons
      from found f
     group by f.a, f.b
  )
  select p.a, p.b, p.reasons,
         (row_number() over (order by ('phone' = any (p.reasons)) desc,
                                      greatest(ca.last_activity_at, cb.last_activity_at) desc,
                                      p.a, p.b))::int
    from pairs p
    join public.crm_contacts ca on ca.tenant_id = v_tenant and ca.id = p.a and ca.merged_into is null
    join public.crm_contacts cb on cb.tenant_id = v_tenant and cb.id = p.b and cb.merged_into is null
   where not exists (select 1 from public.crm_merge_dismissals d
                      where d.tenant_id = v_tenant and d.contact_a = p.a and d.contact_b = p.b)
   order by 4
   limit least(greatest(coalesce(p_limit, 50), 1), 50);
end $$;
revoke all on function app.crm_duplicate_candidates(int) from public, anon, authenticated, service_role;
grant execute on function app.crm_duplicate_candidates(int) to authenticated;

-- One person of a pair, as the caller reads them (RLS, the live check, the column grants): who
-- they are and what a merge would move, never a value. Null when the caller cannot see them.
create or replace function app.crm_merge_side(p_tenant uuid, p_contact uuid) returns jsonb
  language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
           'id', c.id, 'display_name', c.display_name, 'title', c.title,
           'company_name', c.company_name, 'stage', c.stage, 'created_at', c.created_at,
           'last_activity_at', c.last_activity_at, 'version', c.version,
           'leads', (select pg_catalog.count(l.id)::int from public.leads l
                      where l.tenant_id = c.tenant_id and l.contact_id = c.id),
           'emails', (select pg_catalog.count(ch.id)::int from public.crm_contact_channels ch
                       where ch.tenant_id = c.tenant_id and ch.contact_id = c.id and ch.kind = 'email'),
           'phones', (select pg_catalog.count(ch.id)::int from public.crm_contact_channels ch
                       where ch.tenant_id = c.tenant_id and ch.contact_id = c.id and ch.kind = 'phone'))
    from public.crm_contacts c
   where c.tenant_id = p_tenant and c.id = p_contact and c.merged_into is null
$$;
revoke all on function app.crm_merge_side(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function app.crm_merge_side(uuid, uuid) to authenticated;

-- The Merge duplicates screen's list: [{reasons, a, b}], a and b as app.crm_merge_side draws
-- them. INVOKER: RLS decides what the caller sees of each person; the Worker names the tenant
-- too and gets nothing unless it is the token's. 22023 for a limit outside 1 to 50.
create or replace function public.crm_duplicate_pairs(p_tenant uuid, p_limit int default 50)
  returns jsonb
  language plpgsql stable security invoker set search_path = public, pg_temp as $$
begin
  if p_tenant is null or p_limit is null or p_limit not between 1 and 50 then
    raise exception using errcode = '22023', message = 'crm_duplicate_pairs: a tenant and a limit of 1 to 50 are required';
  end if;
  if p_tenant is distinct from app.effective_tenant_id() then
    return '[]'::jsonb;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('reasons', to_jsonb(d.reasons), 'a', s.a, 'b', s.b)
                     order by d.ord)
      from app.crm_duplicate_candidates(p_limit) d
      cross join lateral (select app.crm_merge_side(p_tenant, d.contact_a) as a,
                                 app.crm_merge_side(p_tenant, d.contact_b) as b) s
     where s.a is not null and s.b is not null), '[]'::jsonb);
end $$;
revoke all on function public.crm_duplicate_pairs(uuid, int) from public, anon, authenticated, service_role;
grant execute on function public.crm_duplicate_pairs(uuid, int) to authenticated;

-- ═══ 4. "Not a duplicate" ════════════════════════════════════════════════════════════════
-- As the caller (RLS, the live check, the column grant): both must be live contacts the caller
-- sees (P0002 otherwise, so another tenant's ids and tombstones are unseen alike). Saying it
-- twice is not an error. True when this call wrote the row.
create or replace function public.crm_dismiss_duplicate(p_tenant uuid, p_a uuid, p_b uuid)
  returns boolean
  language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  v_n int;
begin
  if p_tenant is null or p_a is null or p_b is null or p_a = p_b then
    raise exception using errcode = '22023', message = 'crm_dismiss_duplicate: a tenant and two different contacts are required';
  end if;
  if p_tenant is distinct from app.effective_tenant_id()
     or (select count(*) from public.crm_contacts c
          where c.tenant_id = p_tenant and c.id in (p_a, p_b) and c.merged_into is null) <> 2 then
    raise exception using errcode = 'P0002', message = 'crm_dismiss_duplicate: no such contacts';
  end if;
  insert into public.crm_merge_dismissals (tenant_id, contact_a, contact_b)
  values (p_tenant, least(p_a, p_b), greatest(p_a, p_b))
  on conflict do nothing;
  get diagnostics v_n = row_count;
  return v_n > 0;
end $$;
revoke all on function public.crm_dismiss_duplicate(uuid, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.crm_dismiss_duplicate(uuid, uuid, uuid) to authenticated;

-- ═══ 5. The merge ═════════════════════════════════════════════════════════════════════════
-- Merge p_drop into p_keep, in one transaction (crm.md §9). The service role's door: no staff
-- token may move a channel, a note, a lead's link or a timeline line (C5's grants), so the
-- Worker calls it after assertCap, a live recheck, its limit and an RLS read of both people;
-- this checks the acting profile itself, live (app.crm_contacts_actor_ok). 22023 for a bad
-- call, 42501 for an actor who may not, P0002 for a contact the tenant does not hold (or a
-- tombstone), 40001 when either version moved on, 23514 naming crm_contact_channels_cap when
-- the other would take the survivor past ten e-mails or ten phones (nothing is half-merged).
--
-- The survivor keeps its own name, language and source; a blank title, company, city, country
-- or owner is filled from the other record (an owner only while they may own contacts); tags
-- are united (the survivor's first, at most 10); starred if either was; custom values filled
-- (the survivor's win); the stage by precedence, client > lead > past > partner. (C12 review,
-- C12-COR-4) A merge is a person's edit of the survivor, always: a person decided the two are
-- one and which record stays, so the orphan rule no longer takes it as a record nobody worked
-- on (retention and erasure still do). One rule, whatever the merge happened to fill (C5's row
-- trigger marks a direct write that changes a detail, which made the answer depend on it).
-- The merge is a person's work on the record, so it is activity too (C5 counted a merge so).
-- Then:
--   • channels: the other's move (a phone both hold stays once; a moved one is the survivor's
--     main of its kind if it had none), keeping where each came from, so erasing a lead still
--     takes back the copies only that lead carried (C5 review). (C12 review, C12-COR-1) When
--     the copy that stays came from a lead and the other's did not (a person typed it, or an
--     import brought it), the copy that stays takes the other's source and maker first: a
--     lead's erasure never takes a value a person added, and that value still keeps an
--     auto-contact from the orphan rule, as it did on the record it came from;
--   • notes: moved with their ids, words, authors and times (no API role may UPDATE a note, so
--     each is re-added and the original removed in this transaction);
--   • tasks and leads: re-pointed. A lead keeps how it was linked (a phone match is still one
--     to check). C5's trigger draws the lead's "Linked to a contact" line; it is put down to
--     the actor, and the lead's earlier link line names the survivor;
--   • the other's timeline (but its own `created` line, and the note lines its notes redraw):
--     moved; its dismissals: moved to the survivor (not this person is not that one either);
--     tombstones pointing at it: pointed at the survivor (no chains);
--   • a `merged` line on the survivor (counts only);
--   • the other record becomes a tombstone: merged_into, merged_at, a placeholder name, no
--     title, company, city, country, tags, custom values, owner or star; its own timeline and
--     dismissals go. app.purge_crm removes it on the next run;
--   • audit_log `crm.contact.merge` {keep, drop, counts}, in this transaction: no row, no merge.
-- Answers counts and the survivor's new version, never a value.
create or replace function public.crm_merge_contacts(p_tenant uuid, p_keep uuid, p_keep_version int,
                                                     p_drop uuid, p_drop_version int, p_actor uuid)
  returns jsonb
  language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  k public.crm_contacts%rowtype;
  d public.crm_contacts%rowtype;
  c_rank constant text[] := array['partner', 'past', 'lead', 'client'];
  v_hmac text;
  v_locked text[] := '{}';
  v_moved uuid[];
  v_drop_primary uuid[];
  v_notes jsonb;
  v_tags text[];
  v_custom jsonb;
  v_owner uuid;
  v_role text;
  v_leads int;
  v_channels int;
  v_duplicates int;
  v_note_count int;
  v_tasks int;
  v_events int;
  v_version int;
begin
  if p_tenant is null or p_keep is null or p_drop is null or p_keep_version is null
     or p_drop_version is null or p_actor is null then
    raise exception using errcode = '22023', message = 'crm_merge_contacts: a tenant, two contacts, their versions and an actor are required';
  end if;
  if p_keep = p_drop then
    raise exception using errcode = '22023', message = 'crm_merge_contacts: a contact cannot be merged into itself';
  end if;
  if not app.crm_contacts_actor_ok(p_tenant, p_actor, false) then
    raise exception using errcode = '42501', message = 'crm_merge_contacts: this person may not merge contacts';
  end if;

  -- 1. The e-mail locks the link takes (app.crm_link_lead_core, app.crm_email_holder), FIRST and
  --    in order, so an inquiry arriving now from one of these addresses waits and then finds
  --    the survivor, never the record going away; then both rows, in id order.
  for v_hmac in
    select distinct ch.value_hmac from public.crm_contact_channels ch
     where ch.tenant_id = p_tenant and ch.contact_id in (p_keep, p_drop) and ch.kind = 'email'
     order by 1
  loop
    perform pg_advisory_xact_lock(hashtextextended('crm-email:' || p_tenant::text || ':' || v_hmac, 0));
    v_locked := v_locked || v_hmac;
  end loop;
  perform 1 from public.crm_contacts c
   where c.tenant_id = p_tenant and c.id in (p_keep, p_drop)
   order by c.id
     for update;
  select * into k from public.crm_contacts c
   where c.tenant_id = p_tenant and c.id = p_keep and c.merged_into is null;
  if not found then
    raise exception using errcode = 'P0002', message = 'crm_merge_contacts: no such contact';
  end if;
  select * into d from public.crm_contacts c
   where c.tenant_id = p_tenant and c.id = p_drop and c.merged_into is null;
  if not found then
    raise exception using errcode = 'P0002', message = 'crm_merge_contacts: no such contact';
  end if;
  if k.version <> p_keep_version or d.version <> p_drop_version then
    raise exception using errcode = '40001', message = 'crm_merge_contacts: a contact changed since it was read';
  end if;
  -- An address added to either since the first step (rare): its lock too, now.
  for v_hmac in
    select distinct ch.value_hmac from public.crm_contact_channels ch
     where ch.tenant_id = p_tenant and ch.contact_id in (p_keep, p_drop) and ch.kind = 'email'
       and not ch.value_hmac = any (v_locked)
     order by 1
  loop
    perform pg_advisory_xact_lock(hashtextextended('crm-email:' || p_tenant::text || ':' || v_hmac, 0));
  end loop;

  -- 2. The ceiling (C6 review, C6-SEC-3): one reveal never shows more than ten of a kind.
  --    (C12 review, C12-COR-5) Counted as C6 counts a change: only a kind the other record
  --    adds a new value to, against what the survivor holds. A lead's arrival adds a phone
  --    without the ceiling, so a survivor can hold more than ten already; a merge that adds
  --    it nothing of that kind is not refused for it.
  if exists (select 1
               from (select ch.kind,
                            count(*) filter (where ch.contact_id = p_keep) as kept,
                            count(*) filter (
                              where ch.contact_id = p_drop
                                and not exists (select 1 from public.crm_contact_channels y
                                                 where y.tenant_id = p_tenant and y.contact_id = p_keep
                                                   and y.kind = ch.kind and y.value_hmac = ch.value_hmac)) as added
                       from public.crm_contact_channels ch
                      where ch.tenant_id = p_tenant and ch.contact_id in (p_keep, p_drop)
                      group by ch.kind) t
              where t.added > 0 and t.kept + t.added > app.crm_channel_cap()) then
    raise exception using errcode = '23514',
      message = 'a contact keeps at most ten e-mails and ten phones (constraint "crm_contact_channels_cap")';
  end if;

  -- 3. The survivor's details.
  select coalesce(array_agg(y.t order by y.o), '{}') into v_tags
    from (select z.t, min(z.o) as o
            from (select u.t, u.o from unnest(k.tags) with ordinality as u(t, o)
                  union all
                  select u.t, u.o + 1000 from unnest(d.tags) with ordinality as u(t, o)) z
           group by z.t
           order by min(z.o)
           limit 10) y;
  v_custom := d.custom || k.custom;
  if pg_column_size(v_custom) >= 8192 then
    v_custom := k.custom;
  end if;
  v_owner := k.owner_id;
  if v_owner is null and d.owner_id is not null and exists (
       select 1 from public.profiles p
        where p.id = d.owner_id and p.tenant_id = p_tenant and p.is_active
          and app.role_crm_contacts(p.role::text)) then
    v_owner := d.owner_id;
  end if;
  update public.crm_contacts c
     set title = coalesce(k.title, d.title),
         company_name = coalesce(k.company_name, d.company_name),
         city = coalesce(k.city, d.city),
         country = coalesce(k.country, d.country),
         owner_id = v_owner,
         tags = v_tags,
         custom = v_custom,
         is_starred = k.is_starred or d.is_starred,
         stage = case when array_position(c_rank, d.stage) > array_position(c_rank, k.stage)
                      then d.stage else k.stage end,
         staff_edited = true,
         last_activity_at = greatest(k.last_activity_at, d.last_activity_at, now())
   where c.tenant_id = p_tenant and c.id = p_keep;

  -- 4. Channels. A value both hold keeps the survivor's copy, which takes the other's source
  --    and maker when only the other's was not a lead's (C12-COR-1).
  update public.crm_contact_channels y
     set source = x.source, created_by = x.created_by
    from public.crm_contact_channels x
   where y.tenant_id = p_tenant and y.contact_id = p_keep and y.source = 'lead'
     and x.tenant_id = p_tenant and x.contact_id = p_drop and x.kind = y.kind
     and x.value_hmac = y.value_hmac and x.source <> 'lead';
  delete from public.crm_contact_channels x
   where x.tenant_id = p_tenant and x.contact_id = p_drop
     and exists (select 1 from public.crm_contact_channels y
                  where y.tenant_id = p_tenant and y.contact_id = p_keep
                    and y.kind = x.kind and y.value_hmac = x.value_hmac);
  get diagnostics v_duplicates = row_count;
  select coalesce(array_agg(ch.id), '{}') into v_drop_primary
    from public.crm_contact_channels ch
   where ch.tenant_id = p_tenant and ch.contact_id = p_drop and ch.is_primary;
  update public.crm_contact_channels ch
     set contact_id = p_keep, is_primary = false
   where ch.tenant_id = p_tenant and ch.contact_id = p_drop;
  get diagnostics v_channels = row_count;
  update public.crm_contact_channels ch set is_primary = true
   where ch.id = any (v_drop_primary)
     and not exists (select 1 from public.crm_contact_channels y
                      where y.contact_id = p_keep and y.kind = ch.kind and y.is_primary);
  perform app.crm_fill_primary(p_tenant, p_keep);

  -- 5. Notes (append-only: re-added as they were, the originals removed).
  select coalesce(jsonb_agg(jsonb_build_object('id', n.id, 'body', n.body, 'created_by', n.created_by,
                                               'created_at', n.created_at)), '[]'::jsonb)
    into v_notes
    from public.crm_contact_notes n
   where n.tenant_id = p_tenant and n.contact_id = p_drop;
  delete from public.crm_contact_notes n where n.tenant_id = p_tenant and n.contact_id = p_drop;
  insert into public.crm_contact_notes (id, tenant_id, contact_id, body, created_by, created_at)
  select x.id, p_tenant, p_keep, x.body, x.created_by, x.created_at
    from jsonb_to_recordset(v_notes) as x(id uuid, body text, created_by uuid, created_at timestamptz);
  get diagnostics v_note_count = row_count;

  -- 6. Tasks and leads.
  update public.crm_tasks t set contact_id = p_keep
   where t.tenant_id = p_tenant and t.contact_id = p_drop;
  get diagnostics v_tasks = row_count;
  select coalesce(array_agg(l.id), '{}') into v_moved
    from public.leads l where l.tenant_id = p_tenant and l.contact_id = p_drop;
  update public.leads l set contact_id = p_keep
   where l.tenant_id = p_tenant and l.id = any (v_moved);
  v_leads := cardinality(v_moved);

  -- 7. The timelines. The lead's link lines name the survivor; the line C5's trigger just drew
  --    is the actor's. The survivor's lead_linked lines drawn just now go (the other record's
  --    own, moved below, keep when each lead was first linked); the other lines the survivor's
  --    own triggers drew just now (stage, owner, details) are the actor's.
  with gone as (
    delete from public.lead_events e
     where e.tenant_id = p_tenant and e.kind = 'contact_linked'
       and (e.detail ->> 'contact_id' = p_drop::text
            or (e.lead_id = any (v_moved) and e.at = now() and e.actor_id is null
                and e.detail ->> 'contact_id' = p_keep::text))
    returning e.lead_id, e.at, e.actor_id, e.detail
  )
  insert into public.lead_events (tenant_id, lead_id, at, actor_id, kind, detail)
  select p_tenant, g.lead_id, g.at,
         case when g.at = now() and g.actor_id is null then p_actor else g.actor_id end,
         'contact_linked', jsonb_set(g.detail, '{contact_id}', to_jsonb(p_keep::text))
    from gone g;
  delete from public.crm_contact_events e
   where e.tenant_id = p_tenant and e.contact_id = p_keep and e.kind = 'lead_linked'
     and e.at = now() and e.actor_id is null and e.detail ->> 'lead_id' = any (v_moved::text[]);
  with gone as (
    delete from public.crm_contact_events e
     where e.tenant_id = p_tenant and e.contact_id = p_keep and e.at = now() and e.actor_id is null
       and e.kind in ('stage_changed', 'owner_changed', 'details_changed')
    returning e.at, e.kind, e.detail
  )
  insert into public.crm_contact_events (tenant_id, contact_id, at, actor_id, kind, detail)
  select p_tenant, p_keep, g.at, p_actor, g.kind, g.detail from gone g;
  insert into public.crm_contact_events (tenant_id, contact_id, at, actor_id, kind, detail)
  select p_tenant, p_keep, e.at, e.actor_id, e.kind, e.detail
    from public.crm_contact_events e
   where e.tenant_id = p_tenant and e.contact_id = p_drop and e.kind not in ('created', 'note_added');
  get diagnostics v_events = row_count;

  -- 8. Dismissals and tombstones follow the survivor.
  insert into public.crm_merge_dismissals (tenant_id, contact_a, contact_b, created_by, created_at)
  select p_tenant, least(p_keep, o.other), greatest(p_keep, o.other), o.created_by, o.created_at
    from (select case when x.contact_a = p_drop then x.contact_b else x.contact_a end as other,
                 x.created_by, x.created_at
            from public.crm_merge_dismissals x
           where x.tenant_id = p_tenant and p_drop in (x.contact_a, x.contact_b)) o
    join public.crm_contacts c on c.tenant_id = p_tenant and c.id = o.other and c.merged_into is null
   where o.other <> p_keep
  on conflict do nothing;
  delete from public.crm_merge_dismissals x
   where x.tenant_id = p_tenant and p_drop in (x.contact_a, x.contact_b);
  update public.crm_contacts c set merged_into = p_keep
   where c.tenant_id = p_tenant and c.merged_into = p_drop;

  -- 9. The survivor's line, then the tombstone (its own lines go; it holds nothing).
  insert into public.crm_contact_events (tenant_id, contact_id, actor_id, kind, detail)
  values (p_tenant, p_keep, p_actor, 'merged',
          jsonb_build_object('leads', v_leads, 'channels', v_channels, 'notes', v_note_count,
                             'tasks', v_tasks));
  update public.crm_contacts c
     set display_name = 'Merged contact', title = null, company_name = null, city = null,
         country = null, tags = '{}', custom = '{}'::jsonb, owner_id = null, is_starred = false,
         merged_into = p_keep, merged_at = now()
   where c.tenant_id = p_tenant and c.id = p_drop;
  delete from public.crm_contact_events e where e.tenant_id = p_tenant and e.contact_id = p_drop;

  -- 10. The audit row, in this transaction (hash-chained by audit_log's own triggers).
  select p.role::text into v_role from public.profiles p where p.id = p_actor;
  insert into public.audit_log (tenant_id, actor_id, actor_role, action, entity_type, entity_id, detail)
  values (p_tenant, p_actor, v_role, 'crm.contact.merge', 'contact', p_keep::text,
          jsonb_build_object('keep', p_keep, 'drop', p_drop, 'leads', v_leads,
                             'channels', v_channels, 'duplicates', v_duplicates,
                             'notes', v_note_count, 'tasks', v_tasks));

  select c.version into v_version from public.crm_contacts c
   where c.tenant_id = p_tenant and c.id = p_keep;
  return jsonb_build_object('keep', p_keep, 'version', v_version, 'leads', v_leads,
                            'channels', v_channels, 'duplicates', v_duplicates,
                            'notes', v_note_count, 'tasks', v_tasks, 'events', v_events);
end $$;
revoke all on function public.crm_merge_contacts(uuid, uuid, int, uuid, int, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.crm_merge_contacts(uuid, uuid, int, uuid, int, uuid) to service_role;

-- ═══ 6. Retention, restated (C5's copy plus the lines marked `-- C12`) ═══════════════════
-- Merge tombstones go on the next run (crm.md §8.1). Anything that raced onto one while it was
-- made (an inquiry linked, a task added in the same instant) moves to its survivor first.
create or replace function app.purge_crm() returns int
  language plpgsql security definer set search_path = '' as $$
declare
  removed int := 0;
  n int;
  t record;
begin
  for t in select x.id from public.tenants x loop
    update public.leads l set contact_id = c.merged_into  -- C12
      from public.crm_contacts c  -- C12
     where c.tenant_id = t.id and c.merged_into is not null  -- C12
       and l.tenant_id = c.tenant_id and l.contact_id = c.id;  -- C12
    update public.crm_tasks k set contact_id = c.merged_into  -- C12
      from public.crm_contacts c  -- C12
     where c.tenant_id = t.id and c.merged_into is not null  -- C12
       and k.tenant_id = c.tenant_id and k.contact_id = c.id;  -- C12
    delete from public.crm_contacts c where c.tenant_id = t.id and c.merged_into is not null;  -- C12
    get diagnostics n = row_count;  -- C12
    removed := removed + n;  -- C12
    delete from public.crm_contacts c
     where c.tenant_id = t.id
       and c.last_activity_at < now() - make_interval(months => app.lead_retention_months(t.id));
    get diagnostics n = row_count;
    removed := removed + n;
    -- The orphans, by the one rule (the first three tests narrow the candidates).
    delete from public.crm_contacts c
     where c.tenant_id = t.id
       and c.created_by is null and not c.staff_edited and not c.is_starred
       and app.crm_contact_is_orphan(c.tenant_id, c.id);
    get diagnostics n = row_count;
    removed := removed + n;
  end loop;
  return removed;
end $$;
revoke all on function app.purge_crm() from public, anon, authenticated, service_role;

-- ═══ 6b. C5's person erasure, restated (C8's copy in its migration plus the lines marked `-- C12`)
-- (C12 review, C12-COR-3) An erasure that waited on a merge's lock of the same record, or that
-- the Worker read before a merge committed, would otherwise erase the scrubbed tombstone and
-- say it was done, while the person's leads, channels and notes sit on the survivor. It is a
-- P0002 instead (the Worker's 404): the person reloads and erases the survivor.
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
  -- A merge that held the row first leaves a tombstone: the person is on the survivor now.  -- C12
  if exists (select 1 from public.crm_contacts c  -- C12
              where c.tenant_id = p_tenant and c.id = p_contact and c.merged_into is not null) then  -- C12
    raise exception using errcode = 'P0002', message = 'crm_erase_person: no such contact';  -- C12
  end if;  -- C12
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

-- ═══ 7. Postconditions (P-14: under both Supabase grant regimes) ══════════════════════════
do $$
declare
  v_maintain boolean := current_setting('server_version_num')::int >= 170000;
  v_got text[];
  v_fn text;
  r text;
begin
  -- ---- 1. RLS and policies ----------------------------------------------------------------
  if not exists (select 1 from pg_class
                  where oid = 'public.crm_merge_dismissals'::regclass and relrowsecurity and relforcerowsecurity) then
    raise exception 'C12: crm_merge_dismissals must have RLS enabled and forced';
  end if;
  select array_agg(policyname::text || ':' || cmd || ':' || permissive order by policyname collate "C")
    into v_got
    from pg_policies where schemaname = 'public' and tablename = 'crm_merge_dismissals';
  if v_got is distinct from array['crm_merge_dismissals_insert:INSERT:PERMISSIVE',
                                  'crm_merge_dismissals_live:ALL:RESTRICTIVE',
                                  'crm_merge_dismissals_read:SELECT:PERMISSIVE'] then
    raise exception 'C12: the crm_merge_dismissals policies are %', v_got;
  end if;
  if exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = 'crm_merge_dismissals'
                and (roles <> array['authenticated']::name[]
                     or coalesce(qual, with_check) !~ '^\(\(tenant_id = (app\.)?effective_tenant_id\(\)\) AND (app\.)?role_crm_contacts\('
                     or (with_check is not null
                         and with_check !~ '^\(\(tenant_id = (app\.)?effective_tenant_id\(\)\) AND (app\.)?role_crm_contacts\('))) then
    raise exception 'C12: a crm_merge_dismissals policy is not TO authenticated, or does not lead with the tenant predicate and the crm.contacts helper';
  end if;
  if not exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'crm_merge_dismissals'
                    and policyname = 'crm_merge_dismissals_live'
                    and qual ~ 'live_role\(\)' and with_check ~ 'live_role\(\)') then
    raise exception 'C12: crm_merge_dismissals_live lacks the live check';
  end if;

  -- ---- 2. Grants ----------------------------------------------------------------------------
  foreach r in array array['public', 'anon'] loop
    if has_table_privilege(r::name, 'public.crm_merge_dismissals',
                           'select, insert, update, delete, truncate, references, trigger')
       or has_any_column_privilege(r::name, 'public.crm_merge_dismissals', 'select, insert, update, references')
       or (case when v_maintain then has_table_privilege(r::name, 'public.crm_merge_dismissals', 'maintain')
                else false end) then
      raise exception 'C12: % holds a privilege on crm_merge_dismissals', r;
    end if;
  end loop;
  foreach r in array array['authenticated', 'service_role'] loop
    if has_table_privilege(r::name, 'public.crm_merge_dismissals', 'update, truncate, references, trigger')
       or has_any_column_privilege(r::name, 'public.crm_merge_dismissals', 'update, references')
       or (case when v_maintain then has_table_privilege(r::name, 'public.crm_merge_dismissals', 'maintain')
                else false end) then
      raise exception 'C12: % holds UPDATE, TRUNCATE, REFERENCES, TRIGGER or MAINTAIN on crm_merge_dismissals', r;
    end if;
  end loop;
  if not has_table_privilege('authenticated', 'public.crm_merge_dismissals', 'select')
     or has_table_privilege('authenticated', 'public.crm_merge_dismissals', 'insert')
     or has_table_privilege('authenticated', 'public.crm_merge_dismissals', 'delete') then
    raise exception 'C12: authenticated must hold SELECT, INSERT on named columns only, and no DELETE on crm_merge_dismissals';
  end if;
  select coalesce(array_agg(a.attname::text order by a.attname::text collate "C"), '{}') into v_got
    from pg_attribute a
   where a.attrelid = 'public.crm_merge_dismissals'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', a.attrelid, a.attnum, 'insert');
  if v_got is distinct from array['contact_a', 'contact_b', 'tenant_id'] then
    raise exception 'C12: authenticated inserts the crm_merge_dismissals columns %', v_got;
  end if;
  if not has_table_privilege('service_role', 'public.crm_merge_dismissals', 'select, insert, delete') then
    raise exception 'C12: the service role must hold SELECT, INSERT and DELETE on crm_merge_dismissals';
  end if;

  -- ---- 3. Functions -------------------------------------------------------------------------
  -- The readers and "Not a duplicate": INVOKER, executable by authenticated alone.
  foreach v_fn in array array['public.crm_duplicate_pairs(uuid, integer)',
                              'public.crm_dismiss_duplicate(uuid, uuid, uuid)',
                              'app.crm_merge_side(uuid, uuid)'] loop
    if exists (select 1 from pg_proc where oid = v_fn::regprocedure and prosecdef) then
      raise exception 'C12: % must be SECURITY INVOKER', v_fn;
    end if;
    if has_function_privilege('anon', v_fn, 'execute')
       or has_function_privilege('service_role', v_fn, 'execute')
       or not has_function_privilege('authenticated', v_fn, 'execute')
       or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                   where p.oid = v_fn::regprocedure and a.grantee = 0) then
      raise exception 'C12: % must be executable by authenticated alone', v_fn;
    end if;
  end loop;
  -- The finder's definer: pinned, executable by authenticated alone.
  if not exists (select 1 from pg_proc f join pg_roles o on o.oid = f.proowner
                  where f.oid = 'app.crm_duplicate_candidates(integer)'::regprocedure
                    and f.prosecdef and (o.rolbypassrls or o.rolsuper)
                    and f.proconfig @> array['search_path=""']) then
    raise exception 'C12: app.crm_duplicate_candidates must be a pinned definer owned by a role that bypasses RLS';
  end if;
  if has_function_privilege('anon', 'app.crm_duplicate_candidates(integer)', 'execute')
     or has_function_privilege('service_role', 'app.crm_duplicate_candidates(integer)', 'execute')
     or not has_function_privilege('authenticated', 'app.crm_duplicate_candidates(integer)', 'execute') then
    raise exception 'C12: app.crm_duplicate_candidates must be executable by authenticated alone';
  end if;
  -- The merge and the restated erasure: INVOKER, the service role's alone.
  foreach v_fn in array array['public.crm_merge_contacts(uuid, uuid, integer, uuid, integer, uuid)',
                              'public.crm_erase_person(uuid, uuid, uuid[], uuid)'] loop
    if exists (select 1 from pg_proc where oid = v_fn::regprocedure and prosecdef)
       or has_function_privilege('anon', v_fn, 'execute')
       or has_function_privilege('authenticated', v_fn, 'execute')
       or not has_function_privilege('service_role', v_fn, 'execute')
       or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                   where p.oid = v_fn::regprocedure and a.grantee = 0) then
      raise exception 'C12: % must be SECURITY INVOKER and executable by the service role alone', v_fn;
    end if;
  end loop;
  -- The trigger function and the purge: pinned definers no API role executes.
  foreach v_fn in array array['app.tg_crm_merge_dismissal()', 'app.purge_crm()'] loop
    if not exists (select 1 from pg_proc f join pg_roles o on o.oid = f.proowner
                    where f.oid = v_fn::regprocedure and f.prosecdef and (o.rolbypassrls or o.rolsuper)
                      and f.proconfig @> array['search_path=""']) then
      raise exception 'C12: % must be a pinned definer owned by a role that bypasses RLS', v_fn;
    end if;
    if has_function_privilege('anon', v_fn, 'execute')
       or has_function_privilege('authenticated', v_fn, 'execute')
       or has_function_privilege('service_role', v_fn, 'execute') then
      raise exception 'C12: no API role may execute %', v_fn;
    end if;
  end loop;
  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.crm_merge_dismissals'::regclass
                    and tgname = 'crm_merge_dismissals_row' and not tgisinternal) then
    raise exception 'C12: the crm_merge_dismissals trigger is missing';
  end if;
end $$;
