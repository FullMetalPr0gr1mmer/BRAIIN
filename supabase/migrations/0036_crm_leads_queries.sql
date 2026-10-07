-- ─────────────────────────────────────────────────────────────────────────────
-- 0036 — Leads v2, part 3: reading the pipeline (Admin v2 C2a). Forward-only.
-- Depends on 0033, 0034, 0035.
--
-- The CRM screens list, group and count leads. PostgREST filters cannot do it: staff may
-- not read the blind indexes, and PostgREST offers no grouped top-N or aggregates here. So
-- three SECURITY INVOKER functions do it, and RLS and the column grants still decide what
-- the caller sees (the live check included). One narrow definer finds leads by blind index
-- without revealing it.
--
--   • leads.search_text: name + company + the start of the message, folded the way
--     CLAUDE.md §8 folds Arabic (app.normalize_ar_q, 0006: tashkeel, alef forms, ة→ه,
--     kashida; the site's trigram search uses the same step) and lower-cased; a trigram
--     index serves "contains" search, and the query is folded the same way. Staff may read
--     it: it holds nothing they cannot already read.
--   • app.leads_with_contact(kind, hmac): the ids of the caller's tenant's leads whose
--     e-mail or phone has that blind index. A full e-mail or phone search therefore never
--     sends the address to the database, only its HMAC, which the Worker computes; a `q`
--     that looks like an address or a number is refused (22023), never searched as text.
--   • public.leads_list / leads_board / lead_summary (p_tenant, p_filter jsonb): an
--     allow-listed, validated filter (22023 on anything else); safe columns only; bounded
--     pages. The list answers {total, rows}, its total counted apart from the page. Like
--     crm_people, the Worker names the tenant and gets nothing unless it is the token's.
--   • public.crm_people(p_tenant): the active lead workers of the caller's tenant (the
--     people a lead can be assigned to), empty for anyone else, and empty unless the tenant
--     the Worker names is the token's. Display names and roles only. A definer, because a
--     lead worker's own token reads no other profile (profiles_self_select); it checks the
--     caller's live role itself.
-- ─────────────────────────────────────────────────────────────────────────────

-- ---- 1. Search text ----------------------------------------------------------------------
create or replace function app.lead_search_text(p_name text, p_company text, p_message text)
  returns text language sql immutable as $$
  -- `||`, not concat_ws(): concat_ws is only STABLE, and a generated column must be immutable.
  -- app.normalize_ar_q, not app.normalize_ar: only the _q step folds ة into ه (0006), and
  -- app.lead_filter folds the query with the same function.
  select lower(coalesce(app.normalize_ar_q(
    coalesce(p_name, '') || ' ' || coalesce(p_company, '') || ' ' || coalesce(left(p_message, 1000), '')),
    ''))
$$;
-- A STORED generated column is recomputed in the WRITER's session (0011), and every lead
-- write recomputes it: the service role (arrival, the cron) and staff (status, notes).
revoke all on function app.lead_search_text(text, text, text) from public, anon, authenticated, service_role;
grant execute on function app.lead_search_text(text, text, text) to authenticated, service_role;

alter table public.leads add column if not exists search_text text
  generated always as (app.lead_search_text(name, company, message)) stored;
create index if not exists leads_search_trgm_idx on public.leads using gin (search_text gin_trgm_ops);

-- ---- 2. Exact contact lookup, without revealing the index -------------------------------
create or replace function app.leads_with_contact(p_kind text, p_hmac text) returns setof uuid
  language plpgsql stable security definer set search_path = '' as $$
begin
  if not app.role_works_leads(app.live_role()) or p_hmac is null
     or p_hmac !~ '^[0-9a-f]{64}$' then
    return;
  end if;
  if p_kind = 'email' then
    return query select l.id from public.leads l
                  where l.tenant_id = app.effective_tenant_id() and l.email_hmac = p_hmac;
  elsif p_kind = 'phone' then
    return query select l.id from public.leads l
                  where l.tenant_id = app.effective_tenant_id() and l.phone_hmac = p_hmac;
  end if;
end $$;
revoke all on function app.leads_with_contact(text, text) from public, anon, authenticated, service_role;
grant execute on function app.leads_with_contact(text, text) to authenticated;

-- ---- 3. The filter ----------------------------------------------------------------------
-- One validator for the three readers: a key outside the list, or a value outside its
-- bounds, is a 22023 rather than a quietly ignored (or quietly widened) query.
create or replace function app.lead_filter(p jsonb, p_board boolean default false)
  returns table (
    stage uuid, spam boolean, needle text, contact_kind text, contact_hmac text,
    created_from timestamptz, created_to timestamptz, sort text, page_limit int,
    page_offset int, per_stage int)
  -- STABLE, not immutable: a timestamp without an offset is read in the session's zone.
  language plpgsql stable as $$
declare
  f jsonb := coalesce(p, '{}'::jsonb);
  v_q text;
begin
  if jsonb_typeof(f) <> 'object' then
    raise exception using errcode = '22023', message = 'lead filter: an object is required';
  end if;
  if exists (select 1 from jsonb_object_keys(f) k
              where k not in ('stage', 'spam', 'q', 'contact_kind', 'contact_hmac', 'from', 'to',
                              'sort', 'limit', 'offset', 'per_stage')) then
    raise exception using errcode = '22023', message = 'lead filter: unknown key';
  end if;
  begin
    stage := nullif(f ->> 'stage', '')::uuid;
    spam := coalesce((f ->> 'spam')::boolean, false);
    created_from := nullif(f ->> 'from', '')::timestamptz;
    created_to := nullif(f ->> 'to', '')::timestamptz;
    page_limit := coalesce((f ->> 'limit')::int, 25);
    page_offset := coalesce((f ->> 'offset')::int, 0);
    per_stage := coalesce((f ->> 'per_stage')::int, 20);
  exception when others then
    raise exception using errcode = '22023', message = 'lead filter: a value has the wrong type';
  end;
  sort := coalesce(f ->> 'sort', 'newest');
  if sort not in ('newest', 'oldest', 'score') then
    raise exception using errcode = '22023', message = 'lead filter: sort is newest, oldest or score';
  end if;
  if page_limit not between 1 and 100 or page_offset not between 0 and 10000
     or per_stage not between 1 and 50 then
    raise exception using errcode = '22023', message = 'lead filter: a page bound is out of range';
  end if;
  contact_kind := f ->> 'contact_kind';
  contact_hmac := f ->> 'contact_hmac';
  if (contact_kind is null) <> (contact_hmac is null)
     or (contact_kind is not null and (contact_kind not in ('email', 'phone')
                                       or contact_hmac !~ '^[0-9a-f]{64}$')) then
    raise exception using errcode = '22023', message = 'lead filter: contact_kind and contact_hmac go together';
  end if;
  v_q := f ->> 'q';
  if v_q is not null then
    if char_length(v_q) > 64 or v_q ~ '[[:cntrl:]]' then
      raise exception using errcode = '22023', message = 'lead filter: q is at most 64 printable characters';
    end if;
    -- A second layer behind the Worker (src/lib/crm/leadQuery.ts): an e-mail address or a
    -- phone number is found by its blind index only, so one sent as text is refused rather
    -- than searched. The phone test is the Worker's: phone characters only, 7+ digits.
    if strpos(v_q, '@') > 0
       or (v_q ~ '^[-+0-9[:space:]().٠-٩۰-۹]+$'
           and char_length(regexp_replace(v_q, '[^0-9٠-٩۰-۹]', '', 'g')) >= 7) then
      raise exception using errcode = '22023',
        message = 'lead filter: an e-mail address or a phone number is searched by its blind index';
    end if;
    -- Folded like search_text, then escaped: a % or _ in the query is a character.
    needle := nullif(replace(replace(replace(
                lower(coalesce(app.normalize_ar_q(btrim(v_q)), '')),
                '\', '\\'), '%', '\%'), '_', '\_'), '');
  end if;
  -- The board shows every stage, spam excluded; the stage key is the list's alone.
  if p_board and stage is not null then
    raise exception using errcode = '22023', message = 'lead filter: the board takes no stage';
  end if;
  return next;
end $$;
revoke all on function app.lead_filter(jsonb, boolean) from public, anon, authenticated, service_role;
grant execute on function app.lead_filter(jsonb, boolean) to authenticated;

-- ---- 4. The readers (INVOKER: RLS, the live check and the column grants apply) ----------
-- Each takes the tenant from the Worker as well, and finds nothing unless it is the token's
-- (crm_people's rule): a handler that forgot to scope gets nothing rather than a guess.

-- {total, rows}: the total counts every match apart from the page, so a page past the end
-- is an empty page of a known total, never "no leads".
create or replace function public.leads_list(p_tenant uuid, p_filter jsonb default '{}'::jsonb)
  returns jsonb
  language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare
  f record;
begin
  select * into f from app.lead_filter(p_filter);
  return (
    with matching as (
      select l.id, l.lead_number, l.name, l.company, left(l.message, 140) as message_preview,
             l.service_of_interest::text as service_of_interest,
             l.discipline_of_interest::text as discipline_of_interest, l.stage_id, l.is_spam,
             l.score, l.source, l.channel, l.created_at, l.first_response_at, l.won_at, l.version,
             row_number() over (
               order by case when f.sort = 'score' then l.score end desc nulls last,
                        case when f.sort = 'oldest' then l.created_at end asc,
                        l.created_at desc, l.id) as pos
        from public.leads l
       where l.tenant_id = app.effective_tenant_id()
         and l.tenant_id = p_tenant
         and l.is_spam = f.spam
         and (f.stage is null or l.stage_id = f.stage)
         and (f.created_from is null or l.created_at >= f.created_from)
         and (f.created_to is null or l.created_at < f.created_to)
         and (f.needle is null or l.search_text like '%' || f.needle || '%' escape '\')
         and (f.contact_hmac is null
              or l.id in (select app.leads_with_contact(f.contact_kind, f.contact_hmac)))
    )
    select jsonb_build_object(
             'total', (select count(*) from matching),
             'rows', coalesce((select jsonb_agg(to_jsonb(m) - 'pos' order by m.pos)
                                 from matching m
                                where m.pos > f.page_offset
                                  and m.pos <= f.page_offset + f.page_limit),
                              '[]'::jsonb)));
end $$;

create or replace function public.leads_board(p_tenant uuid, p_filter jsonb default '{}'::jsonb)
  returns table (stage_id uuid, total bigint, leads jsonb)
  language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare
  f record;
begin
  select * into f from app.lead_filter(p_filter, true);
  return query
  with matching as (
    select l.id, l.lead_number, l.name, l.company, l.service_of_interest, l.discipline_of_interest,
           l.stage_id, l.score, l.created_at, l.version,
           row_number() over (partition by l.stage_id order by l.created_at desc, l.id) as rn,
           count(*) over (partition by l.stage_id) as n
      from public.leads l
     where l.tenant_id = app.effective_tenant_id()
       and l.tenant_id = p_tenant
       and not l.is_spam
       and (f.created_from is null or l.created_at >= f.created_from)
       and (f.created_to is null or l.created_at < f.created_to)
       and (f.needle is null or l.search_text like '%' || f.needle || '%' escape '\')
       and (f.contact_hmac is null
            or l.id in (select app.leads_with_contact(f.contact_kind, f.contact_hmac)))
  )
  select s.id,
         coalesce(max(m.n), 0)::bigint,
         coalesce(jsonb_agg(jsonb_build_object(
           'id', m.id, 'lead_number', m.lead_number, 'name', m.name, 'company', m.company,
           'service_of_interest', m.service_of_interest,
           'discipline_of_interest', m.discipline_of_interest, 'score', m.score,
           'created_at', m.created_at, 'version', m.version)
           order by m.created_at desc, m.id) filter (where m.rn <= f.per_stage), '[]'::jsonb)
    from public.lead_stages s
    left join matching m on m.stage_id = s.id
   where s.tenant_id = app.effective_tenant_id()
     and s.tenant_id = p_tenant
   group by s.id, s.sort_order, s.key
   order by s.sort_order, s.key;
end $$;

create or replace function public.lead_summary(p_tenant uuid, p_filter jsonb default '{}'::jsonb)
  returns jsonb
  language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare
  f record;
  v jsonb;
begin
  select * into f from app.lead_filter(p_filter);
  if f.stage is not null or f.needle is not null or f.contact_hmac is not null then
    raise exception using errcode = '22023', message = 'lead summary: a date range is its only filter';
  end if;
  select jsonb_build_object(
           'total', count(*) filter (where not l.is_spam),
           'new', count(*) filter (where not l.is_spam and s.is_initial),
           'open', count(*) filter (where not l.is_spam and s.kind = 'open'),
           'won', count(*) filter (where not l.is_spam and s.kind = 'won'),
           'lost', count(*) filter (where not l.is_spam and s.kind = 'lost'),
           'spam', count(*) filter (where l.is_spam),
           'avg_first_response_hours', round((avg(extract(epoch from (l.first_response_at - l.created_at)))
             filter (where l.first_response_at is not null and not l.is_spam) / 3600)::numeric, 1))
    into v
    from public.leads l
    join public.lead_stages s on s.id = l.stage_id
   where l.tenant_id = app.effective_tenant_id()
     and l.tenant_id = p_tenant
     and (f.created_from is null or l.created_at >= f.created_from)
     and (f.created_to is null or l.created_at < f.created_to);
  return v;
end $$;

-- ---- 5. The people a lead can be assigned to ---------------------------------------------
-- The Worker names the tenant and the database checks it is the token's: a handler that
-- forgot to scope would get nothing rather than someone else's people.
create or replace function public.crm_people(p_tenant uuid) returns table (id uuid, display_name text, role text)
  language sql stable security definer set search_path = '' as $$
  select p.id, p.display_name, p.role::text
    from public.profiles p
   where app.role_works_leads((select app.live_role()))
     and p_tenant = app.effective_tenant_id()
     and p.tenant_id = p_tenant
     and p.is_active
     and (p.locked_until is null or p.locked_until <= now())
     and app.role_works_leads(p.role::text)
   order by p.display_name nulls last, p.id
$$;

-- ---- 6. Grants (Admin v2 P-14) ------------------------------------------------------------
revoke all on function public.leads_list(uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.leads_board(uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.lead_summary(uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.crm_people(uuid) from public, anon, authenticated, service_role;
grant execute on function public.leads_list(uuid, jsonb) to authenticated;
grant execute on function public.leads_board(uuid, jsonb) to authenticated;
grant execute on function public.lead_summary(uuid, jsonb) to authenticated;
grant execute on function public.crm_people(uuid) to authenticated;

grant select (search_text) on public.leads to authenticated;

-- ---- Postconditions ---------------------------------------------------------------------
do $$
declare
  v_safe constant text[] := array['id', 'tenant_id', 'kind', 'locale', 'name', 'company',
    'message', 'service_of_interest', 'discipline_of_interest', 'status',
    'consent_marketing', 'created_at', 'updated_at', 'lead_number', 'stage_id', 'is_spam',
    'spam_marked_at', 'first_response_at', 'won_at', 'version', 'created_by', 'updated_by',
    'score', 'source', 'channel', 'search_text'];
  v_readable text[];
  p text;
begin
  select coalesce(array_agg(a.attname::text order by a.attname), '{}')
    into v_readable
    from pg_attribute a
   where a.attrelid = 'public.leads'::regclass
     and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', 'public.leads', a.attname::text, 'select');
  if not (v_readable @> v_safe and v_readable <@ v_safe) then
    raise exception '0036: authenticated reads leads columns % (expected exactly %)', v_readable, v_safe;
  end if;
  foreach p in array array['public.leads_list(uuid, jsonb)', 'public.leads_board(uuid, jsonb)',
                           'public.lead_summary(uuid, jsonb)', 'public.crm_people(uuid)',
                           'app.leads_with_contact(text, text)'] loop
    if has_function_privilege('anon', p, 'execute')
       or not has_function_privilege('authenticated', p, 'execute') then
      raise exception '0036: % must be executable by authenticated and not anon', p;
    end if;
  end loop;
  foreach p in array array['public.leads_list(uuid, jsonb)', 'public.leads_board(uuid, jsonb)',
                           'public.lead_summary(uuid, jsonb)'] loop
    if exists (select 1 from pg_proc where oid = p::regprocedure and prosecdef) then
      raise exception '0036: % must be SECURITY INVOKER (RLS decides what it returns)', p;
    end if;
  end loop;
end $$;
