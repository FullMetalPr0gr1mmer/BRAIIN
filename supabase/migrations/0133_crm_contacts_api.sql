-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 0133 — the contacts API's database half (Admin v2 C6, crm.md CRM-6). Forward-only, EXPAND
-- only: new functions; no table, column, grant or policy of an existing object changes. HELD
-- with C5 (the contacts schema): it merges only after C5, which merges after the owner's
-- lawyer signs off the privacy-notice update (O-11, register L-2). The number is a
-- placeholder: the merge train assigns it (scripts/renumber-migration.mjs). Depends on C5's
-- migration (the contact tables, app.role_crm_contacts, app.crm_touch, the link), 0034
-- (app.lead_retention_months), 0036 (app.normalize_ar_q's folding), 0041 (app.tags_ok,
-- app.crm_eraser_ok) and 0091 (crm_ingest_lead, as C5 restated it).
--
-- WHAT IT ADDS
--   Reads, SECURITY INVOKER (RLS, the live check and the column grants decide; the Worker
--   names the tenant too and gets nothing unless it is the token's), executable by
--   `authenticated` only:
--     • public.crm_contacts_list / crm_contact_summary: the People list and its counts, over
--       one allow-listed, bounded filter (app.crm_contact_filter, 22023 otherwise). A whole
--       e-mail or phone is found by its blind index only (app.crm_contacts_with_channel, a
--       narrow definer: staff never read value_hmac), so a searched address never reaches the
--       database; one sent as text is refused. Value and score are derived from the leads
--       linked other than by phone (never stored, crm.md §5.1).
--     • public.crm_contact_timeline: the contact's events and those of its leads linked other
--       than by phone, one keyset, at most 60 a page. Metadata only: a note's words stay
--       behind the audited notes door (the Worker's), as for leads.
--     • public.crm_contacts_bulk_update: tags, owner, stage (versioned) and star over up to
--       100 contacts, as leads_bulk_update is built (0041).
--   Writes that carry ciphertext, or touch what no staff token may write, are the service
--   role's doors (INVOKER, the service role only), each checking the acting profile LIVE
--   (app.crm_contacts_actor_ok; the erase-gated ones app.crm_eraser_ok): add a contact with
--   its channels, edit channels, delete a contact note, confirm or detach a phone-matched lead
--   (the check C5 left to this slice: a `staff` link), and a new lead from the contact's own
--   ciphertext. Nothing decrypts here: the Worker encrypts and indexes, the doors copy.
--
-- Production behaviour: none until the Worker that calls these deploys (with C7's screens);
-- nothing reads or calls a function this file adds. Rule 5 holds trivially.
-- ─────────────────────────────────────────────────────────────────────────────────────────

-- ═══ 1. Helpers ═══════════════════════════════════════════════════════════════════════════
-- The caller's own tenant's horizon (site_settings.retention.leads_months, 24 by default), for
-- a contact's expiry date. app.lead_retention_months is a definer staff cannot execute (it
-- takes any tenant); this wrapper answers only the caller's own.
create or replace function app.crm_retention_months() returns int
  language sql stable security definer set search_path = '' as $$
  select app.lead_retention_months(app.effective_tenant_id())
$$;
revoke all on function app.crm_retention_months() from public, anon, authenticated, service_role;
grant execute on function app.crm_retention_months() to authenticated;

-- The ids of the caller's tenant's contacts holding this blind index, without revealing it:
-- staff read no value_hmac (C5's column grant). Empty unless the caller's LIVE role holds
-- crm.contacts, or the index is not one.
create or replace function app.crm_contacts_with_channel(p_kind text, p_hmac text) returns setof uuid
  language plpgsql stable security definer set search_path = '' as $$
begin
  if not app.role_crm_contacts(app.live_role()) or p_kind is null or p_kind not in ('email', 'phone')
     or p_hmac is null or p_hmac !~ '^[0-9a-f]{64}$' then
    return;
  end if;
  return query select distinct ch.contact_id from public.crm_contact_channels ch
                where ch.tenant_id = app.effective_tenant_id() and ch.kind = p_kind
                  and ch.value_hmac = p_hmac;
end $$;
revoke all on function app.crm_contacts_with_channel(text, text) from public, anon, authenticated, service_role;
grant execute on function app.crm_contacts_with_channel(text, text) to authenticated;

-- The acting person of a service-role door, checked now: an active, unlocked profile of the
-- tenant holding crm.contacts (and, for a new lead, working leads). The Worker checked the
-- same a moment before (liveRecheck); this is the database's own layer.
create or replace function app.crm_contacts_actor_ok(p_tenant uuid, p_actor uuid, p_leads boolean)
  returns boolean
  language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles p
     where p.id = p_actor
       and p.tenant_id = p_tenant
       and p.is_active
       and (p.locked_until is null or p.locked_until <= now())
       and app.role_crm_contacts(p.role::text)
       and (not coalesce(p_leads, false) or app.role_works_leads(p.role::text)))
$$;
revoke all on function app.crm_contacts_actor_ok(uuid, uuid, boolean) from public, anon, authenticated, service_role;
grant execute on function app.crm_contacts_actor_ok(uuid, uuid, boolean) to service_role;

-- ═══ 2. The filter ════════════════════════════════════════════════════════════════════════
-- One validator for the list and the lookup: a key outside the list, or a value outside its
-- bounds, is 22023. Packages/schemas/crm.ts (ContactQuerySchema) is the Worker's half.
create or replace function app.crm_contact_filter(p jsonb)
  returns table (
    stage text, owner_kind text, owner_id uuid, starred boolean, expiring boolean, tag text,
    needle text, contact_kind text, contact_hmac text, sort text, page_limit int, page_offset int)
  language plpgsql stable as $$
declare
  f jsonb := coalesce(p, '{}'::jsonb);
  v_q text;
  v_owner text;
begin
  if jsonb_typeof(f) <> 'object' then
    raise exception using errcode = '22023', message = 'contact filter: an object is required';
  end if;
  if exists (select 1 from jsonb_object_keys(f) k
              where k not in ('stage', 'owner', 'starred', 'expiring', 'tag', 'q', 'contact_kind',
                              'contact_hmac', 'sort', 'limit', 'offset')) then
    raise exception using errcode = '22023', message = 'contact filter: unknown key';
  end if;
  begin
    starred := (f ->> 'starred')::boolean;
    expiring := (f ->> 'expiring')::boolean;
    page_limit := coalesce((f ->> 'limit')::int, 25);
    page_offset := coalesce((f ->> 'offset')::int, 0);
  exception when others then
    raise exception using errcode = '22023', message = 'contact filter: a value has the wrong type';
  end;
  if page_limit not between 1 and 100 or page_offset not between 0 and 10000 then
    raise exception using errcode = '22023', message = 'contact filter: a page bound is out of range';
  end if;
  stage := f ->> 'stage';
  if stage is not null and stage not in ('lead', 'client', 'past', 'partner') then
    raise exception using errcode = '22023', message = 'contact filter: unknown stage';
  end if;
  sort := coalesce(f ->> 'sort', 'recent');
  if sort not in ('recent', 'name', 'starred', 'oldest') then
    raise exception using errcode = '22023', message = 'contact filter: sort is recent, name, starred or oldest';
  end if;
  tag := f ->> 'tag';
  if tag is not null and not app.tags_ok(array[tag]) then
    raise exception using errcode = '22023', message = 'contact filter: a tag is 1 to 32 characters';
  end if;
  v_owner := f ->> 'owner';
  if v_owner is not null then
    if v_owner = 'me' then
      owner_kind := 'me';
      owner_id := auth.uid();
    elsif v_owner = 'none' then
      owner_kind := 'none';
    elsif v_owner ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      owner_kind := 'person';
      owner_id := v_owner::uuid;
    else
      raise exception using errcode = '22023', message = 'contact filter: owner is me, none or a person';
    end if;
  end if;
  contact_kind := f ->> 'contact_kind';
  contact_hmac := f ->> 'contact_hmac';
  if (contact_kind is null) <> (contact_hmac is null)
     or (contact_kind is not null and (contact_kind not in ('email', 'phone')
                                       or contact_hmac !~ '^[0-9a-f]{64}$')) then
    raise exception using errcode = '22023', message = 'contact filter: contact_kind and contact_hmac go together';
  end if;
  v_q := f ->> 'q';
  if v_q is not null then
    if char_length(v_q) > 64 or v_q ~ '[[:cntrl:]]' then
      raise exception using errcode = '22023', message = 'contact filter: q is at most 64 printable characters';
    end if;
    -- As app.lead_filter: an address or a number is found by its blind index only.
    if strpos(v_q, '@') > 0
       or (v_q ~ '^[-+0-9[:space:]().٠-٩۰-۹]+$'
           and char_length(regexp_replace(v_q, '[^0-9٠-٩۰-۹]', '', 'g')) >= 7) then
      raise exception using errcode = '22023',
        message = 'contact filter: an e-mail address or a phone number is searched by its blind index';
    end if;
    -- Folded like crm_contacts.search_text, then escaped: a % or _ is a character.
    needle := nullif(replace(replace(replace(
                lower(coalesce(app.normalize_ar_q(btrim(v_q)), '')),
                '\', '\\'), '%', '\%'), '_', '\_'), '');
  end if;
  return next;
end $$;
revoke all on function app.crm_contact_filter(jsonb) from public, anon, authenticated, service_role;
grant execute on function app.crm_contact_filter(jsonb) to authenticated;

-- ═══ 3. Reads (INVOKER) ═══════════════════════════════════════════════════════════════════
-- {total, rows}. The total counts every match apart from the page. Value and score come from
-- the leads linked other than by phone (a phone match may be someone else's until checked);
-- `to_check` counts the phone matches waiting for a person. Never a channel's value: only
-- whether the contact has an e-mail or a phone.
create or replace function public.crm_contacts_list(p_tenant uuid, p_filter jsonb default '{}'::jsonb)
  returns jsonb
  language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare
  f record;
  v_months int := app.crm_retention_months();
begin
  select * into f from app.crm_contact_filter(p_filter);
  return (
    with matching as (
      select c.id,
             row_number() over (
               order by case when f.sort = 'starred' then c.is_starred end desc nulls last,
                        case when f.sort = 'name' then c.name_key end asc,
                        case when f.sort = 'oldest' then c.created_at end asc,
                        c.last_activity_at desc, c.id) as pos
        from public.crm_contacts c
       where c.tenant_id = app.effective_tenant_id()
         and c.tenant_id = p_tenant
         and c.merged_into is null
         and (f.stage is null or c.stage = f.stage)
         and (f.owner_kind is null
              or (f.owner_kind = 'none' and c.owner_id is null)
              or (f.owner_kind in ('me', 'person') and c.owner_id = f.owner_id))
         and (f.starred is null or c.is_starred = f.starred)
         and (f.expiring is null
              or (c.last_activity_at + make_interval(months => v_months)
                  < now() + interval '30 days') = f.expiring)
         and (f.tag is null or f.tag = any (c.tags))
         and (f.needle is null or c.search_text like '%' || f.needle || '%' escape '\')
         and (f.contact_hmac is null
              or c.id in (select app.crm_contacts_with_channel(f.contact_kind, f.contact_hmac)))
    ),
    page as (
      select c.id, c.display_name, c.company_name, c.title, c.stage, c.source, c.owner_id,
             c.locale, c.city, c.country, c.tags, c.is_starred, c.last_activity_at,
             c.last_activity_at + make_interval(months => v_months) as expires_at,
             c.created_at, c.version,
             exists (select 1 from public.crm_contact_channels ch
                      where ch.tenant_id = c.tenant_id and ch.contact_id = c.id and ch.kind = 'email') as has_email,
             exists (select 1 from public.crm_contact_channels ch
                      where ch.tenant_id = c.tenant_id and ch.contact_id = c.id and ch.kind = 'phone') as has_phone,
             coalesce(v.leads, 0) as leads, coalesce(v.to_check, 0) as to_check, v.value, v.score,
             m.pos
        from matching m
        join public.crm_contacts c on c.tenant_id = app.effective_tenant_id() and c.id = m.id
        left join lateral (
          select count(*) filter (where l.contact_link <> 'phone')::int as leads,
                 count(*) filter (where l.contact_link = 'phone')::int as to_check,
                 sum(l.value_sar) filter (where l.contact_link <> 'phone' and s.kind = 'won') as value,
                 max(l.score) filter (where l.contact_link <> 'phone') as score
            from public.leads l
            left join public.lead_stages s on s.tenant_id = l.tenant_id and s.id = l.stage_id
           where l.tenant_id = c.tenant_id and l.contact_id = c.id) v on true
       where m.pos > f.page_offset
         and m.pos <= f.page_offset + f.page_limit
    )
    select jsonb_build_object(
             'total', (select count(*) from matching),
             'rows', coalesce((select jsonb_agg(to_jsonb(p) - 'pos' order by p.pos) from page p),
                              '[]'::jsonb)));
end $$;
revoke all on function public.crm_contacts_list(uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.crm_contacts_list(uuid, jsonb) to authenticated;

-- The People screen's counts, no filter: per stage, starred, the caller's own, expiring within
-- 30 days, and contacts with a phone match to check. Counts only.
create or replace function public.crm_contact_summary(p_tenant uuid)
  returns jsonb
  language sql stable security invoker set search_path = public, pg_temp as $$
  with c as (
    select x.* from public.crm_contacts x
     where x.tenant_id = app.effective_tenant_id() and x.tenant_id = p_tenant
       and x.merged_into is null
  )
  select jsonb_build_object(
    'total', (select count(*) from c),
    'lead', (select count(*) from c where c.stage = 'lead'),
    'client', (select count(*) from c where c.stage = 'client'),
    'past', (select count(*) from c where c.stage = 'past'),
    'partner', (select count(*) from c where c.stage = 'partner'),
    'starred', (select count(*) from c where c.is_starred),
    'mine', (select count(*) from c where c.owner_id = auth.uid()),
    'expiring', (select count(*) from c
                  where c.last_activity_at + make_interval(months => app.crm_retention_months())
                        < now() + interval '30 days'),
    'to_check', (select count(*) from c
                  where exists (select 1 from public.leads l
                                 where l.tenant_id = c.tenant_id and l.contact_id = c.id
                                   and l.contact_link = 'phone')))
$$;
revoke all on function public.crm_contact_summary(uuid) from public, anon, authenticated, service_role;
grant execute on function public.crm_contact_summary(uuid) to authenticated;

-- A page of a contact's timeline, newest first: its own events and the events of its leads
-- linked other than by phone (a phone match is not the person's until a person says so), on
-- one keyset (at, src, id): two tables number their events apart, so the source breaks a tie
-- before the id. A filter: all, notes (a note added or deleted, here or on a lead), leads
-- (the leads' events and the link lines), changes (the contact's own other events). Metadata
-- only: never a note's words or a contact detail. P0002 when the caller sees no such contact
-- (another tenant's, a stale token's, none).
-- p_filter: {kind, before, before_src, before_id, limit (1 to 60, 30 by default)}.
create or replace function public.crm_contact_timeline(p_tenant uuid, p_contact uuid,
                                                       p_filter jsonb default '{}'::jsonb)
  returns jsonb
  language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare
  f jsonb := coalesce(p_filter, '{}'::jsonb);
  v_kind text;
  v_before timestamptz;
  v_src text;
  v_id bigint;
  v_limit int;
  v_created_by uuid;
  v_events jsonb;
  v_n int;
begin
  if jsonb_typeof(f) <> 'object'
     or exists (select 1 from jsonb_object_keys(f) k
                 where k not in ('kind', 'before', 'before_src', 'before_id', 'limit')) then
    raise exception using errcode = '22023', message = 'contact timeline: unknown key';
  end if;
  begin
    v_kind := coalesce(f ->> 'kind', 'all');
    v_before := (f ->> 'before')::timestamptz;
    v_src := f ->> 'before_src';
    v_id := (f ->> 'before_id')::bigint;
    v_limit := coalesce((f ->> 'limit')::int, 30);
  exception when others then
    raise exception using errcode = '22023', message = 'contact timeline: a value has the wrong type';
  end;
  if v_kind not in ('all', 'notes', 'leads', 'changes') or v_limit not between 1 and 60
     or ((v_before is null) <> (v_src is null) or (v_before is null) <> (v_id is null))
     or (v_src is not null and v_src not in ('contact', 'lead')) then
    raise exception using errcode = '22023', message = 'contact timeline: kind, page or cursor out of range';
  end if;
  select c.created_by into v_created_by
    from public.crm_contacts c
   where c.tenant_id = app.effective_tenant_id() and c.tenant_id = p_tenant and c.id = p_contact;
  if not found then
    raise exception using errcode = 'P0002', message = 'contact timeline: no such contact';
  end if;

  with ev as (
    select 'contact'::text as src, e.id, e.at,
           -- A contact a person added through the service role's door has no session to name:
           -- its creator is the actor of its first line.
           coalesce(e.actor_id, case when e.kind = 'created' then v_created_by end) as actor_id,
           e.kind, e.detail, null::uuid as lead_id, null::int as lead_number
      from public.crm_contact_events e
     where e.tenant_id = app.effective_tenant_id() and e.tenant_id = p_tenant
       and e.contact_id = p_contact
       and (v_kind = 'all'
            or (v_kind = 'notes' and e.kind in ('note_added', 'note_deleted'))
            or (v_kind = 'leads' and e.kind = 'lead_linked')
            or (v_kind = 'changes' and e.kind not in ('note_added', 'note_deleted', 'lead_linked')))
    union all
    select 'lead'::text, e.id, e.at, e.actor_id, e.kind, e.detail, l.id, l.lead_number
      from public.lead_events e
      join public.leads l on l.tenant_id = e.tenant_id and l.id = e.lead_id
     where e.tenant_id = app.effective_tenant_id() and e.tenant_id = p_tenant
       and l.contact_id = p_contact and l.contact_link <> 'phone'
       -- The contact's own lead_linked line says it; the lead's twin would repeat it.
       and e.kind <> 'contact_linked'
       and (v_kind in ('all', 'leads')
            or (v_kind = 'notes' and e.kind in ('note_added', 'note_deleted')))
  ), page as (
    select ev.* from ev
     where v_before is null or (ev.at, ev.src, ev.id) < (v_before, v_src, v_id)
     order by ev.at desc, ev.src desc, ev.id desc
     limit v_limit
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'src', p.src, 'id', p.id, 'at', p.at, 'actor_id', p.actor_id, 'kind', p.kind,
           'detail', p.detail, 'lead_id', p.lead_id, 'lead_number', p.lead_number)
           order by p.at desc, p.src desc, p.id desc), '[]'::jsonb),
         count(*)::int
    into v_events, v_n
    from page p;
  return jsonb_build_object(
    'events', v_events,
    'next', case when v_n = v_limit then
                   jsonb_build_object('before', v_events -> (v_n - 1) -> 'at',
                                      'before_src', v_events -> (v_n - 1) -> 'src',
                                      'before_id', v_events -> (v_n - 1) -> 'id')
            end);
end $$;
revoke all on function public.crm_contact_timeline(uuid, uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.crm_contact_timeline(uuid, uuid, jsonb) to authenticated;

-- ═══ 4. Bulk, as the caller (INVOKER) ═════════════════════════════════════════════════════
-- Modelled on public.leads_bulk_update (0041). p_value: a tag (tagAdd, tagRemove), a profile
-- id or null (owner), a stage key (stage), true or false (star). Each item is {id, version};
-- the version is required except for star (a star is not an edit and moves no version).
-- Every item comes back once: applied (with its new version), conflict (its version moved
-- on), missing (not a contact this caller can change), skipped (seen at the version sent but
-- left alone: ten tags already). A refused owner (not an active contacts user of the tenant)
-- fails the whole statement (23514): nothing half-applied.
create or replace function public.crm_contacts_bulk_update(
  p_tenant uuid,
  p_action text,
  p_value jsonb,
  p_items jsonb
) returns table (contact_id uuid, contact_version int, outcome text)
  language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  c_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_item jsonb;
  v_versioned boolean := true;
  v_set text;
  v_guard text := '';
  v_uuid uuid;
  v_text text;
  v_bool boolean;
  v_applied jsonb;
begin
  -- Each SET is chosen from this fixed list, never built from the caller's text; the value
  -- travels as a bound parameter.
  if p_action = 'owner' then
    if p_value is null or jsonb_typeof(p_value) = 'null' then
      v_uuid := null;
    elsif jsonb_typeof(p_value) = 'string' and (p_value #>> '{}') ~* c_uuid then
      v_uuid := (p_value #>> '{}')::uuid;
    else
      raise exception using errcode = '22023', message = 'crm_contacts_bulk_update: the value must be a person''s id or null';
    end if;
    v_set := 'owner_id = $4';
  elsif p_action = 'stage' then
    if jsonb_typeof(p_value) is distinct from 'string'
       or (p_value #>> '{}') not in ('lead', 'client', 'past', 'partner') then
      raise exception using errcode = '22023', message = 'crm_contacts_bulk_update: the value must be a stage';
    end if;
    v_text := p_value #>> '{}';
    v_set := 'stage = $5';
  elsif p_action = 'star' then
    v_versioned := false;
    if jsonb_typeof(p_value) is distinct from 'boolean' then
      raise exception using errcode = '22023', message = 'crm_contacts_bulk_update: the value must be true or false';
    end if;
    v_bool := (p_value #>> '{}')::boolean;
    v_set := 'is_starred = $6';
  elsif p_action in ('tagAdd', 'tagRemove') then
    if jsonb_typeof(p_value) is distinct from 'string' or not app.tags_ok(array[p_value #>> '{}']) then
      raise exception using errcode = '22023', message = 'crm_contacts_bulk_update: a tag is 1 to 32 characters';
    end if;
    v_text := p_value #>> '{}';
    if p_action = 'tagAdd' then
      v_set := 'tags = case when $5 = any(c.tags) then c.tags else c.tags || $5 end';
      v_guard := ' and ($5 = any(c.tags) or cardinality(c.tags) < 10)';
    else
      v_set := 'tags = array_remove(c.tags, $5)';
    end if;
  else
    raise exception using errcode = '22023', message = 'crm_contacts_bulk_update: unknown action';
  end if;

  if p_items is null or jsonb_typeof(p_items) is distinct from 'array'
     or jsonb_array_length(p_items) not between 1 and 100 then
    raise exception using errcode = '22023', message = 'crm_contacts_bulk_update: 1 to 100 items';
  end if;
  for v_item in select e from jsonb_array_elements(p_items) e loop
    if jsonb_typeof(v_item) <> 'object' then
      raise exception using errcode = '22023', message = 'crm_contacts_bulk_update: an item is an object';
    end if;
    if exists (select 1 from jsonb_object_keys(v_item) k where k not in ('id', 'version')) then
      raise exception using errcode = '22023', message = 'crm_contacts_bulk_update: an item is {id, version}';
    end if;
    if coalesce(v_item ->> 'id', '') !~* c_uuid then
      raise exception using errcode = '22023', message = 'crm_contacts_bulk_update: an item needs a contact id';
    end if;
    if v_item ? 'version' then
      if coalesce(v_item ->> 'version', '') !~ '^[1-9][0-9]{0,8}$' then
        raise exception using errcode = '22023', message = 'crm_contacts_bulk_update: a version is a positive whole number';
      end if;
    elsif v_versioned then
      raise exception using errcode = '22023', message = 'crm_contacts_bulk_update: this action needs each contact''s version';
    end if;
  end loop;
  if (select count(distinct (e ->> 'id')::uuid) from jsonb_array_elements(p_items) e)
     <> jsonb_array_length(p_items) then
    raise exception using errcode = '22023', message = 'crm_contacts_bulk_update: each contact once';
  end if;

  -- 1. The change, one statement. Tombstones (merged_into, C12) are never changed.
  execute format($sql$
    with items as (
      select (e ->> 'id')::uuid as id, (e ->> 'version')::int as expected
        from jsonb_array_elements($1) e
    ),
    upd as (
      update public.crm_contacts c
         set %s
        from items i
       where c.tenant_id = app.effective_tenant_id()
         and c.tenant_id = $2
         and c.id = i.id
         and c.merged_into is null%s%s
      returning c.id, c.version
    )
    select coalesce(jsonb_object_agg(u.id, u.version), '{}'::jsonb) from upd u
  $sql$, v_set, case when v_versioned then ' and c.version = i.expected' else '' end, v_guard)
  into v_applied
  using p_items, p_tenant, v_versioned, v_uuid, v_text, v_bool;

  -- 2. Every other contact, judged in a second statement with a fresh snapshot (0041's
  --    reason: a row another session changed during the update is a conflict, not skipped).
  return query
    select i.id,
           coalesce((v_applied ->> i.id::text)::int, c.version),
           case when v_applied ? i.id::text then 'applied'
                when c.id is null then 'missing'
                when v_versioned and c.version <> i.expected then 'conflict'
                else 'skipped'
           end
      from (select (e ->> 'id')::uuid as id, (e ->> 'version')::int as expected
              from jsonb_array_elements(p_items) e) i
      left join public.crm_contacts c
        on c.id = i.id
       and c.tenant_id = app.effective_tenant_id()
       and c.tenant_id = p_tenant
       and c.merged_into is null
     order by i.id;
end $$;
revoke all on function public.crm_contacts_bulk_update(uuid, text, jsonb, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.crm_contacts_bulk_update(uuid, text, jsonb, jsonb) to authenticated;

-- ═══ 5. The service role's doors ══════════════════════════════════════════════════════════
-- Channels as the Worker sends them: [{kind, value_enc, value_hmac, is_primary?}], each
-- checked here (the table's CHECKs are the backstop). 22023 on anything else.
create or replace function app.crm_channels_ok(p jsonb) returns boolean
  language sql immutable set search_path = '' as $$
  select p is not null and pg_catalog.jsonb_typeof(p) = 'array'
     and pg_catalog.jsonb_array_length(p) <= 10
     and not exists (
       select 1 from pg_catalog.jsonb_array_elements(p) e
        where pg_catalog.jsonb_typeof(e) <> 'object'
           or exists (select 1 from pg_catalog.jsonb_object_keys(e) k
                       where k not in ('kind', 'value_enc', 'value_hmac', 'is_primary'))
           or coalesce(e ->> 'kind', '') not in ('email', 'phone')
           or pg_catalog.char_length(coalesce(e ->> 'value_enc', '')) not between 1 and 4096
           or coalesce(e ->> 'value_hmac', '') !~ '^[0-9a-f]{64}$'
           or (e ? 'is_primary' and pg_catalog.jsonb_typeof(e -> 'is_primary') <> 'boolean'))
     and (select pg_catalog.count(distinct (e ->> 'kind') || ':' || (e ->> 'value_hmac'))
            from pg_catalog.jsonb_array_elements(p) e) = pg_catalog.jsonb_array_length(p)
$$;
revoke all on function app.crm_channels_ok(jsonb) from public, anon, authenticated, service_role;
grant execute on function app.crm_channels_ok(jsonb) to service_role;

-- The contact already holding one of these e-mail indexes, under the link's own per-address
-- advisory lock (app.crm_link_lead_core takes the same key), so an arrival and a person's add
-- of one new address cannot both make a contact; the unique index is the backstop. Null when
-- none does. p_except: the contact being edited (its own e-mail is not a duplicate).
create or replace function app.crm_email_holder(p_tenant uuid, p_channels jsonb, p_except uuid)
  returns uuid
  language plpgsql volatile security definer set search_path = '' as $$
declare
  v_hmac text;
  v_holder uuid;
begin
  for v_hmac in
    select e ->> 'value_hmac' from pg_catalog.jsonb_array_elements(coalesce(p_channels, '[]'::jsonb)) e
     where e ->> 'kind' = 'email'
     order by 1
  loop
    perform pg_advisory_xact_lock(hashtextextended('crm-email:' || p_tenant::text || ':' || v_hmac, 0));
    select ch.contact_id into v_holder
      from public.crm_contact_channels ch
     where ch.tenant_id = p_tenant and ch.kind = 'email' and ch.value_hmac = v_hmac
       and ch.contact_id is distinct from p_except;
    if v_holder is not null then
      return v_holder;
    end if;
  end loop;
  return null;
end $$;
revoke all on function app.crm_email_holder(uuid, jsonb, uuid) from public, anon, authenticated, service_role;
grant execute on function app.crm_email_holder(uuid, jsonb, uuid) to service_role;

-- Each kind with a channel and no primary gets its oldest as primary.
create or replace function app.crm_fill_primary(p_tenant uuid, p_contact uuid) returns void
  language sql volatile security definer set search_path = '' as $$
  update public.crm_contact_channels ch set is_primary = true
   where ch.id in (
     select distinct on (x.kind) x.id from public.crm_contact_channels x
      where x.tenant_id = p_tenant and x.contact_id = p_contact
        and not exists (select 1 from public.crm_contact_channels y
                         where y.contact_id = x.contact_id and y.kind = x.kind and y.is_primary)
      order by x.kind, x.created_at, x.id)
$$;
revoke all on function app.crm_fill_primary(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function app.crm_fill_primary(uuid, uuid) to service_role;

-- Add a contact by hand: its details and channels in one transaction. p_contact is an
-- allow-listed object (display_name required; title, company_name, stage, source, owner_id,
-- locale, city, country, tags, custom; channels). The creator is p_actor (the row trigger
-- keeps a session's own id, and the service role has none). An e-mail another contact holds
-- writes nothing and answers {duplicate: <that contact>}; otherwise {id}.
create or replace function public.crm_create_contact(p_tenant uuid, p_contact jsonb, p_actor uuid)
  returns jsonb
  language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  v_channels jsonb := coalesce(p_contact -> 'channels', '[]'::jsonb);
  v_holder uuid;
  v_id uuid;
  v_tags text[];
begin
  if p_tenant is null or p_actor is null or p_contact is null or jsonb_typeof(p_contact) <> 'object' then
    raise exception using errcode = '22023', message = 'crm_create_contact: a tenant, a contact and an actor are required';
  end if;
  if not app.crm_contacts_actor_ok(p_tenant, p_actor, false) then
    raise exception using errcode = '42501', message = 'crm_create_contact: this person may not add contacts';
  end if;
  if exists (select 1 from jsonb_object_keys(p_contact) k
              where k not in ('display_name', 'title', 'company_name', 'stage', 'source', 'owner_id',
                              'locale', 'city', 'country', 'tags', 'custom', 'channels')) then
    raise exception using errcode = '22023', message = 'crm_create_contact: unknown contact field';
  end if;
  if not app.crm_channels_ok(v_channels)
     or (p_contact ? 'tags' and jsonb_typeof(p_contact -> 'tags') <> 'array')
     or (p_contact ? 'custom' and jsonb_typeof(p_contact -> 'custom') <> 'object')
     or coalesce(p_contact ->> 'source', 'manual') = 'import' then
    raise exception using errcode = '22023', message = 'crm_create_contact: a field has the wrong shape';
  end if;
  v_holder := app.crm_email_holder(p_tenant, v_channels, null);
  if v_holder is not null then
    return jsonb_build_object('duplicate', v_holder);
  end if;
  v_tags := coalesce(array(select jsonb_array_elements_text(p_contact -> 'tags')), '{}');

  insert into public.crm_contacts (tenant_id, display_name, title, company_name, stage, source,
                                   owner_id, locale, city, country, tags, custom, created_by)
  values (p_tenant, p_contact ->> 'display_name', p_contact ->> 'title', p_contact ->> 'company_name',
          coalesce(p_contact ->> 'stage', 'lead'), coalesce(p_contact ->> 'source', 'manual'),
          nullif(p_contact ->> 'owner_id', '')::uuid, coalesce(p_contact ->> 'locale', 'en'),
          p_contact ->> 'city', p_contact ->> 'country', v_tags,
          coalesce(p_contact -> 'custom', '{}'::jsonb), p_actor)
  returning id into v_id;

  insert into public.crm_contact_channels (tenant_id, contact_id, kind, value_enc, value_hmac,
                                           is_primary, source, created_by)
  select p_tenant, v_id, e ->> 'kind', e ->> 'value_enc', e ->> 'value_hmac', false, 'manual', p_actor
    from jsonb_array_elements(v_channels) e;
  -- The primary of each kind: the one marked, else the first sent.
  update public.crm_contact_channels ch set is_primary = true
   where ch.id in (
     select distinct on (x.kind) x.id
       from public.crm_contact_channels x
       join jsonb_array_elements(v_channels) with ordinality e(v, n)
         on e.v ->> 'kind' = x.kind and e.v ->> 'value_hmac' = x.value_hmac
      where x.tenant_id = p_tenant and x.contact_id = v_id
      order by x.kind, coalesce((e.v ->> 'is_primary')::boolean, false) desc, e.n);
  return jsonb_build_object('id', v_id);
end $$;
revoke all on function public.crm_create_contact(uuid, jsonb, uuid) from public, anon, authenticated, service_role;
grant execute on function public.crm_create_contact(uuid, jsonb, uuid) to service_role;

-- Change a contact's channels: remove some (each must be this contact's), add some (a value
-- the contact holds already is left; an e-mail another contact holds writes nothing and
-- answers {duplicate}), make some primary. Checked at the contact's version the screen read
-- (40001 when it moved on; P0002 when there is no such contact); a channel is not a column
-- of the contact, so the version does not move. Each removal writes `channel_removed` (kind
-- and source, never the value). Answers counts.
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

-- Delete one contact note (crm.erase, Admin: a note that should never have been written
-- down). The timeline says a note went, its id only. P0002 when the contact has no such
-- note; 42501 when the actor may not erase.
create or replace function public.crm_delete_contact_note(p_tenant uuid, p_contact uuid, p_note uuid,
                                                          p_actor uuid)
  returns uuid
  language plpgsql volatile security invoker set search_path = public, pg_temp as $$
begin
  if p_tenant is null or p_contact is null or p_note is null or p_actor is null then
    raise exception using errcode = '22023', message = 'crm_delete_contact_note: a tenant, a contact, a note and an actor are required';
  end if;
  if not app.crm_eraser_ok(p_tenant, p_actor) then
    raise exception using errcode = '42501', message = 'crm_delete_contact_note: this person may not delete notes';
  end if;
  delete from public.crm_contact_notes n
   where n.tenant_id = p_tenant and n.contact_id = p_contact and n.id = p_note;
  if not found then
    raise exception using errcode = 'P0002', message = 'crm_delete_contact_note: no such note';
  end if;
  insert into public.crm_contact_events (tenant_id, contact_id, actor_id, kind, detail)
  values (p_tenant, p_contact, p_actor, 'note_deleted', jsonb_build_object('note_id', p_note));
  return p_note;
end $$;
revoke all on function public.crm_delete_contact_note(uuid, uuid, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.crm_delete_contact_note(uuid, uuid, uuid, uuid) to service_role;

-- A person's link of one lead to one contact (contact_link 'staff'). A definer: it moves the
-- contact's activity (app.crm_touch) and writes four FORCE RLS tables for the service role's
-- doors (its only callers). The lead is linked afresh (unlinked, then linked), so C5's
-- trigger writes the two link lines and runs the won and owner rules, which a phone link
-- skipped; a line naming another contact this lead was linked to goes. The person's details
-- on the lead join the contact (copied, never decrypted): its phone, and its e-mail unless
-- another contact holds it. Its activity counts from now on, from its own time. Answers
-- {link, email: added | kept | elsewhere | none, phone: added | kept | none}.
create or replace function app.crm_staff_link(p_tenant uuid, p_contact uuid, p_lead uuid)
  returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
declare
  l record;
  v_email text := 'none';
  v_phone text := 'none';
  v_n int;
  v_at timestamptz;
begin
  select x.contact_id, x.contact_link, x.is_spam, x.email_enc, x.email_hmac, x.phone_enc,
         x.phone_hmac, x.created_at
    into l
    from public.leads x
   where x.tenant_id = p_tenant and x.id = p_lead
     for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'crm_staff_link: no such lead';
  end if;
  if l.is_spam then
    raise exception using errcode = '22023', message = 'crm_staff_link: a spam lead is never linked';
  end if;
  if l.contact_id = p_contact and l.contact_link in ('email', 'new', 'staff') then
    return jsonb_build_object('link', l.contact_link, 'email', 'kept', 'phone', 'kept');
  end if;
  if l.contact_id is not null and l.contact_id <> p_contact then
    delete from public.crm_contact_events e
     where e.tenant_id = p_tenant and e.contact_id = l.contact_id and e.kind = 'lead_linked'
       and e.detail ->> 'lead_id' = p_lead::text;
    delete from public.lead_events e
     where e.tenant_id = p_tenant and e.lead_id = p_lead and e.kind = 'contact_linked'
       and e.detail ->> 'contact_id' = l.contact_id::text;
  end if;
  update public.leads x set contact_id = null, contact_link = 'staff'
   where x.tenant_id = p_tenant and x.id = p_lead;
  update public.leads x set contact_id = p_contact
   where x.tenant_id = p_tenant and x.id = p_lead;

  if l.email_hmac is not null and l.email_enc is not null then
    if exists (select 1 from public.crm_contact_channels ch
                where ch.tenant_id = p_tenant and ch.contact_id = p_contact and ch.kind = 'email'
                  and ch.value_hmac = l.email_hmac) then
      v_email := 'kept';
    else
      insert into public.crm_contact_channels (tenant_id, contact_id, kind, value_enc, value_hmac,
                                               is_primary, source)
      values (p_tenant, p_contact, 'email', l.email_enc, l.email_hmac, false, 'lead')
      on conflict do nothing;
      get diagnostics v_n = row_count;
      v_email := case when v_n = 1 then 'added' else 'elsewhere' end;
    end if;
  end if;
  if l.phone_hmac is not null and l.phone_enc is not null then
    insert into public.crm_contact_channels (tenant_id, contact_id, kind, value_enc, value_hmac,
                                             is_primary, source)
    values (p_tenant, p_contact, 'phone', l.phone_enc, l.phone_hmac, false, 'lead')
    on conflict do nothing;
    get diagnostics v_n = row_count;
    v_phone := case when v_n = 1 then 'added' else 'kept' end;
  end if;
  perform app.crm_fill_primary(p_tenant, p_contact);

  -- The lead's activity is the person's now: its arrival and its latest activity event.
  select greatest(l.created_at, max(e.at)) into v_at
    from public.lead_events e
   where e.tenant_id = p_tenant and e.lead_id = p_lead
     and e.kind in ('created', 'stage_changed', 'contact_logged', 'note_added', 'task_done', 'merged');
  perform app.crm_touch(p_tenant, p_contact, coalesce(v_at, l.created_at));
  return jsonb_build_object('link', 'staff', 'email', v_email, 'phone', v_phone);
end $$;
revoke all on function app.crm_staff_link(uuid, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function app.crm_staff_link(uuid, uuid, uuid) to service_role;

-- The check C5 left to this slice, on a lead matched to this contact by phone alone:
--   confirm  it is this person: a `staff` link (app.crm_staff_link);
--   detach   it is not: the lead leaves the contact for good (contact_id null, contact_link
--            'staff', so the backfill never links it again), and the two link lines naming
--            the pair go (a stranger's lead on this person's timeline, and this person's id
--            on the stranger's lead). Nothing was copied to the contact by a phone link.
-- 22023 for a lead not linked to this contact by phone; P0002 for no such contact or lead.
create or replace function public.crm_contact_link_lead(p_tenant uuid, p_contact uuid, p_lead uuid,
                                                        p_action text, p_actor uuid)
  returns jsonb
  language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  v_contact uuid;
  v_link text;
begin
  if p_tenant is null or p_contact is null or p_lead is null or p_actor is null
     or p_action is null or p_action not in ('confirm', 'detach') then
    raise exception using errcode = '22023', message = 'crm_contact_link_lead: a tenant, a contact, a lead, confirm or detach, and an actor are required';
  end if;
  if not app.crm_contacts_actor_ok(p_tenant, p_actor, false) then
    raise exception using errcode = '42501', message = 'crm_contact_link_lead: this person may not edit contacts';
  end if;
  perform 1 from public.crm_contacts c
   where c.tenant_id = p_tenant and c.id = p_contact and c.merged_into is null
     for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'crm_contact_link_lead: no such contact';
  end if;
  select l.contact_id, l.contact_link into v_contact, v_link
    from public.leads l where l.tenant_id = p_tenant and l.id = p_lead
     for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'crm_contact_link_lead: no such lead';
  end if;
  if v_contact is distinct from p_contact or v_link is distinct from 'phone' then
    raise exception using errcode = '22023', message = 'crm_contact_link_lead: the lead is not matched to this contact by phone';
  end if;
  if p_action = 'confirm' then
    return app.crm_staff_link(p_tenant, p_contact, p_lead);
  end if;
  update public.leads l set contact_id = null, contact_link = 'staff'
   where l.tenant_id = p_tenant and l.id = p_lead;
  delete from public.crm_contact_events e
   where e.tenant_id = p_tenant and e.contact_id = p_contact and e.kind = 'lead_linked'
     and e.detail ->> 'lead_id' = p_lead::text;
  delete from public.lead_events e
   where e.tenant_id = p_tenant and e.lead_id = p_lead and e.kind = 'contact_linked'
     and e.detail ->> 'contact_id' = p_contact::text;
  return jsonb_build_object('link', 'detached');
end $$;
revoke all on function public.crm_contact_link_lead(uuid, uuid, uuid, text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.crm_contact_link_lead(uuid, uuid, uuid, text, uuid) to service_role;

-- "New lead" for a contact: the contact's own e-mail and phone (the primary of each, else the
-- oldest) copied to the lead as they are, never decrypted, then the lead through the one door
-- every lead takes (public.crm_ingest_lead: the stage, number, score, assignment, timeline),
-- marked as added by p_actor, then linked to THIS contact (a `staff` link) whatever the
-- arrival's own link found (a shared phone can match someone else). p_lead is the Worker's
-- allow-listed object (id, locale, name, company, budget_enc, timeline_text_enc, message,
-- service_of_interest, discipline_of_interest, channel, score_signals): never a contact
-- detail, a source or a creator, which are this door's. 22023 when the contact has neither
-- an e-mail nor a phone. Answers {id, link}.
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
   order by ch.is_primary desc, ch.created_at, ch.id limit 1;
  select ch.value_enc, ch.value_hmac into v_phone
    from public.crm_contact_channels ch
   where ch.tenant_id = p_tenant and ch.contact_id = p_contact and ch.kind = 'phone'
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

-- ═══ Postconditions ═══════════════════════════════════════════════════════════════════════
do $$
declare
  v_fn text;
begin
  -- The readers: INVOKER, authenticated only.
  foreach v_fn in array array['public.crm_contacts_list(uuid, jsonb)', 'public.crm_contact_summary(uuid)',
                              'public.crm_contact_timeline(uuid, uuid, jsonb)',
                              'public.crm_contacts_bulk_update(uuid, text, jsonb, jsonb)'] loop
    if exists (select 1 from pg_proc where oid = v_fn::regprocedure and prosecdef) then
      raise exception 'C6: % must be SECURITY INVOKER', v_fn;
    end if;
    if has_function_privilege('anon', v_fn, 'execute')
       or not has_function_privilege('authenticated', v_fn, 'execute')
       or has_function_privilege('service_role', v_fn, 'execute') then
      raise exception 'C6: % must be executable by authenticated only', v_fn;
    end if;
  end loop;
  -- The doors: INVOKER, the service role only.
  foreach v_fn in array array['public.crm_create_contact(uuid, jsonb, uuid)',
                              'public.crm_edit_contact_channels(uuid, uuid, integer, jsonb, uuid[], uuid[], uuid)',
                              'public.crm_delete_contact_note(uuid, uuid, uuid, uuid)',
                              'public.crm_contact_link_lead(uuid, uuid, uuid, text, uuid)',
                              'public.crm_contact_new_lead(uuid, uuid, jsonb, uuid)'] loop
    if exists (select 1 from pg_proc where oid = v_fn::regprocedure and prosecdef) then
      raise exception 'C6: % must be SECURITY INVOKER', v_fn;
    end if;
    if has_function_privilege('anon', v_fn, 'execute')
       or has_function_privilege('authenticated', v_fn, 'execute')
       or not has_function_privilege('service_role', v_fn, 'execute') then
      raise exception 'C6: % must be executable by the service role only', v_fn;
    end if;
  end loop;
  -- The definers: an empty search_path, owned by a role that bypasses RLS, never anon's.
  foreach v_fn in array array['app.crm_retention_months()', 'app.crm_contacts_with_channel(text, text)',
                              'app.crm_contacts_actor_ok(uuid, uuid, boolean)',
                              'app.crm_email_holder(uuid, jsonb, uuid)', 'app.crm_fill_primary(uuid, uuid)',
                              'app.crm_staff_link(uuid, uuid, uuid)'] loop
    if not exists (select 1 from pg_proc f join pg_roles o on o.oid = f.proowner
                    where f.oid = v_fn::regprocedure and f.prosecdef
                      and f.proconfig[1] = 'search_path=""'
                      and (o.rolsuper or o.rolbypassrls)) then
      raise exception 'C6: % is not a definer with an empty search_path owned by a role that bypasses RLS', v_fn;
    end if;
    if has_function_privilege('anon', v_fn, 'execute') then
      raise exception 'C6: % is executable by anon', v_fn;
    end if;
  end loop;
  -- Staff reach two of them (the filter's lookups), never the doors' helpers.
  if not has_function_privilege('authenticated', 'app.crm_retention_months()', 'execute')
     or not has_function_privilege('authenticated', 'app.crm_contacts_with_channel(text, text)', 'execute')
     or has_function_privilege('authenticated', 'app.crm_contacts_actor_ok(uuid, uuid, boolean)', 'execute')
     or has_function_privilege('authenticated', 'app.crm_email_holder(uuid, jsonb, uuid)', 'execute')
     or has_function_privilege('authenticated', 'app.crm_fill_primary(uuid, uuid)', 'execute')
     or has_function_privilege('authenticated', 'app.crm_staff_link(uuid, uuid, uuid)', 'execute')
     or has_function_privilege('authenticated', 'app.crm_channels_ok(jsonb)', 'execute')
     or has_function_privilege('anon', 'app.crm_channels_ok(jsonb)', 'execute')
     or has_function_privilege('anon', 'app.crm_contact_filter(jsonb)', 'execute') then
    raise exception 'C6: a helper''s EXECUTE is not as stated';
  end if;
end $$;
