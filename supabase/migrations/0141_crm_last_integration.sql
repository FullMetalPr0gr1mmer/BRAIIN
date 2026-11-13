-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 0141 — the six-slice CRM integration (Admin v2 C-int: C10b, C9b, C11, C12, C15 and C16 on
-- one branch; docs/admin-v2/as-built/C-LAST-INTEGRATION.md). Forward-only, EXPAND only. HELD
-- with the six: it merges only after the owner's lawyer signs off the privacy-notice update
-- (O-11) and after their migrations. The number is a placeholder: the merge train assigns it
-- (scripts/renumber-migration.mjs). Depends on C5's migration (the contact tables), C9b's
-- (crm_settings.custom_fields and the value trigger), C11's (crm_contacts.company_id and the
-- company-orphan trigger), C12's (the merge door and the purge as it restated them), C15's
-- (crm_contact_imports) and C16's (crm_contact_files and the add door's per-contact lock).
--
-- WHAT IT DOES (each new line in a restated function is marked `-- C-int`; nothing else in
-- it changes)
--   0. (C-int review, CINT-SEC-2 / XS-2) crm_contact_imports holds every lawful-basis row a
--      contact carries: C15's one-row-per-contact key goes (an index on the contact stays for
--      the cascade and the lookups), so a merge of two imported records keeps BOTH bases, and
--      an access request or a withdrawn consent can still find the basis each moved value
--      came under. Before, the dropped record's row stayed on the tombstone and the nightly
--      purge deleted it. The table is new with C15 (held, never in production): no row exists.
--   1. app.crm_tombstone_follow(p_tenant, p_tombstone): a pinned definer. The files (C16) and
--      the import's lawful-basis rows (C15) of a merge tombstone move to the record it was
--      merged into. The service role holds no UPDATE on either table (a file row and a basis
--      row are immutable to every API role), so the move is this one narrow function, which
--      moves rows only off a record that IS a tombstone, and only to its own survivor. Object
--      paths keep the old contact's id: a path is a name, never read back as a link (C16's
--      departure 3). Only the merge calls it.
--   2. public.crm_merge_contacts restated (the merge's copy plus `-- C-int` lines): C16's file
--      lock on the record going away, taken before either row is locked; custom values merged
--      survivor-first and only for a field CRM settings still defines (C9b); the survivor keeps
--      its company and takes the other's only when it names none or names that same company
--      (CINT-W-1 / XS-1: a survivor's own free-text company is never replaced), and the
--      tombstone keeps none, so an auto-company it alone named goes by C11's orphan rule, and
--      a second audit row, crm.contact.merge.company_removed, names its id (CINT-W-4 / XS-5,
--      as C11-SEC-4 audits an unlink's); then app.crm_tombstone_follow.
--      Who may merge: a live crm.contacts holder (Admin, and Sales since C10b, as crm.md
--      CRM-12 designs it); the Worker claims a Sales user's reveal slot first (C12-SEC-R2-1).
--      Since the owner's decision of 2026-11-13 a pair where either record holds a file needs
--      an actor who may handle files (crm.files, Admin; item 6), which tells a Sales user the
--      person has files (accepted by the owner). The answer and the audit row keep their
--      counts, with no count of files.
--   3. app.purge_crm restated (the merge's copy plus `-- C-int` lines): a file or a basis row
--      on a tombstone follows it before the tombstone goes, by two set-based updates, as C12
--      already moves leads and tasks (CINT-SEC-1 / XS-6: never the follow, which raises for a
--      tombstone erased mid-run and takes a lock per tombstone, held to the end of the
--      nightly run).
--   4. public.crm_file_remove restated (C16's copy plus `-- C-int` lines): a removal named on
--      a record that a merge has just emptied finds the file on the survivor (CINT-W-3 /
--      XS-4: the route removes the object first, so a P0002 there left a row whose object
--      was gone).
--   5. (Owner decision 2026-11-13) public.crm_contact_reveal_channels(p_tenant, p_contact,
--      p_actor): the reveal's ciphertext through a door, the service role's alone. The actor
--      checked live; every channel for an actor who may erase (Admin), the main e-mail and
--      the main phone only for anyone else (Sales). The Worker's reveal reads through it.
--   6. (Owner decision 2026-11-13) public.crm_edit_contact_channels restated (0136's copy plus
--      `-- C-int` lines): choosing the main e-mail or phone, by naming one or by adding one
--      marked primary, needs an actor who may erase (Admin), as removing one already does.
--      Sales still adds. And in item 2's merge (owner decision, same day): a merge where
--      either record holds a file needs an actor who may handle files (crm.files, Admin),
--      checked with both rows locked and before anything moves; 42501 otherwise.
--   7. (C-int review, CINT2-SEC-1) public.crm_erase_lead restated (0134's copy plus `-- C-int`
--      lines): when it takes back a lead's copies from the person, the oldest e-mail or phone
--      left of a kind whose main one went becomes the main one (app.crm_fill_primary), as the
--      editor and the merge already do, so every kind a contact holds keeps a main one and a
--      Sales reveal, add, link or confirm never surfaces a detail Sales was not shown.
--   8. (C-int review, CINT2-SEC-1) public.crm_contact_new_lead restated (0133's copy plus
--      `-- C-int` lines): a new lead for a contact copies its main e-mail and phone only, never
--      a non-primary one as a fallback (Sales may add a lead and then reveal it).
--
-- Production behaviour: none until the six slices and the Worker deploy. Nothing calls the
-- merge before C12's route ships and no tombstone exists before the first merge, so the
-- purge's new lines find nothing. Items 5 and 6 have no deployed caller before C6's Worker
-- and C10b ship (the channels table is new with C5, held). Rule 5 holds trivially.
-- ─────────────────────────────────────────────────────────────────────────────────────────

-- ═══ 0. Every lawful-basis row a contact carries ══════════════════════════════════════════
-- A busy table fails the push instead of queueing behind it (0041's reason).
set local lock_timeout = '5s';
alter table public.crm_contact_imports drop constraint crm_contact_imports_one;
-- The contact's cascade and its lookups (the import's dedupe, the follow) keep an index.
create index crm_contact_imports_contact_idx on public.crm_contact_imports (tenant_id, contact_id);

-- ═══ 1. A tombstone's files and lawful basis follow its survivor ══════════════════════════
create or replace function app.crm_tombstone_follow(p_tenant uuid, p_tombstone uuid) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
declare
  v_keep uuid;
  v_files int;
  v_imports int;
begin
  select c.merged_into into v_keep from public.crm_contacts c
   where c.tenant_id = p_tenant and c.id = p_tombstone and c.merged_into is not null;
  if v_keep is null then
    raise exception using errcode = 'P0002', message = 'crm_tombstone_follow: not a merged record';
  end if;
  -- The add door's own lock (C16): a file being added to the tombstone waits, then is refused.
  perform pg_advisory_xact_lock(hashtextextended('crm-files:' || p_tombstone::text, 0));
  update public.crm_contact_files f set contact_id = v_keep
   where f.tenant_id = p_tenant and f.contact_id = p_tombstone;
  get diagnostics v_files = row_count;
  -- Every basis row: the survivor keeps its own and gains the other's (section 0).
  update public.crm_contact_imports i set contact_id = v_keep
   where i.tenant_id = p_tenant and i.contact_id = p_tombstone;
  get diagnostics v_imports = row_count;
  return jsonb_build_object('files', v_files, 'imports', v_imports);
end $$;
revoke all on function app.crm_tombstone_follow(uuid, uuid) from public, anon, authenticated, service_role;
-- The merge door is the service role's INVOKER function, so it runs this as the service role.
grant execute on function app.crm_tombstone_follow(uuid, uuid) to service_role;

-- ═══ 2. The merge, restated (the merge's copy plus the lines marked `-- C-int`) ══════════
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
  v_removed_company uuid;  -- C-int
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
  -- (C12 x C16) The file add door's own per-contact lock on the record going away, taken  -- C-int
  -- before either row is locked (the add's key check would otherwise wait on this merge's row  -- C-int
  -- lock while holding it): a file being added now waits, then finds a tombstone (P0002); one  -- C-int
  -- added just before is moved to the survivor below.  -- C-int
  perform pg_advisory_xact_lock(hashtextextended('crm-files:' || p_drop::text, 0));  -- C-int
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
  -- (Owner decision 2026-11-13) A merge where either record holds a file needs someone who  -- C-int
  -- may handle files (crm.files: an Admin). Checked with both rows locked, so a file being  -- C-int
  -- added now (its key check waits on those locks) is counted, and before anything moves.  -- C-int
  if not app.crm_files_actor_ok(p_tenant, p_actor)  -- C-int
     and exists (select 1 from public.crm_contact_files f  -- C-int
                  where f.tenant_id = p_tenant and f.contact_id in (p_keep, p_drop)) then  -- C-int
    raise exception using errcode = '42501',  -- C-int
      message = 'crm_merge_contacts: one of these records holds files, so an Admin merges them';  -- C-int
  end if;  -- C-int
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
  -- (C12 x C9b) The survivor's value wins for each key and the other's fills a gap, but only  -- C-int
  -- for a field CRM settings still defines: a value of a field that no longer exists is never  -- C-int
  -- carried (the value trigger would refuse the whole merge for it).  -- C-int
  v_custom := coalesce((select jsonb_object_agg(e.key, e.value)  -- C-int
                          from jsonb_each(d.custom) e  -- C-int
                         where e.key in (select f ->> 'key'  -- C-int
                                           from public.crm_settings s  -- C-int
                                                cross join lateral jsonb_array_elements(s.custom_fields) f  -- C-int
                                          where s.tenant_id = p_tenant)), '{}'::jsonb)  -- C-int
              || k.custom;  -- C-int
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
         -- (C12 x C11) The survivor keeps its company. It takes the other's linked one only  -- C-int
         -- when it names no company, or its free text names that same company (CINT-W-1,  -- C-int
         -- XS-1): a person's own text is never replaced by C11's trigger with another name.  -- C-int
         company_id = case when k.company_id is not null then k.company_id  -- C-int
                           when k.company_name is null  -- C-int
                             or app.crm_name_key(k.company_name) = (select co.name_key  -- C-int
                                                                       from public.crm_companies co  -- C-int
                                                                      where co.tenant_id = p_tenant  -- C-int
                                                                        and co.id = d.company_id)  -- C-int
                           then d.company_id end,  -- C-int
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
         -- (C12 x C11) and no company: an auto-company it alone named goes (C11's orphan rule).  -- C-int
         company_id = null,  -- C-int
         merged_into = p_keep, merged_at = now()
   where c.tenant_id = p_tenant and c.id = p_drop;
  delete from public.crm_contact_events e where e.tenant_id = p_tenant and e.contact_id = p_drop;
  -- (C12 x C11, CINT-W-4 / XS-5) The company the other record named, when C11's orphan rule  -- C-int
  -- took it with the tombstone's company just now (the survivor did not take it).  -- C-int
  if d.company_id is not null and not exists (select 1 from public.crm_companies co  -- C-int
                                               where co.tenant_id = p_tenant and co.id = d.company_id) then  -- C-int
    v_removed_company := d.company_id;  -- C-int
  end if;  -- C-int
  -- (C12 x C16, C12 x C15) Its files and its import's lawful-basis rows follow the survivor.  -- C-int
  perform app.crm_tombstone_follow(p_tenant, p_drop);  -- C-int

  -- 10. The audit row, in this transaction (hash-chained by audit_log's own triggers).
  select p.role::text into v_role from public.profiles p where p.id = p_actor;
  insert into public.audit_log (tenant_id, actor_id, actor_role, action, entity_type, entity_id, detail)
  values (p_tenant, p_actor, v_role, 'crm.contact.merge', 'contact', p_keep::text,
          jsonb_build_object('keep', p_keep, 'drop', p_drop, 'leads', v_leads,
                             'channels', v_channels, 'duplicates', v_duplicates,
                             'notes', v_note_count, 'tasks', v_tasks));
  -- (CINT-W-4 / XS-5) As C11 audits an unlink that removes an auto-company (C11-SEC-4): its id  -- C-int
  -- only, in this transaction, so a merge that removed one cannot leave without saying so.  -- C-int
  if v_removed_company is not null then  -- C-int
    insert into public.audit_log (tenant_id, actor_id, actor_role, action, entity_type, entity_id, detail)  -- C-int
    values (p_tenant, p_actor, v_role, 'crm.contact.merge.company_removed', 'contact', p_keep::text,  -- C-int
            jsonb_build_object('keep', p_keep, 'drop', p_drop, 'removed_company', v_removed_company));  -- C-int
  end if;  -- C-int

  select c.version into v_version from public.crm_contacts c
   where c.tenant_id = p_tenant and c.id = p_keep;
  return jsonb_build_object('keep', p_keep, 'version', v_version, 'leads', v_leads,
                            'channels', v_channels, 'duplicates', v_duplicates,
                            'notes', v_note_count, 'tasks', v_tasks, 'events', v_events);
end $$;
revoke all on function public.crm_merge_contacts(uuid, uuid, int, uuid, int, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.crm_merge_contacts(uuid, uuid, int, uuid, int, uuid) to service_role;

-- ═══ 3. Retention, restated (the merge's copy plus the lines marked `-- C-int`) ══════════
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
    -- (C12 x C16, C12 x C15) Files and basis rows on a tombstone follow it too, set-based as  -- C-int
    -- the two above: no per-tombstone lock and nothing that raises for a tombstone an erasure  -- C-int
    -- takes mid-run, so one record never stops the night's retention (CINT-SEC-1 / XS-6).  -- C-int
    update public.crm_contact_files f set contact_id = c.merged_into  -- C-int
      from public.crm_contacts c  -- C-int
     where c.tenant_id = t.id and c.merged_into is not null  -- C-int
       and f.tenant_id = c.tenant_id and f.contact_id = c.id;  -- C-int
    update public.crm_contact_imports i set contact_id = c.merged_into  -- C-int
      from public.crm_contacts c  -- C-int
     where c.tenant_id = t.id and c.merged_into is not null  -- C-int
       and i.tenant_id = c.tenant_id and i.contact_id = c.id;  -- C-int
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

-- ═══ 4. A file removal follows a merge (C16's copy plus the lines marked `-- C-int`) ══════
-- The route reads the file's path on the record it was asked about, removes the object, then
-- calls this door. A merge committed in between has moved the row to the survivor: the door
-- then removes it there (only the survivor of the record named, and only that file), so no
-- row is left naming an object that is gone (CINT-W-3 / XS-4).
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
  if v_path is null then  -- C-int
    delete from public.crm_contact_files f  -- C-int
     where f.tenant_id = p_tenant and f.id = p_file  -- C-int
       and f.contact_id = (select c.merged_into from public.crm_contacts c  -- C-int
                            where c.tenant_id = p_tenant and c.id = p_contact  -- C-int
                              and c.merged_into is not null)  -- C-int
    returning f.object_path into v_path;  -- C-int
  end if;  -- C-int
  if v_path is null then
    raise exception using errcode = 'P0002', message = 'crm_file_remove: no such file';
  end if;
  return v_path;
end $$;
revoke all on function public.crm_file_remove(uuid, uuid, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.crm_file_remove(uuid, uuid, uuid, uuid) to service_role;

-- ═══ 5. The reveal's ciphertext, decided by the database (owner decision 2026-11-13) ════════
-- A Sales reveal shows the main e-mail and the main phone only; an Admin's shows every one. The
-- Worker's reveal (src/lib/crm/contactReveal.ts) reads the ciphertext it decrypts through this
-- door, never the table, so the database decides what a reveal can show whatever the Worker
-- asks: the acting profile checked live (a crm.contacts holder of the tenant, active, not
-- locked), a merge tombstone or another tenant's contact P0002, every channel for an actor who
-- may erase (app.crm_eraser_ok: crm.erase, the same person who removes one and chooses the
-- main one), the primaries only for anyone else. The service role's alone; it changes nothing.
create or replace function public.crm_contact_reveal_channels(p_tenant uuid, p_contact uuid,
                                                              p_actor uuid)
  returns table (id uuid, kind text, is_primary boolean, source text, value_enc text)
  language plpgsql stable security invoker set search_path = '' as $$
declare
  v_every boolean;
begin
  if p_tenant is null or p_contact is null or p_actor is null then
    raise exception using errcode = '22023', message = 'crm_contact_reveal_channels: a tenant, a contact and an actor are required';
  end if;
  if not app.crm_contacts_actor_ok(p_tenant, p_actor, false) then
    raise exception using errcode = '42501', message = 'crm_contact_reveal_channels: this person may not reveal contact details';
  end if;
  if not exists (select 1 from public.crm_contacts c
                  where c.tenant_id = p_tenant and c.id = p_contact and c.merged_into is null) then
    raise exception using errcode = 'P0002', message = 'crm_contact_reveal_channels: no such contact';
  end if;
  v_every := app.crm_eraser_ok(p_tenant, p_actor);
  return query
    select ch.id, ch.kind, ch.is_primary, ch.source, ch.value_enc
      from public.crm_contact_channels ch
     where ch.tenant_id = p_tenant and ch.contact_id = p_contact
       and (v_every or ch.is_primary)
     order by ch.kind, ch.is_primary desc, ch.created_at, ch.id;
end $$;
revoke all on function public.crm_contact_reveal_channels(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.crm_contact_reveal_channels(uuid, uuid, uuid) to service_role;

-- ═══ 6. Choosing the main e-mail or phone is Admin's (owner decision 2026-11-13) ═════════════
-- C10b's public.crm_edit_contact_channels (0136, its latest definition), restated with the
-- lines marked `-- C-int`: a change that names a primary, or adds a channel marked primary,
-- needs an actor who may erase (Admin), or it is a 42501 and nothing is written. Removing was
-- already Admin's (0136, C10B-SEC-2). Everything else as 0136 wrote it, grants included.
create or replace function public.crm_edit_contact_channels(
  p_tenant uuid, p_contact uuid, p_version int, p_add jsonb, p_remove uuid[], p_primary uuid[],
  p_actor uuid)
  returns jsonb
  language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  v_add jsonb := coalesce(p_add, '[]'::jsonb);
  v_remove uuid[] := coalesce(p_remove, '{}');
  v_primary uuid[] := coalesce(p_primary, '{}');
  v_version int;
  v_holder uuid;
  v_removed int := 0;
  v_added int := 0;
  r record;
  v_id uuid;
begin
  if p_tenant is null or p_contact is null or p_version is null or p_actor is null then
    raise exception using errcode = '22023', message = 'crm_edit_contact_channels: a tenant, a contact, a version and an actor are required';
  end if;
  if not app.crm_contacts_actor_ok(p_tenant, p_actor, false) then
    raise exception using errcode = '42501', message = 'crm_edit_contact_channels: this person may not edit contacts';
  end if;
  if not app.crm_channels_ok(v_add) or cardinality(v_remove) > 10 or cardinality(v_primary) > 2
     or array_position(v_remove, null) is not null or array_position(v_primary, null) is not null then
    raise exception using errcode = '22023', message = 'crm_edit_contact_channels: a change has the wrong shape';
  end if;
  -- (C10b review, C10B-SEC-2) Removing an e-mail or phone deletes a person's details, and one
  -- a person typed in has no copy anywhere else: erasure's (crm.erase, Admin), never a
  -- crm.contacts holder's alone. Sales adds; an Admin removes and (C-int, the owner's decision
  -- of 2026-11-13) chooses the main one.
  if cardinality(v_remove) > 0 and not app.crm_eraser_ok(p_tenant, p_actor) then
    raise exception using errcode = '42501', message = 'crm_edit_contact_channels: this person may not remove an e-mail or phone';
  end if;
  -- (Owner decision 2026-11-13) Which e-mail or phone is the main one decides what a Sales  -- C-int
  -- reveal shows (the main ones only), so choosing it is the eraser's too (crm.erase, Admin):  -- C-int
  -- a channel named primary, or an added one marked primary, needs app.crm_eraser_ok. Sales  -- C-int
  -- still adds (kept, and the main one only when the contact has none of that kind).  -- C-int
  if (cardinality(v_primary) > 0  -- C-int
      or exists (select 1 from jsonb_array_elements(v_add) e where e -> 'is_primary' = 'true'::jsonb))  -- C-int
     and not app.crm_eraser_ok(p_tenant, p_actor) then  -- C-int
    raise exception using errcode = '42501', message = 'crm_edit_contact_channels: this person may not choose the main e-mail or phone';  -- C-int
  end if;  -- C-int
  select c.version into v_version
    from public.crm_contacts c
   where c.tenant_id = p_tenant and c.id = p_contact and c.merged_into is null
     for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'crm_edit_contact_channels: no such contact';
  end if;
  if v_version <> p_version then
    raise exception using errcode = '40001', message = 'crm_edit_contact_channels: the contact changed since it was read';
  end if;
  if exists (select 1 from unnest(v_remove || v_primary) x
              where not exists (select 1 from public.crm_contact_channels ch
                                 where ch.tenant_id = p_tenant and ch.contact_id = p_contact and ch.id = x)) then
    raise exception using errcode = '22023', message = 'crm_edit_contact_channels: a channel is not this contact''s';
  end if;
  if exists (select 1 from unnest(v_primary) x where x = any (v_remove)) then
    raise exception using errcode = '22023', message = 'crm_edit_contact_channels: a removed channel cannot be made primary';
  end if;
  v_holder := app.crm_email_holder(p_tenant, v_add, p_contact);
  if v_holder is not null then
    return jsonb_build_object('duplicate', v_holder);
  end if;

  for r in delete from public.crm_contact_channels ch
            where ch.tenant_id = p_tenant and ch.contact_id = p_contact and ch.id = any (v_remove)
            returning ch.kind, ch.source loop
    insert into public.crm_contact_events (tenant_id, contact_id, actor_id, kind, detail)
    values (p_tenant, p_contact, p_actor, 'channel_removed',
            jsonb_build_object('kind', r.kind, 'source', r.source));
    v_removed := v_removed + 1;
  end loop;

  insert into public.crm_contact_channels (tenant_id, contact_id, kind, value_enc, value_hmac,
                                           is_primary, source, created_by)
  select p_tenant, p_contact, e ->> 'kind', e ->> 'value_enc', e ->> 'value_hmac', false, 'manual', p_actor
    from jsonb_array_elements(v_add) e
  on conflict do nothing;
  get diagnostics v_added = row_count;
  -- At most app.crm_channel_cap() of a kind this change adds to (C6 review, C6-SEC-3); the
  -- whole change is refused, nothing half-saved. The message names the rule for the Worker's
  -- map (src/lib/crm/contacts.ts CONTACT_CONSTRAINTS), as the owner rule's does.
  if exists (select 1 from (select distinct e ->> 'kind' as kind from jsonb_array_elements(v_add) e) k
              where (select count(*) from public.crm_contact_channels ch
                      where ch.tenant_id = p_tenant and ch.contact_id = p_contact and ch.kind = k.kind)
                    > app.crm_channel_cap()) then
    raise exception using errcode = '23514',
      message = 'a contact keeps at most ten e-mails and ten phones (constraint "crm_contact_channels_cap")';
  end if;

  -- Primary: the one named, per kind; a newly added channel marked primary too.
  foreach v_id in array v_primary || array(
      select ch.id from public.crm_contact_channels ch
        join jsonb_array_elements(v_add) e
          on e ->> 'kind' = ch.kind and e ->> 'value_hmac' = ch.value_hmac
       where ch.tenant_id = p_tenant and ch.contact_id = p_contact
         and coalesce((e ->> 'is_primary')::boolean, false)) loop
    update public.crm_contact_channels ch set is_primary = false
     where ch.contact_id = p_contact and ch.is_primary and ch.id <> v_id
       and ch.kind = (select x.kind from public.crm_contact_channels x where x.id = v_id);
    update public.crm_contact_channels ch set is_primary = true where ch.id = v_id;
  end loop;
  perform app.crm_fill_primary(p_tenant, p_contact);
  return jsonb_build_object('added', v_added, 'removed', v_removed);
end $$;
revoke all on function public.crm_edit_contact_channels(uuid, uuid, int, jsonb, uuid[], uuid[], uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.crm_edit_contact_channels(uuid, uuid, int, jsonb, uuid[], uuid[], uuid)
  to service_role;

-- ═══ 7. A lead's erasure leaves a main e-mail and phone (C-int review, CINT2-SEC-1) ═══════════
-- C8's public.crm_erase_lead (0134's copy of C5's, its latest definition), restated with the
-- lines marked `-- C-int`. It takes back the e-mail and phone a lead copied to its person, and
-- one of those may be the person's main one. Since the owner's decision of 2026-11-13 a Sales
-- reveal shows the main ones only, so a kind left with no main one hid what remains from
-- Sales, and the next Sales add, staff link or confirm (each ends in app.crm_fill_primary)
-- made a detail Sales was never shown the main one. Every other door that removes a channel
-- (the editor, the merge) already fills the main one after it; this one now does too. Who
-- erases is crm.erase (Admin), so the main one is still chosen by an Admin's act.
create or replace function public.crm_erase_lead(p_tenant uuid, p_lead uuid, p_actor uuid)
  returns jsonb
  language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  v_number int;
  v_notes int;
  v_events int;
  v_tasks int;  -- C8
  v_contact uuid;
  v_link text;
  v_email_hmac text;
  v_phone_hmac text;
  v_contacts int := 0;
begin
  if p_tenant is null or p_lead is null or p_actor is null then
    raise exception using errcode = '22023', message = 'crm_erase_lead: a tenant, a lead and an actor are required';
  end if;
  if not app.crm_eraser_ok(p_tenant, p_actor) then
    raise exception using errcode = '42501', message = 'crm_erase_lead: this person may not erase';
  end if;
  select l.lead_number, l.contact_id, l.contact_link, l.email_hmac, l.phone_hmac
    into v_number, v_contact, v_link, v_email_hmac, v_phone_hmac
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
  select count(*)::int into v_tasks from public.crm_tasks tk  -- C8
   where tk.tenant_id = p_tenant and tk.lead_id = p_lead;  -- C8
  delete from public.leads l where l.tenant_id = p_tenant and l.id = p_lead;
  delete from public.crm_contact_events e
   where e.tenant_id = p_tenant and e.kind = 'lead_linked' and e.detail ->> 'lead_id' = p_lead::text;
  if v_contact is not null and app.crm_contact_is_orphan(p_tenant, v_contact) then
    delete from public.lead_events e
     where e.tenant_id = p_tenant and e.kind = 'contact_linked'
       and e.detail ->> 'contact_id' = v_contact::text;
    delete from public.crm_contacts c where c.tenant_id = p_tenant and c.id = v_contact;
    v_contacts := 1;
  elsif v_contact is not null and v_link is distinct from 'phone' then
    -- A phone link copied nothing to the contact, so only a lead of the person's own has
    -- copies to take back: the channels made from it that no remaining lead of the person
    -- (linked other than by phone) carries.
    delete from public.crm_contact_channels ch
     where ch.tenant_id = p_tenant and ch.contact_id = v_contact and ch.source = 'lead'
       and ((ch.kind = 'email' and ch.value_hmac = v_email_hmac)
            or (ch.kind = 'phone' and ch.value_hmac = v_phone_hmac))
       and not exists (select 1 from public.leads l
                        where l.tenant_id = p_tenant and l.contact_id = v_contact
                          and l.contact_link is distinct from 'phone'
                          and ((ch.kind = 'email' and l.email_hmac = ch.value_hmac)
                               or (ch.kind = 'phone' and l.phone_hmac = ch.value_hmac)));
    -- (C-int review, CINT2-SEC-1) A copy taken back may have been the main one of its kind:  -- C-int
    -- the oldest left of that kind becomes the main one, as after an Admin's removal in the  -- C-int
    -- editor, so a Sales reveal (the main ones only) never meets a kind with no main one.  -- C-int
    perform app.crm_fill_primary(p_tenant, v_contact);  -- C-int
  end if;
  return jsonb_build_object('lead_number', v_number, 'leads', 1, 'notes', v_notes, 'events', v_events,
                            'tasks', v_tasks,  -- C8
                            'contacts', v_contacts);
end $$;
revoke all on function public.crm_erase_lead(uuid, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.crm_erase_lead(uuid, uuid, uuid) to service_role;

-- ═══ 8. A new lead for a contact copies its main e-mail and phone only (CINT2-SEC-1) ═══════════
-- C6's public.crm_contact_new_lead (0133), restated with the lines marked `-- C-int`. Sales may
-- call it (crm.contacts with leads.manage and leads.pii) and then reveals the new lead, so
-- what it copies must be what a Sales reveal of the contact would show: the main ones. It used
-- to fall back to the oldest when a kind had no main one; with item 7 every kind a contact
-- holds has one, and this keeps the rule even if a later door forgets.
create or replace function public.crm_contact_new_lead(p_tenant uuid, p_contact uuid, p_lead jsonb,
                                                       p_actor uuid)
  returns jsonb
  language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  v_email record;
  v_phone record;
  v_lead jsonb;
  v_id uuid;
  v_out jsonb;
begin
  if p_tenant is null or p_contact is null or p_actor is null or p_lead is null
     or jsonb_typeof(p_lead) <> 'object' then
    raise exception using errcode = '22023', message = 'crm_contact_new_lead: a tenant, a contact, a lead and an actor are required';
  end if;
  if not app.crm_contacts_actor_ok(p_tenant, p_actor, true) then
    raise exception using errcode = '42501', message = 'crm_contact_new_lead: this person may not add leads for contacts';
  end if;
  if exists (select 1 from jsonb_object_keys(p_lead) k
              where k not in ('id', 'locale', 'name', 'company', 'budget_enc', 'timeline_text_enc',
                              'message', 'service_of_interest', 'discipline_of_interest',
                              'channel', 'score_signals')) then
    raise exception using errcode = '22023', message = 'crm_contact_new_lead: unknown lead field';
  end if;
  perform 1 from public.crm_contacts c
   where c.tenant_id = p_tenant and c.id = p_contact and c.merged_into is null
     for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'crm_contact_new_lead: no such contact';
  end if;
  select ch.value_enc, ch.value_hmac into v_email
    from public.crm_contact_channels ch
   where ch.tenant_id = p_tenant and ch.contact_id = p_contact and ch.kind = 'email'
     and ch.is_primary  -- C-int
   order by ch.is_primary desc, ch.created_at, ch.id limit 1;
  select ch.value_enc, ch.value_hmac into v_phone
    from public.crm_contact_channels ch
   where ch.tenant_id = p_tenant and ch.contact_id = p_contact and ch.kind = 'phone'
     and ch.is_primary  -- C-int
   order by ch.is_primary desc, ch.created_at, ch.id limit 1;
  if v_email.value_enc is null and v_phone.value_enc is null then
    raise exception using errcode = '22023', message = 'crm_contact_new_lead: the contact has no e-mail or phone';
  end if;
  v_lead := p_lead || jsonb_strip_nulls(jsonb_build_object(
    'email_enc', v_email.value_enc, 'email_hmac', v_email.value_hmac,
    'phone_enc', v_phone.value_enc, 'phone_hmac', v_phone.value_hmac,
    'source', 'manual', 'created_by', p_actor));
  v_id := public.crm_ingest_lead(p_tenant, v_lead);
  v_out := app.crm_staff_link(p_tenant, p_contact, v_id);
  return jsonb_build_object('id', v_id, 'link', v_out ->> 'link');
end $$;
revoke all on function public.crm_contact_new_lead(uuid, uuid, jsonb, uuid) from public, anon, authenticated, service_role;
grant execute on function public.crm_contact_new_lead(uuid, uuid, jsonb, uuid) to service_role;

-- ═══ 9. Postconditions ════════════════════════════════════════════════════════════════════
do $$
declare
  v_fn text;
begin
  -- The follow: a pinned definer owned by a role that bypasses RLS, the service role's alone.
  if not exists (select 1 from pg_proc f join pg_roles o on o.oid = f.proowner
                  where f.oid = 'app.crm_tombstone_follow(uuid, uuid)'::regprocedure
                    and f.prosecdef and (o.rolbypassrls or o.rolsuper)
                    and f.proconfig = array['search_path=""']) then
    raise exception 'C-int: app.crm_tombstone_follow must be a definer pinned to an empty search_path';
  end if;
  if has_function_privilege('anon', 'app.crm_tombstone_follow(uuid, uuid)', 'execute')
     or has_function_privilege('authenticated', 'app.crm_tombstone_follow(uuid, uuid)', 'execute')
     or not has_function_privilege('service_role', 'app.crm_tombstone_follow(uuid, uuid)', 'execute')
     or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                 where p.oid = 'app.crm_tombstone_follow(uuid, uuid)'::regprocedure and a.grantee = 0) then
    raise exception 'C-int: app.crm_tombstone_follow must be executable by the service role alone';
  end if;
  -- The merge: still INVOKER, pinned as C12 pinned it, the service role's alone, and it calls
  -- the follow, takes the file lock and carries the company and the defined values.
  v_fn := 'public.crm_merge_contacts(uuid, uuid, integer, uuid, integer, uuid)';
  if exists (select 1 from pg_proc where oid = v_fn::regprocedure and prosecdef)
     or not exists (select 1 from pg_proc where oid = v_fn::regprocedure
                     and proconfig = array['search_path=public, pg_temp'])
     or has_function_privilege('anon', v_fn, 'execute')
     or has_function_privilege('authenticated', v_fn, 'execute')
     or not has_function_privilege('service_role', v_fn, 'execute')
     or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                 where p.oid = v_fn::regprocedure and a.grantee = 0) then
    raise exception 'C-int: % must stay SECURITY INVOKER, pinned, the service role''s alone', v_fn;
  end if;
  if not exists (select 1 from pg_proc where oid = v_fn::regprocedure
                  and prosrc like '%app.crm_tombstone_follow(p_tenant, p_drop)%'
                  and prosrc like '%''crm-files:'' || p_drop::text%'
                  and prosrc like '%when k.company_id is not null then k.company_id%'
                  and prosrc like '%''crm.contact.merge.company_removed''%'
                  and prosrc like '%jsonb_array_elements(s.custom_fields)%'
                  and prosrc like '%if not app.crm_files_actor_ok(p_tenant, p_actor)%') then
    raise exception 'C-int: the merge lacks a line of the integration';
  end if;
  -- The purge: still a pinned definer no API role executes, and it follows tombstones.
  if not exists (select 1 from pg_proc f join pg_roles o on o.oid = f.proowner
                  where f.oid = 'app.purge_crm()'::regprocedure and f.prosecdef
                    and (o.rolbypassrls or o.rolsuper) and f.proconfig = array['search_path=""']
                    and f.prosrc like '%update public.crm_contact_files f set contact_id = c.merged_into%'
                    and f.prosrc like '%update public.crm_contact_imports i set contact_id = c.merged_into%'
                    and f.prosrc not like '%crm_tombstone_follow%'
                    and f.prosrc not like '%pg_advisory%') then
    raise exception 'C-int: app.purge_crm must be a pinned definer that follows tombstones set-based';
  end if;
  if has_function_privilege('anon', 'app.purge_crm()', 'execute')
     or has_function_privilege('authenticated', 'app.purge_crm()', 'execute')
     or has_function_privilege('service_role', 'app.purge_crm()', 'execute') then
    raise exception 'C-int: no API role may execute app.purge_crm';
  end if;
  -- The file removal: still INVOKER, pinned, the service role's alone, and it follows a merge.
  v_fn := 'public.crm_file_remove(uuid, uuid, uuid, uuid)';
  if exists (select 1 from pg_proc where oid = v_fn::regprocedure and prosecdef)
     or not exists (select 1 from pg_proc where oid = v_fn::regprocedure
                     and proconfig = array['search_path=""'] and prosrc like '%c.merged_into is not null%')
     or has_function_privilege('anon', v_fn, 'execute')
     or has_function_privilege('authenticated', v_fn, 'execute')
     or not has_function_privilege('service_role', v_fn, 'execute')
     or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                 where p.oid = v_fn::regprocedure and a.grantee = 0) then
    raise exception 'C-int: % must stay SECURITY INVOKER, pinned, the service role''s alone, and follow a merge', v_fn;
  end if;
  -- The reveal's door (owner decision 2026-11-13): INVOKER, pinned to an empty search_path,
  -- the service role's alone, every channel only for an eraser.
  v_fn := 'public.crm_contact_reveal_channels(uuid, uuid, uuid)';
  if exists (select 1 from pg_proc where oid = v_fn::regprocedure and prosecdef)
     or not exists (select 1 from pg_proc where oid = v_fn::regprocedure
                     and proconfig = array['search_path=""']
                     and prosrc like '%app.crm_contacts_actor_ok(p_tenant, p_actor, false)%'
                     and prosrc like '%(v_every or ch.is_primary)%')
     or has_function_privilege('anon', v_fn, 'execute')
     or has_function_privilege('authenticated', v_fn, 'execute')
     or not has_function_privilege('service_role', v_fn, 'execute')
     or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                 where p.oid = v_fn::regprocedure and a.grantee = 0) then
    raise exception 'C-int: % must be SECURITY INVOKER, pinned, the service role''s alone, primaries unless an eraser', v_fn;
  end if;
  -- The channel editor: still INVOKER as 0133 pinned it, the service role's alone, and both
  -- the removal and the choice of the main one ask for an eraser.
  v_fn := 'public.crm_edit_contact_channels(uuid, uuid, integer, jsonb, uuid[], uuid[], uuid)';
  if exists (select 1 from pg_proc where oid = v_fn::regprocedure and prosecdef)
     or not exists (select 1 from pg_proc where oid = v_fn::regprocedure
                     and proconfig = array['search_path=public, pg_temp']
                     and prosrc like '%if cardinality(v_remove) > 0 and not app.crm_eraser_ok(p_tenant, p_actor) then%'
                     and prosrc like '%(cardinality(v_primary) > 0%'
                     and prosrc like '%may not choose the main e-mail or phone%')
     or has_function_privilege('anon', v_fn, 'execute')
     or has_function_privilege('authenticated', v_fn, 'execute')
     or not has_function_privilege('service_role', v_fn, 'execute')
     or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                 where p.oid = v_fn::regprocedure and a.grantee = 0) then
    raise exception 'C-int: % must stay INVOKER, pinned, the service role''s alone, an eraser choosing the main one', v_fn;
  end if;
  -- A lead's erasure fills the main one after it takes copies back; a new lead for a contact
  -- copies the main ones only. Both stay INVOKER, pinned, the service role's alone (CINT2-SEC-1).
  v_fn := 'public.crm_erase_lead(uuid, uuid, uuid)';
  if exists (select 1 from pg_proc where oid = v_fn::regprocedure and prosecdef)
     or not exists (select 1 from pg_proc where oid = v_fn::regprocedure
                     and proconfig = array['search_path=public, pg_temp']
                     and prosrc like '%perform app.crm_fill_primary(p_tenant, v_contact);%')
     or has_function_privilege('anon', v_fn, 'execute')
     or has_function_privilege('authenticated', v_fn, 'execute')
     or not has_function_privilege('service_role', v_fn, 'execute') then
    raise exception 'C-int: % must stay INVOKER, pinned, the service role''s alone, and fill the main one', v_fn;
  end if;
  v_fn := 'public.crm_contact_new_lead(uuid, uuid, jsonb, uuid)';
  if exists (select 1 from pg_proc where oid = v_fn::regprocedure and prosecdef)
     or not exists (select 1 from pg_proc where oid = v_fn::regprocedure
                     and proconfig = array['search_path=public, pg_temp']
                     and prosrc like '%and ch.is_primary  -- C-int%')
     or has_function_privilege('anon', v_fn, 'execute')
     or has_function_privilege('authenticated', v_fn, 'execute')
     or not has_function_privilege('service_role', v_fn, 'execute') then
    raise exception 'C-int: % must stay INVOKER, pinned, the service role''s alone, and copy the main ones only', v_fn;
  end if;
  -- Every basis row a contact carries: no one-per-contact key, an index on the contact.
  if exists (select 1 from pg_constraint where conname = 'crm_contact_imports_one'
                and conrelid = 'public.crm_contact_imports'::regclass)
     or to_regclass('public.crm_contact_imports_contact_idx') is null then
    raise exception 'C-int: crm_contact_imports must keep every basis row, indexed by contact';
  end if;
  -- The tables keep their grants: no API role updates a file row or a basis row.
  if has_any_column_privilege('service_role', 'public.crm_contact_files', 'update')
     or has_any_column_privilege('service_role', 'public.crm_contact_imports', 'update')
     or has_any_column_privilege('authenticated', 'public.crm_contact_files', 'update')
     or has_any_column_privilege('authenticated', 'public.crm_contact_imports', 'update') then
    raise exception 'C-int: an API role updates crm_contact_files or crm_contact_imports';
  end if;
end $$;
